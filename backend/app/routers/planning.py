from uuid import UUID, uuid4
from datetime import datetime, timedelta, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, or_, and_
from sqlalchemy.orm import Session
from app.database import get_db
from app.auth import get_current_user, verify_company_access, verify_project_access, get_company_membership, require_permission
from app.models import Task, TaskPredecessor, ProjectMilestone, Project, TaskTodo, TaskComment, CompanyTeam, User, BOQItem
from app.constants import MILESTONE_TYPE_PATTERN, MILESTONE_STATUS_PATTERN, PREDECESSOR_LINK_TYPE_PATTERN, PROJECT_STATUS_PATTERN
from app.workflow_controls import (
    enforce_entry_creation_window,
    enforce_entry_editing_window,
    enforce_progress_over_estimate,
)
from pydantic import BaseModel, Field

router = APIRouter(
    prefix="/planning",
    tags=["Planning & Scheduler"],
    dependencies=[Depends(get_current_user)]
)

# Pydantic Schemas
class TaskResponse(BaseModel):
    id: UUID
    project_id: UUID
    parent_id: Optional[UUID] = None
    name: str
    duration_days: int
    start_date: datetime
    end_date: datetime
    status: str
    priority: str
    assigned_to: Optional[UUID] = None
    boq_item_id: Optional[UUID] = None
    progress: float = 0.0  # actual physical progress %, 0-100
    baseline_start: Optional[datetime] = None  # planned (baseline) start, snapshotted
    baseline_end: Optional[datetime] = None  # planned (baseline) end, snapshotted
    is_critical: bool = False  # derived via CPM critical-path (zero total float)

    class Config:
        from_attributes = True


class CompanyTaskResponse(TaskResponse):
    project_name: Optional[str] = None
    assigned_to_name: Optional[str] = None


class TaskTreeNode(TaskResponse):
    children: List["TaskTreeNode"] = Field(default_factory=list)

TaskTreeNode.model_rebuild()

class TaskCreateRequest(BaseModel):
    project_id: UUID
    parent_id: Optional[UUID] = None
    name: str
    duration_days: int = Field(..., ge=0)
    start_date: datetime
    status: str = "not_started"
    priority: str = "medium"
    assigned_to: Optional[UUID] = None
    boq_item_id: Optional[UUID] = None
    progress: float = Field(0.0, ge=0, le=100)

class TaskUpdateRequest(BaseModel):
    name: Optional[str] = None
    duration_days: Optional[int] = Field(None, ge=0)
    start_date: Optional[datetime] = None
    status: Optional[str] = None
    priority: Optional[str] = None
    assigned_to: Optional[UUID] = None
    progress: Optional[float] = Field(None, ge=0, le=100)

class PredecessorCreateRequest(BaseModel):
    predecessor_id: UUID
    type: str = Field("finish_to_start", pattern=PREDECESSOR_LINK_TYPE_PATTERN)

# ── Project Milestone schemas ────────────────────────────────────────────────
class MilestoneResponse(BaseModel):
    id: UUID
    project_id: UUID
    name: str
    milestone_date: datetime
    type: str
    status: str
    description: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True

class MilestoneCreateRequest(BaseModel):
    project_id: UUID
    name: str
    milestone_date: datetime
    type: str = Field("start", pattern=MILESTONE_TYPE_PATTERN)  # start | inspection | critical | payment | handover
    status: str = Field("upcoming", pattern=MILESTONE_STATUS_PATTERN)  # upcoming | achieved
    description: Optional[str] = None

class MilestoneUpdateRequest(BaseModel):
    name: Optional[str] = None
    milestone_date: Optional[datetime] = None
    type: Optional[str] = Field(None, pattern=MILESTONE_TYPE_PATTERN)
    status: Optional[str] = Field(None, pattern=MILESTONE_STATUS_PATTERN)
    description: Optional[str] = None

# ── Lookahead task schema ────────────────────────────────────────────────────
class LookaheadTaskResponse(BaseModel):
    id: UUID
    name: str
    start_date: datetime
    end_date: datetime
    status: str
    priority: str
    progress: float = 0.0
    is_critical: bool = False
    assigned_to_name: Optional[str] = None

    class Config:
        from_attributes = True


