import csv
import io
import uuid
from datetime import datetime, timedelta
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Response
from sqlalchemy import func
from sqlalchemy.orm import Session
from app.database import get_db
from app.auth import get_current_user, verify_project_access, get_company_membership, require_any_permission, require_module_view, scope_projects
from app.models import DailyProgressReport, Task, BOQItem, WarehouseInventory, MaterialTransaction, Project, User
from app.workflow_controls import enforce_entry_creation_window, enforce_entry_editing_window, enforce_stock_availability, get_company
from app.inventory_reservation import release_reservation, rereserve_reservation
from app.routers.delete_logs import log_deletion
from pydantic import BaseModel, Field
from app.csv_export import csv_safe_cell as _csv_safe_cell, CSV_FORMULA_PREFIXES as _CSV_FORMULA_PREFIXES, csv_attachment, money, qty, file_slug

router = APIRouter(
    prefix="/dpr",
    tags=["Daily Progress Reports (DPR)"],
    dependencies=[Depends(get_current_user)]
)


def _sync_task_progress(db: Session, task_id) -> None:
    """A task's physical progress follows the quantity reported in its daily
    reports when it is linked to a BOQ line with a quantity: reported to date /
    BOQ quantity. Reports used to leave progress at 0, so BOQ physical progress
    and the dashboards never moved however much work was logged."""
    if task_id is None:
        return
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task or not task.boq_item_id:
        return
    item = db.query(BOQItem).filter(BOQItem.id == task.boq_item_id).first()
    qty = float(item.quantity or 0) if item else 0.0
    if qty <= 0:
        return
    done = float(
        db.query(func.coalesce(func.sum(DailyProgressReport.executed_qty), 0))
        .filter(DailyProgressReport.task_id == task.id).scalar() or 0
    )
    task.progress = round(min(100.0, done * 100.0 / qty), 2)
    if task.progress >= 100.0:
        task.status = "completed"
    elif done > 0 and task.status == "not_started":
        task.status = "in_progress"
    db.add(task)


class MaterialConsumptionSchema(BaseModel):
    material_name: str
    quantity: float = Field(..., gt=0)
    unit: str

class DPRCreateRequest(BaseModel):
    project_id: uuid.UUID
    task_id: Optional[uuid.UUID] = None
    dpr_date: datetime
    weather: str = "Clear"
    executed_qty: float = Field(..., ge=0)
    workers_deployed: int = Field(0, ge=0)
    materials_consumed: List[MaterialConsumptionSchema] = []
    photos: List[str] = []
    notes: Optional[str] = None
    issues: Optional[str] = None

class DPRResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    task_id: Optional[uuid.UUID] = None
    reported_by: str
    dpr_date: datetime
    weather: str
    executed_qty: float
    workers_deployed: int
    materials_consumed: List[MaterialConsumptionSchema]
    photos: List[str]
    notes: Optional[str] = None
    issues: Optional[str] = None
    status: str
    created_at: datetime
    # Unit of the BOQ line behind the task, so "Qty executed: 46" can read
    # "46 cum". None when the task is not tied to a BOQ line.
    task_unit: Optional[str] = None

    class Config:
        from_attributes = True

