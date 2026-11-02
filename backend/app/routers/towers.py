from uuid import UUID
from datetime import datetime
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from app.database import get_db
from app.bill_scope import _active_bills
from app.constants import REVENUE_INVOICE_TYPES
from app.auth import get_current_user, verify_project_access, get_company_membership, require_permission
from app.models import ProjectTower, ProjectBudget, PurchaseOrder, Bill, WorkOrder, Project, User
from pydantic import BaseModel, Field

router = APIRouter(
    prefix="/towers",
    tags=["Multi-Tower / Phase Support"],
    dependencies=[Depends(get_current_user)]
)


# --- Schemas ---
class ProjectTowerResponse(BaseModel):
    id: UUID
    project_id: UUID
    tower_name: str
    tower_code: str
    status: str
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    budget: float
    created_at: datetime

    class Config:
        from_attributes = True


class TowerCreateRequest(BaseModel):
    project_id: UUID
    tower_name: str = Field(..., example="Tower A")
    tower_code: str = Field(..., example="TA")
    status: str = "Ongoing"
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    budget: float = Field(0.0, ge=0)


class TowerUpdateRequest(BaseModel):
    tower_name: Optional[str] = None
    tower_code: Optional[str] = None
    status: Optional[str] = None
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    budget: Optional[float] = Field(None, ge=0)


class ConsolidatedPNLItem(BaseModel):
    tower_id: Optional[UUID] = None
    tower_name: str
    tower_code: str
    total_po_value: float
    total_billed: float
    total_wo_value: float
    budget: float
    variance: float


# --- Endpoints ---

@router.get("/{project_id}", response_model=List[ProjectTowerResponse])
def list_towers(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    towers = db.query(ProjectTower).filter(ProjectTower.project_id == project_id).all()
    return [
        ProjectTowerResponse(
            id=t.id,
            project_id=t.project_id,
            tower_name=t.tower_name,
            tower_code=t.tower_code,
            status=t.status,
            start_date=t.start_date,
            end_date=t.end_date,
            budget=float(t.budget),
            created_at=t.created_at,
        ) for t in towers
    ]


@router.post("/", response_model=ProjectTowerResponse, status_code=201)
def create_tower(req: TowerCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == req.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "projects:edit")
    tower = ProjectTower(
        project_id=req.project_id,
        tower_name=req.tower_name,
        tower_code=req.tower_code,
        status=req.status,
        start_date=req.start_date,
        end_date=req.end_date,
        budget=req.budget,
    )
    db.add(tower)
    db.commit()
    db.refresh(tower)
    return ProjectTowerResponse(
        id=tower.id,
        project_id=tower.project_id,
        tower_name=tower.tower_name,
        tower_code=tower.tower_code,
        status=tower.status,
        start_date=tower.start_date,
        end_date=tower.end_date,
        budget=float(tower.budget),
        created_at=tower.created_at,
    )


@router.patch("/{tower_id}", response_model=ProjectTowerResponse)
def update_tower(tower_id: UUID, req: TowerUpdateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    tower = db.query(ProjectTower).filter(ProjectTower.id == tower_id).first()
    if not tower:
        raise HTTPException(status_code=404, detail="Tower not found")
    project = db.query(Project).filter(Project.id == tower.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "projects:edit")

    update_data = req.model_dump(exclude_unset=True)
    for field, val in update_data.items():
        setattr(tower, field, val)

    db.commit()
    db.refresh(tower)
    return ProjectTowerResponse(
        id=tower.id,
        project_id=tower.project_id,
        tower_name=tower.tower_name,
        tower_code=tower.tower_code,
        status=tower.status,
        start_date=tower.start_date,
        end_date=tower.end_date,
        budget=float(tower.budget),
        created_at=tower.created_at,
    )


@router.delete("/{tower_id}", status_code=204)
def delete_tower(tower_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    tower = db.query(ProjectTower).filter(ProjectTower.id == tower_id).first()
    if not tower:
        raise HTTPException(status_code=404, detail="Tower not found")
    proj = db.query(Project).filter(Project.id == tower.project_id).first()
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, proj.company_id)
    require_permission(db, current_user, proj.company_id, "data:delete")
    from app.routers.delete_logs import log_deletion
    company_id = proj.company_id if proj else None
    log_deletion(db, company_id, "tower", tower.id, f"Tower: {tower.tower_name}", deleted_by=current_user.name)
    db.delete(tower)
    db.commit()
    return None


@router.get("/{project_id}/consolidated-pnl", response_model=List[ConsolidatedPNLItem])
def consolidated_pnl(project_id: UUID, tower_id: Optional[UUID] = Query(None), db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    towers = db.query(ProjectTower).filter(ProjectTower.project_id == project_id).all()

    if not towers:
        budget = db.query(ProjectBudget).filter(ProjectBudget.project_id == project_id).first()
        if budget:
            total_budget = float(budget.subcon_budget) + float(budget.material_budget) + float(budget.labour_budget) + float(budget.equipment_budget)
            pos_value = db.query(PurchaseOrder).filter(PurchaseOrder.project_id == project_id).all()
            total_po_value = sum(p.value_before_gst for p in pos_value)
            # Active bills only: a cancelled bill must not book revenue (R2-723).
            bills = _active_bills(db, project_id, REVENUE_INVOICE_TYPES).all()
            total_billed = sum(float(b.subtotal) for b in bills)
            wos = db.query(WorkOrder).filter(WorkOrder.project_id == project_id).all()
            total_wo_value = sum(float(w.estimated_work_amount) for w in wos)
            return [ConsolidatedPNLItem(
                tower_id=None,
                tower_name="Overall Project",
                tower_code="ALL",
                total_po_value=total_po_value,
                total_billed=total_billed,
                total_wo_value=total_wo_value,
                budget=total_budget,
                variance=total_budget - total_billed,
            )]
        return []

    pos_value = db.query(PurchaseOrder).filter(PurchaseOrder.project_id == project_id).all()
    total_po_value = sum(p.value_before_gst for p in pos_value)
    # Active bills only: a cancelled bill must not book revenue (R2-723).
    bills = _active_bills(db, project_id, REVENUE_INVOICE_TYPES).all()
    total_billed = sum(float(b.subtotal) for b in bills)
    wos = db.query(WorkOrder).filter(WorkOrder.project_id == project_id).all()
    total_wo_value = sum(float(w.estimated_work_amount) for w in wos)

    # No document carries a tower_id (CD-5), so per-tower attribution does not
    # exist: stamping the whole project on every tower row multiplied spend by
    # the tower count (R2-228/R2-248). One honest project-wide row until the
    # column exists (R2-374), reconciled against the project's own budget -
    # the construction the no-towers branch already uses.
    budget_row = db.query(ProjectBudget).filter(ProjectBudget.project_id == project_id).first()
    if budget_row:
        total_budget = float(budget_row.subcon_budget) + float(budget_row.material_budget) + float(budget_row.labour_budget) + float(budget_row.equipment_budget)
    else:
        total_budget = sum(float(t.budget) for t in towers)
    return [ConsolidatedPNLItem(
        tower_id=None,
        tower_name="Overall Project",
        tower_code="ALL",
        total_po_value=total_po_value,
        total_billed=total_billed,
        total_wo_value=total_wo_value,
        budget=total_budget,
        variance=total_budget - total_billed,
    )]