def compute_critical_task_ids(tasks, db: Session) -> set:
    """Derive the critical path (zero total float) for a project's task network.

    Uses a CPM backward pass over the finish-to-start predecessor graph. Dates are
    already scheduled by `propagate_schedule`, so ES/EF come from start/end_date and
    LF is propagated from the project's maximum end_date. A task is critical when its
    total float (LF - EF) is <= 0.
    """
    if not tasks:
        return set()
    task_ids = [t.id for t in tasks]
    end_by_id = {t.id: t.end_date for t in tasks}
    start_by_id = {t.id: t.start_date for t in tasks}
    dur_by_id = {t.id: max(1.0, float(t.duration_days or 0)) for t in tasks}
    project_end = max(end_by_id.values())

    links = db.query(TaskPredecessor).filter(TaskPredecessor.task_id.in_(task_ids)).all()
    succ: dict = {}
    for l in links:
        succ.setdefault(l.predecessor_id, []).append(l.task_id)

    lf_cache: dict = {}
    def latest_finish(tid):
        if tid in lf_cache:
            return lf_cache[tid]
        sc = succ.get(tid)
        if not sc:
            lf_cache[tid] = project_end
            return project_end
        value = min(latest_finish(s) - timedelta(days=dur_by_id.get(s, 1)) for s in sc)
        lf_cache[tid] = value
        return value

    critical = set()
    for t in tasks:
        if t.id not in succ and not any(l.predecessor_id == t.id for l in links):
            # Isolated task: critical only if it ends at the project finish.
            if abs((end_by_id[t.id] - project_end).total_seconds() / 86400.0) < 1e-9:
                critical.add(t.id)
            continue
        slack = (latest_finish(t.id) - end_by_id[t.id]).total_seconds() / 86400.0
        if slack <= 0:
            critical.add(t.id)
    return critical


def annotate_critical(tasks, db: Session):
    """Set the derived `is_critical` flag on each in-memory Task instance (grouped
    by project, since the critical path is per-project) so it serialises via the
    response schema. Does not persist anything."""
    by_project: dict = {}
    for t in tasks:
        by_project.setdefault(t.project_id, []).append(t)
    for proj_tasks in by_project.values():
        critical = compute_critical_task_ids(proj_tasks, db)
        for t in proj_tasks:
            t.is_critical = t.id in critical


# Helper function to check circular dependency
def check_circular_dependency(task_id: UUID, predecessor_id: UUID, db: Session) -> bool:
    # DFS search to see if predecessor_id transitively depends on task_id
    visited = set()
    to_visit = [predecessor_id]
    
    while to_visit:
        curr = to_visit.pop()
        if curr == task_id:
            return True
        if curr in visited:
            continue
        visited.add(curr)
        
        # Fetch all predecessors of curr (things curr depends on)
        links = db.query(TaskPredecessor).filter(TaskPredecessor.task_id == curr).all()
        for link in links:
            to_visit.append(link.predecessor_id)
            
    return False

# Recursive schedule propagation
def propagate_schedule(task_id: UUID, db: Session):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        return

    # Find tasks depending on this task (successors)
    links = db.query(TaskPredecessor).filter(TaskPredecessor.predecessor_id == task_id).all()
    for link in links:
        successor = db.query(Task).filter(Task.id == link.task_id).first()
        if not successor:
            continue

        # In finish-to-start, successor must start at or after the latest predecessor end_date
        pred_links = db.query(TaskPredecessor).filter(TaskPredecessor.task_id == successor.id).all()
        max_end_date = None
        for pl in pred_links:
            pred_task = db.query(Task).filter(Task.id == pl.predecessor_id).first()
            if pred_task:
                if max_end_date is None or pred_task.end_date > max_end_date:
                    max_end_date = pred_task.end_date

        if max_end_date and successor.start_date < max_end_date:
            duration = max(1, successor.duration_days)
            successor.start_date = max_end_date
            successor.end_date = successor.start_date + timedelta(days=duration - 1)
            db.add(successor)
            # Recurse
            propagate_schedule(successor.id, db)

