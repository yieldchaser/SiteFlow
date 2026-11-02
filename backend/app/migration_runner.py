"""
R2-731: Real migration runner that applies supabase/migrations/*.sql on startup.

Prior to this, supabase/migrations/*.sql were never executed by app code; README
instructed hand-pasting into Supabase editor. No Alembic, no script read that
directory, and D-V4 gate only checked file existence -- so R2-730 proved file
existence could be true while prod DB never received the change.

This runner closes the gap:
  - Discovers supabase/migrations/*.sql in sorted lexical order (chronological).
  - Tracks applied files in a supabase_migrations table (created if missing).
  - Executes pending files via raw SQL (single transaction per file).
  - Handles both SQLite (local dev) and Postgres (production):
      * SQLite: no-op execution but still tracks files so the gate can verify
        the runner was invoked; unique-constraint remediation for SQLite dev
        is handled by ensure_sqlite_unique_constraints().
      * Postgres: full execution with checksum and timing, idempotent via the
        migrations' own IF NOT EXISTS / DO-block guards plus tracking table.
  - Idempotent and safe to run on every boot; logs each applied migration.
  - Callable from backend/app/main.py lifespan and from scripts/apply_migrations.py
    for manual/CI invocation.

Blast-radius: new file; no existing table is dropped or altered beyond the
tracking table's CREATE TABLE IF NOT EXISTS.
"""
from __future__ import annotations

import hashlib
import os
import pathlib
import sys
import time
from typing import List, Optional

from sqlalchemy import text
from sqlalchemy import inspect as sa_inspect

# Late import of engine to avoid circular import at module import time;
# functions import engine inside the body when engine_override is None.


def _resolve_migrations_dir() -> pathlib.Path:
    """Return the supabase/migrations directory, probing several candidates."""
    candidates: List[pathlib.Path] = []

    # 1. Explicit env override (useful for CI / manual script).
    env_dir = os.getenv("SUPABASE_MIGRATIONS_DIR")
    if env_dir:
        candidates.append(pathlib.Path(env_dir))

    # 2. Relative to this file: backend/app/migration_runner.py -> repo root.
    this_file = pathlib.Path(__file__).resolve()
    # parents[0]=app, parents[1]=backend, parents[2]=repo root
    try:
        repo_candidates = [
            this_file.parents[2] / "supabase" / "migrations",
            this_file.parents[1] / "supabase" / "migrations",
            this_file.parents[3] / "supabase" / "migrations",
        ]
        candidates.extend(repo_candidates)
    except IndexError:
        pass

    # 3. CWD-based (when process is launched from repo root or backend/).
    cwd = pathlib.Path.cwd()
    candidates.append(cwd / "supabase" / "migrations")
    candidates.append(cwd / "backend" / ".." / "supabase" / "migrations")
    # Also handle worktree where backend is at different level.
    candidates.append(cwd.parent / "supabase" / "migrations")

    for p in candidates:
        try:
            # Resolve without requiring existence first, then check is_dir.
            rp = p.resolve() if p.exists() else p
            if rp.is_dir():
                return rp
        except Exception:
            continue

    # Fallback: return the most likely location even if it doesn't exist yet
    # so caller can log a clear warning.
    try:
        return (this_file.parents[2] / "supabase" / "migrations").resolve()
    except Exception:
        return pathlib.Path("supabase/migrations").resolve()


_PG_ADVISORY_LOCK_KEY = 727310731


def _is_strict_mode() -> bool:
    """M-2: strict-by-default when ENVIRONMENT=production.

    Explicit MIGRATION_RUNNER_STRICT env takes precedence (1/true/yes/on = strict,
    0/false/no/off/empty = not strict is handled via explicit check). When not
    set, default to strict if ENVIRONMENT == production, otherwise non-strict
    (dev/test). Falls back to app.config.Settings.ENVIRONMENT when the env var
    is unset (e.g., config is the source of truth).
    """
    raw = os.getenv("MIGRATION_RUNNER_STRICT")
    if raw is not None and raw.strip() != "":
        return raw.strip().lower() in ("1", "true", "yes", "on")
    env = os.getenv("ENVIRONMENT", "")
    if not env.strip():
        try:
            from app.config import settings as _settings  # lazy to avoid circular import

            env = _settings.ENVIRONMENT or ""
        except Exception:
            env = ""
    return env.strip().lower() == "production"


