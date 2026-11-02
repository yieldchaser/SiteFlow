# -*- coding: utf-8 -*-
"""
Phase 12 — Equipment & Machinery Tracking Router
"""

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field
from app.database import get_db
from app.auth import get_current_user, verify_company_access, verify_project_access, get_company_membership, require_permission
from app.models import Company, Equipment, EquipmentDeployment, FuelLog, MaintenanceSchedule, Project, User
from app.workflow_controls import enforce_entry_creation_window
from app.routers.delete_logs import log_deletion

router = APIRouter(prefix="/equipment", tags=["Equipment & Machinery Tracking"], dependencies=[Depends(get_current_user)])


def _as_aware(dt: datetime) -> datetime:
    """SQLite round-trips DateTime(timezone=True) columns naive; normalize to UTC."""
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ─── Schemas ─────────────────────────────────────────────────────────────────

class EquipmentCreate(BaseModel):
    company_id: uuid.UUID
    name: str
    code: str
    category: str
    ownership_type: str = Field(..., pattern="^(Owned|Hired)$")
    hourly_rate: float = Field(0.0, ge=0)


class EquipmentUpdate(BaseModel):
    name: Optional[str] = None
    code: Optional[str] = None
    category: Optional[str] = None
    ownership_type: Optional[str] = Field(None, pattern="^(Owned|Hired)$")
    status: Optional[str] = None
    hourly_rate: Optional[float] = Field(None, ge=0)


class EquipmentResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    name: str
    code: str
    category: str
    ownership_type: str
    status: str
    hourly_rate: float
    created_at: datetime

    class Config:
        from_attributes = True


class DeploymentCreate(BaseModel):
    project_id: uuid.UUID
    start_date: datetime
    hours_used: Optional[float] = Field(None, ge=0)
    start_meter: Optional[float] = Field(None, ge=0)
    remarks: Optional[str] = None


class DeploymentReturn(BaseModel):
    """Body for PATCH /deployments/{id}/return.

    This endpoint used to take no body at all, so the closing meter reading the
    UI collected was discarded and hours_used stayed 0 for every completed
    deployment. An asset with an hourly rate therefore never produced any cost.
    """
    end_date: Optional[datetime] = None
    end_meter: Optional[float] = Field(None, ge=0)
    hours_used: Optional[float] = Field(None, ge=0)
    remarks: Optional[str] = None


class DeploymentResponse(BaseModel):
    id: uuid.UUID
    equipment_id: uuid.UUID
    project_id: uuid.UUID
    start_date: datetime
    end_date: Optional[datetime]
    hours_used: Optional[float]
    start_meter: Optional[float] = None
    end_meter: Optional[float] = None
    remarks: Optional[str]

    class Config:
        from_attributes = True


class FuelLogCreate(BaseModel):
    project_id: uuid.UUID
    logged_date: datetime
    liters: float = Field(..., gt=0)
    cost_per_liter: float = Field(..., ge=0)
    odometer_hours: Optional[float] = Field(None, ge=0)
    remarks: Optional[str] = None


class FuelLogResponse(BaseModel):
    id: uuid.UUID
    equipment_id: uuid.UUID
    project_id: uuid.UUID
    logged_date: datetime
    liters: float
    cost_per_liter: float
    total_cost: float
    odometer_hours: Optional[float]
    remarks: Optional[str]

    class Config:
        from_attributes = True


class MaintenanceCreate(BaseModel):
    service_type: str
    scheduled_date: datetime
    cost: Optional[float] = Field(0.0, ge=0)
    status: str = Field("scheduled", pattern="^(scheduled|completed|overdue)$")
    remarks: Optional[str] = None


class MaintenanceResponse(BaseModel):
    id: uuid.UUID
    equipment_id: uuid.UUID
    service_type: str
    scheduled_date: datetime
    completed_date: Optional[datetime]
    cost: float
    status: str
    remarks: Optional[str]

    class Config:
        from_attributes = True


# ─── Fleet Endpoints ─────────────────────────────────────────────────────────

