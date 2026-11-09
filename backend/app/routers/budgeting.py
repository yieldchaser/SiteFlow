import io
from datetime import datetime
from uuid import UUID
from typing import List, Optional
from zipfile import BadZipFile
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Response, status
from sqlalchemy.orm import Session
from sqlalchemy import select
from openpyxl import load_workbook
from openpyxl.utils.exceptions import InvalidFileException
from app.database import get_db
from app.auth import get_current_user, verify_project_access, get_company_membership, require_permission, require_module_view
from app.constants import REVENUE_INVOICE_TYPES
from app.models import BOQItem, BOQDocument, ProjectBudget, Project, Bill, LibraryParty, Task, User, BOQRevision, LibraryCostCode, WorkOrderItem, WorkOrder
from app.workflow_controls import get_default_terms
from app.utils.pdf_generator import generate_document_pdf
from app.utils.document_pdf import resolve_pdf_branding, resolve_supplier_tax_details
from pydantic import BaseModel, Field

router = APIRouter(
    prefix="/budgeting",
    tags=["Budgeting & BOQ"],
    dependencies=[Depends(get_current_user)]
)

class BOQItemResponse(BaseModel):
    id: UUID
    project_id: UUID
    section_name: Optional[str] = None
    item_name: str
    cost_code: Optional[str] = None
    unit: str
    quantity: float
    rate: float
    supply_rate: float
    installation_rate: float
    amount: float
    quantity_float_limit: int

    class Config:
        from_attributes = True

class BOQItemCreate(BaseModel):
    item_name: str = Field(..., min_length=1)
    unit: str = "Nos"
    quantity: float = Field(0.0, ge=0)
    rate: float = Field(0.0, ge=0)
    supply_rate: float = Field(0.0, ge=0)
    installation_rate: float = Field(0.0, ge=0)
    section_name: Optional[str] = None
    cost_code: Optional[str] = None

class BudgetAllocationRequest(BaseModel):
    project_id: UUID
    material_budget: float = Field(0.0, ge=0)
    labour_budget: float = Field(0.0, ge=0)
    subcon_budget: float = Field(0.0, ge=0)
    equipment_budget: float = Field(0.0, ge=0)

class BudgetResponse(BaseModel):
    id: UUID
    project_id: UUID
    material_budget: float
    labour_budget: float
    subcon_budget: float
    equipment_budget: float

    class Config:
        from_attributes = True

class BOQItemProgress(BaseModel):
    boq_item_id: UUID
    done_pct: float
    work_done_value: float
    ordered_qty: float
    ordered_value: float
    task_count: int


@router.get("/boq-progress", response_model=List[BOQItemProgress])
def get_boq_progress(project_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user), _: None = Depends(verify_project_access)):
    """Per BOQ line, what the site has actually done and ordered.

    Done is the average physical progress of the tasks linked to the line;
    work done is the line's value times that. Ordered is the work order
    lines placed against it (cancelled work orders left out). The page used
    to spread total client billing across lines by value, so every line
    showed the same made-up percentage.
    """
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    require_module_view(db, current_user, project.company_id, "budgeting")

    items = db.query(BOQItem).filter(BOQItem.project_id == project_id).all()
    progress: dict = {}
    for t in db.query(Task).filter(Task.project_id == project_id, Task.boq_item_id.isnot(None)).all():
        progress.setdefault(t.boq_item_id, []).append(float(t.progress or 0))
    ordered: dict = {}
    rows = (
        db.query(WorkOrderItem)
        .join(WorkOrder, WorkOrder.id == WorkOrderItem.wo_id)
        .filter(WorkOrder.project_id == project_id, WorkOrder.status != "cancelled", WorkOrderItem.boq_item_id.isnot(None))
        .all()
    )
    for wi in rows:
        q, v = ordered.get(wi.boq_item_id, (0.0, 0.0))
        value = float(wi.amount) if wi.amount is not None else float(wi.quantity) * float(wi.rate)
        ordered[wi.boq_item_id] = (q + float(wi.quantity), v + value)

    out = []
    for item in items:
        pcts = progress.get(item.id, [])
        done = min(max(sum(pcts) / len(pcts), 0.0), 100.0) if pcts else 0.0
        value = float(item.amount) if item.amount is not None else float(item.quantity) * _effective_unit_rate(item.rate, item.supply_rate, item.installation_rate)
        oq, ov = ordered.get(item.id, (0.0, 0.0))
        out.append(BOQItemProgress(
            boq_item_id=item.id, done_pct=round(done, 2), work_done_value=round(value * done / 100.0, 2),
            ordered_qty=oq, ordered_value=round(ov, 2), task_count=len(pcts),
        ))
    return out


