from fastapi import Depends, FastAPI, HTTPException, Request
from app.auth import enforce_project_scope
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
import logging
import os
import sys
from contextlib import asynccontextmanager
from sqlalchemy import DateTime, String, Numeric, Boolean, Text, func
from sqlalchemy.exc import IntegrityError
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from app.rate_limit import limiter
from app.routers import (
    auth, calculators, budgeting, planning, drawings, procurement,
    billing, hr, quality, reports, equipment, safety, analytics,
    production, dpr, crm, finance, tally, subcon_attendance, settings,
    assets, three_way, wastage, chat, custom_fields, statutory, face_recognition,
    subcon_performance, vendor_performance, rfq, labour, towers, budget,
    library, profile, mom, delete_logs, projects, todos, team_schedule
)
from app.database import engine, Base, SessionLocal
from app import models

logger = logging.getLogger(__name__)

# Anchor the static mount to the repo's backend/static directory (the same
# location reports.py writes PDFs to) so it never depends on the process CWD.
STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")

# Initialize SQLAlchemy tables if they do not exist
# Note: In production this is handled via Supabase SQL migrations, but for local/SQLite dev it serves as an auto-fallback.
# The actual create_all() call runs ONCE PER BOOT inside the FastAPI lifespan (see lifespan()), NOT at import time.

def ensure_sqlite_library_party_columns():
    if not engine.url.drivername.startswith("sqlite"):
        return

    required_columns = {
        "bank_name": String(255),
        "account_name": String(255),
        "account_number": String(100),
        "ifsc_code": String(20),
        "tax_no": String(100),
        "esi_number": String(100),
        "pf_number": String(100),
        "father_name": String(255),
        "passport_no": String(100),
        "passport_expiry_date": DateTime(timezone=True),
        "creator_name": String(255),
    }

    with engine.begin() as conn:
        existing_columns = {
            row[1]
            for row in conn.exec_driver_sql("PRAGMA table_info(library_parties)").fetchall()
        }
        for column_name, column_type in required_columns.items():
            if column_name in existing_columns:
                continue
            conn.exec_driver_sql(
                f'ALTER TABLE library_parties ADD COLUMN "{column_name}" {column_type.compile(dialect=engine.dialect)}'
            )

    # (call runs in lifespan)


def ensure_sqlite_company_team_party_link():
    if not engine.url.drivername.startswith("sqlite"):
        return
    with engine.begin() as conn:
        existing = {
            row[1]
            for row in conn.exec_driver_sql("PRAGMA table_info(company_team)").fetchall()
        }
        if "library_party_id" not in existing:
            conn.exec_driver_sql('ALTER TABLE company_team ADD COLUMN "library_party_id" VARCHAR(36)')


def backfill_company_team_party_links(db):
    """Associate billing-side company_team rows with their library_party by name within the same company."""
    linked = 0
    for lp in db.query(models.LibraryParty).all():
        if not lp.name:
            continue
        target = (
            db.query(models.CompanyTeam)
            .join(models.User, models.User.id == models.CompanyTeam.user_id)
            .filter(
                models.CompanyTeam.company_id == lp.company_id,
                models.CompanyTeam.library_party_id.is_(None),
                func.lower(func.trim(models.User.name)) == lp.name.strip().lower(),
            )
            .first()
        )
        if target:
            target.library_party_id = lp.id
            linked += 1
    db.commit()
    return linked


    # (call runs in lifespan)


def ensure_sqlite_library_cost_code_columns():
    if not engine.url.drivername.startswith("sqlite"):
        return

    required_columns = {
        "sub_cost_code": String(100),
    }

    with engine.begin() as conn:
        existing_columns = {
            row[1]
            for row in conn.exec_driver_sql("PRAGMA table_info(library_cost_codes)").fetchall()
        }
        for column_name, column_type in required_columns.items():
            if column_name in existing_columns:
                continue
            conn.exec_driver_sql(
                f'ALTER TABLE library_cost_codes ADD COLUMN "{column_name}" {column_type.compile(dialect=engine.dialect)}'
            )

