import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field
from collections import defaultdict
from app.database import get_db
from app.auth import get_current_user, verify_company_access, get_company_membership, verify_project_in_company, require_permission
# R2-751: face_punch now takes the current user, so the model is needed here.
from app.models import FaceRecognitionLog, StaffEmployee, User

router = APIRouter(prefix="/face", tags=["Face Recognition Attendance"], dependencies=[Depends(get_current_user)])


class FacePunchRequest(BaseModel):
    company_id: uuid.UUID
    project_id: uuid.UUID
    employee_id: uuid.UUID
    punch_type: str
    face_verified: bool
    confidence_score: Optional[float] = Field(None, ge=0, le=1)
    image_url: Optional[str] = None
    lat: Optional[float] = Field(None, ge=-90, le=90)
    lng: Optional[float] = Field(None, ge=-180, le=180)
    is_within_geofence: bool = False


class FacePunchResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    project_id: uuid.UUID
    employee_id: uuid.UUID
    punch_type: str
    face_verified: bool
    confidence_score: Optional[float]
    image_url: Optional[str]
    lat: Optional[float]
    lng: Optional[float]
    is_within_geofence: bool
    created_at: Optional[datetime]

    class Config:
        from_attributes = True


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
    punch_in: Optional[str] = None
    punch_out: Optional[str] = None
    confidence_in: Optional[float] = None
    confidence_out: Optional[float] = None
    is_within_geofence_in: bool = False
    is_within_geofence_out: bool = False


@router.post("/punch", response_model=FacePunchResponse, status_code=status.HTTP_201_CREATED)
def face_punch(
    payload: FacePunchRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # R2-751: this was the only endpoint in the router with no company check --
    # the three read paths all use verify_company_access, so this was an
    # omission on the one write rather than a module convention. The router is
    # authenticated but not authorized: any authenticated user of any tenant
    # could POST a punch naming another tenant's company_id and project_id,
    # which was then visible to the victim through the guarded GET /face/logs.
    #
    # A face-recognition log is presented as biometric evidence of presence, so
    # an injected row is evidence-shaped. The direct payroll impact is currently
    # limited only by R2-593 (face punches never become an AttendanceLog) --
    # two findings cancelling each other's severity by accident. Fixing R2-593
    # without this would connect an unguarded cross-tenant write to payroll.
    get_company_membership(db, current_user, payload.company_id)
    require_permission(db, current_user, payload.company_id, "attendance:edit")
    verify_project_in_company(db, payload.project_id, payload.company_id)

    log = FaceRecognitionLog(**payload.model_dump())
    db.add(log)
    db.commit()
    db.refresh(log)
    return log


@router.get("/logs/{company_id}", response_model=List[FacePunchResponse])
def list_logs(company_id: uuid.UUID, project_id: Optional[uuid.UUID] = None, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    query = db.query(FaceRecognitionLog).filter(FaceRecognitionLog.company_id == company_id)
    if project_id:
        query = query.filter(FaceRecognitionLog.project_id == project_id)
    return query.order_by(FaceRecognitionLog.created_at.desc().nulls_last()).limit(200).all()


@router.get("/employees/{company_id}", response_model=List[EmployeeRef])
def list_employees(company_id: uuid.UUID, project_id: Optional[uuid.UUID] = None, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    query = db.query(StaffEmployee).filter(StaffEmployee.company_id == company_id, StaffEmployee.status == "active")
    if project_id:
        query = query.filter(StaffEmployee.project_id == project_id)
    return query.limit(100).all()


@router.get("/summary/{company_id}", response_model=List[DailySummary])
def daily_summary(company_id: uuid.UUID, date: str = Query(...), project_id: Optional[uuid.UUID] = None, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    try:
        target_date = datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD")

    next_date = target_date + timedelta(days=1)
    query = db.query(FaceRecognitionLog).filter(
        FaceRecognitionLog.company_id == company_id,
        FaceRecognitionLog.created_at >= target_date,
        FaceRecognitionLog.created_at < next_date,
    )
    if project_id:
        query = query.filter(FaceRecognitionLog.project_id == project_id)

    logs = query.order_by(FaceRecognitionLog.created_at.asc().nulls_last()).all()
    summary = defaultdict(lambda: {"in": None, "out": None, "name": ""})
    for log in logs:
        key = str(log.employee_id)
        emp = db.query(StaffEmployee).filter(StaffEmployee.id == log.employee_id).first()
        if emp:
            summary[key]["name"] = emp.name
        if log.punch_type == "in" and summary[key]["in"] is None:
            summary[key]["in"] = log.created_at.strftime("%H:%M")
            summary[key]["confidence_in"] = float(log.confidence_score) if log.confidence_score else None
            summary[key]["is_within_geofence_in"] = log.is_within_geofence
        elif log.punch_type == "out" and summary[key]["out"] is None:
            summary[key]["out"] = log.created_at.strftime("%H:%M")
            summary[key]["confidence_out"] = float(log.confidence_score) if log.confidence_score else None
            summary[key]["is_within_geofence_out"] = log.is_within_geofence

    result = []
    for emp_id, data in summary.items():
        result.append(DailySummary(
            attendance_date=date,
            employee_id=uuid.UUID(emp_id),
            employee_name=data["name"] or "Unknown",
            punch_in=data["in"],
            punch_out=data["out"],
            confidence_in=data.get("confidence_in"),
            confidence_out=data.get("confidence_out"),
            is_within_geofence_in=data.get("is_within_geofence_in", False),
            is_within_geofence_out=data.get("is_within_geofence_out", False),
        ))
    return result
