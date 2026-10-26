import calendar

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import datetime, timedelta, timezone
from typing import List, Optional
from app.database import get_db
from app import models
from app.auth import get_current_user, verify_project_in_company, verify_company_access, get_company_membership, require_permission
import uuid

router = APIRouter(prefix="/todos", tags=["Todos"], dependencies=[Depends(get_current_user)])


def _parse_dt(value: Optional[str]):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    candidate = str(value).strip()
    if not candidate:
        return None
    normalized = candidate.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(candidate, fmt)
        except ValueError:
            continue
    return None


def _safe_url(value: Optional[str]) -> Optional[str]:
    """R2-442: legacy rows may hold non-http(s) schemes (e.g. javascript:).

    Such payloads are never served, so no current or future renderer, export or
    notification can turn a stored value into a live link.
    """
    if value is None:
        return None
    if value.startswith("http://") or value.startswith("https://"):
        return value
    return None


def _serialize(db: Session, t: models.Todo):
    assignees = db.query(models.TodoAssignee).filter(models.TodoAssignee.todo_id == t.id).all()
    task_name = None
    if t.linked_task_id:
        task = db.query(models.Task).filter(models.Task.id == t.linked_task_id).first()
        task_name = task.name if task else None
    # A to-do is overdue the day after its due date, not from the first
    # minute of the due day (due dates are stored as midnight).
    is_overdue = (
        t.due_date is not None
        and t.status != "done"
        and t.due_date.date() < datetime.now(timezone.utc).date()
    )
    return {
        "id": str(t.id),
        "company_id": str(t.company_id),
        "project_id": str(t.project_id) if t.project_id else None,
        "created_by": str(t.created_by) if t.created_by else None,
        "title": t.title,
        "due_date": t.due_date.isoformat() if t.due_date else None,
        "is_overdue": is_overdue,
        "repeat_type": t.repeat_type,
        "type": t.type,
        "linked_task_id": str(t.linked_task_id) if t.linked_task_id else None,
        "task_name": task_name,
        "url": _safe_url(t.url),
        "status": t.status,
        "assignee_ids": [str(a.assignee_id) for a in assignees],
        "created_at": t.created_at.isoformat() if t.created_at else None,
    }


def _add_one_month(dt: datetime) -> datetime:
    year, month = (dt.year + 1, 1) if dt.month == 12 else (dt.year, dt.month + 1)
    last_day = calendar.monthrange(year, month)[1]
    return dt.replace(year=year, month=month, day=min(dt.day, last_day))


def _spawn_next_occurrence(db: Session, t: models.Todo) -> Optional[models.Todo]:
    """R2-383: recurring to-dos recur at completion time (no scheduler exists).

    Completing a daily/weekly/monthly to-do spawns the next pending occurrence
    with the due date advanced one interval past now.
    """
    if t.repeat_type not in ("daily", "weekly", "monthly"):
        return None
    now = datetime.now(timezone.utc)
    nxt = t.due_date if t.due_date is not None else now
    for _ in range(10000):
        if t.repeat_type == "daily":
            nxt = nxt + timedelta(days=1)
        elif t.repeat_type == "weekly":
            nxt = nxt + timedelta(weeks=1)
        else:
            nxt = _add_one_month(nxt)
        comparable = nxt if nxt.tzinfo is not None else nxt.replace(tzinfo=timezone.utc)
        if comparable > now:
            spawned = models.Todo(
                company_id=t.company_id,
                project_id=t.project_id,
                created_by=t.created_by,
                title=t.title,
                due_date=nxt,
                repeat_type=t.repeat_type,
                type=t.type,
                linked_task_id=t.linked_task_id,
                url=t.url,
                status="pending",
            )
            db.add(spawned)
            db.flush()
            for a in db.query(models.TodoAssignee).filter(models.TodoAssignee.todo_id == t.id).all():
                db.add(models.TodoAssignee(todo_id=spawned.id, assignee_id=a.assignee_id))
            return spawned
    return None


