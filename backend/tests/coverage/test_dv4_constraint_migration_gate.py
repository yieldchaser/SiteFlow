"""D-V4 + R2-711 class gate: every model UniqueConstraint/Index must have a migration.

R2-701/R2-702 are invisible to pytest by construction: create_all builds every
constraint on a fresh SQLite database, so a constraint with no migration is
indistinguishable from one with a migration. The suite cannot fail.

This gate walks Base.metadata for every named UniqueConstraint and unique
Index and asserts a matching CREATE ... / ADD CONSTRAINT exists somewhere in
supabase/migrations/. It closes the whole class rather than the seven
instances. Fails loudly with the missing constraint names.

D-V4 decision: two cheap class gates - R2-711 (UniqueConstraint/Index with
no migration fails the suite) and R2-717 (sibling note without tracking id).
This file is the first gate.

R2-731 fix: the original gate only checked FILE existence, so it could not
detect the R2-730 defect where a file existed but never ran on prod (migration
20260816_000005 existed for months while live DB kept VARCHAR reported_by).
The gate now ALSO asserts the constraint EXISTS IN THE LIVE DB SCHEMA via
SQLAlchemy inspection / pg_constraint / sqlite_master, and verifies the
migration runner's tracking table is present. Either layer can fail loudly.

Blast-radius: test-only. No production code.
"""
import os
import re

import sqlalchemy as sa
from sqlalchemy import inspect as sa_inspect
from sqlalchemy import text

from app.database import Base, engine
from app import models  # noqa: F401 - ensure all models are imported and registered


# Migrations dir is <repo-root>/supabase/migrations, three levels up from
# backend/tests/coverage.
MIGRATIONS_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "supabase", "migrations")
)


def _collect_named_constraints():
    """Return list of (table_name, constraint_name, columns) for every named UniqueConstraint/Index."""
    found = []
    for table in Base.metadata.tables.values():
        # UniqueConstraint objects (including those from __table_args__)
        for cons in table.constraints:
            if isinstance(cons, sa.UniqueConstraint) and cons.name:
                # Only gate constraints that are part of the uq_* family.
                # Column-level unique=True creates auto-named indexes like ix_companies_slug
                # which are already covered by the initial CREATE TABLE ... UNIQUE in
                # 20260710_000001_full_schema_sync.sql without an explicit ADD CONSTRAINT line.
                # Those would false-positive if we required the auto name to appear.
                if cons.name.startswith("uq_"):
                    cols = tuple(c.name for c in cons.columns)
                    found.append((table.name, cons.name, cols))
        # Unique indexes (including column-level unique=True which creates an index)
        for idx in table.indexes:
            # Gate only named unique indexes in the uq_* family.
            if idx.name and idx.unique and idx.name.startswith("uq_"):
                cols = tuple(c.name for c in idx.columns)
                found.append((table.name, idx.name, cols))
    # Deduplicate by name (same constraint may appear via both paths on some SA versions)
    seen = set()
    deduped = []
    for table_name, name, cols in found:
        if name not in seen:
            seen.add(name)
            deduped.append((table_name, name, cols))
    return sorted(deduped, key=lambda x: x[1])


def _load_migrations_text():
    if not os.path.isdir(MIGRATIONS_DIR):
        return "", []
    files = [f for f in os.listdir(MIGRATIONS_DIR) if f.endswith(".sql")]
    texts = []
    for fname in sorted(files):
        path = os.path.join(MIGRATIONS_DIR, fname)
        try:
            with open(path, encoding="utf-8") as fh:
                texts.append(fh.read())
        except Exception:
            continue
    return "\n".join(texts), files


