"""BI Data Export integration (PowerBI / Tableau).

BI tools do NOT OAuth into us; they CONSUME a data feed. This module issues
per-company API keys (raw key shown once, only a hash stored, HMAC-SHA256 keyed
by SECRET_KEY), and serves read-only CSV/JSON feeds authenticated by that key
header (NOT the session JWT). A key only ever reads its own company's data, and
the feed endpoints are rate-limited.

Key hashing reuses the app's existing OTP hashing approach (HMAC-SHA256 keyed by
SECRET_KEY, see app/routers/auth.py _hash_otp).
"""
import csv
import hashlib
import hmac
import io
import secrets as pysecrets
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.auth import get_company_membership, get_current_user, require_permission
from app.config import settings
from app.constants import REVENUE_INVOICE_TYPES, EXPENSE_INVOICE_TYPES
# R2-743: the shared CSV formula guard, so this exporter cannot drift from the
# other three again.
from app.csv_export import csv_safe_cell
from app.database import get_db
from app.rate_limit import limiter
from app.bill_scope import _active_bills
from app import models
from app.equipment_cost import owned_deployment_cost

router = APIRouter(prefix="/integrations/bi", tags=["Integrations - BI Export"])

KEY_PREFIX = "siteflow_bi_"
STATE_PURPOSE = "bi_export"

FEED_RATE_LIMIT = "120/minute"


# ── Helpers ──────────────────────────────────────────────────────────────────

def _hash_key(raw: str) -> str:
    return hmac.new(settings.SECRET_KEY.encode("utf-8"), raw.encode("utf-8"), hashlib.sha256).hexdigest()


def _mask(key_hash: str) -> str:
    return f"{KEY_PREFIX}{key_hash[-6:]}"


def _extract_api_key(request: Request) -> Optional[str]:
    auth = request.headers.get("authorization")
    if auth and auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return (request.headers.get("x-api-key") or "").strip() or None


def _resolve_key(company_id: uuid.UUID, request: Request, db: Session) -> models.BiApiKey:
    raw = _extract_api_key(request)
    if not raw:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing API key (send X-API-Key header or Authorization: Bearer)",
        )
    key_hash = _hash_key(raw)
    key = (
        db.query(models.BiApiKey)
        .filter(
            models.BiApiKey.company_id == company_id,
            models.BiApiKey.key_hash == key_hash,
            models.BiApiKey.revoked == False,  # noqa: E712
        )
        .first()
    )
    if not key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or revoked API key")
    now = datetime.now(timezone.utc)
    if key.last_used_at is None or key.last_used_at.tzinfo is None or (now - key.last_used_at).total_seconds() > 300:
        key.last_used_at = now
        db.commit()
    return key


def _to_csv(rows: List[dict], columns: List[str]) -> str:
    # R2-743: neutralise formula cells here, in the single writer every feed
    # route renders through (feed_projects, feed_budget_variance,
    # feed_labour_productivity). Applying the guard per call site is exactly
    # what let this site be missed while its three siblings were protected.
    #
    # That matters most on this feed: it is built for a machine, not for a human
    # glance. A BI key is long-lived and polled on a schedule, so a payload
    # lands on every refresh with no user in the loop. And csv.DictWriter's
    # quote-doubling protects the delimiter, not the formula -- a leading "="
    # survives a correctly-quoted field entirely intact.
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    for r in rows:
        writer.writerow({k: csv_safe_cell(v) for k, v in r.items()})
    return buf.getvalue()


def _feed_response(rows: List[dict], columns: List[str], fmt: str):
    if fmt == "json":
        return JSONResponse(content=rows)
    csv_text = _to_csv(rows, columns)
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=export.csv", "Cache-Control": "no-store"},
    )


# ── Key management (session JWT, settings:manage) ────────────────────────────

class BiKeyCreate(BaseModel):
    label: str


class BiKeyOut(BaseModel):
    id: str
    label: str
    key: str
    created_at: Optional[str] = None