@router.get("/boq", response_model=List[BOQItemResponse])
def get_boq_items(project_id: UUID, boq_document_id: Optional[UUID] = None, db: Session = Depends(get_db), current_user: User = Depends(get_current_user), _: None = Depends(verify_project_access)):
    # Check if project exists
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    require_module_view(db, current_user, project.company_id, "budgeting")

    q = db.query(BOQItem).filter(BOQItem.project_id == project_id)
    if boq_document_id is not None:
        q = q.filter(BOQItem.boq_document_id == boq_document_id)
    items = q.all()
    # Cast Numeric types to floats for response model compatibility
    result = []
    for item in items:
            result.append(BOQItemResponse(
                id=item.id,
                project_id=item.project_id,
                section_name=item.section_name,
                item_name=item.item_name,
                cost_code=item.cost_code,
                unit=item.unit,
            quantity=float(item.quantity),
            rate=float(item.rate),
            supply_rate=float(item.supply_rate),
            installation_rate=float(item.installation_rate),
            amount=float(item.amount or 0.0) if item.amount is not None else float(item.quantity) * _effective_unit_rate(item.rate, item.supply_rate, item.installation_rate),
            quantity_float_limit=item.quantity_float_limit
        ))
    return result

@router.post("/boq/import", status_code=status.HTTP_201_CREATED)
async def import_boq(
    project_id: UUID = Form(...),
    file: UploadFile = File(...),
    boq_document_id: Optional[UUID] = Form(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user)
):
    # project_id here comes from multipart form data (not the URL path/query),
    # so it can't share a value with a plain Depends(verify_project_access)
    # sub-dependency; verify membership inline once the project is loaded instead.
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "budgeting:edit")

    if not file.filename.endswith(('.xlsx', '.xlsm')):
        raise HTTPException(status_code=400, detail="Only .xlsx or .xlsm Excel files are supported")

    try:
        contents = await file.read()
        wb = load_workbook(filename=io.BytesIO(contents), read_only=True)
        sheet = wb.active
        if not sheet:
            raise HTTPException(status_code=400, detail="Excel file is empty")

        # Parse header row (assume first row has headers). R2-453: a sheet
        # with zero rows makes next() raise StopIteration, which used to
        # escape the handler as a 500 instead of the empty-file 400 below.
        header_row = next(sheet.iter_rows(values_only=True), None)
        if header_row is None:
            raise HTTPException(status_code=400, detail="Excel file is empty")
        headers = {}
        for idx, val in enumerate(header_row):
            if val:
                headers[str(val).strip().lower()] = idx

        # Required columns check
        name_col = next((headers[k] for k in ["item_name", "item", "description", "name"] if k in headers), None)
        qty_col = next((headers[k] for k in ["qty", "quantity"] if k in headers), None)
        unit_col = headers.get("unit")
        rate_col = next((headers[k] for k in ["rate", "unit_rate"] if k in headers), None)
        
        # Optional split rates
        supply_rate_col = headers.get("supply_rate")
        install_rate_col = next((headers[k] for k in ["installation_rate", "install_rate"] if k in headers), None)
        section_col = next((headers[k] for k in ["section", "section_name"] if k in headers), None)
        cost_code_col = next((headers[k] for k in ["cost_code", "cost code"] if k in headers), None)

        if name_col is None or qty_col is None or unit_col is None or (rate_col is None and supply_rate_col is None):
            raise HTTPException(
                status_code=400,
                detail="Invalid headers. Excel must contain: Description/Item Name, Qty, Unit, and Rate (or Supply Rate)."
            )

        imported_count = 0
        skipped_count = 0
        skipped_details = []
        total_amount = 0.0
        pending_items = []
        cost_codes_seen = set()

        # R2-450: a partially imported BOQ must never be reported like a
        # complete one, so every dropped row is counted and explained.
        for offset, row in enumerate(sheet.iter_rows(values_only=True)):
            row_no = offset + 1  # 1-based spreadsheet row number
            if offset == 0:
                continue

            item_name = row[name_col]
            if not item_name:
                # A fully blank row is sheet padding, not lost data; a row
                # that carries quantities under a blank name cell (merged
                # cells) would otherwise vanish from the totals unseen.
                if any(v is not None and str(v).strip() for v in row):
                    skipped_count += 1
                    skipped_details.append(f"Row {row_no}: item name is blank, skipped")
                continue

            qty_val = row[qty_col]
            unit_val = row[unit_col]
            rate_val = row[rate_col] if rate_col is not None else 0.0
            supply_val = row[supply_rate_col] if supply_rate_col is not None else 0.0
            install_val = row[install_rate_col] if install_rate_col is not None else 0.0

            try:
                quantity = float(qty_val) if qty_val is not None else 0.0
                rate = float(rate_val) if rate_val is not None else 0.0
                supply_rate = float(supply_val) if supply_val is not None else 0.0
                installation_rate = float(install_val) if install_val is not None else 0.0
            except (TypeError, ValueError):
                # TypeError included: float() raises it (not ValueError) on
                # datetime or None-typed cell objects, which used to abort
                # the whole import with a 500 instead of skipping the row.
                skipped_count += 1
                skipped_details.append(f"Row {row_no}: quantity or rate is not numeric ({qty_val!r}), skipped")
                continue

            section_name = str(row[section_col]).strip() if (section_col is not None and row[section_col]) else None
            cost_code_val = str(row[cost_code_col]).strip() if (cost_code_col is not None and row[cost_code_col]) else None
            unit = str(unit_val).strip() if unit_val else "Nos"

            # Enforce quantity float limit (rounding base)
            float_limit = 2
            if unit.lower() in ("kg", "ton", "t", "steel"):
                float_limit = 3
            elif unit.lower() in ("no", "nos", "brick", "bag", "bags"):
                float_limit = 0

            # R2-451: a row quoting a composite rate alongside its
            # supply/install split is charged once, not twice.
            amount = quantity * _effective_unit_rate(rate, supply_rate, installation_rate)
            total_amount += amount

            boq_item = BOQItem(
                project_id=project_id,
                boq_document_id=boq_document_id,
                section_name=section_name,
                cost_code=cost_code_val,
                item_name=str(item_name).strip(),
                unit=unit,
                quantity=quantity,
                rate=rate,
                supply_rate=supply_rate,
                installation_rate=installation_rate,
                quantity_float_limit=float_limit,
                amount=amount
            )
            pending_items.append(boq_item)
            imported_count += 1
            if cost_code_val:
                cost_codes_seen.add(cost_code_val)

        # R2-334: every non-empty cost code must exist in the company's Cost
        # Code Library. Otherwise one spreadsheet typo silently forks a sixth
        # code that never rolls up with the rest.
        if cost_codes_seen:
            known_codes = set(
                code for (code,) in db.query(LibraryCostCode.code).filter(
                    LibraryCostCode.company_id == project.company_id,
                    LibraryCostCode.code.in_(cost_codes_seen),
                ).all()
            )
            unknown_codes = sorted(cost_codes_seen - known_codes)
            if unknown_codes:
                raise HTTPException(
                    status_code=400,
                    detail="Unknown cost codes (add them to the Cost Code Library first): " + ", ".join(unknown_codes),
                )

        for boq_item in pending_items:
            db.add(boq_item)

        db.commit()
        return {
            "success": True,
            "imported_count": imported_count,
            "skipped_count": skipped_count,
            "warnings": skipped_details,
            "total_estimated_cost": total_amount
        }

    except HTTPException:
        db.rollback()
        raise
    except (InvalidFileException, BadZipFile):
        # R2-453: a corrupt or fake .xlsx is a user error. openpyxl's raw
        # message ("File is not a zip file") used to surface as
        # 500 "Import failed: File is not a zip file".
        db.rollback()
        raise HTTPException(status_code=400, detail="Uploaded file could not be read as an Excel (.xlsx) file. Please upload a valid BOQ Excel export.")
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Import failed: {str(e)}")

