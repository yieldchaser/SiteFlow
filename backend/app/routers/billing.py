import json
import logging
from uuid import UUID
from datetime import datetime, timezone
from typing import Dict, List, Optional
from fastapi import APIRouter, Depends, HTTPException, Response, status, Query

logger = logging.getLogger(__name__)
from sqlalchemy import func
from sqlalchemy.orm import Session
from app.database import get_db
from app.auth import get_current_user, verify_project_in_company, verify_project_access, verify_company_access, get_company_membership, require_permission, require_module_view
from app.models import (
    WorkOrder, WorkOrderItem, Bill, TransactionDeduction,
    DebitNote, CreditNote, CompanyTeam, User, Company, LibraryParty, Project, ThreeWayMatch, ProjectParty,
    PurchaseOrder,
)
from app import models
from app.party_names import resolve_party_name, resolve_party_names_batch
from app.routers.custom_fields import CustomFieldValueInput, upsert_values_for_entity, enforce_required_custom_fields
from app.routers.library import next_party_id_custom
from app.routers.projects import ensure_project_party_link
from app.zatca import build_zatca_payload
from app.workflow_controls import enforce_entry_creation_window, enforce_entry_editing_window, get_company, get_default_terms
from app.utils.pdf_generator import generate_document_pdf
from app.utils.document_pdf import resolve_pdf_branding, resolve_supplier_tax_details
from pydantic import BaseModel, Field
from app.constants import (
    CANONICAL_INVOICE_TYPES,
    EXPENSE_INVOICE_TYPES,
    INVOICE_TYPE_PATTERN,
    REVENUE_INVOICE_TYPES,
    SETTLEMENT_INVOICE_TYPES,
    is_expense_invoice_type,
    is_revenue_invoice_type,
    is_settlement_invoice_type,
)

router = APIRouter(
    prefix="/billing",
    tags=["Subcontractor Work Orders & Billing"],
    dependencies=[Depends(get_current_user)]
)

# Pydantic Schemas
class WOItemSchema(BaseModel):
    boq_item_id: Optional[UUID] = None
    task_id: Optional[UUID] = None
    quantity: float = Field(..., ge=0)
    rate: float = Field(..., ge=0)

class WOCreateRequest(BaseModel):
    company_id: UUID
    project_id: UUID
    subcontractor_id: UUID
    wo_number: Optional[str] = None  # omit to auto-generate a sequential number
    wo_date: datetime
    items: List[WOItemSchema]
    terms: Optional[str] = None

class WOUpdateRequest(BaseModel):
    subcontractor_id: UUID
    wo_number: str
    wo_date: datetime
    items: List[WOItemSchema]
    terms: Optional[str] = None


def _compute_estimated_work_amount(items: List[WOItemSchema]) -> float:
    return sum(item.quantity * item.rate for item in items)

class WOResponseItem(BaseModel):
    id: UUID
    boq_item_id: Optional[UUID] = None
    task_id: Optional[UUID] = None
    quantity: float
    rate: float
    amount: float

class WOResponse(BaseModel):
    id: UUID
    company_id: UUID
    project_id: UUID
    subcontractor_id: UUID
    subcontractor_name: str = "Unknown"
    wo_number: str
    wo_date: datetime
    status: str
    estimated_work_amount: float
    billed_amount: float = 0.0
    progress_pct: Optional[float] = None
    terms: Optional[str] = None
    created_at: datetime
    items: List[WOResponseItem] = []

    class Config:
        from_attributes = True

class DeductionItemSchema(BaseModel):
    deduction_type: str = Field(..., pattern="^(TDS|Retention|Security Deposit|Advance Recovery|Material Recovery)$", example="TDS") # TDS, Retention, Security Deposit, Advance Recovery, Material Recovery
    amount: float = Field(..., ge=0)
    percentage: Optional[float] = Field(None, ge=0, le=100)
    notes: Optional[str] = None
    # R2-377: when a Retention deduction falls due for release (e.g. half at
    # practical completion, half after the defect-liability period).
    release_due_date: Optional[datetime] = None

class BillCreateRequest(BaseModel):
    company_id: UUID
    project_id: UUID
    party_company_user_id: UUID
    invoice_number: Optional[str] = None
    invoice_date: datetime
    due_date: Optional[datetime] = None
    invoice_type: str = Field(..., pattern=INVOICE_TYPE_PATTERN, example="subcon") # sale, purchase, subcon, material_sale, material_return, material_transfer, expense, equipment
    subtotal: float = Field(..., ge=0)
    gst_pct: float = Field(18.00, ge=0, le=100)
    deductions: List[DeductionItemSchema] = []
    pre_tax_deductions: bool = False
    # Transaction sub-entity persistence (Project Tab Transaction build)
    items_json: Optional[str] = None  # JSON string of line items
    payment_mode: Optional[str] = None  # Cash / Bank / Cheque
    payment_bank_name: Optional[str] = None
    payment_ref: Optional[str] = None  # cheque no / bank txn ref
    ship_to: Optional[str] = None
    boq_document_id: Optional[UUID] = None  # link this bill to a BOQ document (for Billed Value)
    # Subcontractor work order this RA bill bills against. Required to be resolvable
    # for subcon bills: supplied directly, or auto-resolved when the subcontractor has
    # exactly one active work order on the project. Cumulative billing is validated
    # against the WO's estimated_work_amount.
    wo_id: Optional[UUID] = None
    # R2-371: the purchase order this purchase bill is raised against. When set,
    # cumulative billing is validated against the PO's total_amount, which is
    # the control that makes over-invoicing against a PO detectable.
    po_id: Optional[UUID] = None
    terms: Optional[str] = None  # Terms & Conditions; defaults to company Invoice Terms on create
    # Theme B (soft flag): optional link to an APPROVED ThreeWayMatch. Ignored for
    # sale invoices; required to be approved + same company/project when supplied on
    # purchase/subcon bills (validated in create_bill / PATCH .../match).
    match_id: Optional[UUID] = None
    # Custom Fields (Settings → Custom Fields, entity_type="invoice"). Populated by the
    # Sales Invoice transaction type on the project Transaction tab; harmless no-op for
    # other invoice_type values that don't render a Custom Fields section.
    custom_fields: List[CustomFieldValueInput] = []

class DeductionResponseSchema(BaseModel):
    id: UUID
    deduction_type: str
    amount: float
    percentage: Optional[float] = None
    notes: Optional[str] = None
    # R2-377: retention lifecycle surfaced to clients so outstanding retention
    # is enumerable (released_at None + type Retention = still held).
    release_due_date: Optional[datetime] = None
    released_at: Optional[datetime] = None
    released_amount: Optional[float] = None

class BillResponse(BaseModel):
    id: UUID
    company_id: UUID
    project_id: UUID
    party_company_user_id: UUID
    invoice_number: str
    invoice_date: datetime
    due_date: Optional[datetime] = None
    invoice_type: str
    status: str
    subtotal: float
    gst_amount: float
    total_payable: float
    paid_amount: float
    approval_flag: str
    is_milestone_fixed_amount: bool
    pre_tax_deductions: bool = False
    created_at: datetime
    deductions: List[DeductionResponseSchema] = []
    items_json: Optional[str] = None
    payment_mode: Optional[str] = None
    payment_bank_name: Optional[str] = None
    payment_ref: Optional[str] = None
    ship_to: Optional[str] = None
    terms: Optional[str] = None
    # Theme B (soft flag): the linked ThreeWayMatch id, and its status.
    # match_status is "unmatched" when no approved match is linked, else the
    # linked match's match_status (e.g. "approved").
    match_id: Optional[UUID] = None
    match_status: Optional[str] = None
    wo_id: Optional[UUID] = None
    # R2-371: the purchase order this bill is raised against, null when it was
    # not raised against one.
    po_id: Optional[UUID] = None
    project_name: Optional[str] = None

    class Config:
        from_attributes = True

class DebitNoteCreateRequest(BaseModel):
    project_id: UUID
    company_id: UUID
    party_company_user_id: UUID
    notes: Optional[str] = None
    total_amount: float = Field(..., ge=0)
    work_amount: float = Field(0.0, ge=0)
    gst_amount: float = Field(0.0, ge=0)
    bill_id: Optional[UUID] = None
    reference_number: Optional[str] = None

class DebitNoteResponse(BaseModel):
    id: UUID
    project_id: UUID
    company_id: UUID
    party_company_user_id: UUID
    notes: Optional[str] = None
    total_amount: float
    work_amount: float
    gst_amount: float
    bill_id: Optional[UUID] = None
    reference_number: Optional[str] = None
    approval_flag: str
    created_at: datetime

    class Config:
        from_attributes = True

class CreditNoteCreateRequest(BaseModel):
    project_id: UUID
    company_id: UUID
    party_company_user_id: UUID
    notes: Optional[str] = None
    total_amount: float = Field(..., ge=0)
    bill_id: Optional[UUID] = None
    reference_number: Optional[str] = None

class CreditNoteResponse(BaseModel):
    id: UUID
    project_id: UUID
    company_id: UUID
    party_company_user_id: UUID
    notes: Optional[str] = None
    total_amount: float
    bill_id: Optional[UUID] = None
    reference_number: Optional[str] = None
    approval_flag: str
    created_at: datetime

    class Config:
        from_attributes = True

# --- Endpoints ---

