"""Biometric attendance terminals (ZKTeco / eSSL and other ADMS "push" devices).

A device is pointed at this server (Comm > Cloud Server / ADMS settings). It then
calls /iclock/* on its own: a handshake GET, a heartbeat, and a POST of every
punch (table=ATTLOG) as tab-separated lines. Devices cannot carry a login, so the
/iclock routes are unauthenticated and accept only serial numbers a company has
registered here. Each punch is stored as a BiometricPunch, matched to an
employee by the device user ID ("PIN"), and folded into that employee's
AttendanceLog for the day: first punch is the punch-in, last is the punch-out.
Punches from a PIN nobody is mapped to are kept and applied once it is mapped.
"""

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import get_current_user, get_company_membership, require_permission, verify_company_access, verify_project_in_company
from app.database import get_db
from app.models import AttendanceLog, BiometricDevice, BiometricPunch, StaffEmployee, User
from app.routers.hr import _aware_utc

adms_router = APIRouter(prefix="/iclock", tags=["Biometric device push (ADMS)"])
router = APIRouter(prefix="/biometric", tags=["Biometric Attendance"], dependencies=[Depends(get_current_user)])

VERIFY_MODES = {"0": "Password", "1": "Fingerprint", "2": "Card", "3": "Password", "4": "Card", "15": "Face", "25": "Palm"}


def _text(body: str, status_code: int = 200) -> PlainTextResponse:
    return PlainTextResponse(body, status_code=status_code)


def _device_for(db: Session, sn: Optional[str]) -> Optional[BiometricDevice]:
    if not sn:
        return None
    device = db.query(BiometricDevice).filter(BiometricDevice.serial_number == sn.strip()).first()
    if device:
        device.last_seen_at = datetime.now(timezone.utc)
        db.commit()
    return device


def _local_day_window(device: BiometricDevice, punch_utc: datetime):
    offset = timedelta(minutes=device.tz_offset_minutes or 0)
    local = punch_utc + offset
    start_local = local.replace(hour=0, minute=0, second=0, microsecond=0)
    start_utc = start_local - offset
    return start_utc, start_utc + timedelta(days=1)


def _apply_to_attendance(db: Session, device: BiometricDevice, employee_id: uuid.UUID, punch_utc: datetime) -> AttendanceLog:
    """Rebuild the employee's attendance for the device's local day from every
    matched punch on that project, so repeats and out-of-order uploads converge."""
    start, end = _local_day_window(device, punch_utc)
    punches = (
        db.query(BiometricPunch)
        .join(BiometricDevice, BiometricDevice.id == BiometricPunch.device_id)
        .filter(
            BiometricDevice.project_id == device.project_id,
            BiometricPunch.employee_id == employee_id,
            BiometricPunch.punch_time >= start,
            BiometricPunch.punch_time < end,
        )
        .all()
    )
    times = sorted(_aware_utc(p.punch_time) for p in punches)
    first, last = times[0], times[-1]

    log = (
        db.query(AttendanceLog)
        .filter(
            AttendanceLog.employee_id == employee_id,
            AttendanceLog.project_id == device.project_id,
            AttendanceLog.attendance_date >= start,
            AttendanceLog.attendance_date < end,
        )
        .order_by(AttendanceLog.attendance_date)
        .first()
    )
    if log is None:
        log = AttendanceLog(
            employee_id=employee_id,
            project_id=device.project_id,
            attendance_date=first,
            status="Present",
            shift_multiplier=Decimal("1.0"),
        )
        db.add(log)

    punch_in = min(first, _aware_utc(log.punch_in)) if log.punch_in else first
    punch_out = last if last > punch_in else None
    if log.punch_out and (punch_out is None or _aware_utc(log.punch_out) > punch_out):
        punch_out = _aware_utc(log.punch_out)
    log.punch_in = punch_in
    log.punch_out = punch_out
    # The terminal is fixed at the site gate, so a punch on it is presence on site.
    log.is_within_geofence = True
    log.location_verified = True
    log.status = "Present"
    if not log.notes:
        log.notes = f"Biometric: {device.name}"
    if punch_out:
        hours = (punch_out - punch_in).total_seconds() / 3600
        log.hours_worked = Decimal(str(round(hours, 2)))
        log.overtime_hours = Decimal(str(round(max(0.0, hours - 8.0), 2)))
    else:
        log.hours_worked = None
        log.overtime_hours = Decimal("0")
    db.flush()
    for p in punches:
        p.attendance_log_id = log.id
    return log