@router.post("/allocation", response_model=BudgetResponse)
def allocate_project_budgets(
    request: BudgetAllocationRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    project = db.query(Project).filter(Project.id == request.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "budgeting:edit")

    budget = db.query(ProjectBudget).filter(ProjectBudget.project_id == request.project_id).first()
    if not budget:
        budget = ProjectBudget(project_id=request.project_id)
        db.add(budget)

    budget.material_budget = request.material_budget
    budget.labour_budget = request.labour_budget
    budget.subcon_budget = request.subcon_budget
    budget.equipment_budget = request.equipment_budget

    db.commit()
    db.refresh(budget)
    return budget


# ─── BOQ Documents (per-client BOQ layer) ────────────────────────────────────
# Invoices raised to the client whose value counts toward "Billed Value".
# D3: use the single shared revenue bucket so settlement/movement never leak
# into billed value.
BILLING_TYPES = set(REVENUE_INVOICE_TYPES)


def _effective_unit_rate(rate, supply_rate, installation_rate) -> float:
    # R2-451: an item is quoted either as one composite rate or as a supply
    # rate plus an installation rate. Templates often carry the composite
    # Rate column alongside its split; adding all three charged the work
    # twice, so the composite wins and the split only fills in when no
    # composite rate was given.
    r = float(rate or 0.0)
    return r if r else float(supply_rate or 0.0) + float(installation_rate or 0.0)


def _item_amount(i: BOQItem) -> float:
    if i.amount is not None:
        return float(i.amount)
    return float(i.quantity) * _effective_unit_rate(i.rate, i.supply_rate, i.installation_rate)


class BOQDocumentCreate(BaseModel):
    project_id: UUID
    title: str
    client_party_id: Optional[UUID] = None
    milestone_done: int = Field(0, ge=0)
    milestone_total: int = Field(0, ge=0)
    terms: Optional[str] = None  # Terms & Conditions; defaults to company BOQ Terms on create


class BOQDocumentPatch(BaseModel):
    title: Optional[str] = None
    client_party_id: Optional[UUID] = None
    milestone_done: Optional[int] = Field(None, ge=0)
    milestone_total: Optional[int] = Field(None, ge=0)
    terms: Optional[str] = None


class BOQDocumentResponse(BaseModel):
    id: UUID
    project_id: UUID
    client_party_id: Optional[UUID] = None
    client_name: Optional[str] = None
    title: str
    milestone_done: int
    milestone_total: int
    boq_value: float
    revised_amount: Optional[float] = None
    billed_value: float
    physical_progress: float  # 0-100, value-weighted linked-task completion
    item_count: int
    terms: Optional[str] = None

    class Config:
        from_attributes = True


def _build_doc_response(db: Session, d: BOQDocument) -> BOQDocumentResponse:
    items = db.query(BOQItem).filter(BOQItem.boq_document_id == d.id).all()
    boq_value = sum(_item_amount(i) for i in items)

    bills = (
        db.query(Bill)
        .filter(Bill.project_id == d.project_id, Bill.boq_document_id == d.id, Bill.invoice_type.in_(BILLING_TYPES), Bill.status != "Cancelled")
        .all()
    )
    # Work value billed (before GST and deductions), so it compares with the
    # BOQ value, which is also before GST. total_payable read 18% high.
    billed_value = sum(float(b.subtotal or 0) for b in bills)

    # Physical progress = value-weighted average of linked-task completion.
    item_ids = [i.id for i in items]
    progress_by_item: dict = {}
    if item_ids:
        tasks = db.query(Task).filter(Task.boq_item_id.in_(item_ids)).all()
        for t in tasks:
            progress_by_item.setdefault(t.boq_item_id, []).append(float(t.progress or 0))
    num = 0.0
    den = 0.0
    for i in items:
        amt = _item_amount(i)
        ps = progress_by_item.get(i.id)
        pct = (sum(ps) / len(ps)) if ps else 0.0
        num += amt * pct
        den += amt
    physical_progress = round(num / den, 2) if den > 0 else 0.0

    party = db.query(LibraryParty).filter(LibraryParty.id == d.client_party_id).first() if d.client_party_id else None
    return BOQDocumentResponse(
        id=d.id,
        project_id=d.project_id,
        client_party_id=d.client_party_id,
        client_name=party.name if party else None,
        title=d.title,
        milestone_done=d.milestone_done,
        milestone_total=d.milestone_total,
        boq_value=round(boq_value, 2),
        revised_amount=float(d.revised_amount) if d.revised_amount is not None else None,
        billed_value=round(billed_value, 2),
        physical_progress=physical_progress,
        item_count=len(items),
        terms=d.terms,
    )


@router.get("/boq-documents", response_model=List[BOQDocumentResponse])
def list_boq_documents(project_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user), _: None = Depends(verify_project_access)):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    require_module_view(db, current_user, project.company_id, "budgeting")
    docs = db.query(BOQDocument).filter(BOQDocument.project_id == project_id).all()
    return [_build_doc_response(db, d) for d in docs]