def _is_sqlite(engine) -> bool:
    try:
        return engine.url.drivername.startswith("sqlite") or engine.dialect.name == "sqlite"
    except Exception:
        return "sqlite" in str(getattr(engine, "url", "")).lower()


def _ensure_migrations_table(engine) -> None:
    """Create supabase_migrations tracking table if it does not exist."""
    is_sqlite = _is_sqlite(engine)
    if is_sqlite:
        create_sql = (
            "CREATE TABLE IF NOT EXISTS supabase_migrations ("
            " filename TEXT PRIMARY KEY,"
            " applied_at TEXT DEFAULT (datetime('now')),"
            " checksum TEXT"
            ")"
        )
    else:
        create_sql = (
            "CREATE TABLE IF NOT EXISTS supabase_migrations ("
            " filename TEXT PRIMARY KEY,"
            " applied_at TIMESTAMPTZ DEFAULT now() NOT NULL,"
            " checksum TEXT"
            ")"
        )
    with engine.begin() as conn:
        conn.exec_driver_sql(create_sql)


def _get_applied_map(engine) -> dict:
    """Return mapping filename -> stored checksum (None if missing). M-5/M-6."""
    _ensure_migrations_table(engine)
    with engine.connect() as conn:
        try:
            rows = conn.exec_driver_sql("SELECT filename, checksum FROM supabase_migrations").fetchall()
            out: dict = {}
            for r in rows:
                try:
                    fname = r[0]
                    cs = r[1] if len(r) > 1 else None
                except Exception:
                    continue
                out[fname] = cs
            return out
        except Exception as e:
            print(f"[migration_runner] ERROR: failed to read applied migrations: {e}", file=sys.stderr)
            print("[migration_runner] ERROR: could not read supabase_migrations - empty result would re-run every migration", file=sys.stderr)
            if _is_strict_mode():
                raise
            print("[migration_runner] WARNING: returning empty applied set in non-strict mode - all migrations will appear pending (re-run risk)", file=sys.stderr)
            return {}


def _get_applied_filenames(engine) -> set:
    """Return set of filenames already recorded as applied. Wrapper over _get_applied_map for compatibility."""
    return set(_get_applied_map(engine).keys())