def _parse_attlog(device: BiometricDevice, body: str):
    offset = timedelta(minutes=device.tz_offset_minutes or 0)
    for line in body.splitlines():
        parts = line.strip().split("\t")
        if len(parts) < 2 or not parts[0].strip():
            continue
        try:
            local = datetime.strptime(parts[1].strip(), "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
        punch_utc = (local - offset).replace(tzinfo=timezone.utc)
        verify = VERIFY_MODES.get(parts[3].strip(), parts[3].strip()) if len(parts) > 3 else None
        yield parts[0].strip(), punch_utc, verify


def ingest_attlog(db: Session, device: BiometricDevice, body: str) -> int:
    """Store and apply ATTLOG lines. Returns how many lines were accepted, which
    includes lines already stored: devices resend after a timeout."""
    accepted = 0
    for pin, punch_utc, verify in _parse_attlog(device, body):
        accepted += 1
        exists = db.query(BiometricPunch).filter(
            BiometricPunch.device_id == device.id,
            BiometricPunch.device_pin == pin,
            BiometricPunch.punch_time == punch_utc,
        ).first()
        if exists:
            continue
        employee = db.query(StaffEmployee).filter(
            StaffEmployee.company_id == device.company_id,
            StaffEmployee.biometric_pin == pin,
        ).first()
        punch = BiometricPunch(
            company_id=device.company_id,
            device_id=device.id,
            device_pin=pin,
            punch_time=punch_utc,
            verify_mode=verify,
            employee_id=employee.id if employee else None,
        )
        db.add(punch)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            continue
        if employee:
            _apply_to_attendance(db, device, employee.id, punch_utc)
    db.commit()
    return accepted


# --- Device-facing ADMS endpoints --------------------------------------------

@adms_router.get("/cdata")
@adms_router.get("/cdata.aspx")
def adms_handshake(SN: Optional[str] = None, db: Session = Depends(get_db)):
    device = _device_for(db, SN)
    if not device:
        return _text("UNKNOWN DEVICE", 404)
    hours = (device.tz_offset_minutes or 0) / 60
    return _text(
        f"GET OPTION FROM: {device.serial_number}\n"
        "ATTLOGStamp=None\nOPERLOGStamp=9999\nATTPHOTOStamp=None\n"
        "ErrorDelay=30\nDelay=10\nTransTimes=00:00;14:05\nTransInterval=1\n"
        "TransFlag=TransData AttLog\n"
        f"TimeZone={hours:g}\nRealtime=1\nEncrypt=None\n"
    )


@adms_router.post("/cdata")
@adms_router.post("/cdata.aspx")
async def adms_upload(request: Request, SN: Optional[str] = None, table: Optional[str] = None, db: Session = Depends(get_db)):
    device = _device_for(db, SN)
    if not device:
        return _text("UNKNOWN DEVICE", 404)
    body = (await request.body()).decode("utf-8", errors="replace")
    if (table or "").upper() != "ATTLOG":
        # User lists, templates and operation logs are acknowledged and ignored.
        return _text(f"OK: {len([l for l in body.splitlines() if l.strip()])}")
    return _text(f"OK: {ingest_attlog(db, device, body)}")


@adms_router.get("/getrequest")
@adms_router.get("/getrequest.aspx")
def adms_poll(SN: Optional[str] = None, db: Session = Depends(get_db)):
    if not _device_for(db, SN):
        return _text("UNKNOWN DEVICE", 404)
    return _text("OK")


@adms_router.post("/devicecmd")
@adms_router.post("/devicecmd.aspx")
def adms_command_result(SN: Optional[str] = None, db: Session = Depends(get_db)):
    if not _device_for(db, SN):
        return _text("UNKNOWN DEVICE", 404)
    return _text("OK")


# --- Management endpoints -------------------------------------------------------

class DeviceCreate(BaseModel):
    company_id: uuid.UUID
    project_id: uuid.UUID
    serial_number: str = Field(..., min_length=3, max_length=64)
    name: str = Field(..., min_length=1, max_length=255)
    tz_offset_minutes: int = Field(330, ge=-720, le=840)


class DeviceResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    project_id: uuid.UUID
    serial_number: str
    name: str
    tz_offset_minutes: int
    last_seen_at: Optional[datetime] = None
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class PunchResponse(BaseModel):
    id: uuid.UUID
    device_name: str
    device_pin: str
    punch_time: datetime
    verify_mode: Optional[str] = None
    employee_id: Optional[uuid.UUID] = None
    employee_name: Optional[str] = None


class EmployeePin(BaseModel):
    id: uuid.UUID
    name: str
    employee_code: Optional[str] = None
    designation: Optional[str] = None
    biometric_pin: Optional[str] = None


class PinUpdate(BaseModel):
    biometric_pin: Optional[str] = Field(None, max_length=20)


@router.get("/devices/{company_id}", response_model=List[DeviceResponse])
def list_devices(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    return db.query(BiometricDevice).filter(BiometricDevice.company_id == company_id).order_by(BiometricDevice.created_at).all()


@router.post("/devices", response_model=DeviceResponse, status_code=201)
def register_device(payload: DeviceCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, payload.company_id)
    require_permission(db, current_user, payload.company_id, "attendance:edit")
    verify_project_in_company(db, payload.project_id, payload.company_id)
    serial = payload.serial_number.strip()
    if db.query(BiometricDevice).filter(BiometricDevice.serial_number == serial).first():
        raise HTTPException(status_code=409, detail="A device with this serial number is already registered.")
    device = BiometricDevice(
        company_id=payload.company_id, project_id=payload.project_id, serial_number=serial,
        name=payload.name.strip(), tz_offset_minutes=payload.tz_offset_minutes,
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


@router.delete("/devices/{device_id}", status_code=204)
def remove_device(device_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    device = db.query(BiometricDevice).filter(BiometricDevice.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    get_company_membership(db, current_user, device.company_id)
    require_permission(db, current_user, device.company_id, "attendance:edit")
    db.delete(device)
    db.commit()


@router.get("/punches/{company_id}", response_model=List[PunchResponse])
def list_punches(
    company_id: uuid.UUID,
    unmatched_only: bool = False,
    limit: int = 200,
    db: Session = Depends(get_db),
    _: None = Depends(verify_company_access),
):
    q = db.query(BiometricPunch).filter(BiometricPunch.company_id == company_id)
    if unmatched_only:
        q = q.filter(BiometricPunch.employee_id.is_(None))
    rows = q.order_by(BiometricPunch.punch_time.desc()).limit(max(1, min(limit, 1000))).all()
    devices = {d.id: d.name for d in db.query(BiometricDevice).filter(BiometricDevice.company_id == company_id).all()}
    emp_ids = {r.employee_id for r in rows if r.employee_id}
    names = {e.id: e.name for e in db.query(StaffEmployee).filter(StaffEmployee.id.in_(emp_ids)).all()} if emp_ids else {}
    return [
        PunchResponse(
            id=r.id, device_name=devices.get(r.device_id, ""), device_pin=r.device_pin, punch_time=r.punch_time,
            verify_mode=r.verify_mode, employee_id=r.employee_id, employee_name=names.get(r.employee_id),
        )
        for r in rows
    ]


@router.get("/employees/{company_id}", response_model=List[EmployeePin])
def list_employee_pins(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    rows = db.query(StaffEmployee).filter(StaffEmployee.company_id == company_id).order_by(StaffEmployee.name).all()
    return [
        EmployeePin(id=e.id, name=e.name, employee_code=e.employee_code, designation=e.designation, biometric_pin=e.biometric_pin)
        for e in rows
    ]


@router.put("/employees/{employee_id}/pin", response_model=EmployeePin)
def set_employee_pin(employee_id: uuid.UUID, payload: PinUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    employee = db.query(StaffEmployee).filter(StaffEmployee.id == employee_id).first()
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")
    get_company_membership(db, current_user, employee.company_id)
    require_permission(db, current_user, employee.company_id, "attendance:edit")
    pin = (payload.biometric_pin or "").strip() or None
    if pin:
        clash = db.query(StaffEmployee).filter(
            StaffEmployee.company_id == employee.company_id,
            StaffEmployee.biometric_pin == pin,
            StaffEmployee.id != employee.id,
        ).first()
        if clash:
            raise HTTPException(status_code=409, detail=f"Device user ID {pin} is already assigned to {clash.name}.")
    employee.biometric_pin = pin
    db.flush()
    if pin:
        # Punches recorded before this mapping existed now count for the employee.
        waiting = db.query(BiometricPunch).filter(
            BiometricPunch.company_id == employee.company_id,
            BiometricPunch.device_pin == pin,
            BiometricPunch.employee_id.is_(None),
        ).all()
        for p in waiting:
            p.employee_id = employee.id
        db.flush()
        for p in waiting:
            device = db.query(BiometricDevice).filter(BiometricDevice.id == p.device_id).first()
            if device:
                _apply_to_attendance(db, device, employee.id, _aware_utc(p.punch_time))
    db.commit()
    return EmployeePin(id=employee.id, name=employee.name, employee_code=employee.employee_code,
                       designation=employee.designation, biometric_pin=employee.biometric_pin)
