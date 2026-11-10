import json
import uuid
from datetime import datetime, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session
from app.database import get_db
from app.auth import get_current_user, verify_company_access, get_company_membership, require_permission, verify_project_in_company, assert_cost_codes_known
from app.models import (
    CRMLead, CRMQuotation, CRMQuotationItem, Company,
    CRMLeadSource, CRMLeadCategory, CRMLeadStatus, CompanyTeam, User,
    LibraryParty,
    Project, Bill,
)
from app.workflow_controls import get_default_terms
from app.routers.library import next_party_id_custom
# R2-745: the shared line-item/tax validator. create_bill was its only caller,
# so the second bill-creation surface (quotation conversion) bypassed every
# check it enforces. Imported here so both surfaces cannot drift apart.
from app.routers.billing import _validate_bill_line_items
from app.constants import SUPPLIER_NUMBERED_INVOICE_TYPES
from pydantic import BaseModel, Field, EmailStr, field_validator

router = APIRouter(
    prefix="/crm",
    tags=["CRM & Lead Management"],
    dependencies=[Depends(get_current_user)]
)

WON_STATUSES = {"Won", "Converted"}


def _verify_party_in_company(db: Session, party_id: uuid.UUID, comp_uuid: uuid.UUID) -> LibraryParty:
    party = db.query(LibraryParty).filter(LibraryParty.id == party_id).first()
    if not party:
        raise HTTPException(status_code=404, detail="Library party not found")
    if party.company_id != comp_uuid:
        raise HTTPException(status_code=400, detail="Library party does not belong to this company")
    return party


def ensure_lead_party(db: Session, lead: CRMLead) -> None:
    """Idempotently ensure a won lead has a LibraryParty.

    If the lead is Won/Converted and ``party_id`` is still null, create a
    LibraryParty (name = client_company_name) in the lead's company when one
    does not already exist for that (company_id, name), then link the lead.
    """
    if lead.party_id is not None:
        return
    if lead.status not in WON_STATUSES:
        return
    if not lead.client_company_name:
        return
    existing = (
        db.query(LibraryParty)
        .filter(
            LibraryParty.company_id == lead.company_id,
            LibraryParty.name == lead.client_company_name,
        )
        .first()
    )
    party = existing or LibraryParty(
        id=uuid.uuid4(),
        company_id=lead.company_id,
        party_id_custom=next_party_id_custom(db, lead.company_id),
        name=lead.client_company_name,
        party_type="Client",
        phone=lead.phone_no,
        email=lead.email,
        address=lead.address,
    )
    if existing is None:
        db.add(party)
        db.flush()
    lead.party_id = party.id


def _resolve_lead_lookup(db: Session, model, comp_uuid: uuid.UUID, field: str, value: Optional[str], defaults: list) -> Optional[str]:
    """R2-359: resolve a lead's source/category/status against the company-scoped
    lookup instead of storing free text.

    Seeds the company's defaults on first use, matches case-insensitively so
    "won" normalises to the stored name, and refuses values the company has not
    defined - the same treatment party_id already gets - so the pipeline stays
    groupable and renaming a lookup row cannot orphan leads silently.
    """
    if value is None:
        return None
    known = {i.name.casefold(): i.name for i in _get_or_seed(db, model, comp_uuid, defaults)}
    canonical = known.get(value.casefold())
    if canonical is None:
        allowed = ", ".join(sorted(known.values())) if known else "none defined yet"
        raise HTTPException(
            status_code=400,
            detail=f"'{value}' is not one of this company's CRM {field} options ({allowed}). Add it under CRM settings first.",
        )
    return canonical

# Lead Schemas
class LeadCreateRequest(BaseModel):
    company_id: uuid.UUID
    assignee_id: Optional[uuid.UUID] = None
    lead_type: str
    contact_name: str
    phone_no: str = Field(..., pattern=r"^\+?\d{8,15}$")
    country_code: Optional[str] = None
    email: Optional[EmailStr] = None
    client_company_name: Optional[str] = None
    party_id: Optional[uuid.UUID] = None
    address: Optional[str] = None
    source: Optional[str] = None
    category: Optional[str] = None
    status: str = "New Lead"
    # R2-759: constrain priority vocabulary to (low, medium, high) and normalize casing
    priority: str = Field("medium", pattern=r"(?i)^(low|medium|high)$")
    budget: float = Field(0.0, ge=0)
    lead_name: Optional[str] = None
    description: Optional[str] = None
    last_contacted: Optional[datetime] = None
    next_follow_up: Optional[datetime] = None
    expected_closure: Optional[datetime] = None

    @field_validator("priority")
    @classmethod
    def _normalize_priority(cls, v: Optional[str]) -> str:
        if v is not None:
            return v.strip().lower()
        return "medium"

    @field_validator("expected_closure")
    @classmethod
    def _reject_past_closure(cls, v: Optional[datetime]) -> Optional[datetime]:
        if v is not None:
            # R2-737: normalize to aware UTC before comparison — copy todos.py:57-61
            # pattern (make naive aware, use aware now) so +05:30 does not raise
            # TypeError: can't compare offset-naive and offset-aware datetimes.
            if v.tzinfo is None:
                v = v.replace(tzinfo=timezone.utc)
            if v < datetime.now(timezone.utc):
                raise ValueError("expected_closure must not be in the past")
        return v