def ensure_sqlite_company_slug_column():
    if "sqlite" not in str(engine.url):
        return
    with engine.begin() as conn:
        existing_columns = {
            row[1]
            for row in conn.exec_driver_sql("PRAGMA table_info(companies)").fetchall()
        }
        if "slug" not in existing_columns:
            conn.exec_driver_sql(
                'ALTER TABLE companies ADD COLUMN "slug" VARCHAR(255)'
            )

    # (call runs in lifespan)


def ensure_sqlite_company_parent_column():
    """Add the self-referential parent_company_id grouping column to existing companies tables."""
    if not engine.url.drivername.startswith("sqlite"):
        return
    with engine.begin() as conn:
        existing = {
            row[1]
            for row in conn.exec_driver_sql("PRAGMA table_info(companies)").fetchall()
        }
        if "parent_company_id" not in existing:
            conn.exec_driver_sql(
                'ALTER TABLE companies ADD COLUMN "parent_company_id" VARCHAR(36)'
            )


    # (call runs in lifespan)


def ensure_sqlite_project_tab_columns():
    """Add columns introduced for the Project Tab parity build to existing tables."""
    if not engine.url.drivername.startswith("sqlite"):
        return

    column_specs = {
        "projects": {
            "project_value": Numeric(18, 2),
            "planned_start_date": DateTime(timezone=True),
            "planned_end_date": DateTime(timezone=True),
            "actual_start_date": DateTime(timezone=True),
            "actual_end_date": DateTime(timezone=True),
            "orientation": String(255),
            "dimension": String(255),
            "scope_of_work": String(),
            "project_avatar": String(),
            "is_pinned": Boolean(),
        },
        "library_cost_codes": {
            "parent_id": String(),
        },
        "library_materials": {
            "alternate_unit": String(50),
        },
        "project_parties": {
            "status": String(50),
        },
    }

    with engine.begin() as conn:
        for table, cols in column_specs.items():
            existing = {row[1] for row in conn.exec_driver_sql(f'PRAGMA table_info("{table}")').fetchall()}
            for col_name, col_type in cols.items():
                if col_name in existing:
                    continue
                conn.exec_driver_sql(
                    f'ALTER TABLE "{table}" ADD COLUMN "{col_name}" {col_type.compile(dialect=engine.dialect)}'
                )

    # (call runs in lifespan)


def ensure_sqlite_bill_columns():
    """Add Transaction-tab sub-entity columns to the bills table for SQLite dev."""
    if not engine.url.drivername.startswith("sqlite"):
        return
    required_columns = {
        "items_json": Text(),
        "payment_mode": String(20),
        "payment_bank_name": String(255),
        "payment_ref": String(255),
        "ship_to": Text(),
    }
    with engine.begin() as conn:
        existing = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(bills)").fetchall()}
        for col, typ in required_columns.items():
            if col in existing:
                continue
            conn.exec_driver_sql(
                f'ALTER TABLE bills ADD COLUMN "{col}" {typ.compile(dialect=engine.dialect)}'
            )


def ensure_sqlite_task_columns():
    """Add progress + baseline columns to the tasks table for SQLite dev."""
    if not engine.url.drivername.startswith("sqlite"):
        return
    required_columns = {
        "progress": Numeric(5, 2),
        "baseline_start": DateTime(timezone=True),
        "baseline_end": DateTime(timezone=True),
    }
    with engine.begin() as conn:
        existing = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(tasks)").fetchall()}
        for col, typ in required_columns.items():
            if col in existing:
                continue
            conn.exec_driver_sql(
                f'ALTER TABLE tasks ADD COLUMN "{col}" {typ.compile(dialect=engine.dialect)}'
            )


    # (call runs in lifespan)