@router.get("/tasks", response_model=List[TaskResponse])
def get_tasks(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    tasks = db.query(Task).filter(Task.project_id == project_id).all()
    annotate_critical(tasks, db)
    return tasks


@router.get("/tasks/hierarchy/{project_id}", response_model=List[TaskTreeNode])
def get_task_hierarchy(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    tasks = db.query(Task).filter(Task.project_id == project_id).all()
    annotate_critical(tasks, db)

    nodes = {
        t.id: TaskTreeNode(
            id=t.id,
            project_id=t.project_id,
            parent_id=t.parent_id,
            name=t.name,
            duration_days=t.duration_days,
            start_date=t.start_date,
            end_date=t.end_date,
            status=t.status,
            priority=t.priority,
            assigned_to=t.assigned_to,
            boq_item_id=t.boq_item_id,
            progress=float(t.progress or 0.0),
            baseline_start=t.baseline_start,
            baseline_end=t.baseline_end,
            is_critical=getattr(t, "is_critical", False),
            children=[],
        )
        for t in tasks
    }

    roots: List[TaskTreeNode] = []
    for t in tasks:
        node = nodes[t.id]
        if t.parent_id and t.parent_id in nodes:
            nodes[t.parent_id].children.append(node)
        else:
            roots.append(node)

    return roots


@router.get("/tasks/company/{company_id}", response_model=List[CompanyTaskResponse])
def get_company_tasks(company_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    """Cross-project rollup of every task in the company (Team Schedule Gantt)."""
    company = db.query(Project).filter(Project.company_id == company_id).first()
    if not company:
        raise HTTPException(status_code=404, detail="Company has no projects")

    tasks = (
        db.query(Task)
        .join(Project, Task.project_id == Project.id)
        .filter(Project.company_id == company_id)
        .all()
    )

    projects = db.query(Project).filter(Project.company_id == company_id).all()
    proj_by_id = {p.id: p for p in projects}

    annotate_critical(tasks, db)

    team_ids = [t.assigned_to for t in tasks if t.assigned_to]
    teams = db.query(CompanyTeam).filter(CompanyTeam.id.in_(team_ids)).all() if team_ids else []
    users = (
        db.query(User).filter(User.id.in_([t.user_id for t in teams if t.user_id])).all()
        if teams else []
    )
    users_by_id = {u.id: u for u in users}
    team_by_id = {t.id: t for t in teams}

    def resolve_name(tid: UUID) -> Optional[str]:
        team = team_by_id.get(tid)
        if not team:
            return None
        if team.user_id and team.user_id in users_by_id and users_by_id[team.user_id].name:
            return users_by_id[team.user_id].name
        return None

    out = []
    for t in tasks:
        d = TaskResponse.from_orm(t).dict()
        d["project_name"] = proj_by_id[t.project_id].name if t.project_id in proj_by_id else None
        d["assigned_to_name"] = resolve_name(t.assigned_to) if t.assigned_to else None
        out.append(CompanyTaskResponse(**d))
    return out


@router.get("/tasks/lookahead", response_model=List[LookaheadTaskResponse])
def get_lookahead(project_id: UUID, days: int = 14, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    """Rolling lookahead: tasks whose scheduled window overlaps the next `days` days,
    plus any not-yet-completed task that has already slipped past its end date.
    Derived from real tasks only (no new table)."""
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    window_start = datetime.now(timezone.utc)
    window_end = window_start + timedelta(days=days)

    tasks = (
        db.query(Task)
        .filter(Task.project_id == project_id)
        .filter(
            or_(
                # Scheduled work whose window overlaps the forward window.
                and_(Task.start_date <= window_end, Task.end_date >= window_start),
                # Open work that has already slipped past its planned end date:
                # a lookahead exists to surface slippage, so an incomplete task
                # stays visible until it is actually done (R2-458).
                and_(Task.end_date < window_start, Task.status != "completed"),
            )
        )
        .order_by(Task.start_date.asc())
        .all()
    )

    critical_ids = compute_critical_task_ids(tasks, db)

    assigned_ids = [t.assigned_to for t in tasks if t.assigned_to]
    teams = db.query(CompanyTeam).filter(CompanyTeam.id.in_(assigned_ids)).all() if assigned_ids else []
    users = (
        db.query(User).filter(User.id.in_([t.user_id for t in teams if t.user_id])).all()
        if teams else []
    )
    users_by_id = {u.id: u for u in users}
    team_by_id = {t.id: t for t in teams}

    def resolve_name(tid):
        team = team_by_id.get(tid)
        if not team:
            return None
        if team.user_id and team.user_id in users_by_id and users_by_id[team.user_id].name:
            return users_by_id[team.user_id].name
        return None

    out = []
    for t in tasks:
        d = LookaheadTaskResponse.from_orm(t).dict()
        d["is_critical"] = t.id in critical_ids
        d["assigned_to_name"] = resolve_name(t.assigned_to) if t.assigned_to else None
        out.append(LookaheadTaskResponse(**d))
    return out


def _snapshot_task_baseline(task: Task) -> None:
    """Helper to snapshot start/end dates into baseline fields for a task."""
    task.baseline_start = task.start_date
    task.baseline_end = task.end_date


@router.post("/tasks/{task_id}/set-baseline", response_model=TaskResponse)
def set_baseline(task_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Snapshot the task's current planned start/end into the baseline fields."""
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    project = db.query(Project).filter(Project.id == task.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "planning:edit")

    _snapshot_task_baseline(task)
    db.add(task)
    db.commit()
    db.refresh(task)
    annotate_critical(
        db.query(Task).filter(Task.project_id == task.project_id).all(), db
    )
    return task


@router.post("/projects/{project_id}/baseline")
def freeze_project_baseline(
    project_id: UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Snapshot planned start/end dates into baseline fields for every task in the project atomically."""
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "planning:edit")

    tasks = db.query(Task).filter(Task.project_id == project_id).all()
    for task in tasks:
        _snapshot_task_baseline(task)
        db.add(task)
    db.commit()

    if tasks:
        annotate_critical(tasks, db)

    return {
        "status": "success",
        "project_id": str(project_id),
        "tasks_updated": len(tasks),
        "message": f"Successfully froze baseline for {len(tasks)} tasks."
    }


@router.get("/milestones", response_model=List[MilestoneResponse])
def get_milestones(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return (
        db.query(ProjectMilestone)
        .filter(ProjectMilestone.project_id == project_id)
        .order_by(ProjectMilestone.milestone_date.asc())
        .all()
    )


@router.post("/milestones", response_model=MilestoneResponse, status_code=status.HTTP_201_CREATED)
def create_milestone(request: MilestoneCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == request.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "planning:edit")
    milestone = ProjectMilestone(
        project_id=request.project_id,
        name=request.name,
        milestone_date=request.milestone_date,
        type=request.type,
        status=request.status,
        description=request.description,
    )
    db.add(milestone)
    db.commit()
    db.refresh(milestone)
    return milestone


@router.put("/milestones/{milestone_id}", response_model=MilestoneResponse)
def update_milestone(milestone_id: UUID, request: MilestoneUpdateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    milestone = db.query(ProjectMilestone).filter(ProjectMilestone.id == milestone_id).first()
    if not milestone:
        raise HTTPException(status_code=404, detail="Milestone not found")
    project = db.query(Project).filter(Project.id == milestone.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "planning:edit")

    if request.name is not None:
        milestone.name = request.name
    if request.milestone_date is not None:
        milestone.milestone_date = request.milestone_date
    if request.type is not None:
        milestone.type = request.type
    if request.status is not None:
        milestone.status = request.status
    if request.description is not None:
        milestone.description = request.description

    db.add(milestone)
    db.commit()
    db.refresh(milestone)
    return milestone


@router.delete("/milestones/{milestone_id}")
def delete_milestone(milestone_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    milestone = db.query(ProjectMilestone).filter(ProjectMilestone.id == milestone_id).first()
    if not milestone:
        raise HTTPException(status_code=404, detail="Milestone not found")
    project = db.query(Project).filter(Project.id == milestone.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "planning:edit")
    db.delete(milestone)
    db.commit()
    return {"success": True, "message": "Milestone deleted successfully"}


@router.post("/tasks", response_model=TaskResponse, status_code=status.HTTP_201_CREATED)
def create_task(request: TaskCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == request.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "planning:edit")

    # Data-integrity: a parent task must belong to the same project as the new task.
    if request.parent_id is not None:
        parent = db.query(Task).filter(Task.id == request.parent_id).first()
        if parent and parent.project_id != request.project_id:
            raise HTTPException(status_code=400, detail="Parent task does not belong to the same project")

    # Workflow Controls: Entry Controls (creation date window) & Progress Controls
    enforce_entry_creation_window(db, project.company_id, request.start_date)
    enforce_progress_over_estimate(db, project.company_id, request.progress)

    # Auto-calculate end_date based on start_date and duration_days
    end_date = request.start_date + timedelta(days=request.duration_days - 1)
    if end_date < request.start_date:
        raise HTTPException(status_code=400, detail="Task duration must not end before it starts")

    task = Task(
        project_id=request.project_id,
        parent_id=request.parent_id,
        name=request.name,
        duration_days=request.duration_days,
        start_date=request.start_date,
        end_date=end_date,
        status=request.status,
        priority=request.priority,
        assigned_to=request.assigned_to,
        boq_item_id=request.boq_item_id,
        progress=request.progress,
        baseline_start=request.start_date,
        baseline_end=end_date,
    )

    db.add(task)
    db.commit()
    db.refresh(task)
    annotate_critical(
        db.query(Task).filter(Task.project_id == task.project_id).all(), db
    )
    return task

@router.put("/tasks/{task_id}", response_model=TaskResponse)
def update_task(task_id: UUID, request: TaskUpdateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Workflow Controls: Entry Controls (editing date window) & Progress Controls
    project = db.query(Project).filter(Project.id == task.project_id).first()
    # Fail closed: a task whose project can't be resolved (dangling FK) must not
    # silently bypass membership/permission/workflow checks.
    if not project:
        raise HTTPException(status_code=404, detail="Project not found for this task")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "planning:edit")
    enforce_progress_over_estimate(db, project.company_id, request.progress)

    old_status = task.status
    dates_changed = False

    if request.name is not None:
        task.name = request.name
    if request.status is not None:
        task.status = request.status
    if request.priority is not None:
        task.priority = request.priority
    if request.assigned_to is not None:
        task.assigned_to = request.assigned_to
    if request.progress is not None:
        task.progress = request.progress
        if request.status is None:
            if request.progress <= 0:
                task.status = "not_started"
            elif request.progress >= 100:
                task.status = "completed"
            else:
                task.status = "ongoing"
    elif request.status is not None:
        if request.status == "completed":
            task.progress = 100.0
        elif request.status == "not_started":
            task.progress = 0.0

    if task.status != old_status:
        # Auto-log status change activity to TaskComment (Onsite Parity 14.9.2)
        membership = get_company_membership(db, current_user, project.company_id)
        author_name = getattr(current_user, "name", None) or "System"
        status_log = TaskComment(
            id=uuid4(),
            task_id=task.id,
            user_id=membership.id,
            user_name=author_name,
            message_text=f"Status changed from {old_status} to {task.status}",
            created_at=datetime.now(timezone.utc),
        )
        db.add(status_log)

    # Handle duration or start date changes
    if request.start_date is not None or request.duration_days is not None:
        start_date = request.start_date if request.start_date is not None else task.start_date
        duration_days = request.duration_days if request.duration_days is not None else task.duration_days

        task.start_date = start_date
        task.duration_days = duration_days
        task.end_date = start_date + timedelta(days=duration_days - 1)
        if task.end_date < task.start_date:
            raise HTTPException(status_code=400, detail="Task duration must not end before it starts")
        dates_changed = True

    # Enforce the editing window against the EFFECTIVE start date that will be
    # saved (after any date change above), not the stale pre-update value. This
    # prevents a request that moves a task into an out-of-window date from
    # sailing through because the old date happened to be in-window.
    effective_start = task.start_date
    enforce_entry_editing_window(db, project.company_id, effective_start)

    db.add(task)
    db.commit()

    if dates_changed:
        # Propagate changes downstream to successors
        propagate_schedule(task_id, db)
        db.commit()

    db.refresh(task)
    annotate_critical(
        db.query(Task).filter(Task.project_id == task.project_id).all(), db
    )
    return task


@router.delete("/tasks/{task_id}")
def delete_task(task_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    project = db.query(Project).filter(Project.id == task.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found for this task")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "planning:edit")

    # delete predecessors/successors relations first if any
    db.query(TaskPredecessor).filter(
        (TaskPredecessor.task_id == task_id) | (TaskPredecessor.predecessor_id == task_id)
    ).delete(synchronize_session=False)

    from app.routers.delete_logs import log_deletion
    log_deletion(db, project.company_id, "task", task.id, f"Task: {task.name}", deleted_by=current_user.name)
    db.delete(task)
    db.commit()
    return {"success": True}


@router.post("/tasks/{task_id}/predecessors", status_code=status.HTTP_201_CREATED)
def add_predecessor(task_id: UUID, request: PredecessorCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    task = db.query(Task).filter(Task.id == task_id).first()
    predecessor = db.query(Task).filter(Task.id == request.predecessor_id).first()

    if not task or not predecessor:
        raise HTTPException(status_code=404, detail="Task or Predecessor not found")

    project = db.query(Project).filter(Project.id == task.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "planning:edit")

    pred_project = db.query(Project).filter(Project.id == predecessor.project_id).first()
    if not pred_project or pred_project.company_id != project.company_id:
        raise HTTPException(
            status_code=403,
            detail="Predecessor task belongs to another company",
        )

    if task_id == request.predecessor_id:
        raise HTTPException(status_code=400, detail="A task cannot be its own predecessor")

    # Check for circular dependency
    if check_circular_dependency(task_id, request.predecessor_id, db):
        raise HTTPException(
            status_code=400,
            detail="Circular dependency detected! This link would cause an infinite scheduling loop."
        )

    # Check if dependency already exists
    existing = db.query(TaskPredecessor).filter(
        TaskPredecessor.task_id == task_id,
        TaskPredecessor.predecessor_id == request.predecessor_id
    ).first()

    if not existing:
        link = TaskPredecessor(
            task_id=task_id,
            predecessor_id=request.predecessor_id,
            type=request.type
        )
        db.add(link)
        db.commit()

        # Propagate schedule change immediately to align the task sequence
        propagate_schedule(request.predecessor_id, db)
        db.commit()

    return {"success": True, "message": "Predecessor dependency added successfully"}


# ─────────────────────────────────────────────────────────────────────────────
# Competitor Parity Endpoints: Checklists & Activity Feed Comments
# ─────────────────────────────────────────────────────────────────────────────

class TodoCreate(BaseModel):
    title: str

class TodoResponse(BaseModel):
    id: UUID
    task_id: UUID
    title: str
    is_completed: bool
    created_at: datetime

    class Config:
        from_attributes = True

class CommentCreate(BaseModel):
    message_text: Optional[str] = None
    media_url: Optional[str] = None
    voice_note_url: Optional[str] = None
    progress_qty_added: Optional[float] = None

class CommentResponse(BaseModel):
    id: UUID
    task_id: UUID
    user_id: UUID
    user_name: str
    message_text: Optional[str]
    media_url: Optional[str]
    voice_note_url: Optional[str]
    progress_qty_added: Optional[float]
    created_at: datetime

    class Config:
        from_attributes = True


@router.get("/tasks/{task_id}/todos", response_model=List[TodoResponse])
def get_task_todos(task_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    project = db.query(Project).filter(Project.id == task.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    return db.query(TaskTodo).filter(TaskTodo.task_id == task_id).order_by(TaskTodo.created_at.asc()).all()


@router.post("/tasks/{task_id}/todos", response_model=TodoResponse, status_code=status.HTTP_201_CREATED)
def create_task_todo(task_id: UUID, payload: TodoCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    project = db.query(Project).filter(Project.id == task.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "planning:edit")
    todo = TaskTodo(task_id=task_id, title=payload.title, is_completed=False)
    db.add(todo)
    db.commit()
    db.refresh(todo)
    return todo


@router.patch("/tasks/todos/{todo_id}/toggle", response_model=TodoResponse)
def toggle_task_todo(todo_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    todo = db.query(TaskTodo).filter(TaskTodo.id == todo_id).first()
    if not todo:
        raise HTTPException(status_code=404, detail="Todo not found")
    task = db.query(Task).filter(Task.id == todo.task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    project = db.query(Project).filter(Project.id == task.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "planning:edit")
    todo.is_completed = not todo.is_completed
    db.commit()
    db.refresh(todo)
    return todo


@router.delete("/tasks/todos/{todo_id}")
def delete_task_todo(todo_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    todo = db.query(TaskTodo).filter(TaskTodo.id == todo_id).first()
    if not todo:
        raise HTTPException(status_code=404, detail="Todo not found")
    task = db.query(Task).filter(Task.id == todo.task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    proj = db.query(Project).filter(Project.id == task.project_id).first()
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, proj.company_id)
    require_permission(db, current_user, proj.company_id, "data:delete")
    from app.routers.delete_logs import log_deletion
    company_id = str(proj.company_id) if proj else None
    log_deletion(db, company_id, "task", todo.id, f"Task Todo: {todo.title}", deleted_by=current_user.name)
    db.delete(todo)
    db.commit()
    return {"success": True, "message": "Todo deleted successfully"}


@router.get("/tasks/{task_id}/comments", response_model=List[CommentResponse])
def get_task_comments(task_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    project = db.query(Project).filter(Project.id == task.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    return db.query(TaskComment).filter(TaskComment.task_id == task_id).order_by(TaskComment.created_at.asc()).all()


@router.post("/tasks/{task_id}/comments", response_model=CommentResponse, status_code=status.HTTP_201_CREATED)
def create_task_comment(task_id: UUID, payload: CommentCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    project = db.query(Project).filter(Project.id == task.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    membership = get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "planning:edit")

    # Actor fields are server-owned: the feed records who is actually
    # authenticated (the caller's company_team row and account name), never a
    # name or id supplied in the request body.
    comment = TaskComment(
        task_id=task_id,
        user_id=membership.id,
        user_name=current_user.name or "",
        message_text=payload.message_text,
        media_url=payload.media_url,
        voice_note_url=payload.voice_note_url,
        progress_qty_added=payload.progress_qty_added
    )
    db.add(comment)
    
    # Optional WBS physical progress update when a measured quantity is booked.
    # The measurement-book percentage is cumulative booked quantity against the
    # linked BOQ item's contracted quantity, so Log Progress moves Task.progress
    # (and completes the task at 100%) instead of leaving the quantity a
    # write-only chat line. Without a linked BOQ quantity there is no honest
    # denominator, so progress is left to the explicit PATCH path.
    if payload.progress_qty_added is not None and payload.progress_qty_added > 0:
        if task.status == "not_started":
            task.status = "ongoing"
            db.add(task)
        planned_qty = None
        if task.boq_item_id:
            boq_item = db.query(BOQItem).filter(BOQItem.id == task.boq_item_id).first()
            if boq_item is not None and boq_item.quantity is not None and float(boq_item.quantity) > 0:
                planned_qty = float(boq_item.quantity)
        if planned_qty:
            db.flush()
            measured_total = float(
                db.query(func.coalesce(func.sum(TaskComment.progress_qty_added), 0.0))
                .filter(
                    TaskComment.task_id == task_id,
                    TaskComment.progress_qty_added.isnot(None),
                )
                .scalar()
                or 0.0
            )
            new_progress = round(min(100.0, max(0.0, measured_total / planned_qty * 100.0)), 2)
            if float(task.progress or 0.0) != new_progress:
                task.progress = new_progress
            if new_progress >= 100.0 and task.status != "completed":
                task.status = "completed"
            db.add(task)
            
    db.commit()
    db.refresh(comment)
    return comment


# ─── Project Settings CRUD Endpoints ──────────────────────────────────────────

class ProjectCreateSchema(BaseModel):
    company_id: UUID
    name: str
    code: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    # Required for the same reason as on POST /projects/: place of supply for
    # every invoice raised against this project derives from the site state.
    # This route used to accept and drop it, which was a back door that produced
    # projects that could never be billed.
    state: Optional[str] = None
    location: Optional[str] = None
    attendance_radius_meters: Optional[int] = 500
    health: Optional[str] = "Good"
    category: Optional[str] = None
    stage: Optional[str] = None
    key_personnel_id: Optional[UUID] = None

class ProjectUpdateSchema(BaseModel):
    name: Optional[str] = None
    code: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    location: Optional[str] = None
    attendance_radius_meters: Optional[int] = None
    status: Optional[str] = Field(None, pattern=PROJECT_STATUS_PATTERN)
    health: Optional[str] = None
    category: Optional[str] = None
    stage: Optional[str] = None
    key_personnel_id: Optional[UUID] = None

class ProjectResponseSchema(BaseModel):
    id: UUID
    company_id: UUID
    name: str
    code: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    location: Optional[str] = None
    attendance_radius_meters: int
    status: str
    health: str
    category: Optional[str] = None
    stage: Optional[str] = None
    key_personnel_id: Optional[UUID] = None
    is_pinned: bool = False

    class Config:
        from_attributes = True

@router.get("/projects", response_model=List[ProjectResponseSchema])
def list_projects_v3(company_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    return db.query(Project).filter(Project.company_id == company_id).all()

@router.get("/projects/{project_id}", response_model=ProjectResponseSchema)
def get_project_v3(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    proj = db.query(Project).filter(Project.id == project_id).first()
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    return proj

def _require_own_team_member(db: Session, company_id, team_id) -> None:
    # key_personnel_id must name a member of the project's own company.
    if team_id is None:
        return
    from app.models import CompanyTeam
    if not db.query(CompanyTeam.id).filter(CompanyTeam.id == team_id, CompanyTeam.company_id == company_id).first():
        raise HTTPException(status_code=400, detail="Key personnel must be a member of this company.")


@router.post("/projects", response_model=ProjectResponseSchema, status_code=status.HTTP_201_CREATED)
def create_project_v3(payload: ProjectCreateSchema, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    import uuid
    get_company_membership(db, current_user, payload.company_id)
    require_permission(db, current_user, payload.company_id, "planning:edit")
    # Mirror the guard on POST /projects/ (projects.py). Without it this route
    # is a back door that creates projects which billing.py and crm.py will
    # later refuse to invoice, with no way to tell from this screen.
    if not payload.state or not str(payload.state).strip():
        raise HTTPException(
            status_code=422,
            detail="Project.state is required for invoicing - set the site state (GST state code or name); place of supply derives from the site per IGST Act s.12(3)",
        )
    try:
        from app.gst_utils import project_state_code as _psc
        if _psc(payload.state) is None:
            raise HTTPException(status_code=422, detail="Project.state must be a valid GST state code or name (e.g. 27, Maharashtra, KA)")
    except HTTPException:
        raise
    except Exception:
        pass
    proj = Project(
        id=uuid.uuid4(),
        company_id=payload.company_id,
        name=payload.name,
        code=payload.code,
        address=payload.address,
        city=payload.city,
        state=payload.state,
        # R2-750: no invented default. This used to fall back to a Mumbai
        # coordinate, so a Gujarat or Kerala site created through this route got
        # a geofence that was confidently wrong rather than absent -- worse than
        # no geofence, because every punch was then measured against the wrong
        # point and rejected (or, worse, accepted) for the wrong reason. A
        # project with no coordinates is now honest: punches are recorded as
        # not GPS-verified until someone sets them (PUT /projects/{id} accepts
        # `location`).
        location=payload.location,
        attendance_radius_meters=payload.attendance_radius_meters or 500,
        status="Ongoing",
        health=payload.health or "Good",
        category=payload.category,
        stage=payload.stage,
        key_personnel_id=payload.key_personnel_id
    )
    _require_own_team_member(db, payload.company_id, payload.key_personnel_id)
    db.add(proj)
    db.commit()
    db.refresh(proj)
    return proj

@router.patch("/projects/{project_id}", response_model=ProjectResponseSchema)
def update_project_v3(project_id: UUID, payload: ProjectUpdateSchema, db: Session = Depends(get_db), current_user: User = Depends(get_current_user), _: None = Depends(verify_project_access)):
    proj = db.query(Project).filter(Project.id == project_id).first()
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    require_permission(db, current_user, proj.company_id, "planning:edit")
    
    if payload.name is not None:
        proj.name = payload.name
    if payload.code is not None:
        proj.code = payload.code
    if payload.address is not None:
        proj.address = payload.address
    if payload.city is not None:
        proj.city = payload.city
    if payload.location is not None:
        proj.location = payload.location
    if payload.attendance_radius_meters is not None:
        proj.attendance_radius_meters = payload.attendance_radius_meters
    if payload.status is not None:
        proj.status = payload.status
    if payload.health is not None:
        proj.health = payload.health
    if payload.category is not None:
        proj.category = payload.category
    if payload.stage is not None:
        proj.stage = payload.stage
    if payload.key_personnel_id is not None:
        _require_own_team_member(db, proj.company_id, payload.key_personnel_id)
        proj.key_personnel_id = payload.key_personnel_id
        
    db.commit()
    db.refresh(proj)
    return proj


@router.delete("/projects/{project_id}")
def delete_project(project_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    proj = db.query(Project).filter(Project.id == project_id).first()
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, proj.company_id)
    require_permission(db, current_user, proj.company_id, "planning:edit")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, proj.company_id, "project", proj.id, f"Project: {proj.name}", deleted_by=current_user.name)
    db.delete(proj)
    db.commit()
    return {"success": True}