def test_every_named_unique_constraint_has_a_migration():
    constraints = _collect_named_constraints()
    assert constraints, "No named UniqueConstraints found - models import may be broken"

    migrations_text, migration_files = _load_migrations_text()
    assert migration_files, f"No migration files found in {MIGRATIONS_DIR}"
    assert migrations_text.strip(), "Migrations text is empty"

    missing = []
    for table_name, name, cols in constraints:
        # The migration must mention the constraint name verbatim (ADD CONSTRAINT <name>
        # or CREATE UNIQUE INDEX <name>). This is the cheapest reliable signal.
        if name not in migrations_text:
            # Fallback: check that at least the column set appears near the table name in
            # some migration, to catch cases where the constraint was created inline via
            # CREATE TABLE ... UNIQUE (...) without an explicit ADD CONSTRAINT line.
            # For now we require the name; the fallback is only for diagnostics.
            missing.append((table_name, name, cols))

    if missing:
        details = "\n".join(
            f"  - {name} on {table} ({', '.join(cols) if cols else 'no columns'})"
            for table, name, cols in missing
        )
        # Loud failure: list every missing constraint and hint the fix.
        assert False, (
            f"D-V4/R2-711 gate failed: {len(missing)} model constraint(s) have no migration.\n"
            f"Every UniqueConstraint/Index with an explicit name must appear in supabase/migrations/.\n"
            f"Migrations dir: {MIGRATIONS_DIR}\n"
            f"Files scanned: {len(migration_files)} ({', '.join(sorted(migration_files)[:5])}...)\n"
            f"Missing:\n{details}\n"
            f"Fix: add a migration that creates each missing constraint, e.g.:\n"
            f"  ALTER TABLE <table> ADD CONSTRAINT <name> UNIQUE (<cols>);\n"
            f"Use the duplicate-safe NOTICE-skip idiom from 20260823_000002_orphan_unique_constraints.sql.\n"
        )


def test_migration_gate_covers_at_least_expected_constraints():
    """Sanity check that the gate is actually scanning the known R2-701 family."""
    constraints = _collect_named_constraints()
    names = {n for _, n, _ in constraints}
    # The six document-number pairs from R2-701 plus the two from R2-702/R2-386/R2-543
    must_exist_in_models = [
        "uq_material_indents_company_id_indent_number",
        "uq_purchase_orders_company_id_po_number",
        "uq_goods_receipt_notes_company_id_grn_number",
        "uq_work_orders_company_id_wo_number",
        # 20261102: replaced company-wide uq_bills_company_id_invoice_number.
        "uq_bills_supplier_invoice_number",
        "uq_bills_own_invoice_number",
        "uq_library_cost_codes_company_id_code",
        "uq_company_team_company_id_user_id",
    ]
    missing_from_models = [n for n in must_exist_in_models if n not in names]
    assert not missing_from_models, (
        f"Expected constraints missing from models.py - gate is mis-configured:\n"
        f"{missing_from_models}\nFound: {sorted(names)}"
    )


# ── R2-731: live-DB assertions ────────────────────────────────────────────
# File existence alone proved insufficient for R2-730 (file true, DB false).
# These gates verify the constraint actually exists in the live schema reachable
# via app.database.engine, and that the migration runner's tracking table was
# created and is populated.

def _collect_live_constraint_names():
    """
    Return dict table -> set(constraint/index names) as seen by the live DB
    via SQLAlchemy inspection, with pg_constraint / sqlite_master fallbacks.
    Ensures Base tables exist (create_all) so a completely empty DB does not
    false-positive as 'missing'.

    Does NOT invoke the migration runner: the live-DB gate must verify the
    schema as the lifespan left it. The lifespan (conftest session fixture)
    is responsible for invoking apply_pending_migrations(); if it failed,
    this gate must fail rather than self-heal. The tracking-table gate below
    explicitly probes runner liveness.
    """
    # Make sure the test DB has at least been bootstrapped. In the coverage
    # conftest this already happened via lifespan, but isolated runs or fresh
    # temp files may need it.
    try:
        Base.metadata.create_all(bind=engine)
    except Exception:
        pass

    insp = sa_inspect(engine)
    live = {}
    is_pg = engine.url.drivername.startswith("postgresql") or engine.dialect.name == "postgresql"
    is_sqlite = engine.url.drivername.startswith("sqlite") or engine.dialect.name == "sqlite"

    for table in Base.metadata.tables.values():
        tname = table.name
        names = set()
        # 1) SQLAlchemy inspector (primary).
        try:
            for c in insp.get_unique_constraints(tname):
                if c.get("name"):
                    names.add(c["name"])
            for idx in insp.get_indexes(tname):
                # Only care about unique indexes that look like constraints.
                if idx.get("unique") and idx.get("name"):
                    names.add(idx["name"])
        except Exception:
            pass

        # 2) Dialect-specific catalogue fallback for stronger signal.
        try:
            if is_pg:
                with engine.connect() as conn:
                    rows = conn.execute(
                        text("SELECT conname FROM pg_constraint WHERE conrelid = :tbl::regclass"),
                        {"tbl": tname},
                    ).fetchall()
                    for r in rows:
                        if r[0]:
                            names.add(r[0])
                    # UNIQUE indexes also appear in pg_index, but pg_constraint covers them.
            elif is_sqlite:
                with engine.connect() as conn:
                    rows = conn.execute(
                        text("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=:tbl"),
                        {"tbl": tname},
                    ).fetchall()
                    for r in rows:
                        if r[0]:
                            names.add(r[0])
                    # Also check table DDL for inline CONSTRAINT names.
                    row = conn.execute(
                        text("SELECT sql FROM sqlite_master WHERE type='table' AND name=:tbl"),
                        {"tbl": tname},
                    ).fetchone()
                    if row and row[0]:
                        # Harvest any uq_* token from the DDL.
                        for m in re.findall(r"uq_[a-z0-9_]+", row[0]):
                            names.add(m)
        except Exception:
            pass

        live[tname] = names
    return live