def ensure_sqlite_schema_sync():
    """Catch-all migration for SQLite dev DBs: add any model column that is
    missing from an existing table. Only nullable columns (or columns with a
    default) are added, so data already present is preserved. This keeps the
    local SQLite schema aligned with models.py without manual per-column ALTERs.

    R2-741: previously swallowed every error via bare except: continue / print
    without context. Now logs to stderr with table and column so a failing
    column (e.g. type mismatch) is loud and actionable instead of silent.
    """
    if not engine.url.drivername.startswith("sqlite"):
        return
    from app import models as _models
    with engine.begin() as conn:
        for tname, tmeta in _models.Base.metadata.tables.items():
            try:
                existing = {row[1] for row in conn.exec_driver_sql(f'PRAGMA table_info("{tname}")').fetchall()}
            except Exception as e:
                print(f"[schema_sync] failed for {tname}: {e}", file=sys.stderr)
                continue
            for col in tmeta.columns:
                if col.name in existing:
                    continue
                if not (col.nullable or col.default is not None or col.server_default is not None):
                    continue
                try:
                    col_type = col.type.compile(dialect=engine.dialect)
                    conn.exec_driver_sql(f'ALTER TABLE "{tname}" ADD COLUMN "{col.name}" {col_type}')
                except Exception as e:
                    print(f"[schema_sync] failed for {tname}.{col.name}: {e}", file=sys.stderr)
                    continue

    # (call runs in lifespan)


def ensure_postgres_schema_sync():
    """PostgreSQL-compatible schema migration: safely add any column that is
    present in SQLAlchemy models but missing from the live production DB.

    Uses `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` which is a no-op when the
    column already exists, making this fully idempotent and safe to run on every
    boot. Only nullable columns or columns with a server/Python default are
    eligible (non-nullable without a default would break existing rows).

    This avoids Alembic complexity while keeping the production Postgres schema
    in sync with models.py across deploys.

    R2-741: the original per-table body was try/except: continue which swallowed
    the reason a column failed to be added (e.g. type mismatch, permission).
    The silent swallow is what made the D2/CD-4 outage invisible: boot sync
    tried and failed to add pf_wage_ceiling / assume_full_month_when_no_attendance
    / attendance_source but never logged the exception, so Sentry only saw the
    downstream UndefinedColumn on login. Now every failure is logged to stderr
    with table and column context, and the loop continues so one bad column does
    not block the rest. Strict re-raise is left to the lifespan's M-2 guard if
    the whole sync path fails.
    """
    if not engine.url.drivername.startswith("postgresql"):
        return
    from app import models as _models
    from sqlalchemy import text, inspect as sa_inspect

    insp = sa_inspect(engine)
    with engine.begin() as conn:
        for tname, tmeta in _models.Base.metadata.tables.items():
            try:
                existing_cols = {c["name"] for c in insp.get_columns(tname)}
            except Exception as e:
                print(f"[schema_sync] failed for {tname}: {e}", file=sys.stderr)
                continue
            for col in tmeta.columns:
                if col.name in existing_cols:
                    continue
                # Only add nullable columns or those with a default value.
                if not (col.nullable or col.default is not None or col.server_default is not None):
                    print(f"[schema_sync] skipping non-nullable no-default column {tname}.{col.name}", file=sys.stderr)
                    continue
                try:
                    col_type = col.type.compile(dialect=engine.dialect)
                    # Build DEFAULT clause when a server_default exists.
                    default_clause = ""
                    if col.server_default is not None:
                        default_clause = f" DEFAULT {col.server_default.arg}"
                    stmt = f'ALTER TABLE "{tname}" ADD COLUMN IF NOT EXISTS "{col.name}" {col_type}{default_clause}'
                    conn.execute(text(stmt))
                    print(f"[schema_sync] added {tname}.{col.name} ({col_type})", file=sys.stderr)
                except Exception as e:
                    print(f"[schema_sync] failed for {tname}.{col.name}: {e}", file=sys.stderr)
                    continue

    # (call runs in lifespan)


