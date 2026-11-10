from uuid import UUID
from datetime import datetime
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import func
from app.database import get_db
from app.auth import get_current_user, verify_project_access, get_company_membership, require_permission, project_ids_for_user
from app.models import (
    WorkOrder, WorkOrderAmendment, SubcontractorPerformance,
    WorkOrderItem, Bill, TransactionDeduction, User,
    Project, Task,
)
from app.bill_scope import _active_bills
from app.party_names import resolve_party_name
from app.routers.delete_logs import log_deletion
from pydantic import BaseModel, Field

router = APIRouter(
    prefix="/subcon",
    tags=["Subcontractor Performance & Amendments"],
    dependencies=[Depends(get_current_user)]
)


# --- Schemas ---
class AmendmentCreateRequest(BaseModel):
    # Ignored: the amendment is always signed by the person saving it.
    amended_by: Optional[str] = None
    amended_fields: dict = Field(..., example={"estimated_work_amount": 1250000.0})
    reason: Optional[str] = None


class AmendmentResponse(BaseModel):
    id: UUID
    wo_id: UUID
    amendment_number: int
    amended_fields: dict
    previous_values: Optional[dict] = None
    amended_by: Optional[str] = None
    amended_at: datetime
    reason: Optional[str] = None

    class Config:
        from_attributes = True


class ScorecardResponse(BaseModel):
    id: UUID
    company_id: UUID
    project_id: UUID
    subcontractor_id: UUID
    subcontractor_name: str = "Unknown"
    period_start: datetime
    period_end: datetime
    on_time_pct: float
    billing_accuracy_pct: float
    quality_score: float
    tasks_completed: int
    tasks_delayed: int
    total_billed: float
    disputes_count: int
    notes: Optional[str] = None

    class Config:
        from_attributes = True


class ComparativeItem(BaseModel):
    subcontractor_id: UUID
    subcontractor_name: str = "Unknown"
    scorecard_count: int
    avg_on_time_pct: float
    avg_billing_accuracy_pct: float
    avg_quality_score: float
    total_tasks_completed: int
    total_tasks_delayed: int
    total_billed: float
    total_disputes: int


# --- Work Order Amendments ---

AMENDABLE_WO_FIELDS = {"estimated_work_amount", "terms"}


def _amendable_wo(db: Session, wo_id: UUID, current_user: User) -> WorkOrder:
    wo = db.query(WorkOrder).filter(WorkOrder.id == wo_id).first()
    if not wo:
        raise HTTPException(status_code=404, detail="Work order not found")
    get_company_membership(db, current_user, wo.company_id)
    allowed = project_ids_for_user(db, current_user, wo.company_id)
    if allowed is not None and wo.project_id not in allowed:
        raise HTTPException(status_code=403, detail="You do not have access to this project")
    return wo


