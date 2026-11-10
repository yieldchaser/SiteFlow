"""Face attendance: the punches a site's face terminal recorded.

Face attendance on Indian sites is done by face-scan terminals (ZKTeco and
similar). The terminal matches the face itself and pushes each punch to
/iclock (biometric.py), saying how the person was checked; those punches
already become attendance and payroll. This screen lists the ones checked by
face.

Before, this router read face_recognition_logs, a table nothing in the product
wrote: there was no camera, no face matching and no caller of its POST /punch,
which took "face_verified" and a confidence score on the client's word. The
screen could only ever be empty, and the endpoint would have stored any
"verified" claim as evidence. Both are gone.
"""
import uuid
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import get_current_user, verify_company_access
from app.database import get_db
from app.models import BiometricDevice, BiometricPunch, Project, StaffEmployee

router = APIRouter(prefix="/face", tags=["Face Recognition Attendance"], dependencies=[Depends(get_current_user)])

FACE = "Face"  # biometric.VERIFY_MODES["15"]


class FacePunch(BaseModel):
    id: uuid.UUID
    punch_time: datetime
    employee_id: Optional[uuid.UUID] = None
    employee_name: Optional[str] = None
    employee_code: Optional[str] = None
    device_pin: str
    device_name: str
    site_name: str


class EmployeeRef(BaseModel):
    id: uuid.UUID
    name: str
    employee_code: Optional[str] = None
    designation: Optional[str] = None

    class Config:
        from_attributes = True


class DailySummary(BaseModel):
    attendance_date: str
    employee_id: uuid.UUID
    employee_name: str
    employee_code: Optional[str] = None
    first_punch: str
    last_punch: Optional[str] = None
    punches: int
    site_name: str


def _devices(db: Session, company_id: uuid.UUID, project_id: Optional[uuid.UUID]):
    q = db.query(BiometricDevice).filter(BiometricDevice.company_id == company_id)
    if project_id:
        q = q.filter(BiometricDevice.project_id == project_id)
    return {d.id: d for d in q.all()}


def _face_punches(db: Session, company_id: uuid.UUID, devices: dict, start=None, end=None, limit=None):
    if not devices:
        return []
    q = db.query(BiometricPunch).filter(
        BiometricPunch.company_id == company_id,
        BiometricPunch.device_id.in_(list(devices)),
        BiometricPunch.verify_mode == FACE,
    )
    if start is not None:
        q = q.filter(BiometricPunch.punch_time >= start, BiometricPunch.punch_time < end)
    q = q.order_by(BiometricPunch.punch_time.desc() if limit else BiometricPunch.punch_time.asc())
    return q.limit(limit).all() if limit else q.all()


def _lookups(db: Session, rows, devices):
    emp_ids = {r.employee_id for r in rows if r.employee_id}
    emps = {e.id: e for e in db.query(StaffEmployee).filter(StaffEmployee.id.in_(emp_ids)).all()} if emp_ids else {}
    proj_ids = {d.project_id for d in devices.values()}
    sites = {p.id: p.name for p in db.query(Project).filter(Project.id.in_(proj_ids)).all()} if proj_ids else {}
    return emps, sites


@router.get("/logs/{company_id}", response_model=List[FacePunch])
def list_logs(company_id: uuid.UUID, project_id: Optional[uuid.UUID] = None, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    devices = _devices(db, company_id, project_id)
    rows = _face_punches(db, company_id, devices, limit=200)
    emps, sites = _lookups(db, rows, devices)
    out = []
    for r in rows:
        d = devices[r.device_id]
        e = emps.get(r.employee_id)
        out.append(FacePunch(
            id=r.id, punch_time=r.punch_time, employee_id=r.employee_id,
            employee_name=e.name if e else None, employee_code=e.employee_code if e else None,
            device_pin=r.device_pin, device_name=d.name, site_name=sites.get(d.project_id, ""),
        ))
    return out


@router.get("/employees/{company_id}", response_model=List[EmployeeRef])
def list_employees(company_id: uuid.UUID, project_id: Optional[uuid.UUID] = None, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    query = db.query(StaffEmployee).filter(StaffEmployee.company_id == company_id, StaffEmployee.status == "active")
    if project_id:
        query = query.filter(StaffEmployee.project_id == project_id)
    return query.limit(100).all()


@router.get("/summary/{company_id}", response_model=List[DailySummary])
def daily_summary(company_id: uuid.UUID, date: str = Query(...), project_id: Optional[uuid.UUID] = None, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    """First and last face punch per person on a day, in the site's own time
    (the terminal's clock offset, India by default). The day used to be cut at
    midnight UTC, so a 5 AM punch landed on the previous day."""
    try:
        day = datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Pick a date")
    devices = _devices(db, company_id, project_id)
    if not devices:
        return []
    offsets = {d.tz_offset_minutes if d.tz_offset_minutes is not None else 330 for d in devices.values()}
    # Wide UTC window covering the local day at every device's offset.
    start = (day - timedelta(minutes=max(offsets))).replace(tzinfo=timezone.utc)
    end = (day + timedelta(days=1) - timedelta(minutes=min(offsets))).replace(tzinfo=timezone.utc)
    rows = _face_punches(db, company_id, devices, start=start, end=end)
    emps, sites = _lookups(db, rows, devices)

    per = OrderedDict()
    for r in rows:
        if not r.employee_id:
            continue  # terminal user ID not linked to an employee yet
        d = devices[r.device_id]
        pt = r.punch_time if r.punch_time.tzinfo else r.punch_time.replace(tzinfo=timezone.utc)
        local = pt + timedelta(minutes=d.tz_offset_minutes if d.tz_offset_minutes is not None else 330)
        if local.date() != day.date():
            continue
        s = per.setdefault(r.employee_id, {"first": local, "last": local, "n": 0, "site": sites.get(d.project_id, "")})
        s["last"] = local
        s["n"] += 1
    out = []
    for emp_id, s in per.items():
        e = emps.get(emp_id)
        out.append(DailySummary(
            attendance_date=date, employee_id=emp_id,
            employee_name=e.name if e else "Unknown", employee_code=e.employee_code if e else None,
            first_punch=s["first"].strftime("%H:%M"),
            last_punch=s["last"].strftime("%H:%M") if s["n"] > 1 else None,
            punches=s["n"], site_name=s["site"],
        ))
    return out