def _file_checksum(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8", errors="ignore")).hexdigest()[:16]


def _ensure_sqlite_unique_constraints(engine) -> None:
    """
    For SQLite dev, ensure every named UniqueConstraint from models.Base has a
    backing UNIQUE index. SQLite cannot ALTER TABLE to add a constraint after
    the table exists; create_all only helps on fresh DBs. This remediation
    creates the missing UNIQUE index idempotently so the D-V4 live-DB gate
    passes on stale dev DB files without requiring a full wipe.
    """
    if not _is_sqlite(engine):
        return
    try:
        from app.database import Base
        # Import models to ensure all tables are registered.
        import app.models  # noqa: F401
    except Exception as e:
        print(f"[migration_runner] sqlite unique-constraint remediation skipped (import): {e}")
        return

    insp = sa_inspect(engine)
    # Collect expected constraints from metadata.
    import sqlalchemy as sa

    to_create: List[tuple] = []  # (table, name, columns)
    partial_where: dict = {}
    for table in Base.metadata.tables.values():
        for cons in table.constraints:
            if isinstance(cons, sa.UniqueConstraint) and cons.name and cons.name.startswith("uq_"):
                cols = tuple(c.name for c in cons.columns)
                to_create.append((table.name, cons.name, cols))
        for idx in table.indexes:
            if idx.name and idx.unique and idx.name.startswith("uq_"):
                cols = tuple(c.name for c in idx.columns)
                # Deduplicate: if same name already queued from constraints, skip.
                if idx.name not in {n for _, n, _ in to_create}:
                    to_create.append((table.name, idx.name, cols))
                    # A partial index keeps its WHERE, or the backfill would
                    # make it stricter than the model says.
                    where = idx.dialect_options["sqlite"].get("where")
                    if where is not None:
                        partial_where[idx.name] = str(where)

    if not to_create:
        return

    with engine.begin() as conn:
        for table_name, name, cols in to_create:
            if not cols:
                continue
            # Skip if table itself does not exist yet (empty DB before create_all).
            try:
                tbl_exists = conn.exec_driver_sql(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table_name,)
                ).fetchone()
                if not tbl_exists:
                    continue
            except Exception:
                pass
            # Check if index/constraint already exists via sqlite_master.
            try:
                existing = conn.exec_driver_sql(
                    "SELECT name FROM sqlite_master WHERE type='index' AND name=?", (name,)
                ).fetchone()
                if existing:
                    continue
                # Also check table DDL for CONSTRAINT name (covers fresh tables).
                # If the table's SQL already contains the constraint name, skip.
                ddl_row = conn.exec_driver_sql(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table_name,)
                ).fetchone()
                if ddl_row and ddl_row[0] and name in ddl_row[0]:
                    continue
            except Exception:
                # Fallback to inspector if direct query fails.
                try:
                    uqs = insp.get_unique_constraints(table_name)
                    idxs = insp.get_indexes(table_name)
                    found = {c["name"] for c in uqs if c.get("name")} | {i["name"] for i in idxs if i.get("unique") and i.get("name")}
                    if name in found:
                        continue
                except Exception:
                    pass

            cols_sql = ", ".join(f'"{c}"' for c in cols)
            stmt = f'CREATE UNIQUE INDEX IF NOT EXISTS "{name}" ON "{table_name}" ({cols_sql})'
            if name in partial_where:
                stmt += f" WHERE {partial_where[name]}"
            try:
                conn.exec_driver_sql(stmt)
                print(f"[migration_runner] sqlite: created missing unique index {name} ON {table_name}({', '.join(cols)})")
            except Exception as e:
                # Duplicate data will cause this to fail; log but don't hard-fail boot.
                print(f"[migration_runner] sqlite: could not create {name}: {e}")