def ensure_material_wastage_reported_by_uuid():
    """R2-730: material_wastage.reported_by migration 20260816_000005 never ran on prod.

    Live Supabase had ``reported_by`` as VARCHAR with 2 free-text rows; the model
    declares UUID FK to company_team.id. The migration's USING clause nulls
    non-UUID values and adds the FK. Boot sync only adds missing columns, so
    this type mismatch stays silently wrong and SQLAlchemy raises
    ``ValueError: badly formed hexadecimal UUID string`` on the wastage read path.

    Fix is idempotent and covers both runtimes:
      * SQLite (test/dev): clean non-UUID values to NULL so reads never 500.
        SQLite cannot ALTER COLUMN TYPE in place without a table rebuild, but
        nulling bad data prevents the ORM coercion failure.
      * Postgres (prod): ALTER TYPE UUID USING CASE WHEN reported_by ~ uuid THEN
        ::uuid ELSE NULL END, and add the FK if missing. Mirrors the repo
        migration file exactly.
    """
    import re

    if engine.url.drivername.startswith("sqlite"):
        with engine.begin() as conn:
            exists = conn.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='material_wastage'"
            ).fetchone()
            if not exists:
                return
            cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(material_wastage)").fetchall()}
            if "reported_by" not in cols:
                try:
                    conn.exec_driver_sql('ALTER TABLE material_wastage ADD COLUMN "reported_by" CHAR(36)')
                except Exception as e:
                    print(f"ensure_material_wastage_reported_by_uuid sqlite add column skip: {e}")
                return
            uuid_re = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
            try:
                rows = conn.exec_driver_sql(
                    "SELECT id, reported_by FROM material_wastage WHERE reported_by IS NOT NULL"
                ).fetchall()
            except Exception:
                return
            for rid, rb in rows:
                if rb is None:
                    continue
                if not uuid_re.match(str(rb)):
                    try:
                        conn.exec_driver_sql(
                            "UPDATE material_wastage SET reported_by = NULL WHERE id = ?", (str(rid),)
                        )
                    except Exception as e:
                        print(f"ensure_material_wastage_reported_by_uuid sqlite null skip {rid}: {e}")
        return

    if engine.url.drivername.startswith("postgresql"):
        from sqlalchemy import text
        from sqlalchemy import inspect as sa_inspect

        insp = sa_inspect(engine)
        with engine.begin() as conn:
            try:
                col = next(
                    (c for c in insp.get_columns("material_wastage") if c["name"] == "reported_by"),
                    None,
                )
            except Exception:
                return
            if col is None:
                try:
                    conn.execute(text(
                        'ALTER TABLE "material_wastage" ADD COLUMN IF NOT EXISTS "reported_by" UUID REFERENCES "company_team"("id") ON DELETE SET NULL'
                    ))
                    print("ensure_material_wastage_reported_by_uuid: added missing reported_by column (postgres)")
                except Exception as e:
                    print(f"ensure_material_wastage_reported_by_uuid postgres add column skip: {e}")
                return
            type_str = str(col["type"]).lower()
            if "uuid" not in type_str:
                try:
                    conn.execute(text(
                        """
                        ALTER TABLE "material_wastage"
                        ALTER COLUMN "reported_by" TYPE UUID
                        USING (CASE WHEN "reported_by" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN "reported_by"::uuid ELSE NULL END)
                        """
                    ))
                    print("ensure_material_wastage_reported_by_uuid: converted reported_by to UUID (postgres)")
                except Exception as e:
                    print(f"ensure_material_wastage_reported_by_uuid postgres type conversion skip: {e}")
            try:
                fk_exists = conn.execute(text(
                    """
                    SELECT 1 FROM pg_constraint
                    WHERE conname = 'material_wastage_reported_by_fkey'
                    AND conrelid = 'material_wastage'::regclass
                    """
                )).fetchone()
            except Exception:
                fk_exists = None
            if not fk_exists:
                try:
                    conn.execute(text(
                        'ALTER TABLE "material_wastage" ADD CONSTRAINT "material_wastage_reported_by_fkey" FOREIGN KEY ("reported_by") REFERENCES "company_team"("id") ON DELETE SET NULL'
                    ))
                    print("ensure_material_wastage_reported_by_uuid: added FK material_wastage_reported_by_fkey")
                except Exception as e:
                    print(f"ensure_material_wastage_reported_by_uuid postgres FK skip: {e}")
        return


# NOTE (D-V1): the historical auto_seed_database() that created the shared demo
# tenant ("Demo Construction Ltd", e0000000-...), a demo user and showcase
# projects on EVERY boot was removed. No code path may create that tenant; a
# demo, if ever needed again, is a real company seeded deliberately.

# Initialize Sentry error tracking before the FastAPI app is constructed.
# Gated on a non-empty DSN: calling sentry_sdk.init with an empty DSN is a
# silent no-op, but we skip it explicitly so behaviour is obvious in logs and
# we never spend startup cost when Sentry is not configured (e.g. local dev).
from app.config import settings as _app_settings

