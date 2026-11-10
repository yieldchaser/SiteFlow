from uuid import UUID
from datetime import date, datetime, timedelta, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import func
from app.database import get_db
from app.auth import get_current_user, verify_project_access, get_company_membership, require_permission, project_ids_for_user
from app.models import (
    WorkOrder, WorkOrderAmendment, SubcontractorPerformance,
    WorkOrderItem, Bill, TransactionDeduction, User,
    Project, Task, NCR,
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


# --- Subcontractor performance, worked out live ---
#
# Facts, not invented 0-100 scores. The old scorecard called "on-time %" the
# share of the subcontractor's bills WE had paid, compared one month's bills
# against the whole work order value as "billing accuracy" (a normal monthly
# bill scored about 10%), took 5 quality points off per work order amendment
# (usually a scope change) while ignoring the NCRs raised against them, and
# counted tasks not yet due as delayed. It was also saved every time the page
# was opened.
#
# For a period (dates in India time), per subcontractor with a work order on
# the project:
#   tasks_finished   tasks on their work orders, completed, finishing in the period
#   finished_on_time of those with an original plan, finished on or before it
#   running_late     not completed, end date in the period and already passed
#   ncrs_raised      NCRs on this project naming them, raised in the period
#   ncrs_open        of those, not closed yet
#   billed           their subcontractor bills dated in the period (work value)
#   billed_to_date   all their bills on this project, against wo_value
#   amendments       work order amendments in the period

IST = timedelta(minutes=330)


def _local_day(dt) -> Optional[date]:
    if dt is None:
        return None
    if isinstance(dt, datetime):
        if dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
        return (dt + IST).date()
    return dt


class SubconPerformanceRow(BaseModel):
    subcontractor_id: UUID
    subcontractor_name: str
    work_orders: int
    wo_value: float
    tasks_finished: int
    tasks_judged: int
    finished_on_time: int
    running_late: int
    ncrs_raised: int
    ncrs_open: int
    billed: float
    billed_to_date: float
    amendments: int


@router.get("/performance/{project_id}", response_model=List[SubconPerformanceRow])
def subcon_performance(
    project_id: UUID,
    start: Optional[date] = None,
    end: Optional[date] = None,
    db: Session = Depends(get_db),
    _: None = Depends(verify_project_access),
):
    today = _local_day(datetime.now(timezone.utc))
    # Nothing after today can have happened yet.
    end = min(end, today) if end else today
    if start and start > end:
        raise HTTPException(status_code=422, detail="The start date is after the end date")

    def in_period(d: Optional[date]) -> bool:
        return d is not None and (start is None or d >= start) and d <= end

    wos = db.query(WorkOrder).filter(WorkOrder.project_id == project_id).all()
    by_sub: dict = {}
    for w in wos:
        by_sub.setdefault(w.subcontractor_id, []).append(w)

    ncrs = db.query(NCR).filter(NCR.project_id == project_id).all()
    bills = _active_bills(db, project_id, ["subcon"]).all()

    out = []
    for sub_id, sub_wos in by_sub.items():
        wo_ids = [w.id for w in sub_wos]
        live_wos = [w for w in sub_wos if w.status != "cancelled"]
        task_ids = {
            wi.task_id for wi in db.query(WorkOrderItem).filter(WorkOrderItem.wo_id.in_(wo_ids)).all() if wi.task_id
        }
        tasks = db.query(Task).filter(Task.id.in_(task_ids)).all() if task_ids else []
        finished = judged = on_time = late = 0
        for t in tasks:
            t_end = _local_day(t.end_date)
            if not in_period(t_end):
                continue
            if t.status == "completed":
                finished += 1
                base = _local_day(getattr(t, "baseline_end", None))
                if base is not None:
                    judged += 1
                    if t_end <= base:
                        on_time += 1
            elif t_end < today:
                late += 1

        sub_ncrs = [n for n in ncrs if n.vendor_id == sub_id and in_period(_local_day(n.created_at))]
        sub_bills = [b for b in bills if b.party_company_user_id == sub_id]
        amend = db.query(WorkOrderAmendment).filter(WorkOrderAmendment.wo_id.in_(wo_ids)).all()

        out.append(SubconPerformanceRow(
            subcontractor_id=sub_id,
            subcontractor_name=_resolve_subcontractor_name(db, sub_id),
            work_orders=len(live_wos),
            wo_value=round(sum(float(w.estimated_work_amount or 0) for w in live_wos), 2),
            tasks_finished=finished,
            tasks_judged=judged,
            finished_on_time=on_time,
            running_late=late,
            ncrs_raised=len(sub_ncrs),
            ncrs_open=sum(1 for n in sub_ncrs if (n.status or "").lower() != "closed"),
            billed=round(sum(float(b.subtotal or 0) for b in sub_bills if in_period(_local_day(b.invoice_date))), 2),
            billed_to_date=round(sum(float(b.subtotal or 0) for b in sub_bills), 2),
            amendments=sum(1 for a in amend if in_period(_local_day(a.amended_at))),
        ))
    out.sort(key=lambda r: r.subcontractor_name.lower())
    return out


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

