from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy.orm import Session
from sqlalchemy import func, Numeric, Boolean, DateTime, String
from datetime import datetime
from typing import List, Optional
from app.database import get_db
from app import models
from app.auth import get_current_user, verify_company_access, verify_project_access, get_company_membership, require_permission
from app.routers.custom_fields import CustomFieldValueInput, upsert_values_for_entity, enforce_required_custom_fields
from app.constants import (
    EXPENSE_INVOICE_TYPES,
    PROJECT_STATUS_PATTERN,
    REVENUE_INVOICE_TYPES,
    is_expense_invoice_type,
    is_revenue_invoice_type,
)
import uuid

router = APIRouter(prefix="/projects", tags=["Projects"], dependencies=[Depends(get_current_user)])


def _to_float(value):
    try:
        if value is None:
            return 0.0
        return float(value)
    except (ValueError, TypeError):
        return 0.0


def _party_settlement(db, project_id, party_id, opening_adv, opening_pay):
    """A project party's balances, from its opening balance and live activity.

    Bridge: a library party links to its billing-side company_team via
    CompanyTeam.library_party_id (auto-linked by name at startup). Bills and
    payments reference party_company_user_id = company_team.id.

    Two ledgers, because one party can be paid by us and pay us:
    - payable: opening advance (+) / opening to-pay (-), each expense bill adds
      (paid - payable), and money we paid that settled no bill is an advance.
    - receivable: each revenue bill adds (payable - paid), and money the party
      paid us that settled no bill is an advance received.
    Revenue bills and advances used to be ignored, so a client always showed
    Rs 0 and a mobilisation advance never appeared.
    """
    team_ids = [
        t.id
        for t in db.query(models.CompanyTeam).filter(
            models.CompanyTeam.library_party_id == party_id
        ).all()
    ]
    if not team_ids:
        lp = db.query(models.LibraryParty).filter(models.LibraryParty.id == party_id).first()
        if lp and lp.name:
            teams = (
                db.query(models.CompanyTeam)
                .join(models.User, models.User.id == models.CompanyTeam.user_id)
                .filter(
                    models.CompanyTeam.company_id == lp.company_id,
                    func.lower(func.trim(models.User.name)) == lp.name.strip().lower(),
                )
                .all()
            )
            team_ids = [t.id for t in teams]

    pay_net = float(opening_adv or 0) - float(opening_pay or 0)
    rec_net = 0.0
    if team_ids:
        bills = (
            db.query(models.Bill)
            .filter(
                models.Bill.project_id == project_id,
                models.Bill.party_company_user_id.in_(team_ids),
                models.Bill.status != "Cancelled",
            )
            .all()
        )
        for b in bills:
            # D3: settlement cash movements are not accruals.
            if is_expense_invoice_type(b.invoice_type):
                pay_net += _to_float(b.paid_amount) - _to_float(b.total_payable)
            elif is_revenue_invoice_type(b.invoice_type):
                rec_net += _to_float(b.total_payable) - _to_float(b.paid_amount)
        for ptype, amt in (
            db.query(models.Payment.payment_type, func.coalesce(func.sum(models.Payment.unsettled_amount), 0))
            .filter(
                models.Payment.project_id == project_id,
                models.Payment.party_company_user_id.in_(team_ids),
                models.Payment.unsettled_amount > 0,
            )
            .group_by(models.Payment.payment_type)
            .all()
        ):
            if ptype == "out":
                pay_net += _to_float(amt)
            elif ptype == "in":
                rec_net -= _to_float(amt)

    return {
        "advance_paid": round(max(0.0, pay_net), 2),
        "to_pay": round(max(0.0, -pay_net), 2),
        "to_receive": round(max(0.0, rec_net), 2),
        "advance_received": round(max(0.0, -rec_net), 2),
    }


def ensure_project_party_link(db: Session, project_id, party_id) -> None:
    """R2-487: raise a bill against a party and the project-party link must
    exist by the time the request commits - the Party register and the
    balances rollup iterate over project_parties rows only, so a bill without
    a link left the screen answering 'No parties linked to this project' and
    Rs 0 To Pay while unpaid bills sat one tab away. Idempotent upsert with
    zero opening balances; commits with the caller's transaction."""
    if project_id is None or party_id is None:
        return
    existing = db.query(models.ProjectParty).filter(
        models.ProjectParty.project_id == project_id,
        models.ProjectParty.party_id == party_id,
    ).first()
    if existing:
        return
    db.add(models.ProjectParty(
        project_id=project_id,
        party_id=party_id,
        balance=0.0,
        advance_paid=0.0,
        to_pay=0.0,
        status="Active",
    ))