def _sequential_deduction_calc(deductions: List[DeductionItemSchema], base: float, pretax_order: bool):
    """Settings -> Workflow Controls -> Finance Controls -> 'Pre-Tax Deduction/Retention'
    (Company.pretax_deduction_retention).

    Splits the requested deductions into Retention vs everything else (TDS,
    Security Deposit, Advance Recovery, Material Recovery, ...) and applies
    them sequentially against `base` so the order actually changes the
    result:
      - pretax_order=True  -> TDS/other deductions computed first, Retention
        is then computed on the post-deduction amount.
      - pretax_order=False (default) -> Retention computed first, TDS/other
        deductions are then computed on the post-retention amount.

    Returns (deduction_details, total_deducted) where deduction_details is a
    list of (DeductionItemSchema, calculated_amount) tuples in the same
    shape the caller previously built manually."""
    retention_list = [d for d in deductions if d.deduction_type == "Retention"]
    other_list = [d for d in deductions if d.deduction_type != "Retention"]

    def _calc(d: DeductionItemSchema, on_amount: float) -> float:
        if d.percentage:
            return on_amount * (d.percentage / 100.0)
        return d.amount

    first_list, second_list = (other_list, retention_list) if pretax_order else (retention_list, other_list)

    details = []
    first_total = 0.0
    for d in first_list:
        amt = _calc(d, base)
        first_total += amt
        details.append((d, amt))

    # Clamp `remaining` so over-aggressive fixed-amount deductions in the first
    # group can never push the second group's base negative (which would produce
    # a nonsensical negative payable).
    remaining = max(0.0, base - first_total)
    second_total = 0.0
    for d in second_list:
        amt = _calc(d, remaining)
        second_total += amt
        details.append((d, amt))

    total_deducted = first_total + second_total
    # Deductions must never exceed `base`, otherwise a bill's payable amount
    # could go negative due to overlapping fixed-amount deductions.
    total_deducted = min(total_deducted, base)
    return details, total_deducted


def _compute_wo_billing(db: Session, wo_id: UUID, est_amount: float):
    # R2-762: Sum total_payable of non-cancelled bills raised against this work order
    bills = db.query(Bill).filter(
        Bill.wo_id == wo_id,
        Bill.status != "Cancelled"
    ).all()
    billed_amount = round(sum(float(b.total_payable or 0.0) for b in bills), 2)
    # Progress against the contract must compare like with like. estimated_work_amount
    # is the GST-exclusive contract value, so the numerator has to be the billed
    # WORK value (subtotal), not total_payable, which is GST-inclusive and net of
    # retention and TDS. Using total_payable overstated progress by roughly the
    # GST rate: 420,000 of work on a 1,250,000 order read 37.3% instead of 33.6%.
    billed_work_value = round(sum(float(b.subtotal or 0.0) for b in bills), 2)
    progress_pct = None
    if float(est_amount) > 0:
        progress_pct = round((billed_work_value / float(est_amount)) * 100.0, 1)
    return billed_amount, progress_pct


def _compute_wo_billing_batch(db: Session, wo_ids: List[UUID], est_amounts: Dict[UUID, float]) -> Dict[UUID, tuple]:
    if not wo_ids:
        return {}
    bills = db.query(Bill.wo_id, Bill.total_payable).filter(
        Bill.wo_id.in_(wo_ids),
        Bill.status != "Cancelled"
    ).all()
    totals_by_wo: Dict[UUID, float] = {wid: 0.0 for wid in wo_ids}
    for b_wo_id, b_total_payable in bills:
        if b_wo_id in totals_by_wo:
            totals_by_wo[b_wo_id] += float(b_total_payable or 0.0)
    result = {}
    for wid in wo_ids:
        billed_amt = round(totals_by_wo.get(wid, 0.0), 2)
        est = est_amounts.get(wid, 0.0)
        prog_pct = None
        if float(est) > 0:
            prog_pct = round((billed_amt / float(est)) * 100.0, 1)
        result[wid] = (billed_amt, prog_pct)
    return result


# 1. Work Orders
@router.get("/work-orders", response_model=List[WOResponse])
def get_work_orders(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access), current_user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    require_module_view(db, current_user, project.company_id, "billing")
    orders = db.query(WorkOrder).filter(WorkOrder.project_id == project_id).all()
    if not orders:
        return []

    wo_ids = [wo.id for wo in orders]

    # 1. Batched items lookup
    all_items = db.query(WorkOrderItem).filter(WorkOrderItem.wo_id.in_(wo_ids)).all()
    items_by_wo: Dict[UUID, List[WorkOrderItem]] = {wid: [] for wid in wo_ids}
    for item in all_items:
        if item.wo_id in items_by_wo:
            items_by_wo[item.wo_id].append(item)

    # 2. Batched subcontractor name lookup
    sub_ids = [wo.subcontractor_id for wo in orders if wo.subcontractor_id is not None]
    party_names = resolve_party_names_batch(db, sub_ids)

    # 3. Batched billing rollup
    est_amounts = {wo.id: float(wo.estimated_work_amount) for wo in orders}
    billing_by_wo = _compute_wo_billing_batch(db, wo_ids, est_amounts)

    res = []
    for wo in orders:
        items = items_by_wo.get(wo.id, [])
        item_schemas = [
            WOResponseItem(
                id=i.id,
                boq_item_id=i.boq_item_id,
                task_id=i.task_id,
                quantity=float(i.quantity),
                rate=float(i.rate),
                amount=float(i.amount) if i.amount else float(i.quantity * i.rate)
            ) for i in items
        ]
        subcontractor_name = party_names.get(wo.subcontractor_id, "Unknown") if wo.subcontractor_id else "Unknown"
        billed_amt, prog_pct = billing_by_wo.get(wo.id, (0.0, None))
        res.append(
            WOResponse(
                id=wo.id,
                company_id=wo.company_id,
                project_id=wo.project_id,
                subcontractor_id=wo.subcontractor_id,
                subcontractor_name=subcontractor_name,
                wo_number=wo.wo_number,
                wo_date=wo.wo_date,
                status=wo.status,
                estimated_work_amount=float(wo.estimated_work_amount),
                billed_amount=billed_amt,
                progress_pct=prog_pct,
                terms=wo.terms,
                created_at=wo.created_at,
                items=item_schemas
            )
        )
    return res


def _generate_wo_number(db: Session, company_id: UUID) -> str:
    """Return the next sequential work order number for the company.

    Produces WO-NNNN where NNNN is the next integer past the current company-wide
    count. Bumps past any collision from concurrent creates, mirroring
    _generate_grn_number in procurement.py. Scoped to the company because the
    uniqueness constraint (billing.py duplicate check) is company-wide.
    """
    count = db.query(WorkOrder).filter(WorkOrder.company_id == company_id).count()
    candidate = f"WO-{count + 1:04d}"
    while db.query(WorkOrder).filter(
        WorkOrder.company_id == company_id,
        WorkOrder.wo_number == candidate,
    ).first():
        count += 1
        candidate = f"WO-{count + 1:04d}"
    return candidate