@router.post("/companies/{company_id}/keys", response_model=BiKeyOut)
def create_key(
    company_id: uuid.UUID,
    body: BiKeyCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Create a BI API key. The raw key is returned ONCE and never stored again."""
    get_company_membership(db, current_user, company_id)
    require_permission(db, current_user, company_id, "settings:manage")
    label = (body.label or "").strip()
    if not label:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="label is required")

    raw = f"{KEY_PREFIX}{pysecrets.token_urlsafe(32)}"
    key = models.BiApiKey(
        company_id=company_id,
        label=label,
        key_hash=_hash_key(raw),
        created_by_user_id=current_user.id,
    )
    db.add(key)
    db.commit()
    db.refresh(key)
    return BiKeyOut(
        id=str(key.id),
        label=key.label,
        key=raw,
        created_at=key.created_at.isoformat() if key.created_at else None,
    )


@router.get("/companies/{company_id}/keys")
def list_keys(
    company_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """List the company's BI keys (masked; the raw key is never returned again)."""
    get_company_membership(db, current_user, company_id)
    require_permission(db, current_user, company_id, "settings:manage")
    rows = (
        db.query(models.BiApiKey)
        .filter(models.BiApiKey.company_id == company_id)
        .order_by(models.BiApiKey.created_at.desc())
        .all()
    )
    return [
        {
            "id": str(k.id),
            "label": k.label,
            "masked_key": _mask(k.key_hash),
            "created_at": k.created_at.isoformat() if k.created_at else None,
            "last_used_at": k.last_used_at.isoformat() if k.last_used_at else None,
            "revoked": k.revoked,
        }
        for k in rows
    ]


@router.delete("/companies/{company_id}/keys/{key_id}")
def revoke_key(
    company_id: uuid.UUID,
    key_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Revoke (soft-delete) a BI API key."""
    get_company_membership(db, current_user, company_id)
    require_permission(db, current_user, company_id, "settings:manage")
    key = (
        db.query(models.BiApiKey)
        .filter(models.BiApiKey.id == key_id, models.BiApiKey.company_id == company_id)
        .first()
    )
    if not key:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="API key not found")
    key.revoked = True
    db.commit()
    return {"ok": True, "revoked": True}


# ── Feeds (API key auth, rate-limited) ──────────────────────────────────────

@router.get("/feed/{company_id}/projects")
@limiter.limit(FEED_RATE_LIMIT)
def feed_projects(
    request: Request,
    company_id: uuid.UUID,
    fmt: str = Query(default="csv", pattern="^(csv|json)$"),
    db: Session = Depends(get_db),
):
    _resolve_key(company_id, request, db)
    projects = db.query(models.Project).filter(models.Project.company_id == company_id).all()
    rows = []
    for p in projects:
        rows.append(
            {
                "project_id": str(p.id),
                "name": p.name,
                "code": p.code,
                "status": p.status,
                "city": p.city,
                "state": p.state,
                "category": p.category,
                "stage": p.stage,
                "health": p.health,
                "project_value": float(p.project_value or 0),
                "planned_start_date": p.planned_start_date.isoformat() if p.planned_start_date else "",
                "planned_end_date": p.planned_end_date.isoformat() if p.planned_end_date else "",
            }
        )
    columns = [
        "project_id", "name", "code", "status", "city", "state",
        "category", "stage", "health", "project_value",
        "planned_start_date", "planned_end_date",
    ]
    return _feed_response(rows, columns, fmt)


@router.get("/feed/{company_id}/budget-variance")
@limiter.limit(FEED_RATE_LIMIT)
def feed_budget_variance(
    request: Request,
    company_id: uuid.UUID,
    fmt: str = Query(default="csv", pattern="^(csv|json)$"),
    db: Session = Depends(get_db),
):
    _resolve_key(company_id, request, db)
    projects = db.query(models.Project).filter(models.Project.company_id == company_id).all()
    rows = []
    for p in projects:
        budget = db.query(models.ProjectBudget).filter(models.ProjectBudget.project_id == p.id).first()
        material_budget = float(budget.material_budget or 0) if budget else 0.0
        labour_budget = float(budget.labour_budget or 0) if budget else 0.0
        subcon_budget = float(budget.subcon_budget or 0) if budget else 0.0
        equipment_budget = float(budget.equipment_budget or 0) if budget else 0.0
        total_budget = material_budget + labour_budget + subcon_budget + equipment_budget

        # R2-289: partition the shared EXPENSE_INVOICE_TYPES scope head-for-head
        # like budget.py (purchase -> material, subcon -> subcon, equipment ->
        # plant, anything else e.g. "expense" -> other) so the BI feed and the
        # Budget module can never disagree about the same project again.
        material_actual = subcon_actual = equipment_bill_total = other_actual = 0.0
        for b in _active_bills(db, p.id, EXPENSE_INVOICE_TYPES).all():
            amount = float(b.subtotal or 0)
            if b.invoice_type == "purchase":
                material_actual += amount
            elif b.invoice_type == "subcon":
                subcon_actual += amount
            elif b.invoice_type == "equipment":
                equipment_bill_total += amount
            else:
                other_actual += amount
        # Labour actual: sum of payroll line-item net payables for this project's finalized runs (C2).
        labour_actual = float(
            db.query(func.coalesce(func.sum(models.PayrollLineItem.gross_salary + models.PayrollLineItem.pf_employer + models.PayrollLineItem.esi_employer), 0))
            .join(models.PayrollRun)
            .filter(
                models.PayrollRun.project_id == p.id,
                models.PayrollRun.status == "finalized",
            )
            .scalar()
            or 0
        )
        # Equipment actual: equipment-type bills (partitioned above) + deployment
        # hourly cost + fuel cost (mirrors budget.py). Active bills only: a
        # cancelled bill must not book cost (R2-723).
        equipment_actual = equipment_bill_total
        equipment_actual += owned_deployment_cost(db, p.id)
        fuel_logs = db.query(models.FuelLog).filter(models.FuelLog.project_id == p.id).all()
        equipment_actual += sum(float(log.total_cost or 0.0) for log in fuel_logs)

        total_actual = material_actual + subcon_actual + labour_actual + equipment_actual + other_actual
        rows.append(
            {
                "project_id": str(p.id),
                "name": p.name,
                "material_budget": material_budget,
                "labour_budget": labour_budget,
                "subcon_budget": subcon_budget,
                "equipment_budget": equipment_budget,
                "total_budget": total_budget,
                "material_actual": material_actual,
                "subcon_actual": subcon_actual,
                "labour_actual": labour_actual,
                "equipment_actual": equipment_actual,
                "other_actual": other_actual,
                "total_actual": total_actual,
                "total_variance": total_budget - total_actual,
            }
        )
    columns = [
        "project_id", "name", "material_budget", "labour_budget", "subcon_budget",
        "equipment_budget", "total_budget", "material_actual", "subcon_actual",
        "labour_actual", "equipment_actual", "other_actual", "total_actual", "total_variance",
    ]
    return _feed_response(rows, columns, fmt)


@router.get("/feed/{company_id}/labour-productivity")
@limiter.limit(FEED_RATE_LIMIT)
def feed_labour_productivity(
    request: Request,
    company_id: uuid.UUID,
    fmt: str = Query(default="csv", pattern="^(csv|json)$"),
    db: Session = Depends(get_db),
):
    _resolve_key(company_id, request, db)
    projects = db.query(models.Project).filter(models.Project.company_id == company_id).all()
    rows = []
    for p in projects:
        logs = db.query(models.AttendanceLog).filter(models.AttendanceLog.project_id == p.id).all()
        total_punches = len(logs)
        total_hours = sum(float(l.hours_worked or 0) for l in logs)
        geofenced = sum(1 for l in logs if l.is_within_geofence)
        present = sum(1 for l in logs if (l.status or "").lower().startswith("present"))
        distinct_employees = len({str(l.employee_id) for l in logs})
        avg_hours = (total_hours / total_punches) if total_punches else 0.0
        rows.append(
            {
                "project_id": str(p.id),
                "name": p.name,
                "total_attendance_logs": total_punches,
                "distinct_employees": distinct_employees,
                "total_hours_worked": round(total_hours, 2),
                "avg_hours_per_log": round(avg_hours, 2),
                "geofenced_logs": geofenced,
                "present_logs": present,
            }
        )
    columns = [
        "project_id", "name", "total_attendance_logs", "distinct_employees",
        "total_hours_worked", "avg_hours_per_log", "geofenced_logs", "present_logs",
    ]
    return _feed_response(rows, columns, fmt)