# ─── helpers ───

_TASK_PROGRESS = {
    "not_started": 0.0,
    "start": 0.1,
    "ongoing": 0.5,
    "in_progress": 0.5,
    "completed": 1.0,
}


def _parse_dt(value: Optional[str]):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    candidate = str(value).strip()
    if not candidate:
        return None
    normalized = candidate.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(candidate, fmt)
        except ValueError:
            continue
    return None


def _project_progress(db: Session, project_id: uuid.UUID) -> float:
    tasks = db.query(models.Task).filter(models.Task.project_id == project_id).all()
    if not tasks:
        return 0.0
    total_dur = sum((t.duration_days or 0) for t in tasks) or 1
    earned = sum(
        (t.duration_days or 0) * (float(t.progress or 0.0) / 100.0 if t.progress is not None else _TASK_PROGRESS.get(t.status, 0.0))
        for t in tasks
    )
    return round(earned / total_dur * 100, 1)


def _project_cash(db: Session, project_id: uuid.UUID):
    # D3: billed revenue vs billed cost - settlement and movement never count
    cash_in = db.query(func.coalesce(func.sum(models.Bill.total_payable), 0)).filter(
        models.Bill.project_id == project_id, models.Bill.invoice_type.in_(REVENUE_INVOICE_TYPES), models.Bill.status != "Cancelled"
    ).scalar() or 0
    cash_out = db.query(func.coalesce(func.sum(models.Bill.total_payable), 0)).filter(
        models.Bill.project_id == project_id, models.Bill.invoice_type.in_(EXPENSE_INVOICE_TYPES), models.Bill.status != "Cancelled"
    ).scalar() or 0
    return float(cash_in), float(cash_out)


def _serialize_project(db: Session, p: models.Project, include_members=False):
    progress = _project_progress(db, p.id)
    cash_in, cash_out = _project_cash(db, p.id)
    todo_pending = db.query(func.count(models.Todo.id)).join(
        models.TodoAssignee, models.TodoAssignee.todo_id == models.Todo.id
    ).filter(
        models.Todo.project_id == p.id,
        models.Todo.status == "pending"
    ).scalar() or 0
    data = {
        "id": str(p.id),
        "company_id": str(p.company_id),
        "name": p.name,
        "code": p.code,
        "status": p.status,
        "address": p.address,
        "city": p.city,
        "state": p.state,
        "stage": p.stage,
        "category": p.category,
        "project_value": float(p.project_value or 0),
        "planned_start_date": p.planned_start_date.isoformat() if p.planned_start_date else None,
        "planned_end_date": p.planned_end_date.isoformat() if p.planned_end_date else None,
        "actual_start_date": p.actual_start_date.isoformat() if p.actual_start_date else None,
        "actual_end_date": p.actual_end_date.isoformat() if p.actual_end_date else None,
        "orientation": p.orientation,
        "dimension": p.dimension,
        "scope_of_work": p.scope_of_work,
        "project_avatar": p.project_avatar,
        "attendance_radius_meters": p.attendance_radius_meters,
        # R2-750: returned so the console can show and edit the site
        # coordinates. It was persistable only through planning.py and never
        # readable back from this endpoint at all.
        "location": p.location,
        "branch_id": str(p.branch_id) if p.branch_id else None,
        "is_pinned": bool(p.is_pinned),
        "progress": progress,
        "cash_in": cash_in,
        "cash_out": cash_out,
        "todo_pending": todo_pending,
        "created_at": p.created_at.isoformat() if p.created_at else None,
    }
    if include_members:
        members = db.query(models.ProjectMember).filter(
            models.ProjectMember.project_id == p.id
        ).all()
        data["member_ids"] = [str(m.company_team_id) for m in members]
    return data


# ─── schemas ───

