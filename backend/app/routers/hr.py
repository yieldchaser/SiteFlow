"""
Phase 9 — Staff HR, Geofenced Attendance & Payroll
Endpoints:
  POST   /hr/employees              — Create employee
  GET    /hr/employees/{project_id} — List employees for project
  POST   /hr/attendance/punch       — GPS punch-in or punch-out (geofence validated)
  GET    /hr/attendance/{project_id}/{date} — Daily attendance list
  POST   /hr/timesheets             — Create weekly timesheet
  POST   /hr/timesheets/{ts_id}/entries — Add entry to timesheet
  PATCH  /hr/timesheets/{ts_id}/submit  — Submit timesheet for approval
  PATCH  /hr/timesheets/{ts_id}/approve — Approve timesheet
  POST   /hr/payroll/run            — Execute monthly payroll run
  GET    /hr/payroll/{run_id}/payslips — List payslips for a run
"""

import calendar
import csv
import io
import logging
import math
import uuid
from datetime import datetime, date, timedelta, timezone
from decimal import Decimal
from typing import List, Literal, Optional
from fastapi import APIRouter, Depends, HTTPException, status, File, Form, UploadFile, Response
from sqlalchemy import func

logger = logging.getLogger(__name__)
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field, field_validator
from app.database import get_db
from app.auth import get_current_user, verify_project_in_company, verify_company_access, verify_project_access, get_company_membership, require_permission, require_module_view, assert_cost_codes_known
# R2-185/R2-407: the shared CSV formula guard (one helper, every export).
from app.csv_export import csv_safe_cell as _csv_safe_cell, CSV_FORMULA_PREFIXES as _CSV_FORMULA_PREFIXES
from app.models import (
    StaffEmployee, AttendanceLog, Timesheet,
    TimesheetEntry, PayrollRun, PayrollLineItem, Project, LeaveRequest,
    Holiday, Designation, LeaveTemplate, PayrollProfile, User, Company,
    CompanyPayrollSettings
)
from app.workflow_controls import enforce_entry_creation_window

router = APIRouter(prefix="/hr", tags=["HR, Attendance & Payroll"], dependencies=[Depends(get_current_user)])


# ─── Helpers ─────────────────────────────────────────────────────────────────

# Statutory ESI wage ceiling applies to GROSS wages (basic + HRA + allowances),
# not basic pay alone.
ESI_GROSS_WAGE_CEILING = 21000.0


def _esi_applicable(basic_salary: float, hra: float, other_allowances: float) -> bool:
    """True when full gross wages are within the ESI ceiling."""
    return (float(basic_salary) + float(hra) + float(other_allowances)) <= ESI_GROSS_WAGE_CEILING


# R2-210/R2-262/R2-220/R2-728: DateTime(timezone=True) columns round-trip aware on
# Postgres but naive on SQLite; normalize every operand to aware UTC before
# arithmetic or comparison so the two flavors never mix.
def _aware_utc(dt: datetime) -> datetime:
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


_IST = timezone(timedelta(hours=5, minutes=30))


def _ist_day_bounds(day: date):
    """Aware-UTC [start, end) of an Indian calendar day. Punches store the real
    instant, so a 02:00 IST punch is 20:30Z the day before; reading days in UTC
    put every punch before 05:30 IST on the wrong date. Manual marks are pinned
    at 00:00Z of their day, which also falls inside this window."""
    start = datetime(day.year, day.month, day.day, tzinfo=_IST).astimezone(timezone.utc)
    return start, start + timedelta(days=1)


def _utc_midnight(dt: datetime) -> datetime:
    # R2-753: If the datetime carries a timezone offset (or was converted to UTC from local browser time),
    # convert it to IST so that an evening UTC instant (e.g. 14 Aug 18:30Z) correctly maps to the intended
    # calendar day (15 Aug) before pinning at UTC midnight.
    if dt.tzinfo is not None:
        local = dt.astimezone(_IST)
        return datetime(local.year, local.month, local.day, tzinfo=timezone.utc)
    return datetime(dt.year, dt.month, dt.day, tzinfo=timezone.utc)