@router.post("/work-orders", response_model=WOResponse, status_code=201)
def create_work_order(req: WOCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Tenant check: the caller must be a member of the company this work order belongs to.
    get_company_membership(db, current_user, req.company_id)
    verify_project_in_company(db, req.project_id, req.company_id)
    require_permission(db, current_user, req.company_id, "billing:edit")
    if req.subcontractor_id:
        sub = db.query(models.CompanyTeam).filter(models.CompanyTeam.id == req.subcontractor_id).first()
        if not sub or sub.company_id != req.company_id:
            raise HTTPException(status_code=403, detail="Subcontractor does not belong to this company")

    # Check if WO number already exists for company
    wo_number = req.wo_number or _generate_wo_number(db, req.company_id)
    existing = db.query(WorkOrder).filter(
        WorkOrder.company_id == req.company_id,
        WorkOrder.wo_number == wo_number
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Work Order number already exists for this company")

    estimated_amount = _compute_estimated_work_amount(req.items)

    wo = WorkOrder(
        company_id=req.company_id,
        project_id=req.project_id,
        subcontractor_id=req.subcontractor_id,
        wo_number=wo_number,
        wo_date=req.wo_date,
        status="active",
        estimated_work_amount=estimated_amount,
        # Settings -> Terms & Conditions -> Subcon Work Order: pre-fill the
        # company default when the caller doesn't supply their own terms.
        terms=req.terms if req.terms else get_default_terms(db, req.company_id, "subcon")
    )
    db.add(wo)
    db.flush()

    item_schemas = []
    for item in req.items:
        db_item = WorkOrderItem(
            wo_id=wo.id,
            boq_item_id=item.boq_item_id,
            task_id=item.task_id,
            quantity=item.quantity,
            rate=item.rate,
            amount=item.quantity * item.rate
        )
        db.add(db_item)
        db.flush()
        
        item_schemas.append(
            WOResponseItem(
                id=db_item.id,
                boq_item_id=db_item.boq_item_id,
                task_id=db_item.task_id,
                quantity=float(db_item.quantity),
                rate=float(db_item.rate),
                amount=float(db_item.amount)
            )
        )

    db.commit()
    db.refresh(wo)

    billed_amt, prog_pct = _compute_wo_billing(db, wo.id, float(wo.estimated_work_amount))
    return WOResponse(
        id=wo.id,
        company_id=wo.company_id,
        project_id=wo.project_id,
        subcontractor_id=wo.subcontractor_id,
        wo_number=wo.wo_number,
        wo_date=wo.wo_date,
        status=wo.status,
        estimated_work_amount=float(wo.estimated_work_amount),
        billed_amount=billed_amt,
        progress_pct=prog_pct,
        terms=wo.terms,
        created_at=wo.created_at,
        items=item_schemas
    )

@router.put("/work-orders/{wo_id}", response_model=WOResponse)
def update_work_order(wo_id: UUID, req: WOUpdateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    wo = db.query(WorkOrder).filter(WorkOrder.id == wo_id).first()
    if not wo:
        raise HTTPException(status_code=404, detail="Work order not found")
    get_company_membership(db, current_user, wo.company_id)
    require_permission(db, current_user, wo.company_id, "billing:edit")

    if wo.status == "cancelled":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Cannot edit a cancelled work order")

    # Guard: block edits once any non-cancelled bill references this work order
    billed_count = (
        db.query(Bill)
        .filter(
            Bill.wo_id == wo.id,
            Bill.status != "Cancelled",
        )
        .count()
    )
    if billed_count > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Work order has been billed against and cannot be edited. Please issue a new work order or variation instead.",
        )

    if req.subcontractor_id:
        sub = db.query(models.CompanyTeam).filter(models.CompanyTeam.id == req.subcontractor_id).first()
        if not sub or sub.company_id != wo.company_id:
            raise HTTPException(status_code=403, detail="Subcontractor does not belong to this company")

    if req.wo_number != wo.wo_number:
        existing = db.query(WorkOrder).filter(
            WorkOrder.company_id == wo.company_id,
            WorkOrder.wo_number == req.wo_number,
            WorkOrder.id != wo.id
        ).first()
        if existing:
            raise HTTPException(status_code=400, detail="Work Order number already exists for this company")

    # Wholesale replace line items
    db.query(WorkOrderItem).filter(WorkOrderItem.wo_id == wo.id).delete()

    wo.subcontractor_id = req.subcontractor_id
    wo.wo_number = req.wo_number
    wo.wo_date = req.wo_date
    wo.terms = req.terms
    wo.estimated_work_amount = _compute_estimated_work_amount(req.items)
    db.add(wo)
    db.flush()

    item_schemas = []
    for item in req.items:
        db_item = WorkOrderItem(
            wo_id=wo.id,
            boq_item_id=item.boq_item_id,
            task_id=item.task_id,
            quantity=item.quantity,
            rate=item.rate,
            amount=item.quantity * item.rate
        )
        db.add(db_item)
        db.flush()

        item_schemas.append(
            WOResponseItem(
                id=db_item.id,
                boq_item_id=db_item.boq_item_id,
                task_id=db_item.task_id,
                quantity=float(db_item.quantity),
                rate=float(db_item.rate),
                amount=float(db_item.amount)
            )
        )

    db.commit()
    db.refresh(wo)

    billed_amt, prog_pct = _compute_wo_billing(db, wo.id, float(wo.estimated_work_amount))
    return WOResponse(
        id=wo.id,
        company_id=wo.company_id,
        project_id=wo.project_id,
        subcontractor_id=wo.subcontractor_id,
        wo_number=wo.wo_number,
        wo_date=wo.wo_date,
        status=wo.status,
        estimated_work_amount=float(wo.estimated_work_amount),
        billed_amount=billed_amt,
        progress_pct=prog_pct,
        terms=wo.terms,
        created_at=wo.created_at,
        items=item_schemas
    )

@router.post("/work-orders/{wo_id}/cancel", response_model=WOResponse)
def cancel_work_order(wo_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    wo = db.query(WorkOrder).filter(WorkOrder.id == wo_id).first()
    if not wo:
        raise HTTPException(status_code=404, detail="Work order not found")
    get_company_membership(db, current_user, wo.company_id)
    require_permission(db, current_user, wo.company_id, "billing:edit")
    if wo.status == "cancelled":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Work order is already cancelled")
    open_bills = (
        db.query(Bill)
        .filter(
            Bill.wo_id == wo.id,
            Bill.status != "Cancelled",
        )
        .count()
    )
    if open_bills:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot cancel a work order with open bills; cancel those bills first",
        )
    enforce_entry_editing_window(db, wo.company_id, wo.wo_date)
    wo.status = "cancelled"
    db.add(wo)
    db.commit()
    db.refresh(wo)

    items = db.query(WorkOrderItem).filter(WorkOrderItem.wo_id == wo.id).all()
    item_schemas = [
        WOResponseItem(
            id=i.id,
            boq_item_id=i.boq_item_id,
            task_id=i.task_id,
            quantity=float(i.quantity),
            rate=float(i.rate),
            amount=float(i.amount) if i.amount else float(i.quantity * i.rate)
        ) for i in items
    ]
    subcontractor_name = resolve_party_name(db, wo.subcontractor_id)
    billed_amt, prog_pct = _compute_wo_billing(db, wo.id, float(wo.estimated_work_amount))
    return WOResponse(
        id=wo.id,
        company_id=wo.company_id,
        project_id=wo.project_id,
        subcontractor_id=wo.subcontractor_id,
        subcontractor_name=subcontractor_name,
        wo_number=wo.wo_number,
        wo_date=wo.wo_date,
        status=wo.status,
        estimated_work_amount=float(wo.estimated_work_amount),
        billed_amount=billed_amt,
        progress_pct=prog_pct,
        terms=wo.terms,
        created_at=wo.created_at,
        items=item_schemas
    )

# ─── AUTO-GENERATED DOCUMENT NUMBERING ───
def next_document_number(db: Session, company_id: UUID, invoice_type: str = "purchase") -> str:
    """Generate next sequential document number per company and invoice type (Onsite Parity 14.9.2)."""
    prefix_map = {
        "purchase": "PUR",
        "sale": "INV",
        "material_sale": "INV",
        "subcon": "SUB",
        "equipment": "EQP",
        "expense": "EXP",
        "material_return": "RET",
        "material_transfer": "TRF",
        "debit_note": "DN",
        "credit_note": "CN",
    }
    prefix = prefix_map.get(invoice_type, "BILL")
    year = datetime.now(timezone.utc).year
    count = db.query(Bill).filter(
        Bill.company_id == company_id,
        Bill.invoice_number.like(f"{prefix}-{year}-%"),
    ).count()

    candidate = f"{prefix}-{year}-{count + 1:04d}"
    while db.query(Bill).filter(Bill.company_id == company_id, Bill.invoice_number == candidate).first():
        count += 1
        candidate = f"{prefix}-{year}-{count + 1:04d}"
    return candidate


@router.get("/next-number/{company_id}")
def get_next_document_number(
    company_id: UUID,
    invoice_type: str = "purchase",
    db: Session = Depends(get_db),
    _: None = Depends(verify_company_access),
):
    """Retrieve next auto-generated document number for form pre-fill (Onsite Parity 14.9.2)."""
    return {"invoice_number": next_document_number(db, company_id, invoice_type)}


# 2. Bills
def _bills_query_and_serialize(
    query,
    db: Session,
    search: Optional[str] = None,
    limit: Optional[int] = None,
    offset: int = 0,
    response: Optional[Response] = None,
) -> List[BillResponse]:
    if search and search.strip():
        term = f"%{search.strip()}%"
        from sqlalchemy import or_
        query = query.filter(
            or_(
                Bill.invoice_number.ilike(term),
                Bill.payment_ref.ilike(term),
            )
        )
    total = query.count()
    if response is not None:
        response.headers["X-Total-Count"] = str(total)
        if limit is not None:
            response.headers["X-Limit"] = str(limit)
            response.headers["X-Offset"] = str(offset)
    if offset:
        query = query.offset(offset)
    if limit is not None:
        query = query.limit(limit)
    bills = query.all()

    project_name_by_id = {p.id: p.name for p in db.query(Project.id, Project.name).all()}
    res = []
    for b in bills:
        deductions = db.query(TransactionDeduction).filter(TransactionDeduction.bill_id == b.id).all()
        ded_schemas = [
            DeductionResponseSchema(
                id=d.id,
                deduction_type=d.deduction_type,
                amount=float(d.amount),
                percentage=float(d.percentage) if d.percentage else None,
                notes=d.notes,
                release_due_date=d.release_due_date,
                released_at=d.released_at,
                released_amount=float(d.released_amount) if d.released_amount is not None else None,
            ) for d in deductions
        ]
        res.append(
            BillResponse(
                id=b.id,
                company_id=b.company_id,
                project_id=b.project_id,
                party_company_user_id=b.party_company_user_id,
                invoice_number=b.invoice_number,
                invoice_date=b.invoice_date,
                due_date=b.due_date,
                invoice_type=b.invoice_type,
                status=b.status,
                subtotal=float(b.subtotal),
                gst_amount=float(b.gst_amount),
                total_payable=float(b.total_payable),
                paid_amount=float(b.paid_amount),
                approval_flag=b.approval_flag,
                is_milestone_fixed_amount=b.is_milestone_fixed_amount,
                pre_tax_deductions=bool(b.pre_tax_deductions),
                created_at=b.created_at,
                deductions=ded_schemas,
                items_json=b.items_json,
                payment_mode=b.payment_mode,
                payment_bank_name=b.payment_bank_name,
                payment_ref=b.payment_ref,
                ship_to=b.ship_to,
                terms=b.terms,
                match_id=b.match_id,
                match_status=_derive_bill_match_status(db, b),
                wo_id=b.wo_id,
                po_id=b.po_id,
                project_name=project_name_by_id.get(b.project_id),
            )
        )
    return res


@router.get("/bills", response_model=List[BillResponse])
def get_bills(
    project_id: Optional[UUID] = None,
    company_id: Optional[UUID] = None,
    invoice_type: Optional[str] = None,
    search: Optional[str] = None,
    limit: Optional[int] = Query(None, ge=1, le=500),
    offset: int = Query(0, ge=0),
    response: Response = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not project_id and not company_id:
        raise HTTPException(status_code=400, detail="Either project_id or company_id is required")
    if project_id:
        verify_project_access(project_id, current_user, db)
        project = db.query(Project).filter(Project.id == project_id).first()
        require_module_view(db, current_user, project.company_id, "billing")
        query = db.query(Bill).filter(Bill.project_id == project_id)
    else:
        verify_company_access(company_id, current_user, db)
        require_module_view(db, current_user, company_id, "billing")
        query = db.query(Bill).filter(Bill.company_id == company_id)

    if invoice_type:
        query = query.filter(Bill.invoice_type == invoice_type)

    return _bills_query_and_serialize(query, db, search, limit, offset, response)


@router.get("/bills/{company_id}", response_model=List[BillResponse])
def get_bills_by_company(
    company_id: UUID,
    invoice_type: Optional[str] = None,
    search: Optional[str] = None,
    limit: Optional[int] = Query(None, ge=1, le=500),
    offset: int = Query(0, ge=0),
    response: Response = None,
    db: Session = Depends(get_db),
    _: None = Depends(verify_company_access),
    current_user: User = Depends(get_current_user),
):
    require_module_view(db, current_user, company_id, "billing")
    query = db.query(Bill).filter(Bill.company_id == company_id)
    if invoice_type:
        query = query.filter(Bill.invoice_type == invoice_type)
    return _bills_query_and_serialize(query, db, search, limit, offset, response)

@router.post("/bills/{bill_id}/cancel", response_model=BillResponse)
def cancel_bill(bill_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    bill = db.query(Bill).filter(Bill.id == bill_id).first()
    if not bill:
        raise HTTPException(status_code=404, detail="Bill not found")
    get_company_membership(db, current_user, bill.company_id)
    require_permission(db, current_user, bill.company_id, "finance:edit")
    if float(bill.paid_amount or 0.0) > 0.0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot cancel a bill with payments; reverse the payment first",
        )
    enforce_entry_editing_window(db, bill.company_id, bill.invoice_date)
    bill.status = "Cancelled"
    bill.cancelled_at = datetime.now(timezone.utc)
    bill.cancelled_by = current_user.id
    db.add(bill)
    db.commit()
    db.refresh(bill)

    deductions = db.query(TransactionDeduction).filter(TransactionDeduction.bill_id == bill.id).all()
    ded_schemas = [
        DeductionResponseSchema(
            id=d.id,
            deduction_type=d.deduction_type,
            amount=float(d.amount),
            percentage=float(d.percentage) if d.percentage else None,
            notes=d.notes,
            release_due_date=d.release_due_date,
            released_at=d.released_at,
            released_amount=float(d.released_amount) if d.released_amount is not None else None,
        ) for d in deductions
    ]
    return BillResponse(
        id=bill.id,
        company_id=bill.company_id,
        project_id=bill.project_id,
        party_company_user_id=bill.party_company_user_id,
        invoice_number=bill.invoice_number,
        invoice_date=bill.invoice_date,
        due_date=bill.due_date,
        invoice_type=bill.invoice_type,
        status=bill.status,
        subtotal=float(bill.subtotal),
        gst_amount=float(bill.gst_amount),
        total_payable=float(bill.total_payable),
        paid_amount=float(bill.paid_amount),
        approval_flag=bill.approval_flag,
        is_milestone_fixed_amount=bill.is_milestone_fixed_amount,
        pre_tax_deductions=bool(bill.pre_tax_deductions),
        created_at=bill.created_at,
        deductions=ded_schemas,
        items_json=bill.items_json,
        payment_mode=bill.payment_mode,
        payment_bank_name=bill.payment_bank_name,
        payment_ref=bill.payment_ref,
        ship_to=bill.ship_to,
        terms=bill.terms,
        match_id=bill.match_id,
        match_status=_derive_bill_match_status(db, bill),
        wo_id=bill.wo_id,
        po_id=bill.po_id,
    )


@router.post("/bills/{bill_id}/approve", response_model=BillResponse)
def approve_bill(bill_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Audit-approve a bill (R2-214).

    Approval is its own lifecycle column (approval_flag), independent of the
    payment status: finance settles only approved/auto_approved bills and
    retention release requires the same, so this gate was previously writable
    by nothing - the UI flipped a local variable instead.
    """
    bill = db.query(Bill).filter(Bill.id == bill_id).first()
    if not bill:
        raise HTTPException(status_code=404, detail="Bill not found")
    get_company_membership(db, current_user, bill.company_id)
    require_permission(db, current_user, bill.company_id, "billing:approve")
    if bill.status == "Cancelled":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot approve a cancelled bill",
        )
    if bill.approval_flag not in ("approved", "auto_approved"):
        bill.approval_flag = "approved"
        db.commit()
        db.refresh(bill)

    deductions = db.query(TransactionDeduction).filter(TransactionDeduction.bill_id == bill.id).all()
    ded_schemas = [
        DeductionResponseSchema(
            id=d.id,
            deduction_type=d.deduction_type,
            amount=float(d.amount),
            percentage=float(d.percentage) if d.percentage else None,
            notes=d.notes,
            release_due_date=d.release_due_date,
            released_at=d.released_at,
            released_amount=float(d.released_amount) if d.released_amount is not None else None,
        ) for d in deductions
    ]
    return BillResponse(
        id=bill.id,
        company_id=bill.company_id,
        project_id=bill.project_id,
        party_company_user_id=bill.party_company_user_id,
        invoice_number=bill.invoice_number,
        invoice_date=bill.invoice_date,
        due_date=bill.due_date,
        invoice_type=bill.invoice_type,
        status=bill.status,
        subtotal=float(bill.subtotal),
        gst_amount=float(bill.gst_amount),
        total_payable=float(bill.total_payable),
        paid_amount=float(bill.paid_amount),
        approval_flag=bill.approval_flag,
        is_milestone_fixed_amount=bill.is_milestone_fixed_amount,
        pre_tax_deductions=bool(bill.pre_tax_deductions),
        created_at=bill.created_at,
        deductions=ded_schemas,
        items_json=bill.items_json,
        payment_mode=bill.payment_mode,
        payment_bank_name=bill.payment_bank_name,
        payment_ref=bill.payment_ref,
        ship_to=bill.ship_to,
        terms=bill.terms,
        match_id=bill.match_id,
        match_status=_derive_bill_match_status(db, bill),
        wo_id=bill.wo_id,
        po_id=bill.po_id,
    )


@router.get("/bills/{bill_id}/zatca")
def get_bill_zatca(bill_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    bill = db.query(Bill).filter(Bill.id == bill_id).first()
    if not bill:
        raise HTTPException(status_code=404, detail="Bill not found")
    # Tenant check: the bill belongs to a company the caller is a member of.
    get_company_membership(db, current_user, bill.company_id)
    require_module_view(db, current_user, bill.company_id, "billing")
    if not is_revenue_invoice_type(bill.invoice_type):
        raise HTTPException(status_code=400, detail="ZATCA e-invoicing applies to revenue (taxable) invoices")
    company = db.query(Company).filter(Company.id == bill.company_id).first()
    if not company:
        raise HTTPException(status_code=404, detail="Company not found")
    # R2-412: an official-looking e-invoice artefact is produced only when the
    # operator has actually configured ZATCA for this company - never as a
    # default document with a boolean apology attached.
    if not bool(getattr(company, "is_zatca_enable", False)):
        raise HTTPException(
            status_code=409,
            detail="ZATCA e-invoicing is not enabled for this company",
        )
    if not str(getattr(company, "vat_number", None) or "").strip():
        raise HTTPException(
            status_code=409,
            detail="ZATCA seller VAT registration number is not configured for this company",
        )
    # R2-413: a bill whose line detail is missing or does not reconcile gets
    # a refusal, never a document with an invented line.
    try:
        payload = build_zatca_payload(company, bill)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return {
        "is_zatca_enabled": True,
        "qr_tlv_base64": payload["qr_tlv_base64"],
        "ubl_xml": payload["ubl_xml"],
        "invoice_number": payload["invoice_number"],
        "issue_date": payload["issue_date"],
        "total_excl_vat": payload["total_excl_vat"],
        "vat_total": payload["vat_total"],
        "total_incl_vat": payload["total_incl_vat"],
    }

def _amount_in_words(value) -> str:
    """R2-399: Rule 46 requires the invoice amount in words; render the Indian
    numbering system (crore / lakh / thousand / hundred) with paise."""
    ones = [
        "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight",
        "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen",
        "Sixteen", "Seventeen", "Eighteen", "Nineteen",
    ]
    tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]

    def two(n: int) -> str:
        return ones[n] if n < 20 else f"{tens[n // 10]} {ones[n % 10]}".strip()

    def indian(n: int) -> str:
        if n < 100:
            return two(n)
        if n < 1000:
            h, r = divmod(n, 100)
            return " ".join(filter(None, [f"{ones[h]} Hundred", indian(r) if r else ""]))
        if n < 100000:
            th, r = divmod(n, 1000)
            return " ".join(filter(None, [f"{indian(th)} Thousand", indian(r) if r else ""]))
        if n < 10000000:
            l, r = divmod(n, 100000)
            return " ".join(filter(None, [f"{indian(l)} Lakh", indian(r) if r else ""]))
        c, r = divmod(n, 10000000)
        return " ".join(filter(None, [f"{indian(c)} Crore", indian(r) if r else ""]))

    try:
        value = float(value)
    except (TypeError, ValueError):
        return ""
    negative = value < 0
    whole, paise = divmod(int(round(abs(value), 2) * 100), 100)
    words = f"{indian(whole)} Rupees"
    if paise:
        words += f" and {indian(paise)} Paise"
    return f"{'Negative ' if negative else ''}{words} Only"


@router.get("/bills/{bill_id}/pdf")
def get_bill_pdf(bill_id: UUID, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    bill = db.query(Bill).filter(Bill.id == bill_id).first()
    if not bill:
        raise HTTPException(status_code=404, detail="Bill not found")
    # Tenant check: the bill belongs to a company the caller is a member of.
    get_company_membership(db, current_user, bill.company_id)
    require_module_view(db, current_user, bill.company_id, "billing")

    project = db.query(Project).filter(Project.id == bill.project_id).first() if bill.project_id else None
    company_name, custom_banner = resolve_pdf_branding(db, bill.company_id, project)
    from app.utils.document_pdf import load_branding_assets
    branding = load_branding_assets(db, bill.company_id)
    # R2-403: the registered supplier identity (legal name, GSTIN, phone,
    # address) is stored on the Company/branch rows; print it on the invoice
    # masthead instead of ignoring it (Rule 46 supplier side).
    supplier_lines = resolve_supplier_tax_details(db, bill.company_id, project)

    party = db.query(CompanyTeam).filter(CompanyTeam.id == bill.party_company_user_id).first()
    # R2-400 / R2-748: Resolve party name using the single shared resolver (LibraryParty first, then User)
    party_name = resolve_party_name(db, bill.party_company_user_id, fallback="N/A")
    party_gstin = ""
    party_address = ""
    if party and party.library_party_id:
        linked_party = db.query(LibraryParty).filter(LibraryParty.id == party.library_party_id).first()
        if linked_party and getattr(linked_party, "tax_no", None):
            party_gstin = str(linked_party.tax_no)
        if linked_party and getattr(linked_party, "address", None):
            party_address = str(linked_party.address).strip()

    type_label_map = {
        "sale": "Tax Invoice",
        "material_sale": "Tax Invoice - Material Sales",
        "purchase": "Purchase Tax Invoice",
        "subcon": "Subcontractor Tax Invoice",
        "material_return": "Material Return",
        "material_transfer": "Material Transfer Voucher",
        "expense": "Other Expense Voucher",
        "equipment": "Equipment Expense Voucher",
    }
    if bill.invoice_type not in type_label_map:
        raise HTTPException(status_code=400, detail=f"Invalid or unhandled invoice_type '{bill.invoice_type}'")
    type_label = type_label_map[bill.invoice_type]

    # D4 (R2-041/R2-125/R2-319): place of supply is the SITE (Project.state)
    # per IGST Act s.12(3) for works contracts - not the party address.
    # Compare site state vs supplier GSTIN prefix: same -> CGST+SGST halves,
    # different -> IGST full. Forward-only - no rewrite of filed docs.
    supplier_gstin = ""
    for ln in supplier_lines:
        if ln.startswith("GSTIN: "):
            supplier_gstin = ln[len("GSTIN: "):].strip()
            break
    # Keep recipient prefix only as a legacy fallback when site state is absent
    # so that invoices created before D4 (when state was nullable) still render.
    recipient_state = party_gstin[:2] if len(party_gstin) >= 2 else ""
    try:
        from app.gst_utils import project_state_code as _proj_code, is_inter_state as _is_inter, supplier_state_code as _sup_code
        _site_code = _proj_code(getattr(project, "state", None) if project else None)
        _sup_code_val = _sup_code(supplier_gstin)
        inter_val = _is_inter(getattr(project, "state", None) if project else None, supplier_gstin)
        if _site_code:
            place_of_supply = _site_code
            inter_state = bool(inter_val) if inter_val is not None else False
        else:
            # Legacy fallback: site state missing - fall back to recipient-based POS
            # so that pre-D4 PDFs (and the R2-272 pin) remain honest. New writes
            # are gated by Project.state required 422, so this path only serves history.
            place_of_supply = recipient_state or ""
            inter_state = bool(_sup_code_val and place_of_supply and _sup_code_val != place_of_supply)
    except Exception:
        # Absolute fallback identical to pre-D4 behavior
        supplier_state = supplier_gstin[:2] if len(supplier_gstin) >= 2 else ""
        recipient_state = party_gstin[:2] if len(party_gstin) >= 2 else ""
        place_of_supply = recipient_state or ""
        inter_state = bool(supplier_state and place_of_supply and supplier_state != place_of_supply)

    party_lines = [
        f"Party: {party_name}",
        f"Invoice No: {bill.invoice_number}",
        f"Invoice Date: {bill.invoice_date.strftime('%Y-%m-%d') if bill.invoice_date else ''}",
        f"Type: {type_label}",
        f"Status: {bill.status}",
    ]
    if party_gstin:
        party_lines.append(f"Recipient GSTIN: {party_gstin}")
    # R2-747: recipient name, address and GSTIN are the Rule 46 recipient trio.
    if party_address:
        party_lines.append(f"Recipient Address: {party_address}")
    if place_of_supply:
        party_lines.append(f"Place of Supply: {place_of_supply}")
    if bill.due_date:
        party_lines.append(f"Due Date: {bill.due_date.strftime('%Y-%m-%d')}")

    table_headers = ["Description", "HSN/SAC", "Qty", "Rate", "Amount"]
    col_widths = [44, 12, 10, 15, 15]
    table_rows = []
    if bill.items_json:
        try:
            for it in json.loads(bill.items_json):
                table_rows.append([
                    it.get("desc") or it.get("description") or "",
                    str(it.get("hsn_sac") or ""),
                    str(it.get("qty", "")),
                    str(it.get("rate", "")),
                    str(it.get("amount", "")),
                ])
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            logger.warning("Bill %s has unparseable items_json: %s", bill.id, exc)
    if not table_rows:
        table_rows.append(["(No line items)", "", "", "", ""])

    totals_lines = [
        f"Subtotal: {bill.subtotal}",
        f"GST Amount: {bill.gst_amount}",
        f"Total Payable: {bill.total_payable}",
        f"Paid Amount: {bill.paid_amount}",
    ]
    gst_total = float(bill.gst_amount or 0)
    if gst_total > 0:
        if inter_state:
            totals_lines.append(f"IGST: {gst_total:.2f}")
        else:
            cgst = round(gst_total / 2, 2)
            totals_lines.append(f"CGST: {cgst:.2f}")
            totals_lines.append(f"SGST: {(gst_total - cgst):.2f}")

    # R2-399: the remaining Rule 46 elements - the invoice amount in words,
    # the reverse-charge declaration, and a signature block (rendered above
    # the company's uploaded signature image when one exists).
    totals_lines.append(f"Amount in Words: {_amount_in_words(bill.total_payable)}")
    totals_lines.append("Tax Payable Under Reverse Charge: No")
    totals_lines.append(f"For {company_name or 'the supplier'}")
    totals_lines.append("Authorised Signatory")

    pdf_bytes = generate_document_pdf(
        title=type_label,
        party_lines=party_lines,
        table_headers=table_headers,
        table_rows=table_rows,
        col_widths=col_widths,
        totals_lines=totals_lines,
        terms=bill.terms,
        company_name=company_name,
        custom_banner=custom_banner,
        supplier_lines=supplier_lines,
        branding=branding,
    )
    filename = f"{bill.invoice_number or 'bill'}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


# --- Theme B (soft flag) helpers: link a Bill to an approved ThreeWayMatch ---
def _resolve_bill_match_id(db: Session, invoice_type: str, match_id, company_id: UUID, project_id: UUID, total_payable=None):
    """Validate an optional ThreeWayMatch link for a bill.

    - Sale bills are exempt: a supplied match_id is ignored (returns None).
    - purchase/subcon bills are NOT required to have a match (soft flag).
    - When match_id IS supplied on purchase/subcon, it must point to an
      approved match in the same company/project, else 400.
    - R2-594: the linked match's invoiced amount must agree with the bill's
      total_payable, so an approved record for a different figure cannot be
      attached to this bill.
    Returns the match_id to attach (or None).
    """
    if not match_id:
        return None
    if not is_expense_invoice_type(invoice_type):
        # 3-way matching is a purchase-side control; ignore for revenue, settlement, and movement invoices.
        return None
    match = db.query(ThreeWayMatch).filter(ThreeWayMatch.id == match_id).first()
    if not match:
        raise HTTPException(status_code=400, detail="Three-way match not found")
    if match.company_id != company_id or match.project_id != project_id:
        raise HTTPException(status_code=400, detail="Three-way match does not belong to this company/project")
    if match.match_status != "approved":
        raise HTTPException(status_code=400, detail=f"Three-way match is not approved (status: {match.match_status})")
    if total_payable is not None and float(match.invoiced_amount) != round(float(total_payable), 2):
        raise HTTPException(
            status_code=400,
            detail="Linked three-way match's invoiced amount does not agree with this bill's payable amount",
        )
    return match.id


def _derive_bill_match_status(db: Session, bill: Bill) -> Optional[str]:
    """Return the linked match's match_status, or 'unmatched' when none linked."""
    if bill.match_id is None:
        return "unmatched"
    match = db.query(ThreeWayMatch).filter(ThreeWayMatch.id == bill.match_id).first()
    return match.match_status if match else "unmatched"


def _validate_bill_line_items(items_json: Optional[str], subtotal: float, invoice_type: str) -> None:
    """R2-401: line detail is what makes an invoice verifiable.

    A tax invoice (sale / material_sale) must carry at least one described
    line item; a null or empty blob prints "(No line items)" on the PDF and
    gives the recipient nothing to audit. Whenever lines ARE supplied (any
    invoice type), each needs a description and their amounts must reconcile
    to the bill subtotal, so the stated total cannot drift from the goods.
    """
    if items_json is None or not str(items_json).strip():
        if is_revenue_invoice_type(invoice_type):
            raise HTTPException(
                status_code=422,
                detail="Tax invoices require at least one line item describing what was supplied",
            )
        return
    try:
        items = json.loads(items_json)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="items_json must be a valid JSON array of line items")
    if not isinstance(items, list):
        raise HTTPException(status_code=422, detail="items_json must be a JSON array of line item objects")
    if not items:
        if is_revenue_invoice_type(invoice_type):
            raise HTTPException(
                status_code=422,
                detail="Tax invoices require at least one line item describing what was supplied",
            )
        return
    lines_total = 0.0
    for it in items:
        if not isinstance(it, dict):
            raise HTTPException(status_code=422, detail="Each line item must be a JSON object")
        if not str(it.get("desc") or it.get("description") or "").strip():
            raise HTTPException(status_code=422, detail="Every line item needs a description")
        # R2-747: HSN/SAC is mandatory per line on a B2B tax invoice (Rule 46 of
        # the CGST Rules) and the recipient needs it to claim credit. The PDF
        # renders the column but the value was never required, so it shipped
        # blank -- the same Rule 46 defect wearing a header.
        if is_revenue_invoice_type(invoice_type) and not str(it.get("hsn_sac") or "").strip():
            raise HTTPException(
                status_code=422,
                detail=(
                    "Every line item on a tax invoice needs an HSN/SAC code "
                    "(Rule 46, CGST Rules) -- the recipient needs it to claim credit."
                ),
            )
        amount = it.get("amount")
        if amount is None:
            amount = float(it.get("qty") or 0) * float(it.get("rate") or 0)
        try:
            lines_total += float(amount or 0)
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail="Line item amounts must be numeric")
    if abs(lines_total - float(subtotal)) > 0.01:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Line items total Rs {lines_total:,.2f} does not match the bill subtotal "
                f"Rs {float(subtotal):,.2f}"
            ),
        )


