"""
Phase 16 - Production Management

Endpoints:
  POST   /production/recipes                  - Create a production recipe
  GET    /production/recipes                  - List recipes for a project
  POST   /production/batches                  - Create a production batch and consume materials
  GET    /production/batches                  - List batches for a project
  GET    /production/summary                  - Project production dashboard payload
"""

from datetime import datetime
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.auth import get_current_user, verify_project_access, get_company_membership, require_permission
from app.models import (
    MaterialTransaction,
    ProductionBatch,
    ProductionBatchMaterial,
    ProductionRecipe,
    ProductionRecipeMaterial,
    Project,
    User,
    WarehouseInventory,
)
from app.workflow_controls import enforce_stock_availability, get_company
from app.routers.delete_logs import log_deletion

router = APIRouter(prefix="/production", tags=["Production Management"], dependencies=[Depends(get_current_user)])


class RecipeMaterialCreate(BaseModel):
    material_name: str
    planned_qty: float = Field(..., ge=0)
    unit: str
    is_optional: bool = False


class RecipeMaterialResponse(BaseModel):
    id: UUID
    material_name: str
    planned_qty: float
    unit: str
    is_optional: bool

    class Config:
        from_attributes = True


class RecipeCreate(BaseModel):
    company_id: UUID
    project_id: UUID
    recipe_code: str
    product_name: str
    mix_type: str
    unit: str = "m3"
    target_output_qty: float = Field(1.0, gt=0)
    wastage_pct: float = Field(5.0, ge=0, le=100)
    notes: Optional[str] = None
    materials: List[RecipeMaterialCreate]


class RecipeResponse(BaseModel):
    id: UUID
    company_id: UUID
    project_id: UUID
    recipe_code: str
    product_name: str
    mix_type: str
    unit: str
    target_output_qty: float
    wastage_pct: float
    status: str
    notes: Optional[str]
    created_at: datetime
    materials: List[RecipeMaterialResponse] = []

    class Config:
        from_attributes = True


class BatchMaterialInput(BaseModel):
    material_name: str
    actual_qty: Optional[float] = Field(None, ge=0)
    unit: str


class BatchMaterialResponse(BaseModel):
    id: UUID
    material_name: str
    planned_qty: float
    actual_qty: float
    unit: str
    variance_qty: float

    class Config:
        from_attributes = True


class BatchCreate(BaseModel):
    company_id: UUID
    project_id: UUID
    recipe_id: UUID
    batch_number: str
    task_id: Optional[UUID] = None
    planned_output_qty: Optional[float] = Field(None, ge=0)
    actual_output_qty: Optional[float] = Field(None, ge=0)
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    status: str = Field("completed", pattern="^(draft|running|completed|cancelled)$")
    notes: Optional[str] = None
    materials: Optional[List[BatchMaterialInput]] = None


class BatchResponse(BaseModel):
    id: UUID
    company_id: UUID
    project_id: UUID
    recipe_id: UUID
    recipe_code: str
    product_name: str
    mix_type: str
    batch_number: str
    planned_output_qty: float
    actual_output_qty: float
    planned_material_qty: float
    actual_material_qty: float
    consumption_variance_qty: float
    status: str
    started_at: Optional[datetime]
    completed_at: Optional[datetime]
    notes: Optional[str]
    created_at: datetime
    materials: List[BatchMaterialResponse] = []

    class Config:
        from_attributes = True


class InventoryAlertResponse(BaseModel):
    id: UUID
    material_name: str
    on_hand_qty: float
    reserved_qty: float
    available_qty: float
    unit: str
    needs_reorder: bool

    class Config:
        from_attributes = True


class ProductionSummaryResponse(BaseModel):
    project_id: UUID
    project_name: str
    recipe_count: int
    batch_count: int
    planned_output_qty: float
    actual_output_qty: float
    output_variance_qty: float
    planned_material_qty: float
    actual_material_qty: float
    material_variance_qty: float
    recipes: List[RecipeResponse] = []
    batches: List[BatchResponse] = []
    inventory_alerts: List[InventoryAlertResponse] = []

    class Config:
        from_attributes = True