@router.post("/boq-documents", response_model=BOQDocumentResponse, status_code=201)
def create_boq_document(req: BOQDocumentCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == req.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "budgeting:edit")
    if req.milestone_done > req.milestone_total:
        raise HTTPException(status_code=400, detail="milestone_done cannot exceed milestone_total")
    if req.client_party_id:
        party = db.query(LibraryParty).filter(LibraryParty.id == req.client_party_id).first()
        if not party:
            raise HTTPException(status_code=404, detail="Client party not found")
    doc = BOQDocument(
        project_id=req.project_id,
        client_party_id=req.client_party_id,
        title=req.title,
        milestone_done=req.milestone_done,
        milestone_total=req.milestone_total,
        # Settings -> Terms & Conditions -> BOQ Terms: pre-fill the company
        # default when the caller doesn't supply their own terms.
        terms=req.terms
        if req.terms
        else get_default_terms(db, project.company_id, "boq"),
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return _build_doc_response(db, doc)


@router.patch("/boq-documents/{doc_id}", response_model=BOQDocumentResponse)
def patch_boq_document(doc_id: UUID, req: BOQDocumentPatch, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    doc = db.query(BOQDocument).filter(BOQDocument.id == doc_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="BOQ document not found")
    project = db.query(Project).filter(Project.id == doc.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "budgeting:edit")
    if req.title is not None:
        doc.title = req.title
    if req.client_party_id is not None:
        doc.client_party_id = req.client_party_id
    if req.milestone_done is not None:
        doc.milestone_done = req.milestone_done
    if req.milestone_total is not None:
        doc.milestone_total = req.milestone_total
    if (req.milestone_done is not None or req.milestone_total is not None) and doc.milestone_done > doc.milestone_total:
        raise HTTPException(status_code=400, detail="milestone_done cannot exceed milestone_total")
    if req.terms is not None:
        doc.terms = req.terms
    db.commit()
    db.refresh(doc)
    return _build_doc_response(db, doc)


@router.post("/boq-documents/{doc_id}/items", response_model=BOQItemResponse, status_code=status.HTTP_201_CREATED)
def create_boq_item(doc_id: UUID, req: BOQItemCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    doc = db.query(BOQDocument).filter(BOQDocument.id == doc_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="BOQ document not found")
    project = db.query(Project).filter(Project.id == doc.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "budgeting:edit")

    # R2-334: same library gate as the spreadsheet importer. A cost code that
    # is not in the company's Cost Code Library would never roll up.
    if req.cost_code:
        known = db.query(LibraryCostCode.id).filter(
            LibraryCostCode.company_id == project.company_id,
            LibraryCostCode.code == req.cost_code,
        ).first()
        if not known:
            raise HTTPException(status_code=400, detail="Unknown cost code (add it to the Cost Code Library first)")

    float_limit = 2
    if req.unit.lower() in ("kg", "ton", "t", "steel"):
        float_limit = 3
    elif req.unit.lower() in ("no", "nos", "brick", "bag", "bags"):
        float_limit = 0

    amount = req.quantity * _effective_unit_rate(req.rate, req.supply_rate, req.installation_rate)
    item = BOQItem(
        project_id=doc.project_id,
        boq_document_id=doc.id,
        section_name=req.section_name,
        cost_code=req.cost_code,
        item_name=req.item_name.strip(),
        unit=req.unit,
        quantity=req.quantity,
        rate=req.rate,
        supply_rate=req.supply_rate,
        installation_rate=req.installation_rate,
        quantity_float_limit=float_limit,
        amount=amount,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return BOQItemResponse(
        id=item.id,
        project_id=item.project_id,
        section_name=item.section_name,
        item_name=item.item_name,
        cost_code=item.cost_code,
        unit=item.unit,
        quantity=float(item.quantity),
        rate=float(item.rate),
        supply_rate=float(item.supply_rate),
        installation_rate=float(item.installation_rate),
        amount=float(item.amount),
        quantity_float_limit=item.quantity_float_limit,
    )


# R2-449: a line item that can only ever be added (Excel import or POST items)
# cannot be corrected in place, so the only fix for a wrong rate was a
# corrective re-import that doubled the document's lines. PATCH and DELETE
# close that loop. tasks/work_order_items reference boq_items with
# ON DELETE SET NULL, so deleting a row nulls links instead of failing.


def _unit_float_limit(unit: str) -> int:
    u = unit.lower()
    if u in ("kg", "ton", "t", "steel"):
        return 3
    if u in ("no", "nos", "brick", "bag", "bags"):
        return 0
    return 2


class BOQItemPatch(BaseModel):
    section_name: Optional[str] = None
    item_name: Optional[str] = Field(None, min_length=1)
    cost_code: Optional[str] = None
    unit: Optional[str] = None
    quantity: Optional[float] = Field(None, ge=0)
    rate: Optional[float] = Field(None, ge=0)
    supply_rate: Optional[float] = Field(None, ge=0)
    installation_rate: Optional[float] = Field(None, ge=0)


@router.patch("/boq/{item_id}", response_model=BOQItemResponse)
def update_boq_item(item_id: UUID, req: BOQItemPatch, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(BOQItem).filter(BOQItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="BOQ line item not found")
    project = db.query(Project).filter(Project.id == item.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "budgeting:edit")

    if req.item_name is not None:
        item.item_name = req.item_name.strip()
    if req.section_name is not None:
        item.section_name = req.section_name or None
    if req.unit is not None and req.unit.strip():
        item.unit = req.unit.strip()
    if req.cost_code is not None:
        code = req.cost_code.strip() or None
        # R2-334 parity with the importer and create: a code outside the
        # company's Cost Code Library never rolls up.
        if code:
            known = db.query(LibraryCostCode.id).filter(
                LibraryCostCode.company_id == project.company_id,
                LibraryCostCode.code == code,
            ).first()
            if not known:
                raise HTTPException(status_code=400, detail="Unknown cost code (add it to the Cost Code Library first)")
        item.cost_code = code
    if req.quantity is not None:
        item.quantity = req.quantity
    if req.rate is not None:
        item.rate = req.rate
    if req.supply_rate is not None:
        item.supply_rate = req.supply_rate
    if req.installation_rate is not None:
        item.installation_rate = req.installation_rate

    item.quantity_float_limit = _unit_float_limit(item.unit)
    item.amount = float(item.quantity) * _effective_unit_rate(
        item.rate, item.supply_rate, item.installation_rate
    )
    db.commit()
    db.refresh(item)
    return BOQItemResponse(
        id=item.id,
        project_id=item.project_id,
        section_name=item.section_name,
        item_name=item.item_name,
        cost_code=item.cost_code,
        unit=item.unit,
        quantity=float(item.quantity),
        rate=float(item.rate),
        supply_rate=float(item.supply_rate),
        installation_rate=float(item.installation_rate),
        amount=float(item.amount),
        quantity_float_limit=item.quantity_float_limit,
    )


@router.delete("/boq/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_boq_item(item_id: UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(BOQItem).filter(BOQItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="BOQ line item not found")
    project = db.query(Project).filter(Project.id == item.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "budgeting:edit")
    # Deleting a line that tasks or work orders measure against silently
    # unlinked them (ON DELETE SET NULL), so progress and subcontractor
    # billing lost their BOQ reference. Make the user unlink them first.
    task_count = db.query(Task).filter(Task.boq_item_id == item.id).count()
    wo_count = db.query(WorkOrderItem).filter(WorkOrderItem.boq_item_id == item.id).count()
    if task_count or wo_count:
        parts = []
        if task_count:
            parts.append(f"{task_count} task{'s' if task_count != 1 else ''}")
        if wo_count:
            parts.append(f"{wo_count} work order line{'s' if wo_count != 1 else ''}")
        raise HTTPException(
            status_code=409,
            detail=f"This BOQ line is used by {' and '.join(parts)}. Link them to another line first, then delete it.",
        )
    db.delete(item)
    db.commit()


@router.get("/boq-documents/{doc_id}/pdf")
def get_boq_document_pdf(doc_id: UUID, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    doc = db.query(BOQDocument).filter(BOQDocument.id == doc_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="BOQ document not found")
    # Tenant check: the document's project belongs to a company the caller is a member of.
    project = db.query(Project).filter(Project.id == doc.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_module_view(db, current_user, project.company_id, "budgeting")

    company_name, custom_banner = resolve_pdf_branding(db, project.company_id, project)
    from app.utils.document_pdf import load_branding_assets
    branding = load_branding_assets(db, project.company_id)
    # R2-607: the registered supplier identity (legal name, GSTIN, phone,
    # address) is stored on the Company/branch rows; print it under the BOQ
    # masthead like the bill PDF already does (R2-403).
    supplier_lines = resolve_supplier_tax_details(db, project.company_id, project)
    party = db.query(LibraryParty).filter(LibraryParty.id == doc.client_party_id).first() if doc.client_party_id else None
    client_name = party.name if party else "N/A"

    party_lines = [
        f"Client: {client_name}",
        f"Title: {doc.title}",
        # Defence in depth: legacy rows may hold done > total; never print
        # an impossible milestone count on the client-facing document.
        f"Milestones: {min(doc.milestone_done, doc.milestone_total)} / {doc.milestone_total}",
    ]

    items = db.query(BOQItem).filter(BOQItem.boq_document_id == doc.id).all()
    table_headers = ["Section", "Item", "Unit", "Qty", "Rate", "Amount"]
    col_widths = [14, 30, 8, 10, 14, 14]
    table_rows = []
    boq_value = 0.0
    for it in items:
        amt = _item_amount(it)
        boq_value += amt
        table_rows.append([
            it.section_name or "",
            it.item_name,
            it.unit,
            str(it.quantity),
            str(it.rate),
            f"{amt:.2f}",
        ])
    if not table_rows:
        table_rows.append(["", "(No line items)", "", "", "", ""])

    totals_lines = [
        f"BOQ Value: {boq_value:.2f}",
        f"Line Items: {len(items)}",
    ]
    if doc.revised_amount is not None:
        totals_lines.append(f"Revised Amount: {float(doc.revised_amount):.2f}")

    pdf_bytes = generate_document_pdf(
        title="Bill of Quantities (BOQ)",
        party_lines=party_lines,
        table_headers=table_headers,
        table_rows=table_rows,
        col_widths=col_widths,
        totals_lines=totals_lines,
        terms=doc.terms,
        company_name=company_name,
        custom_banner=custom_banner,
        supplier_lines=supplier_lines,
        branding=branding,
    )
    filename = f"boq-{doc.title or doc.id}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# BOQ Revisions (budget revision history per BOQ document)
# ---------------------------------------------------------------------------


class BOQRevisionResponse(BaseModel):
    id: UUID
    boq_document_id: UUID
    project_id: UUID
    revision_no: int
    revised_amount: float
    previous_amount: Optional[float] = None
    delta: Optional[float] = None  # revised_amount - previous_amount
    reason: Optional[str] = None
    revised_by_user_id: Optional[UUID] = None
    revised_by_name: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


class BOQRevisionCreate(BaseModel):
    revised_amount: float = Field(..., gt=0)
    reason: Optional[str] = None


def _build_revision_response(r: BOQRevision, db: Session) -> BOQRevisionResponse:
    prev = float(r.previous_amount) if r.previous_amount is not None else None
    delta = (float(r.revised_amount) - prev) if prev is not None else None
    name = None
    if r.revised_by_user_id:
        u = db.query(User).filter(User.id == r.revised_by_user_id).first()
        name = (u.name or u.email or str(u.id)) if u else None
    return BOQRevisionResponse(
        id=r.id,
        boq_document_id=r.boq_document_id,
        project_id=r.project_id,
        revision_no=r.revision_no,
        revised_amount=float(r.revised_amount),
        previous_amount=prev,
        delta=delta,
        reason=r.reason,
        revised_by_user_id=r.revised_by_user_id,
        revised_by_name=name,
        created_at=r.created_at,
    )


@router.get("/boq-documents/{doc_id}/revisions", response_model=List[BOQRevisionResponse])
def list_boq_revisions(
    doc_id: UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    doc = db.query(BOQDocument).filter(BOQDocument.id == doc_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="BOQ document not found")
    project = db.query(Project).filter(Project.id == doc.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_module_view(db, current_user, project.company_id, "budgeting")
    revisions = (
        db.query(BOQRevision)
        .filter(BOQRevision.boq_document_id == doc_id)
        .order_by(BOQRevision.revision_no.asc())
        .all()
    )
    return [_build_revision_response(r, db) for r in revisions]


@router.post("/boq-documents/{doc_id}/revisions", response_model=BOQRevisionResponse, status_code=201)
def create_boq_revision(
    doc_id: UUID,
    req: BOQRevisionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    doc = db.query(BOQDocument).filter(BOQDocument.id == doc_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="BOQ document not found")
    project = db.query(Project).filter(Project.id == doc.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "budgeting:edit")

    last = (
        db.query(BOQRevision)
        .filter(BOQRevision.boq_document_id == doc_id)
        .order_by(BOQRevision.revision_no.desc())
        .first()
    )
    next_no = (last.revision_no + 1) if last else 1
    if last:
        previous_amount = last.revised_amount
    else:
        item_sum = sum(
            _item_amount(i)
            for i in db.query(BOQItem).filter(BOQItem.boq_document_id == doc_id).all()
        )
        previous_amount = (
            float(doc.revised_amount) if doc.revised_amount is not None else round(item_sum, 2)
        )

    rev = BOQRevision(
        boq_document_id=doc_id,
        project_id=doc.project_id,
        revision_no=next_no,
        revised_amount=req.revised_amount,
        previous_amount=previous_amount,
        reason=req.reason,
        revised_by_user_id=current_user.id,
    )
    doc.revised_amount = req.revised_amount
    db.add(rev)
    db.commit()
    db.refresh(rev)
    return _build_revision_response(rev, db)


@router.get("/boq-revisions", response_model=List[BOQRevisionResponse])
def list_project_boq_revisions(
    project_id: UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    _: None = Depends(verify_project_access),
):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    require_module_view(db, current_user, project.company_id, "budgeting")
    revisions = (
        db.query(BOQRevision)
        .filter(BOQRevision.project_id == project_id)
        .order_by(BOQRevision.created_at.desc(), BOQRevision.revision_no.desc())
        .all()
    )
    return [_build_revision_response(r, db) for r in revisions]