# TODO(D-013): profile hook - measure first, trigger when any tenant exceeds 500 bills or 50 projects (whichever first). No perf work now; add timing/sampled logging here when threshold is crossed.
# D-013 trigger: profile when tenant >500 bills or >50 projects
@router.post("/bills", response_model=BillResponse, status_code=201)
def create_bill(req: BillCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Tenant check: the caller must be a member of the company this bill belongs to.
    get_company_membership(db, current_user, req.company_id)
    verify_project_in_company(db, req.project_id, req.company_id)
    require_permission(db, current_user, req.company_id, "billing:edit")
    # D4 (R2-041/R2-125/R2-319): site state is required for any invoiceable write -
    # place of supply derives from Project.state vs supplier GSTIN.
    _bill_proj = db.query(Project).filter(Project.id == req.project_id).first()
    if not _bill_proj or not str(getattr(_bill_proj, "state", "") or "").strip():
        raise HTTPException(
            status_code=422,
            detail="Project.state is required for invoicing - set the site state (GST state code or name) before creating invoices; place of supply derives from the site per IGST Act s.12(3)",
        )
    enforce_required_custom_fields(db, req.company_id, "invoice", [cf.model_dump() for cf in req.custom_fields])
    enforce_required_custom_fields(db, req.company_id, "bill", [cf.model_dump() for cf in req.custom_fields])

    # Resolve or auto-generate invoice number (Onsite Parity 14.9.2)
    inv_num = (req.invoice_number or "").strip()
    if not inv_num or inv_num.lower() == "auto":
        inv_num = next_document_number(db, req.company_id, req.invoice_type)

    # Check if invoice number already exists for company
    existing = db.query(Bill).filter(
        Bill.company_id == req.company_id,
        Bill.invoice_number == inv_num
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Invoice number already exists for this company")

    # R2-401: reject tax invoices with no line items, and reconcile any
    # supplied lines against the subtotal before the bill is persisted.
    _validate_bill_line_items(req.items_json, req.subtotal, req.invoice_type)

    # Theme B (soft flag): resolve and validate the optional ThreeWayMatch link.
    # Returns the (possibly None) match_id to attach, or raises 400. Sale bills are
    # exempt: a supplied match_id is silently ignored for them. purchase/subcon bills
    # are NOT blocked when no match is supplied; only an invalid/non-approved/wrong-scope
    # match_id is rejected.
    match_id = _resolve_bill_match_id(db, req.invoice_type, req.match_id, req.company_id, req.project_id)

    # R2-379: an "Advance Recovery" deduction may only draw against an advance that is
    # actually on record for this party + project (ProjectParty.advance_paid), and the
    # cumulative recovery across all bills can never exceed it.
    advance_recovery_total = sum(
        d.amount if not d.percentage else req.subtotal * (d.percentage / 100.0)
        for d in req.deductions
        if d.deduction_type == "Advance Recovery"
    )
    if advance_recovery_total > 0:
        team = db.query(CompanyTeam).filter(CompanyTeam.id == req.party_company_user_id).first()
        link = None
        if team and team.library_party_id:
            link = db.query(ProjectParty).filter(
                ProjectParty.project_id == req.project_id,
                ProjectParty.party_id == team.library_party_id,
            ).first()
        available = float(link.advance_paid) if link else 0.0
        already_recovered = float(
            db.query(func.coalesce(func.sum(TransactionDeduction.amount), 0))
            .join(Bill, TransactionDeduction.bill_id == Bill.id)
            .filter(
                Bill.company_id == req.company_id,
                Bill.project_id == req.project_id,
                Bill.party_company_user_id == req.party_company_user_id,
                Bill.status != "Cancelled",
                TransactionDeduction.deduction_type == "Advance Recovery",
            )
            .scalar()
            or 0.0
        )
        remaining = max(0.0, available - already_recovered)
        if advance_recovery_total > remaining:
            raise HTTPException(
                status_code=422,
                detail=f"Advance Recovery of ₹{advance_recovery_total:,.2f} exceeds the party's remaining project advance of ₹{remaining:,.2f}",
            )

    # Workflow Controls: Entry Controls (creation date window)
    enforce_entry_creation_window(db, req.company_id, req.invoice_date)

    # R2-253: a subcon bill must be comparable to its work order. Resolve the WO
    # (supplied, or the subcontractor's single active WO on the project) and cap
    # cumulative billing at its estimated_work_amount.
    wo_id = req.wo_id
    if req.invoice_type == "subcon":
        if wo_id is None:
            candidates = (
                db.query(WorkOrder)
                .filter(
                    WorkOrder.project_id == req.project_id,
                    WorkOrder.subcontractor_id == req.party_company_user_id,
                    WorkOrder.status == "active",
                )
                .all()
            )
            if len(candidates) == 1:
                wo_id = candidates[0].id
        if wo_id is not None:
            wo = db.query(WorkOrder).filter(WorkOrder.id == wo_id).first()
            if not wo:
                raise HTTPException(status_code=404, detail="Work order not found")
            if wo.company_id != req.company_id or wo.project_id != req.project_id:
                raise HTTPException(status_code=400, detail="Work order does not belong to this company/project")
            already_billed = float(
                db.query(func.coalesce(func.sum(Bill.subtotal), 0))
                .filter(
                    Bill.company_id == req.company_id,
                    Bill.project_id == req.project_id,
                    Bill.wo_id == wo_id,
                    Bill.invoice_type == "subcon",
                    Bill.status != "Cancelled",
                )
                .scalar()
                or 0.0
            )
            ceiling = float(wo.estimated_work_amount or 0.0)
            if already_billed + float(req.subtotal) > ceiling:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"Subcon bill exceeds work order {wo.wo_number}: cumulative billing "
                        f"₹{already_billed + float(req.subtotal):,.2f} against committed ₹{ceiling:,.2f}. "
                        f"Raise a work-order amendment first."
                    ),
                )

    # R2-371: a bill raised against a purchase order must be comparable to it.
    # Scope the PO to this company/project and cap cumulative billing at its
    # total_amount. This is the control that makes over-invoicing against a PO
    # detectable at all -- before it, a vendor could bill far beyond the PO and
    # no query in the product could relate the two documents. Mirrors the wo_id
    # ceiling added by R2-253.
    po_id = req.po_id
    if po_id is not None:
        po = db.query(PurchaseOrder).filter(PurchaseOrder.id == po_id).first()
        if not po:
            raise HTTPException(status_code=404, detail="Purchase order not found")
        if po.company_id != req.company_id or po.project_id != req.project_id:
            raise HTTPException(
                status_code=400,
                detail="Purchase order does not belong to this company/project",
            )
        already_billed = float(
            db.query(func.coalesce(func.sum(Bill.subtotal), 0))
            .filter(
                Bill.company_id == req.company_id,
                Bill.project_id == req.project_id,
                Bill.po_id == po_id,
                Bill.status != "Cancelled",
            )
            .scalar()
            or 0.0
        )
        ceiling = float(po.total_amount or 0.0)
        if already_billed + float(req.subtotal) > ceiling:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Purchase bill exceeds PO {po.po_number}: cumulative billing "
                    f"₹{already_billed + float(req.subtotal):,.2f} against committed "
                    f"₹{ceiling:,.2f}. Raise a PO amendment first."
                ),
            )

    # Workflow Controls: Finance Controls (Pre-Tax Deduction/Retention order)
    company = get_company(db, req.company_id)
    pretax_order = bool(company.pretax_deduction_retention) if company else False

    # R2-211 + D3: settlement vouchers are cash movements against
    # already-taxed invoices, not taxable supplies of their own. Routed
    # through the single shared classifier.
    if is_settlement_invoice_type(req.invoice_type) and req.gst_pct > 0:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{req.invoice_type} is a settlement voucher (cash movement) and cannot carry "
                "GST; post it with gst_pct 0"
            ),
        )

    # Mathematical Core Billing Engine
    # Calculate pre-determined deduction amounts
    if req.pre_tax_deductions:
        # Pre-Tax Calculations (Deductions subtract from taxable subtotal first, GST is computed on the post-deduction amount)
        deduction_details, ded_amt = _sequential_deduction_calc(req.deductions, req.subtotal, pretax_order)

        gst_amount = (req.subtotal - ded_amt) * (req.gst_pct / 100.0)
        total_payable = req.subtotal - ded_amt + gst_amount
    else:
        # Post-Tax presentation (GST shown on the GST-exclusive subtotal), but
        # TDS/Retention are now computed against the GST-EXCLUSIVE work value
        # (Indian TDS under the Income Tax Act is on the value of work/services,
        # not on the GST component). The `pre_tax_deductions` flag only controls
        # invoice presentation/order from here on, not whether GST is included in
        # the deduction base.
        deduction_details, ded_amt = _sequential_deduction_calc(req.deductions, req.subtotal, pretax_order)

        gst_amount = req.subtotal * (req.gst_pct / 100.0)
        total_payable = req.subtotal - ded_amt + gst_amount

    bill = Bill(
        company_id=req.company_id,
        project_id=req.project_id,
        party_company_user_id=req.party_company_user_id,
        invoice_number=inv_num,
        invoice_date=req.invoice_date,
        due_date=req.due_date,
        invoice_type=req.invoice_type,
        status="Unpaid",
        subtotal=req.subtotal,
        gst_amount=gst_amount,
        total_payable=total_payable,
        paid_amount=0.0,
        approval_flag="pending",
        is_milestone_fixed_amount=False,
        pre_tax_deductions=req.pre_tax_deductions,
        items_json=req.items_json,
        payment_mode=req.payment_mode,
        payment_bank_name=req.payment_bank_name,
        payment_ref=req.payment_ref,
        ship_to=req.ship_to,
        boq_document_id=req.boq_document_id,
        wo_id=wo_id,
        po_id=po_id,
        match_id=match_id,
        # Settings -> Terms & Conditions -> Invoice Terms (or Subcon Terms for
        # subcon invoices): pre-fill the company default when the caller doesn't
        # supply their own terms. Mirrors the subcon Work Order wiring.
        terms=req.terms
        if req.terms
        else get_default_terms(
            db,
            req.company_id,
            "subcon" if req.invoice_type == "subcon" else "invoice",
        ),
    )
    db.add(bill)
    db.flush()

    # Theme B (soft flag): reverse-link the match to this bill (uses the existing
    # ThreeWayMatch.invoice_id column). Only when a match was actually linked.
    if match_id is not None:
        linked_match = db.query(ThreeWayMatch).filter(ThreeWayMatch.id == match_id).first()
        if linked_match:
            linked_match.invoice_id = bill.id
            db.add(linked_match)

    # R2-487: billing a party must create the project-party link the Party
    # register and balances rollup iterate over - otherwise the project keeps
    # reporting 'No parties linked' / Rs 0 To Pay while its unpaid bills exist.
    bill_team = db.query(CompanyTeam).filter(
        CompanyTeam.id == req.party_company_user_id
    ).first()
    if bill_team is not None and bill_team.library_party_id:
        ensure_project_party_link(db, req.project_id, bill_team.library_party_id)

    upsert_values_for_entity(
        db, req.company_id, "invoice", bill.id,
        [cf.model_dump() for cf in req.custom_fields],
    )

    ded_responses = []
    for d, calculated_amt in deduction_details:
        db_ded = TransactionDeduction(
            bill_id=bill.id,
            deduction_type=d.deduction_type,
            amount=calculated_amt,
            percentage=d.percentage,
            notes=d.notes,
            # R2-377: record when withheld retention falls due for release.
            release_due_date=d.release_due_date
        )
        db.add(db_ded)
        db.flush()

        ded_responses.append(
            DeductionResponseSchema(
                id=db_ded.id,
                deduction_type=db_ded.deduction_type,
                amount=float(db_ded.amount),
                percentage=float(db_ded.percentage) if db_ded.percentage else None,
                notes=db_ded.notes,
                release_due_date=db_ded.release_due_date,
                released_at=db_ded.released_at,
                released_amount=float(db_ded.released_amount) if db_ded.released_amount is not None else None,
            )
        )

    db.commit()
    db.refresh(bill)

    return BillResponse(
        id=bill.id,
        company_id=bill.company_id,
        project_id=bill.project_id,
        party_company_user_id=bill.party_company_user_id,
        invoice_number=bill.invoice_number,
        invoice_date=bill.invoice_date,
        due_date=bill.due_date,
        invoice_type=bill.invoice_type,
        status=bill.status,
        subtotal=float(bill.subtotal),
        gst_amount=float(bill.gst_amount),
        total_payable=float(bill.total_payable),
        paid_amount=float(bill.paid_amount),
        approval_flag=bill.approval_flag,
        is_milestone_fixed_amount=bill.is_milestone_fixed_amount,
        pre_tax_deductions=bool(bill.pre_tax_deductions),
        created_at=bill.created_at,
        deductions=ded_responses,
        items_json=bill.items_json,
        payment_mode=bill.payment_mode,
        payment_bank_name=bill.payment_bank_name,
        payment_ref=bill.payment_ref,
        ship_to=bill.ship_to,
        terms=bill.terms,
        match_id=bill.match_id,
        match_status=_derive_bill_match_status(db, bill),
        wo_id=bill.wo_id,
        # R2-371: echo the purchase order this bill was raised against.
        po_id=bill.po_id,
    )