if _app_settings.SENTRY_DSN:
    import sentry_sdk
    from sentry_sdk.integrations.fastapi import FastApiIntegration
    from sentry_sdk.integrations.starlette import StarletteIntegration

    sentry_sdk.init(
        dsn=_app_settings.SENTRY_DSN,
        release=_app_settings.SENTRY_RELEASE or None,
        integrations=[StarletteIntegration(), FastApiIntegration()],
        # Error tracking, not full APM: sample a small fraction of transactions
        # for performance rather than tracing every request in prod.
        traces_sample_rate=0.1,
    )
    print("Sentry error tracking initialized.")
else:
    print("SENTRY_DSN not set; Sentry error tracking disabled.")

# ── Startup lifecycle ─────────────────────────────────────────────────────────
# All schema-sync side effects that historically ran at MODULE IMPORT
# time now live here. Running them in the FastAPI lifespan guarantees they
# execute exactly once per process boot - and crucially NOT once per worker when
# the app is served by Gunicorn/Uvicorn with --workers N (each worker re-imports
# the module, so import-time code double-seeds/races). Importing this module
# (e.g. from pytest) no longer touches the database.
@asynccontextmanager
async def lifespan(app: FastAPI):
    # SQLite dev schema sync (local/SQLite auto-fallback only; in production
    # schema changes run via Supabase SQL migrations).
    #
    # This guard is load-bearing, not tidiness. Until 2026-09-02 the call ran
    # against whatever DATABASE_URL pointed at, so a model added without a
    # hand-written migration was created in production silently, with no row
    # level security and no policy. That is how kyc_access_logs, the audit trail
    # for identity-document access, ended up as the only table of 140 without
    # RLS, and nothing caught it until Supabase emailed. A missing table now
    # fails loudly on first query, which is the safer failure.
    #
    # Production column drift is handled separately by
    # ensure_postgres_schema_sync() at the end of this function.
    if engine.url.drivername.startswith("sqlite"):
        Base.metadata.create_all(bind=engine)
    ensure_sqlite_library_party_columns()
    ensure_sqlite_company_team_party_link()
    _seed_db = SessionLocal()
    try:
        backfill_company_team_party_links(_seed_db)
    finally:
        _seed_db.close()
    ensure_sqlite_library_cost_code_columns()
    ensure_sqlite_company_slug_column()
    ensure_sqlite_company_parent_column()
    ensure_sqlite_project_tab_columns()
    ensure_sqlite_bill_columns()
    ensure_sqlite_task_columns()
    ensure_sqlite_schema_sync()
    ensure_postgres_schema_sync()  # Production PostgreSQL: add missing model columns
    ensure_material_wastage_reported_by_uuid()  # R2-730: repair 20260816_000005 type mismatch (VARCHAR -> UUID FK)
    # M-1: Render's Docker context is backend/ so supabase/migrations is not in the image.
    # The startup runner cannot work in production and would silently pretend it did (R2-730).
    # Production migrations run ONLY via CI workflow .github/workflows/migrate.yml (full checkout,
    # apply_migrations.py --strict). Keep the startup hook only for SQLite dev where it also
    # remediates unique constraints via _ensure_sqlite_unique_constraints().
    # R2-731 / M-2+M-3: strict-by-default in production + pg_advisory_lock still applies when invoked.
    try:
        from app.migration_runner import apply_pending_migrations, _is_sqlite as _migration_is_sqlite

        try:
            _is_sqlite_lifespan = _migration_is_sqlite(engine)
        except Exception:
            _is_sqlite_lifespan = str(getattr(getattr(engine, "url", ""), "drivername", "")).startswith("sqlite") or "sqlite" in str(
                getattr(engine, "url", "")
            ).lower()
        if _is_sqlite_lifespan:
            apply_pending_migrations()
        else:
            print(
                "[lifespan] skipping startup migration_runner on Postgres -- migrations via CI workflow "
                ".github/workflows/migrate.yml (M-1: Render backend/ context has no supabase/migrations)",
                file=sys.stderr,
            )
    except Exception as e:
        # M-2: crash boot in production/strict mode so missing schema does not leave API up.
        # Only swallow in dev. Runner's own per-file strict handles most cases; this
        # outer guard catches whole-pass failures (e.g., lock, tracking table).
        # Reuse runner's strict helper so prod default and explicit overrides stay consistent.
        try:
            from app.migration_runner import _is_strict_mode as _lifespan_is_strict

            _is_strict = _lifespan_is_strict()
        except Exception:
            _env = os.getenv("ENVIRONMENT", "")
            if not _env.strip():
                try:
                    from app.config import settings as _lifespan_settings

                    _env = _lifespan_settings.ENVIRONMENT or ""
                except Exception:
                    _env = ""
            _env = _env.strip().lower()
            _strict_raw = os.getenv("MIGRATION_RUNNER_STRICT", "")
            if _strict_raw is not None and _strict_raw.strip() != "":
                _is_strict = _strict_raw.strip().lower() in ("1", "true", "yes", "on")
            else:
                _is_strict = _env == "production"
        if _is_strict:
            print(f"[lifespan] migration_runner FAILED in strict/production mode -- aborting boot: {e}")
            raise
        print(f"[lifespan] migration_runner error (non-fatal, dev): {e}")
    os.makedirs(os.path.join(STATIC_DIR, "reports"), exist_ok=True)
    yield