class LeadUpdateRequest(BaseModel):
    assignee_id: Optional[uuid.UUID] = None
    lead_type: Optional[str] = None
    contact_name: Optional[str] = None
    phone_no: Optional[str] = Field(None, pattern=r"^\+?\d{8,15}$")
    country_code: Optional[str] = None
    email: Optional[EmailStr] = None
    client_company_name: Optional[str] = None
    party_id: Optional[uuid.UUID] = None
    address: Optional[str] = None
    source: Optional[str] = None
    category: Optional[str] = None
    status: Optional[str] = None
    # R2-759: constrain priority vocabulary to (low, medium, high) and normalize casing
    priority: Optional[str] = Field(None, pattern=r"(?i)^(low|medium|high)$")
    budget: Optional[float] = Field(None, ge=0)
    description: Optional[str] = None
    lead_name: Optional[str] = None
    last_contacted: Optional[datetime] = None
    next_follow_up: Optional[datetime] = None
    expected_closure: Optional[datetime] = None

    @field_validator("priority")
    @classmethod
    def _normalize_priority(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            return v.strip().lower()
        return v

    @field_validator("expected_closure")
    @classmethod
    def _reject_past_closure(cls, v: Optional[datetime]) -> Optional[datetime]:
        # R2-438: the create path has rejected past closures since R2-273;
        # the update path silently accepted them, so a closure date in 2020
        # could still be written after the fact.
        # R2-737: normalize to aware UTC before comparison — copy todos.py:57-61
        # pattern (make naive aware, use aware now) so +05:30 does not raise
        # TypeError: can't compare offset-naive and offset-aware datetimes.
        if v is not None:
            if v.tzinfo is None:
                v = v.replace(tzinfo=timezone.utc)
            if v < datetime.now(timezone.utc):
                raise ValueError("expected_closure must not be in the past")
        return v


class LeadResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    assignee_id: Optional[uuid.UUID] = None
    lead_date: datetime
    lead_type: str
    contact_name: str
    phone_no: str
    country_code: Optional[str] = None
    email: Optional[str] = None
    client_company_name: Optional[str] = None
    party_id: Optional[uuid.UUID] = None
    address: Optional[str] = None
    source: Optional[str] = None
    category: Optional[str] = None
    status: str
    priority: str
    budget: float
    lead_name: Optional[str] = None
    description: Optional[str] = None
    last_contacted: Optional[datetime] = None
    next_follow_up: Optional[datetime] = None
    expected_closure: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

# Quotation Schemas
class QuotationItemCreateRequest(BaseModel):
    section_name: Optional[str] = None
    item_name: str
    qty: float = Field(..., ge=0)
    unit: str
    cost_price: float = Field(0.0, ge=0)
    selling_price: float = Field(0.0, ge=0)
    supply_rate: float = Field(0.0, ge=0)
    installation_rate: float = Field(0.0, ge=0)
    supply_tax_pct: float = Field(18.00, ge=0, le=100)
    installation_tax_pct: float = Field(12.00, ge=0, le=100)
    markup: float = 0.0
    item_code: Optional[str] = None
    hsn_sac: Optional[str] = None
    cost_code: Optional[str] = None
    length: Optional[float] = None
    width: Optional[float] = None
    height: Optional[float] = None
    billed_qty: float = Field(0.0, ge=0)
    unbilled_qty: float = Field(0.0, ge=0)

def _next_quotation_no(db: Session, company_id) -> str:
    """QT-001, QT-002 ... per company, so every quote has a number to quote
    back to the client and on the invoice it becomes."""
    count = (
        db.query(func.count(CRMQuotation.id))
        .join(CRMLead, CRMLead.id == CRMQuotation.lead_id)
        .filter(CRMLead.company_id == company_id)
        .scalar()
    ) or 0
    n = int(count) + 1
    while db.query(CRMQuotation.id).join(CRMLead, CRMLead.id == CRMQuotation.lead_id).filter(
        CRMLead.company_id == company_id, CRMQuotation.qt_no == f"QT-{n:03d}"
    ).first():
        n += 1
    return f"QT-{n:03d}"


class QuotationCreateRequest(BaseModel):
    subject: str
    tax_type: str = "bill_level"  # item_level, bill_level
    gst_pct: float = Field(18.00, ge=0, le=100)

    @field_validator("tax_type", mode="before")
    @classmethod
    def _known_tax_type(cls, v):
        # Any other value used to fall through both tax branches, so the
        # quote showed 18% and charged nothing. "GST" means tax on the bill.
        t = str(v or "bill_level").strip().lower().replace("-", "_").replace(" ", "_")
        if t in ("gst", "bill", "bill_level"):
            return "bill_level"
        if t in ("item", "item_level"):
            return "item_level"
        raise ValueError("Tax type must be bill_level or item_level")
    cgst_pct: Optional[float] = Field(None, ge=0, le=100)
    sgst_pct: Optional[float] = Field(None, ge=0, le=100)
    # D4 — optional site for POS; when provided, GST head derives from
    # Project.state vs supplier GSTIN (IGST inter-state, CGST/SGST halves intra-state)
    project_id: Optional[uuid.UUID] = None
    discount: float = Field(0.0, ge=0)
    additional_charges: float = Field(0.0, ge=0)
    round_off: float = 0.0
    qt_no: Optional[str] = None
    qt_date: Optional[datetime] = None
    bank_account_id: Optional[uuid.UUID] = None
    terms: Optional[str] = None
    items: List[QuotationItemCreateRequest]

class QuotationItemResponse(BaseModel):
    id: uuid.UUID
    section_name: Optional[str] = None
    item_name: str
    qty: float
    unit: str
    cost_price: float
    selling_price: float
    supply_rate: float
    installation_rate: float
    supply_tax_pct: float
    installation_tax_pct: float
    total_amount: float
    markup: float
    item_code: Optional[str] = None
    hsn_sac: Optional[str] = None
    cost_code: Optional[str] = None
    length: Optional[float] = None
    width: Optional[float] = None
    height: Optional[float] = None
    billed_qty: float
    unbilled_qty: float

    class Config:
        from_attributes = True

class QuotationResponse(BaseModel):
    id: uuid.UUID
    lead_id: uuid.UUID
    subject: str
    tax_type: str
    status: str
    gst_pct: float
    cgst_pct: float
    sgst_pct: float
    cgst_amount: float
    sgst_amount: float
    # D4 — inter-state quotations carry IGST
    igst_pct: float = 0.0
    igst_amount: float = 0.0
    tax_amount: float
    discount: float
    additional_charges: float
    round_off: float
    qt_no: Optional[str] = None
    qt_date: Optional[datetime] = None
    bank_account_id: Optional[uuid.UUID] = None
    total_amount: float
    terms: Optional[str] = None
    created_at: datetime
    items: List[QuotationItemResponse] = []

    class Config:
        from_attributes = True


# --- Lead Endpoints ---

@router.post("/leads", response_model=LeadResponse, status_code=status.HTTP_201_CREATED)
def create_lead(req: LeadCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    comp_uuid = uuid.UUID(str(req.company_id))
    company = db.query(Company).filter(Company.id == comp_uuid).first()
    if not company:
        raise HTTPException(status_code=404, detail="Company not found")
    get_company_membership(db, current_user, comp_uuid)
    require_permission(db, current_user, comp_uuid, "crm:edit")

    # R2-359: the three lookup-backed fields must reference the company's
    # tables, normalised, not arrive as free text.
    src = _resolve_lead_lookup(db, CRMLeadSource, comp_uuid, "source", req.source, DEFAULT_SOURCES)
    cat = _resolve_lead_lookup(db, CRMLeadCategory, comp_uuid, "category", req.category, [])
    stat = _resolve_lead_lookup(db, CRMLeadStatus, comp_uuid, "status", req.status, DEFAULT_STATUSES)

    lead = CRMLead(
        id=uuid.uuid4(),
        company_id=comp_uuid,
        assignee_id=uuid.UUID(str(req.assignee_id)) if req.assignee_id else None,
        lead_type=req.lead_type,
        contact_name=req.contact_name,
        phone_no=req.phone_no,
        country_code=req.country_code or "+91",
        email=req.email,
        client_company_name=req.client_company_name,
        party_id=req.party_id,
        address=req.address,
        source=src,
        category=cat,
        status=stat,
        priority=req.priority,
        budget=req.budget,
        lead_name=req.lead_name,
        description=req.description,
        last_contacted=req.last_contacted,
        next_follow_up=req.next_follow_up,
        expected_closure=req.expected_closure
    )
    if req.party_id is not None:
        _verify_party_in_company(db, req.party_id, comp_uuid)
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return lead

@router.get("/leads", response_model=List[LeadResponse])
def get_leads(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    comp_uuid = uuid.UUID(str(company_id))
    return db.query(CRMLead).filter(CRMLead.company_id == comp_uuid).all()

@router.put("/leads/{lead_id}", response_model=LeadResponse)
def update_lead(lead_id: uuid.UUID, req: LeadUpdateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    lead_uuid = uuid.UUID(str(lead_id))
    lead = db.query(CRMLead).filter(CRMLead.id == lead_uuid).first()
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    get_company_membership(db, current_user, lead.company_id)
    require_permission(db, current_user, lead.company_id, "crm:edit")

    # R2-359: supplied lookup fields resolve against the company's tables
    # before anything is written.
    new_status = _resolve_lead_lookup(db, CRMLeadStatus, lead.company_id, "status", req.status, DEFAULT_STATUSES) if req.status is not None else None
    new_source = _resolve_lead_lookup(db, CRMLeadSource, lead.company_id, "source", req.source, DEFAULT_SOURCES) if req.source is not None else None
    new_category = _resolve_lead_lookup(db, CRMLeadCategory, lead.company_id, "category", req.category, []) if req.category is not None else None

    if req.status is not None:
        lead.status = new_status
    if req.priority is not None:
        lead.priority = req.priority
    if req.budget is not None:
        lead.budget = req.budget
    # Optional fields the caller sent apply even when blank, so a follow-up
    # date or a note can be cleared, not only changed.
    sent = req.model_fields_set
    if "next_follow_up" in sent:
        lead.next_follow_up = req.next_follow_up
    if "expected_closure" in sent:
        lead.expected_closure = req.expected_closure
    if "last_contacted" in sent:
        lead.last_contacted = req.last_contacted
    if "description" in sent:
        lead.description = (req.description or "").strip() or None
    if "assignee_id" in sent:
        lead.assignee_id = uuid.UUID(str(req.assignee_id)) if req.assignee_id else None
    if req.lead_type is not None:
        lead.lead_type = req.lead_type
    if req.contact_name is not None:
        lead.contact_name = req.contact_name
    if req.phone_no is not None:
        lead.phone_no = req.phone_no
    if req.country_code is not None:
        lead.country_code = req.country_code
    if "email" in sent:
        lead.email = req.email or None
    if "client_company_name" in sent:
        lead.client_company_name = req.client_company_name or None
    if req.party_id is not None:
        _verify_party_in_company(db, req.party_id, lead.company_id)
        lead.party_id = req.party_id
    if "address" in sent:
        lead.address = req.address or None
    if req.source is not None:
        lead.source = new_source
    if req.category is not None:
        lead.category = new_category
    if "lead_name" in sent:
        lead.lead_name = req.lead_name or None

    ensure_lead_party(db, lead)

    db.add(lead)
    db.commit()
    db.refresh(lead)
    return lead


@router.get("/leads/{lead_id}", response_model=LeadResponse)
def get_lead(lead_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    lead_uuid = uuid.UUID(str(lead_id))
    lead = db.query(CRMLead).filter(CRMLead.id == lead_uuid).first()
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    get_company_membership(db, current_user, lead.company_id)
    return lead


@router.delete("/leads/{lead_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_lead(lead_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Delete a CRM lead. Tenant-scoped: the caller must belong to the lead's
    company, and the deletion is written to the DeleteLog audit trail."""
    lead = db.query(CRMLead).filter(CRMLead.id == lead_id).first()
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    get_company_membership(db, current_user, lead.company_id)
    require_permission(db, current_user, lead.company_id, "data:delete")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, lead.company_id, "crm_lead", lead.id, f"CRM Lead: {lead.contact_name}", deleted_by=current_user.name)
    db.delete(lead)
    db.commit()


# ─── Company team members (Assignee dropdown) ────────────────────────────────

class TeamMemberResponse(BaseModel):
    id: uuid.UUID
    name: str

    class Config:
        from_attributes = True


@router.get("/team-members/{company_id}", response_model=List[TeamMemberResponse])
def list_team_members(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    comp_uuid = uuid.UUID(str(company_id))
    rows = (
        db.query(CompanyTeam, User)
        .join(User, User.id == CompanyTeam.user_id)
        .filter(CompanyTeam.company_id == comp_uuid)
        .order_by(User.name)
        .all()
    )
    return [TeamMemberResponse(id=t.id, name=u.name) for t, u in rows]


# ─── Creatable company-scoped lookups (Source / Category / Status) ────────────

class LookupResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    name: str

    class Config:
        from_attributes = True


class LookupCreate(BaseModel):
    name: str


DEFAULT_SOURCES = ["Website", "Facebook", "Instagram", "Google", "Whatsapp", "Referral", "Cold Call", "Email Campaign"]
DEFAULT_STATUSES = ["New Lead", "Follow-Up", "Proposal Stage", "Converted", "Won", "Lost", "No Response", "Irrelevant Lead"]


def _get_or_seed(db: Session, model, comp_uuid: uuid.UUID, defaults: list[str]):
    items = db.query(model).filter(model.company_id == comp_uuid).order_by(model.name).all()
    if not items and defaults:
        for d in defaults:
            db.add(model(company_id=comp_uuid, name=d))
        db.commit()
        items = db.query(model).filter(model.company_id == comp_uuid).order_by(model.name).all()
    return items


@router.get("/lead-sources/{company_id}", response_model=List[LookupResponse])
def list_lead_sources(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    comp_uuid = uuid.UUID(str(company_id))
    return _get_or_seed(db, CRMLeadSource, comp_uuid, DEFAULT_SOURCES)


@router.post("/lead-sources/{company_id}", response_model=LookupResponse, status_code=status.HTTP_201_CREATED)
def create_lead_source(company_id: uuid.UUID, payload: LookupCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user), _: None = Depends(verify_company_access)):
    comp_uuid = uuid.UUID(str(company_id))
    require_permission(db, current_user, comp_uuid, "crm:edit")
    obj = CRMLeadSource(company_id=comp_uuid, name=payload.name)
    db.add(obj)
    db.commit()
    return obj


@router.put("/lead-sources/{source_id}", response_model=LookupResponse)
def update_lead_source(source_id: uuid.UUID, payload: LookupCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    obj = db.query(CRMLeadSource).filter(CRMLeadSource.id == source_id).first()
    if not obj:
        raise HTTPException(status_code=404, detail="Lead source not found")
    get_company_membership(db, current_user, obj.company_id)
    require_permission(db, current_user, obj.company_id, "crm:edit")
    obj.name = payload.name
    db.commit()
    db.refresh(obj)
    return obj


@router.delete("/lead-sources/{source_id}")
def delete_lead_source(source_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    obj = db.query(CRMLeadSource).filter(CRMLeadSource.id == source_id).first()
    if not obj:
        raise HTTPException(status_code=404, detail="Lead source not found")
    get_company_membership(db, current_user, obj.company_id)
    require_permission(db, current_user, obj.company_id, "crm:edit")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, obj.company_id, "lead_source", obj.id, f"Lead Source: {obj.name}", deleted_by=current_user.name)
    db.delete(obj)
    db.commit()
    return {"success": True}


@router.get("/lead-categories/{company_id}", response_model=List[LookupResponse])
def list_lead_categories(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    comp_uuid = uuid.UUID(str(company_id))
    return _get_or_seed(db, CRMLeadCategory, comp_uuid, [])


@router.post("/lead-categories/{company_id}", response_model=LookupResponse, status_code=status.HTTP_201_CREATED)
def create_lead_category(company_id: uuid.UUID, payload: LookupCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user), _: None = Depends(verify_company_access)):
    comp_uuid = uuid.UUID(str(company_id))
    require_permission(db, current_user, comp_uuid, "crm:edit")
    obj = CRMLeadCategory(company_id=comp_uuid, name=payload.name)
    db.add(obj)
    db.commit()
    return obj


@router.put("/lead-categories/{category_id}", response_model=LookupResponse)
def update_lead_category(category_id: uuid.UUID, payload: LookupCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    obj = db.query(CRMLeadCategory).filter(CRMLeadCategory.id == category_id).first()
    if not obj:
        raise HTTPException(status_code=404, detail="Lead category not found")
    get_company_membership(db, current_user, obj.company_id)
    require_permission(db, current_user, obj.company_id, "crm:edit")
    obj.name = payload.name
    db.commit()
    db.refresh(obj)
    return obj


@router.delete("/lead-categories/{category_id}")
def delete_lead_category(category_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    obj = db.query(CRMLeadCategory).filter(CRMLeadCategory.id == category_id).first()
    if not obj:
        raise HTTPException(status_code=404, detail="Lead category not found")
    get_company_membership(db, current_user, obj.company_id)
    require_permission(db, current_user, obj.company_id, "crm:edit")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, obj.company_id, "lead_category", obj.id, f"Lead Category: {obj.name}", deleted_by=current_user.name)
    db.delete(obj)
    db.commit()
    return {"success": True}


@router.get("/lead-statuses/{company_id}", response_model=List[LookupResponse])
def list_lead_statuses(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    comp_uuid = uuid.UUID(str(company_id))
    return _get_or_seed(db, CRMLeadStatus, comp_uuid, DEFAULT_STATUSES)


@router.post("/lead-statuses/{company_id}", response_model=LookupResponse, status_code=status.HTTP_201_CREATED)
def create_lead_status(company_id: uuid.UUID, payload: LookupCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user), _: None = Depends(verify_company_access)):
    comp_uuid = uuid.UUID(str(company_id))
    require_permission(db, current_user, comp_uuid, "crm:edit")
    obj = CRMLeadStatus(company_id=comp_uuid, name=payload.name)
    db.add(obj)
    db.commit()
    return obj


@router.put("/lead-statuses/{status_id}", response_model=LookupResponse)
def update_lead_status(status_id: uuid.UUID, payload: LookupCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    obj = db.query(CRMLeadStatus).filter(CRMLeadStatus.id == status_id).first()
    if not obj:
        raise HTTPException(status_code=404, detail="Lead status not found")
    get_company_membership(db, current_user, obj.company_id)
    require_permission(db, current_user, obj.company_id, "crm:edit")
    obj.name = payload.name
    db.commit()
    db.refresh(obj)
    return obj


@router.delete("/lead-statuses/{status_id}")
def delete_lead_status(status_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    obj = db.query(CRMLeadStatus).filter(CRMLeadStatus.id == status_id).first()
    if not obj:
        raise HTTPException(status_code=404, detail="Lead status not found")
    get_company_membership(db, current_user, obj.company_id)
    require_permission(db, current_user, obj.company_id, "crm:edit")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, obj.company_id, "lead_status", obj.id, f"Lead Status: {obj.name}", deleted_by=current_user.name)
    db.delete(obj)
    db.commit()
    return {"success": True}


# --- Quotation Endpoints ---

@router.post("/leads/{lead_id}/quotations", response_model=QuotationResponse, status_code=status.HTTP_201_CREATED)
def create_quotation(lead_id: uuid.UUID, req: QuotationCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    lead_uuid = uuid.UUID(str(lead_id))
    lead = db.query(CRMLead).filter(CRMLead.id == lead_uuid).first()
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    get_company_membership(db, current_user, lead.company_id)
    require_permission(db, current_user, lead.company_id, "crm:edit")

    # D4: derive GST head from site state vs supplier GSTIN when project_id is supplied
    _d4_inter = None
    _d4_project_state = None
    _d4_supplier_gstin = None
    _d4_igst_pct = 0.0
    gst_pct = req.gst_pct
    if getattr(req, "project_id", None):
        try:
            _proj = db.query(Project).filter(Project.id == req.project_id).first()
            if not _proj or _proj.company_id != lead.company_id:
                raise HTTPException(status_code=422, detail="project_id does not belong to the lead's company")
            if not str(getattr(_proj, "state", "") or "").strip():
                raise HTTPException(
                    status_code=422,
                    detail="Set the state the site is in (Project settings) first. GST on this project's bills depends on it.",
                )
            _d4_project_state = _proj.state
            _comp = db.query(Company).filter(Company.id == lead.company_id).first()
            _d4_supplier_gstin = getattr(_comp, "gstin", None)
            if getattr(_proj, "branch_id", None):
                from app.models import CompanyBranch as _CB
                _br = db.query(_CB).filter(_CB.id == _proj.branch_id).first()
                if _br and getattr(_br, "gstin", None):
                    _d4_supplier_gstin = _br.gstin
            from app.gst_utils import is_inter_state as _is_inter
            _d4_inter = _is_inter(_d4_project_state, _d4_supplier_gstin)
        except HTTPException:
            raise
        except Exception:
            _d4_inter = None

    if _d4_inter is True:
        # Inter-state -> IGST
        cgst_pct = 0.0
        sgst_pct = 0.0
        _d4_igst_pct = gst_pct
    elif _d4_inter is False:
        # Intra-state -> halves
        cgst_pct = req.cgst_pct if req.cgst_pct is not None else gst_pct / 2.0
        sgst_pct = req.sgst_pct if req.sgst_pct is not None else gst_pct / 2.0
        _d4_igst_pct = 0.0
    else:
        # No project context — legacy halves (forward-only; new project quotes must provide project_id)
        cgst_pct = req.cgst_pct if req.cgst_pct is not None else gst_pct / 2.0
        sgst_pct = req.sgst_pct if req.sgst_pct is not None else gst_pct / 2.0
        _d4_igst_pct = 0.0

    # R2-764: quotation item cost codes must exist in the company's Cost Code Library
    item_cost_codes = [item.cost_code for item in req.items if item.cost_code]
    if item_cost_codes:
        assert_cost_codes_known(db, lead.company_id, codes=item_cost_codes, status_code=422)

    # Create quotation record
    quot = CRMQuotation(
        id=uuid.uuid4(),
        lead_id=lead_uuid,
        subject=req.subject,
        tax_type=req.tax_type,
        status="Draft",
        gst_pct=gst_pct,
        cgst_pct=cgst_pct,
        sgst_pct=sgst_pct,
        igst_pct=_d4_igst_pct,
        igst_amount=0.0,
        discount=req.discount,
        additional_charges=req.additional_charges,
        round_off=req.round_off,
        qt_no=(req.qt_no or "").strip() or _next_quotation_no(db, lead.company_id),
        qt_date=req.qt_date.date() if req.qt_date else None,
        bank_account_id=uuid.UUID(str(req.bank_account_id)) if req.bank_account_id else None,
        total_amount=0.0,
        # Settings -> Terms & Conditions -> CRM Quotation: pre-fill the
        # company default when the caller doesn't supply their own terms.
        terms=req.terms if req.terms else get_default_terms(db, lead.company_id, "quotation")
    )
    db.add(quot)
    db.flush()

    def dim_factor(item: QuotationItemCreateRequest) -> float:
        if item.length and item.width and item.height:
            return float(item.length) * float(item.width) * float(item.height)
        return 1.0

    # First pass: pre-tax base for discount ratio (N x L x W x H aware)
    total_pre_tax_base = 0.0
    for item in req.items:
        unit_price = item.selling_price + item.supply_rate + item.installation_rate
        total_pre_tax_base += float(item.qty) * dim_factor(item) * unit_price

    discount_ratio = 0.0
    if total_pre_tax_base > 0:
        discount_ratio = 1.0 if req.discount >= total_pre_tax_base else (req.discount / total_pre_tax_base)

    subtotal = 0.0
    total_tax = 0.0
    pending = []

    for item in req.items:
        unit_price = item.selling_price + item.supply_rate + item.installation_rate
        df = dim_factor(item)
        eff_qty = float(item.qty) * df
        item_base = eff_qty * unit_price
        item_tax = 0.0

        if req.tax_type == "item_level":
            item_discounted_base = item_base * (1.0 - discount_ratio)
            if item.supply_rate > 0 or item.installation_rate > 0:
                supply_base = (eff_qty * item.supply_rate) * (1.0 - discount_ratio)
                install_base = (eff_qty * item.installation_rate) * (1.0 - discount_ratio)
                selling_base = (eff_qty * item.selling_price) * (1.0 - discount_ratio)
                supply_tax = supply_base * (item.supply_tax_pct / 100.0)
                install_tax = install_base * (item.installation_tax_pct / 100.0)
                selling_tax = selling_base * (gst_pct / 100.0)
                item_tax = supply_tax + install_tax + selling_tax
            else:
                item_tax = item_discounted_base * (gst_pct / 100.0)
            item_total = item_discounted_base + item_tax
        else:
            item_total = item_base  # bill-level tax handled below

        subtotal += item_base
        total_tax += item_tax

        pending.append((item, eff_qty, item_base, item_tax, item_total))

    for item, eff_qty, item_base, item_tax, item_total in pending:
        q_item = CRMQuotationItem(
            id=uuid.uuid4(),
            quotation_id=quot.id,
            section_name=item.section_name,
            item_name=item.item_name,
            qty=item.qty,
            unit=item.unit,
            cost_price=item.cost_price,
            selling_price=item.selling_price,
            supply_rate=item.supply_rate,
            installation_rate=item.installation_rate,
            supply_tax_pct=item.supply_tax_pct,
            installation_tax_pct=item.installation_tax_pct,
            total_amount=item_total,
            markup=item.markup,
            item_code=item.item_code,
            hsn_sac=item.hsn_sac,
            cost_code=item.cost_code,
            length=item.length,
            width=item.width,
            height=item.height,
            billed_qty=item.billed_qty,
            unbilled_qty=item.unbilled_qty
        )
        db.add(q_item)

    # Bill-level tax + totals
    if req.tax_type == "bill_level":
        discounted = subtotal - req.discount
        tax = discounted * (gst_pct / 100.0)
        total_tax = tax
        base_total = discounted + tax
    else:
        base_total = subtotal  # taxes already inside items

    final_total = base_total + (req.additional_charges or 0.0) + (req.round_off or 0.0)

    # D4 split — IGST when inter-state, otherwise CGST/SGST halves
    if _d4_inter is True:
        cgst_amount = 0.0
        sgst_amount = 0.0
        igst_amount = float(total_tax)
    else:
        total_gst = (cgst_pct + sgst_pct) or 1.0
        cgst_amount = total_tax * (cgst_pct / total_gst)
        sgst_amount = total_tax * (sgst_pct / total_gst)
        igst_amount = 0.0

    quot.total_amount = max(final_total, 0.0)
    quot.cgst_amount = cgst_amount
    quot.sgst_amount = sgst_amount
    quot.igst_amount = igst_amount
    db.add(quot)
    db.commit()
    db.refresh(quot)

    # Assemble response
    res = QuotationResponse(
        id=quot.id,
        lead_id=quot.lead_id,
        subject=quot.subject,
        tax_type=quot.tax_type,
        status=quot.status,
        gst_pct=float(quot.gst_pct),
        cgst_pct=float(quot.cgst_pct),
        sgst_pct=float(quot.sgst_pct),
        cgst_amount=float(quot.cgst_amount),
        sgst_amount=float(quot.sgst_amount),
        igst_pct=float(getattr(quot, "igst_pct", 0.0) or 0.0),
        igst_amount=float(getattr(quot, "igst_amount", 0.0) or 0.0),
        tax_amount=float(float(quot.cgst_amount or 0) + float(quot.sgst_amount or 0) + float(getattr(quot, "igst_amount", 0) or 0)),
        discount=float(quot.discount),
        additional_charges=float(quot.additional_charges),
        round_off=float(quot.round_off),
        qt_no=quot.qt_no,
        qt_date=quot.qt_date,
        bank_account_id=quot.bank_account_id,
        total_amount=float(quot.total_amount),
        terms=quot.terms,
        created_at=quot.created_at,
        items=[]
    )
    # Build item response from persisted rows
    persisted = db.query(CRMQuotationItem).filter(CRMQuotationItem.quotation_id == quot.id).all()
    res.items = [
        QuotationItemResponse(
            id=i.id,
            section_name=i.section_name,
            item_name=i.item_name,
            qty=float(i.qty),
            unit=i.unit,
            cost_price=float(i.cost_price),
            selling_price=float(i.selling_price),
            supply_rate=float(i.supply_rate),
            installation_rate=float(i.installation_rate),
            supply_tax_pct=float(i.supply_tax_pct),
            installation_tax_pct=float(i.installation_tax_pct),
            total_amount=float(i.total_amount),
            markup=float(i.markup),
            item_code=i.item_code,
            hsn_sac=i.hsn_sac,
            cost_code=i.cost_code,
            length=float(i.length) if i.length is not None else None,
            width=float(i.width) if i.width is not None else None,
            height=float(i.height) if i.height is not None else None,
            billed_qty=float(i.billed_qty or 0.0),
            unbilled_qty=float(i.unbilled_qty or 0.0),
        ) for i in persisted
    ]
    return res

@router.get("/leads/{lead_id}/quotations", response_model=List[QuotationResponse])
def get_quotations(lead_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    lead_uuid = uuid.UUID(str(lead_id))
    lead = db.query(CRMLead).filter(CRMLead.id == lead_uuid).first()
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    get_company_membership(db, current_user, lead.company_id)
    quots = db.query(CRMQuotation).filter(CRMQuotation.lead_id == lead_uuid).all()
    
    results = []
    for q in quots:
        items = db.query(CRMQuotationItem).filter(CRMQuotationItem.quotation_id == q.id).all()
        results.append(
            QuotationResponse(
                id=q.id,
                lead_id=q.lead_id,
                subject=q.subject,
                tax_type=q.tax_type,
                status=q.status,
                gst_pct=float(q.gst_pct),
                cgst_pct=float(q.cgst_pct),
                sgst_pct=float(q.sgst_pct),
                cgst_amount=float(q.cgst_amount),
                sgst_amount=float(q.sgst_amount),
                igst_pct=float(getattr(q, "igst_pct", 0.0) or 0.0),
                igst_amount=float(getattr(q, "igst_amount", 0.0) or 0.0),
                tax_amount=float(float(q.cgst_amount or 0) + float(q.sgst_amount or 0) + float(getattr(q, "igst_amount", 0) or 0)),
                discount=float(q.discount),
                additional_charges=float(q.additional_charges),
                round_off=float(q.round_off),
                qt_no=q.qt_no,
                qt_date=q.qt_date,
                bank_account_id=q.bank_account_id,
                total_amount=float(q.total_amount),
                terms=q.terms,
                created_at=q.created_at,
                items=[
                    QuotationItemResponse(
                        id=i.id,
                        section_name=i.section_name,
                        item_name=i.item_name,
                        qty=float(i.qty),
                        unit=i.unit,
                        cost_price=float(i.cost_price),
                        selling_price=float(i.selling_price),
                        supply_rate=float(i.supply_rate),
                        installation_rate=float(i.installation_rate),
                        supply_tax_pct=float(i.supply_tax_pct),
                        installation_tax_pct=float(i.installation_tax_pct),
                        total_amount=float(i.total_amount),
                        markup=float(i.markup),
                        item_code=i.item_code,
                        hsn_sac=i.hsn_sac,
                        cost_code=i.cost_code,
                        length=float(i.length) if i.length is not None else None,
                        width=float(i.width) if i.width is not None else None,
                        height=float(i.height) if i.height is not None else None,
                        billed_qty=float(i.billed_qty or 0.0),
                        unbilled_qty=float(i.unbilled_qty or 0.0),
                    ) for i in items
                ]
            )
        )
    return results


# ─── Quotation → Invoice conversion (R2-360) ─────────────────────────────────

class QuotationConvertRequest(BaseModel):
    project_id: uuid.UUID
    party_company_user_id: uuid.UUID
    invoice_number: Optional[str] = None


class QuotationConversionResponse(BaseModel):
    bill_id: uuid.UUID
    invoice_number: str
    quotation_id: uuid.UUID
    subtotal: float
    gst_amount: float
    total_payable: float


@router.post(
    "/quotations/{quotation_id}/convert-to-invoice",
    response_model=QuotationConversionResponse,
    status_code=status.HTTP_201_CREATED,
)
def convert_quotation_to_invoice(quotation_id: uuid.UUID, req: QuotationConvertRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """R2-360: turn a CRM quotation into a sale invoice instead of re-keying it
    by hand in Billing. Money comes from the quotation's own arithmetic -- GST
    is the stored CGST+SGST+IGST split, all three components, because an
    inter-state quotation stores the whole tax in igst_amount and zeroes the
    other two (D4). The itemised lines survive into items_json, including
    hsn_sac, bill.quotation_id records the link so conversion can be
    reconciled, and a quotation holds at most one active invoice.

    R2-745/R2-747: the payload is validated by _validate_bill_line_items, the
    same contract create_bill enforces. It used to be hand-assembled and
    unchecked, which is how the tax and the HSN column were lost."""
    quot_uuid = uuid.UUID(str(quotation_id))
    quot = db.query(CRMQuotation).filter(CRMQuotation.id == quot_uuid).first()
    if not quot:
        raise HTTPException(status_code=404, detail="Quotation not found")
    lead = db.query(CRMLead).filter(CRMLead.id == quot.lead_id).first()
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    get_company_membership(db, current_user, lead.company_id)
    require_permission(db, current_user, lead.company_id, "billing:edit")

    project = verify_project_in_company(db, req.project_id, lead.company_id)
    # D4: site state required for the resulting invoice
    if not project or not str(getattr(project, "state", "") or "").strip():
        raise HTTPException(
            status_code=422,
            detail="Set the state the site is in (Project settings) first. GST on this project's bills depends on it.",
        )
    party_row = db.query(CompanyTeam).filter(CompanyTeam.id == req.party_company_user_id).first()
    if not party_row or party_row.company_id != lead.company_id:
        raise HTTPException(status_code=400, detail="Invoice party does not belong to this company")

    already = (
        db.query(Bill)
        .filter(Bill.quotation_id == quot.id, Bill.status != "Cancelled")
        .first()
    )
    if already:
        raise HTTPException(
            status_code=409,
            detail=f"Quotation already converted to invoice {already.invoice_number}",
        )

    invoice_number = req.invoice_number or (f"INV-{quot.qt_no}" if quot.qt_no else f"INV-{str(quot.id)[:8]}")
    # A sale invoice is the company's own number: unique company-wide.
    number_clash = (
        db.query(Bill)
        .filter(
            Bill.company_id == lead.company_id,
            Bill.invoice_number == invoice_number,
            Bill.invoice_type.notin_(SUPPLIER_NUMBERED_INVOICE_TYPES),
        )
        .first()
    )
    if number_clash:
        raise HTTPException(status_code=409, detail="Invoice number already exists for this company")

    # R2-745: all three tax components, matching crm.py:734 and :801. Dropping
    # igst_amount made an inter-state invoice record gst_amount 0 and book the
    # tax-inclusive total as taxable value.
    gst_amount = (
        float(quot.cgst_amount or 0)
        + float(quot.sgst_amount or 0)
        + float(getattr(quot, "igst_amount", 0) or 0)
    )
    total_payable = float(quot.total_amount or 0)
    subtotal = total_payable - gst_amount

    items = db.query(CRMQuotationItem).filter(CRMQuotationItem.quotation_id == quot.id).all()
    items_json = json.dumps(
        [
            {
                "desc": i.item_name,
                "cost_code_name": i.cost_code,
                "qty": float(i.qty),
                "rate": float(i.selling_price or 0) + float(i.supply_rate or 0) + float(i.installation_rate or 0),
                "amount": float(i.total_amount or 0),
                # R2-747: carried through so the invoice's HSN/SAC column is not
                # structurally blank even when the user filled it on the quotation.
                "hsn_sac": i.hsn_sac or "",
            }
            for i in items
        ]
    )

    # R2-745/R2-747: hold this surface to the same contract as create_bill.
    # Without it, a quotation carrying additional_charges or round_off emits
    # lines that under-sum the subtotal, and a tax invoice can ship with no
    # HSN/SAC -- neither of which any downstream step catches, because the PDF
    # renders whatever is stored.
    _validate_bill_line_items(items_json, subtotal, "sale")

    bill = Bill(
        id=uuid.uuid4(),
        company_id=lead.company_id,
        project_id=project.id,
        party_company_user_id=req.party_company_user_id,
        invoice_number=invoice_number[:100],
        invoice_date=datetime.utcnow(),
        due_date=None,
        invoice_type="sale",
        status="Unpaid",
        subtotal=subtotal,
        gst_amount=gst_amount,
        total_payable=total_payable,
        paid_amount=0.0,
        approval_flag="pending",
        is_milestone_fixed_amount=False,
        items_json=items_json,
        terms=quot.terms,
        quotation_id=quot.id,
    )
    db.add(bill)
    db.commit()

    return QuotationConversionResponse(
        bill_id=bill.id,
        invoice_number=bill.invoice_number,
        quotation_id=quot.id,
        subtotal=subtotal,
        gst_amount=gst_amount,
        total_payable=total_payable,
    )