@router.post("", response_model=EquipmentResponse, status_code=status.HTTP_201_CREATED)
def add_equipment(payload: EquipmentCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # R2-556: resolve the referenced company before use and 404 naming it,
    # instead of letting an unknown id surface as a misleading membership 403.
    if not db.query(Company).filter(Company.id == payload.company_id).first():
        raise HTTPException(status_code=404, detail="Company not found")
    get_company_membership(db, current_user, payload.company_id)
    require_permission(db, current_user, payload.company_id, "equipment:edit")
    # R2-049: the code check is company-scoped, matching the (company_id, code)
    # unique constraint. Unscoped, it rejected a code held by a different
    # tenant and told the caller that code was taken -- simultaneously a
    # cross-tenant denial of service and a disclosure about another company's
    # fleet numbering.
    existing = db.query(Equipment).filter(
        Equipment.code == payload.code,
        Equipment.company_id == payload.company_id,
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Equipment code already exists")
    
    data = payload.model_dump()
    data["hourly_rate"] = Decimal(str(data["hourly_rate"]))
    eq = Equipment(**data)
    db.add(eq)
    db.commit()
    db.refresh(eq)
    return eq


@router.put("/{equipment_id}", response_model=EquipmentResponse)
def update_equipment(equipment_id: uuid.UUID, payload: EquipmentUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    eq = db.query(Equipment).filter(Equipment.id == equipment_id).first()
    if not eq:
        raise HTTPException(status_code=404, detail="Equipment not found")
    get_company_membership(db, current_user, eq.company_id)
    require_permission(db, current_user, eq.company_id, "equipment:edit")

    if payload.code and payload.code != eq.code:
        existing = db.query(Equipment).filter(
            Equipment.code == payload.code,
            Equipment.company_id == eq.company_id,
            Equipment.id != equipment_id,
        ).first()
        if existing:
            raise HTTPException(status_code=400, detail="Equipment code already exists")

    update_data = payload.model_dump(exclude_unset=True)
    if "hourly_rate" in update_data and update_data["hourly_rate"] is not None:
        update_data["hourly_rate"] = Decimal(str(update_data["hourly_rate"]))

    for k, v in update_data.items():
        setattr(eq, k, v)

    db.commit()
    db.refresh(eq)
    return eq


@router.get("/{company_id}", response_model=List[EquipmentResponse])
def list_fleet(
    company_id: uuid.UUID,
    ownership_type: Optional[str] = None,
    db: Session = Depends(get_db),
    _: None = Depends(verify_company_access)
):
    query = db.query(Equipment).filter(Equipment.company_id == company_id)
    if ownership_type:
        ot = ownership_type.strip()
        # Competitor parity alias: Rented maps to Hired in the fleet schema
        if ot.lower() == "rented":
            ot = "Hired"
        query = query.filter(func.lower(Equipment.ownership_type) == ot.lower())
    return query.order_by(Equipment.created_at.desc()).all()


# ─── Deployment Endpoints ────────────────────────────────────────────────────

@router.post("/{equipment_id}/deploy", response_model=DeploymentResponse, status_code=status.HTTP_201_CREATED)
def deploy_equipment(
    equipment_id: uuid.UUID,
    payload: DeploymentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    eq = db.query(Equipment).filter(Equipment.id == equipment_id).first()
    if not eq:
        raise HTTPException(status_code=404, detail="Equipment not found")
    get_company_membership(db, current_user, eq.company_id)
    require_permission(db, current_user, eq.company_id, "equipment:edit")

    proj = db.query(Project).filter(Project.id == payload.project_id).first()
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    if proj.company_id != eq.company_id:
        raise HTTPException(status_code=403, detail="Equipment does not belong to the project's company")

    # Workflow Controls: Entry Controls (creation date window)
    enforce_entry_creation_window(db, eq.company_id, payload.start_date)

    # Set any current active deployments to finished
    active = db.query(EquipmentDeployment).filter(
        EquipmentDeployment.equipment_id == equipment_id,
        EquipmentDeployment.end_date == None
    ).all()
    for dep in active:
        dep.end_date = payload.start_date

    new_dep = EquipmentDeployment(
        equipment_id=equipment_id,
        project_id=payload.project_id,
        start_date=payload.start_date,
        hours_used=Decimal(str(payload.hours_used)) if payload.hours_used is not None else None,
        start_meter=Decimal(str(payload.start_meter)) if payload.start_meter is not None else None,
        remarks=payload.remarks
    )
    eq.status = "deployed"
    db.add(new_dep)
    db.commit()
    db.refresh(new_dep)
    return new_dep


@router.get("/deployments/{project_id}", response_model=List[DeploymentResponse])
def list_deployments(project_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    return db.query(EquipmentDeployment).filter(
        EquipmentDeployment.project_id == project_id
    ).order_by(EquipmentDeployment.start_date.desc()).all()


@router.patch("/deployments/{deployment_id}/return", response_model=DeploymentResponse)
def return_deployment(
    deployment_id: uuid.UUID,
    payload: Optional[DeploymentReturn] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dep = db.query(EquipmentDeployment).filter(EquipmentDeployment.id == deployment_id).first()
    if not dep:
        raise HTTPException(status_code=404, detail="Deployment not found")
    eq = db.query(Equipment).filter(Equipment.id == dep.equipment_id).first()
    if not eq:
        raise HTTPException(status_code=404, detail="Equipment not found")
    get_company_membership(db, current_user, eq.company_id)
    require_permission(db, current_user, eq.company_id, "equipment:edit")

    payload = payload or DeploymentReturn()
    dep.end_date = payload.end_date or datetime.now(timezone.utc)

    if payload.end_meter is not None:
        if dep.start_meter is not None and Decimal(str(payload.end_meter)) < dep.start_meter:
            raise HTTPException(status_code=400, detail=f"Stop reading {payload.end_meter} is below the start reading {dep.start_meter}")
        dep.end_meter = Decimal(str(payload.end_meter))
    if payload.remarks:
        # Append rather than overwrite: the start remarks are the only record of
        # how the deployment opened.
        dep.remarks = f"{dep.remarks}. {payload.remarks}" if dep.remarks else payload.remarks

    # hours_used drives every cost calculation against Equipment.hourly_rate. An
    # explicit reading wins; otherwise fall back to wall-clock elapsed time so a
    # completed deployment is never silently free.
    # Next best is the hour meter: wall-clock time bills a crane parked overnight.
    if payload.hours_used is not None:
        dep.hours_used = Decimal(str(payload.hours_used))
    elif dep.start_meter is not None and dep.end_meter is not None:
        dep.hours_used = dep.end_meter - dep.start_meter
    elif dep.hours_used in (None, 0) and dep.start_date and dep.end_date:
        start = dep.start_date
        end = dep.end_date
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        elapsed_hours = max(0.0, (end - start).total_seconds() / 3600.0)
        dep.hours_used = Decimal(str(round(elapsed_hours, 2)))

    eq.status = "available"
    db.commit()
    db.refresh(dep)
    return dep


# ─── Fuel Logging Endpoints ──────────────────────────────────────────────────

@router.post("/{equipment_id}/fuel", response_model=FuelLogResponse, status_code=status.HTTP_201_CREATED)
def log_fuel(
    equipment_id: uuid.UUID,
    payload: FuelLogCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    eq = db.query(Equipment).filter(Equipment.id == equipment_id).first()
    if not eq:
        raise HTTPException(status_code=404, detail="Equipment not found")
    get_company_membership(db, current_user, eq.company_id)
    require_permission(db, current_user, eq.company_id, "equipment:edit")

    proj = db.query(Project).filter(Project.id == payload.project_id).first()
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    if proj.company_id != eq.company_id:
        raise HTTPException(status_code=403, detail="Equipment does not belong to the project's company")

    # R2-570: temporal, relational and odometer guards before anything is written.
    logged_at = _as_aware(payload.logged_date)
    if logged_at > datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="logged_date cannot be in the future")
    # Workflow Controls: Entry Controls (creation date window)
    enforce_entry_creation_window(db, eq.company_id, payload.logged_date)
    deployments = db.query(EquipmentDeployment).filter(
        EquipmentDeployment.equipment_id == equipment_id,
        EquipmentDeployment.project_id == payload.project_id,
    ).all()
    covered = any(
        _as_aware(d.start_date) <= logged_at
        and (d.end_date is None or logged_at <= _as_aware(d.end_date))
        for d in deployments
    )
    if not covered:
        raise HTTPException(
            status_code=400,
            detail="Equipment has no deployment on this project covering logged_date",
        )
    if payload.odometer_hours is not None:
        prev = db.query(FuelLog).filter(
            FuelLog.equipment_id == equipment_id,
            FuelLog.odometer_hours.isnot(None),
        ).order_by(FuelLog.logged_date.desc()).first()
        if prev is not None and float(payload.odometer_hours) < float(prev.odometer_hours):
            raise HTTPException(
                status_code=400,
                detail=f"odometer_hours cannot be lower than the machine's previous reading ({float(prev.odometer_hours)})",
            )

    data = payload.model_dump()
    total_cost = data["liters"] * data["cost_per_liter"]
    
    # Convert floats to Decimal for database
    db_data = {
        "equipment_id": equipment_id,
        "project_id": data["project_id"],
        "logged_date": data["logged_date"],
        "liters": Decimal(str(data["liters"])),
        "cost_per_liter": Decimal(str(data["cost_per_liter"])),
        "total_cost": Decimal(str(total_cost)),
        "odometer_hours": Decimal(str(data["odometer_hours"])) if data["odometer_hours"] is not None else None,
        "remarks": data["remarks"]
    }

    log = FuelLog(**db_data)
    db.add(log)
    db.commit()
    db.refresh(log)
    return log


@router.get("/fuel-logs/{project_id}", response_model=List[FuelLogResponse])
def list_fuel_logs(project_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    return db.query(FuelLog).filter(
        FuelLog.project_id == project_id
    ).order_by(FuelLog.logged_date.desc()).all()


# ─── Maintenance Endpoints ───────────────────────────────────────────────────

@router.post("/{equipment_id}/maintenance", response_model=MaintenanceResponse, status_code=status.HTTP_201_CREATED)
def schedule_maintenance(
    equipment_id: uuid.UUID,
    payload: MaintenanceCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    eq = db.query(Equipment).filter(Equipment.id == equipment_id).first()
    if not eq:
        raise HTTPException(status_code=404, detail="Equipment not found")
    get_company_membership(db, current_user, eq.company_id)
    require_permission(db, current_user, eq.company_id, "equipment:edit")

    # Workflow Controls: Entry Controls (creation date window)
    enforce_entry_creation_window(db, eq.company_id, payload.scheduled_date)

    data = payload.model_dump()
    db_data = {
        "equipment_id": equipment_id,
        "service_type": data["service_type"],
        "scheduled_date": data["scheduled_date"],
        "cost": Decimal(str(data["cost"] or 0.0)),
        "status": data["status"],
        "remarks": data["remarks"]
    }

    # R2-531: completed_date must be timezone-aware (datetime.utcnow() is not).
    now = datetime.now(timezone.utc)
    done_key = None
    if data["status"] == "completed":
        db_data["completed_date"] = now
        done_key = (data["service_type"].strip().lower(), _as_aware(data["scheduled_date"]).date())

    sched = MaintenanceSchedule(**db_data)
    db.add(sched)
    db.flush()

    # R2-531: derive Equipment.status from the open schedules' dates and today,
    # never from whichever record was written last - a future-dated booking
    # must not take the machine off the road, and completing one job must not
    # clear the flag while other due work is still open. The completed record
    # closes the matching (service_type, scheduled day) bookings.
    due_open = any(
        _as_aware(s.scheduled_date) <= now
        and (done_key is None or (s.service_type.strip().lower(), _as_aware(s.scheduled_date).date()) != done_key)
        for s in db.query(MaintenanceSchedule)
        .filter(
            MaintenanceSchedule.equipment_id == equipment_id,
            MaintenanceSchedule.status != "completed",
        )
        .all()
    )
    if due_open:
        eq.status = "maintenance"
    elif data["status"] == "completed" and eq.status == "maintenance":
        eq.status = "available"

    db.commit()
    db.refresh(sched)
    return sched


@router.get("/maintenance-schedules/{equipment_id}", response_model=List[MaintenanceResponse])
def list_maintenance_schedules(equipment_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    eq = db.query(Equipment).filter(Equipment.id == equipment_id).first()
    if not eq:
        raise HTTPException(status_code=404, detail="Equipment not found")
    get_company_membership(db, current_user, eq.company_id)
    return db.query(MaintenanceSchedule).filter(
        MaintenanceSchedule.equipment_id == equipment_id
    ).order_by(MaintenanceSchedule.scheduled_date.desc()).all()


@router.delete("/{equipment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_equipment(equipment_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """R2-760: Delete / void an equipment record with audit log."""
    eq = db.query(Equipment).filter(Equipment.id == equipment_id).first()
    if not eq:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Equipment not found")
    get_company_membership(db, current_user, eq.company_id)
    require_permission(db, current_user, eq.company_id, "equipment:edit")

    # Check for active deployments
    active_dep = db.query(EquipmentDeployment).filter(
        EquipmentDeployment.equipment_id == eq.id,
        EquipmentDeployment.end_date == None,
    ).first()
    if active_dep:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Cannot delete equipment with active deployment")

    log_deletion(
        db,
        company_id=eq.company_id,
        entity_type="equipment",
        entity_id=eq.id,
        summary=f"Equipment [{eq.code}]: {eq.name}",
        deleted_by=current_user.name or current_user.email or "Unknown",
    )
    db.delete(eq)
    db.commit()


@router.delete("/deployments/{deployment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_deployment(deployment_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """R2-760: Delete / void an equipment deployment with audit log."""
    dep = db.query(EquipmentDeployment).filter(EquipmentDeployment.id == deployment_id).first()
    if not dep:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Deployment not found")
    eq = db.query(Equipment).filter(Equipment.id == dep.equipment_id).first()
    if not eq:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Equipment not found")
    get_company_membership(db, current_user, eq.company_id)
    require_permission(db, current_user, eq.company_id, "equipment:edit")
    log_deletion(
        db,
        company_id=eq.company_id,
        entity_type="equipment_deployment",
        entity_id=dep.id,
        summary=f"Deployment for equipment {eq.name}",
        deleted_by=current_user.name or current_user.email or "Unknown",
    )
    db.delete(dep)
    db.commit()


@router.delete("/fuel-logs/{log_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_fuel_log(log_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """R2-760: Delete / void an equipment fuel log with audit log."""
    fl = db.query(FuelLog).filter(FuelLog.id == log_id).first()
    if not fl:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Fuel log not found")
    eq = db.query(Equipment).filter(Equipment.id == fl.equipment_id).first()
    if not eq:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Equipment not found")
    get_company_membership(db, current_user, eq.company_id)
    require_permission(db, current_user, eq.company_id, "equipment:edit")
    log_deletion(
        db,
        company_id=eq.company_id,
        entity_type="fuel_log",
        entity_id=fl.id,
        summary=f"Fuel log {fl.liters}L for equipment {eq.name}",
        deleted_by=current_user.name or current_user.email or "Unknown",
    )
    db.delete(fl)
    db.commit()


@router.get("/expenses/{bill_id}/pdf")
def get_equipment_expense_pdf(
    bill_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Download equipment expense bill as PDF (Competitor Parity 14.9.4 #3)."""
    from app.models import Bill
    from app.routers.billing import get_bill_pdf
    bill = db.query(Bill).filter(Bill.id == bill_id).first()
    if not bill:
        raise HTTPException(status_code=404, detail="Equipment expense bill not found")
    if bill.invoice_type != "equipment":
        raise HTTPException(status_code=400, detail="Bill is not an equipment expense")
    return get_bill_pdf(bill_id=bill_id, db=db, current_user=current_user)