class TodoCreate(BaseModel):
    company_id: uuid.UUID
    project_id: Optional[uuid.UUID] = None
    title: str = Field(..., max_length=500)
    due_date: Optional[str] = None
    repeat_type: str = "none"
    type: Optional[str] = None
    linked_task_id: Optional[uuid.UUID] = None
    url: Optional[str] = None
    assignee_ids: List[uuid.UUID] = []

    @field_validator("url")
    @classmethod
    def url_http_only(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not (v.startswith("http://") or v.startswith("https://")):
            raise ValueError("url must start with http:// or https://")
        return v

    @field_validator("due_date")
    @classmethod
    def due_date_not_past(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        parsed = _parse_dt(v)
        if parsed is not None and parsed.date() < datetime.now(timezone.utc).date():
            raise ValueError("due_date cannot be in the past")
        return v


class TodoUpdate(BaseModel):
    title: Optional[str] = Field(None, max_length=500)
    due_date: Optional[str] = None
    repeat_type: Optional[str] = None
    type: Optional[str] = None
    linked_task_id: Optional[uuid.UUID] = None
    url: Optional[str] = None
    status: Optional[str] = None
    assignee_ids: Optional[List[uuid.UUID]] = None

    @field_validator("url")
    @classmethod
    def url_http_only(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not (v.startswith("http://") or v.startswith("https://")):
            raise ValueError("url must start with http:// or https://")
        return v

    @field_validator("due_date")
    @classmethod
    def due_date_not_past(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        parsed = _parse_dt(v)
        if parsed is not None and parsed.date() < datetime.now(timezone.utc).date():
            raise ValueError("due_date cannot be in the past")
        return v


@router.get("/company/{company_id}")
def list_todos(
    company_id: uuid.UUID,
    project_id: Optional[uuid.UUID] = None,
    status: Optional[str] = None,
    assignee_id: Optional[uuid.UUID] = None,
    db: Session = Depends(get_db),
    _: None = Depends(verify_company_access),
):
    q = db.query(models.Todo).filter(models.Todo.company_id == company_id)
    if project_id:
        q = q.filter(models.Todo.project_id == project_id)
    if status:
        q = q.filter(models.Todo.status == status)
    if assignee_id:
        q = q.join(models.TodoAssignee, models.TodoAssignee.todo_id == models.Todo.id).filter(
            models.TodoAssignee.assignee_id == assignee_id
        )
    todos = q.all()
    return [_serialize(db, t) for t in todos]


def _check_assignees(db: Session, company_id, assignee_ids) -> None:
    """Assignees must be members of the to-do's own company."""
    if not assignee_ids:
        return
    found = {
        r.id for r in db.query(models.CompanyTeam.id).filter(
            models.CompanyTeam.id.in_(assignee_ids), models.CompanyTeam.company_id == company_id
        ).all()
    }
    if len(found) != len(set(assignee_ids)):
        raise HTTPException(status_code=400, detail="Assignees must be members of this company")


@router.post("/")
def create_todo(payload: TodoCreate, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    membership = get_company_membership(db, current_user, payload.company_id)
    if payload.project_id:
        verify_project_in_company(db, payload.project_id, payload.company_id)
    require_permission(db, current_user, payload.company_id, "planning:edit")
    _check_assignees(db, payload.company_id, payload.assignee_ids)
    t = models.Todo(
        company_id=payload.company_id,
        project_id=payload.project_id,
        created_by=membership.id,
        title=payload.title,
        due_date=_parse_dt(payload.due_date),
        repeat_type=payload.repeat_type,
        type=payload.type,
        linked_task_id=payload.linked_task_id,
        url=payload.url,
        status="pending",
    )
    db.add(t)
    db.flush()
    for aid in payload.assignee_ids:
        db.add(models.TodoAssignee(todo_id=t.id, assignee_id=aid))
    db.commit()
    db.refresh(t)
    return _serialize(db, t)


@router.put("/{todo_id}")
def update_todo(todo_id: uuid.UUID, payload: TodoUpdate, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    t = db.query(models.Todo).filter(models.Todo.id == todo_id).first()
    if not t:
        raise HTTPException(status_code=404, detail="Todo not found")
    get_company_membership(db, current_user, t.company_id)
    require_permission(db, current_user, t.company_id, "planning:edit")
    prev_status = t.status
    if payload.title is not None:
        t.title = payload.title
    if payload.due_date is not None:
        t.due_date = _parse_dt(payload.due_date)
    if payload.repeat_type is not None:
        t.repeat_type = payload.repeat_type
    if payload.type is not None:
        t.type = payload.type
    if payload.linked_task_id is not None:
        t.linked_task_id = payload.linked_task_id
    # An explicit null clears the url (R2-442).
    if "url" in payload.model_fields_set:
        t.url = payload.url
    if payload.status is not None:
        t.status = payload.status
    if payload.assignee_ids is not None:
        _check_assignees(db, t.company_id, payload.assignee_ids)
        db.query(models.TodoAssignee).filter(models.TodoAssignee.todo_id == t.id).delete()
        for aid in payload.assignee_ids:
            db.add(models.TodoAssignee(todo_id=t.id, assignee_id=aid))
    if payload.status == "done" and prev_status != "done":
        _spawn_next_occurrence(db, t)
    db.commit()
    db.refresh(t)
    return _serialize(db, t)


@router.delete("/{todo_id}")
def delete_todo(todo_id: uuid.UUID, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    t = db.query(models.Todo).filter(models.Todo.id == todo_id).first()
    if not t:
        raise HTTPException(status_code=404, detail="Todo not found")
    get_company_membership(db, current_user, t.company_id)
    require_permission(db, current_user, t.company_id, "data:delete")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, t.company_id, "todo", t.id, f"Todo: {t.title}", deleted_by=current_user.name)
    db.delete(t)
    db.commit()
    return {"success": True}