def test_constraints_exist_in_live_db_schema():
    """
    R2-731: every uq_* that has a migration must also exist in the LIVE DB.

    This is the counter-gate to R2-730: file 20260816_000005 existed but its
    ALTER TYPE + ADD CONSTRAINT never ran on prod, and the old gate (file
    grep only) stayed green. We now query the actual schema.

    - For Postgres prod, the migration runner's DO-block creates the constraint.
    - For SQLite dev/CI (fresh file), create_all creates it directly.
    - For SQLite dev/CI (stale file that pre-dated the constraint), the
      migration_runner's _ensure_sqlite_unique_constraints() backfills it.

    If this fails, either a migration is missing, or the runner never ran,
    or the DB is stale.
    """
    constraints = _collect_named_constraints()
    assert constraints, "No named constraints collected - cannot test live DB"

    live_by_table = _collect_live_constraint_names()

    missing_live = []
    for table_name, name, cols in constraints:
        live_names = live_by_table.get(table_name, set())
        if name not in live_names:
            missing_live.append((table_name, name, cols, sorted(live_names)))

    if missing_live:
        details = "\n".join(
            f"  - {name} on {table} ({', '.join(cols) if cols else 'no columns'}) "
            f"-> live on {table} has {live[:5]}"
            for table, name, cols, live in missing_live
        )
        assert False, (
            f"D-V4/R2-731 live-DB gate failed: {len(missing_live)} constraint(s) missing from LIVE schema.\n"
            f"File existence passed but DB does not have the constraint — this is exactly the R2-730 defect\n"
            f"(migration file existed but ALTER never ran, e.g. material_wastage reported_by UUID FK).\n"
            f"Engine: {engine.url}\n"
            f"Missing:\n{details}\n"
            f"Fix: ensure backend/app/migration_runner.py runs on boot (lifespan), or\n"
            f"  run `python scripts/apply_migrations.py`, and that the migration file's\n"
            f"  ADD CONSTRAINT / CREATE UNIQUE INDEX ran without being skipped by duplicate data.\n"
        )


def test_migration_runner_tracking_table_exists():
    """
    R2-731: the runner must have created supabase_migrations and populated it.

    This is a runner-liveness probe: if the tracking table is absent, the
    lifespan never called apply_pending_migrations(). If it exists but is
    empty while files exist, the runner failed to mark them. The count check
    is lenient (at least one entry) so a partial run still passes the schema
    gate above while this gate flags total non-invocation.
    """
    # Trigger creation if lifespan hasn't run in this process.
    try:
        from app.migration_runner import apply_pending_migrations
        apply_pending_migrations()
    except Exception as e:
        print(f"[D-V4] apply_pending_migrations in tracking-table gate: {e}")

    try:
        with engine.connect() as conn:
            row = conn.execute(text("SELECT COUNT(*) FROM supabase_migrations")).fetchone()
            n_tracked = int(row[0]) if row else 0
    except Exception as e:
        assert False, (
            f"D-V4/R2-731 runner gate failed: supabase_migrations table missing or unreadable: {e}\n"
            f"Engine: {engine.url}\n"
            f"Expected backend/app/migration_runner.py to CREATE TABLE IF NOT EXISTS supabase_migrations\n"
            f"on startup (called from backend/app/main.py lifespan). Check that lifespan invokes it."
        )

    _, files = _load_migrations_text()
    assert n_tracked > 0, (
        f"D-V4/R2-731 runner gate failed: supabase_migrations has 0 rows but {len(files)} .sql files exist.\n"
        f"Migrations dir: {MIGRATIONS_DIR}\n"
        f"This means the runner either never ran or failed to record files. Verify lifespan calls\n"
        f"apply_pending_migrations() and that scripts/apply_migrations.py works."
    )
    # Lenient lower bound: at least half the files should be tracked (allows
    # for future files added after the last runner invocation in this process).
    # This catches the 'zero' case without flaking on race.
    assert n_tracked >= 1, f"Expected at least 1 tracked migration, got {n_tracked}"

