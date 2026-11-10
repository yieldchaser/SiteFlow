"""
Competitor Parity — Delete Logs (Audit Trail of Deleted Records)
Company-level, read-only audit view of deletions across the platform.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from datetime import datetime, timedelta, timezone
import uuid

from app.database import get_db
from app.auth import get_current_user, get_company_membership, is_owner_equivalent
from app.models import DeleteLog, User

router = APIRouter(tags=["Delete Logs"], dependencies=[Depends(get_current_user)])


# ─── Helpers ─────────────────────────────────────────────────────────────────

def log_deletion(
    db: Session,
    company_id,
    entity_type: str,
    entity_id,
    summary: str,
    party_name: str = None,
    *,
    deleted_by: str,
):
    """Queue an audit log row on the caller's session. The caller's commit
    persists it in the same transaction as the deletion, so either both land
    or neither does; a failure here aborts the caller's delete.

    deleted_by is required keyword-only: an audit trail that records what was
    deleted but never by whom is not an audit trail (R2-301 / R2-536)."""
    cid = uuid.UUID(str(company_id)) if company_id else None
    log = DeleteLog(
        company_id=cid,
        entity_type=entity_type,
        entity_id=str(entity_id),
        entity_summary=summary,
        party_name=party_name,
        deleted_by=deleted_by,
    )
    db.add(log)


def _serialize(l: DeleteLog) -> dict:
    return {
        "id": str(l.id),
        "company_id": str(l.company_id) if l.company_id else None,
        "entity_type": l.entity_type,
        "entity_id": l.entity_id,
        "entity_summary": l.entity_summary,
        "party_name": l.party_name,
        "deleted_by": l.deleted_by,
        "deleted_at": l.deleted_at.isoformat() if l.deleted_at else None,
    }


IST = timezone(timedelta(hours=5, minutes=30))


def _day_bound(value: str, end: bool):
    """A plain date means that whole day in India. "To 10 Nov" used to stop
    at midnight UTC on 10 Nov, so that day's deletions were left out."""
    try:
        if len(value) == 10:
            d = datetime.fromisoformat(value).replace(tzinfo=IST)
            return d + timedelta(days=1) if end else d
        return datetime.fromisoformat(value)
    except ValueError:
        return None


# ─── Routes ──────────────────────────────────────────────────────────────────

@router.get("/{company_id}")
def list_delete_logs(
    company_id: uuid.UUID,
    entity_type: str = None,
    party: str = None,
    from_date: str = None,
    to_date: str = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List deletion logs for a company, with optional filters."""
    get_company_membership(db, current_user, company_id)
    query = db.query(DeleteLog).filter(DeleteLog.company_id == company_id)
    if entity_type:
        query = query.filter(DeleteLog.entity_type == entity_type)
    if party:
        query = query.filter(DeleteLog.party_name.ilike(f"%{party}%"))
    start = _day_bound(from_date, end=False) if from_date else None
    if start is not None:
        query = query.filter(DeleteLog.deleted_at >= start)
    stop = _day_bound(to_date, end=True) if to_date else None
    if stop is not None:
        query = query.filter(DeleteLog.deleted_at < stop if len(to_date) == 10 else DeleteLog.deleted_at <= stop)
    records = query.order_by(DeleteLog.deleted_at.desc()).all()
    return [_serialize(r) for r in records]


@router.delete("/{company_id}/{log_id}")
def purge_delete_log(
    company_id: uuid.UUID,
    log_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Permanently purge a single delete-log entry. Owner only: a log any
    team member could wipe would not show who deleted what."""
    membership = get_company_membership(db, current_user, company_id)
    if not is_owner_equivalent(db, membership):
        raise HTTPException(status_code=403, detail="Only the company owner can remove entries from the delete log.")
    log = (
        db.query(DeleteLog)
        .filter(DeleteLog.id == log_id, DeleteLog.company_id == company_id)
        .first()
    )
    if not log:
        raise HTTPException(status_code=404, detail="Delete log not found.")
    db.delete(log)
    db.commit()
    return {"message": "Delete log purged successfully.", "id": str(log.id)}
