import logging
from uuid import UUID
from datetime import datetime, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

logger = logging.getLogger(__name__)
from sqlalchemy import func
from sqlalchemy.orm import Session
from app.database import get_db
from app.auth import get_current_user, verify_project_in_company, verify_company_access, verify_project_access, get_company_membership, require_permission
from app.models import (
    MaterialIndent, MaterialIndentItem,
    PurchaseOrder, PurchaseOrderItem,
    GoodsReceiptNote, GRNItem,
    WarehouseInventory, MaterialTransaction,
    Project, User, ApprovalRule, CompanyTeam, LibraryParty, LibraryMaterial
)
from app.approvals import (
    find_matching_rule,
    match_approver,
    levels_approved,
    user_already_acted,
    record_action,
    PO_FEATURE_TYPE,
)
from app.workflow_controls import enforce_stock_availability, enforce_entry_creation_window, enforce_entry_editing_window, get_company, get_default_terms
from app.inventory_reservation import release_reservation, rereserve_reservation
from app.utils.pdf_generator import generate_document_pdf
from app.utils.document_pdf import resolve_pdf_branding, resolve_supplier_tax_details
from pydantic import BaseModel, Field, field_validator

router = APIRouter(
    prefix="/procurement",
    tags=["Procurement & Inventory"],
    dependencies=[Depends(get_current_user)]
)

# Pydantic Schemas
class IndentItemSchema(BaseModel):
    material_name: str
    quantity: float = Field(..., ge=0)
    unit: str

class IndentCreateRequest(BaseModel):
    company_id: UUID
    project_id: UUID
    requested_by: Optional[UUID] = None
    # Optional so the server can number it. The form leaves this blank and every
    # indent used to be stored with indent_number "", which cannot be quoted to a
    # vendor or referenced on a PO. GRNs, NCRs and RA bills all self-number;
    # indents were the one document that did not.
    indent_number: Optional[str] = None
    items: List[IndentItemSchema]

class IndentResponse(BaseModel):
    id: UUID
    company_id: UUID
    project_id: UUID
    requested_by: Optional[UUID] = None
    approved_by: Optional[UUID] = None
    approved_at: Optional[datetime] = None
    indent_number: str
    status: str
    created_at: datetime
    items: List[IndentItemSchema] = []

    class Config:
        from_attributes = True

class POCreateItemSchema(BaseModel):
    material_name: str
    quantity: float = Field(..., ge=0)
    unit: str
    rate: float = Field(..., ge=0)
    tax_pct: float = Field(18.00, ge=0, le=100)

class POCreateRequest(BaseModel):
    company_id: UUID
    project_id: UUID
    vendor_id: Optional[UUID] = None
    # A vendor chosen from the Party Library. PurchaseOrder.vendor_id is a
    # foreign key to company_team, and a party registered through the library has
    # no company_team row, so a supplier could not be named on a PO at all: the
    # picker was fed by /billing/subcontractors and offered subcontractors only.
    # Supplying the party id here resolves (or creates) the company_team link.
    vendor_party_id: Optional[UUID] = None
    po_number: str
    po_date: datetime
    expected_delivery_date: Optional[datetime] = None
    items: List[POCreateItemSchema] = Field(..., min_length=1)
    terms: Optional[str] = None  # Terms & Conditions; defaults to company Purchase Order Terms on create
    # R2-372: raise this PO from an approved material indent. The link is
    # validated, capped at the approved quantities, and marks the indent ordered.
    indent_id: Optional[UUID] = None

class POResponseItemSchema(BaseModel):
    id: UUID
    material_name: str
    quantity: float
    unit: str
    rate: float
    tax_pct: float
    total_amount: float

class POResponse(BaseModel):
    id: UUID
    company_id: UUID
    project_id: UUID
    vendor_id: Optional[UUID] = None
    vendor_name: Optional[str] = None
    indent_id: Optional[UUID] = None
    po_number: str
    po_date: datetime
    expected_delivery_date: Optional[datetime] = None
    status: str
    gross_amount: float
    tax_amount: float
    total_amount: float
    approval_flag: str
    approval_rule_id: Optional[UUID] = None
    approvals_required: int = 0
    approvals_completed: int = 0
    created_at: datetime
    terms: Optional[str] = None
    items: List[POResponseItemSchema] = []

    class Config:
        from_attributes = True

class GRNCreateItemSchema(BaseModel):
    po_item_id: UUID
    received_qty: float = Field(..., ge=0)

class GRNCreateRequest(BaseModel):
    company_id: UUID
    project_id: UUID
    po_id: UUID
    grn_number: Optional[str] = None  # omit to auto-generate per Settings -> Workflow Controls -> GRN Numbering
    received_date: datetime
    received_by: Optional[UUID] = None
    items: List[GRNCreateItemSchema]

    @field_validator("received_date")
    @classmethod
    def received_date_not_future(cls, v: datetime) -> datetime:
        if v.tzinfo is None:
            v = v.astimezone()
        if v.astimezone(timezone.utc) > datetime.now(timezone.utc):
            raise ValueError("received_date cannot be in the future")
        return v

class GRNResponseItemSchema(BaseModel):
    id: UUID
    po_item_id: UUID
    received_qty: float

class GRNResponse(BaseModel):
    id: UUID
    company_id: UUID
    project_id: UUID
    po_id: UUID
    grn_number: str
    received_date: datetime
    received_by: Optional[UUID] = None
    created_at: datetime
    items: List[GRNResponseItemSchema] = []

    class Config:
        from_attributes = True

class InventoryResponse(BaseModel):
    id: UUID
    project_id: UUID
    material_name: str
    category: str = "Uncategorized"
    on_hand_qty: float
    reserved_qty: float
    unit: str
    created_at: datetime

    class Config:
        from_attributes = True

class TransactionResponse(BaseModel):
    id: UUID
    project_id: UUID
    material_name: str
    category: str = "Uncategorized"
    qty: float
    type: str
    unit: Optional[str] = None
    source_ref_id: Optional[UUID] = None
    reason: Optional[str] = None   # R2-387: why an adjustment restated the stock
    created_at: datetime

    class Config:
        from_attributes = True

# Computed stock (Received - Consumed + Adjustments), grouped by category on the frontend
class StockRow(BaseModel):
    inventory_id: Optional[UUID] = None
    category: str
    material_name: str
    unit: Optional[str] = None
    received: float = 0.0
    consumed: float = 0.0
    adjusted: float = 0.0        # net of "adjustment" corrections (R2-387); kept out of received/consumed
    current_stock: float = 0.0   # may be negative on over-consumption (no clamp)
    reserved: float = 0.0

    class Config:
        from_attributes = True

class TransactionCreateRequest(BaseModel):
    project_id: UUID
    material_name: str
    type: str                      # received, used, transferred, returned, adjustment
    qty: float
    category: str = "Uncategorized"
    unit: Optional[str] = None
    source_ref_id: Optional[UUID] = None
    # Marks a "used"/"transferred" movement as material issued to a subcontractor, so
    # Workflow Controls -> Material Controls -> Restrict Subcontractor Material Issue
    # can be checked independently of the generic Restrict Material Usage / Transfer flags.
    is_subcon_issue: bool = False
    # R2-387: an "adjustment" restates stock (physical count, write-off, opening
    # balance, negative-stock repair) without fabricating a consumption event.
    # The reason is mandatory and stored with the row; adjustments are excluded
    # from received/consumed aggregates so consumption analytics stay truthful.
    reason: Optional[str] = None

    @field_validator("qty")
    @classmethod
    def _qty_sign_by_type(cls, v: float, info) -> float:
        if info.data.get("type") == "adjustment":
            if v == 0:
                raise ValueError("an adjustment quantity cannot be zero")
            return v
        if v <= 0:
            raise ValueError("qty must be greater than 0")
        return v