def _recipe_response(db: Session, recipe: ProductionRecipe) -> RecipeResponse:
    items = db.query(ProductionRecipeMaterial).filter(ProductionRecipeMaterial.recipe_id == recipe.id).all()
    return RecipeResponse(
        id=recipe.id,
        company_id=recipe.company_id,
        project_id=recipe.project_id,
        recipe_code=recipe.recipe_code,
        product_name=recipe.product_name,
        mix_type=recipe.mix_type,
        unit=recipe.unit,
        target_output_qty=float(recipe.target_output_qty),
        wastage_pct=float(recipe.wastage_pct),
        status=recipe.status,
        notes=recipe.notes,
        created_at=recipe.created_at,
        materials=[
            RecipeMaterialResponse(
                id=item.id,
                material_name=item.material_name,
                planned_qty=float(item.planned_qty),
                unit=item.unit,
                is_optional=item.is_optional,
            )
            for item in items
        ],
    )


def _batch_response(db: Session, batch: ProductionBatch) -> BatchResponse:
    recipe = db.query(ProductionRecipe).filter(ProductionRecipe.id == batch.recipe_id).first()
    materials = db.query(ProductionBatchMaterial).filter(ProductionBatchMaterial.batch_id == batch.id).all()
    if not recipe:
        raise HTTPException(status_code=404, detail="Production recipe not found for batch")
    return BatchResponse(
        id=batch.id,
        company_id=batch.company_id,
        project_id=batch.project_id,
        recipe_id=batch.recipe_id,
        recipe_code=recipe.recipe_code,
        product_name=recipe.product_name,
        mix_type=recipe.mix_type,
        batch_number=batch.batch_number,
        planned_output_qty=float(batch.planned_output_qty),
        actual_output_qty=float(batch.actual_output_qty),
        planned_material_qty=float(batch.planned_material_qty),
        actual_material_qty=float(batch.actual_material_qty),
        consumption_variance_qty=float(batch.consumption_variance_qty),
        status=batch.status,
        started_at=batch.started_at,
        completed_at=batch.completed_at,
        notes=batch.notes,
        created_at=batch.created_at,
        materials=[
            BatchMaterialResponse(
                id=item.id,
                material_name=item.material_name,
                planned_qty=float(item.planned_qty),
                actual_qty=float(item.actual_qty),
                unit=item.unit,
                variance_qty=float(item.variance_qty),
            )
            for item in materials
        ],
    )


def _upsert_inventory(db: Session, project_id: UUID, material_name: str, unit: str, used_qty: float) -> WarehouseInventory:
    inventory = db.query(WarehouseInventory).filter(
        WarehouseInventory.project_id == project_id,
        WarehouseInventory.material_name == material_name,
    ).first()
    if not inventory:
        inventory = WarehouseInventory(
            project_id=project_id,
            material_name=material_name,
            on_hand_qty=0.0,
            reserved_qty=0.0,
            unit=unit,
        )
        db.add(inventory)
        db.flush()

    inventory.on_hand_qty = float(inventory.on_hand_qty or 0.0) - float(used_qty)
    inventory.unit = unit or inventory.unit
    return inventory