def haversine_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Return distance in metres between two GPS coordinates (Haversine formula)."""
    R = 6_371_000  # Earth radius in metres
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _parse_site_coords(location_str: Optional[str]):
    """Parse 'lat,lng' string stored in Project.location. Returns (lat, lng) or (None, None)."""
    if not location_str:
        return None, None
    try:
        parts = location_str.split(",")
        return float(parts[0].strip()), float(parts[1].strip())
    except Exception:
        return None, None


# ─── Schemas ─────────────────────────────────────────────────────────────────

class EmployeeCreate(BaseModel):
    company_id: uuid.UUID
    project_id: Optional[uuid.UUID] = None
    # An employee saved with an empty name renders as a blank row that nobody can
    # identify, and it used to be accepted with a 201. min_length alone would let
    # a run of spaces through, hence the strip validator below.
    name: str = Field(..., min_length=1, max_length=255)
    employee_code: Optional[str] = None
    uan: Optional[str] = None
    designation: Optional[str] = None
    department: Optional[str] = None
    mobile: Optional[str] = None
    # Upper bounds so a mistyped or mis-mapped field cannot store a salary of
    # 9,81,12,23,344 and blow up every payroll total that reads it.
    basic_salary: float = Field(0.0, ge=0, le=1e9)
    hra: float = Field(0.0, ge=0, le=1e9)
    other_allowances: float = Field(0.0, ge=0, le=1e9)
    pf_employee_pct: float = Field(12.0, ge=0, le=100)
    pf_employer_pct: float = Field(12.0, ge=0, le=100)
    esi_employee_pct: float = Field(0.75, ge=0, le=100)
    esi_employer_pct: float = Field(3.25, ge=0, le=100)
    tds_monthly: float = Field(0.0, ge=0)
    is_esi_applicable: bool = True
    date_of_joining: Optional[datetime] = None

    @field_validator("project_id", mode="before")
    @classmethod
    def validate_project_id(cls, v):
        if v == "" or v is None:
            return None
        return v

    @field_validator("name")
    @classmethod
    def _name_is_not_blank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("name is required")
        return v.strip()

    @field_validator("uan", mode="before")
    @classmethod
    def validate_uan(cls, v):
        if v is None:
            return None
        v = str(v).strip()
        if not v:
            return None
        if len(v) != 12 or not v.isdigit():
            raise ValueError("UAN must be a 12-digit numeric string")
        return v


class EmployeeResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    project_id: Optional[uuid.UUID]
    name: str
    employee_code: Optional[str]
    uan: Optional[str] = None
    designation: Optional[str]
    department: Optional[str]
    mobile: Optional[str]
    # Pay fields are None for callers without payroll access (see _staff_list).
    basic_salary: Optional[float]
    hra: Optional[float]
    other_allowances: Optional[float]
    pf_employee_pct: Optional[float]
    pf_employer_pct: Optional[float]
    esi_employee_pct: Optional[float]
    esi_employer_pct: Optional[float]
    tds_monthly: Optional[float]
    is_esi_applicable: Optional[bool]
    status: str
    date_of_joining: Optional[datetime]
    created_at: datetime

    class Config:
        from_attributes = True


_PAY_FIELDS = (
    "uan", "basic_salary", "hra", "other_allowances", "pf_employee_pct", "pf_employer_pct",
    "esi_employee_pct", "esi_employer_pct", "tds_monthly", "is_esi_applicable",
)


def _has_module_view(db: Session, user: User, company_id: uuid.UUID, module: str) -> bool:
    try:
        require_module_view(db, user, company_id, module)
        return True
    except HTTPException:
        return False


def _staff_list(db: Session, user: User, company_id: uuid.UUID, employees: list) -> list:
    """The staff roster for attendance and payroll screens.

    Whoever marks attendance (attendance access) needs the names; only payroll
    access sees pay, UAN and statutory rates. Anyone else gets a 403.
    """
    sees_pay = _has_module_view(db, user, company_id, "payroll")
    if not sees_pay and not _has_module_view(db, user, company_id, "attendance"):
        raise HTTPException(status_code=403, detail="You do not have access to view staff.")
    rows = [EmployeeResponse.model_validate(e).model_dump() for e in employees]
    if not sees_pay:
        for row in rows:
            for field in _PAY_FIELDS:
                row[field] = None
    return rows


class PunchRequest(BaseModel):
    employee_id: uuid.UUID
    project_id: uuid.UUID
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)
    punch_type: str = Field(..., pattern="^(in|out)$")
    shift_multiplier: Optional[float] = 1.0
    location_verified: Optional[bool] = True
    notes: Optional[str] = None
    captured_at: Optional[datetime] = None


class AttendanceResponse(BaseModel):
    id: uuid.UUID
    employee_id: uuid.UUID
    project_id: uuid.UUID
    attendance_date: datetime
    punch_in: Optional[datetime]
    punch_out: Optional[datetime]
    lat_in: Optional[float]
    lng_in: Optional[float]
    distance_from_site_m: Optional[float]
    is_within_geofence: bool
    status: str
    hours_worked: Optional[float]
    overtime_hours: float
    shift_multiplier: float
    location_verified: bool
    marked_manually: bool = False
    marked_by: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


class ManualAttendanceRequest(BaseModel):
    """Mark the muster by hand, for a crew with no smartphone or GPS.

    The attendance sheet offered Present / Absent / Paid Leave / Week Off as
    filters and had no way to set any of them: the only write path was a GPS
    punch. A site without smartphones could not record attendance at all, and
    payroll had nothing to consume.
    """
    employee_id: uuid.UUID
    project_id: uuid.UUID
    attendance_date: str  # YYYY-MM-DD
    status: str = Field(..., pattern="^(Present|Absent|Paid Leave|Week Off|Half Day)$")
    shift_multiplier: float = Field(1.0, ge=0, le=3)
    notes: Optional[str] = None


class TimesheetCreate(BaseModel):
    employee_id: uuid.UUID
    project_id: uuid.UUID
    week_start: datetime
    week_end: datetime
    notes: Optional[str] = None


class TimesheetEntryCreate(BaseModel):
    task_id: Optional[uuid.UUID] = None
    entry_date: datetime
    hours: float = Field(..., gt=0, le=24)
    activity_description: Optional[str] = None
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    # R2-561: accepted only for request-shape compatibility; the value is
    # never stored. The server derives duration from start/end (else hours).
    duration: Optional[int] = None # in minutes


class TimesheetResponse(BaseModel):
    id: uuid.UUID
    employee_id: uuid.UUID
    project_id: uuid.UUID
    week_start: datetime
    week_end: datetime
    total_hours: float
    status: str
    approved_by: Optional[uuid.UUID] = None
    notes: Optional[str]
    created_at: datetime

    class Config:
        from_attributes = True


class TimesheetHeaderResponse(TimesheetResponse):
    """A timesheet HEADER, for the weekly approvals table.

    R2-588: both existing GETs (/timesheets/project/{id} and
    /timesheets/company/{id}) return List[TimesheetEntryResponse] -- entries,
    not headers. Nothing in the API returned headers at all, so the console's
    approvals table had nothing to render and its Submit/Approve buttons, which
    live inside those rows, could never appear. Every timesheet therefore stayed
    draft forever.
    """
    employee_name: Optional[str] = None


class TimesheetEntryResponse(BaseModel):
    id: uuid.UUID
    timesheet_id: uuid.UUID
    task_id: Optional[uuid.UUID]
    entry_date: datetime
    hours: float
    activity_description: Optional[str]
    start_time: Optional[datetime]
    end_time: Optional[datetime]
    duration: Optional[int]
    created_at: datetime
    employee_name: Optional[str] = None
    employee_id: Optional[uuid.UUID] = None

    class Config:
        from_attributes = True


class PayrollRunCreate(BaseModel):
    company_id: uuid.UUID
    project_id: Optional[uuid.UUID] = None
    payroll_month: str = Field(..., pattern=r"^\d{4}-\d{2}$")  # e.g. "2026-06"
    # R2-481: the payroll denominator is no longer a client-supplied constant
    # defaulting to 26. Omitted -> derived server-side from the real calendar
    # length of payroll_month minus the company's configured weekly offs
    # (Company.weekly_off_days), so the Weekly Off configuration finally feeds
    # payroll. An explicit value is still honored (bounds kept) for
    # fixed-cycle companies.
    days_in_month: Optional[int] = Field(None, ge=1, le=31)
    # R2-431: opt in to paying a full month for employees with no recorded
    # attendance or leave (salaried staff who do not punch). Default False —
    # no recorded days, no pay.
    assume_full_month: bool = False

    @field_validator("project_id", mode="before")
    @classmethod
    def validate_project_id(cls, v):
        if v == "" or v is None:
            return None
        return v

    @field_validator("payroll_month")
    @classmethod
    def _payroll_month_is_real_month(cls, v: str) -> str:
        # R2-355: the pattern alone accepts "2026-13", which run_payroll feeds
        # straight into datetime() and crashes with an unhandled ValueError.
        # Reject impossible months here so the client gets a 422 naming the
        # valid format instead of a 500.
        month = int(v.split("-")[1])
        if not 1 <= month <= 12:
            raise ValueError("payroll_month must be a real month in YYYY-MM format, e.g. 2026-06")
        return v


class PayslipResponse(BaseModel):
    id: uuid.UUID
    payroll_run_id: uuid.UUID
    employee_id: uuid.UUID
    employee_name: str
    days_present: float
    days_in_month: int
    gross_salary: float
    basic: float
    hra: float
    other_allowances: float
    overtime_amount: float
    pf_employee: float
    pf_employer: float
    esi_employee: float
    esi_employer: float
    tds: float
    advance_recovery: float
    other_deductions: float
    total_deductions: float
    net_payable: float
    # D2: always returned — whether days were counted from punch/leave or assumed fallback
    attendance_source: str = "recorded"


class PayrollRunResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    project_id: Optional[uuid.UUID]
    payroll_month: str
    status: str
    total_gross: float
    total_deductions: float
    total_net: float
    created_at: datetime
    payslips: List[PayslipResponse] = []

    class Config:
        from_attributes = True


# ─── Employees ───────────────────────────────────────────────────────────────

@router.post("/employees", response_model=EmployeeResponse, status_code=status.HTTP_201_CREATED)
def create_employee(payload: EmployeeCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, payload.company_id)
    require_permission(db, current_user, payload.company_id, "payroll:edit")
    data = payload.model_dump()
    # ESI eligibility is derived from gross wages server-side; the caller's
    # value is never trusted.
    data["is_esi_applicable"] = _esi_applicable(data["basic_salary"], data["hra"], data["other_allowances"])
    emp = StaffEmployee(**data)
    db.add(emp)
    db.commit()
    db.refresh(emp)
    return emp


@router.get("/employees/{project_id}", response_model=List[EmployeeResponse])
def list_employees(project_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access), current_user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    employees = db.query(StaffEmployee).filter(
        StaffEmployee.project_id == project_id,
        StaffEmployee.status == "active"
    ).all()
    return _staff_list(db, current_user, project.company_id, employees)


# ─── Attendance / Geofence ───────────────────────────────────────────────────

@router.post("/attendance/punch", response_model=AttendanceResponse, status_code=status.HTTP_201_CREATED)
def punch(payload: PunchRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == payload.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    # Punches feed payroll days, so marking someone present is an attendance edit
    # (Supervisor, Site Engineer, HR), not something any member may do.
    require_permission(db, current_user, project.company_id, "attendance:edit")

    employee = db.query(StaffEmployee).filter(StaffEmployee.id == payload.employee_id).first()
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")
    if employee.company_id != project.company_id:
        # AttendanceLog carries no company_id and run_payroll counts attendance by
        # employee_id alone, so a cross-company punch would inject attendance that
        # later inflates the victim company's payroll days.
        raise HTTPException(status_code=403, detail="Employee does not belong to this project's company")

    site_lat, site_lng = _parse_site_coords(project.location)
    radius = 500 if project.attendance_radius_meters is None else project.attendance_radius_meters

    distance_m: Optional[float] = None
    within_geofence = False
    if site_lat is not None:
        distance_m = round(haversine_distance_m(payload.lat, payload.lng, site_lat, site_lng), 2)
        within_geofence = distance_m <= radius
    else:
        # R2-750: no site coords configured, so nothing was measured. This used
        # to set within_geofence = True, which stamped every punch
        # location_verified=True and "Present" on the strength of a measurement
        # that never happened. Attendance drives payroll and "GPS Verified" is
        # an assurance shown to whoever reviews the muster, so an unverifiable
        # punch is recorded as unverified -- not as verified.
        #
        # The project can be given coordinates via PUT /projects/{id} (R2-750
        # added `location` to ProjectCreate/ProjectUpdate); until then the
        # honest answer is "not verified", never a silently-passing geofence.
        within_geofence = False

    # R2-210/R2-262/R2-728: aware UTC clock so stored/loaded punch values (aware on
    # Postgres) are always compared against the same flavor.
    now = datetime.now(timezone.utc)

    # C10: Offline punches accept client-provided captured_at within a sane window
    # (up to 24h in the past, max 5 minutes in the future for clock skew).
    if payload.captured_at is not None:
        punch_time = _aware_utc(payload.captured_at)
        if punch_time > now + timedelta(minutes=5):
            raise HTTPException(
                status_code=400,
                detail="captured_at cannot be in the future (maximum 5 minutes clock skew allowed).",
            )
        if punch_time < now - timedelta(hours=24):
            raise HTTPException(
                status_code=400,
                detail="captured_at is too old (maximum 24 hours allowed for offline sync).",
            )
    else:
        punch_time = now

    today_start, today_end = _ist_day_bounds(punch_time.astimezone(_IST).date())

    if payload.punch_type == "in":
        # Check if already punched in today
        existing = db.query(AttendanceLog).filter(
            AttendanceLog.employee_id == payload.employee_id,
            AttendanceLog.project_id == payload.project_id,
            AttendanceLog.attendance_date >= today_start,
            AttendanceLog.attendance_date < today_end,
            AttendanceLog.punch_in.isnot(None)
        ).first()
        if existing:
            raise HTTPException(status_code=400, detail="Already punched in today. Use punch_type='out'.")

        log = AttendanceLog(
            employee_id=payload.employee_id,
            project_id=payload.project_id,
            attendance_date=punch_time,
            punch_in=punch_time,
            lat_in=Decimal(str(payload.lat)),
            lng_in=Decimal(str(payload.lng)),
            distance_from_site_m=Decimal(str(distance_m)) if distance_m is not None else None,
            is_within_geofence=within_geofence,
            status="Present" if within_geofence else "Present (Off-Site)",
            shift_multiplier=Decimal(str(payload.shift_multiplier or 1.0)),
            location_verified=within_geofence,
            notes=payload.notes
        )
        db.add(log)
        db.commit()
        db.refresh(log)
        return log
    else:
        # punch_type == "out"
        # Search for an open punch-in within the last 24 hours up to punch_time (handles shifts crossing midnight / timezones)
        log = db.query(AttendanceLog).filter(
            AttendanceLog.employee_id == payload.employee_id,
            AttendanceLog.project_id == payload.project_id,
            AttendanceLog.attendance_date >= punch_time - timedelta(hours=24),
            AttendanceLog.attendance_date <= punch_time,
            AttendanceLog.punch_out.is_(None)
        ).order_by(AttendanceLog.attendance_date.desc()).first()
        if not log:
            raise HTTPException(status_code=400, detail="No open punch-in found for today.")

        log.punch_out = punch_time
        log.lat_out = Decimal(str(payload.lat))
        log.lng_out = Decimal(str(payload.lng))

        if payload.shift_multiplier is not None:
            log.shift_multiplier = Decimal(str(payload.shift_multiplier))
        log.location_verified = within_geofence

        # Compute hours worked
        # R2-210/R2-262/R2-728: normalize BOTH operands to aware UTC; punch_in comes
        # back aware from Postgres (naive from SQLite), and mixing flavors
        # raised TypeError, 500ing punch-out and leaving the row open (R2-728).
        if log.punch_in:
            now = punch_time
            delta = (now - _aware_utc(log.punch_in)).total_seconds() / 3600
            if delta < 0:
                raise HTTPException(status_code=400, detail="punch_out time cannot be earlier than punch_in time.")
            log.hours_worked = Decimal(str(round(delta, 2)))
            # Overtime = hours beyond 8
            ot = max(0.0, delta - 8.0)
            log.overtime_hours = Decimal(str(round(ot, 2)))

        db.commit()
        db.refresh(log)
        return log


@router.post("/attendance/manual", response_model=AttendanceResponse)
def mark_attendance_manually(
    payload: ManualAttendanceRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Supervisor marks a day for one employee, with no GPS.

    Deliberately NOT location_verified: this is somebody's word, not a measured
    punch, and the muster shown to whoever signs off payroll has to say which is
    which. Re-marking the same day updates the existing row rather than stacking
    duplicate attendance, which would double-count payroll days.
    """
    project = db.query(Project).filter(Project.id == payload.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "attendance:edit")

    employee = db.query(StaffEmployee).filter(StaffEmployee.id == payload.employee_id).first()
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")
    if employee.company_id != project.company_id:
        raise HTTPException(status_code=403, detail="Employee does not belong to this project's company")

    try:
        target = datetime.strptime(payload.attendance_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(status_code=400, detail="attendance_date must be YYYY-MM-DD")
    if target > datetime.now(timezone.utc) + timedelta(days=1):
        raise HTTPException(status_code=400, detail="attendance_date cannot be in the future")

    day_start, day_end = _ist_day_bounds(target.date())
    log = db.query(AttendanceLog).filter(
        AttendanceLog.employee_id == payload.employee_id,
        AttendanceLog.project_id == payload.project_id,
        AttendanceLog.attendance_date >= day_start,
        AttendanceLog.attendance_date < day_end,
    ).first()

    if log is None:
        log = AttendanceLog(
            employee_id=payload.employee_id,
            project_id=payload.project_id,
            attendance_date=target,
        )
        db.add(log)

    log.status = payload.status
    log.shift_multiplier = Decimal(str(payload.shift_multiplier))
    log.is_within_geofence = False
    log.location_verified = False
    log.marked_manually = True
    log.marked_by = current_user.name
    if payload.notes:
        log.notes = payload.notes

    db.commit()
    db.refresh(log)
    return log


@router.get("/attendance/{project_id}/{date_str}", response_model=List[AttendanceResponse])
def daily_attendance(project_id: uuid.UUID, date_str: str, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    try:
        target = datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="date_str must be YYYY-MM-DD")
    day_start, day_end = _ist_day_bounds(target.date())
    return db.query(AttendanceLog).filter(
        AttendanceLog.project_id == project_id,
        AttendanceLog.attendance_date >= day_start,
        AttendanceLog.attendance_date < day_end
    ).all()


# ─── Timesheets ──────────────────────────────────────────────────────────────

@router.post("/timesheets", response_model=TimesheetResponse, status_code=status.HTTP_201_CREATED)
def create_timesheet(payload: TimesheetCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == payload.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "attendance:edit")
    # R2-564: the staff_employees FK was enforced only by the database, so a
    # stale employee_id surfaced as a raw 500. Resolve it here so stale
    # clients get an honest 404.
    employee = db.query(StaffEmployee).filter(
        StaffEmployee.id == payload.employee_id,
        StaffEmployee.company_id == project.company_id,
    ).first()
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")
    ts = Timesheet(**payload.model_dump())
    db.add(ts)
    db.commit()
    db.refresh(ts)
    return ts


@router.post("/timesheets/{ts_id}/entries", status_code=status.HTTP_201_CREATED)
def add_timesheet_entry(ts_id: uuid.UUID, payload: TimesheetEntryCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    ts = db.query(Timesheet).filter(Timesheet.id == ts_id).first()
    if not ts:
        raise HTTPException(status_code=404, detail="Timesheet not found")
    project = db.query(Project).filter(Project.id == ts.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Timesheet's project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "attendance:edit")
    if ts.status not in ("draft", "rejected"):
        raise HTTPException(status_code=400, detail=f"Cannot add entries to timesheet in status '{ts.status}'")

    entry_date = payload.entry_date
    week_start = ts.week_start
    week_end = ts.week_end
    if entry_date.tzinfo is None:
        entry_date = entry_date.replace(tzinfo=timezone.utc)
    if week_start.tzinfo is None:
        week_start = week_start.replace(tzinfo=timezone.utc)
    if week_end.tzinfo is None:
        week_end = week_end.replace(tzinfo=timezone.utc)
    if not (week_start <= entry_date <= week_end):
        raise HTTPException(
            status_code=422,
            detail=f"entry_date must fall within the timesheet's week ({week_start.date()} to {week_end.date()})",
        )

    entry_data = payload.model_dump()
    # R2-561: duration is always derived server-side; any client-supplied
    # value is discarded so hours, start/end and duration cannot disagree.
    # end <= start is rejected rather than persisted as a negative duration.
    if entry_data.get("start_time") and entry_data.get("end_time"):
        start = _aware_utc(entry_data["start_time"])
        end = _aware_utc(entry_data["end_time"])
        if end <= start:
            raise HTTPException(status_code=422, detail="end_time must be after start_time")
        entry_data["duration"] = int((end - start).total_seconds() // 60)
    else:
        entry_data["duration"] = int(round(payload.hours * 60))

    entry = TimesheetEntry(timesheet_id=ts_id, **entry_data)
    db.add(entry)

    # Recompute total_hours
    existing_hours = sum(
        float(e.hours) for e in db.query(TimesheetEntry).filter(TimesheetEntry.timesheet_id == ts_id).all()
    )
    ts.total_hours = Decimal(str(round(existing_hours + payload.hours, 2)))
    db.commit()
    db.refresh(entry)
    return {
        "id": str(entry.id), 
        "timesheet_total_hours": float(ts.total_hours),
        "start_time": entry.start_time.isoformat() if entry.start_time else None,
        "end_time": entry.end_time.isoformat() if entry.end_time else None,
        "duration": entry.duration
    }


@router.get("/timesheets/project/{project_id}", response_model=List[TimesheetEntryResponse])
def list_project_timesheet_entries(project_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    results = db.query(
        TimesheetEntry,
        StaffEmployee.name.label("employee_name"),
        Timesheet.employee_id.label("employee_id")
    ).select_from(TimesheetEntry)\
     .join(Timesheet, TimesheetEntry.timesheet_id == Timesheet.id)\
     .join(StaffEmployee, Timesheet.employee_id == StaffEmployee.id)\
     .filter(Timesheet.project_id == project_id)\
     .order_by(TimesheetEntry.entry_date.desc())\
     .all()
    
    response = []
    for entry, emp_name, emp_id in results:
        res = TimesheetEntryResponse.model_validate(entry)
        res.employee_name = emp_name
        res.employee_id = emp_id
        response.append(res)
    return response


@router.get("/timesheets/project/{project_id}/headers", response_model=List[TimesheetHeaderResponse])
def list_project_timesheet_headers(project_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    """R2-588: return the timesheet HEADERS for a project.

    The project and company variants above both return entries; the weekly
    approvals table needs one row per timesheet (employee, week, hours, status)
    so Submit and Approve have somewhere to render.
    """
    rows = (
        db.query(Timesheet, StaffEmployee.name.label("employee_name"))
        .join(StaffEmployee, Timesheet.employee_id == StaffEmployee.id)
        .filter(Timesheet.project_id == project_id)
        .order_by(Timesheet.week_start.desc(), StaffEmployee.name.asc())
        .all()
    )
    headers = []
    for ts, emp_name in rows:
        item = TimesheetHeaderResponse.model_validate(ts)
        item.employee_name = emp_name
        headers.append(item)
    return headers


@router.get("/timesheets/company/{company_id}")
def list_company_timesheet_entries(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    results = db.query(
        TimesheetEntry,
        StaffEmployee.name.label("employee_name"),
        Timesheet.employee_id.label("employee_id"),
        Project.name.label("project_name")
    ).select_from(TimesheetEntry)\
     .join(Timesheet, TimesheetEntry.timesheet_id == Timesheet.id)\
     .join(StaffEmployee, Timesheet.employee_id == StaffEmployee.id)\
     .join(Project, Timesheet.project_id == Project.id)\
     .filter(Project.company_id == company_id)\
     .order_by(TimesheetEntry.entry_date.desc())\
     .all()
    
    response = []
    for entry, emp_name, emp_id, proj_name in results:
        response.append({
            "id": str(entry.id),
            "timesheet_id": str(entry.timesheet_id),
            "entry_date": entry.entry_date.isoformat(),
            "hours": float(entry.hours),
            "activity_description": entry.activity_description,
            "employee_name": emp_name,
            "employee_id": str(emp_id),
            "project_name": proj_name,
            "start_time": entry.start_time.isoformat() if entry.start_time else None,
            "end_time": entry.end_time.isoformat() if entry.end_time else None,
            "duration": entry.duration
        })
    return response


@router.patch("/timesheets/{ts_id}/submit", response_model=TimesheetResponse)
def submit_timesheet(ts_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    ts = db.query(Timesheet).filter(Timesheet.id == ts_id).first()
    if not ts:
        raise HTTPException(status_code=404, detail="Timesheet not found")
    project = db.query(Project).filter(Project.id == ts.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Timesheet's project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "attendance:edit")
    if ts.status != "draft":
        raise HTTPException(status_code=400, detail="Only draft timesheets can be submitted")
    ts.status = "submitted"
    db.commit()
    db.refresh(ts)
    return ts


@router.patch("/timesheets/{ts_id}/approve", response_model=TimesheetResponse)
def approve_timesheet(ts_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    ts = db.query(Timesheet).filter(Timesheet.id == ts_id).first()
    if not ts:
        raise HTTPException(status_code=404, detail="Timesheet not found")
    project = db.query(Project).filter(Project.id == ts.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Timesheet's project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "attendance:approve")
    if ts.status != "submitted":
        raise HTTPException(status_code=400, detail="Only submitted timesheets can be approved")
    ts.status = "approved"
    ts.approved_by = current_user.id
    db.commit()
    db.refresh(ts)
    return ts


@router.delete("/timesheets/{ts_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_timesheet(ts_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Delete a weekly timesheet. Tenant-scoped: the caller must belong to the
    timesheet's company, and the deletion is written to the DeleteLog audit trail.

    Timesheet has no company_id column of its own; tenancy is resolved via
    its project (same relationship list_company_timesheet_entries joins
    through)."""
    ts = db.query(Timesheet).filter(Timesheet.id == ts_id).first()
    if not ts:
        raise HTTPException(status_code=404, detail="Timesheet not found")
    project = db.query(Project).filter(Project.id == ts.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Timesheet's project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "data:delete")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, project.company_id, "timesheet", ts.id, f"Timesheet {ts.id}", deleted_by=current_user.name)
    db.delete(ts)
    db.commit()


# ─── Payroll Engine ──────────────────────────────────────────────────────────

_WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def _working_days_in_month(payroll_month: str, weekly_off_days, holidays=None) -> int:
    """R2-481/R2-754: real calendar length of payroll_month minus the company's
    configured weekly offs and declared company holidays for that month.
    Stored day names may be full ("Sunday") or abbreviated ("Sun"); matching
    is case-insensitive on the first three letters."""
    year, month = (int(part) for part in payroll_month.split("-"))
    off_keys = {str(name).strip().lower()[:3] for name in (weekly_off_days or [])}
    holiday_days = set()
    for h in (holidays or []):
        if hasattr(h, "date") and not callable(getattr(h, "date")):
            h_date = h.date
        elif isinstance(h, (datetime, date)):
            h_date = h
        elif isinstance(h, str):
            try:
                h_date = date.fromisoformat(h.split("T")[0])
            except Exception:
                continue
        else:
            continue

        if isinstance(h_date, (datetime, date)):
            if h_date.year == year and h_date.month == month:
                holiday_days.add(h_date.day)

    total_days = calendar.monthrange(year, month)[1]
    return sum(
        1
        for day in range(1, total_days + 1)
        if _WEEKDAY_KEYS[datetime(year, month, day).weekday()] not in off_keys
        and day not in holiday_days
    )


def _compute_payslip(emp: StaffEmployee, days_present: float, days_in_month: int, overtime_hours: float = 0.0, pf_wage_ceiling: float = 15000.0) -> dict:
    """
    Compute one employee's payslip.

    Gross = (Basic + HRA + OtherAllowances) * ratio + OvertimePay, where the
    pro-rata ratio is capped at 1.0 so attendance above days_in_month never
    pays more than one full month (R2-354).
    PF employee  = Basic * pf_employee_pct%   (on prorated basic)
    PF employer  = Basic(capped at pf_wage_ceiling) * pf_employer_pct% (CD-4)
    ESI employee = Gross * esi_employee_pct%  (only if is_esi_applicable)
    ESI employer = Gross * esi_employer_pct%
    TDS          = tds_monthly (fixed, not prorated)
    Net          = Gross - PF_emp - ESI_emp - TDS
    PF ceiling is applied in exactly one place here for employer PF (CD-4);
    employee PF is also capped to the same wage base for ledger consistency.
    """
    # R2-354: cap the pro-rata at one full month. days_present counts calendar
    # attendance against the resolved period denominator (R2-481: derived from
    # the real month minus weekly offs when the client omits it), so an
    # uncapped ratio could pay past 100% for a fully attended month.
    ratio = min(1.0, days_present / days_in_month) if days_in_month > 0 else 0
    full_gross = float(emp.basic_salary) + float(emp.hra) + float(emp.other_allowances)
    
    # Overtime Calculation
    ot_rate = (float(emp.basic_salary) / days_in_month / 8.0) * 1.5 if days_in_month > 0 else 0.0
    ot_amount = round(float(overtime_hours) * ot_rate, 2)

    gross = round(full_gross * ratio, 2) + ot_amount
    basic_pro = round(float(emp.basic_salary) * ratio, 2)

    # CD-4: EPF wage ceiling caps the wage base for PF at pf_wage_ceiling (default 15000).
    # Applied in exactly one place here (employer PF wage base).
    _ceiling = float(pf_wage_ceiling) if pf_wage_ceiling is not None else 15000.0
    _pf_wages_capped = min(basic_pro, _ceiling)
    pf_emp = round(_pf_wages_capped * float(emp.pf_employee_pct) / 100, 2)
    pf_er  = round(_pf_wages_capped * float(emp.pf_employer_pct) / 100, 2)

    if emp.is_esi_applicable and (full_gross + ot_amount) <= ESI_GROSS_WAGE_CEILING:
        esi_emp = round(gross * float(emp.esi_employee_pct) / 100, 2)
        esi_er  = round(gross * float(emp.esi_employer_pct) / 100, 2)
    else:
        esi_emp = esi_er = 0.0

    tds = float(emp.tds_monthly)
    total_ded = round(pf_emp + esi_emp + tds, 2)
    net = round(gross - total_ded, 2)

    return {
        "days_present": days_present,
        "days_in_month": days_in_month,
        "gross_salary": gross,
        "basic": basic_pro,
        "hra": round(float(emp.hra) * ratio, 2),
        "other_allowances": round(float(emp.other_allowances) * ratio, 2),
        "overtime_amount": ot_amount,
        "pf_employee": pf_emp,
        "pf_employer": pf_er,
        "esi_employee": esi_emp,
        "esi_employer": esi_er,
        "tds": tds,
        "advance_recovery": 0.0,
        "other_deductions": 0.0,
        "total_deductions": total_ded,
        "net_payable": net,
    }


@router.post("/payroll/run", response_model=PayrollRunResponse, status_code=status.HTTP_201_CREATED)
def run_payroll(payload: PayrollRunCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Triggers a monthly payroll run for all active employees in the project.
    Days present is determined by counting AttendanceLog records for that month with status 'Present' or 'Present (Off-Site)'.
    """
    get_company_membership(db, current_user, payload.company_id)
    require_permission(db, current_user, payload.company_id, "payroll:run")
    # Parse month boundaries
    # R2-220: attendance_date is aware on Postgres, so the month bounds must
    # be aware UTC too or the SQL comparison errors out.
    year, month = map(int, payload.payroll_month.split("-"))
    month_start = datetime(year, month, 1, tzinfo=timezone.utc)
    month_end = datetime(year, month + 1, 1, tzinfo=timezone.utc) if month < 12 else datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    # Attendance is counted by Indian calendar day (see _ist_day_bounds).
    att_start = _ist_day_bounds(month_start.date())[0]
    att_end = _ist_day_bounds(month_end.date())[0]

    # R2-481: resolve the denominator server-side. An explicitly supplied
    # days_in_month wins; otherwise the real month length minus the company's
    # weekly offs replaces the old constant default of 26.
    company = db.query(Company).filter(Company.id == payload.company_id).first()
    # R2-754: Fetch declared company holidays for this month so paid holidays reduce working days
    holidays = db.query(Holiday).filter(
        Holiday.company_id == payload.company_id,
        Holiday.date >= month_start,
        Holiday.date < month_end,
    ).all()
    if payload.days_in_month is not None:
        effective_days_in_month = int(payload.days_in_month)
    else:
        effective_days_in_month = _working_days_in_month(
            payload.payroll_month,
            company.weekly_off_days if company else [],
            holidays=holidays,
        )

    # R2-606: a payroll run is a money entry into a period, so it obeys the
    # same Entry Controls back-dating window as bills and payments (R2-381).
    # The pay period's closing boundary is what ages: a month is only
    # rejected once it has been fully closed for longer than the window,
    # so running last month's payroll stays possible on a normal window.
    enforce_entry_creation_window(db, payload.company_id, month_end)

    # R2-353: payroll must be idempotent per (company, project, month). A
    # re-run used to mint a second finalized run and double-count every
    # salary in the ledgers that sum PayrollLineItem, with no way to void
    # either run. Name the existing run so the caller can inspect it.
    existing_run = db.query(PayrollRun).filter(
        PayrollRun.company_id == payload.company_id,
        PayrollRun.project_id == payload.project_id,
        PayrollRun.payroll_month == payload.payroll_month,
        PayrollRun.status == "finalized",
    ).first()
    if existing_run:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"A finalized payroll run already exists for {payload.payroll_month} "
                f"(run id {existing_run.id}). Void it before running payroll again."
            ),
        )

    # Fetch active employees
    query = db.query(StaffEmployee).filter(
        StaffEmployee.company_id == payload.company_id,
        StaffEmployee.status == "active"
    )
    if payload.project_id:
        query = query.filter(StaffEmployee.project_id == payload.project_id)
    employees = query.all()

    if not employees:
        raise HTTPException(status_code=400, detail="No active employees found for the given company/project")

    run = PayrollRun(
        company_id=payload.company_id,
        project_id=payload.project_id,
        payroll_month=payload.payroll_month,
        status="draft",
    )
    db.add(run)
    db.flush()

    payslips = []
    for emp in employees:
        # Count attendance days this month
        att_count = db.query(AttendanceLog).filter(
            AttendanceLog.employee_id == emp.id,
            AttendanceLog.attendance_date >= att_start,
            AttendanceLog.attendance_date < att_end,
            AttendanceLog.status.in_(["Present", "Present (Off-Site)"])
        ).count()

        # Sum overtime hours this month
        total_ot = db.query(func.sum(AttendanceLog.overtime_hours)).filter(
            AttendanceLog.employee_id == emp.id,
            AttendanceLog.attendance_date >= att_start,
            AttendanceLog.attendance_date < att_end
        ).scalar() or 0.0

        # Handle joining mid-month
        if emp.date_of_joining:
            # R2-220: keep the same flavor as the now-aware month bounds.
            joining_date = _aware_utc(emp.date_of_joining)
            if joining_date > month_start:
                if joining_date < month_end:
                    days_remaining = (month_end - joining_date).days
                    default_days = min(float(days_remaining), float(effective_days_in_month))
                else:
                    default_days = 0.0
            else:
                default_days = float(effective_days_in_month)
        else:
            default_days = float(effective_days_in_month)

        # Add approved, PAID leave days to attendance so leave isn't under-counted.
        # Mirror the name-matching convention used by get_leave_balances; also
        # match the new employee_id FK when populated. Only templated paid leave
        # types (casual/sick/earned) count — any other leave_type value is left
        # out pending a founder decision on paid-vs-unpaid handling.
        PAID_LEAVE_TYPES = {"casual", "sick", "earned"}
        approved_leaves = db.query(LeaveRequest).filter(
            LeaveRequest.company_id == payload.company_id,
            func.lower(LeaveRequest.status) == "approved",
            (LeaveRequest.employee_id == emp.id) | (func.lower(LeaveRequest.employee_name) == emp.name.lower()),
            LeaveRequest.start_date < month_end,
            LeaveRequest.end_date >= month_start,
        ).all()
        approved_leave_days = 0.0
        for lr in approved_leaves:
            if (lr.leave_type or "").strip().lower() in PAID_LEAVE_TYPES:
                approved_leave_days += float(lr.days_count or 0.0)

        # D2 + R2-431: zero-attendance payroll POLICY.
        # Company setting assume_full_month_when_no_attendance defaults OFF (no punch = zero pay).
        # The per-run payload flag is retained for backwards compat; effective value is OR of both.
        # ALWAYS return attendance_source recorded|assumed and badge assumed rows (NOT optional).
        effective_assume = bool(payload.assume_full_month) or bool(getattr(company, "assume_full_month_when_no_attendance", False))
        # CD-4: EPF wage ceiling default 15000, capped in _compute_payslip employer PF (single place).
        _ceiling_raw = getattr(company, "pf_wage_ceiling", None)
        if _ceiling_raw is None:
            try:
                from app.models import CompanyPayrollSettings as _CPS
                _cps_row = db.query(_CPS).filter(_CPS.company_id == payload.company_id).first()
                if _cps_row is not None and getattr(_cps_row, "pf_wage_ceiling", None) is not None:
                    _ceiling_raw = _cps_row.pf_wage_ceiling
            except Exception:
                pass
        effective_ceiling = float(_ceiling_raw) if _ceiling_raw is not None else 15000.0
        if (att_count + approved_leave_days) > 0:
            days_present = float(att_count + approved_leave_days)
            attendance_source = "recorded"
        else:
            attendance_source = "assumed"
            days_present = float(default_days) if effective_assume else 0.0

        calc = _compute_payslip(emp, days_present, effective_days_in_month, float(total_ot), pf_wage_ceiling=effective_ceiling)
        calc["attendance_source"] = attendance_source
        # Separate string field before Decimal conversion so it stays verbatim.
        _calc_for_line = {k: (v if isinstance(v, int) else Decimal(str(v))) for k, v in calc.items() if k != "attendance_source"}
        line = PayrollLineItem(
            payroll_run_id=run.id,
            employee_id=emp.id,
            attendance_source=attendance_source,
            **_calc_for_line
        )
        db.add(line)
        payslips.append({"employee_id": emp.id, "employee_name": emp.name, **calc})

    # Aggregate totals
    run.total_gross = Decimal(str(round(sum(p["gross_salary"] for p in payslips), 2)))
    run.total_deductions = Decimal(str(round(sum(p["total_deductions"] for p in payslips), 2)))
    run.total_net = Decimal(str(round(sum(p["net_payable"] for p in payslips), 2)))
    run.status = "finalized"

    db.commit()
    db.refresh(run)

    return {
        "id": run.id,
        "company_id": run.company_id,
        "project_id": run.project_id,
        "payroll_month": run.payroll_month,
        "status": run.status,
        "total_gross": float(run.total_gross),
        "total_deductions": float(run.total_deductions),
        "total_net": float(run.total_net),
        "created_at": run.created_at,
        "payslips": [
            {
                "id": str(uuid.uuid4()),
                "payroll_run_id": str(run.id),
                "employee_id": str(p["employee_id"]),
                "employee_name": p["employee_name"],
                **{k: v for k, v in p.items() if k not in ("employee_id", "employee_name")}
            }
            for p in payslips
        ]
    }


@router.get("/payroll/{run_id}/payslips")
def get_payslips(run_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    run = db.query(PayrollRun).filter(PayrollRun.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Payroll run not found")
    get_company_membership(db, current_user, run.company_id)
    require_module_view(db, current_user, run.company_id, "payroll")
    lines = db.query(PayrollLineItem).filter(PayrollLineItem.payroll_run_id == run_id).all()
    result = []
    for line in lines:
        emp = db.query(StaffEmployee).filter(StaffEmployee.id == line.employee_id).first()
        result.append({
            "id": str(line.id),
            "employee_id": str(line.employee_id),
            "employee_name": emp.name if emp else "Unknown",
            "employee_designation": emp.designation if emp else "",
            "days_present": float(line.days_present),
            "days_in_month": line.days_in_month,
            "gross_salary": float(line.gross_salary),
            "basic": float(line.basic),
            "hra": float(line.hra),
            "other_allowances": float(line.other_allowances),
            "pf_employee": float(line.pf_employee),
            "pf_employer": float(line.pf_employer),
            "esi_employee": float(line.esi_employee),
            "esi_employer": float(line.esi_employer),
            "tds": float(line.tds),
            "advance_recovery": float(line.advance_recovery),
            "total_deductions": float(line.total_deductions),
            "net_payable": float(line.net_payable),
            # D2: always returned for badge
            "attendance_source": getattr(line, "attendance_source", None) or ("assumed" if float(line.days_present or 0) == 0 and line.days_in_month else "recorded"),
        })
    return result




@router.get("/payroll/{run_id}/payslips/export")
def export_payslips_csv(run_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Export one row per PayrollLineItem as a CSV attachment.

    Payroll is sensitive finance data, so this is tenant-guarded and gated by the
    payroll module view permission (same as GET /payroll/{run_id}/payslips). Read-only.
    Every row carries the identity block a filing needs (R2-409): employee code,
    pay period, payroll run id, company and project, so same-named employees
    stay distinguishable and the file can be reconciled to its run.
    """
    run = db.query(PayrollRun).filter(PayrollRun.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Payroll run not found")
    get_company_membership(db, current_user, run.company_id)
    require_module_view(db, current_user, run.company_id, "payroll")

    lines = db.query(PayrollLineItem).filter(PayrollLineItem.payroll_run_id == run_id).all()
    company = db.query(Company).filter(Company.id == run.company_id).first()
    project = db.query(Project).filter(Project.id == run.project_id).first() if run.project_id else None

    columns = [
        "Employee Code", "Employee Name", "Designation", "Days Present", "Days In Month",
        "Gross", "PF Employee", "PF Employer", "ESI Employee", "ESI Employer",
        "TDS", "Advance Recovery", "Other Deductions", "Total Deductions", "Net Pay",
        # R2-409: appended so index-based readers of the original columns keep working.
        "Pay Period", "Payroll Run ID", "Company", "Project",
    ]

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(columns)
    for line in lines:
        emp = db.query(StaffEmployee).filter(StaffEmployee.id == line.employee_id).first()
        writer.writerow([
            _csv_safe_cell(emp.employee_code if (emp and emp.employee_code) else (str(line.employee_id)[:8].upper() if emp else "Unknown")),
            _csv_safe_cell(emp.name if emp else "Unknown"),
            _csv_safe_cell(emp.designation if (emp and emp.designation) else ""),
            float(line.days_present),
            line.days_in_month,
            float(line.gross_salary),
            float(line.pf_employee),
            float(line.pf_employer),
            float(line.esi_employee),
            float(line.esi_employer),
            float(line.tds),
            float(line.advance_recovery),
            float(line.other_deductions),
            float(line.total_deductions),
            float(line.net_payable),
            # R2-409: pay period + reconciliation identifiers.
            _csv_safe_cell(run.payroll_month),
            str(run.id),
            _csv_safe_cell(company.name if company else ""),
            _csv_safe_cell(project.name if project else ""),
        ])
    csv_text = buf.getvalue()
    filename = f"payslips-{run.payroll_month}-{datetime.utcnow().strftime('%Y%m%d')}.csv"
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


@router.get("/payroll/latest/{company_id}")
def latest_payroll_run(company_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Return the most recent PayrollRun for a company so the frontend can resolve a run to export.

    Returns {run_id, payroll_month} or {run_id: null, payroll_month: null} when no run exists yet.
    Tenant-guarded and gated by the payroll module view permission.
    """
    get_company_membership(db, current_user, company_id)
    require_module_view(db, current_user, company_id, "payroll")
    run = (
        db.query(PayrollRun)
        .filter(PayrollRun.company_id == company_id)
        .order_by(PayrollRun.created_at.desc())
        .first()
    )
    if not run:
        return {"run_id": None, "payroll_month": None}
    return {"run_id": str(run.id), "payroll_month": run.payroll_month}


from pydantic import BaseModel


class LeaveRequestCreate(BaseModel):
    project_id: Optional[uuid.UUID] = None
    # R2-527: employee_id is mandatory. An optional id let one approved leave
    # be counted against every employee sharing the name while the id-keyed
    # employee lost name-matched rows entirely (the two lookups were consumed
    # either/or). Legacy NULL-id rows are backfilled once by unambiguous name
    # (supabase migration) and the balance lookup merges both buckets instead
    # of falling back between them.
    employee_id: uuid.UUID
    employee_name: str
    leave_type: str
    start_date: datetime
    end_date: datetime
    days_count: float = Field(..., ge=0)
    reason: Optional[str] = None

    @field_validator("project_id", mode="before")
    @classmethod
    def validate_project_id(cls, v):
        if v == "" or v is None:
            return None
        return v

class LeaveRequestResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    project_id: Optional[uuid.UUID]
    employee_id: Optional[uuid.UUID] = None
    employee_name: str
    leave_type: str
    start_date: datetime
    end_date: datetime
    days_count: float
    status: str
    applied_on: datetime
    reason: Optional[str] = None

    class Config:
        from_attributes = True

LeaveStatus = Literal["Pending", "Approved", "Rejected"]

class LeaveStatusUpdate(BaseModel):
    status: LeaveStatus


@router.get("/leaves/{company_id}", response_model=List[LeaveRequestResponse])
def list_leaves(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    return db.query(LeaveRequest).filter(LeaveRequest.company_id == company_id).all()


@router.post("/leaves/{company_id}", response_model=LeaveRequestResponse)
def create_leave_request(company_id: uuid.UUID, data: LeaveRequestCreate, db: Session = Depends(get_db),     _: None = Depends(verify_company_access), current_user: User = Depends(get_current_user)):
    if data.project_id:
        verify_project_in_company(db, data.project_id, company_id)
    # Workflow Controls: Entry Controls (creation date window)
    enforce_entry_creation_window(db, company_id, data.start_date)
    new_leave = LeaveRequest(
        company_id=company_id,
        project_id=data.project_id,
        employee_id=data.employee_id,
        employee_name=data.employee_name,
        leave_type=data.leave_type,
        start_date=data.start_date,
        end_date=data.end_date,
        days_count=data.days_count,
        reason=data.reason
    )
    db.add(new_leave)
    db.commit()
    db.refresh(new_leave)
    return new_leave


@router.put("/leaves/approve/{leave_id}", response_model=LeaveRequestResponse)
def update_leave_status(leave_id: uuid.UUID, data: LeaveStatusUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    leave = db.query(LeaveRequest).filter(LeaveRequest.id == leave_id).first()
    if not leave:
        raise HTTPException(status_code=404, detail="Leave request not found")
    get_company_membership(db, current_user, leave.company_id)
    require_permission(db, current_user, leave.company_id, "payroll:edit")

    leave.status = data.status
    db.commit()
    db.refresh(leave)
    return leave


@router.post("/leaves/{leave_id}/withdraw", response_model=LeaveRequestResponse)
def withdraw_leave_request(leave_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    leave = db.query(LeaveRequest).filter(LeaveRequest.id == leave_id).first()
    if not leave:
        raise HTTPException(status_code=404, detail="Leave request not found")
    get_company_membership(db, current_user, leave.company_id)
    if leave.status == "Withdrawn":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Leave request is already withdrawn")
    if leave.status in ("Approved", "Rejected"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Cannot withdraw a leave request that is already {leave.status}")

    leave.status = "Withdrawn"
    db.commit()
    db.refresh(leave)
    return leave


@router.post("/payroll/upload")
def upload_payroll(
    company_id: uuid.UUID = Form(...),
    project_id: Optional[uuid.UUID] = Form(None),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user)
):
    # company_id here comes from multipart form data (not the URL path/query),
    # so it can't share a value with a plain Depends(verify_company_access)
    # sub-dependency; verify membership inline instead.
    get_company_membership(db, current_user, company_id)
    require_permission(db, current_user, company_id, "payroll:edit")
    import csv
    import io

    try:
        content = file.file.read().decode("utf-8")
        csv_reader = csv.reader(io.StringIO(content))
    except UnicodeDecodeError:
        raise HTTPException(
            status_code=400,
            detail="Uploaded file could not be decoded as UTF-8 text. Please upload a CSV file.",
        )
    except Exception:
        logger.exception("Payroll CSV upload failed while reading file")
        raise HTTPException(status_code=400, detail="Failed to read the uploaded file. Please re-upload a valid CSV.")

    headers = next(csv_reader, None)
    if not headers:
        raise HTTPException(status_code=400, detail="Empty CSV file")
        
    headers = [h.replace('\ufeff', '').strip() for h in headers]
    
    if 'Name' not in headers:
        raise HTTPException(status_code=400, detail="Invalid CSV schema: 'Name' column is required")
        
    created_count = 0
    updated_count = 0
    
    for row_cells in csv_reader:
        if not row_cells or not any(row_cells):
            continue
            
        row = {}
        for idx, header in enumerate(headers):
            if idx < len(row_cells):
                row[header] = row_cells[idx].strip()
                
        name = row.get("Name")
        if not name:
            continue
            
        def to_float(val, default=0.0):
            try:
                return float(val) if val else default
            except ValueError:
                return default
                
        basic_salary = to_float(row.get("Basic"))
        hra = 0.0
        other_allowances = to_float(row.get("Fixed Allowance"))
        
        for prefix in ["A1", "A2", "A3"]:
            allow_name = row.get(f"Allowance Name ({prefix})", "")
            allow_amt = to_float(row.get(f"{prefix} Amount"))
            if "hra" in allow_name.lower():
                hra += allow_amt
            elif allow_name:
                other_allowances += allow_amt
                
        tds_monthly = 0.0
        for prefix in ["D1", "D2"]:
            ded_name = row.get(f"Deduction Name ({prefix})", "")
            ded_amt = to_float(row.get(f"{prefix} Amount"))
            if "tds" in ded_name.lower() or "tax" in ded_name.lower():
                tds_monthly += ded_amt
                
        designation = row.get("Designation")
        department = row.get("Cost Code")
        mobile = None
        
        emp = db.query(StaffEmployee).filter(
            StaffEmployee.company_id == company_id,
            StaffEmployee.name == name
        ).first()
        
        if emp:
            emp.designation = designation or emp.designation
            emp.department = department or emp.department
            emp.basic_salary = basic_salary
            emp.hra = hra
            emp.other_allowances = other_allowances
            emp.tds_monthly = tds_monthly
            if project_id:
                emp.project_id = project_id
            updated_count += 1
        else:
            emp = StaffEmployee(
                id=uuid.uuid4(),
                company_id=company_id,
                project_id=project_id,
                name=name,
                employee_code=f"EMP-{uuid.uuid4().hex[:6].upper()}",
                designation=designation,
                department=department,
                mobile=mobile,
                basic_salary=basic_salary,
                hra=hra,
                other_allowances=other_allowances,
                tds_monthly=tds_monthly,
                status="active"
            )
            db.add(emp)
            created_count += 1
            
    db.commit()
    
    return {
        "status": "success",
        "created": created_count,
        "updated": updated_count
    }


# ─── Company-scoped HR (Payroll tab) ────────────────────────────────────────

class EmployeeUpdate(BaseModel):
    uan: Optional[str] = None
    designation: Optional[str] = None
    department: Optional[str] = None
    mobile: Optional[str] = None
    basic_salary: Optional[float] = Field(None, ge=0)
    hra: Optional[float] = Field(None, ge=0)
    other_allowances: Optional[float] = Field(None, ge=0)
    tds_monthly: Optional[float] = Field(None, ge=0)
    status: Optional[str] = None
    date_of_joining: Optional[datetime] = None

    @field_validator("uan", mode="before")
    @classmethod
    def validate_uan(cls, v):
        if v is None:
            return None
        v = str(v).strip()
        if not v:
            return None
        if len(v) != 12 or not v.isdigit():
            raise ValueError("UAN must be a 12-digit numeric string")
        return v


@router.get("/company/employees/{company_id}", response_model=List[EmployeeResponse])
def list_company_employees(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access), current_user: User = Depends(get_current_user)):
    """Company-wide active employee list (Payroll → People tab, and the
    attendance screen's staff picker)."""
    employees = db.query(StaffEmployee).filter(
        StaffEmployee.company_id == company_id,
        StaffEmployee.status == "active"
    ).all()
    return _staff_list(db, current_user, company_id, employees)


@router.put("/employees/{employee_id}", response_model=EmployeeResponse)
def update_employee(employee_id: uuid.UUID, payload: EmployeeUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    emp = db.query(StaffEmployee).filter(StaffEmployee.id == employee_id).first()
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")
    get_company_membership(db, current_user, emp.company_id)
    require_permission(db, current_user, emp.company_id, "payroll:edit")
    updates = payload.model_dump(exclude_unset=True)
    for k, v in updates.items():
        setattr(emp, k, v)
    if {"basic_salary", "hra", "other_allowances"} & updates.keys():
        # Pay changed: re-derive ESI eligibility from the new gross wages
        # instead of freezing the verdict captured at creation.
        emp.is_esi_applicable = _esi_applicable(float(emp.basic_salary), float(emp.hra), float(emp.other_allowances))
    db.commit()
    db.refresh(emp)
    return emp


@router.delete("/employees/{employee_id}")
def deactivate_employee(employee_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Deactivate / offboard an employee while keeping payroll and attendance history intact."""
    emp = db.query(StaffEmployee).filter(StaffEmployee.id == employee_id).first()
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")
    get_company_membership(db, current_user, emp.company_id)
    require_permission(db, current_user, emp.company_id, "payroll:edit")
    emp.status = "inactive"
    from app.routers.delete_logs import log_deletion
    log_deletion(db, emp.company_id, "employee", emp.id, f"Employee deactivated: {emp.name}", deleted_by=current_user.name)
    db.commit()
    return {"success": True, "message": "Employee deactivated successfully"}


# ─── Designations (company-scoped lookup) ───────────────────────────────────

class DesignationResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    name: str
    created_at: datetime

    class Config:
        from_attributes = True


class DesignationCreate(BaseModel):
    name: str


@router.get("/designations/{company_id}", response_model=List[DesignationResponse])
def list_designations(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    return db.query(Designation).filter(Designation.company_id == company_id).order_by(Designation.name).all()


@router.post("/designations/{company_id}", response_model=DesignationResponse, status_code=status.HTTP_201_CREATED)
def create_designation(company_id: uuid.UUID, payload: DesignationCreate, db: Session = Depends(get_db), _: None = Depends(verify_company_access), current_user: User = Depends(get_current_user)):
    require_permission(db, current_user, company_id, "payroll:edit")
    obj = Designation(company_id=company_id, name=payload.name)
    db.add(obj)
    db.commit()
    return obj


@router.put("/designations/{designation_id}", response_model=DesignationResponse)
def update_designation(designation_id: uuid.UUID, payload: DesignationCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    obj = db.query(Designation).filter(Designation.id == designation_id).first()
    if not obj:
        raise HTTPException(status_code=404, detail="Designation not found")
    get_company_membership(db, current_user, obj.company_id)
    require_permission(db, current_user, obj.company_id, "payroll:edit")
    obj.name = payload.name
    db.commit()
    db.refresh(obj)
    return obj


@router.delete("/designations/{designation_id}")
def delete_designation(designation_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    obj = db.query(Designation).filter(Designation.id == designation_id).first()
    if not obj:
        raise HTTPException(status_code=404, detail="Designation not found")
    get_company_membership(db, current_user, obj.company_id)
    require_permission(db, current_user, obj.company_id, "payroll:edit")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, obj.company_id, "designation", obj.id, f"Designation: {obj.name}", deleted_by=current_user.name)
    db.delete(obj)
    db.commit()
    return {"success": True}


# ─── Leave Templates (company-scoped policy) ────────────────────────────────

class LeaveTypeQuota(BaseModel):
    type: str
    days: float = Field(..., ge=0)


class LeaveTemplateResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    name: str
    casual_leave_days: float
    sick_leave_days: float
    earned_leave_days: float
    leave_types: List[LeaveTypeQuota] = []
    created_at: datetime

    class Config:
        from_attributes = True


class LeaveTemplateCreate(BaseModel):
    name: str
    casual_leave_days: float = Field(0.0, ge=0)
    sick_leave_days: float = Field(0.0, ge=0)
    earned_leave_days: float = Field(0.0, ge=0)
    leave_types: List[LeaveTypeQuota] = []


class LeaveTemplateUpdate(BaseModel):
    name: Optional[str] = None
    casual_leave_days: Optional[float] = Field(None, ge=0)
    sick_leave_days: Optional[float] = Field(None, ge=0)
    earned_leave_days: Optional[float] = Field(None, ge=0)
    leave_types: Optional[List[LeaveTypeQuota]] = None


@router.get("/leave-templates/{company_id}", response_model=List[LeaveTemplateResponse])
def list_leave_templates(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    return db.query(LeaveTemplate).filter(LeaveTemplate.company_id == company_id).order_by(LeaveTemplate.name).all()


@router.post("/leave-templates/{company_id}", response_model=LeaveTemplateResponse, status_code=status.HTTP_201_CREATED)
def create_leave_template(company_id: uuid.UUID, payload: LeaveTemplateCreate, db: Session = Depends(get_db), _: None = Depends(verify_company_access), current_user: User = Depends(get_current_user)):
    require_permission(db, current_user, company_id, "payroll:edit")
    obj = LeaveTemplate(company_id=company_id, **payload.model_dump())
    db.add(obj)
    db.commit()
    return obj


@router.put("/leave-templates/{leave_template_id}", response_model=LeaveTemplateResponse)
def update_leave_template(leave_template_id: uuid.UUID, payload: LeaveTemplateUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    obj = db.query(LeaveTemplate).filter(LeaveTemplate.id == leave_template_id).first()
    if not obj:
        raise HTTPException(status_code=404, detail="Leave template not found")
    get_company_membership(db, current_user, obj.company_id)
    require_permission(db, current_user, obj.company_id, "payroll:edit")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(obj, k, v)
    db.commit()
    db.refresh(obj)
    return obj


@router.delete("/leave-templates/{leave_template_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_leave_template(leave_template_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    obj = db.query(LeaveTemplate).filter(LeaveTemplate.id == leave_template_id).first()
    if not obj:
        raise HTTPException(status_code=404, detail="Leave template not found")
    get_company_membership(db, current_user, obj.company_id)
    require_permission(db, current_user, obj.company_id, "data:delete")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, obj.company_id, "leave_template", obj.id, f"Leave Template: {obj.name}", deleted_by=current_user.name)
    db.delete(obj)
    db.commit()


# ─── Payroll Profiles (per-employee detail + salary breakup) ────────────────

class PayrollProfileResponse(BaseModel):
    id: uuid.UUID
    employee_id: uuid.UUID
    company_id: uuid.UUID
    salary_amount: float
    shift_start: Optional[str] = None
    shift_end: Optional[str] = None
    shift_hours: float
    overtime_rate: float
    cost_code: Optional[str] = None
    leave_template_id: Optional[uuid.UUID] = None
    salary_breakup: Optional[str] = None
    updated_at: datetime

    class Config:
        from_attributes = True


class PayrollProfileUpdate(BaseModel):
    salary_amount: Optional[float] = Field(None, ge=0)
    shift_start: Optional[str] = None
    shift_end: Optional[str] = None
    shift_hours: Optional[float] = Field(None, ge=0, le=24)
    overtime_rate: Optional[float] = Field(None, ge=0)
    cost_code: Optional[str] = None
    leave_template_id: Optional[uuid.UUID] = None
    salary_breakup: Optional[str] = None


def _to_decimal(val):
    return Decimal(str(val)) if val is not None else None


@router.get("/payroll-profiles/{employee_id}", response_model=PayrollProfileResponse)
def get_payroll_profile(employee_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    prof = db.query(PayrollProfile).filter(PayrollProfile.employee_id == employee_id).first()
    if not prof:
        raise HTTPException(status_code=404, detail="Payroll profile not found")
    get_company_membership(db, current_user, prof.company_id)
    require_module_view(db, current_user, prof.company_id, "payroll")
    return prof


@router.put("/payroll-profiles/{employee_id}", response_model=PayrollProfileResponse)
def upsert_payroll_profile(employee_id: uuid.UUID, payload: PayrollProfileUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    emp = db.query(StaffEmployee).filter(StaffEmployee.id == employee_id).first()
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")
    get_company_membership(db, current_user, emp.company_id)
    require_permission(db, current_user, emp.company_id, "payroll:edit")
    prof = db.query(PayrollProfile).filter(PayrollProfile.employee_id == employee_id).first()
    data = payload.model_dump(exclude_unset=True)

    # R2-764: payroll profile cost code must exist in the company's Cost Code Library
    if "cost_code" in data and data["cost_code"]:
        assert_cost_codes_known(db, emp.company_id, codes=[data["cost_code"]], status_code=422)

    if not prof:
        prof = PayrollProfile(
            employee_id=employee_id,
            company_id=emp.company_id,
            salary_amount=Decimal("0.0"),
            shift_hours=Decimal("8.0"),
            overtime_rate=Decimal("0.0"),
        )
        db.add(prof)
        db.flush()
    for k, v in data.items():
        if v is None:
            continue
        if k in ("salary_amount", "shift_hours", "overtime_rate"):
            setattr(prof, k, _to_decimal(v))
        else:
            setattr(prof, k, v)
    db.commit()
    return prof


# ─── Leave Balances (per-employee, per-assigned template) ───────────────────

class LeaveTypeBalance(BaseModel):
    entitled: float = 0.0
    used: float = 0.0
    balance: float = 0.0


class EmployeeLeaveBalance(BaseModel):
    employee_id: uuid.UUID
    employee_name: str
    designation: Optional[str] = None
    template_source: str  # "assigned" | "company_default" | "none"
    casual: LeaveTypeBalance = LeaveTypeBalance()
    sick: LeaveTypeBalance = LeaveTypeBalance()
    earned: LeaveTypeBalance = LeaveTypeBalance()


class LeaveBalancesResponse(BaseModel):
    company_id: uuid.UUID
    as_of: str
    leave_year: str
    company_has_templates: bool
    employees: List[EmployeeLeaveBalance] = []


@router.get("/leave-balances/{company_id}", response_model=LeaveBalancesResponse)
def get_leave_balances(
    company_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: None = Depends(verify_company_access),
    current_user: User = Depends(get_current_user),
):
    """Per-employee leave balances for a company.

    Entitlement comes from the LeaveTemplate assigned to the employee via their
    PayrollProfile.leave_template_id. If the employee has no profile or no
    template assigned, the company's first LeaveTemplate is used as a fallback;
    if the company has no templates at all, entitlement is 0 and the response
    flags company_has_templates=False so the UI can prompt configuration.

    Used days are the SUM of Approved LeaveRequest days for the current leave
    year (calendar year), merging the id-keyed bucket with the legacy
    name-matched bucket (employee_id NULL rows) instead of falling back
    between them (R2-527).
    Balance can go negative when an employee has over-taken their entitlement.
    """
    require_module_view(db, current_user, company_id, "payroll")

    now = datetime.utcnow()
    leave_year = str(now.year)
    year_start = datetime(now.year, 1, 1)

    employees = (
        db.query(StaffEmployee)
        .filter(StaffEmployee.company_id == company_id, StaffEmployee.status == "active")
        .order_by(StaffEmployee.name)
        .all()
    )

    templates = (
        db.query(LeaveTemplate)
        .filter(LeaveTemplate.company_id == company_id)
        .order_by(LeaveTemplate.created_at)
        .all()
    )
    company_default = templates[0] if templates else None
    template_by_id = {t.id: t for t in templates}

    profiles = (
        db.query(PayrollProfile)
        .filter(PayrollProfile.company_id == company_id)
        .all()
    )
    profile_by_emp = {p.employee_id: p for p in profiles}

    approved = (
        db.query(
            LeaveRequest.employee_id,
            func.lower(LeaveRequest.employee_name).label("ename"),
            func.lower(LeaveRequest.leave_type).label("ltype"),
            func.sum(LeaveRequest.days_count),
        )
        .filter(
            LeaveRequest.company_id == company_id,
            func.lower(LeaveRequest.status) == "approved",
            LeaveRequest.start_date >= year_start,
        )
        .group_by(
            LeaveRequest.employee_id,
            func.lower(LeaveRequest.employee_name),
            func.lower(LeaveRequest.leave_type),
        )
        .all()
    )
    used_by_emp_id: dict = {}
    used_by_name: dict = {}
    for emp_id, ename, ltype, total in approved:
        if emp_id is not None:
            used_by_emp_id.setdefault(emp_id, {})[ltype] = float(total or 0.0)
        else:
            used_by_name.setdefault(ename, {})[ltype] = float(total or 0.0)

    result_employees = []
    for emp in employees:
        prof = profile_by_emp.get(emp.id)
        template = None
        template_source = "none"
        if prof and prof.leave_template_id and prof.leave_template_id in template_by_id:
            template = template_by_id[prof.leave_template_id]
            template_source = "assigned"
        elif company_default is not None:
            template = company_default
            template_source = "company_default"

        entitled = {"casual": 0.0, "sick": 0.0, "earned": 0.0}
        if template is not None:
            entitled["casual"] = float(template.casual_leave_days or 0.0)
            entitled["sick"] = float(template.sick_leave_days or 0.0)
            entitled["earned"] = float(template.earned_leave_days or 0.0)

        # R2-527: merge BOTH buckets instead of the either/or fallback. One
        # employee can carry id-keyed leave and legacy name-matched (NULL-id)
        # leave at the same time; picking one side silently dropped the other.
        used: dict = {}
        for bucket in (
            used_by_emp_id.get(emp.id) or {},
            used_by_name.get(emp.name.lower()) or {},
        ):
            for leave_key, total in bucket.items():
                used[leave_key] = used.get(leave_key, 0.0) + float(total or 0.0)

        def balance_for(key: str) -> LeaveTypeBalance:
            ent = entitled[key]
            usd = float(used.get(key, 0.0))
            return LeaveTypeBalance(
                entitled=round(ent, 2),
                used=round(usd, 2),
                balance=round(ent - usd, 2),
            )

        result_employees.append(
            EmployeeLeaveBalance(
                employee_id=emp.id,
                employee_name=emp.name,
                designation=emp.designation,
                template_source=template_source,
                casual=balance_for("casual"),
                sick=balance_for("sick"),
                earned=balance_for("earned"),
            )
        )

    return LeaveBalancesResponse(
        company_id=company_id,
        as_of=now.strftime("%Y-%m-%d"),
        leave_year=leave_year,
        company_has_templates=bool(templates),
        employees=result_employees,
    )


# ─── Holidays (company-scoped calendar) ─────────────────────────────────────

class HolidayResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    name: str
    date: datetime
    created_at: datetime

    class Config:
        from_attributes = True


class HolidayCreate(BaseModel):
    name: str
    date: datetime


class HolidayUpdate(BaseModel):
    name: Optional[str] = None
    date: Optional[datetime] = None


@router.get("/holidays/{company_id}", response_model=List[HolidayResponse])
def list_holidays(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    return db.query(Holiday).filter(Holiday.company_id == company_id).order_by(Holiday.date).all()


@router.post("/holidays/{company_id}", response_model=HolidayResponse, status_code=status.HTTP_201_CREATED)
def create_holiday(company_id: uuid.UUID, payload: HolidayCreate, db: Session = Depends(get_db), _: None = Depends(verify_company_access), current_user: User = Depends(get_current_user)):
    require_permission(db, current_user, company_id, "payroll:edit")
    # R2-220: pin the calendar date at UTC midnight so a tz-offset input
    # cannot shift the holiday to the previous day on Postgres.
    obj = Holiday(company_id=company_id, name=payload.name, date=_utc_midnight(payload.date))
    db.add(obj)
    db.commit()
    return obj


@router.put("/holidays/{holiday_id}", response_model=HolidayResponse)
def update_holiday(holiday_id: uuid.UUID, payload: HolidayUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    obj = db.query(Holiday).filter(Holiday.id == holiday_id).first()
    if not obj:
        raise HTTPException(status_code=404, detail="Holiday not found")
    get_company_membership(db, current_user, obj.company_id)
    require_permission(db, current_user, obj.company_id, "payroll:edit")
    for k, v in payload.model_dump(exclude_unset=True).items():
        # R2-220: same UTC-midnight pinning on update.
        if k == "date" and v is not None:
            v = _utc_midnight(v)
        setattr(obj, k, v)
    db.commit()
    db.refresh(obj)
    return obj


@router.delete("/holidays/{holiday_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_holiday(holiday_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    obj = db.query(Holiday).filter(Holiday.id == holiday_id).first()
    if not obj:
        raise HTTPException(status_code=404, detail="Holiday not found")
    get_company_membership(db, current_user, obj.company_id)
    require_permission(db, current_user, obj.company_id, "data:delete")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, obj.company_id, "holiday", obj.id, f"Holiday: {obj.name}", deleted_by=current_user.name)
    db.delete(obj)
    db.commit()


# ─── Company-wide attendance ─────────────────────────────────────────────────

class CompanyAttendanceResponse(BaseModel):
    employee_id: uuid.UUID
    employee_name: str
    attendance_date: datetime
    punch_in: Optional[datetime]
    punch_out: Optional[datetime]
    status: str
    hours_worked: Optional[float]
    overtime_hours: float
    is_within_geofence: bool
    # So the muster can show which days were hand-marked rather than punched.
    marked_manually: bool = False
    marked_by: Optional[str] = None

    class Config:
        from_attributes = True


@router.get("/attendance/company/{company_id}/{date_str}", response_model=List[CompanyAttendanceResponse])
def company_attendance(company_id: uuid.UUID, date_str: str, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    """Company-wide attendance rollup for a single day (Payroll → Attendance tab)."""
    try:
        target = datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="date_str must be YYYY-MM-DD")
    day_start, day_end = _ist_day_bounds(target.date())
    results = (
        db.query(AttendanceLog, StaffEmployee.name.label("employee_name"))
        .join(StaffEmployee, AttendanceLog.employee_id == StaffEmployee.id)
        .filter(
            StaffEmployee.company_id == company_id,
            AttendanceLog.attendance_date >= day_start,
            AttendanceLog.attendance_date < day_end,
        )
        .order_by(StaffEmployee.name)
        .all()
    )
    # R2-430: employee_name exists only on StaffEmployee (the joined column),
    # never on AttendanceLog itself, so model_validate(log) failed its required
    # field and the rollup 500ed whenever any row existed. Build each row
    # directly with the joined real name instead.
    response = []
    for log, emp_name in results:
        response.append(CompanyAttendanceResponse(
            employee_id=log.employee_id,
            employee_name=emp_name,
            attendance_date=log.attendance_date,
            punch_in=log.punch_in,
            punch_out=log.punch_out,
            status=log.status,
            hours_worked=float(log.hours_worked) if log.hours_worked is not None else None,
            overtime_hours=float(log.overtime_hours),
            is_within_geofence=bool(log.is_within_geofence),
            marked_manually=bool(getattr(log, "marked_manually", False)),
            marked_by=getattr(log, "marked_by", None),
        ))
    return response