class InventoryPatchRequest(BaseModel):
    category: Optional[str] = None
    unit: Optional[str] = None

# --- Endpoints ---

# Movement classification for stock math
RECEIVED_TYPES = {"received", "returned"}
CONSUMED_TYPES = {"used", "transferred"}
ADJUSTMENT_TYPES = {"adjustment"}

# 1. Indents
@router.get("/indents", response_model=List[IndentResponse])
def get_indents(
    project_id: Optional[UUID] = Query(None),
    company_id: Optional[UUID] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    if project_id is None and company_id is None:
        raise HTTPException(status_code=400, detail="Either project_id or company_id must be provided")

    if project_id is not None:
        project = db.query(Project).filter(Project.id == project_id).first()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        get_company_membership(db, current_user, project.company_id)
    else:
        get_company_membership(db, current_user, company_id)

    query = db.query(MaterialIndent)
    if project_id is not None:
        query = query.filter(MaterialIndent.project_id == project_id)
    else:
        query = query.filter(MaterialIndent.company_id == company_id)

    indents = query.all()
    res = []
    for ind in indents:
        items = db.query(MaterialIndentItem).filter(MaterialIndentItem.indent_id == ind.id).all()
        item_schemas = [
            IndentItemSchema(
                material_name=i.material_name,
                quantity=float(i.quantity),
                unit=i.unit
            ) for i in items
        ]
        res.append(
            IndentResponse(
                id=ind.id,
                company_id=ind.company_id,
                project_id=ind.project_id,
                requested_by=ind.requested_by,
                approved_by=ind.approved_by,
                approved_at=ind.approved_at,
                indent_number=ind.indent_number,
                status=ind.status,
                created_at=ind.created_at,
                items=item_schemas
            )
        )
    return res

@router.get("/indents/company/{company_id}", response_model=List[IndentResponse])
def get_company_indents(
    company_id: UUID,
    project_id: Optional[UUID] = None,
    status: Optional[str] = None,
    db: Session = Depends(get_db),
    _: None = Depends(verify_company_access),
):
    q = db.query(MaterialIndent).filter(MaterialIndent.company_id == company_id)
    if project_id:
        q = q.filter(MaterialIndent.project_id == project_id)
    if status:
        from sqlalchemy import func
        q = q.filter(func.lower(MaterialIndent.status) == status.strip().lower())
    indents = q.all()
    res = []
    for ind in indents:
        items = db.query(MaterialIndentItem).filter(MaterialIndentItem.indent_id == ind.id).all()
        item_schemas = [
            IndentItemSchema(
                material_name=i.material_name,
                quantity=float(i.quantity),
                unit=i.unit
            ) for i in items
        ]
        res.append(
            IndentResponse(
                id=ind.id,
                company_id=ind.company_id,
                project_id=ind.project_id,
                requested_by=ind.requested_by,
                approved_by=ind.approved_by,
                approved_at=ind.approved_at,
                indent_number=ind.indent_number,
                status=ind.status,
                created_at=ind.created_at,
                items=item_schemas
            )
        )
    return res

def _company_team_id_for_party(db: Session, company_id: UUID, party_id: UUID) -> UUID:
    """Resolve a Party Library entry to the company_team row a PO can point at.

    PurchaseOrder.vendor_id is FK -> company_team.id, so an external vendor needs
    a company_team row with no login, linked back to the party. Subcontractors
    created through /billing/subcontractors already get one; parties registered
    directly in the library do not. Create it on first use rather than making the
    user register the same vendor twice.
    """
    party = db.query(LibraryParty).filter(
        LibraryParty.id == party_id, LibraryParty.company_id == company_id
    ).first()
    if not party:
        raise HTTPException(status_code=404, detail="Vendor not found in the party library")

    team = db.query(CompanyTeam).filter(
        CompanyTeam.company_id == company_id,
        CompanyTeam.library_party_id == party_id,
    ).first()
    if team:
        return team.id

    team = CompanyTeam(
        company_id=company_id,
        user_id=None,
        priority_type=(party.party_type or "vendor").strip().lower() or "vendor",
        library_party_id=party.id,
    )
    db.add(team)
    db.flush()
    return team.id


def _generate_indent_number(db: Session, company_id: UUID, project_id: UUID) -> str:
    """Running IND-#### sequence, mirroring _generate_grn_number.

    The indent form leaves the number blank and nothing filled it in, so every
    indent raised through the UI was stored with indent_number "". An unnumbered
    requisition cannot be quoted to a vendor or referenced from a PO.
    """
    count = db.query(MaterialIndent).filter(MaterialIndent.company_id == company_id).count()
    candidate = f"IND-{count + 1:04d}"
    while db.query(MaterialIndent).filter(
        MaterialIndent.company_id == company_id, MaterialIndent.indent_number == candidate
    ).first():
        count += 1
        candidate = f"IND-{count + 1:04d}"
    return candidate


@router.post("/indents", response_model=IndentResponse, status_code=201)
def create_indent(req: IndentCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, req.company_id)
    verify_project_in_company(db, req.project_id, req.company_id)
    require_permission(db, current_user, req.company_id, "procurement:edit")
    indent_number = (req.indent_number or "").strip() or _generate_indent_number(
        db, req.company_id, req.project_id
    )
    # Check if indent number already exists for the company
    existing = db.query(MaterialIndent).filter(
        MaterialIndent.company_id == req.company_id,
        MaterialIndent.indent_number == indent_number
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Indent number already exists for this company")

    now = datetime.now(timezone.utc)
    indent = MaterialIndent(
        company_id=req.company_id,
        project_id=req.project_id,
        requested_by=req.requested_by,
        indent_number=indent_number,
        status="pending",
        created_at=now,
    )
    db.add(indent)
    db.flush()

    item_schemas = []
    for item in req.items:
        db_item = MaterialIndentItem(
            indent_id=indent.id,
            material_name=item.material_name,
            quantity=item.quantity,
            unit=item.unit,
            created_at=now,
        )
        db.add(db_item)
        item_schemas.append(item)

    db.commit()
    db.refresh(indent)

    return IndentResponse(
        id=indent.id,
        company_id=indent.company_id,
        project_id=indent.project_id,
        requested_by=indent.requested_by,
        approved_by=indent.approved_by,
        approved_at=indent.approved_at,
        indent_number=indent.indent_number,
        status=indent.status,
        created_at=indent.created_at,
        items=item_schemas
    )

@router.post("/indents/{indent_id}/approve", response_model=IndentResponse)
def approve_indent(indent_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    indent = db.query(MaterialIndent).filter(MaterialIndent.id == indent_id).first()
    if not indent:
        raise HTTPException(status_code=404, detail="Indent not found")
    membership = get_company_membership(db, current_user, indent.company_id)
    require_permission(db, current_user, indent.company_id, "procurement:approve")
    if indent.status != "pending":
        raise HTTPException(status_code=400, detail=f"Only pending indents can be approved (current status: {indent.status})")

    indent.status = "approved"
    indent.approved_by = membership.id
    indent.approved_at = datetime.now(timezone.utc)

    items = db.query(MaterialIndentItem).filter(MaterialIndentItem.indent_id == indent.id).all()
    for item in items:
        inv = db.query(WarehouseInventory).filter(
            WarehouseInventory.project_id == indent.project_id,
            WarehouseInventory.material_name == item.material_name
        ).first()
        if inv is None:
            item.reserved_qty = 0.0
            continue
        available = float(inv.on_hand_qty) - float(inv.reserved_qty)
        to_reserve = min(float(item.quantity), max(0.0, available))
        inv.reserved_qty = float(inv.reserved_qty) + to_reserve
        item.reserved_qty = to_reserve
        db.add(inv)
        db.add(item)

    db.commit()
    db.refresh(indent)

    item_schemas = [
        IndentItemSchema(
            material_name=i.material_name,
            quantity=float(i.quantity),
            unit=i.unit
        ) for i in items
    ]
    return IndentResponse(
        id=indent.id,
        company_id=indent.company_id,
        project_id=indent.project_id,
        requested_by=indent.requested_by,
        approved_by=indent.approved_by,
        approved_at=indent.approved_at,
        indent_number=indent.indent_number,
        status=indent.status,
        created_at=indent.created_at,
        items=item_schemas
    )

@router.post("/indents/{indent_id}/reject", response_model=IndentResponse)
def reject_indent(indent_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    indent = db.query(MaterialIndent).filter(MaterialIndent.id == indent_id).first()
    if not indent:
        raise HTTPException(status_code=404, detail="Indent not found")
    get_company_membership(db, current_user, indent.company_id)
    require_permission(db, current_user, indent.company_id, "procurement:approve")
    if indent.status != "pending":
        raise HTTPException(status_code=400, detail=f"Only pending indents can be rejected (current status: {indent.status})")

    indent.status = "rejected"

    items = db.query(MaterialIndentItem).filter(MaterialIndentItem.indent_id == indent.id).all()
    for item in items:
        if item.reserved_qty and float(item.reserved_qty) > 0:
            inv = db.query(WarehouseInventory).filter(
                WarehouseInventory.project_id == indent.project_id,
                WarehouseInventory.material_name == item.material_name
            ).first()
            if inv:
                inv.reserved_qty = max(0.0, float(inv.reserved_qty) - float(item.reserved_qty))
                db.add(inv)
            item.reserved_qty = 0.0
            db.add(item)

    db.commit()
    db.refresh(indent)

    items = db.query(MaterialIndentItem).filter(MaterialIndentItem.indent_id == indent.id).all()
    item_schemas = [
        IndentItemSchema(
            material_name=i.material_name,
            quantity=float(i.quantity),
            unit=i.unit
        ) for i in items
    ]
    return IndentResponse(
        id=indent.id,
        company_id=indent.company_id,
        project_id=indent.project_id,
        requested_by=indent.requested_by,
        approved_by=indent.approved_by,
        approved_at=indent.approved_at,
        indent_number=indent.indent_number,
        status=indent.status,
        created_at=indent.created_at,
        items=item_schemas
    )

@router.post("/indents/{indent_id}/cancel", response_model=IndentResponse)
def cancel_indent(indent_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    indent = db.query(MaterialIndent).filter(MaterialIndent.id == indent_id).first()
    if not indent:
        raise HTTPException(status_code=404, detail="Indent not found")
    get_company_membership(db, current_user, indent.company_id)
    require_permission(db, current_user, indent.company_id, "procurement:approve")
    if indent.status not in ["approved", "ordered"]:
        raise HTTPException(status_code=400, detail=f"Only approved or ordered indents can be cancelled (current status: {indent.status})")

    indent.status = "cancelled"

    items = db.query(MaterialIndentItem).filter(MaterialIndentItem.indent_id == indent.id).all()
    for item in items:
        if item.reserved_qty and float(item.reserved_qty) > 0:
            inv = db.query(WarehouseInventory).filter(
                WarehouseInventory.project_id == indent.project_id,
                WarehouseInventory.material_name == item.material_name
            ).first()
            if inv:
                inv.reserved_qty = max(0.0, float(inv.reserved_qty) - float(item.reserved_qty))
                db.add(inv)
            item.reserved_qty = 0.0
            db.add(item)

    db.commit()
    db.refresh(indent)

    items = db.query(MaterialIndentItem).filter(MaterialIndentItem.indent_id == indent.id).all()
    item_schemas = [
        IndentItemSchema(
            material_name=i.material_name,
            quantity=float(i.quantity),
            unit=i.unit
        ) for i in items
    ]
    return IndentResponse(
        id=indent.id,
        company_id=indent.company_id,
        project_id=indent.project_id,
        requested_by=indent.requested_by,
        approved_by=indent.approved_by,
        approved_at=indent.approved_at,
        indent_number=indent.indent_number,
        status=indent.status,
        created_at=indent.created_at,
        items=item_schemas
    )

# 2. Purchase Orders

# R2-179: PO_FEATURE_TYPE comes from app/approvals.py.


def _po_response(db: Session, po: PurchaseOrder) -> POResponse:
    items = db.query(PurchaseOrderItem).filter(PurchaseOrderItem.po_id == po.id).all()
    item_schemas = [
        POResponseItemSchema(
            id=i.id,
            material_name=i.material_name,
            quantity=float(i.quantity),
            unit=i.unit,
            rate=float(i.rate),
            tax_pct=float(i.tax_pct),
            total_amount=float(i.total_amount) if i.total_amount else float(i.quantity * i.rate)
        ) for i in items
    ]
    vendor_name = None
    if po.vendor_id:
        team = db.query(CompanyTeam).filter(CompanyTeam.id == po.vendor_id).first()
        if team:
            if team.user_id:
                user = db.query(User).filter(User.id == team.user_id).first()
                vendor_name = user.name if user and user.name else None
            if not vendor_name and team.library_party_id:
                party = db.query(LibraryParty).filter(LibraryParty.id == team.library_party_id).first()
                vendor_name = party.name if party else None
    levels_required = 0
    if po.approval_rule_id:
        rule = db.query(ApprovalRule).filter(ApprovalRule.id == po.approval_rule_id).first()
        levels_required = rule.levels if rule else 0
    return POResponse(
        id=po.id,
        company_id=po.company_id,
        project_id=po.project_id,
        vendor_id=po.vendor_id,
        vendor_name=vendor_name,
        indent_id=po.indent_id,
        po_number=po.po_number,
        po_date=po.po_date,
        expected_delivery_date=po.expected_delivery_date,
        status=po.status,
        gross_amount=float(po.gross_amount),
        tax_amount=float(po.tax_amount),
        total_amount=float(po.total_amount),
        approval_flag=po.approval_flag,
        approval_rule_id=po.approval_rule_id,
        approvals_required=levels_required,
        approvals_completed=levels_approved(db, "purchase_order", po.id) if po.approval_rule_id else 0,
        created_at=po.created_at,
        terms=po.terms,
        items=item_schemas
    )


@router.get("/pos", response_model=List[POResponse])
def get_pos(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    pos = db.query(PurchaseOrder).filter(PurchaseOrder.project_id == project_id).all()
    return [_po_response(db, po) for po in pos]

@router.post("/pos", response_model=POResponse, status_code=201)
def create_po(req: POCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, req.company_id)
    verify_project_in_company(db, req.project_id, req.company_id)
    require_permission(db, current_user, req.company_id, "procurement:edit")
    # R2-478: Settings -> Workflow Controls -> Material Purchase Order
    # Restriction was stored and rendered but read by nothing. With the control
    # armed, purchase orders may only be raised from an approved material indent
    # (R2-372 linkage); direct unlinked PO creation is refused.
    _company = get_company(db, req.company_id)
    if _company and _company.po_restriction and req.indent_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Material Purchase Order Restriction: purchase orders may only be raised from an approved material indent",
        )
    # Check if PO number already exists
    existing = db.query(PurchaseOrder).filter(
        PurchaseOrder.company_id == req.company_id,
        PurchaseOrder.po_number == req.po_number
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="PO number already exists for this company")

    # R2-372: a PO raised from an indent carries the link, may only come off an
    # APPROVED indent (so one approval cannot be ordered repeatedly - the flip
    # to "ordered" below consumes it), and may never exceed what the indent
    # approved per material. Validated before anything is written.
    indent = None
    if req.indent_id is not None:
        indent = db.query(MaterialIndent).filter(MaterialIndent.id == req.indent_id).first()
        if not indent:
            raise HTTPException(status_code=404, detail="Material indent not found")
        if indent.company_id != req.company_id or indent.project_id != req.project_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Material indent does not belong to the supplied company/project",
            )
        if indent.status != "approved":
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Purchase orders can only be raised from an approved indent "
                    f"(indent {indent.indent_number} current status: {indent.status})"
                ),
            )
        approved_qty: dict = {}
        for ii in db.query(MaterialIndentItem).filter(MaterialIndentItem.indent_id == indent.id).all():
            approved_qty[ii.material_name] = approved_qty.get(ii.material_name, 0.0) + float(ii.quantity or 0.0)
        requested_qty: dict = {}
        for item in req.items:
            requested_qty[item.material_name] = requested_qty.get(item.material_name, 0.0) + float(item.quantity)
        for name, qty in requested_qty.items():
            allowed = approved_qty.get(name)
            if allowed is None:
                raise HTTPException(
                    status_code=422,
                    detail=f"'{name}' is not on indent {indent.indent_number}; only approved indent items may be ordered",
                )
            if qty > allowed + 1e-9:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"'{name}': indent {indent.indent_number} approved {round(allowed, 4)}, "
                        f"this PO requests {round(qty, 4)}"
                    ),
                )

    gross_amount = 0.0
    tax_amount = 0.0

    po_items = []
    for item in req.items:
        item_gross = item.quantity * item.rate
        item_tax = item_gross * (item.tax_pct / 100.0)
        item_total = item_gross + item_tax

        gross_amount += item_gross
        tax_amount += item_tax

        po_items.append((item, item_total))

    total_amount = gross_amount + tax_amount
    matched_rule = find_matching_rule(db, req.company_id, PO_FEATURE_TYPE, total_amount)

    vendor_id = req.vendor_id
    if vendor_id is None and req.vendor_party_id is not None:
        vendor_id = _company_team_id_for_party(db, req.company_id, req.vendor_party_id)

    po = PurchaseOrder(
        company_id=req.company_id,
        project_id=req.project_id,
        vendor_id=vendor_id,
        indent_id=indent.id if indent is not None else None,
        po_number=req.po_number,
        po_date=req.po_date,
        expected_delivery_date=req.expected_delivery_date,
        status="draft",
        gross_amount=gross_amount,
        tax_amount=tax_amount,
        total_amount=total_amount,
        # A configured ApprovalRule gates this PO: it starts life needing
        # `matched_rule.levels` sign-offs before approve_po can mark it
        # approved/sent. No matching rule = unchanged legacy behaviour
        # (single approve_po call finalizes it).
        approval_flag="pending_approval" if matched_rule else "pending",
        approval_rule_id=matched_rule.id if matched_rule else None,
        # Settings -> Terms & Conditions -> Purchase Order Terms: pre-fill the
        # company default when the caller doesn't supply their own terms.
        terms=req.terms
        if req.terms
        else get_default_terms(db, req.company_id, "purchase_order"),
    )
    db.add(po)
    db.flush()

    for item, total in po_items:
        db_item = PurchaseOrderItem(
            po_id=po.id,
            material_name=item.material_name,
            quantity=item.quantity,
            unit=item.unit,
            rate=item.rate,
            tax_pct=item.tax_pct,
            total_amount=total
        )
        db.add(db_item)

    # R2-372: the approved indent is now consumed - "ordered" removes it from
    # the approvable pool so the same approval can never fund a second PO.
    if indent is not None:
        indent.status = "ordered"

    db.commit()
    db.refresh(po)

    return _po_response(db, po)

