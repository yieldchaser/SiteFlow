"""
Phase 14 — Minutes of Meeting (MOM)
Router for logging and tracking meeting minutes per company/project site.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.database import get_db
from app.auth import get_current_user, verify_project_in_company, get_company_membership, require_permission
from app.models import MoM, Project, User
from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime, date
import uuid

router = APIRouter(prefix="/mom", tags=["Minutes of Meeting"], dependencies=[Depends(get_current_user)])


# ─── Pydantic Schemas ────────────────────────────────────────────────────────

class ActionItem(BaseModel):
    text: str = Field(..., min_length=1, max_length=500)
    owner: Optional[str] = Field(None, max_length=255)
    due_date: Optional[date] = None
    done: bool = False


class MoMCreate(BaseModel):
    project_id: Optional[str] = None
    title: Optional[str] = Field(None, max_length=255)
    meeting_date: Optional[date] = None
    venue: Optional[str] = Field(None, max_length=255)
    action_items: List[ActionItem] = []
    type: str = "Regular"           # Regular, Review, Client Meeting, Internal
    status: str = "Open"            # Open, Closed, Action Pending
    attendees: List[str] = []
    notes: Optional[str] = None
    created_by: Optional[str] = None


class MoMUpdate(BaseModel):
    # An explicit null moves the minutes to company-wide.
    project_id: Optional[str] = None
    title: Optional[str] = Field(None, max_length=255)
    meeting_date: Optional[date] = None
    venue: Optional[str] = Field(None, max_length=255)
    action_items: Optional[List[ActionItem]] = None
    type: Optional[str] = None
    status: Optional[str] = None
    attendees: Optional[List[str]] = None
    notes: Optional[str] = None
    created_by: Optional[str] = None


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _serialize(m: MoM) -> dict:
    return {
        "id": str(m.id),
        "company_id": str(m.company_id),
        "project_id": str(m.project_id) if m.project_id else None,
        "title": m.title,
        "meeting_date": m.meeting_date.isoformat() if m.meeting_date else None,
        "venue": m.venue,
        "action_items": m.action_items or [],
        "type": m.type,
        "status": m.status,
        "attendees": m.attendees or [],
        "notes": m.notes,
        "created_by": m.created_by,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


# ─── Routes ──────────────────────────────────────────────────────────────────

@router.get("/{company_id}")
def list_mom(
    company_id: str,
    project_id: Optional[str] = None,
    status: Optional[str] = None,
    type: Optional[str] = None,
    attendee: Optional[str] = None,
    date: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List MOM records for a company, with optional filters."""
    get_company_membership(db, current_user, uuid.UUID(company_id))
    query = db.query(MoM).filter(MoM.company_id == uuid.UUID(company_id))
    if project_id:
        query = query.filter(MoM.project_id == uuid.UUID(project_id))
    if status:
        query = query.filter(MoM.status == status)
    if type:
        query = query.filter(MoM.type == type)
    if date:
        try:
            target = datetime.fromisoformat(date).date()
            query = query.filter(MoM.meeting_date == target)
        except ValueError:
            pass
    records = query.order_by(MoM.meeting_date.desc().nullslast(), MoM.created_at.desc()).all()
    if attendee:
        # Part of a name is enough: "kulkarni" finds "Rajesh Kulkarni".
        needle = attendee.strip().lower()
        records = [m for m in records if any(needle in (a or "").lower() for a in (m.attendees or []))]
    return [_serialize(m) for m in records]


@router.post("/{company_id}")
def create_mom(
    company_id: str,
    payload: MoMCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new MOM record."""
    get_company_membership(db, current_user, uuid.UUID(company_id))
    require_permission(db, current_user, uuid.UUID(company_id), "planning:edit")
    if payload.project_id:
        verify_project_in_company(db, uuid.UUID(payload.project_id), uuid.UUID(company_id))
    mom = MoM(
        company_id=uuid.UUID(company_id),
        project_id=uuid.UUID(payload.project_id) if payload.project_id else None,
        title=payload.title,
        meeting_date=payload.meeting_date or datetime.now().date(),
        venue=payload.venue,
        action_items=[a.model_dump(mode="json") for a in payload.action_items],
        type=payload.type,
        status=payload.status,
        attendees=payload.attendees or [],
        notes=payload.notes,
        created_by=current_user.name,
    )
    db.add(mom)
    db.commit()
    db.refresh(mom)
    return {**_serialize(mom), "message": "MOM created successfully."}


@router.get("/{company_id}/{mom_id}")
def get_mom(
    company_id: str,
    mom_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a single MOM record by id."""
    get_company_membership(db, current_user, uuid.UUID(company_id))
    mom = (
        db.query(MoM)
        .filter(MoM.id == uuid.UUID(mom_id), MoM.company_id == uuid.UUID(company_id))
        .first()
    )
    if not mom:
        raise HTTPException(status_code=404, detail="MOM not found.")
    return _serialize(mom)


@router.put("/{company_id}/{mom_id}")
def update_mom(
    company_id: str,
    mom_id: str,
    payload: MoMUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update an existing MOM record."""
    get_company_membership(db, current_user, uuid.UUID(company_id))
    require_permission(db, current_user, uuid.UUID(company_id), "planning:edit")
    mom = (
        db.query(MoM)
        .filter(MoM.id == uuid.UUID(mom_id), MoM.company_id == uuid.UUID(company_id))
        .first()
    )
    if not mom:
        raise HTTPException(status_code=404, detail="MOM not found.")
    if "project_id" in payload.model_fields_set:
        if payload.project_id:
            verify_project_in_company(db, uuid.UUID(payload.project_id), uuid.UUID(company_id))
            mom.project_id = uuid.UUID(payload.project_id)
        else:
            mom.project_id = None
    if payload.title is not None:
        mom.title = payload.title
    if payload.meeting_date is not None:
        mom.meeting_date = payload.meeting_date
    if payload.venue is not None:
        mom.venue = payload.venue
    if payload.action_items is not None:
        mom.action_items = [a.model_dump(mode="json") for a in payload.action_items]
    if payload.type is not None:
        mom.type = payload.type
    if payload.status is not None:
        mom.status = payload.status
    if payload.attendees is not None:
        mom.attendees = payload.attendees
    if payload.notes is not None:
        mom.notes = payload.notes
    if payload.created_by is not None:
        mom.created_by = current_user.name
    db.commit()
    db.refresh(mom)
    return {**_serialize(mom), "message": "MOM updated successfully."}


@router.delete("/{company_id}/{mom_id}")
def delete_mom(
    company_id: str,
    mom_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a MOM record."""
    get_company_membership(db, current_user, uuid.UUID(company_id))
    require_permission(db, current_user, uuid.UUID(company_id), "planning:edit")
    mom = (
        db.query(MoM)
        .filter(MoM.id == uuid.UUID(mom_id), MoM.company_id == uuid.UUID(company_id))
        .first()
    )
    if not mom:
        raise HTTPException(status_code=404, detail="MOM not found.")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, mom.company_id, "mom", mom.id, f"MOM: {mom.type} ({mom.status})", deleted_by=current_user.name)
    db.delete(mom)
    db.commit()
    return {"message": "MOM deleted successfully.", "id": str(mom.id)}