def apply_pending_migrations(engine_override=None) -> List[str]:
    """
    Apply pending supabase/migrations/*.sql files in sorted order.

    Returns list of filenames that were newly applied (or tracked for SQLite).
    Safe to call repeatedly (idempotent).
    """
    if engine_override is not None:
        engine = engine_override
    else:
        from app.database import engine as _engine
        engine = _engine

    migrations_dir = _resolve_migrations_dir()
    if not migrations_dir.is_dir():
        # M-1: Render's Docker context is backend/ so supabase/migrations is absent
        # in the image. On Postgres (production) the runner cannot work via startup
        # hook -- the only supported path is CI workflow .github/workflows/migrate.yml
        # which has a full checkout. Make missing dir a loud error, not an info line.
        is_sqlite = _is_sqlite(engine)
        if is_sqlite:
            print(
                f"[migration_runner] migrations dir not found: {migrations_dir} (skipping) -- "
                f"will still apply SQLite unique-constraint remediation"
            )
            try:
                _ensure_sqlite_unique_constraints(engine)
            except Exception as e:
                print(f"[migration_runner] sqlite remediation after missing dir failed: {e}", file=sys.stderr)
            return []
        msg = (
            f"[migration_runner] ERROR: migrations dir not found in container: {migrations_dir} "
            f"(expected via CI workflow .github/workflows/migrate.yml -- not via startup hook; "
            f"Render Docker context is backend/ so supabase/migrations is not in image)"
        )
        print(msg, file=sys.stderr)
        if _is_strict_mode():
            raise FileNotFoundError(msg)
        return []

    try:
        files = sorted([p for p in migrations_dir.iterdir() if p.is_file() and p.suffix == ".sql"])
    except Exception as e:
        print(f"[migration_runner] could not list {migrations_dir}: {e}")
        return []

    if not files:
        print(f"[migration_runner] no .sql files in {migrations_dir}")
        return []

    # M-2/M-3: determine dialect before acquiring lock.
    is_sqlite = _is_sqlite(engine)

    # --- M-3: pg_advisory_lock to serialize concurrent boots (Render overlap / cold-boot) ---
    # Advisory lock is Postgres-only; skip gracefully on SQLite or non-Postgres.
    _lock_conn = None
    _lock_acquired = False
    _is_pg = False
    if not is_sqlite:
        try:
            _is_pg = engine.dialect.name == "postgresql" or engine.url.drivername.startswith("postgresql")
        except Exception:
            url_str = str(getattr(engine, "url", "")).lower()
            _is_pg = "postgres" in url_str or "supabase" in url_str
        if _is_pg:
            try:
                _lock_conn = engine.connect()
                _lock_conn.exec_driver_sql(f"SELECT pg_advisory_lock({_PG_ADVISORY_LOCK_KEY})")
                try:
                    _lock_conn.commit()
                except Exception:
                    pass
                _lock_acquired = True
                print(f"[migration_runner] acquired pg_advisory_lock {_PG_ADVISORY_LOCK_KEY}")
            except Exception as e:
                # Not Postgres, permission issue, or lock unavailable -- proceed without lock but log.
                print(f"[migration_runner] advisory lock unavailable, proceeding without lock: {e}")
                if _lock_conn is not None:
                    try:
                        _lock_conn.close()
                    except Exception:
                        pass
                    _lock_conn = None
                    _lock_acquired = False

    # Wrap whole migration pass so advisory lock covers read-applied + execute + record.
    try:
        # Ensure tracking table exists and load applied set (inside lock). M-5/M-6.
        try:
            applied_map = _get_applied_map(engine)
            applied = set(applied_map.keys())
        except Exception as e:
            print(f"[migration_runner] ERROR: could not load applied set: {e}", file=sys.stderr)
            if _is_strict_mode():
                raise
            print("[migration_runner] WARNING: proceeding with empty applied set - re-run risk", file=sys.stderr)
            applied = set()
            applied_map = {}

        newly_applied: List[str] = []

        for path in files:
            fname = path.name
            # M-5: read and checksum even for already-applied files to detect edits.
            try:
                content = path.read_text(encoding="utf-8", errors="ignore")
            except Exception as e:
                print(f"[migration_runner] could not read {fname}: {e}")
                continue

            checksum = _file_checksum(content)

            if fname in applied:
                stored = applied_map.get(fname)
                if stored is not None and stored != "" and stored != checksum:
                    msg = f"[migration_runner] ERROR: checksum mismatch for {fname}: stored {stored} vs current {checksum} -- migration was edited after application"
                    print(msg, file=sys.stderr)
                    if _is_strict_mode():
                        raise ValueError(msg)
                continue

            if not content.strip():
                print(f"[migration_runner] skipping empty {fname}")
                # Still mark as applied to avoid infinite loop on empty file.
                try:
                    with engine.begin() as conn:
                        conn.exec_driver_sql(
                            "INSERT OR IGNORE INTO supabase_migrations (filename, checksum) VALUES (?, ?)" if is_sqlite
                            else "INSERT INTO supabase_migrations (filename, checksum) VALUES (%s, %s) ON CONFLICT (filename) DO NOTHING",
                            (fname, checksum) if is_sqlite else (fname, checksum),
                        )
                except Exception:
                    try:
                        with engine.begin() as conn:
                            conn.execute(text("INSERT INTO supabase_migrations (filename, checksum) VALUES (:fname, :cs) ON CONFLICT (filename) DO NOTHING"),
                                         {"fname": fname, "cs": checksum})
                    except Exception as ie:
                        print(f"[migration_runner] could not track {fname}: {ie}")
                newly_applied.append(fname)
                continue

            # checksum already computed above; reuse for SQLite and Postgres paths

            if is_sqlite:
                # SQLite dev: do NOT attempt to execute Postgres-flavored SQL
                # (DO $$, pg_constraint, UUID type, etc. will error). Just track.
                try:
                    with engine.begin() as conn:
                        # Use OR IGNORE for SQLite idempotency.
                        conn.exec_driver_sql(
                            "INSERT OR IGNORE INTO supabase_migrations (filename, checksum) VALUES (?, ?)",
                            (fname, checksum),
                        )
                    print(f"[migration_runner] sqlite: marked {fname} as applied (no exec, SQLite dev)")
                    newly_applied.append(fname)
                except Exception as e:
                    print(f"[migration_runner] sqlite tracking failed for {fname}: {e}")
                continue

            # Postgres path: execute the SQL then record.
            start = time.time()
            try:
                with engine.begin() as conn:
                    # Execute the entire file as one operation. Postgres can handle
                    # multi-statement strings and DO blocks this way.
                    # Bypass DBAPI interpolation: use raw DBAPI cursor single-arg
                    # execute so psycopg2 does not try to interpolate % in PL/pgSQL.
                    try:
                        raw = conn.connection
                        # conn.connection is a PoolProxiedConnection / _ConnectionFairy;
                        # its cursor() proxies to the underlying DBAPI connection.
                        cur = raw.cursor()
                        cur.execute(content)
                        try:
                            cur.close()
                        except Exception:
                            pass
                    except Exception as first_err:
                        # Fallback for drivers where raw cursor is unavailable.
                        try:
                            conn.execute(text(content))
                        except Exception as fallback_err:
                            raise RuntimeError(
                                f"migration failed: {first_err} (fallback also failed: {fallback_err})"
                            ) from first_err

                    # Record in tracking table in same transaction.
                    try:
                        conn.execute(
                            text("INSERT INTO supabase_migrations (filename, checksum) VALUES (:fname, :cs) ON CONFLICT (filename) DO NOTHING"),
                            {"fname": fname, "cs": checksum},
                        )
                    except Exception:
                        # Fallback for psycopg2 %s style via exec_driver_sql
                        conn.exec_driver_sql(
                            "INSERT INTO supabase_migrations (filename, checksum) VALUES (%s, %s) ON CONFLICT (filename) DO NOTHING",
                            (fname, checksum),
                        )

                elapsed = int((time.time() - start) * 1000)
                print(f"[migration_runner] applied {fname} ({elapsed}ms, checksum {checksum})")
                newly_applied.append(fname)

            except Exception as e:
                # Do not mark as applied; next boot will retry.
                # M-2: strict-by-default in production -> raise so boot crashes.
                # In dev, log and continue (non-fatal).
                print(f"[migration_runner] FAILED to apply {fname}: {e}")
                if _is_strict_mode():
                    raise
                continue

        if not newly_applied:
            # For SQLite, also ensure unique constraints are backfilled even when
            # no new files were pending (stale DB file case).
            if is_sqlite:
                _ensure_sqlite_unique_constraints(engine)
            else:
                print(f"[migration_runner] no pending migrations ({len(files)} total, {len(applied)} already applied)")
        else:
            print(f"[migration_runner] applied {len(newly_applied)}/{len(files)} pending: {', '.join(newly_applied)}")
            if is_sqlite:
                _ensure_sqlite_unique_constraints(engine)

        return newly_applied
    finally:
        if _lock_acquired and _lock_conn is not None:
            try:
                _lock_conn.exec_driver_sql(f"SELECT pg_advisory_unlock({_PG_ADVISORY_LOCK_KEY})")
                try:
                    _lock_conn.commit()
                except Exception:
                    pass
                print(f"[migration_runner] released pg_advisory_lock {_PG_ADVISORY_LOCK_KEY}")
            except Exception as e:
                print(f"[migration_runner] advisory unlock failed: {e}")
            finally:
                try:
                    _lock_conn.close()
                except Exception:
                    pass


# Convenience alias for lifespan import.
run_migrations = apply_pending_migrations