# Theme B (soft flag): link an existing purchase/subcon bill to an approved ThreeWayMatch.
class BillMatchLinkRequest(BaseModel):
    match_id: Optional[UUID] = None


@router.patch("/bills/{bill_id}/match", response_model=BillResponse)
def link_bill_match(bill_id: UUID, req: BillMatchLinkRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    bill = db.query(Bill).filter(Bill.id == bill_id).first()
    if not bill:
        raise HTTPException(status_code=404, detail="Bill not found")
    get_company_membership(db, current_user, bill.company_id)
    verify_project_in_company(db, bill.project_id, bill.company_id)
    require_permission(db, current_user, bill.company_id, "billing:edit")

    if is_expense_invoice_type(bill.invoice_type):
        enforce_entry_editing_window(db, bill.company_id, bill.invoice_date)
        match_id = _resolve_bill_match_id(db, bill.invoice_type, req.match_id, bill.company_id, bill.project_id, total_payable=bill.total_payable)
        bill.match_id = match_id
        if match_id is not None:
            linked_match = db.query(ThreeWayMatch).filter(ThreeWayMatch.id == match_id).first()
            if linked_match:
                linked_match.invoice_id = bill.id
                db.add(linked_match)
    else:
        # Revenue, settlement, and movement invoices are exempt from 3-way matching; clear any supplied match.
        bill.match_id = None

    db.commit()
    db.refresh(bill)

    deductions = db.query(TransactionDeduction).filter(TransactionDeduction.bill_id == bill.id).all()
    ded_schemas = [
        DeductionResponseSchema(
            id=d.id,
            deduction_type=d.deduction_type,
            amount=float(d.amount),
            percentage=float(d.percentage) if d.percentage else None,
            notes=d.notes,
            release_due_date=d.release_due_date,
            released_at=d.released_at,
            released_amount=float(d.released_amount) if d.released_amount is not None else None,
        ) for d in deductions
    ]
    return BillResponse(
        id=bill.id,
        company_id=bill.company_id,
        project_id=bill.project_id,
        party_company_user_id=bill.party_company_user_id,
        invoice_number=bill.invoice_number,
        invoice_date=bill.invoice_date,
        due_date=bill.due_date,
        invoice_type=bill.invoice_type,
        status=bill.status,
        subtotal=float(bill.subtotal),
        gst_amount=float(bill.gst_amount),
        total_payable=float(bill.total_payable),
        paid_amount=float(bill.paid_amount),
        approval_flag=bill.approval_flag,
        is_milestone_fixed_amount=bill.is_milestone_fixed_amount,
        pre_tax_deductions=bool(bill.pre_tax_deductions),
        created_at=bill.created_at,
        deductions=ded_schemas,
        items_json=bill.items_json,
        payment_mode=bill.payment_mode,
        payment_bank_name=bill.payment_bank_name,
        payment_ref=bill.payment_ref,
        ship_to=bill.ship_to,
        terms=bill.terms,
        match_id=bill.match_id,
        match_status=_derive_bill_match_status(db, bill),
        wo_id=bill.wo_id,
        po_id=bill.po_id,
    )


# --- R2-377: retention release path ---
# Withheld retention was write-only: deducted from every subcon bill's payable
# but never recorded as a liability, with no way to give the money back or say
# when it falls due. The lifecycle columns on TransactionDeduction record the
# obligation; this endpoint is the release path. The cash payout itself keeps
# flowing through the existing Payments records.
class RetentionReleaseRequest(BaseModel):
    released_amount: Optional[float] = Field(None, gt=0)


@router.post("/bills/{bill_id}/deductions/{deduction_id}/release", response_model=DeductionResponseSchema)
def release_retention(bill_id: UUID, deduction_id: UUID, req: Optional[RetentionReleaseRequest] = None, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Release withheld retention back to the subcontractor.

    Only Retention deductions on non-cancelled bills can be released; TDS and
    other deduction types are remitted to authorities, not returned. Omitting
    the body releases the full outstanding amount; supplying released_amount
    performs a partial release (e.g. half at practical completion, half after
    the defect-liability period). Mirrors the R2-346 settlement gate: money
    only leaves against bills that have passed review."""
    bill = db.query(Bill).filter(Bill.id == bill_id).first()
    if not bill:
        raise HTTPException(status_code=404, detail="Bill not found")
    get_company_membership(db, current_user, bill.company_id)
    require_permission(db, current_user, bill.company_id, "finance:edit")
    ded = db.query(TransactionDeduction).filter(
        TransactionDeduction.id == deduction_id,
        TransactionDeduction.bill_id == bill.id,
    ).first()
    if not ded:
        raise HTTPException(status_code=404, detail="Deduction not found on this bill")
    if ded.deduction_type != "Retention":
        raise HTTPException(status_code=400, detail="Only Retention deductions can be released")
    if bill.status == "Cancelled":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot release retention on a cancelled bill",
        )
    if bill.approval_flag not in ("approved", "auto_approved"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Bill must pass review before its retention can be released",
        )
    already = float(ded.released_amount or 0.0)
    outstanding = round(float(ded.amount) - already, 2)
    if outstanding <= 0:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Retention is already fully released")
    amount = round(float(req.released_amount), 2) if req is not None and req.released_amount is not None else outstanding
    if amount > outstanding:
        raise HTTPException(
            status_code=422,
            detail=f"Release of \u20b9{amount:,.2f} exceeds the outstanding retention of \u20b9{outstanding:,.2f}",
        )
    ded.released_amount = round(already + amount, 2)
    ded.released_at = datetime.now(timezone.utc)
    db.add(ded)
    db.commit()
    db.refresh(ded)
    return DeductionResponseSchema(
        id=ded.id,
        deduction_type=ded.deduction_type,
        amount=float(ded.amount),
        percentage=float(ded.percentage) if ded.percentage else None,
        notes=ded.notes,
        release_due_date=ded.release_due_date,
        released_at=ded.released_at,
        released_amount=float(ded.released_amount) if ded.released_amount is not None else None,
    )


# 3. Debit Notes
@router.get("/debit-notes", response_model=List[DebitNoteResponse])
def get_debit_notes(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access), current_user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    require_module_view(db, current_user, project.company_id, "billing")
    notes = db.query(DebitNote).filter(DebitNote.project_id == project_id).all()
    return [
        DebitNoteResponse(
            id=n.id,
            project_id=n.project_id,
            company_id=n.company_id,
            party_company_user_id=n.party_company_user_id,
            notes=n.notes,
            total_amount=float(n.total_amount),
            work_amount=float(n.work_amount),
            gst_amount=float(n.gst_amount),
            bill_id=n.bill_id,
            reference_number=n.reference_number,
            approval_flag=n.approval_flag,
            created_at=n.created_at
        ) for n in notes
    ]

@router.post("/debit-notes", response_model=DebitNoteResponse, status_code=201)
def create_debit_note(req: DebitNoteCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Tenant check: the caller must be a member of the company this debit note belongs to.
    get_company_membership(db, current_user, req.company_id)
    verify_project_in_company(db, req.project_id, req.company_id)
    require_permission(db, current_user, req.company_id, "billing:edit")

    note = DebitNote(
        project_id=req.project_id,
        company_id=req.company_id,
        party_company_user_id=req.party_company_user_id,
        notes=req.notes,
        total_amount=req.total_amount,
        work_amount=req.work_amount,
        gst_amount=req.gst_amount,
        bill_id=req.bill_id,
        reference_number=req.reference_number,
        approval_flag="pending"
    )
    db.add(note)
    db.commit()
    db.refresh(note)
    
    return DebitNoteResponse(
        id=note.id,
        project_id=note.project_id,
        company_id=note.company_id,
        party_company_user_id=note.party_company_user_id,
        notes=note.notes,
        total_amount=float(note.total_amount),
        work_amount=float(note.work_amount),
        gst_amount=float(note.gst_amount),
        bill_id=note.bill_id,
        reference_number=note.reference_number,
        approval_flag=note.approval_flag,
        created_at=note.created_at
    )

# 4. Credit Notes
@router.get("/credit-notes", response_model=List[CreditNoteResponse])
def get_credit_notes(project_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access), current_user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    require_module_view(db, current_user, project.company_id, "billing")
    notes = db.query(CreditNote).filter(CreditNote.project_id == project_id).all()
    return [
        CreditNoteResponse(
            id=n.id,
            project_id=n.project_id,
            company_id=n.company_id,
            party_company_user_id=n.party_company_user_id,
            notes=n.notes,
            total_amount=float(n.total_amount),
            bill_id=n.bill_id,
            reference_number=n.reference_number,
            approval_flag=n.approval_flag,
            created_at=n.created_at
        ) for n in notes
    ]

@router.post("/credit-notes", response_model=CreditNoteResponse, status_code=201)
def create_credit_note(req: CreditNoteCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Tenant check: the caller must be a member of the company this credit note belongs to.
    get_company_membership(db, current_user, req.company_id)
    verify_project_in_company(db, req.project_id, req.company_id)
    require_permission(db, current_user, req.company_id, "billing:edit")

    note = CreditNote(
        project_id=req.project_id,
        company_id=req.company_id,
        party_company_user_id=req.party_company_user_id,
        notes=req.notes,
        total_amount=req.total_amount,
        bill_id=req.bill_id,
        reference_number=req.reference_number,
        approval_flag="pending"
    )
    db.add(note)
    db.commit()
    db.refresh(note)
    
    return CreditNoteResponse(
        id=note.id,
        project_id=note.project_id,
        company_id=note.company_id,
        party_company_user_id=note.party_company_user_id,
        notes=note.notes,
        total_amount=float(note.total_amount),
        bill_id=note.bill_id,
        reference_number=note.reference_number,
        approval_flag=note.approval_flag,
        created_at=note.created_at
    )

@router.post("/debit-notes/{note_id}/cancel", response_model=DebitNoteResponse)
def cancel_debit_note(note_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    note = db.query(DebitNote).filter(DebitNote.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Debit note not found")
    get_company_membership(db, current_user, note.company_id)
    require_permission(db, current_user, note.company_id, "billing:edit")
    if note.approval_flag == "cancelled":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Debit note is already cancelled")
    enforce_entry_editing_window(db, note.company_id, note.created_at)
    note.approval_flag = "cancelled"
    db.add(note)
    db.commit()
    db.refresh(note)
    return DebitNoteResponse(
        id=note.id,
        project_id=note.project_id,
        company_id=note.company_id,
        party_company_user_id=note.party_company_user_id,
        notes=note.notes,
        total_amount=float(note.total_amount),
        work_amount=float(note.work_amount),
        gst_amount=float(note.gst_amount),
        bill_id=note.bill_id,
        reference_number=note.reference_number,
        approval_flag=note.approval_flag,
        created_at=note.created_at
    )

@router.post("/credit-notes/{note_id}/cancel", response_model=CreditNoteResponse)
def cancel_credit_note(note_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    note = db.query(CreditNote).filter(CreditNote.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Credit note not found")
    get_company_membership(db, current_user, note.company_id)
    require_permission(db, current_user, note.company_id, "billing:edit")
    if note.approval_flag == "cancelled":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Credit note is already cancelled")
    enforce_entry_editing_window(db, note.company_id, note.created_at)
    note.approval_flag = "cancelled"
    db.add(note)
    db.commit()
    db.refresh(note)
    return CreditNoteResponse(
        id=note.id,
        project_id=note.project_id,
        company_id=note.company_id,
        party_company_user_id=note.party_company_user_id,
        notes=note.notes,
        total_amount=float(note.total_amount),
        bill_id=note.bill_id,
        reference_number=note.reference_number,
        approval_flag=note.approval_flag,
        created_at=note.created_at
    )


# 6. Subcontractors (userless CompanyTeam + linked LibraryParty, no login)
class SubcontractorCreateRequest(BaseModel):
    company_id: UUID
    name: str
    phone: Optional[str] = None
    email: Optional[str] = None
    tax_no: Optional[str] = None  # also accepts "gstin"
    gstin: Optional[str] = None
    bank_name: Optional[str] = None
    account_number: Optional[str] = None
    ifsc_code: Optional[str] = None
    address: Optional[str] = None


class SubcontractorUpdateRequest(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    tax_no: Optional[str] = None
    gstin: Optional[str] = None
    bank_name: Optional[str] = None
    account_number: Optional[str] = None
    ifsc_code: Optional[str] = None
    address: Optional[str] = None


class SubcontractorResponse(BaseModel):
    company_team_id: UUID
    library_party_id: UUID
    name: str


class SubcontractorListResponse(BaseModel):
    company_team_id: UUID
    name: str
    gstin: Optional[str] = None
    phone: Optional[str] = None

    class Config:
        from_attributes = True


@router.post("/subcontractors", response_model=SubcontractorResponse, status_code=201)
def create_subcontractor(req: SubcontractorCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Tenant + RBAC: only team managers may register an external subcontractor.
    get_company_membership(db, current_user, req.company_id)
    require_permission(db, current_user, req.company_id, "team:manage")

    if not req.name or not req.name.strip():
        raise HTTPException(status_code=400, detail="Subcontractor name is required")

    tax_no = req.tax_no or req.gstin
    party = models.LibraryParty(
        company_id=req.company_id,
        party_id_custom=next_party_id_custom(db, req.company_id),
        name=req.name.strip(),
        phone=req.phone,
        email=req.email,
        party_type="Subcontractor",
        address=req.address,
        bank_name=req.bank_name,
        account_number=req.account_number,
        ifsc_code=req.ifsc_code,
        tax_no=tax_no,
    )
    db.add(party)
    db.flush()

    # External subcontractor = a CompanyTeam row with no login (user_id NULL),
    # priority_type "subcontractor", linked to the vendor master via library_party_id.
    team = models.CompanyTeam(
        company_id=req.company_id,
        user_id=None,
        role_id=None,
        priority_type="subcontractor",
        library_party_id=party.id,
    )
    db.add(team)
    db.commit()
    db.refresh(team)

    return SubcontractorResponse(
        company_team_id=team.id,
        library_party_id=party.id,
        name=party.name,
    )


@router.get("/subcontractors", response_model=List[SubcontractorListResponse])
def list_subcontractors(company_id: UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    rows = (
        db.query(
            CompanyTeam.id,
            CompanyTeam.user_id,
            CompanyTeam.library_party_id,
            User.name.label("user_name"),
            LibraryParty.name.label("party_name"),
            LibraryParty.tax_no,
            LibraryParty.phone,
        )
        .outerjoin(User, User.id == CompanyTeam.user_id)
        .outerjoin(LibraryParty, LibraryParty.id == CompanyTeam.library_party_id)
        .filter(
            CompanyTeam.company_id == company_id,
            CompanyTeam.priority_type == "subcontractor",
        )
        .all()
    )
    res = []
    for r in rows:
        display_name = r.user_name or r.party_name or "Unknown"
        res.append(
            SubcontractorListResponse(
                company_team_id=r.id,
                name=display_name,
                gstin=r.tax_no,
                phone=r.phone,
            )
        )
    return res


@router.put("/subcontractors/{team_id}", response_model=SubcontractorResponse)
def update_subcontractor(team_id: UUID, req: SubcontractorUpdateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    team = db.query(models.CompanyTeam).filter(models.CompanyTeam.id == team_id).first()
    if not team:
        raise HTTPException(status_code=404, detail="Subcontractor not found")
    get_company_membership(db, current_user, team.company_id)
    require_permission(db, current_user, team.company_id, "team:manage")

    party = None
    if team.library_party_id:
        party = db.query(models.LibraryParty).filter(models.LibraryParty.id == team.library_party_id).first()

    if party:
        if req.name and req.name.strip():
            party.name = req.name.strip()
        if req.phone is not None:
            party.phone = req.phone
        if req.email is not None:
            party.email = req.email
        tax_no = req.tax_no or req.gstin
        if tax_no is not None:
            party.tax_no = tax_no
        if req.bank_name is not None:
            party.bank_name = req.bank_name
        if req.account_number is not None:
            party.account_number = req.account_number
        if req.ifsc_code is not None:
            party.ifsc_code = req.ifsc_code
        if req.address is not None:
            party.address = req.address

    db.commit()
    return SubcontractorResponse(
        company_team_id=team.id,
        library_party_id=team.library_party_id or team.id,
        name=party.name if party else "Subcontractor",
    )


@router.delete("/subcontractors/{team_id}")
def delete_subcontractor(team_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    team = db.query(models.CompanyTeam).filter(models.CompanyTeam.id == team_id).first()
    if not team:
        raise HTTPException(status_code=404, detail="Subcontractor not found")
    get_company_membership(db, current_user, team.company_id)
    require_permission(db, current_user, team.company_id, "team:manage")

    from app.routers.delete_logs import log_deletion
    party_name = "Subcontractor"
    if team.library_party_id:
        party = db.query(models.LibraryParty).filter(models.LibraryParty.id == team.library_party_id).first()
        if party:
            party_name = party.name
            db.delete(party)

    log_deletion(db, team.company_id, "subcontractor", team.id, f"Subcontractor: {party_name}", deleted_by=current_user.name)
    db.delete(team)
    db.commit()
    return {"success": True}