app = FastAPI(
    title="SiteFlow - Construction Management API",
    description="Backend microservice handling operational logic, calculators, and integrations.",
    version="3.0.0",
    lifespan=lifespan,
    # Members limited to some projects cannot reach any other project's data.
    dependencies=[Depends(enforce_project_scope)],
)

# Rate limiting (slowapi). The limiter instance itself lives in app.rate_limit so
# routers can import it directly and decorate individual endpoints without a
# circular import. Only applied per-route (see e.g. app/routers/auth.py OTP
# endpoints) rather than globally, so no SlowAPIMiddleware is registered here.
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

@app.exception_handler(IntegrityError)
async def integrity_error_handler(request, exc: IntegrityError):
    # A referential or uniqueness constraint rejected the write - e.g. a
    # delete whose parent is still referenced by an FK with no ondelete rule.
    # That is the client's conflict to resolve, not a server fault.
    if exc.orig is not None:
        detail = str(exc.orig).split("\n")[0]
    else:
        detail = str(exc)
    return JSONResponse(
        status_code=409,
        content={"detail": f"Record is still referenced by another row: {detail}"},
    )


@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError):
    # Malformed path/query params that were taken as str and converted manually
    # via uuid.UUID(str(x)) or date.fromisoformat(x) raise ValueError. Without
    # this handler they escape to the catch-all Exception handler as 500 and
    # pollute Sentry (malformed UUID, not-a-date, not-a-zip). Return 422 so
    # they are correctly classified as client errors.
    logger.warning("ValueError: %s", exc)
    return JSONResponse(
        status_code=422,
        content={"detail": str(exc) if str(exc) else "Invalid value"},
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    # R2-194: an exception that escapes every router is rendered by
    # ServerErrorMiddleware, which sits OUTSIDE CORSMiddleware - so a bare 500
    # would reach the browser without CORS headers and surface as an opaque
    # network failure instead of a status code. The origin is echoed only when
    # whitelisted so allow_credentials stays valid; the detail stays generic so
    # internals never leak. Starlette still logs and re-raises afterwards.
    origin = request.headers.get("origin")
    headers = {}
    if origin and origin in _app_settings.allowed_origins_list:
        headers = {
            "access-control-allow-origin": origin,
            "access-control-allow-credentials": "true",
        }
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
        headers=headers,
    )

# Configure CORS for Next.js frontend communication.
# Allowed origins are parsed dynamically from ALLOWED_ORIGINS and FRONTEND_URL env vars.
# Explicit whitelist prevents wildcard (*) access and rejects unauthorized origins.
ALLOWED_ORIGINS = _app_settings.allowed_origins_list