@router.post("/pos/{po_id}/approve", response_model=POResponse)
def approve_po(po_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == po_id).first()
    if not po:
        raise HTTPException(status_code=404, detail="PO not found")
    get_company_membership(db, current_user, po.company_id)
    require_permission(db, current_user, po.company_id, "procurement:approve")
    # CD-8 (R2-341): cancelled/closed POs are terminal — cannot be approved.
    if (po.status or "").lower() in ("cancelled", "closed"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Cannot approve a PO that is {po.status}")
    if po.approval_flag == "approved":
        raise HTTPException(status_code=400, detail="Purchase order is already fully approved")
    if po.approval_flag == "rejected":
        raise HTTPException(status_code=400, detail="Purchase order was rejected; cannot approve")

    rule = db.query(ApprovalRule).filter(ApprovalRule.id == po.approval_rule_id).first() if po.approval_rule_id else None

    if rule:
        matched = match_approver(rule.approvers, current_user)
        if not matched:
            raise HTTPException(status_code=403, detail="You are not a configured approver for this purchase order")
        if user_already_acted(db, "purchase_order", po.id, current_user.id):
            raise HTTPException(status_code=400, detail="You have already recorded a decision on this purchase order")

        next_level = levels_approved(db, "purchase_order", po.id) + 1
        record_action(
            db, company_id=po.company_id, rule_id=rule.id, entity_type="purchase_order", entity_id=po.id,
            level=next_level, action="approved", user=current_user, matched_label=matched,
        )
        if next_level >= rule.levels:
            po.approval_flag = "approved"
            _advance_to_sent_if_behind(po)
        # else: still pending_approval, awaiting further levels
    else:
        po.approval_flag = "approved"
        _advance_to_sent_if_behind(po)

    db.commit()
    db.refresh(po)
    return _po_response(db, po)


@router.post("/pos/{po_id}/reject", response_model=POResponse)
def reject_po(po_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == po_id).first()
    if not po:
        raise HTTPException(status_code=404, detail="PO not found")
    get_company_membership(db, current_user, po.company_id)
    require_permission(db, current_user, po.company_id, "procurement:approve")
    if (po.status or "").lower() in ("cancelled", "closed"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Cannot reject a PO that is {po.status}")
    if po.approval_flag == "approved":
        raise HTTPException(status_code=400, detail="Purchase order is already fully approved")
    if po.approval_flag == "rejected":
        raise HTTPException(status_code=400, detail="Purchase order is already rejected")

    rule = db.query(ApprovalRule).filter(ApprovalRule.id == po.approval_rule_id).first() if po.approval_rule_id else None
    if rule:
        matched = match_approver(rule.approvers, current_user)
        if not matched:
            raise HTTPException(status_code=403, detail="You are not a configured approver for this purchase order")
        record_action(
            db, company_id=po.company_id, rule_id=rule.id, entity_type="purchase_order", entity_id=po.id,
            level=levels_approved(db, "purchase_order", po.id) + 1, action="rejected", user=current_user, matched_label=matched,
        )

    po.approval_flag = "rejected"
    db.commit()
    db.refresh(po)
    return _po_response(db, po)


@router.post("/pos/{po_id}/cancel", response_model=POResponse)
def cancel_po(po_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """CD-8 (R2-341) — PO cancel, replicated from R2-370 bill-cancel.

    Guard: 409 if already cancelled or closed (terminal states). Sets
    cancelled_at/cancelled_by and moves status to "cancelled" so every
    committed-cost aggregation (which filters on status in sent/partial/received)
    excludes it from the start — no missed call site like R2-723.
    """
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == po_id).first()
    if not po:
        raise HTTPException(status_code=404, detail="PO not found")
    get_company_membership(db, current_user, po.company_id)
    require_permission(db, current_user, po.company_id, "procurement:edit")
    cur = (po.status or "").lower()
    if cur in ("cancelled", "closed"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Purchase order is already {cur}")
    po.status = "cancelled"
    po.cancelled_at = datetime.now(timezone.utc)
    po.cancelled_by = current_user.id
    db.add(po)
    db.commit()
    db.refresh(po)
    return _po_response(db, po)


@router.post("/pos/{po_id}/close", response_model=POResponse)
def close_po(po_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """CD-8 (R2-341) — PO close, terminal state sibling to cancel.

    A closed PO is fulfilled and must also be excluded from open committed
    sums; the guard mirrors cancel so a second close/cancel is 409.
    """
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == po_id).first()
    if not po:
        raise HTTPException(status_code=404, detail="PO not found")
    get_company_membership(db, current_user, po.company_id)
    require_permission(db, current_user, po.company_id, "procurement:edit")
    cur = (po.status or "").lower()
    if cur in ("cancelled", "closed"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Purchase order is already {cur}")
    po.status = "closed"
    db.add(po)
    db.commit()
    db.refresh(po)
    return _po_response(db, po)

# 3. Goods Receipt Notes (GRN) & Inventory State Trigger

def _generate_grn_number(db: Session, company_id: UUID, project_id: UUID) -> str:
    """Settings -> Workflow Controls -> Material Controls -> GRN Numbering.
    'Project Level' scopes the running sequence to the project; 'Company
    Level' shares one running sequence across every project in the company."""
    company = get_company(db, company_id)
    scope = (company.grn_numbering if company else None) or "Project Level"
    if scope == "Company Level":
        count = db.query(GoodsReceiptNote).filter(GoodsReceiptNote.company_id == company_id).count()
    else:
        count = db.query(GoodsReceiptNote).filter(GoodsReceiptNote.project_id == project_id).count()
    candidate = f"GRN-{count + 1:04d}"
    # Guard against a rare collision (e.g. concurrent creates) by bumping until free.
    while db.query(GoodsReceiptNote).filter(
        GoodsReceiptNote.company_id == company_id, GoodsReceiptNote.grn_number == candidate
    ).first():
        count += 1
        candidate = f"GRN-{count + 1:04d}"
    return candidate


# Purchase order lifecycle ranks for forward-only status movement from goods
# receipt (R2-239/R2-348): a GRN may advance a PO along draft -> sent ->
# partial -> received, never rewind it, and "closed"/"cancelled" outrank them all.
# CD-8 (R2-341): cancelled is terminal like closed — a cancelled PO must never
# be revived by a later GRN or approval; rank 4 blocks forward movement.
_PO_STATUS_RANK = {
    "draft": 0,
    "pending": 0,
    "pending_approval": 0,
    "sent": 1,
    "partial": 2,
    "partially_received": 2,
    "received": 3,
    "closed": 4,
    "cancelled": 4,
}


def _advance_to_sent_if_behind(po) -> None:
    # R2-219: approval authorises a PO, it never rewrites fulfilment. Only a
    # PO that has not yet been sent is lifted to "sent" (same forward-only
    # rank map goods receipt uses), so approving after delivery can no longer
    # rewind a partial/received/closed PO and re-open goods receipt.
    if _PO_STATUS_RANK.get((po.status or "").lower(), 0) < _PO_STATUS_RANK["sent"]:
        po.status = "sent"


@router.get("/grns", response_model=List[GRNResponse])
def get_grns(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    grns = db.query(GoodsReceiptNote).filter(GoodsReceiptNote.project_id == project_id).all()
    res = []
    for g in grns:
        items = db.query(GRNItem).filter(GRNItem.grn_id == g.id).all()
        item_schemas = [
            GRNResponseItemSchema(
                id=i.id,
                po_item_id=i.po_item_id,
                received_qty=float(i.received_qty)
            ) for i in items
        ]
        res.append(
            GRNResponse(
                id=g.id,
                company_id=g.company_id,
                project_id=g.project_id,
                po_id=g.po_id,
                grn_number=g.grn_number,
                received_date=g.received_date,
                received_by=g.received_by,
                created_at=g.created_at,
                items=item_schemas
            )
        )
    return res

@router.post("/grns", response_model=GRNResponse, status_code=201)
def create_grn(req: GRNCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, req.company_id)
    require_permission(db, current_user, req.company_id, "procurement:edit")
    # Workflow Controls: Entry Controls (creation date window) — a GRN dated
    # outside the window must be rejected like any other back-dated entry.
    enforce_entry_creation_window(db, req.company_id, req.received_date)
    grn_number = req.grn_number.strip() if req.grn_number else None
    if not grn_number:
        grn_number = _generate_grn_number(db, req.company_id, req.project_id)

    # Check if GRN number already exists
    existing = db.query(GoodsReceiptNote).filter(
        GoodsReceiptNote.company_id == req.company_id,
        GoodsReceiptNote.grn_number == grn_number
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="GRN number already exists for this company")

    # 1. Check PO exists and belongs to this company/project
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == req.po_id).first()
    if not po:
        raise HTTPException(status_code=404, detail="Purchase Order not found")
    if po.company_id != req.company_id or po.project_id != req.project_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Purchase Order does not belong to the supplied company/project",
        )

    # R2-239/R2-348: goods receipt is only legal against an APPROVED purchase
    # order. Receiving stock must never be the act that pushes an unapproved
    # PO through its lifecycle.
    if (po.approval_flag or "").lower() != "approved":
        raise HTTPException(
            status_code=422,
            detail=(
                f"Purchase order is not approved (approval_flag='{po.approval_flag}', "
                f"status='{po.status}'); goods receipt requires an approved PO"
            ),
        )
    # CD-8 (R2-341): cancelled/closed POs are terminal — no further receipt.
    if (po.status or "").lower() in ("cancelled", "closed"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Cannot receive goods for a PO that is {po.status}")

    # R2-348: cap what this GRN may receive per line. Cumulative received
    # across every earlier GRN plus every earlier line of THIS request may
    # never exceed the ordered quantity (no configured tolerance exists, so
    # the cap is exact up to float noise). Validated before anything is
    # written so a rejection leaves zero partial state behind.
    po_lines = db.query(PurchaseOrderItem).filter(PurchaseOrderItem.po_id == req.po_id).all()
    ordered_by_line = {pi.id: float(pi.quantity or 0.0) for pi in po_lines}
    already_received: dict = {}
    prior_items = (
        db.query(GRNItem)
        .join(GoodsReceiptNote, GoodsReceiptNote.id == GRNItem.grn_id)
        .filter(GoodsReceiptNote.po_id == req.po_id)
        .all()
    )
    for gi in prior_items:
        already_received[gi.po_item_id] = already_received.get(gi.po_item_id, 0.0) + float(gi.received_qty or 0.0)

    line_by_id: dict = {}
    pending_in_request: dict = {}
    for line_no, item in enumerate(req.items, start=1):
        po_item = db.query(PurchaseOrderItem).filter(PurchaseOrderItem.id == item.po_item_id).first()
        if not po_item:
            raise HTTPException(status_code=400, detail=f"PO Item {item.po_item_id} not found")
        if po_item.po_id != req.po_id:
            raise HTTPException(
                status_code=400,
                detail=f"PO Item {item.po_item_id} does not belong to PO {req.po_id}",
            )
        ordered = ordered_by_line.get(po_item.id, 0.0)
        received_so_far = already_received.get(po_item.id, 0.0) + pending_in_request.get(po_item.id, 0.0)
        remaining = ordered - received_so_far
        if item.received_qty > remaining + 1e-9:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Over-receipt blocked on PO item line {line_no} ('{po_item.material_name}'): "
                    f"ordered {ordered}, already received {round(received_so_far, 4)}, "
                    f"requested {round(item.received_qty, 4)}; only {round(max(remaining, 0.0), 4)} remains"
                ),
            )
        pending_in_request[po_item.id] = pending_in_request.get(po_item.id, 0.0) + item.received_qty
        line_by_id[po_item.id] = po_item

    grn = GoodsReceiptNote(
        company_id=req.company_id,
        project_id=req.project_id,
        po_id=req.po_id,
        grn_number=grn_number,
        received_date=req.received_date,
        received_by=req.received_by
    )
    db.add(grn)
    db.flush()

    item_responses = []
    for item in req.items:
        # Identity already validated above; reuse the cached PO line.
        po_item = line_by_id[item.po_item_id]

        # 2. Create GRN item
        db_item = GRNItem(
            grn_id=grn.id,
            po_item_id=item.po_item_id,
            received_qty=item.received_qty
        )
        db.add(db_item)
        db.flush()

        item_responses.append(
            GRNResponseItemSchema(
                id=db_item.id,
                po_item_id=db_item.po_item_id,
                received_qty=float(db_item.received_qty)
            )
        )

        # 3. STATEFUL INVENTORY TRIGGER: Increment WarehouseInventory levels
        inv = db.query(WarehouseInventory).filter(
            WarehouseInventory.project_id == req.project_id,
            WarehouseInventory.material_name == po_item.material_name
        ).first()

        if inv:
            inv.on_hand_qty = float(inv.on_hand_qty) + item.received_qty
        else:
            # Take the category from the Material Library entry of the same name,
            # otherwise every received material lands in stock as "Uncategorized"
            # and the category the user set in the library is never seen again.
            lib = db.query(LibraryMaterial.category).filter(
                LibraryMaterial.company_id == req.company_id,
                func.lower(LibraryMaterial.name) == po_item.material_name.strip().lower(),
            ).first()
            inv = WarehouseInventory(
                project_id=req.project_id,
                material_name=po_item.material_name,
                category=(lib.category if lib and lib.category else "Uncategorized"),
                on_hand_qty=item.received_qty,
                reserved_qty=0.0,
                unit=po_item.unit
            )
            db.add(inv)
            db.flush()

        # 4. STATEFUL TRANSACTION LOG: Write to material_transactions
        txn = MaterialTransaction(
            project_id=req.project_id,
            material_name=po_item.material_name,
            qty=item.received_qty,
            type="received",
            unit=po_item.unit,
            category=inv.category,
            source_ref_id=grn.id
        )
        db.add(txn)

    # 5. Recompute PO status from received quantity vs ordered quantity across
    #    ALL of the PO's line items (across every GRN). A PO is "received" only
    #    once every ordered line item has been fully received; otherwise it's
    #    "partially_received" if some (but not all) quantity is in. Movement is
    #    FORWARD-ONLY (R2-239/R2-348): a receipt may advance the lifecycle
    #    (sent -> partial -> received) but never rewind it, and a closed PO
    #    stays closed.
    po_items = db.query(PurchaseOrderItem).filter(PurchaseOrderItem.po_id == req.po_id).all()
    if po_items:
        received_by_po_item = {pi.id: 0.0 for pi in po_items}
        grn_items = db.query(GRNItem).join(GoodsReceiptNote).filter(
            GoodsReceiptNote.po_id == req.po_id
        ).all()
        for gi in grn_items:
            if gi.po_item_id in received_by_po_item:
                received_by_po_item[gi.po_item_id] += float(gi.received_qty)

        fully_received = all(
            received_by_po_item[pi.id] >= float(pi.quantity) - 1e-9 for pi in po_items
        )
        some_received = any(
            received_by_po_item[pi.id] > 0.0 for pi in po_items
        )
        computed = "received" if fully_received else ("partial" if some_received else None)
        if computed and _PO_STATUS_RANK.get(computed, 0) > _PO_STATUS_RANK.get((po.status or "").lower(), 0):
            po.status = computed
        # else: nothing received yet, or the PO already sits at this or a later
        # stage -> leave PO status unchanged (no rewind, no invented jumps)
    # An empty PO gains no status from receiving nothing.
    
    db.commit()
    db.refresh(grn)

    from app.routers.vendor_performance import refresh_vendor_performance
    try:
        refresh_vendor_performance(db, req.project_id, req.company_id)
    except Exception as exc:
        logger.exception("Failed to refresh vendor performance after GRN %s: %s", grn.id, exc)

    return GRNResponse(
        id=grn.id,
        company_id=grn.company_id,
        project_id=grn.project_id,
        po_id=grn.po_id,
        grn_number=grn.grn_number,
        received_date=grn.received_date,
        received_by=grn.received_by,
        created_at=grn.created_at,
        items=item_responses
    )

@router.post("/grns/{grn_id}/cancel", status_code=200)
def cancel_grn(grn_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    grn = db.query(GoodsReceiptNote).filter(GoodsReceiptNote.id == grn_id).first()
    if not grn:
        raise HTTPException(status_code=404, detail="GRN not found")
    get_company_membership(db, current_user, grn.company_id)
    require_permission(db, current_user, grn.company_id, "procurement:edit")
    enforce_entry_editing_window(db, grn.company_id, grn.created_at)

    # Check if already cancelled
    existing_reversal = db.query(MaterialTransaction).filter(
        MaterialTransaction.source_ref_id == grn.id,
        MaterialTransaction.type == "grn_cancellation"
    ).first()
    if existing_reversal:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="GRN is already cancelled")

    # Reverse inventory and log reversal transactions
    grn_items = db.query(GRNItem).filter(GRNItem.grn_id == grn.id).all()
    for item in grn_items:
        po_item = db.query(PurchaseOrderItem).filter(PurchaseOrderItem.id == item.po_item_id).first()
        mat_name = po_item.material_name if po_item else "Unknown"
        unit = po_item.unit if po_item else "Unit"

        inv = db.query(WarehouseInventory).filter(
            WarehouseInventory.project_id == grn.project_id,
            WarehouseInventory.material_name == mat_name
        ).first()

        if inv:
            inv.on_hand_qty = float(inv.on_hand_qty) - float(item.received_qty)

        txn = MaterialTransaction(
            project_id=grn.project_id,
            material_name=mat_name,
            qty=-float(item.received_qty),
            type="grn_cancellation",
            unit=unit,
            category=inv.category if inv else "Uncategorized",
            source_ref_id=grn.id
        )
        db.add(txn)

    # If linked to a PO, recalculate PO status if needed
    if grn.po_id:
        po = db.query(PurchaseOrder).filter(PurchaseOrder.id == grn.po_id).first()
        if po and (po.status or "").lower() not in ("cancelled", "closed"):
            all_grn_items = (
                db.query(GRNItem)
                .join(GoodsReceiptNote, GoodsReceiptNote.id == GRNItem.grn_id)
                .filter(GoodsReceiptNote.po_id == grn.po_id)
                .all()
            )
            cancelled_grn_ids = set(
                row[0] for row in db.query(MaterialTransaction.source_ref_id)
                .filter(MaterialTransaction.type == "grn_cancellation")
                .all()
            )
            cancelled_grn_ids.add(grn.id)

            po_items = db.query(PurchaseOrderItem).filter(PurchaseOrderItem.po_id == grn.po_id).all()
            if po_items:
                received_by_po_item = {pi.id: 0.0 for pi in po_items}
                for gi in all_grn_items:
                    if gi.grn_id not in cancelled_grn_ids and gi.po_item_id in received_by_po_item:
                        received_by_po_item[gi.po_item_id] += float(gi.received_qty)

                fully_received = all(
                    received_by_po_item[pi.id] >= float(pi.quantity) - 1e-9 for pi in po_items
                )
                some_received = any(
                    received_by_po_item[pi.id] > 0.0 for pi in po_items
                )
                po.status = "received" if fully_received else ("partial" if some_received else "approved")

    db.commit()

    from app.routers.vendor_performance import refresh_vendor_performance
    try:
        refresh_vendor_performance(db, grn.project_id, grn.company_id)
    except Exception as exc:
        logger.exception("Failed to refresh vendor performance after cancelling GRN %s: %s", grn.id, exc)

    return {"detail": "GRN cancelled and inventory movement reversed", "id": str(grn.id), "status": "cancelled"}

# 4. Warehouse Inventory
@router.get("/inventory", response_model=List[InventoryResponse])
def get_inventory(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    inv = db.query(WarehouseInventory).filter(WarehouseInventory.project_id == project_id).all()
    return [
        InventoryResponse(
            id=i.id,
            project_id=i.project_id,
            material_name=i.material_name,
            on_hand_qty=float(i.on_hand_qty),
            reserved_qty=float(i.reserved_qty),
            unit=i.unit,
            created_at=i.created_at
        ) for i in inv
    ]

# 5. Material Transactions
@router.get("/transactions", response_model=List[TransactionResponse])
def get_transactions(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    txns = db.query(MaterialTransaction).filter(MaterialTransaction.project_id == project_id).order_by(MaterialTransaction.created_at.desc()).all()
    return [
        TransactionResponse(
            id=t.id,
            project_id=t.project_id,
            material_name=t.material_name,
            category=t.category,
            qty=float(t.qty),
            type=t.type,
            unit=t.unit,
            source_ref_id=t.source_ref_id,
            reason=t.reason if t.type in ADJUSTMENT_TYPES else None,
            created_at=t.created_at
        ) for t in txns
    ]


# 6. Computed Stock (Received - Consumed), negative allowed
@router.get("/stock", response_model=List[StockRow])
def get_stock(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    invs = db.query(WarehouseInventory).filter(WarehouseInventory.project_id == project_id).all()
    txns = db.query(MaterialTransaction).filter(MaterialTransaction.project_id == project_id).all()

    # R2-239/R2-348: receipt is capped at the ordered quantity per PO line, so
    # stock views must never report more received than the project actually
    # ordered. Clamp the per-material ledger aggregate at the total ordered
    # across all of the project's POs; materials with no PO line (manual
    # receipts) are untouched. Over-consumption stays visible as a negative.
    # CD-8 (R2-341): cancelled/closed POs never contribute to the ceiling — a
    # cancelled PO's ordered quantity must not inflate the "received" cap, and
    # the committed-cost aggregations below already exclude them via the
    # sent/partial/received inclusion list.
    ordered_totals = {
        name: float(total or 0.0)
        for name, total in (
            db.query(PurchaseOrderItem.material_name, func.sum(PurchaseOrderItem.quantity))
            .join(PurchaseOrder, PurchaseOrder.id == PurchaseOrderItem.po_id)
            .filter(
                PurchaseOrder.project_id == project_id,
                PurchaseOrder.status.notin_(["cancelled", "closed"]),
            )
            .group_by(PurchaseOrderItem.material_name)
            .all()
        )
    }

    received: dict = {}
    consumed: dict = {}
    adjusted: dict = {}
    txn_cat: dict = {}
    txn_unit: dict = {}
    for t in txns:
        key = t.material_name
        txn_cat.setdefault(key, t.category)
        if t.unit:
            txn_unit.setdefault(key, t.unit)
        if t.type in RECEIVED_TYPES:
            received[key] = received.get(key, 0.0) + float(t.qty)
        elif t.type in CONSUMED_TYPES:
            consumed[key] = consumed.get(key, 0.0) + float(t.qty)
        elif t.type in ADJUSTMENT_TYPES:
            # R2-387: corrections carry a signed delta of their own and never
            # pollute the received/consumed figures the reports read.
            adjusted[key] = adjusted.get(key, 0.0) + float(t.qty)

    names = set(received) | set(consumed) | {i.material_name for i in invs}
    rows = []
    for name in sorted(names):
        inv = next((i for i in invs if i.material_name == name), None)
        r = received.get(name, 0.0)
        ceiling = ordered_totals.get(name)
        if ceiling is not None:
            r = min(r, ceiling)   # never show more received than was ordered
        c = consumed.get(name, 0.0)
        adj = adjusted.get(name, 0.0)
        cat = (inv.category if inv else None) or txn_cat.get(name) or "Uncategorized"
        unit = (inv.unit if inv and inv.unit else None) or txn_unit.get(name)
        rows.append(StockRow(
            inventory_id=inv.id if inv else None,
            category=cat,
            material_name=name,
            unit=unit,
            received=round(r, 4),
            consumed=round(c, 4),
            adjusted=round(adj, 4),
            current_stock=round(r - c + adj, 4),   # NO CLAMP — over-consumption goes negative
            reserved=round(float(inv.reserved_qty), 4) if inv else 0.0,
        ))
    rows.sort(key=lambda x: (x.category, x.material_name))
    return rows


# 7. Record a manual material movement (receive / issue), syncs inventory
@router.post("/transactions", response_model=TransactionResponse, status_code=status.HTTP_201_CREATED)
def create_transaction(req: TransactionCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == req.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "procurement:edit")

    if req.type not in RECEIVED_TYPES and req.type not in CONSUMED_TYPES and req.type not in ADJUSTMENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported type '{req.type}'. Use one of {sorted(RECEIVED_TYPES | CONSUMED_TYPES | ADJUSTMENT_TYPES)}",
        )

    # R2-387: a stock correction must say why. The reason is stored on the row
    # so the audit trail shows a deliberate restatement, not a phantom movement.
    if req.type == "adjustment" and not (req.reason or "").strip():
        raise HTTPException(status_code=422, detail="An inventory adjustment requires a reason describing the correction")

    # Workflow Controls: Material Controls (insufficient-stock restrictions)
    if req.type in CONSUMED_TYPES:
        company = get_company(db, project.company_id)
        if company:
            if req.is_subcon_issue:
                if company.restrict_subcon_material_issue:
                    enforce_stock_availability(db, req.project_id, req.material_name, req.qty, "Restrict Subcontractor Material Issue")
            elif req.type == "transferred":
                if company.restrict_material_transfer:
                    enforce_stock_availability(db, req.project_id, req.material_name, req.qty, "Restrict Material Transfer")
            elif req.type == "used":
                if company.negative_stock_lock:
                    enforce_stock_availability(db, req.project_id, req.material_name, req.qty, "Restrict Material Usage")

    txn = MaterialTransaction(
        project_id=req.project_id,
        material_name=req.material_name,
        category=req.category,
        qty=req.qty,
        type=req.type,
        unit=req.unit,
        source_ref_id=req.source_ref_id,
        reason=req.reason if req.type == "adjustment" else None,
    )
    db.add(txn)
    db.flush()

    if req.type in RECEIVED_TYPES:
        delta = req.qty
    elif req.type in ADJUSTMENT_TYPES:
        delta = req.qty   # signed: positive restates stock up, negative writes it off
    else:
        delta = -req.qty

    inv = db.query(WarehouseInventory).filter(
        WarehouseInventory.project_id == req.project_id,
        WarehouseInventory.material_name == req.material_name,
    ).first()
    if inv:
        inv.on_hand_qty = float(inv.on_hand_qty) + delta
        if req.unit:
            inv.unit = req.unit
    else:
        inv = WarehouseInventory(
            project_id=req.project_id,
            material_name=req.material_name,
            category=req.category,
            on_hand_qty=delta,
            reserved_qty=0.0,
            unit=req.unit or "nos",
        )
        db.add(inv)
        db.flush()

    if req.type not in RECEIVED_TYPES:
        if req.type in ADJUSTMENT_TYPES:
            if req.qty < 0:
                release_reservation(db, req.project_id, req.material_name, abs(req.qty))
        else:
            release_reservation(db, req.project_id, req.material_name, req.qty)

    db.commit()
    db.refresh(txn)
    return TransactionResponse(
        id=txn.id,
        project_id=txn.project_id,
        material_name=txn.material_name,
        category=txn.category,
        qty=float(txn.qty),
        type=txn.type,
        unit=txn.unit,
        source_ref_id=txn.source_ref_id,
        reason=txn.reason if txn.type in ADJUSTMENT_TYPES else None,
        created_at=txn.created_at,
    )


# 8. Patch inventory master (set category / unit)
@router.patch("/inventory/{inventory_id}", response_model=InventoryResponse)
def patch_inventory(inventory_id: UUID, req: InventoryPatchRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    inv = db.query(WarehouseInventory).filter(WarehouseInventory.id == inventory_id).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Inventory not found")
    project = db.query(Project).filter(Project.id == inv.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "procurement:edit")
    if req.category is not None:
        inv.category = req.category
    if req.unit is not None and req.unit != inv.unit:
        if float(inv.on_hand_qty or 0) != 0 or float(inv.reserved_qty or 0) != 0:
            raise HTTPException(status_code=422, detail="Cannot change the unit of an item that holds stock; restate the quantity through movements instead")
        inv.unit = req.unit
    db.commit()
    db.refresh(inv)
    return InventoryResponse(
        id=inv.id,
        project_id=inv.project_id,
        material_name=inv.material_name,
        category=inv.category,
        on_hand_qty=float(inv.on_hand_qty),
        reserved_qty=float(inv.reserved_qty),
        unit=inv.unit,
        created_at=inv.created_at,
    )


@router.get("/pos/{po_id}/pdf")
def get_po_pdf(po_id: UUID, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    po = db.query(PurchaseOrder).filter(PurchaseOrder.id == po_id).first()
    if not po:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    # Tenant check: the PO belongs to a company the caller is a member of.
    get_company_membership(db, current_user, po.company_id)

    project = db.query(Project).filter(Project.id == po.project_id).first() if po.project_id else None
    company_name, custom_banner = resolve_pdf_branding(db, po.company_id, project)
    from app.utils.document_pdf import load_branding_assets
    branding = load_branding_assets(db, po.company_id)
    # R2-607: the registered supplier identity (legal name, GSTIN, phone,
    # address) is stored on the Company/branch rows; print it on the PO
    # masthead like the bill PDF already does (R2-403).
    supplier_lines = resolve_supplier_tax_details(db, po.company_id, project)

    vendor = db.query(CompanyTeam).filter(CompanyTeam.id == po.vendor_id).first() if po.vendor_id else None
    vendor_user = db.query(User).filter(User.id == vendor.user_id).first() if vendor else None
    vendor_name = vendor_user.name if vendor_user and vendor_user.name else "N/A"

    party_lines = [
        f"Vendor: {vendor_name}",
        f"PO Number: {po.po_number}",
        f"PO Date: {po.po_date.strftime('%Y-%m-%d') if po.po_date else ''}",
        f"Status: {po.status}",
    ]

    items = db.query(PurchaseOrderItem).filter(PurchaseOrderItem.po_id == po.id).all()
    received_by_po_item = {}
    grn_items = db.query(GRNItem).join(GoodsReceiptNote).filter(GoodsReceiptNote.po_id == po.id).all()
    for gi in grn_items:
        received_by_po_item[gi.po_item_id] = received_by_po_item.get(gi.po_item_id, 0.0) + float(gi.received_qty)

    table_headers = ["Material", "Qty", "Unit", "Rate", "Tax%", "Amount", "Received"]
    col_widths = [30, 9, 8, 13, 7, 15, 15]
    table_rows = []
    for it in items:
        amt = float(it.total_amount) if it.total_amount else float(it.quantity * it.rate)
        table_rows.append([
            it.material_name,
            str(it.quantity),
            it.unit,
            str(it.rate),
            str(it.tax_pct),
            f"{amt:.2f}",
            f"{received_by_po_item.get(it.id, 0.0):.4f}",
        ])
    if not table_rows:
        table_rows.append(["(No line items)", "", "", "", "", "", ""])

    totals_lines = [
        f"Gross Amount: {po.gross_amount}",
        f"Tax Amount: {po.tax_amount}",
        f"Total Amount: {po.total_amount}",
    ]

    pdf_bytes = generate_document_pdf(
        title="Purchase Order",
        party_lines=party_lines,
        table_headers=table_headers,
        table_rows=table_rows,
        col_widths=col_widths,
        totals_lines=totals_lines,
        terms=po.terms,
        company_name=company_name,
        custom_banner=custom_banner,
        supplier_lines=supplier_lines,
        branding=branding,
    )
    filename = f"{po.po_number or 'po'}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )
