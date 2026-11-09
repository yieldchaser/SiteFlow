import uuid
from datetime import datetime
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field
from app.database import get_db
from app.auth import get_current_user, verify_project_access, get_company_membership, require_permission
from app.constants import WASTAGE_TYPE_PATTERN, WASTAGE_STATUS_PATTERN, WASTAGE_STATUSES
from app.models import MaterialWastage, MaterialTransaction, PurchaseOrder, PurchaseOrderItem, User, WarehouseInventory
from app.workflow_controls import enforce_stock_availability
from app.routers.delete_logs import log_deletion
from decimal import Decimal

router = APIRouter(prefix="/wastage", tags=["Material Wastage & Scrap"], dependencies=[Depends(get_current_user)])


class MaterialWastageCreate(BaseModel):
    company_id: uuid.UUID
    project_id: uuid.UUID
    material_name: str
    wastage_type: str = Field(..., pattern=WASTAGE_TYPE_PATTERN)
    quantity: float = Field(..., gt=0)
    unit: str
    estimated_value: Optional[float] = Field(None, ge=0)
    estimated_value_override: bool = False
    reason: Optional[str] = None
    photo_urls: List[str] = []
    task_id: Optional[uuid.UUID] = None


class MaterialWastageResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    project_id: uuid.UUID
    material_name: str
    wastage_type: str
    quantity: float
    unit: str
    estimated_value: float
    reason: Optional[str]
    reported_by: Optional[uuid.UUID]
    photo_urls: List[str]
    task_id: Optional[uuid.UUID]
    status: str
    created_at: datetime

    class Config:
        from_attributes = True


def _last_material_rate(db: Session, project_id: uuid.UUID, material_name: str) -> Optional[float]:
    item = (
        db.query(PurchaseOrderItem)
        .join(PurchaseOrder, PurchaseOrder.id == PurchaseOrderItem.po_id)
        .filter(
            PurchaseOrder.project_id == project_id,
            PurchaseOrderItem.material_name == material_name,
        )
        .order_by(PurchaseOrder.created_at.desc())
        .first()
    )
    if not item:
        return None
    return float(item.rate)


@router.post("", response_model=MaterialWastageResponse, status_code=status.HTTP_201_CREATED)
def create_wastage(payload: MaterialWastageCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    membership = get_company_membership(db, current_user, payload.company_id)
    require_permission(db, current_user, payload.company_id, "procurement:edit")
    inv = db.query(WarehouseInventory).filter(
        WarehouseInventory.project_id == payload.project_id,
        WarehouseInventory.material_name == payload.material_name,
    ).first()
    enforce_stock_availability(db, payload.project_id, payload.material_name, payload.quantity, "Material Wastage")
    if payload.estimated_value_override and payload.estimated_value is not None:
        estimated_value = payload.estimated_value
    else:
        rate = _last_material_rate(db, payload.project_id, payload.material_name)
        estimated_value = payload.quantity * rate if rate is not None else 0.0
    wastage = MaterialWastage(
        company_id=payload.company_id,
        project_id=payload.project_id,
        material_name=payload.material_name,
        wastage_type=payload.wastage_type,
        quantity=payload.quantity,
        unit=payload.unit,
        estimated_value=Decimal(str(estimated_value)),
        reason=payload.reason,
        reported_by=membership.id,
        photo_urls=payload.photo_urls,
        task_id=payload.task_id,
    )
    db.add(wastage)
    db.flush()
    if inv is not None:
        inv.on_hand_qty = float(inv.on_hand_qty) - float(payload.quantity)
    db.add(MaterialTransaction(
        project_id=payload.project_id,
        material_name=payload.material_name,
        qty=payload.quantity,
        type="used",
        unit=payload.unit,
        source_ref_id=wastage.id,
    ))
    db.commit()
    db.refresh(wastage)
    return wastage


@router.get("/{project_id}", response_model=List[MaterialWastageResponse])
def list_wastage(project_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    return db.query(MaterialWastage).filter(
        MaterialWastage.project_id == project_id
    ).order_by(MaterialWastage.created_at.desc()).all()


@router.patch("/{wastage_id}/status", response_model=MaterialWastageResponse)
def update_wastage_status(wastage_id: uuid.UUID, status: str = Query(..., pattern=WASTAGE_STATUS_PATTERN), db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    wastage = db.query(MaterialWastage).filter(MaterialWastage.id == wastage_id).first()
    if not wastage:
        raise HTTPException(status_code=404, detail="Wastage record not found")
    get_company_membership(db, current_user, wastage.company_id)
    require_permission(db, current_user, wastage.company_id, "procurement:edit")
    # A record moves one step at a time: reported, reviewed, approved,
    # disposed. Skipping review or walking a disposed record back left the
    # register saying things nobody had checked.
    order = list(WASTAGE_STATUSES)
    current = wastage.status if wastage.status in order else order[0]
    if status != current:
        nxt = order.index(current) + 1
        if nxt >= len(order) or status != order[nxt]:
            if nxt >= len(order):
                msg = f"This wastage is already {current}. It cannot change any more."
            else:
                msg = f"This wastage is {current}. It can only move to {order[nxt]} next."
            raise HTTPException(status_code=400, detail=msg)
    wastage.status = status
    db.commit()
    db.refresh(wastage)
    return wastage


@router.delete("/{wastage_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_wastage(wastage_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """R2-760: Delete / void a material wastage entry with inventory reversal and audit log."""
    w = db.query(MaterialWastage).filter(MaterialWastage.id == wastage_id).first()
    if not w:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Wastage record not found")
    get_company_membership(db, current_user, w.company_id)
    require_permission(db, current_user, w.company_id, "procurement:edit")

    # Restore inventory on delete
    inv = db.query(WarehouseInventory).filter(
        WarehouseInventory.project_id == w.project_id,
        WarehouseInventory.material_name == w.material_name,
    ).first()
    if inv:
        inv.on_hand_qty = float(inv.on_hand_qty) + float(w.quantity)
        db.add(inv)

    db.query(MaterialTransaction).filter(MaterialTransaction.source_ref_id == w.id).delete()
    log_deletion(
        db,
        company_id=w.company_id,
        entity_type="material_wastage",
        entity_id=w.id,
        summary=f"Wastage [{w.wastage_type}]: {w.quantity} {w.unit} of {w.material_name}",
        deleted_by=current_user.name or current_user.email or "Unknown",
    )
    db.delete(w)
    db.commit()