def _validate_location(value: Optional[str]) -> Optional[str]:
    """R2-750: normalise a 'latitude,longitude' pair, or reject it.

    Project.location had no writer on the endpoint that creates real projects
    (POST /projects/), so all 7 projects in production carry a null location and
    the attendance geofence never runs -- it lets you configure a radius
    (attendance_radius_meters, default 500) around a point you cannot specify.

    A malformed pair is rejected rather than stored: a silently unparseable
    value re-creates the same inertness and is harder to see than an error.
    """
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    parts = raw.split(",")
    if len(parts) != 2:
        raise ValueError("location must be 'latitude,longitude', for example '19.0760,72.8777'")
    try:
        lat = float(parts[0].strip())
        lng = float(parts[1].strip())
    except ValueError:
        raise ValueError("location must be 'latitude,longitude' with numeric values")
    if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lng <= 180.0):
        raise ValueError("location out of range: latitude -90..90, longitude -180..180")
    return f"{lat},{lng}"


class ProjectCreate(BaseModel):
    company_id: uuid.UUID
    name: str
    code: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    stage: Optional[str] = None
    category: Optional[str] = None
    project_value: float = Field(0.0, ge=0, le=1e15)
    planned_start_date: Optional[str] = None
    planned_end_date: Optional[str] = None
    orientation: Optional[str] = None
    dimension: Optional[str] = None
    scope_of_work: Optional[str] = None
    attendance_radius_meters: int = Field(500, ge=0, le=100000)
    # R2-750: site coordinates. This endpoint creates the real projects, so
    # without this field there is no supported way to place a site on the map.
    location: Optional[str] = None
    branch_id: Optional[uuid.UUID] = None
    member_ids: List[uuid.UUID] = []
    custom_fields: List[CustomFieldValueInput] = []

    @field_validator("location")
    @classmethod
    def _location_is_a_coordinate_pair(cls, v):
        return _validate_location(v)

    @model_validator(mode="after")
    def planned_dates_not_inverted(self):
        start = _parse_dt(self.planned_start_date)
        end = _parse_dt(self.planned_end_date)
        if start and end and end < start:
            raise ValueError("planned_end_date cannot be before planned_start_date")
        return self


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    code: Optional[str] = None
    status: Optional[str] = Field(None, pattern=PROJECT_STATUS_PATTERN)
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    stage: Optional[str] = None
    category: Optional[str] = None
    project_value: Optional[float] = Field(None, ge=0, le=1e15)
    planned_start_date: Optional[str] = None
    planned_end_date: Optional[str] = None
    actual_start_date: Optional[str] = None
    actual_end_date: Optional[str] = None
    orientation: Optional[str] = None
    dimension: Optional[str] = None
    scope_of_work: Optional[str] = None
    project_avatar: Optional[str] = None
    attendance_radius_meters: Optional[int] = Field(None, ge=0, le=100000)
    # R2-750: so coordinates can be added to a project that was created
    # without them -- which today is every project in production.
    location: Optional[str] = None
    branch_id: Optional[uuid.UUID] = None
    custom_fields: Optional[List[CustomFieldValueInput]] = None

    @field_validator("location")
    @classmethod
    def _location_is_a_coordinate_pair(cls, v):
        return _validate_location(v)


class LocationCreate(BaseModel):
    name: str
    parent_id: Optional[uuid.UUID] = None


# ─── project CRUD ───