# In production, disable loose origin regexes so only explicit whitelist origins are permitted.
cors_origin_regex = _app_settings.FRONTEND_ORIGIN_REGEX if _app_settings.is_local_env else None

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=cors_origin_regex,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Admin-Secret"],
    expose_headers=["Content-Disposition", "X-Total-Count", "X-Limit", "X-Offset"],
)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# Register routers
app.include_router(auth.router, prefix="/apis/v3")
app.include_router(calculators.router, prefix="/apis/v3")
app.include_router(budgeting.router, prefix="/apis/v3")
app.include_router(planning.router, prefix="/apis/v3")
app.include_router(drawings.router, prefix="/apis/v3")
app.include_router(procurement.router, prefix="/apis/v3")
app.include_router(billing.router, prefix="/apis/v3")
app.include_router(hr.router, prefix="/apis/v3")
app.include_router(quality.router, prefix="/apis/v3")
app.include_router(reports.router, prefix="/apis/v3")
app.include_router(equipment.router, prefix="/apis/v3")
app.include_router(safety.router, prefix="/apis/v3")
app.include_router(analytics.router, prefix="/apis/v3")
app.include_router(production.router, prefix="/apis/v3")
app.include_router(dpr.router, prefix="/apis/v3")
app.include_router(crm.router, prefix="/apis/v3")
app.include_router(finance.router, prefix="/apis/v3")
app.include_router(finance.cashbook_router, prefix="/apis/v3")
app.include_router(tally.router, prefix="/apis/v3")
app.include_router(subcon_attendance.router, prefix="/apis/v3")
app.include_router(settings.router, prefix="/apis/v3")
app.include_router(assets.router, prefix="/apis/v3")
app.include_router(three_way.router, prefix="/apis/v3")
app.include_router(wastage.router, prefix="/apis/v3")
app.include_router(chat.router, prefix="/apis/v3")
app.include_router(custom_fields.router, prefix="/apis/v3")
app.include_router(statutory.router, prefix="/apis/v3")
app.include_router(face_recognition.router, prefix="/apis/v3")
from app.routers import biometric as _biometric  # noqa: E402
app.include_router(_biometric.router, prefix="/apis/v3")
# Biometric terminals call /iclock/* at the server root (ADMS push protocol).
app.include_router(_biometric.adms_router)
app.include_router(subcon_performance.router, prefix="/apis/v3")
app.include_router(vendor_performance.router, prefix="/apis/v3")
app.include_router(rfq.router, prefix="/apis/v3")
app.include_router(labour.router, prefix="/apis/v3")
app.include_router(towers.router, prefix="/apis/v3")
app.include_router(budget.router, prefix="/apis/v3")
app.include_router(library.router, prefix="/apis/v3")
app.include_router(profile.router, prefix="/apis/v3")
app.include_router(mom.router, prefix="/apis/v3")
app.include_router(projects.router, prefix="/apis/v3")
app.include_router(todos.router, prefix="/apis/v3")
app.include_router(delete_logs.router, prefix="/apis/v3/delete-logs")
from app.routers import files as files_router
app.include_router(files_router.router, prefix="/apis/v3")
app.include_router(team_schedule.router, prefix="/apis/v3")
from app.routers import google_sheets as google_sheets_router
app.include_router(google_sheets_router.router, prefix="/apis/v3")
from app.routers import google_auth as google_auth_router
app.include_router(google_auth_router.router, prefix="/apis/v3")
from app.routers import admin_migrations as admin_migrations_router
app.include_router(admin_migrations_router.router, prefix="/apis/v3")
from app.routers import admin_pos as admin_pos_router
app.include_router(admin_pos_router.router, prefix="/apis/v3")
from app.routers import google_drive as google_drive_router
app.include_router(google_drive_router.router, prefix="/apis/v3")
from app.routers import bi_export as bi_export_router
app.include_router(bi_export_router.router, prefix="/apis/v3")
from app.routers import zoho_books as zoho_books_router
app.include_router(zoho_books_router.router, prefix="/apis/v3")
from app.routers import public_leads as public_leads_router
app.include_router(public_leads_router.router, prefix="/apis/v3")

@app.api_route("/apis/v3/{unmatched_path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
def api_v3_not_found(unmatched_path: str):
    raise HTTPException(status_code=404, detail="Not found")

@app.get("/")
def read_root():
    return {
        "status": "healthy",
        "service": "SiteFlow Core API Engine",
        "version": "3.0.0"
    }

@app.get("/health")
def health_check():
    # R2-080: stable liveness path for uptime pingers to hit instead of "/".
    # Deliberately cheap (no DB, no auth) so a wake-up ping answers fast.
    return {"status": "ok"}
