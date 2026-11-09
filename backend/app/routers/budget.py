from uuid import UUID
from datetime import date, datetime, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import func
from app import payroll_scope
from app.database import get_db
from app.auth import get_current_user, verify_project_access
from app.models import (
    PurchaseOrder, Bill, WorkOrder, WorkOrderItem,
    ProjectTower, ProjectBudget, PayrollRun, PayrollLineItem,
    Equipment, EquipmentDeployment, FuelLog, MaterialWastage
)
from pydantic import BaseModel
from app.bill_scope import _active_bills
from app.constants import EXPENSE_INVOICE_TYPES
from app.equipment_cost import owned_deployment_cost

router = APIRouter(
    prefix="/budget",
    tags=["Budget & Committed Cost Tracking"],
    dependencies=[Depends(get_current_user)]
)


class CommittedCostItem(BaseModel):
    category: str
    committed_amount: float
    billed_amount: float
    actual_invoiced: float
    variance: float

    class Config:
        from_attributes = True


class BudgetWithCommitted(BaseModel):
    project_id: UUID
    material_budget: float
    labour_budget: float
    subcon_budget: float
    equipment_budget: float
    material_committed: float
    material_actual: float
    labour_committed: float
    labour_actual: float
    subcon_committed: float
    subcon_actual: float
    equipment_committed: float
    equipment_actual: float
    other_actual: float = 0.0
    total_budget: float
    total_committed: float
    total_actual: float
    total_committed_variance: float
    total_variance: float


class TowerBudgetBreakdown(BaseModel):
    tower_id: Optional[UUID]
    tower_name: str
    budget: float
    committed: float
    actual: float
    variance: float


@router.get("/committed/{project_id}", response_model=BudgetWithCommitted)
def get_committed_costs(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    # A missing budget row is reported as zeros in memory; a read must never
    # persist anything (R2-152).
    budget = db.query(ProjectBudget).filter(ProjectBudget.project_id == project_id).first()
    if not budget:
        budget = ProjectBudget(
            project_id=project_id,
            material_budget=0.0,
            labour_budget=0.0,
            subcon_budget=0.0,
            equipment_budget=0.0,
        )

    pos = db.query(PurchaseOrder).filter(
        PurchaseOrder.project_id == project_id,
        PurchaseOrder.status.in_(("sent", "partial", "received")),
    ).all()
    material_committed = sum(p.value_before_gst for p in pos)

    # Only approved, non-cancelled bills are actual spend (R2-233): an
    # unapproved bill must not book cost the moment it is typed.
    bills_expense = _active_bills(db, project_id, EXPENSE_INVOICE_TYPES).filter(
        Bill.approval_flag == "approved",
    ).all()
    material_actual = 0.0
    subcon_actual = 0.0
    equipment_bill_total = 0.0
    other_actual = 0.0
    for b in bills_expense:
        # Work value: before GST and before TDS/retention (still cost).
        amount = float(b.subtotal or 0.0)
        if b.invoice_type == "purchase":
            material_actual += amount
        elif b.invoice_type == "subcon":
            subcon_actual += amount
        elif b.invoice_type == "equipment":
            equipment_bill_total += amount
        else:
            other_actual += amount

    wastage_actual = float(
        db.query(func.sum(MaterialWastage.estimated_value)).filter(
            MaterialWastage.project_id == project_id
        ).scalar() or 0.0
    )
    material_actual += wastage_actual

    wos = db.query(WorkOrder).filter(
        WorkOrder.project_id == project_id,
        WorkOrder.status != "cancelled",
    ).all()
    subcon_committed = sum(float(w.estimated_work_amount) for w in wos)

    labour_committed = 0.0
    # C2: only finalized payroll runs contribute to actual labour cost
    labour_actual = float(
        # Cost to the company: gross pay plus employer PF and ESI. Net pay
        # left out the employee PF, ESI and TDS the company still pays over.
        payroll_scope.for_project(
            db.query(func.sum(PayrollLineItem.gross_salary + PayrollLineItem.pf_employer + PayrollLineItem.esi_employer))
            .join(PayrollRun)
            .filter(PayrollRun.status == "finalized"),
            project_id,
        )
        .scalar()
        or 0.0
    )

    equipment_committed = 0.0
    dep_cost = owned_deployment_cost(db, project_id)
    fuel_cost = float(db.query(func.sum(FuelLog.total_cost)).filter(FuelLog.project_id == project_id).scalar() or 0.0)
    equipment_actual = equipment_bill_total + dep_cost + fuel_cost

    total_budget = (
        float(budget.material_budget) +
        float(budget.labour_budget) +
        float(budget.subcon_budget) +
        float(budget.equipment_budget)
    )
    total_committed = material_committed + labour_committed + subcon_committed + equipment_committed
    total_actual = material_actual + labour_actual + subcon_actual + equipment_actual + other_actual

    return BudgetWithCommitted(
        project_id=project_id,
        material_budget=float(budget.material_budget),
        labour_budget=float(budget.labour_budget),
        subcon_budget=float(budget.subcon_budget),
        equipment_budget=float(budget.equipment_budget),
        material_committed=material_committed,
        material_actual=material_actual,
        labour_committed=labour_committed,
        labour_actual=labour_actual,
        subcon_committed=subcon_committed,
        subcon_actual=subcon_actual,
        equipment_committed=equipment_committed,
        equipment_actual=equipment_actual,
        other_actual=other_actual,
        total_budget=total_budget,
        total_committed=total_committed,
        total_actual=total_actual,
        total_committed_variance=total_budget - total_committed,
        total_variance=total_budget - total_actual,
    )


@router.get("/committed/{project_id}/towers", response_model=List[TowerBudgetBreakdown])
def get_tower_budget(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    # Documents carry no tower_id (CD-5), so per-tower attribution does not
    # exist: repeating the project's committed/actual on every tower row
    # multiplied spend by the tower count (R2-248). One honest project-wide
    # row until the column exists (R2-374). Its figures are the main
    # endpoint's totals: this row used to count POs only as committed (no
    # work orders) and bills only as actual (no payroll, wastage, fuel or
    # owned equipment), so it disagreed with the totals on the same page.
    totals = get_committed_costs(project_id, db, None)
    budget = db.query(ProjectBudget).filter(ProjectBudget.project_id == project_id).first()
    if budget:
        total_budget = totals.total_budget
    else:
        towers = db.query(ProjectTower).filter(ProjectTower.project_id == project_id).all()
        total_budget = sum(float(t.budget or 0) for t in towers)
    return [TowerBudgetBreakdown(
        tower_id=None,
        tower_name="Overall Project",
        budget=total_budget,
        committed=totals.total_committed,
        actual=totals.total_actual,
        variance=total_budget - totals.total_actual,
    )]
