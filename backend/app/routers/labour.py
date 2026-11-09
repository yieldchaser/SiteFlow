from uuid import UUID
from datetime import datetime, date
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session
from app.database import get_db
from app.auth import get_current_user, verify_project_in_company, verify_project_access, get_company_membership, require_permission
from app.models import (
    WorkOrder, SubcontractorPerformance,
    BOCWRecord, MusterRoll, Bill, User,
    AttendanceLog, SubcontractorAttendance, PayrollRun, PayrollLineItem, StaffEmployee
)
from app.party_names import resolve_party_name
from app.routers.delete_logs import log_deletion
from pydantic import BaseModel, Field
import csv
import io
from app.csv_export import csv_safe_cell as _csv_safe_cell, CSV_FORMULA_PREFIXES as _CSV_FORMULA_PREFIXES

router = APIRouter(
    prefix="/labour",
    tags=["Labour Management"],
    dependencies=[Depends(get_current_user)]
)


def _resolve_contractor_name(db: Session, contractor_id: Optional[UUID]) -> str:
    # R2-131: external contractors are CompanyTeam rows with no login; the
    # shared resolver also follows library_party_id to the real name.
    return resolve_party_name(db, contractor_id)




# --- Schemas ---
class ReliabilityResponse(BaseModel):
    id: UUID
    company_id: UUID
    project_id: UUID
    contractor_id: UUID
    contractor_name: str = "Unknown"
    period_start: datetime
    period_end: datetime
    on_time_pct: float
    billing_accuracy_pct: float
    quality_score: float
    tasks_completed: int
    tasks_delayed: int
    total_billed: float
    disputes_count: int

    class Config:
        from_attributes = True


class BOCWResponse(BaseModel):
    id: UUID
    company_id: UUID
    project_id: UUID
    contractor_id: Optional[UUID] = None
    contractor_name: str
    month_year: str
    workers_count: int
    wages_paid: float
    contribution_amount: float
    acknowledgement_number: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


class BOCWCreate(BaseModel):
    company_id: UUID
    project_id: UUID
    contractor_id: Optional[UUID] = None
    # R2-415: the stored name comes from contractor_id when it resolves, so the
    # return can no longer name a contractor who does not exist in the system.
    contractor_name: str = ""
    # R2-415: YYYY-MM like payroll_month (R2-355); "last month" is rejected
    # instead of being exported verbatim into a statutory return.
    month_year: str = Field(..., pattern=r"^\d{4}-\d{2}$")
    # R2-415: every material figure is optional; anything left None is derived
    # from the records this module already holds.
    workers_count: Optional[int] = Field(None, ge=0)          # None => attendance in month
    wages_paid: Optional[float] = Field(None, ge=0)           # None => payroll runs for month
    contribution_amount: Optional[float] = Field(None, ge=0)  # None => 1% of bill-ledger cost
    acknowledgement_number: Optional[str] = None


class MusterRollResponse(BaseModel):
    id: UUID
    company_id: UUID
    project_id: UUID
    contractor_id: Optional[UUID] = None
    date: str
    labor_role: str
    workers_present: int
    workers_absent: int
    hours_worked: float
    overtime_hours: float
    notes: Optional[str] = None

    class Config:
        from_attributes = True


class MusterRollCreate(BaseModel):
    company_id: UUID
    project_id: UUID
    contractor_id: Optional[UUID] = None
    date: datetime
    labor_role: str
    # R2-507: every figure is optional; anything left None is derived for the
    # site-day from the punch screen (AttendanceLog) and the crew drawer
    # (SubcontractorAttendance) so a diligent site never re-keys the register.
    workers_present: Optional[int] = Field(None, ge=0)
    workers_absent: Optional[int] = Field(None, ge=0)
    hours_worked: Optional[float] = Field(None, ge=0)
    overtime_hours: Optional[float] = Field(None, ge=0)
    notes: Optional[str] = None


# --- Contractor Reliability ---