@router.get("/work-orders/{wo_id}/amendments", response_model=List[AmendmentResponse])
def get_amendments(wo_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _amendable_wo(db, wo_id, current_user)
    amendments = db.query(WorkOrderAmendment).filter(
        WorkOrderAmendment.wo_id == wo_id
    ).order_by(WorkOrderAmendment.amendment_number.desc()).all()
    return amendments


@router.post("/work-orders/{wo_id}/amendments", response_model=AmendmentResponse, status_code=201)
def create_amendment(wo_id: UUID, req: AmendmentCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """A change to a work order after it was issued, kept as a numbered record
    of what it was, what it became, who changed it and why. Once a bill is
    raised against a work order this is the only way to change its value."""
    wo = _amendable_wo(db, wo_id, current_user)
    require_permission(db, current_user, wo.company_id, "subcontractor:edit")
    if wo.status == "cancelled":
        raise HTTPException(status_code=409, detail="This work order is cancelled and cannot be changed")

    reason = (req.reason or "").strip()
    if not reason:
        raise HTTPException(status_code=422, detail="Say why the work order is changing")

    unknown = set(req.amended_fields) - AMENDABLE_WO_FIELDS
    if unknown:
        raise HTTPException(status_code=422, detail="Only the work order value and terms can be changed here")
    if not req.amended_fields:
        raise HTTPException(status_code=422, detail="Change the value or the terms")

    previous = {}
    if "estimated_work_amount" in req.amended_fields:
        amount = req.amended_fields["estimated_work_amount"]
        if not isinstance(amount, (int, float)) or isinstance(amount, bool) or amount < 0:
            raise HTTPException(status_code=422, detail="Enter the new work order value as a number, zero or more")
        amount = round(float(amount), 2)
        billed = float(
            db.query(func.coalesce(func.sum(Bill.subtotal), 0))
            .filter(Bill.wo_id == wo.id, Bill.invoice_type == "subcon", Bill.status != "Cancelled")
            .scalar() or 0.0
        )
        if amount + 0.005 < billed:
            raise HTTPException(
                status_code=422,
                detail=f"₹{billed:,.2f} is already billed against this work order. The new value cannot be lower than that.",
            )
        previous["estimated_work_amount"] = float(wo.estimated_work_amount or 0.0)
        req.amended_fields["estimated_work_amount"] = amount
    if "terms" in req.amended_fields:
        if not isinstance(req.amended_fields["terms"], str):
            raise HTTPException(status_code=422, detail="Terms must be text")
        previous["terms"] = wo.terms or ""

    changed = {k: v for k, v in req.amended_fields.items() if previous.get(k) != v}
    if not changed:
        raise HTTPException(status_code=422, detail="Nothing changed: the new value and terms are the same as now")

    last = db.query(WorkOrderAmendment).filter(
        WorkOrderAmendment.wo_id == wo_id
    ).order_by(WorkOrderAmendment.amendment_number.desc()).first()

    next_number = (last.amendment_number + 1) if last else 1

    amendment = WorkOrderAmendment(
        wo_id=wo_id,
        amendment_number=next_number,
        amended_fields=changed,
        previous_values={k: previous[k] for k in changed},
        amended_by=current_user.name or current_user.email or str(current_user.id),
        reason=reason,
    )
    for field, value in changed.items():
        setattr(wo, field, value)
    db.add(amendment)
    db.commit()
    db.refresh(amendment)
    return amendment


# --- Performance Scorecards ---


def _resolve_subcontractor_name(db: Session, subcontractor_id: UUID) -> str:
    # R2-131: scorecards must show the LibraryParty name for login-less
    # subcontractors instead of "Unknown".
    return resolve_party_name(db, subcontractor_id)


@router.get("/scorecards/{project_id}", response_model=List[ScorecardResponse])
def get_scorecards(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    scorecards = db.query(SubcontractorPerformance).filter(
        SubcontractorPerformance.project_id == project_id
    ).all()
    return [
        ScorecardResponse(
            id=sc.id,
            company_id=sc.company_id,
            project_id=sc.project_id,
            subcontractor_id=sc.subcontractor_id,
            subcontractor_name=_resolve_subcontractor_name(db, sc.subcontractor_id),
            period_start=sc.period_start,
            period_end=sc.period_end,
            on_time_pct=float(sc.on_time_pct),
            billing_accuracy_pct=float(sc.billing_accuracy_pct),
            quality_score=float(sc.quality_score),
            tasks_completed=sc.tasks_completed,
            tasks_delayed=sc.tasks_delayed,
            total_billed=float(sc.total_billed),
            disputes_count=sc.disputes_count,
            notes=sc.notes,
        )
        for sc in scorecards
    ]


@router.get("/scorecards/{project_id}/comparative", response_model=List[ComparativeItem])
def get_comparative(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    scorecards = db.query(SubcontractorPerformance).filter(
        SubcontractorPerformance.project_id == project_id
    ).all()

    grouped = {}
    for sc in scorecards:
        sub_id = str(sc.subcontractor_id)
        if sub_id not in grouped:
            grouped[sub_id] = {
                "subcontractor_id": sc.subcontractor_id,
                "subcontractor_name": _resolve_subcontractor_name(db, sc.subcontractor_id),
                "scorecard_count": 0,
                "sum_on_time": 0.0,
                "sum_billing_accuracy": 0.0,
                "sum_quality": 0.0,
                "total_tasks_completed": 0,
                "total_tasks_delayed": 0,
                "total_billed": 0.0,
                "total_disputes": 0,
            }
        g = grouped[sub_id]
        g["scorecard_count"] += 1
        g["sum_on_time"] += float(sc.on_time_pct)
        g["sum_billing_accuracy"] += float(sc.billing_accuracy_pct)
        g["sum_quality"] += float(sc.quality_score)
        g["total_tasks_completed"] += sc.tasks_completed
        g["total_tasks_delayed"] += sc.tasks_delayed
        g["total_billed"] += float(sc.total_billed)
        g["total_disputes"] += sc.disputes_count

    result = []
    for g in grouped.values():
        count = g["scorecard_count"]
        result.append(ComparativeItem(
            subcontractor_id=g["subcontractor_id"],
            subcontractor_name=g["subcontractor_name"],
            scorecard_count=count,
            avg_on_time_pct=round(g["sum_on_time"] / count, 2) if count else 0.0,
            avg_billing_accuracy_pct=round(g["sum_billing_accuracy"] / count, 2) if count else 0.0,
            avg_quality_score=round(g["sum_quality"] / count, 2) if count else 0.0,
            total_tasks_completed=g["total_tasks_completed"],
            total_tasks_delayed=g["total_tasks_delayed"],
            total_billed=round(g["total_billed"], 2),
            total_disputes=g["total_disputes"],
        ))
    return result


# --- Auto-calculation of scorecards (real data, zero fabrication) ---
#
# Derivation logic (all from existing DB rows for project_id + subcontractor_id + period):
#   tasks_completed : Task rows linked to this subcontractor's WorkOrders (via WorkOrderItem)
#                     whose end_date falls in the period AND status == "completed".
#   tasks_delayed   : same-linked tasks in the period that are not completed and are past
#                     their end_date (or explicitly status == "delayed").
#   total_billed    : sum(Bill.subtotal) (work value) for invoice_type == "subcon" billed to this
#                     subcontractor (party_company_user_id) within the period.
#   disputes_count  : count(WorkOrderAmendment) raised on this subcontractor's WorkOrders
#                     within the period (amendments are the only dispute-like signal present).
#   on_time_pct     : settlement rate of the subcontractor's bills in the period
#                     (settled = status in Paid/Partially Paid, or not yet past due_date).
#                     0.0 when there are no subcon bills - absence of evidence is not a perfect score.
#   billing_accuracy_pct : measured-vs-quoted where both signals exist (sum of
#                     WorkOrder.estimated_work_amount vs Bill.subtotal), penalised by absolute
#                     deviation from the quote; 0.0 when either signal is missing - never a constant.
#   quality_score   : derived from real disputes proxy: max(0, 100 - 5 * disputes_count).
#                     An empty period (no completed tasks AND nothing billed) scores 0 across every
#                     metric instead of reading as flawless.

def _compute_subcon_metrics(db: Session, project_id: UUID, subcontractor_id: UUID,
                            period_start: datetime, period_end: datetime):
    wos = db.query(WorkOrder).filter(
        WorkOrder.project_id == project_id,
        WorkOrder.subcontractor_id == subcontractor_id,
    ).all()
    wo_ids = [w.id for w in wos]

    tasks_completed = 0
    tasks_delayed = 0
    if wo_ids:
        wo_items = db.query(WorkOrderItem).filter(WorkOrderItem.wo_id.in_(wo_ids)).all()
        task_ids = [wi.task_id for wi in wo_items if wi.task_id]
        if task_ids:
            tasks = db.query(Task).filter(
                Task.id.in_(task_ids),
                Task.end_date >= period_start,
                Task.end_date <= period_end,
            ).all()
            for t in tasks:
                if t.status == "completed":
                    tasks_completed += 1
                elif t.status == "delayed" or (t.progress is not None and float(t.progress) < 100 and t.end_date < period_end):
                    tasks_delayed += 1

    bills = _active_bills(db, project_id, ["subcon"]).filter(
        Bill.party_company_user_id == subcontractor_id,
        Bill.invoice_date >= period_start,
        Bill.invoice_date <= period_end,
    ).all()
    total_billed = float(sum(float(b.subtotal) for b in bills))

    settled = 0
    for b in bills:
        if b.status in ("Paid", "Partially Paid"):
            settled += 1
    on_time_pct = round((settled / len(bills)) * 100, 2) if bills else 0.0

    disputes_count = 0
    if wo_ids:
        disputes_count = db.query(WorkOrderAmendment).filter(
            WorkOrderAmendment.wo_id.in_(wo_ids),
            WorkOrderAmendment.amended_at >= period_start,
            WorkOrderAmendment.amended_at <= period_end,
        ).count()

    quoted_total = sum(float(w.estimated_work_amount or 0.0) for w in wos)
    if quoted_total > 0 and bills:
        deviation = abs(total_billed - quoted_total) / quoted_total
        billing_accuracy_pct = round(max(0.0, 100.0 * (1.0 - deviation)), 2)
    else:
        billing_accuracy_pct = 0.0
    quality_score = max(0.0, 100.0 - 5.0 * disputes_count)

    if tasks_completed == 0 and total_billed == 0:
        on_time_pct = 0.0
        billing_accuracy_pct = 0.0
        quality_score = 0.0

    return {
        "tasks_completed": tasks_completed,
        "tasks_delayed": tasks_delayed,
        "total_billed": round(total_billed, 2),
        "on_time_pct": on_time_pct,
        "billing_accuracy_pct": billing_accuracy_pct,
        "quality_score": round(quality_score, 2),
        "disputes_count": disputes_count,
    }


def recompute_subcontractor_performance(db: Session, project_id: UUID, company_id: UUID,
                                        subcontractor_id: UUID, period_start: datetime,
                                        period_end: datetime) -> SubcontractorPerformance:
    metrics = _compute_subcon_metrics(db, project_id, subcontractor_id, period_start, period_end)
    existing = db.query(SubcontractorPerformance).filter(
        SubcontractorPerformance.project_id == project_id,
        SubcontractorPerformance.subcontractor_id == subcontractor_id,
        SubcontractorPerformance.period_start == period_start,
        SubcontractorPerformance.period_end == period_end,
    ).first()
    if existing:
        row = existing
    else:
        row = SubcontractorPerformance(
            company_id=company_id,
            project_id=project_id,
            subcontractor_id=subcontractor_id,
            period_start=period_start,
            period_end=period_end,
        )
        db.add(row)
    row.on_time_pct = metrics["on_time_pct"]
    row.billing_accuracy_pct = metrics["billing_accuracy_pct"]
    row.quality_score = metrics["quality_score"]
    row.tasks_completed = metrics["tasks_completed"]
    row.tasks_delayed = metrics["tasks_delayed"]
    row.total_billed = metrics["total_billed"]
    row.disputes_count = metrics["disputes_count"]
    db.flush()
    return row


class RecomputeResponse(BaseModel):
    project_id: UUID
    subcontractor_id: Optional[UUID] = None
    period_start: datetime
    period_end: datetime
    scorecards: List[ScorecardResponse]


@router.post("/scorecards/recompute", response_model=RecomputeResponse)
def recompute_scorecards(
    project_id: UUID,
    period_start: datetime,
    period_end: datetime,
    subcontractor_id: Optional[UUID] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    verify_project_access(project_id, current_user, db)
    require_permission(db, current_user, project.company_id, "subcontractor:edit")

    if subcontractor_id:
        subs = [subcontractor_id]
    else:
        subs = [r.subcontractor_id for r in db.query(WorkOrder.subcontractor_id)
                .filter(WorkOrder.project_id == project_id).distinct().all()]

    rows = []
    for sid in subs:
        row = recompute_subcontractor_performance(db, project_id, project.company_id, sid, period_start, period_end)
        rows.append(ScorecardResponse(
            id=row.id,
            company_id=row.company_id,
            project_id=row.project_id,
            subcontractor_id=row.subcontractor_id,
            subcontractor_name=_resolve_subcontractor_name(db, row.subcontractor_id),
            period_start=row.period_start,
            period_end=row.period_end,
            on_time_pct=float(row.on_time_pct),
            billing_accuracy_pct=float(row.billing_accuracy_pct),
            quality_score=float(row.quality_score),
            tasks_completed=row.tasks_completed,
            tasks_delayed=row.tasks_delayed,
            total_billed=float(row.total_billed),
            disputes_count=row.disputes_count,
            notes=row.notes,
        ))
    db.commit()
    return RecomputeResponse(
        project_id=project_id,
        subcontractor_id=subcontractor_id,
        period_start=period_start,
        period_end=period_end,
        scorecards=rows,
    )


@router.delete("/performance/{record_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_subcon_performance(record_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """R2-760: Delete / void a subcontractor performance scorecard with audit log."""
    perf = db.query(SubcontractorPerformance).filter(SubcontractorPerformance.id == record_id).first()
    if not perf:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Performance scorecard not found")
    get_company_membership(db, current_user, perf.company_id)
    require_permission(db, current_user, perf.company_id, "subcontractor:edit")
    log_deletion(
        db,
        company_id=perf.company_id,
        entity_type="subcon_performance",
        entity_id=perf.id,
        summary=f"Performance scorecard for subcontractor {perf.subcontractor_id}",
        deleted_by=current_user.name or current_user.email or "Unknown",
    )
    db.delete(perf)
    db.commit()