@router.get("/company/{company_id}")
def list_projects(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    projects = db.query(models.Project).filter(models.Project.company_id == company_id).all()
    return [_serialize_project(db, p) for p in projects]


@router.get("/company/{company_id}/summary")
def project_summary(company_id: uuid.UUID, user_id: Optional[uuid.UUID] = None, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    project_ids = [p.id for p in db.query(models.Project.id).filter(models.Project.company_id == company_id).all()]

    # Approval (Pending) - drawing revisions + credit notes + payment requests
    dr_pending = db.query(func.count(models.DrawingRevision.id)).join(
        models.Drawing, models.Drawing.id == models.DrawingRevision.drawing_id
    ).join(
        models.Project, models.Project.id == models.Drawing.project_id
    ).filter(
        models.Project.company_id == company_id,
        models.DrawingRevision.approval_status == "pending"
    ).scalar() or 0
    cn_pending = db.query(func.count(models.CreditNote.id)).filter(
        models.CreditNote.company_id == company_id,
        models.CreditNote.approval_flag == "pending"
    ).scalar() or 0
    pr_pending = db.query(func.count(models.PaymentRequest.id)).filter(
        models.PaymentRequest.company_id == company_id,
        models.PaymentRequest.approval_status == "Pending"
    ).scalar() or 0
    approvals_pending = int(dr_pending) + int(cn_pending) + int(pr_pending)

    # Material (Pending) - pending material indents
    materials_pending = db.query(func.count(models.MaterialIndent.id)).filter(
        models.MaterialIndent.company_id == company_id,
        models.MaterialIndent.status == "pending"
    ).scalar() or 0

    # To Do (Pending) - assigned to user across the company
    todo_q = db.query(func.count(models.Todo.id)).filter(
        models.Todo.company_id == company_id,
        models.Todo.status == "pending"
    )
    if user_id:
        todo_q = todo_q.join(
            models.TodoAssignee, models.TodoAssignee.todo_id == models.Todo.id
        ).filter(models.TodoAssignee.assignee_id == user_id)
    todos_pending = todo_q.scalar() or 0

    return {
        "project_count": len(project_ids),
        "approvals_pending": approvals_pending,
        "materials_pending": int(materials_pending),
        "todos_pending": int(todos_pending),
    }


# TODO(D-013): profile hook - measure first, trigger when any tenant exceeds 500 bills or 50 projects (whichever first). No perf work now; add timing/sampled logging near bill/project creation when threshold is crossed.
# D-013 trigger: profile when tenant >500 bills or >50 projects
@router.post("/")
def create_project(payload: ProjectCreate, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    get_company_membership(db, current_user, payload.company_id)
    require_permission(db, current_user, payload.company_id, "projects:edit")
    enforce_required_custom_fields(db, payload.company_id, "project", [cf.model_dump() for cf in payload.custom_fields])
    # D4: site state is required for any invoiceable project (POS derives from site)
    if not payload.state or not str(payload.state).strip():
        raise HTTPException(
            status_code=422,
            detail="Project.state is required for invoicing - set the site state (GST state code or name) before creating invoices; place of supply derives from the site per IGST Act s.12(3)",
        )
    try:
        from app.gst_utils import project_state_code as _psc
        if _psc(payload.state) is None:
            raise HTTPException(status_code=422, detail="Project.state must be a valid GST state code or name (e.g. 27, Maharashtra, KA)")
    except HTTPException:
        raise
    except Exception:
        pass
    proj = models.Project(
        company_id=payload.company_id,
        name=payload.name,
        code=payload.code,
        address=payload.address,
        city=payload.city,
        state=payload.state,
        stage=payload.stage,
        category=payload.category,
        project_value=payload.project_value,
        planned_start_date=_parse_dt(payload.planned_start_date),
        planned_end_date=_parse_dt(payload.planned_end_date),
        orientation=payload.orientation,
        dimension=payload.dimension,
        scope_of_work=payload.scope_of_work,
        attendance_radius_meters=payload.attendance_radius_meters,
        # R2-750: persisted on create; planning.py was the only writer before.
        location=payload.location,
        branch_id=payload.branch_id,
        status="Ongoing",
    )
    db.add(proj)
    db.flush()
    for mid in payload.member_ids:
        db.add(models.ProjectMember(project_id=proj.id, company_team_id=mid))
    upsert_values_for_entity(
        db, payload.company_id, "project", proj.id,
        [cf.model_dump() for cf in payload.custom_fields],
    )
    db.commit()
    db.refresh(proj)
    return _serialize_project(db, proj, include_members=True)


@router.get("/{project_id}")
def get_project(project_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    p = db.query(models.Project).filter(models.Project.id == project_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    return _serialize_project(db, p, include_members=True)


@router.put("/{project_id}")
def update_project(project_id: uuid.UUID, payload: ProjectUpdate, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user), _: None = Depends(verify_project_access)):
    p = db.query(models.Project).filter(models.Project.id == project_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    require_permission(db, current_user, p.company_id, "projects:edit")
    updates = payload.model_dump(exclude_unset=True)
    custom_fields = updates.pop("custom_fields", None)
    for field, value in updates.items():
        if field in ("planned_start_date", "planned_end_date", "actual_start_date", "actual_end_date"):
            value = _parse_dt(value)
        setattr(p, field, value)
    # D4: clearing site state is not allowed - POS would become indeterminate
    if "state" in updates:
        if updates["state"] is None or not str(updates["state"]).strip():
            raise HTTPException(
                status_code=422,
                detail="Project.state is required - clearing the site state is not allowed; place of supply derives from the site per IGST Act s.12(3)",
            )
        try:
            from app.gst_utils import project_state_code as _psc2
            if _psc2(updates["state"]) is None:
                raise HTTPException(status_code=422, detail="Project.state must be a valid GST state code or name (e.g. 27, Maharashtra, KA)")
        except HTTPException:
            raise
        except Exception:
            pass
    # If the project currently has no state at all, any update that would leave it
    # invoiceable (i.e. any update post-D4) must supply a state. Legacy rows with
    # blank state can still be updated to add a state, but not left blank.
    if not str(getattr(p, "state", "") or "").strip() and "state" not in updates:
        # Allow non-state updates only if the project already has no bills yet?
        # For simplicity, require state to be supplied alongside any update when blank,
        # mirroring the create requirement. If the caller is not touching state, we
        # still block until they set it, because the site is now invoiceable.
        # Check if project has any bills - if so, definitely require state.
        try:
            from app.models import Bill as _BillCheck
            has_bills = db.query(_BillCheck.id).filter(_BillCheck.project_id == p.id).first() is not None
            if has_bills:
                raise HTTPException(
                    status_code=422,
                    detail="Project.state is required for invoicing - set the site state before updating this project; place of supply derives from the site per IGST Act s.12(3)",
                )
        except HTTPException:
            raise
        except Exception:
            pass
    if p.planned_start_date and p.planned_end_date and p.planned_end_date < p.planned_start_date:
        raise HTTPException(status_code=422, detail="planned_end_date cannot be before planned_start_date")
    if custom_fields:
        enforce_required_custom_fields(db, p.company_id, "project", custom_fields)
    upsert_values_for_entity(db, p.company_id, "project", p.id, custom_fields)
    db.commit()
    db.refresh(p)
    return _serialize_project(db, p, include_members=True)


@router.post("/{project_id}/pin")
def toggle_pin(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user), _: None = Depends(verify_project_access)):
    p = db.query(models.Project).filter(models.Project.id == project_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    require_permission(db, current_user, p.company_id, "projects:edit")
    p.is_pinned = not bool(p.is_pinned)
    db.commit()
    db.refresh(p)
    return {"id": str(p.id), "is_pinned": bool(p.is_pinned)}


# R2-557: every table below hangs off projects.id with ondelete="CASCADE" -
# one DELETE destroys all of their rows for this project in a single
# unconfirmed transaction. The route counts them before touching anything.
PROJECT_CASCADE_CHILDREN = [
    models.BOQItem, models.BOQDocument, models.BOQRevision, models.ProjectBudget,
    models.Task, models.ProjectMilestone, models.Drawing, models.MaterialIndent,
    models.PurchaseOrder, models.GoodsReceiptNote, models.WarehouseInventory,
    models.MaterialTransaction, models.ProductionRecipe, models.ProductionBatch,
    models.WorkOrder, models.Bill, models.DebitNote, models.CreditNote,
    models.StaffEmployee, models.AttendanceLog, models.Timesheet, models.PayrollRun,
    models.SiteInspection, models.NCR, models.MaterialTestResult, models.ClientReport,
    models.EquipmentDeployment, models.FuelLog, models.SafetyIncident,
    models.ToolboxTalk, models.PPECheck, models.DailyProgressReport,
    models.TallyCostCentreMapping, models.SubcontractorAttendance,
    models.ThreeWayMatch, models.MaterialWastage, models.ChatGroup,
    models.FaceRecognitionLog, models.SubcontractorPerformance,
    models.VendorPerformance, models.RFQ, models.ProjectTower, models.BOCWRecord,
    models.MusterRoll, models.MoM, models.ProjectMember, models.ProjectLocation,
    models.ProjectParty, models.Todo, models.FileFolder, models.ProjectFile,
]


@router.delete("/{project_id}")
def delete_project(project_id: uuid.UUID, confirm: Optional[str] = None, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user), _: None = Depends(verify_project_access)):
    p = db.query(models.Project).filter(models.Project.id == project_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    require_permission(db, current_user, p.company_id, "data:delete")
    # R2-300: one DELETE used to cascade away the project's entire financial
    # history (bills, payments, purchase orders, payroll runs all hang off
    # ondelete="CASCADE"/"SET NULL" FKs) with no confirmation of what would be
    # lost and no restore path. Refuse while any financial record remains -
    # a project with books attached must be closed/archived, never deleted.
    financial = {
        "bills": db.query(models.Bill).filter(models.Bill.project_id == p.id).count(),
        "payments": db.query(models.Payment).filter(models.Payment.project_id == p.id).count(),
        "purchase_orders": db.query(models.PurchaseOrder).filter(models.PurchaseOrder.project_id == p.id).count(),
        "payroll_runs": db.query(models.PayrollRun).filter(models.PayrollRun.project_id == p.id).count(),
    }
    if any(financial.values()):
        detail = ", ".join(f"{k}: {v}" for k, v in financial.items() if v)
        raise HTTPException(
            status_code=409,
            detail=f"Project has financial records that would be destroyed ({detail}). Close or archive it instead.",
        )
    # R2-557: preflight the full cascade. The caller is shown exactly how many
    # rows across the 51 child tables will be destroyed and must echo an
    # explicit confirmation token - the project name, the same string the UI's
    # delete modal makes you type. Without it nothing is deleted.
    dependents = {
        m.__tablename__: db.query(m).filter(m.project_id == p.id).count()
        for m in PROJECT_CASCADE_CHILDREN
    }
    total = sum(dependents.values())
    inventory = ", ".join(f"{k}: {v}" for k, v in dependents.items() if v)
    if total and confirm != p.name:
        raise HTTPException(
            status_code=400,
            detail=(
                f"This permanently deletes {total} dependent record(s) ({inventory}) "
                f"and cannot be undone. Retry with confirm={p.name!r} to proceed."
            ),
        )
    from app.routers.delete_logs import log_deletion
    log_deletion(db, p.company_id, "project", str(p.id), f"Project: {p.name}", party_name=p.name, deleted_by=current_user.name)
    db.delete(p)
    db.commit()
    return {"success": True, "deleted_dependents": total}


# ─── Members (Settings → Members) ───

@router.get("/{project_id}/members")
def list_project_members(project_id: uuid.UUID, search: Optional[str] = None, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    p = db.query(models.Project).filter(models.Project.id == project_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    q = (
        db.query(models.CompanyTeam)
        .join(models.ProjectMember, models.ProjectMember.company_team_id == models.CompanyTeam.id)
        .filter(
            models.ProjectMember.project_id == project_id,
            models.CompanyTeam.company_id == p.company_id,
        )
    )
    members = q.all()
    result = []
    for m in members:
        user = db.query(models.User).filter(models.User.id == m.user_id).first() if m.user_id else None
        role_name = None
        if m.role_id:
            role = db.query(models.CompanyRole).filter(models.CompanyRole.id == m.role_id).first()
            role_name = role.role_name if role else None
        name = user.name if user else None
        if not name and m.library_party_id:
            party = db.query(models.LibraryParty).filter(models.LibraryParty.id == m.library_party_id).first()
            name = party.name if party else None
        if search and search.lower() not in (name or "").lower() and search.lower() not in (role_name or "").lower():
            continue
        result.append({
            "company_team_id": str(m.id),
            "user_id": str(m.user_id) if m.user_id else None,
            "name": name,
            "mobile": user.mobile if user else None,
            "role": role_name,
            "priority_type": m.priority_type,
        })
    return result


@router.post("/{project_id}/members")
def add_project_member(project_id: uuid.UUID, member_id: uuid.UUID, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user), _: None = Depends(verify_project_access)):
    p = db.query(models.Project).filter(models.Project.id == project_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    require_permission(db, current_user, p.company_id, "team:manage")
    existing = db.query(models.ProjectMember).filter(
        models.ProjectMember.project_id == project_id,
        models.ProjectMember.company_team_id == member_id
    ).first()
    if not existing:
        db.add(models.ProjectMember(project_id=project_id, company_team_id=member_id))
        db.commit()
    return {"success": True}


@router.delete("/{project_id}/members/{member_id}")
def remove_project_member(project_id: uuid.UUID, member_id: uuid.UUID, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user), _: None = Depends(verify_project_access)):
    proj = db.query(models.Project).filter(models.Project.id == project_id).first()
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    require_permission(db, current_user, proj.company_id, "team:manage")
    row = db.query(models.ProjectMember).filter(
        models.ProjectMember.project_id == project_id,
        models.ProjectMember.company_team_id == member_id
    ).first()
    if row:
        from app.routers.delete_logs import log_deletion
        proj = db.query(models.Project).filter(models.Project.id == project_id).first()
        company_id = proj.company_id if proj else None
        log_deletion(db, company_id, "project_member", member_id, f"Project Member removed from: {proj.name if proj else project_id}", deleted_by=current_user.name)
        db.delete(row)
        db.commit()
    return {"success": True}


# ─── Parties (project-scoped linkage + balances) ───

class ProjectPartyCreate(BaseModel):
    party_id: uuid.UUID
    opening_balance_direction: Optional[str] = Field(None, pattern="^(will_pay|will_receive)$")  # will_pay / will_receive
    opening_balance_amount: Optional[float] = Field(0.0, ge=0)


@router.get("/{project_id}/parties")
def list_project_parties(project_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    links = db.query(models.ProjectParty).filter(models.ProjectParty.project_id == project_id).all()
    result = []
    for link in links:
        party = db.query(models.LibraryParty).filter(models.LibraryParty.id == link.party_id).first()
        if not party:
            continue
        led = _party_settlement(db, project_id, link.party_id, link.advance_paid, link.to_pay)
        result.append({
            "party_id": str(party.id),
            "name": party.name,
            "party_type": party.party_type,
            # Positive: in our favour (advance we paid, money owed to us).
            "balance": round(led["advance_paid"] + led["to_receive"] - led["to_pay"] - led["advance_received"], 2),
            **led,
            "status": link.status or "-",
        })
    return result


@router.post("/{project_id}/parties")
def add_project_party(project_id: uuid.UUID, payload: ProjectPartyCreate, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user), _: None = Depends(verify_project_access)):
    p = db.query(models.Project).filter(models.Project.id == project_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    require_permission(db, current_user, p.company_id, "projects:edit")

    # A party added to a project must be billable on it. Every bill, credit note
    # and payment names its counterparty by company_team id, and the project's
    # transaction screen offers only project members. A client registered in the
    # Party Library had neither, so no sales invoice could ever be raised to a
    # client. Resolve (or create) the party's login-less team row, which also
    # 404s a party from another company, and make it a project member.
    from app.routers.procurement import _company_team_id_for_party
    team_id = _company_team_id_for_party(db, p.company_id, payload.party_id)
    if not db.query(models.ProjectMember).filter(
        models.ProjectMember.project_id == project_id,
        models.ProjectMember.company_team_id == team_id,
    ).first():
        db.add(models.ProjectMember(project_id=project_id, company_team_id=team_id))
    db.commit()

    existing = db.query(models.ProjectParty).filter(
        models.ProjectParty.project_id == project_id,
        models.ProjectParty.party_id == payload.party_id
    ).first()
    if not existing:
        adv = pay = 0.0
        if payload.opening_balance_direction in ("will_pay", "will_receive") and (payload.opening_balance_amount or 0) > 0:
            amount = float(payload.opening_balance_amount)
            adv = amount if payload.opening_balance_direction == "will_receive" else 0.0
            pay = amount if payload.opening_balance_direction == "will_pay" else 0.0
        existing = models.ProjectParty(
            project_id=project_id,
            party_id=payload.party_id,
            balance=round(adv - pay, 2),
            advance_paid=adv,
            to_pay=pay,
            status="Active",
        )
        db.add(existing)
        db.commit()
        db.refresh(existing)
    elif payload.opening_balance_direction in ("will_pay", "will_receive") and (payload.opening_balance_amount or 0) > 0:
        amount = float(payload.opening_balance_amount)
        adv = amount if payload.opening_balance_direction == "will_receive" else 0.0
        pay = amount if payload.opening_balance_direction == "will_pay" else 0.0
        existing.advance_paid = adv
        existing.to_pay = pay
        existing.balance = round(adv - pay, 2)
        db.commit()
        db.refresh(existing)
    return {
        "party_id": str(existing.party_id),
        "company_team_id": str(team_id),
        "balance": float(existing.balance),
        "advance_paid": float(existing.advance_paid),
        "to_pay": float(existing.to_pay),
        "status": existing.status or "-",
    }


class ProjectPartyStatusUpdate(BaseModel):
    status: str = Field(..., pattern="^(Active|Inactive)$")


@router.put("/{project_id}/parties/{party_id}")
def set_project_party_status(
    project_id: uuid.UUID, party_id: uuid.UUID, payload: ProjectPartyStatusUpdate, db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
    _: None = Depends(verify_project_access)
):
    project = db.query(models.Project).filter(models.Project.id == project_id).first()
    require_permission(db, current_user, project.company_id, "projects:edit")
    link = db.query(models.ProjectParty).filter(
        models.ProjectParty.project_id == project_id,
        models.ProjectParty.party_id == party_id,
    ).first()
    if not link:
        raise HTTPException(status_code=404, detail="Party link not found")
    link.status = payload.status
    db.commit()
    return {"party_id": str(party_id), "status": link.status}


@router.get("/{project_id}/parties/balances")
def project_party_balances(project_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    links = db.query(models.ProjectParty).filter(models.ProjectParty.project_id == project_id).all()
    totals = {"advance_paid": 0.0, "to_pay": 0.0, "to_receive": 0.0, "advance_received": 0.0}
    for l in links:
        for k, v in _party_settlement(db, project_id, l.party_id, l.advance_paid, l.to_pay).items():
            totals[k] += v
    return {k: round(v, 2) for k, v in totals.items()}


@router.delete("/{project_id}/parties/{party_id}")
def remove_project_party(project_id: uuid.UUID, party_id: uuid.UUID, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user), _: None = Depends(verify_project_access)):
    link = db.query(models.ProjectParty).filter(
        models.ProjectParty.project_id == project_id,
        models.ProjectParty.party_id == party_id
    ).first()
    if link:
        from app.routers.delete_logs import log_deletion
        proj = db.query(models.Project).filter(models.Project.id == project_id).first()
        company_id = proj.company_id if proj else None
        party = db.query(models.LibraryParty).filter(models.LibraryParty.id == party_id).first()
        log_deletion(db, company_id, "project_party", link.id, f"Project Party removed: {party.name if party else party_id}", party_name=party.name if party else None, deleted_by=current_user.name)
        db.delete(link)
        db.commit()
    return {"success": True}


# ─── Location Structure (Settings → Location Structure) ───

@router.get("/{project_id}/locations")
def list_locations(project_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    locs = db.query(models.ProjectLocation).filter(models.ProjectLocation.project_id == project_id).all()
    return [{"id": str(l.id), "name": l.name, "parent_id": str(l.parent_id) if l.parent_id else None} for l in locs]


@router.post("/{project_id}/locations")
def create_location(project_id: uuid.UUID, payload: LocationCreate, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user), _: None = Depends(verify_project_access)):
    p = db.query(models.Project).filter(models.Project.id == project_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    require_permission(db, current_user, p.company_id, "projects:edit")
    loc = models.ProjectLocation(project_id=project_id, name=payload.name, parent_id=payload.parent_id)
    db.add(loc)
    db.commit()
    db.refresh(loc)
    return {"id": str(loc.id), "name": loc.name, "parent_id": str(loc.parent_id) if loc.parent_id else None}


@router.delete("/{project_id}/locations/{location_id}")
def delete_location(project_id: uuid.UUID, location_id: uuid.UUID, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user), _: None = Depends(verify_project_access)):
    loc = db.query(models.ProjectLocation).filter(
        models.ProjectLocation.id == location_id,
        models.ProjectLocation.project_id == project_id
    ).first()
    if not loc:
        raise HTTPException(status_code=404, detail="Location not found")
    from app.routers.delete_logs import log_deletion
    proj = db.query(models.Project).filter(models.Project.id == project_id).first()
    company_id = proj.company_id if proj else None
    log_deletion(db, company_id, "location", loc.id, f"Location: {loc.name}", deleted_by=current_user.name)
    db.delete(loc)
    db.commit()
    return {"success": True}