@router.get("/reliability/{project_id}", response_model=List[ReliabilityResponse])
def get_reliability(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    scorecards = db.query(SubcontractorPerformance).filter(
        SubcontractorPerformance.project_id == project_id
    ).all()

    result = []
    for sc in scorecards:
        result.append(ReliabilityResponse(
            id=sc.id,
            company_id=sc.company_id,
            project_id=sc.project_id,
            contractor_id=sc.subcontractor_id,
            contractor_name=_resolve_contractor_name(db, sc.subcontractor_id),
            period_start=sc.period_start,
            period_end=sc.period_end,
            on_time_pct=float(sc.on_time_pct),
            billing_accuracy_pct=float(sc.billing_accuracy_pct),
            quality_score=float(sc.quality_score),
            tasks_completed=sc.tasks_completed,
            tasks_delayed=sc.tasks_delayed,
            total_billed=float(sc.total_billed),
            disputes_count=sc.disputes_count,
        ))
    return result


# --- BOCW Records ---

def _derive_month_workers(db: Session, project_id: UUID, month: str) -> int:
    """R2-415: distinct workers on the project in a YYYY-MM month - employees
    with a punch plus subcontractor crews counted once per role."""
    logs = db.query(AttendanceLog).filter(AttendanceLog.project_id == project_id).all()
    employees = {a.employee_id for a in logs if a.attendance_date.strftime("%Y-%m") == month}
    crews = {
        (s.subcontractor_id, (s.labor_role or "").strip().lower())
        for s in db.query(SubcontractorAttendance).filter(SubcontractorAttendance.project_id == project_id).all()
        if s.attendance_date.strftime("%Y-%m") == month
    }
    return len(employees) + len(crews)


@router.get("/bocw/{project_id}", response_model=List[BOCWResponse])
def get_bocw(project_id: UUID, month_year: Optional[str] = None, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    query = db.query(BOCWRecord).filter(BOCWRecord.project_id == project_id)
    if month_year:
        query = query.filter(BOCWRecord.month_year == month_year)
    records = query.all()
    return [
        BOCWResponse(
            id=r.id,
            company_id=r.company_id,
            project_id=r.project_id,
            contractor_id=r.contractor_id,
            contractor_name=r.contractor_name,
            month_year=r.month_year,
            workers_count=r.workers_count,
            wages_paid=float(r.wages_paid),
            contribution_amount=float(r.contribution_amount),
            acknowledgement_number=r.acknowledgement_number,
            created_at=r.created_at,
        ) for r in records
    ]


@router.get("/bocw/{project_id}/export")
def export_bocw(project_id: UUID, month_year: Optional[str] = None, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    query = db.query(BOCWRecord).filter(BOCWRecord.project_id == project_id)
    if month_year:
        query = query.filter(BOCWRecord.month_year == month_year)
    records = query.all()

    if not records:
        raise HTTPException(status_code=404, detail="No BOCW records found")

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Contractor Name", "Month-Year", "Workers Count", "Wages Paid",
        "Contribution Amount", "Acknowledgement Number", "Created At"
    ])
    for r in records:
        writer.writerow([
            _csv_safe_cell(r.contractor_name),
            _csv_safe_cell(r.month_year),
            r.workers_count,
            float(r.wages_paid),
            float(r.contribution_amount),
            _csv_safe_cell(r.acknowledgement_number or ""),
            r.created_at.strftime("%Y-%m-%d %H:%M:%S") if r.created_at else "",
        ])

    output.seek(0)
    return StreamingResponse(
        io.BytesIO(output.getvalue().encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=bocw_export_{project_id}.csv"}
    )


@router.post("/bocw", response_model=BOCWResponse, status_code=201)
def create_bocw(req: BOCWCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, req.company_id)
    verify_project_in_company(db, req.project_id, req.company_id)
    require_permission(db, current_user, req.company_id, "attendance:edit")
    # R2-415: derive the return from the records this module already holds
    # instead of filing whatever the caller typed.
    if req.contractor_id:
        contractor_name = _resolve_contractor_name(db, req.contractor_id)
    else:
        contractor_name = (req.contractor_name or "").strip() or "Unknown"
    workers_count = req.workers_count
    if workers_count is None:
        workers_count = _derive_month_workers(db, req.project_id, req.month_year)
    wages_paid = req.wages_paid
    if wages_paid is None:
        runs = db.query(PayrollRun).filter(
            PayrollRun.project_id == req.project_id,
            PayrollRun.payroll_month == req.month_year,
        ).all()
        wages_paid = float(sum(float(r.total_net or 0) for r in runs))
        # A company-wide run (no project) pays this site's staff too: their
        # lines count here (see app.payroll_scope).
        wages_paid += float(
            db.query(func.sum(PayrollLineItem.net_payable))
            .select_from(PayrollLineItem)
            .join(PayrollRun)
            .join(StaffEmployee, StaffEmployee.id == PayrollLineItem.employee_id)
            .filter(
                PayrollRun.project_id.is_(None),
                PayrollRun.payroll_month == req.month_year,
                PayrollRun.status == "finalized",
                StaffEmployee.project_id == req.project_id,
            )
            .scalar()
            or 0
        )
    contribution_amount = req.contribution_amount
    if contribution_amount is None:
        # BOCW Cess Act: 1% of the cost of construction - the bill ledger
        # holds that cost (money-out bills, cancelled ones excluded).
        bills = db.query(Bill).filter(
            Bill.project_id == req.project_id,
            Bill.invoice_type.in_(["purchase", "subcon"]),
            Bill.status != "Cancelled",
        ).all()
        cost_of_construction = float(sum(float(b.subtotal or 0) for b in bills))
        contribution_amount = round(cost_of_construction * 0.01, 2)
    if wages_paid > 0 and workers_count <= 0:
        raise HTTPException(status_code=422, detail="workers_count must be greater than zero when wages are recorded")
    record = BOCWRecord(
        company_id=req.company_id,
        project_id=req.project_id,
        contractor_id=req.contractor_id,
        contractor_name=contractor_name,
        month_year=req.month_year,
        workers_count=workers_count,
        wages_paid=wages_paid,
        contribution_amount=contribution_amount,
        acknowledgement_number=req.acknowledgement_number,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return BOCWResponse(
        id=record.id,
        company_id=record.company_id,
        project_id=record.project_id,
        contractor_id=record.contractor_id,
        contractor_name=record.contractor_name,
        month_year=record.month_year,
        workers_count=record.workers_count,
        wages_paid=float(record.wages_paid),
        contribution_amount=float(record.contribution_amount),
        acknowledgement_number=record.acknowledgement_number,
        created_at=record.created_at,
    )


# --- Muster Roll ---

def _derive_day_figures(db: Session, project_id: UUID, day):
    """R2-507: compute (present, absent, hours, overtime) for one project-day
    from the sources the product already holds - employee punches
    (AttendanceLog) and subcontractor crew counts (SubcontractorAttendance).
    Returns None when the day has no source rows at all."""
    logs = [
        a for a in db.query(AttendanceLog).filter(AttendanceLog.project_id == project_id).all()
        if a.attendance_date.date() == day
    ]
    crews = [
        s for s in db.query(SubcontractorAttendance).filter(SubcontractorAttendance.project_id == project_id).all()
        if s.attendance_date.date() == day
    ]
    if not logs and not crews:
        return None
    present = sum(1 for a in logs if (a.status or "") != "Absent")
    absent = sum(1 for a in logs if (a.status or "") == "Absent")
    hours = round(float(sum(float(a.hours_worked or 0) for a in logs)), 2)
    overtime = round(
        float(sum(float(a.overtime_hours or 0) for a in logs))
        + float(sum(float(s.overtime_hours or 0) for s in crews)),
        2,
    )
    # A crew row is that many workers on site, not one person.
    present += int(sum(int(s.worker_count or 0) for s in crews))
    return present, absent, hours, overtime


@router.get("/muster-roll/{project_id}", response_model=List[MusterRollResponse])
def get_muster_roll(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    records = db.query(MusterRoll).filter(MusterRoll.project_id == project_id).all()
    return [
        MusterRollResponse(
            id=r.id,
            company_id=r.company_id,
            project_id=r.project_id,
            contractor_id=r.contractor_id,
            date=r.date.strftime("%Y-%m-%d") if r.date else "",
            labor_role=r.labor_role,
            workers_present=r.workers_present,
            workers_absent=r.workers_absent,
            hours_worked=float(r.hours_worked),
            overtime_hours=float(r.overtime_hours),
            notes=r.notes,
        ) for r in records
    ]


@router.post("/muster-roll", response_model=MusterRollResponse, status_code=201)
def create_muster_roll(req: MusterRollCreate, response: Response, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, req.company_id)
    verify_project_in_company(db, req.project_id, req.company_id)
    require_permission(db, current_user, req.company_id, "attendance:edit")
    date_only = req.date.date()
    # R2-507: omitted figures are derived from attendance data instead of
    # forcing a hand-typed statutory register.
    workers_present = req.workers_present
    workers_absent = req.workers_absent
    hours_worked = req.hours_worked
    overtime_hours = req.overtime_hours
    if any(v is None for v in (workers_present, workers_absent, hours_worked, overtime_hours)):
        derived = _derive_day_figures(db, req.project_id, date_only)
        if derived is None:
            raise HTTPException(
                status_code=422,
                detail="no attendance data for this day to derive the muster roll from; supply the figures explicitly",
            )
        d_present, d_absent, d_hours, d_overtime = derived
        if workers_present is None:
            workers_present = d_present
        if workers_absent is None:
            workers_absent = d_absent
        if hours_worked is None:
            hours_worked = d_hours
        if overtime_hours is None:
            overtime_hours = d_overtime
    if hours_worked > workers_present * 24:
        raise HTTPException(status_code=422, detail="hours_worked cannot exceed workers_present × 24")
    if overtime_hours > hours_worked:
        raise HTTPException(status_code=422, detail="overtime_hours cannot exceed hours_worked")
    # R2-333: the muster roll is a statutory register; re-posting the same
    # gang for the same day (double-tap, retry after timeout, two supervisors)
    # must update one row in place instead of recording the workers twice.
    # Idempotency key follows the subcon precedent (R2-332): project +
    # contractor + calendar day + role compared trimmed and case-insensitively.
    role_key = req.labor_role.strip().lower()
    existing = db.query(MusterRoll).filter(MusterRoll.project_id == req.project_id).all()
    record = None
    for item in existing:
        if (
            item.date.date() == date_only
            and item.contractor_id == req.contractor_id
            and (item.labor_role or "").strip().lower() == role_key
        ):
            record = item
            break
    is_update = record is not None
    if not is_update:
        record = MusterRoll(
            company_id=req.company_id,
            project_id=req.project_id,
            contractor_id=req.contractor_id,
            date=req.date,
            labor_role=req.labor_role.strip(),
        )
        db.add(record)
    record.workers_present = workers_present
    record.workers_absent = workers_absent
    record.hours_worked = hours_worked
    record.overtime_hours = overtime_hours
    record.notes = req.notes
    db.commit()
    db.refresh(record)
    if is_update:
        # An idempotent replay returns 200; only a fresh insert is 201.
        response.status_code = status.HTTP_200_OK
    return MusterRollResponse(
        id=record.id,
        company_id=record.company_id,
        project_id=record.project_id,
        contractor_id=record.contractor_id,
        date=record.date.strftime("%Y-%m-%d") if record.date else "",
        labor_role=record.labor_role,
        workers_present=record.workers_present,
        workers_absent=record.workers_absent,
        hours_worked=float(record.hours_worked),
        overtime_hours=float(record.overtime_hours),
        notes=record.notes,
    )


@router.delete("/bocw/{record_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_bocw(record_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """R2-760: Delete / void a BOCW record with audit log."""
    rec = db.query(BOCWRecord).filter(BOCWRecord.id == record_id).first()
    if not rec:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="BOCW record not found")
    get_company_membership(db, current_user, rec.company_id)
    require_permission(db, current_user, rec.company_id, "attendance:edit")
    log_deletion(
        db,
        company_id=rec.company_id,
        entity_type="bocw_record",
        entity_id=rec.id,
        summary=f"BOCW record for {rec.month_year} contractor {rec.contractor_name}",
        deleted_by=current_user.name or current_user.email or "Unknown",
    )
    db.delete(rec)
    db.commit()


@router.delete("/muster-roll/{record_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_muster_roll(record_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """R2-760: Delete / void a Muster Roll entry with audit log."""
    rec = db.query(MusterRoll).filter(MusterRoll.id == record_id).first()
    if not rec:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Muster roll record not found")
    get_company_membership(db, current_user, rec.company_id)
    require_permission(db, current_user, rec.company_id, "attendance:edit")
    log_deletion(
        db,
        company_id=rec.company_id,
        entity_type="muster_roll",
        entity_id=rec.id,
        summary=f"Muster roll on {rec.date} role {rec.labor_role}",
        deleted_by=current_user.name or current_user.email or "Unknown",
    )
    db.delete(rec)
    db.commit()