@router.post("", response_model=DPRResponse, status_code=status.HTTP_201_CREATED)
def create_dpr(req: DPRCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project_uuid = uuid.UUID(str(req.project_id))
    project = db.query(Project).filter(Project.id == project_uuid).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    # A daily report is site progress: Planning edit (Supervisor, Site Engineer)
    # is enough, without the right to create or change projects.
    require_any_permission(db, current_user, project.company_id, "planning:edit", "projects:edit")

    # Workflow Controls: Entry Controls (creation date window)
    enforce_entry_creation_window(db, project.company_id, req.dpr_date)

    # R2-261: one report per activity per day, so the same day's work is not
    # counted twice. Each report carries one task, so the check is per task:
    # a site pouring a slab and laying blockwork on the same day files one
    # report for each. Keying it on the project alone left the second
    # activity of any day impossible to record.
    same_day = db.query(DailyProgressReport).filter(
        DailyProgressReport.project_id == project_uuid,
        func.date(DailyProgressReport.dpr_date) == req.dpr_date.date(),
    )
    same_day = same_day.filter(
        DailyProgressReport.task_id == req.task_id if req.task_id else DailyProgressReport.task_id.is_(None)
    )
    if same_day.first():
        raise HTTPException(
            status_code=409,
            detail="A Daily Progress Report already exists for this task on this date. Delete that report to file it again.",
        )

    task_uuid = None
    if req.task_id:
        task_uuid = uuid.UUID(str(req.task_id))
        # R2-599: the task must belong to the project this report is filed
        # against. Resolving it by id alone let a caller advance a task in any
        # project -- or any company -- whose id they knew, because the
        # permission check above authorises against `project`, not against the
        # task. Scoping the query to the project makes the cross-project write
        # unrepresentable: a foreign task id now selects no row at all.
        task = db.query(Task).filter(
            Task.id == task_uuid,
            Task.project_id == project_uuid,
        ).first()
        if not task:
            raise HTTPException(
                status_code=400,
                detail="Task not found in this project",
            )
        # Update task status on progress update
        if task.status == "not_started":
            task.status = "in_progress"
            db.add(task)

    # Convert Pydantic schemas to dict list for JSONB column
    materials_list = [mat.dict() for mat in req.materials_consumed]

    # Workflow Controls: Material Controls (R2-380). The daily report consumes
    # stock just like manual usage, so negative_stock_lock is enforced here
    # too, checked for every consumed material BEFORE any row is written. A
    # material with no inventory row has nothing available at all, so the lock
    # also stops inventing stock as a brand-new row at a negative quantity.
    company = get_company(db, project.company_id)
    if company and company.negative_stock_lock:
        for mat in req.materials_consumed:
            enforce_stock_availability(
                db, project_uuid, mat.material_name, mat.quantity, "Restrict Material Usage"
            )

    dpr = DailyProgressReport(
        id=uuid.uuid4(),
        project_id=project_uuid,
        task_id=task_uuid,
        # R2-408: the author of record is the authenticated user, resolved
        # server-side. reported_by used to be client free text stored
        # verbatim, so a raw UUID or an arbitrary string became the author
        # of the primary contemporaneous site record.
        reported_by=current_user.name,
        dpr_date=req.dpr_date,
        weather=req.weather,
        executed_qty=req.executed_qty,
        workers_deployed=req.workers_deployed,
        materials_consumed=materials_list,
        photos=req.photos,
        notes=req.notes,
        issues=req.issues,
        status="submitted"
    )
    db.add(dpr)
    db.flush()
    _sync_task_progress(db, dpr.task_id)

    # Process material consumption state updates
    saved_materials = []
    for mat in req.materials_consumed:
        inv = db.query(WarehouseInventory).filter(
            WarehouseInventory.project_id == project_uuid,
            WarehouseInventory.material_name == mat.material_name
        ).first()

        if inv:
            inv.on_hand_qty = float(inv.on_hand_qty) - mat.quantity
            db.add(inv)
        else:
            # Create a warehouse row even if it has negative balance (allow workflow flexibility)
            new_inv = WarehouseInventory(
                id=uuid.uuid4(),
                project_id=project_uuid,
                material_name=mat.material_name,
                on_hand_qty=-mat.quantity,
                reserved_qty=0.0,
                unit=mat.unit
            )
            db.add(new_inv)

        released_qty = release_reservation(db, project_uuid, mat.material_name, mat.quantity)

        # Log to material transactions ledger
        txn = MaterialTransaction(
            id=uuid.uuid4(),
            project_id=project_uuid,
            material_name=mat.material_name,
            qty=mat.quantity,
            type="used",
            source_ref_id=dpr.id,
            created_at=dpr.dpr_date,
        )
        db.add(txn)

        mat_dict = mat.dict() if hasattr(mat, "dict") else dict(mat)
        mat_dict["reserved_released"] = released_qty
        saved_materials.append(mat_dict)

    dpr.materials_consumed = saved_materials
    db.add(dpr)

    db.commit()
    db.refresh(dpr)
    return dpr

def resolve_dpr_authors(db: Session, reports: List[DailyProgressReport]) -> dict[str, str]:
    """Resolve raw reported_by strings (names or legacy UUIDs) to display names in a batch."""
    author_uuids = set()
    raw_keys = set()
    for d in reports:
        val = d.reported_by if isinstance(d, DailyProgressReport) else str(d)
        if not val:
            continue
        raw_keys.add(val)
        try:
            author_uuids.add(uuid.UUID(val))
        except (ValueError, AttributeError):
            pass

    users_by_id = {}
    if author_uuids:
        users = db.query(User).filter(User.id.in_(author_uuids)).all()
        for u in users:
            if u.name:
                users_by_id[str(u.id)] = u.name

    mapping = {}
    for k in raw_keys:
        try:
            u_id_str = str(uuid.UUID(str(k)))
            mapping[k] = users_by_id.get(u_id_str, "Unknown")
        except (ValueError, AttributeError):
            mapping[k] = str(k)
    return mapping


@router.get("", response_model=List[DPRResponse])
def get_dprs(project_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    project_uuid = uuid.UUID(str(project_id))
    dprs = db.query(DailyProgressReport).filter(
        DailyProgressReport.project_id == project_uuid
    ).order_by(DailyProgressReport.dpr_date.desc()).all()
    author_map = resolve_dpr_authors(db, dprs)
    task_ids = {d.task_id for d in dprs if d.task_id}
    unit_by_task = {}
    if task_ids:
        rows = (
            db.query(Task.id, BOQItem.unit)
            .join(BOQItem, BOQItem.id == Task.boq_item_id)
            .filter(Task.id.in_(task_ids))
            .all()
        )
        unit_by_task = {tid: unit for tid, unit in rows}
    result = []
    for d in dprs:
        result.append(
            DPRResponse(
                id=d.id,
                project_id=d.project_id,
                task_id=d.task_id,
                task_unit=unit_by_task.get(d.task_id),
                reported_by=author_map.get(d.reported_by, d.reported_by or "Unknown"),
                dpr_date=d.dpr_date,
                weather=d.weather,
                executed_qty=float(d.executed_qty or 0),
                workers_deployed=d.workers_deployed or 0,
                materials_consumed=d.materials_consumed or [],
                photos=d.photos or [],
                notes=d.notes,
                issues=d.issues,
                status=d.status,
                created_at=d.created_at,
            )
        )
    return result

@router.get("/summary")
def get_dpr_summary(project_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    project_uuid = uuid.UUID(str(project_id))
    dprs = db.query(DailyProgressReport).filter(DailyProgressReport.project_id == project_uuid).all()
    author_map = resolve_dpr_authors(db, dprs)
    
    total_workers = sum(d.workers_deployed for d in dprs)
    activities_count = len(dprs)
    flagged_issues = [
        {"date": d.dpr_date.isoformat() if hasattr(d.dpr_date, 'isoformat') else str(d.dpr_date), "reporter": author_map.get(d.reported_by, d.reported_by or "Unknown"), "issue": d.issues}
        for d in dprs if d.issues and d.issues.strip()
    ]
    
    # Average completion from the maintained per-task progress field
    tasks = db.query(Task).filter(Task.project_id == project_uuid).all()
    avg_completion = (sum(float(t.progress or 0) for t in tasks) / len(tasks)) if tasks else 0

    # R2-444 / C6: the dashboard's material tiles must answer from the same stock
    # ledger this project writes to. DPR consumption keys on func.date(dpr_date)
    # matching the feed so backdated or scheduled DPRs align with their day.
    today_date = datetime.utcnow().date()
    used_today = float(
        db.query(func.sum(MaterialTransaction.qty))
        .outerjoin(DailyProgressReport, MaterialTransaction.source_ref_id == DailyProgressReport.id)
        .filter(
            MaterialTransaction.project_id == project_uuid,
            MaterialTransaction.type == "used",
            func.date(func.coalesce(DailyProgressReport.dpr_date, MaterialTransaction.created_at)) == today_date,
        )
        .scalar() or 0.0
    )
    received_today = float(
        db.query(func.sum(MaterialTransaction.qty))
        .filter(
            MaterialTransaction.project_id == project_uuid,
            MaterialTransaction.type == "received",
            func.date(MaterialTransaction.created_at) == today_date,
        )
        .scalar() or 0.0
    )

    # The quantity sums above add bags to tonnes; the tiles show how many
    # different materials moved instead, which means something.
    used_materials_today = (
        db.query(func.count(func.distinct(MaterialTransaction.material_name)))
        .outerjoin(DailyProgressReport, MaterialTransaction.source_ref_id == DailyProgressReport.id)
        .filter(
            MaterialTransaction.project_id == project_uuid,
            MaterialTransaction.type == "used",
            func.date(func.coalesce(DailyProgressReport.dpr_date, MaterialTransaction.created_at)) == today_date,
        )
        .scalar() or 0
    )
    received_materials_today = (
        db.query(func.count(func.distinct(MaterialTransaction.material_name)))
        .filter(
            MaterialTransaction.project_id == project_uuid,
            MaterialTransaction.type == "received",
            func.date(MaterialTransaction.created_at) == today_date,
        )
        .scalar() or 0
    )

    return {
        "materials_received_today": int(received_materials_today),
        "materials_used_today": int(used_materials_today),
        "activities_tracked": activities_count,
        "total_workers_deployed": total_workers,
        "avg_completion": round(avg_completion, 1),
        "issues_flagged": len(flagged_issues),
        "flagged_issues_list": flagged_issues,
        "material_received_today": received_today,
        "material_used_today": round(used_today, 2),
    }

@router.get("/export")
def export_dpr_csv(
    project_id: Optional[uuid.UUID] = None,
    company_id: Optional[uuid.UUID] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Export DPR entries as a CSV attachment (company-wide or per-project, optional date range).

    Tenant-guarded: resolves the owning company from project_id or company_id, then enforces
    membership + the projects module view permission. Read-only.
    """
    if project_id:
        project = db.query(Project).filter(Project.id == project_id).first()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        cid = project.company_id
    elif company_id:
        cid = company_id
    else:
        raise HTTPException(status_code=400, detail="Provide project_id or company_id")

    get_company_membership(db, current_user, cid)
    require_module_view(db, current_user, cid, "projects")

    query = db.query(DailyProgressReport)
    if project_id:
        query = query.filter(DailyProgressReport.project_id == project_id)
    else:
        proj_ids = scope_projects(db.query(Project.id).filter(Project.company_id == cid), db, current_user, cid).subquery()
        query = query.filter(DailyProgressReport.project_id.in_(proj_ids))

    if from_date:
        try:
            fd = datetime.strptime(from_date, "%Y-%m-%d")
            query = query.filter(DailyProgressReport.dpr_date >= fd)
        except ValueError:
            raise HTTPException(status_code=400, detail="from_date must be YYYY-MM-DD")
    if to_date:
        try:
            td = datetime.strptime(to_date, "%Y-%m-%d") + timedelta(days=1)
            query = query.filter(DailyProgressReport.dpr_date < td)
        except ValueError:
            raise HTTPException(status_code=400, detail="to_date must be YYYY-MM-DD")

    reports = query.order_by(DailyProgressReport.dpr_date.desc()).all()

    columns = [
        "Date", "Project", "Author", "Executed Qty", "Work Done",
        "Labour Count", "Materials", "Remarks", "Status",
    ]

    p_ids = list({d.project_id for d in reports if d.project_id})
    projs_by_id = {p.id: p for p in db.query(Project).filter(Project.id.in_(p_ids)).all()} if p_ids else {}
    author_map = resolve_dpr_authors(db, reports)

    rows = []
    for d in reports:
        project = projs_by_id.get(d.project_id)
        mats = d.materials_consumed or []
        mat_str = "; ".join(
            f"{m.get('material_name')} {qty(m.get('quantity'))} {m.get('unit') or ''}".strip()
            for m in mats
        )
        author = author_map.get(d.reported_by, d.reported_by or "Unknown")
        rows.append([
            d.dpr_date.strftime("%Y-%m-%d") if d.dpr_date else "",
            project.name if project else "",
            author,
            qty(d.executed_qty),
            d.notes or "",
            d.workers_deployed or 0,
            mat_str,
            d.issues or "",
            (d.status or "").replace("_", " ").title(),
        ])
    if project_id:
        only = projs_by_id.get(project_id) or db.query(Project).filter(Project.id == project_id).first()
        scope = file_slug(getattr(only, "code", None) or getattr(only, "name", None) or "project")
    else:
        scope = "all-projects"
    filename = f"dpr-{scope}-{datetime.utcnow().strftime('%Y-%m-%d')}.csv"
    return csv_attachment(columns, rows, filename)


@router.delete("/{dpr_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dpr(dpr_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """R2-760: Void / delete a DPR entry, reverting any inventory and logging deletion audit."""
    dpr = db.query(DailyProgressReport).filter(DailyProgressReport.id == dpr_id).first()
    if not dpr:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="DPR not found")
    project = db.query(Project).filter(Project.id == dpr.project_id).first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    # A daily report is site progress: Planning edit (Supervisor, Site Engineer)
    # is enough, without the right to create or change projects.
    require_any_permission(db, current_user, project.company_id, "planning:edit", "projects:edit")
    enforce_entry_editing_window(db, project.company_id, dpr.dpr_date)

    if dpr.materials_consumed:
        for mat in dpr.materials_consumed:
            if isinstance(mat, dict):
                qty = float(mat.get("quantity", 0))
                name = mat.get("material_name")
                reserved_released = float(mat.get("reserved_released", 0))
                if qty > 0 and name:
                    inv = db.query(WarehouseInventory).filter(
                        WarehouseInventory.project_id == dpr.project_id,
                        WarehouseInventory.material_name == name
                    ).first()
                    if inv:
                        inv.on_hand_qty = float(inv.on_hand_qty) + qty
                        db.add(inv)
                    if reserved_released > 0:
                        rereserve_reservation(db, dpr.project_id, name, reserved_released)
    db.query(MaterialTransaction).filter(MaterialTransaction.source_ref_id == dpr.id).delete()

    log_deletion(
        db,
        company_id=project.company_id,
        entity_type="dpr",
        entity_id=dpr.id,
        summary=f"DPR for date {dpr.dpr_date.date() if dpr.dpr_date else 'N/A'} reported by {dpr.reported_by}",
        deleted_by=current_user.name or current_user.email or "Unknown",
    )
    task_id = dpr.task_id
    db.delete(dpr)
    db.flush()
    _sync_task_progress(db, task_id)
    db.commit()

