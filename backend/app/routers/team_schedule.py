from uuid import UUID
from datetime import datetime
from typing import List, Optional
from urllib.parse import urlparse
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from pydantic import BaseModel, field_validator

from app.config import settings
from app.database import get_db
from app.auth import get_current_user, verify_project_in_company, verify_company_access, get_company_membership, require_permission, project_ids_for_user, scope_projects
from app import models
from app.models import User


router = APIRouter(
    prefix="/team-schedule",
    tags=["Team Schedule"],
    dependencies=[Depends(get_current_user)],
)


# ─── Schemas ───────────────────────────────────────────────────────────────────
def _is_allowed_file_url(url: str) -> bool:
    """R2-257: a timesheet attachment reaches an <a href> on the Team Action
    page, so a javascript: URL here is stored XSS in the app's own origin.
    Same rule as drawings: a same-origin path (/...) or an https URL on this
    product's own storage origin; every other scheme and host is rejected."""
    stripped = url.strip()
    if stripped.startswith("/") and not stripped.startswith("//"):
        return True
    parsed = urlparse(stripped)
    if parsed.scheme != "https" or not parsed.netloc:
        return False
    storage_origin = urlparse((getattr(settings, "SUPABASE_URL", "") or "").strip())
    return bool(storage_origin.netloc) and parsed.netloc == storage_origin.netloc


class TimesheetCreate(BaseModel):
    company_id: UUID
    party_id: Optional[UUID] = None
    project_id: Optional[UUID] = None
    entry_date: datetime
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    remarks: Optional[str] = None
    file_url: Optional[str] = None
    file_name: Optional[str] = None

    @field_validator("file_url")
    @classmethod
    def file_url_scheme_allowlist(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        if not v.strip():
            raise ValueError("file_url cannot be blank; send null when there is no attachment")
        if not _is_allowed_file_url(v):
            raise ValueError(
                "file_url must be a same-origin path (/...) or an https URL on this product's own storage origin; other hosts and non-https schemes are rejected"
            )
        return v


class TimesheetUpdate(BaseModel):
    party_id: Optional[UUID] = None
    project_id: Optional[UUID] = None
    entry_date: Optional[datetime] = None
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    remarks: Optional[str] = None
    file_url: Optional[str] = None
    file_name: Optional[str] = None

    @field_validator("file_url")
    @classmethod
    def file_url_scheme_allowlist(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        if not v.strip():
            raise ValueError("file_url cannot be blank; send null when there is no attachment")
        if not _is_allowed_file_url(v):
            raise ValueError(
                "file_url must be a same-origin path (/...) or an https URL on this product's own storage origin; other hosts and non-https schemes are rejected"
            )
        return v


class TimesheetResponse(BaseModel):
    id: UUID
    company_id: UUID
    party_id: Optional[UUID] = None
    party_name: Optional[str] = None
    project_id: Optional[UUID] = None
    project_name: Optional[str] = None
    entry_date: datetime
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    duration_minutes: Optional[int] = None
    remarks: Optional[str] = None
    file_url: Optional[str] = None
    file_name: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


# ─── Helpers ───────────────────────────────────────────────────────────────────
def _serialize(row: models.TeamScheduleTimesheet, db: Session) -> TimesheetResponse:
    party = db.query(models.LibraryParty).filter(models.LibraryParty.id == row.party_id).first() if row.party_id else None
    project = db.query(models.Project).filter(models.Project.id == row.project_id).first() if row.project_id else None
    return TimesheetResponse(
        id=row.id,
        company_id=row.company_id,
        party_id=row.party_id,
        party_name=row.party_name or (party.name if party else None),
        project_id=row.project_id,
        project_name=project.name if project else None,
        entry_date=row.entry_date,
        start_time=row.start_time,
        end_time=row.end_time,
        duration_minutes=row.duration_minutes,
        remarks=row.remarks,
        file_url=row.file_url,
        file_name=row.file_name,
        created_at=row.created_at,
    )


def _compute_duration(start: Optional[datetime], end: Optional[datetime]) -> Optional[int]:
    if not start or not end:
        return None
    seconds = (end - start).total_seconds()
    return int(round(seconds / 60))


def _party_in_company(db: Session, party_id: UUID, company_id: UUID) -> models.LibraryParty:
    """The person must be in this company's library; a party from another
    company would put that company's name on our timesheet."""
    party = db.query(models.LibraryParty).filter(
        models.LibraryParty.id == party_id, models.LibraryParty.company_id == company_id
    ).first()
    if not party:
        raise HTTPException(status_code=400, detail="Pick a person from your company's party list")
    return party


def _row_for_user(db: Session, timesheet_id: UUID, user: User) -> models.TeamScheduleTimesheet:
    """A timesheet on a project this person cannot open is treated as not there."""
    row = db.query(models.TeamScheduleTimesheet).filter(models.TeamScheduleTimesheet.id == timesheet_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Timesheet not found")
    get_company_membership(db, user, row.company_id)
    allowed = project_ids_for_user(db, user, row.company_id)
    if allowed is not None and row.project_id not in allowed:
        raise HTTPException(status_code=404, detail="Timesheet not found")
    return row


# ─── Endpoints ─────────────────────────────────────────────────────────────────
@router.get("/timesheets", response_model=List[TimesheetResponse])
def list_timesheets(
    company_id: UUID,
    party_id: Optional[UUID] = None,
    project_id: Optional[UUID] = None,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    search: Optional[str] = None,
    db: Session = Depends(get_db),
    _: None = Depends(verify_company_access),
    current_user: User = Depends(get_current_user),
):
    q = scope_projects(
        db.query(models.TeamScheduleTimesheet).filter(models.TeamScheduleTimesheet.company_id == company_id),
        db, current_user, company_id, column=models.TeamScheduleTimesheet.project_id,
    )
    if party_id:
        q = q.filter(models.TeamScheduleTimesheet.party_id == party_id)
    if project_id:
        q = q.filter(models.TeamScheduleTimesheet.project_id == project_id)
    if date_from:
        q = q.filter(models.TeamScheduleTimesheet.entry_date >= date_from)
    if date_to:
        q = q.filter(models.TeamScheduleTimesheet.entry_date <= date_to)
    if search:
        like = f"%{search}%"
        q = q.filter(
            (models.TeamScheduleTimesheet.remarks.ilike(like))
            | (models.TeamScheduleTimesheet.party_name.ilike(like))
        )
    rows = q.order_by(models.TeamScheduleTimesheet.entry_date.desc()).all()
    return [_serialize(r, db) for r in rows]


@router.post("/timesheets", response_model=TimesheetResponse, status_code=status.HTTP_201_CREATED)
def create_timesheet(payload: TimesheetCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, payload.company_id)
    if payload.project_id:
        verify_project_in_company(db, payload.project_id, payload.company_id)
    require_permission(db, current_user, payload.company_id, "attendance:edit")
    if payload.start_time and payload.end_time and payload.end_time <= payload.start_time:
        raise HTTPException(status_code=422, detail="End time must be after start time. For a night shift, the end is on the next day.")
    party_name = None
    if payload.party_id:
        party_name = _party_in_company(db, payload.party_id, payload.company_id).name

    row = models.TeamScheduleTimesheet(
        company_id=payload.company_id,
        party_id=payload.party_id,
        party_name=party_name,
        project_id=payload.project_id,
        entry_date=payload.entry_date,
        start_time=payload.start_time,
        end_time=payload.end_time,
        duration_minutes=_compute_duration(payload.start_time, payload.end_time),
        remarks=payload.remarks,
        file_url=payload.file_url,
        file_name=payload.file_name,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _serialize(row, db)


@router.get("/timesheets/{timesheet_id}", response_model=TimesheetResponse)
def get_timesheet(timesheet_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    row = _row_for_user(db, timesheet_id, current_user)
    return _serialize(row, db)


@router.put("/timesheets/{timesheet_id}", response_model=TimesheetResponse)
def update_timesheet(timesheet_id: UUID, payload: TimesheetUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    row = _row_for_user(db, timesheet_id, current_user)
    require_permission(db, current_user, row.company_id, "attendance:edit")

    if payload.project_id is not None:
        verify_project_in_company(db, payload.project_id, row.company_id)
        row.project_id = payload.project_id

    if payload.party_id is not None:
        party = _party_in_company(db, payload.party_id, row.company_id)
        row.party_id = payload.party_id
        row.party_name = party.name

    if payload.entry_date is not None:
        row.entry_date = payload.entry_date

    st = payload.start_time if payload.start_time is not None else row.start_time
    et = payload.end_time if payload.end_time is not None else row.end_time
    if st and et and et <= st:
        raise HTTPException(status_code=422, detail="End time must be after start time. For a night shift, the end is on the next day.")

    if payload.start_time is not None:
        row.start_time = payload.start_time
    if payload.end_time is not None:
        row.end_time = payload.end_time
    if payload.start_time is not None or payload.end_time is not None:
        row.duration_minutes = _compute_duration(row.start_time, row.end_time)

    if payload.remarks is not None:
        row.remarks = payload.remarks
    if payload.file_url is not None:
        row.file_url = payload.file_url
    if payload.file_name is not None:
        row.file_name = payload.file_name

    db.commit()
    db.refresh(row)
    return _serialize(row, db)


@router.delete("/timesheets/{timesheet_id}", status_code=status.HTTP_200_OK)
def delete_timesheet(timesheet_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    row = _row_for_user(db, timesheet_id, current_user)
    require_permission(db, current_user, row.company_id, "data:delete")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, row.company_id, "timesheet", row.id, f"Timesheet: {row.party_name or row.id}", party_name=row.party_name, deleted_by=current_user.name)
    db.delete(row)
    db.commit()
    return {"success": True, "message": "Timesheet deleted successfully"}