@router.post("/recipes", response_model=RecipeResponse, status_code=status.HTTP_201_CREATED)
def create_recipe(payload: RecipeCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, payload.company_id)
    require_permission(db, current_user, payload.company_id, "production:edit")
    project = db.query(Project).filter(Project.id == payload.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project.company_id != payload.company_id:
        raise HTTPException(status_code=403, detail="Project does not belong to this company")

    existing = db.query(ProductionRecipe).filter(
        ProductionRecipe.company_id == payload.company_id,
        ProductionRecipe.recipe_code == payload.recipe_code,
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Recipe code already exists for this company")

    recipe = ProductionRecipe(
        company_id=payload.company_id,
        project_id=payload.project_id,
        recipe_code=payload.recipe_code,
        product_name=payload.product_name,
        mix_type=payload.mix_type,
        unit=payload.unit,
        target_output_qty=payload.target_output_qty,
        wastage_pct=payload.wastage_pct,
        notes=payload.notes,
    )
    db.add(recipe)
    db.flush()

    for material in payload.materials:
        db.add(
            ProductionRecipeMaterial(
                recipe_id=recipe.id,
                material_name=material.material_name,
                planned_qty=material.planned_qty,
                unit=material.unit,
                is_optional=material.is_optional,
            )
        )

    db.commit()
    db.refresh(recipe)
    return _recipe_response(db, recipe)


@router.get("/recipes", response_model=List[RecipeResponse])
def list_recipes(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    recipes = db.query(ProductionRecipe).filter(ProductionRecipe.project_id == project_id).order_by(ProductionRecipe.created_at.desc()).all()
    return [_recipe_response(db, recipe) for recipe in recipes]


@router.post("/batches", response_model=BatchResponse, status_code=status.HTTP_201_CREATED)
def create_batch(payload: BatchCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, payload.company_id)
    require_permission(db, current_user, payload.company_id, "production:edit")
    recipe = db.query(ProductionRecipe).filter(ProductionRecipe.id == payload.recipe_id).first()
    if not recipe:
        raise HTTPException(status_code=404, detail="Production recipe not found")
    if recipe.company_id != payload.company_id or recipe.project_id != payload.project_id:
        raise HTTPException(status_code=400, detail="Recipe does not belong to the supplied company/project")

    batch_exists = db.query(ProductionBatch).filter(
        ProductionBatch.company_id == payload.company_id,
        ProductionBatch.batch_number == payload.batch_number,
    ).first()
    if batch_exists:
        raise HTTPException(status_code=400, detail="Batch number already exists for this company")

    # Workflow Controls: Material Controls -> Restrict Production Material
    company = get_company(db, payload.company_id)
    restrict_production_material = bool(company and company.restrict_production_material)
    # R2-254: a completed batch consumes stock exactly like manual usage and the
    # DPR do, so an armed negative_stock_lock must gate it too - checked for every
    # consumed material BEFORE any row is written, not after stock goes negative.
    negative_stock_lock = bool(company and company.negative_stock_lock)

    recipe_materials = db.query(ProductionRecipeMaterial).filter(ProductionRecipeMaterial.recipe_id == recipe.id).all()
    override_map = {item.material_name: item for item in (payload.materials or [])}

    planned_output_qty = payload.planned_output_qty if payload.planned_output_qty is not None else float(recipe.target_output_qty)
    actual_output_qty = payload.actual_output_qty if payload.actual_output_qty is not None else planned_output_qty
    started_at = payload.started_at or datetime.utcnow()
    completed_at = payload.completed_at or (datetime.utcnow() if payload.status == "completed" else None)

    batch = ProductionBatch(
        company_id=payload.company_id,
        project_id=payload.project_id,
        recipe_id=payload.recipe_id,
        task_id=payload.task_id,
        batch_number=payload.batch_number,
        planned_output_qty=planned_output_qty,
        actual_output_qty=actual_output_qty,
        status=payload.status,
        started_at=started_at,
        completed_at=completed_at,
        notes=payload.notes,
    )
    db.add(batch)
    db.flush()

    planned_material_qty = 0.0
    actual_material_qty = 0.0

    target_output = float(recipe.target_output_qty) or 1.0
    wastage_factor = 1.0 + float(recipe.wastage_pct or 0) / 100.0
    for recipe_material in recipe_materials:
        override = override_map.pop(recipe_material.material_name, None)
        per_unit = float(recipe_material.planned_qty) / target_output

        # The recipe is written for its target output (say 8 bags of cement
        # per 1 cum). A batch plans for its own size: a 5 cum batch plans
        # 40 bags, plus the recipe's wastage allowance. The plan used to stay
        # at the recipe's 8 bags whatever the batch size, so a 5 cum pour
        # using 41 bags showed 33 bags over plan.
        planned_qty = per_unit * planned_output_qty * wastage_factor
        if override and override.actual_qty is not None:
            actual_qty = override.actual_qty
        else:
            # No measured figure: the recipe amount for what was produced.
            actual_qty = per_unit * actual_output_qty * wastage_factor
        unit = override.unit if override else recipe_material.unit
        variance_qty = actual_qty - planned_qty

        planned_material_qty += planned_qty
        actual_material_qty += actual_qty

        db.add(
            ProductionBatchMaterial(
                batch_id=batch.id,
                material_name=recipe_material.material_name,
                planned_qty=planned_qty,
                actual_qty=actual_qty,
                unit=unit,
                variance_qty=variance_qty,
            )
        )
        
        if batch.status == "completed":
            if restrict_production_material:
                enforce_stock_availability(db, payload.project_id, recipe_material.material_name, actual_qty, "Restrict Production Material")
            elif negative_stock_lock:
                enforce_stock_availability(db, payload.project_id, recipe_material.material_name, actual_qty, "Restrict Material Usage")
            db.add(
                MaterialTransaction(
                    project_id=payload.project_id,
                    material_name=recipe_material.material_name,
                    qty=actual_qty,
                    type="used",
                    source_ref_id=batch.id,
                )
            )
            _upsert_inventory(db, payload.project_id, recipe_material.material_name, unit, actual_qty)

    for extra_material in override_map.values():
        actual_qty = extra_material.actual_qty if extra_material.actual_qty is not None else 0.0
        planned_qty = 0.0
        planned_material_qty += planned_qty
        actual_material_qty += actual_qty

        db.add(
            ProductionBatchMaterial(
                batch_id=batch.id,
                material_name=extra_material.material_name,
                planned_qty=planned_qty,
                actual_qty=actual_qty,
                unit=extra_material.unit,
                variance_qty=actual_qty - planned_qty,
            )
        )
        
        if batch.status == "completed":
            if restrict_production_material:
                enforce_stock_availability(db, payload.project_id, extra_material.material_name, actual_qty, "Restrict Production Material")
            elif negative_stock_lock:
                enforce_stock_availability(db, payload.project_id, extra_material.material_name, actual_qty, "Restrict Material Usage")
            db.add(
                MaterialTransaction(
                    project_id=payload.project_id,
                    material_name=extra_material.material_name,
                    qty=actual_qty,
                    type="used",
                    source_ref_id=batch.id,
                )
            )
            _upsert_inventory(db, payload.project_id, extra_material.material_name, extra_material.unit, actual_qty)

    batch.planned_material_qty = planned_material_qty
    batch.actual_material_qty = actual_material_qty
    batch.consumption_variance_qty = actual_material_qty - planned_material_qty

    db.commit()
    db.refresh(batch)
    return _batch_response(db, batch)


@router.patch("/batches/{batch_id}/complete", response_model=BatchResponse)
def complete_batch(batch_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    batch = db.query(ProductionBatch).filter(ProductionBatch.id == batch_id).first()
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    get_company_membership(db, current_user, batch.company_id)
    require_permission(db, current_user, batch.company_id, "production:edit")
    if batch.status == "completed":
        return _batch_response(db, batch)

    # Workflow Controls: Material Controls -> Restrict Production Material
    company = get_company(db, batch.company_id)
    restrict_production_material = bool(company and company.restrict_production_material)
    # R2-254: completing a deferred batch is the same consumption event; the
    # negative_stock_lock gates it identically to the create-time path.
    negative_stock_lock = bool(company and company.negative_stock_lock)

    batch.status = "completed"
    batch.completed_at = datetime.utcnow()

    # Deduct inventory if not already deducted
    tx_exists = db.query(MaterialTransaction).filter(
        MaterialTransaction.source_ref_id == batch.id
    ).first()

    if not tx_exists:
        batch_materials = db.query(ProductionBatchMaterial).filter(ProductionBatchMaterial.batch_id == batch.id).all()
        for bm in batch_materials:
            if restrict_production_material:
                enforce_stock_availability(db, batch.project_id, bm.material_name, float(bm.actual_qty), "Restrict Production Material")
            elif negative_stock_lock:
                enforce_stock_availability(db, batch.project_id, bm.material_name, float(bm.actual_qty), "Restrict Material Usage")
            db.add(
                MaterialTransaction(
                    project_id=batch.project_id,
                    material_name=bm.material_name,
                    qty=bm.actual_qty,
                    type="used",
                    source_ref_id=batch.id,
                )
            )
            _upsert_inventory(db, batch.project_id, bm.material_name, bm.unit, bm.actual_qty)

    db.commit()
    db.refresh(batch)
    return _batch_response(db, batch)



@router.get("/batches", response_model=List[BatchResponse])
def list_batches(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    batches = db.query(ProductionBatch).filter(ProductionBatch.project_id == project_id).order_by(ProductionBatch.created_at.desc()).all()
    return [_batch_response(db, batch) for batch in batches]


@router.get("/summary", response_model=ProductionSummaryResponse)
def production_summary(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    recipes = db.query(ProductionRecipe).filter(ProductionRecipe.project_id == project_id).order_by(ProductionRecipe.created_at.desc()).all()
    batches = db.query(ProductionBatch).filter(ProductionBatch.project_id == project_id).order_by(ProductionBatch.created_at.desc()).all()
    inventory = db.query(WarehouseInventory).filter(WarehouseInventory.project_id == project_id).order_by(WarehouseInventory.material_name.asc()).all()

    total_planned_output = sum(float(batch.planned_output_qty) for batch in batches)
    total_actual_output = sum(float(batch.actual_output_qty) for batch in batches)
    total_planned_material = sum(float(batch.planned_material_qty) for batch in batches)
    total_actual_material = sum(float(batch.actual_material_qty) for batch in batches)

    inventory_alerts = [
        InventoryAlertResponse(
            id=row.id,
            material_name=row.material_name,
            on_hand_qty=float(row.on_hand_qty),
            reserved_qty=float(row.reserved_qty),
            available_qty=float(row.on_hand_qty) - float(row.reserved_qty),
            unit=row.unit,
            needs_reorder=float(row.on_hand_qty) <= float(row.reserved_qty),
        )
        for row in inventory
    ]

    return ProductionSummaryResponse(
        project_id=project.id,
        project_name=project.name,
        recipe_count=len(recipes),
        batch_count=len(batches),
        planned_output_qty=total_planned_output,
        actual_output_qty=total_actual_output,
        output_variance_qty=total_actual_output - total_planned_output,
        planned_material_qty=total_planned_material,
        actual_material_qty=total_actual_material,
        material_variance_qty=total_actual_material - total_planned_material,
        recipes=[_recipe_response(db, recipe) for recipe in recipes],
        batches=[_batch_response(db, batch) for batch in batches],
        inventory_alerts=inventory_alerts,
    )


@router.delete("/recipes/{recipe_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_recipe(recipe_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """R2-760: Delete / void a production recipe with audit log."""
    rec = db.query(ProductionRecipe).filter(ProductionRecipe.id == recipe_id).first()
    if not rec:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Production recipe not found")
    get_company_membership(db, current_user, rec.company_id)
    require_permission(db, current_user, rec.company_id, "production:edit")

    db.query(ProductionRecipeMaterial).filter(ProductionRecipeMaterial.recipe_id == rec.id).delete()
    log_deletion(
        db,
        company_id=rec.company_id,
        entity_type="production_recipe",
        entity_id=rec.id,
        summary=f"Production recipe [{rec.recipe_code}]: {rec.product_name}",
        deleted_by=current_user.name or current_user.email or "Unknown",
    )
    db.delete(rec)
    db.commit()


@router.delete("/batches/{batch_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_batch(batch_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """R2-760: Delete / void a production batch with inventory reversal and audit log."""
    batch = db.query(ProductionBatch).filter(ProductionBatch.id == batch_id).first()
    if not batch:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Production batch not found")
    get_company_membership(db, current_user, batch.company_id)
    require_permission(db, current_user, batch.company_id, "production:edit")

    # Restore materials if consumed
    mats = db.query(ProductionBatchMaterial).filter(ProductionBatchMaterial.batch_id == batch.id).all()
    for m in mats:
        inv = db.query(WarehouseInventory).filter(
            WarehouseInventory.project_id == batch.project_id,
            WarehouseInventory.material_name == m.material_name,
        ).first()
        if inv:
            inv.on_hand_qty = float(inv.on_hand_qty) + float(m.consumed_qty)
            db.add(inv)

    db.query(ProductionBatchMaterial).filter(ProductionBatchMaterial.batch_id == batch.id).delete()
    db.query(MaterialTransaction).filter(MaterialTransaction.source_ref_id == batch.id).delete()
    log_deletion(
        db,
        company_id=batch.company_id,
        entity_type="production_batch",
        entity_id=batch.id,
        summary=f"Production batch [{batch.batch_number}]",
        deleted_by=current_user.name or current_user.email or "Unknown",
    )
    db.delete(batch)
    db.commit()

