from fastapi import APIRouter, Depends, HTTPException, status, Response, Query, UploadFile, File
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy.orm import Session
from sqlalchemy import Numeric
from datetime import datetime
from typing import List, Optional
from app.database import get_db
from app import models, supabase_storage
from app.library_names import refuse_same_name_on_create, refuse_same_name_on_update
from app.models import User
from app.auth import get_current_user, verify_company_access, verify_project_access, get_company_membership, require_permission, assert_cost_codes_known
import uuid

router = APIRouter(prefix="/library", tags=["Company Libraries"], dependencies=[Depends(get_current_user)])

# ─── schemas ───

class PartyCreate(BaseModel):
    company_id: uuid.UUID
    party_id_custom: Optional[str] = Field(None, max_length=100)
    name: str = Field(..., max_length=255)
    project_id: Optional[uuid.UUID] = None
    phone: Optional[str] = Field(None, max_length=50)
    email: Optional[str] = Field(None, max_length=255)
    party_type: Optional[str] = Field(None, max_length=100, pattern="(?i)^(Client|Supplier|Vendor|Subcontractor|Contractor|Staff|Party|Architect|Consultant|Other|Investor|Worker|Labour Contractor|Material Supplier|Equipment Supplier|Other Vendor)$")
    address: Optional[str] = None
    bank_name: Optional[str] = Field(None, max_length=255)
    account_name: Optional[str] = Field(None, max_length=255)
    account_number: Optional[str] = Field(None, max_length=100)
    ifsc_code: Optional[str] = Field(None, max_length=20)
    tax_no: Optional[str] = Field(None, max_length=100)
    date_of_joining: Optional[str] = None # ISO format or custom date string
    aadhaar_number: Optional[str] = Field(None, max_length=50)
    pan_number: Optional[str] = Field(None, max_length=50)
    esi_number: Optional[str] = Field(None, max_length=100)
    pf_number: Optional[str] = Field(None, max_length=100)
    father_name: Optional[str] = Field(None, max_length=255)
    passport_no: Optional[str] = Field(None, max_length=100)
    passport_expiry_date: Optional[str] = None
    creator_name: Optional[str] = Field(None, max_length=255)
    aadhaar_file: Optional[str] = None
    pan_file: Optional[str] = None
    opening_balance_direction: Optional[str] = Field(None, pattern="^(will_pay|will_receive)$")  # will_pay / will_receive
    opening_balance_amount: Optional[float] = Field(0.0, ge=0)
    # Finance tab company-level extensions
    contractor_role: Optional[str] = Field(None, max_length=100)
    service_rate_categories: Optional[str] = None  # JSON list of tag strings
    bank_account_id: Optional[uuid.UUID] = None
    opening_balance: Optional[float] = Field(0.0, ge=0)
    opening_balance_type: Optional[str] = Field(None, max_length=20, pattern="^(pay|receive)$")  # "pay" / "receive"

class AssetTypeCreate(BaseModel):
    company_id: uuid.UUID
    name: str = Field(..., max_length=255)

class AssetTypeUpdate(BaseModel):
    name: str = Field(..., max_length=255)

class CostCodeCreate(BaseModel):
    company_id: uuid.UUID
    code: str = Field(..., max_length=100)
    sub_cost_code: Optional[str] = Field(None, max_length=100)
    parent_id: Optional[uuid.UUID] = None
    name: str = Field(..., max_length=255)
    budget_amount: float = Field(0.0, ge=0)

class CostCodeUpdate(BaseModel):
    code: Optional[str] = Field(None, max_length=100)
    sub_cost_code: Optional[str] = Field(None, max_length=100)
    parent_id: Optional[uuid.UUID] = None
    name: Optional[str] = Field(None, max_length=255)
    budget_amount: Optional[float] = Field(None, ge=0)

class DeductionCreate(BaseModel):
    company_id: uuid.UUID
    name: str = Field(..., max_length=255)

class DeductionUpdate(BaseModel):
    name: str = Field(..., max_length=255)

class ProgressCreate(BaseModel):
    company_id: uuid.UUID
    name: str = Field(..., max_length=255)

class ProgressUpdate(BaseModel):
    name: str = Field(..., max_length=255)

class WorkforceCreate(BaseModel):
    company_id: uuid.UUID
    name: str = Field(..., max_length=255)
    rate_type: Optional[str] = Field(None, max_length=50)
    salary_per_shift: Optional[float] = Field(None, ge=0)
    shift_hours: Optional[float] = Field(None, ge=0)
    cost_code: Optional[str] = Field(None, max_length=100)

class WorkforceUpdate(BaseModel):
    # name is Optional so a partial update can omit it, but the column is
    # NOT NULL. update_library_workforce applies model_dump(exclude_unset=True),
    # so an explicit {"name": null} would reach the database and surface as a
    # 500 IntegrityError instead of a 422. Reject it at the schema.
    name: Optional[str] = Field(None, max_length=255)
    rate_type: Optional[str] = Field(None, max_length=50)
    salary_per_shift: Optional[float] = Field(None, ge=0)
    shift_hours: Optional[float] = Field(None, ge=0)
    cost_code: Optional[str] = Field(None, max_length=100)

    @field_validator("name")
    @classmethod
    def _name_not_cleared(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not v.strip():
            raise ValueError("name cannot be blank")
        return v

    @model_validator(mode="after")
    def _name_not_explicitly_null(self):
        if "name" in self.model_fields_set and self.name is None:
            raise ValueError("name cannot be cleared")
        return self

class MaterialCreate(BaseModel):
    company_id: uuid.UUID
    name: str = Field(..., max_length=255)
    unit: str = Field(..., max_length=50)
    alternate_unit: Optional[str] = Field(None, max_length=50)
    gst_rate: float = Field(0.0, ge=0, le=100)
    category: Optional[str] = Field(None, max_length=100)
    unit_cost: float = Field(0.0, ge=0)
    lead_time_days: int = Field(0, ge=0)
    hsn_sac: Optional[str] = Field(None, max_length=50)
    item_code: Optional[str] = Field(None, max_length=100)
    specifications: Optional[str] = None
    creator_name: Optional[str] = Field(None, max_length=255)

    @model_validator(mode="after")
    def validate_dual_units(self):
        if self.alternate_unit and self.alternate_unit.strip():
            if self.alternate_unit.strip().lower() == self.unit.strip().lower():
                raise ValueError("Alternate unit must differ from base unit")
        return self

class MaterialUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=255)
    unit: Optional[str] = Field(None, max_length=50)
    alternate_unit: Optional[str] = Field(None, max_length=50)
    gst_rate: Optional[float] = Field(None, ge=0, le=100)
    category: Optional[str] = Field(None, max_length=100)
    unit_cost: Optional[float] = Field(None, ge=0)
    lead_time_days: Optional[int] = Field(None, ge=0)
    hsn_sac: Optional[str] = Field(None, max_length=50)
    item_code: Optional[str] = Field(None, max_length=100)
    specifications: Optional[str] = None

class RateCreate(BaseModel):
    company_id: uuid.UUID
    name: str = Field(..., max_length=255)
    item_code: Optional[str] = Field(None, max_length=100)
    unit: str = Field(..., max_length=50)
    gst_rate: float = Field(0.0, ge=0, le=100)
    category: Optional[str] = Field(None, max_length=100)
    unit_cost: float = Field(0.0, ge=0)
    markup_value: float = 0.0
    markup_type: str = Field("percent", pattern="^(percent|flat)$")
    unit_sale_price: float = Field(0.0, ge=0)
    note: Optional[str] = None
    cost_code: Optional[str] = Field(None, max_length=100)
    hsn_sac: Optional[str] = Field(None, max_length=50)

class RateUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=255)
    item_code: Optional[str] = Field(None, max_length=100)
    unit: Optional[str] = Field(None, max_length=50)
    gst_rate: Optional[float] = Field(None, ge=0, le=100)
    category: Optional[str] = Field(None, max_length=100)
    unit_cost: Optional[float] = Field(None, ge=0)
    markup_value: Optional[float] = None
    markup_type: Optional[str] = Field(None, pattern="^(percent|flat)$")
    unit_sale_price: Optional[float] = Field(None, ge=0)
    note: Optional[str] = None
    cost_code: Optional[str] = Field(None, max_length=100)
    hsn_sac: Optional[str] = Field(None, max_length=50)

class PartyUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=255)
    phone: Optional[str] = Field(None, max_length=50)
    email: Optional[str] = Field(None, max_length=255)
    party_type: Optional[str] = Field(None, max_length=50)
    address: Optional[str] = None
    bank_name: Optional[str] = Field(None, max_length=100)
    account_name: Optional[str] = Field(None, max_length=255)
    account_number: Optional[str] = Field(None, max_length=100)
    ifsc_code: Optional[str] = Field(None, max_length=50)
    tax_no: Optional[str] = Field(None, max_length=50)
    date_of_joining: Optional[str] = None
    aadhaar_number: Optional[str] = Field(None, max_length=50)
    pan_number: Optional[str] = Field(None, max_length=50)
    esi_number: Optional[str] = Field(None, max_length=50)
    pf_number: Optional[str] = Field(None, max_length=50)
    father_name: Optional[str] = Field(None, max_length=255)
    passport_no: Optional[str] = Field(None, max_length=50)
    passport_expiry_date: Optional[str] = None
    creator_name: Optional[str] = Field(None, max_length=255)
    contractor_role: Optional[str] = Field(None, max_length=100)
    service_rate_categories: Optional[str] = None
    bank_account_id: Optional[uuid.UUID] = None
    opening_balance: Optional[float] = None
    opening_balance_type: Optional[str] = None


def _parse_optional_datetime(value: Optional[str]) -> Optional[datetime]:
    if value is None:
        return None

    if isinstance(value, datetime):
        return value

    candidate = value.strip()
    if not candidate:
        return None

    normalized = candidate.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        pass

    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d-%b-%Y", "%d-%B-%Y"):
        try:
            return datetime.strptime(candidate, fmt)
        except ValueError:
            continue

    return None


# ─── UNITS MASTER ───
STANDARD_CONSTRUCTION_UNITS = [
    {"code": "Bag", "name": "Bags (Cement / Dry Mix)", "category": "Packaging"},
    {"code": "MT", "name": "Metric Tonnes", "category": "Weight"},
    {"code": "Kg", "name": "Kilograms", "category": "Weight"},
    {"code": "Ton", "name": "Tonnes", "category": "Weight"},
    {"code": "Quintal", "name": "Quintals (100 kg)", "category": "Weight"},
    {"code": "Nos", "name": "Numbers / Pieces", "category": "Count"},
    {"code": "Sq.Ft", "name": "Square Feet", "category": "Area"},
    {"code": "Sq.M", "name": "Square Meters", "category": "Area"},
    {"code": "Cu.M", "name": "Cubic Meters (Cum)", "category": "Volume"},
    {"code": "Cu.Ft", "name": "Cubic Feet (Cft)", "category": "Volume"},
    {"code": "Brass", "name": "Brass (100 Cu.Ft)", "category": "Volume"},
    {"code": "Ltr", "name": "Liters", "category": "Liquid Volume"},
    {"code": "Bundle", "name": "Bundles (Rebar / Pipes)", "category": "Packaging"},
    {"code": "Trip", "name": "Trips (Dumpers / Tankers)", "category": "Logistics"},
    {"code": "R.Ft", "name": "Running Feet", "category": "Length"},
    {"code": "R.M", "name": "Running Meters", "category": "Length"},
    {"code": "Hour", "name": "Hours (Plant & Machinery)", "category": "Time"},
    {"code": "Day", "name": "Days / Shifts", "category": "Time"},
]


@router.get("/units")
def get_library_units(
    search: Optional[str] = None,
    response: Response = None,
):
    """Standard Construction Unit Master with search support (Onsite Parity 14.9.4 #10)."""
    units = STANDARD_CONSTRUCTION_UNITS
    if search and search.strip():
        term = search.strip().lower()
        units = [u for u in units if term in u["code"].lower() or term in u["name"].lower() or term in u["category"].lower()]
    if response is not None:
        response.headers["X-Total-Count"] = str(len(units))
    return units


# ─── PARTIES ───
def next_party_id_custom(db: Session, company_id: uuid.UUID) -> str:
    """Company-scoped party ID generator (COUNT + 1 with collision loop), shared by
    every LibraryParty creation site so no party is stored without an identifier.

    The loop makes this safe against gaps but not against two concurrent creates
    picking the same candidate, which is why migration 20260902_000002 adds a
    unique index on (company_id, party_id_custom) as the real guarantee."""
    count = db.query(models.LibraryParty).filter(models.LibraryParty.company_id == company_id).count()
    candidate = f"PID-{count + 1}"
    while db.query(models.LibraryParty).filter(
            models.LibraryParty.company_id == company_id,
            models.LibraryParty.party_id_custom == candidate).first():
        count += 1
        candidate = f"PID-{count + 1}"
    return candidate


@router.get("/parties/{company_id}")
def get_library_parties(
    company_id: uuid.UUID,
    party_type: Optional[str] = None,
    search: Optional[str] = None,
    limit: Optional[int] = Query(None, ge=1, le=500),
    offset: int = Query(0, ge=0),
    response: Response = None,
    db: Session = Depends(get_db),
    _: None = Depends(verify_company_access),
):
    query = db.query(models.LibraryParty).filter(models.LibraryParty.company_id == company_id)
    if party_type:
        from sqlalchemy import func
        query = query.filter(func.lower(models.LibraryParty.party_type) == party_type.strip().lower())
    if search and search.strip():
        term = f"%{search.strip()}%"
        from sqlalchemy import or_
        query = query.filter(
            or_(
                models.LibraryParty.name.ilike(term),
                models.LibraryParty.phone.ilike(term),
                models.LibraryParty.email.ilike(term),
                models.LibraryParty.tax_no.ilike(term),
                models.LibraryParty.party_id_custom.ilike(term),
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
    return query.all()

@router.post("/parties")
def create_library_party(payload: PartyCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, payload.company_id)
    require_permission(db, current_user, payload.company_id, "library:edit")
    # Automatically generate custom PID if not supplied
    # R2-440: a supplied ID is stored trimmed; blank or whitespace-only falls through
    # to the generator so no party is ever stored without a visible identifier.
    supplied = (payload.party_id_custom or "").strip()
    if supplied:
        # A supplied ID used to be stored unchecked, which is how this company
        # ended up with two parties both called PID-2. The generator has a
        # collision loop; the supplied path had none.
        clash = db.query(models.LibraryParty).filter(
            models.LibraryParty.company_id == payload.company_id,
            models.LibraryParty.party_id_custom == supplied,
        ).first()
        if clash:
            raise HTTPException(
                status_code=409,
                detail=f"Party ID {supplied} is already used by {clash.name}",
            )
        payload.party_id_custom = supplied
    else:
        payload.party_id_custom = next_party_id_custom(db, payload.company_id)
    
    refuse_same_name_on_create(db, models.LibraryParty, payload)
    party = models.LibraryParty(
        company_id=payload.company_id,
        party_id_custom=payload.party_id_custom,
        name=payload.name,
        phone=payload.phone,
        email=payload.email,
        party_type=payload.party_type,
        address=payload.address,
        bank_name=payload.bank_name,
        account_name=payload.account_name,
        account_number=payload.account_number,
        ifsc_code=payload.ifsc_code,
        tax_no=payload.tax_no,
        date_of_joining=_parse_optional_datetime(payload.date_of_joining),
        aadhaar_number=payload.aadhaar_number,
        pan_number=payload.pan_number,
        esi_number=payload.esi_number,
        pf_number=payload.pf_number,
        father_name=payload.father_name,
        passport_no=payload.passport_no,
        passport_expiry_date=_parse_optional_datetime(payload.passport_expiry_date),
        creator_name=payload.creator_name,
        aadhaar_file=payload.aadhaar_file,
        pan_file=payload.pan_file,
        contractor_role=payload.contractor_role,
        service_rate_categories=payload.service_rate_categories,
        bank_account_id=payload.bank_account_id,
        opening_balance=payload.opening_balance or 0.0,
        opening_balance_type=payload.opening_balance_type,
    )
    db.add(party)
    db.flush()
    # Opening balance is project-scoped: persist it on the project_parties junction
    # when a project context is supplied, otherwise keep a global opening record.
    if payload.opening_balance_direction in ("will_pay", "will_receive") and (payload.opening_balance_amount or 0) > 0:
        amount = float(payload.opening_balance_amount)
        adv = amount if payload.opening_balance_direction == "will_receive" else 0.0
        pay = amount if payload.opening_balance_direction == "will_pay" else 0.0
        if payload.project_id:
            db.add(models.ProjectParty(
                project_id=payload.project_id,
                party_id=party.id,
                balance=round(adv - pay, 2),
                advance_paid=adv,
                to_pay=pay,
            ))
    db.commit()
    db.refresh(party)
    return party


@router.put("/parties/{party_id}")
def update_library_party(party_id: uuid.UUID, payload: PartyUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    party = db.query(models.LibraryParty).filter(models.LibraryParty.id == party_id).first()
    if not party:
        raise HTTPException(status_code=404, detail="Party not found")
    get_company_membership(db, current_user, party.company_id)
    require_permission(db, current_user, party.company_id, "library:edit")
    refuse_same_name_on_update(db, party, payload)

    update_dict = payload.model_dump(exclude_unset=True)
    if "date_of_joining" in update_dict:
        update_dict["date_of_joining"] = _parse_optional_datetime(update_dict["date_of_joining"])
    if "passport_expiry_date" in update_dict:
        update_dict["passport_expiry_date"] = _parse_optional_datetime(update_dict["passport_expiry_date"])

    for k, v in update_dict.items():
        setattr(party, k, v)

    db.commit()
    db.refresh(party)
    return party


@router.get("/parties/{company_id}/balances")
def get_party_balances(
    company_id: uuid.UUID,
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: None = Depends(verify_company_access),
    _project: None = Depends(verify_project_access),
):
    q = db.query(models.ProjectParty).filter(models.ProjectParty.project_id == project_id)
    balances = q.all()
    advance_paid = sum(float(b.advance_paid) for b in balances)
    to_pay = sum(float(b.to_pay) for b in balances)
    return {"advance_paid": round(advance_paid, 2), "to_pay": round(to_pay, 2)}

def log_kyc_access(
    db: Session,
    company_id: uuid.UUID,
    party_id: uuid.UUID,
    party_name: Optional[str],
    document_type: str,
    accessed_by: str,
):
    """5B.6 Audit trail recording KYC identity document access / unmasking."""
    log = models.KYCAccessLog(
        company_id=company_id,
        party_id=party_id,
        party_name=party_name,
        document_type=document_type,
        accessed_by=accessed_by,
    )
    db.add(log)
    db.commit()


@router.post("/parties/{party_id}/kyc/{doc_type}")
async def upload_party_kyc_document(
    party_id: uuid.UUID,
    doc_type: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if doc_type not in ("aadhaar_file", "pan_file"):
        raise HTTPException(status_code=400, detail="Invalid KYC document type. Expected 'aadhaar_file' or 'pan_file'.")
    party = db.query(models.LibraryParty).filter(models.LibraryParty.id == party_id).first()
    if not party:
        raise HTTPException(status_code=404, detail="Party not found")
    get_company_membership(db, current_user, party.company_id)
    require_permission(db, current_user, party.company_id, "library:edit")

    # 5B.2 Server-side validation: MIME type
    content_type = (file.content_type or "").strip().lower()
    allowed_types = {"image/jpeg": ".jpg", "image/png": ".png", "application/pdf": ".pdf"}
    if content_type not in allowed_types:
        raise HTTPException(
            status_code=400,
            detail="Invalid file type. Only JPEG, PNG, and PDF documents are allowed for identity verification.",
        )
    
    contents = await file.read()
    # 5B.2 Server-side validation: 5 MB cap
    if len(contents) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File size exceeds maximum allowed limit of 5 MB.")

    # 5B.2 Non-client generated storage path
    ext = allowed_types[content_type]
    file_id = uuid.uuid4().hex[:12]
    storage_path = f"{party.company_id}/{party.id}/{doc_type}_{file_id}{ext}"

    if supabase_storage.is_storage_configured():
        # Delete old file if exists
        old_path = getattr(party, doc_type, None)
        if old_path:
            supabase_storage.delete_object(supabase_storage.BUCKET_KYC_DOCUMENTS, old_path)
        supabase_storage.upload_bytes(
            supabase_storage.BUCKET_KYC_DOCUMENTS, storage_path, contents, content_type
        )
    
    setattr(party, doc_type, storage_path)
    db.commit()
    db.refresh(party)
    return {"success": True, "doc_type": doc_type, "storage_path": storage_path}


@router.get("/parties/{party_id}/kyc/{doc_type}")
def get_party_kyc_document_url(
    party_id: uuid.UUID,
    doc_type: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if doc_type not in ("aadhaar_file", "pan_file"):
        raise HTTPException(status_code=400, detail="Invalid KYC document type.")
    party = db.query(models.LibraryParty).filter(models.LibraryParty.id == party_id).first()
    if not party:
        raise HTTPException(status_code=404, detail="Party not found")
    get_company_membership(db, current_user, party.company_id)
    require_permission(db, current_user, party.company_id, "library:edit")

    storage_path = getattr(party, doc_type, None)
    if not storage_path:
        raise HTTPException(status_code=404, detail="Document not found")

    # 5B.3 15-minute signed URL per request
    signed_url = None
    if supabase_storage.is_storage_configured():
        signed_url = supabase_storage.create_signed_url(
            supabase_storage.BUCKET_KYC_DOCUMENTS, storage_path, expires_in=900
        )
    else:
        # Fallback for dev / unconfigured storage
        signed_url = f"/mock-storage/{supabase_storage.BUCKET_KYC_DOCUMENTS}/{storage_path}"

    # 5B.6 Access logging
    actor = getattr(current_user, "name", None) or getattr(current_user, "email", "unknown")
    log_kyc_access(db, party.company_id, party.id, party.name, doc_type, actor)

    return {"url": signed_url, "expires_in_seconds": 900}


@router.delete("/parties/{party_id}/kyc/{doc_type}")
def delete_party_kyc_document(
    party_id: uuid.UUID,
    doc_type: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if doc_type not in ("aadhaar_file", "pan_file"):
        raise HTTPException(status_code=400, detail="Invalid KYC document type.")
    party = db.query(models.LibraryParty).filter(models.LibraryParty.id == party_id).first()
    if not party:
        raise HTTPException(status_code=404, detail="Party not found")
    get_company_membership(db, current_user, party.company_id)
    require_permission(db, current_user, party.company_id, "library:edit")

    storage_path = getattr(party, doc_type, None)
    if storage_path and supabase_storage.is_storage_configured():
        supabase_storage.delete_object(supabase_storage.BUCKET_KYC_DOCUMENTS, storage_path)

    setattr(party, doc_type, None)
    db.commit()
    return {"success": True}


@router.get("/parties/{party_id}/aadhaar-reveal")
def reveal_party_aadhaar(
    party_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    party = db.query(models.LibraryParty).filter(models.LibraryParty.id == party_id).first()
    if not party:
        raise HTTPException(status_code=404, detail="Party not found")
    get_company_membership(db, current_user, party.company_id)
    require_permission(db, current_user, party.company_id, "library:edit")

    actor = getattr(current_user, "name", None) or getattr(current_user, "email", "unknown")
    log_kyc_access(db, party.company_id, party.id, party.name, "aadhaar_number_reveal", actor)

    return {"aadhaar_number": party.aadhaar_number}


def _refuse_if_party_in_use(db: Session, party: models.LibraryParty) -> None:
    """A party with bills, payments, orders or an open balance is not deleted:
    deleting took its project balances with it, and left those documents
    under a name nobody could find in the library any more."""
    m = models
    team_ids = [tid for (tid,) in db.query(m.CompanyTeam.id).filter(
        m.CompanyTeam.company_id == party.company_id, m.CompanyTeam.library_party_id == party.id).all()]
    used = {}
    if team_ids:
        used = {
            "bill": db.query(m.Bill).filter(m.Bill.party_company_user_id.in_(team_ids)).count(),
            "payment": db.query(m.Payment).filter(m.Payment.party_company_user_id.in_(team_ids)).count(),
            "purchase order": db.query(m.PurchaseOrder).filter(m.PurchaseOrder.vendor_id.in_(team_ids)).count(),
            "work order": db.query(m.WorkOrder).filter(m.WorkOrder.subcontractor_id.in_(team_ids)).count(),
        }
    open_balance = db.query(m.ProjectParty).filter(
        m.ProjectParty.party_id == party.id,
        (m.ProjectParty.advance_paid != 0) | (m.ProjectParty.to_pay != 0),
    ).count()
    if open_balance:
        used["project with money still open"] = open_balance
    used = {k: v for k, v in used.items() if v}
    if used:
        what = ", ".join(f"{n} {label}{'' if n == 1 or label.startswith('project') else 's'}" for label, n in used.items())
        raise HTTPException(status_code=409, detail=f"{party.name} has {what}. Keep the party so those records stay linked to it.")


@router.delete("/parties/{party_id}")
def delete_library_party(party_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    party = db.query(models.LibraryParty).filter(models.LibraryParty.id == party_id).first()
    if not party:
        raise HTTPException(status_code=404, detail="Party not found")
    get_company_membership(db, current_user, party.company_id)
    require_permission(db, current_user, party.company_id, "data:delete")
    _refuse_if_party_in_use(db, party)
    # 5B.5 Delete stored objects with delete_object
    if party.aadhaar_file and supabase_storage.is_storage_configured():
        supabase_storage.delete_object(supabase_storage.BUCKET_KYC_DOCUMENTS, party.aadhaar_file)
    if party.pan_file and supabase_storage.is_storage_configured():
        supabase_storage.delete_object(supabase_storage.BUCKET_KYC_DOCUMENTS, party.pan_file)
    from app.routers.delete_logs import log_deletion
    log_deletion(db, party.company_id, "party", party.id, f"Party: {party.name}", party_name=party.name, deleted_by=current_user.name)
    db.delete(party)
    db.commit()
    return {"success": True}


# ─── ASSET TYPES ───
@router.get("/asset-types/{company_id}")
def get_library_asset_types(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    return db.query(models.LibraryAssetType).filter(models.LibraryAssetType.company_id == company_id).all()

@router.post("/asset-types")
def create_library_asset_type(payload: AssetTypeCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, payload.company_id)
    require_permission(db, current_user, payload.company_id, "library:edit")
    refuse_same_name_on_create(db, models.LibraryAssetType, payload)
    item = models.LibraryAssetType(company_id=payload.company_id, name=payload.name)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item

@router.put("/asset-types/{item_id}")
def update_library_asset_type(item_id: uuid.UUID, payload: AssetTypeUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(models.LibraryAssetType).filter(models.LibraryAssetType.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Asset type not found")
    get_company_membership(db, current_user, item.company_id)
    require_permission(db, current_user, item.company_id, "library:edit")
    refuse_same_name_on_update(db, item, payload)
    item.name = payload.name
    db.commit()
    db.refresh(item)
    return item

@router.delete("/asset-types/{item_id}")
def delete_library_asset_type(item_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(models.LibraryAssetType).filter(models.LibraryAssetType.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Asset type not found")
    get_company_membership(db, current_user, item.company_id)
    require_permission(db, current_user, item.company_id, "data:delete")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, item.company_id, "asset_type", item.id, f"Asset Type: {item.name}", deleted_by=current_user.name)
    db.delete(item)
    db.commit()
    return {"success": True}


# ─── COST CODES ───
# Records keep the cost code as text (BOQ items, payments, payroll details,
# workforce and rate cards, quotation lines). So a code that is deleted or
# renamed must not leave them pointing at a code that no longer exists: every
# later edit of such a record is refused as "unknown cost code".

def _cost_code_usage(db: Session, company_id: uuid.UUID, code: str) -> dict:
    m = models
    counts = {
        "BOQ item": db.query(m.BOQItem).join(m.Project, m.Project.id == m.BOQItem.project_id)
            .filter(m.Project.company_id == company_id, m.BOQItem.cost_code == code).count(),
        "payment": db.query(m.Payment).filter(m.Payment.company_id == company_id, m.Payment.cost_code == code).count(),
        "payroll detail": db.query(m.PayrollProfile).filter(m.PayrollProfile.company_id == company_id, m.PayrollProfile.cost_code == code).count(),
        "workforce": db.query(m.LibraryWorkforce).filter(m.LibraryWorkforce.company_id == company_id, m.LibraryWorkforce.cost_code == code).count(),
        "rate card item": db.query(m.LibraryRate).filter(m.LibraryRate.company_id == company_id, m.LibraryRate.cost_code == code).count(),
        "quotation line": db.query(m.CRMQuotationItem).join(m.CRMQuotation, m.CRMQuotation.id == m.CRMQuotationItem.quotation_id)
            .join(m.CRMLead, m.CRMLead.id == m.CRMQuotation.lead_id)
            .filter(m.CRMLead.company_id == company_id, m.CRMQuotationItem.cost_code == code).count(),
    }
    return {k: v for k, v in counts.items() if v}


def _describe_usage(usage: dict) -> str:
    return ", ".join(f"{n} {label}{'' if n == 1 else 's'}" for label, n in usage.items())


def _rename_cost_code_everywhere(db: Session, company_id: uuid.UUID, old: str, new: str) -> None:
    m = models
    project_ids = [pid for (pid,) in db.query(m.Project.id).filter(m.Project.company_id == company_id).all()]
    if project_ids:
        db.query(m.BOQItem).filter(m.BOQItem.project_id.in_(project_ids), m.BOQItem.cost_code == old).update(
            {m.BOQItem.cost_code: new}, synchronize_session=False)
    for model in (m.Payment, m.PayrollProfile, m.LibraryWorkforce, m.LibraryRate):
        db.query(model).filter(model.company_id == company_id, model.cost_code == old).update(
            {model.cost_code: new}, synchronize_session=False)
    quote_ids = [qid for (qid,) in db.query(m.CRMQuotation.id).join(m.CRMLead, m.CRMLead.id == m.CRMQuotation.lead_id)
                 .filter(m.CRMLead.company_id == company_id).all()]
    if quote_ids:
        db.query(m.CRMQuotationItem).filter(m.CRMQuotationItem.quotation_id.in_(quote_ids),
                                            m.CRMQuotationItem.cost_code == old).update(
            {m.CRMQuotationItem.cost_code: new}, synchronize_session=False)


def _check_code_free(db: Session, company_id: uuid.UUID, code: str, item_id: Optional[uuid.UUID] = None) -> None:
    q = db.query(models.LibraryCostCode).filter(models.LibraryCostCode.company_id == company_id,
                                                models.LibraryCostCode.code == code)
    if item_id:
        q = q.filter(models.LibraryCostCode.id != item_id)
    clash = q.first()
    if clash:
        raise HTTPException(status_code=409, detail=f"Cost code {code} already exists ({clash.name}).")


def _check_parent(db: Session, company_id: uuid.UUID, parent_id: Optional[uuid.UUID], item_id: Optional[uuid.UUID] = None) -> None:
    """The parent must be one of this company's codes, and a code cannot sit under itself."""
    seen = set()
    current = parent_id
    while current:
        if item_id and current == item_id:
            raise HTTPException(status_code=422, detail="A cost code cannot sit under itself or one of its own sub codes.")
        if current in seen:
            break
        seen.add(current)
        node = db.query(models.LibraryCostCode).filter(models.LibraryCostCode.id == current,
                                                       models.LibraryCostCode.company_id == company_id).first()
        if not node:
            raise HTTPException(status_code=422, detail="Pick a parent cost code from this company's list.")
        current = node.parent_id


def _clean_text(value: Optional[str], what: str) -> str:
    v = (value or "").strip()
    if not v:
        raise HTTPException(status_code=422, detail=f"Enter the {what}.")
    return v


@router.get("/cost-codes/{company_id}")
def get_library_cost_codes(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    return db.query(models.LibraryCostCode).filter(models.LibraryCostCode.company_id == company_id).all()

@router.post("/cost-codes")
def create_library_cost_code(payload: CostCodeCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, payload.company_id)
    require_permission(db, current_user, payload.company_id, "library:edit")
    code = _clean_text(payload.code, "cost code")
    name = _clean_text(payload.name, "cost code name")
    _check_code_free(db, payload.company_id, code)
    _check_parent(db, payload.company_id, payload.parent_id)
    item = models.LibraryCostCode(
        company_id=payload.company_id,
        code=code,
        sub_cost_code=(payload.sub_cost_code or "").strip() or None,
        parent_id=payload.parent_id,
        name=name,
        budget_amount=payload.budget_amount,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item

@router.put("/cost-codes/{item_id}")
def update_library_cost_code(item_id: uuid.UUID, payload: CostCodeUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(models.LibraryCostCode).filter(models.LibraryCostCode.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Cost code not found")
    get_company_membership(db, current_user, item.company_id)
    require_permission(db, current_user, item.company_id, "library:edit")
    data = payload.model_dump(exclude_unset=True)
    if "code" in data:
        data["code"] = _clean_text(data["code"], "cost code")
        if data["code"] != item.code:
            _check_code_free(db, item.company_id, data["code"], item.id)
            # Records using the old code move with it.
            _rename_cost_code_everywhere(db, item.company_id, item.code, data["code"])
    if "name" in data:
        data["name"] = _clean_text(data["name"], "cost code name")
    if "parent_id" in data:
        _check_parent(db, item.company_id, data["parent_id"], item.id)
    if "budget_amount" in data and data["budget_amount"] is None:
        data.pop("budget_amount")
    for k, v in data.items():
        setattr(item, k, v)
    db.commit()
    db.refresh(item)
    return item

@router.delete("/cost-codes/{item_id}")
def delete_library_cost_code(item_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(models.LibraryCostCode).filter(models.LibraryCostCode.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Cost code not found")
    get_company_membership(db, current_user, item.company_id)
    require_permission(db, current_user, item.company_id, "data:delete")
    # Sub codes used to vanish with their parent without a word.
    children = db.query(models.LibraryCostCode).filter(models.LibraryCostCode.parent_id == item.id).count()
    if children:
        raise HTTPException(status_code=409, detail=f"Cost code {item.code} has {children} sub code{'' if children == 1 else 's'} under it. Move or delete them first.")
    usage = _cost_code_usage(db, item.company_id, item.code)
    if usage:
        raise HTTPException(status_code=409, detail=f"Cost code {item.code} is used on {_describe_usage(usage)}. Move those to another code first, or keep this one.")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, item.company_id, "cost_code", item.id, f"Cost Code: {item.name}", deleted_by=current_user.name)
    db.delete(item)
    db.commit()
    return {"success": True}


# ─── DEDUCTIONS ───
@router.get("/deductions/{company_id}")
def get_library_deductions(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    return db.query(models.LibraryDeduction).filter(models.LibraryDeduction.company_id == company_id).all()

@router.post("/deductions")
def create_library_deduction(payload: DeductionCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, payload.company_id)
    require_permission(db, current_user, payload.company_id, "library:edit")
    refuse_same_name_on_create(db, models.LibraryDeduction, payload)
    item = models.LibraryDeduction(company_id=payload.company_id, name=payload.name)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item

@router.put("/deductions/{item_id}")
def update_library_deduction(item_id: uuid.UUID, payload: DeductionUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(models.LibraryDeduction).filter(models.LibraryDeduction.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Deduction not found")
    get_company_membership(db, current_user, item.company_id)
    require_permission(db, current_user, item.company_id, "library:edit")
    refuse_same_name_on_update(db, item, payload)
    item.name = payload.name
    db.commit()
    db.refresh(item)
    return item

@router.delete("/deductions/{item_id}")
def delete_library_deduction(item_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(models.LibraryDeduction).filter(models.LibraryDeduction.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Deduction not found")
    get_company_membership(db, current_user, item.company_id)
    require_permission(db, current_user, item.company_id, "data:delete")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, item.company_id, "deduction", item.id, f"Deduction: {item.name}", deleted_by=current_user.name)
    db.delete(item)
    db.commit()
    return {"success": True}


# ─── PROGRESSES ───
@router.get("/progresses/{company_id}")
def get_library_progresses(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    return db.query(models.LibraryProgress).filter(models.LibraryProgress.company_id == company_id).all()

@router.post("/progresses")
def create_library_progress(payload: ProgressCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, payload.company_id)
    require_permission(db, current_user, payload.company_id, "library:edit")
    refuse_same_name_on_create(db, models.LibraryProgress, payload)
    item = models.LibraryProgress(company_id=payload.company_id, name=payload.name)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item

@router.put("/progresses/{item_id}")
def update_library_progress(item_id: uuid.UUID, payload: ProgressUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(models.LibraryProgress).filter(models.LibraryProgress.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Progress not found")
    get_company_membership(db, current_user, item.company_id)
    require_permission(db, current_user, item.company_id, "library:edit")
    refuse_same_name_on_update(db, item, payload)
    item.name = payload.name
    db.commit()
    db.refresh(item)
    return item

@router.delete("/progresses/{item_id}")
def delete_library_progress(item_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(models.LibraryProgress).filter(models.LibraryProgress.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Progress not found")
    get_company_membership(db, current_user, item.company_id)
    require_permission(db, current_user, item.company_id, "data:delete")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, item.company_id, "progress", item.id, f"Progress: {item.name}", deleted_by=current_user.name)
    db.delete(item)
    db.commit()
    return {"success": True}


# ─── WORKFORCES ───
@router.get("/workforces/{company_id}")
def get_library_workforces(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    return db.query(models.LibraryWorkforce).filter(models.LibraryWorkforce.company_id == company_id).all()

@router.post("/workforces")
def create_library_workforce(payload: WorkforceCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, payload.company_id)
    require_permission(db, current_user, payload.company_id, "library:edit")
    refuse_same_name_on_create(db, models.LibraryWorkforce, payload)
    item = models.LibraryWorkforce(
        company_id=payload.company_id,
        name=payload.name,
        rate_type=payload.rate_type,
        salary_per_shift=payload.salary_per_shift,
        shift_hours=payload.shift_hours,
        cost_code=payload.cost_code,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item

@router.put("/workforces/{item_id}")
def update_library_workforce(item_id: uuid.UUID, payload: WorkforceUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(models.LibraryWorkforce).filter(models.LibraryWorkforce.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Workforce not found")
    get_company_membership(db, current_user, item.company_id)
    require_permission(db, current_user, item.company_id, "library:edit")
    refuse_same_name_on_update(db, item, payload)
    update_data = payload.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(item, field, value)
    db.commit()
    db.refresh(item)
    return item

@router.delete("/workforces/{item_id}")
def delete_library_workforce(item_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(models.LibraryWorkforce).filter(models.LibraryWorkforce.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Workforce not found")
    get_company_membership(db, current_user, item.company_id)
    require_permission(db, current_user, item.company_id, "data:delete")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, item.company_id, "workforce", item.id, f"Workforce: {item.name}", deleted_by=current_user.name)
    db.delete(item)
    db.commit()
    return {"success": True}


@router.get("/materials/{company_id}")
def get_library_materials(
    company_id: uuid.UUID,
    search: Optional[str] = None,
    limit: Optional[int] = Query(None, ge=1, le=500),
    offset: int = Query(0, ge=0),
    response: Response = None,
    db: Session = Depends(get_db),
    _: None = Depends(verify_company_access),
):
    query = db.query(models.LibraryMaterial).filter(models.LibraryMaterial.company_id == company_id)
    if search and search.strip():
        term = f"%{search.strip()}%"
        from sqlalchemy import or_
        query = query.filter(
            or_(
                models.LibraryMaterial.name.ilike(term),
                models.LibraryMaterial.category.ilike(term),
                models.LibraryMaterial.item_code.ilike(term),
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
    return query.all()

@router.post("/materials")
def create_library_material(payload: MaterialCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, payload.company_id)
    require_permission(db, current_user, payload.company_id, "library:edit")
    refuse_same_name_on_create(db, models.LibraryMaterial, payload)
    item = models.LibraryMaterial(
        company_id=payload.company_id,
        name=payload.name,
        unit=payload.unit,
        alternate_unit=payload.alternate_unit,
        gst_rate=payload.gst_rate,
        category=payload.category,
        unit_cost=payload.unit_cost,
        lead_time_days=payload.lead_time_days,
        hsn_sac=payload.hsn_sac,
        item_code=payload.item_code,
        specifications=payload.specifications,
        # Resolve server-side rather than trusting the client, the same way the
        # DPR author is resolved. The client may still send a display name; the
        # authenticated user wins.
        creator_name=(current_user.name or payload.creator_name),
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item

@router.put("/materials/{item_id}")
def update_library_material(item_id: uuid.UUID, payload: MaterialUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(models.LibraryMaterial).filter(models.LibraryMaterial.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Material not found")
    get_company_membership(db, current_user, item.company_id)
    require_permission(db, current_user, item.company_id, "library:edit")
    refuse_same_name_on_update(db, item, payload)
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(item, k, v)
    db.commit()
    db.refresh(item)
    return item

@router.delete("/materials/{item_id}")
def delete_library_material(item_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(models.LibraryMaterial).filter(models.LibraryMaterial.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Material not found")
    get_company_membership(db, current_user, item.company_id)
    require_permission(db, current_user, item.company_id, "data:delete")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, item.company_id, "material", item.id, f"Material: {item.name}", deleted_by=current_user.name)
    db.delete(item)
    db.commit()
    return {"success": True}


# ─── RATES ───
def _sale_price(unit_cost, markup_value, markup_type) -> float:
    """Sale price is always cost plus markup. It was taken as sent, so a cost
    changed later left the old sale price standing."""
    cost = float(unit_cost or 0)
    markup = float(markup_value or 0)
    price = cost * (1 + markup / 100) if (markup_type or "percent") == "percent" else cost + markup
    if price < 0:
        raise HTTPException(status_code=422, detail="The markup takes the sale price below zero.")
    return round(price, 2)


@router.get("/rates/{company_id}")
def get_library_rates(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    return db.query(models.LibraryRate).filter(models.LibraryRate.company_id == company_id).all()

@router.post("/rates")
def create_library_rate(payload: RateCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, payload.company_id)
    require_permission(db, current_user, payload.company_id, "library:edit")
    # R2-764: library rate cost code must exist in the company's Cost Code Library
    if payload.cost_code:
        assert_cost_codes_known(db, payload.company_id, codes=[payload.cost_code], status_code=422)
    refuse_same_name_on_create(db, models.LibraryRate, payload)
    item = models.LibraryRate(
        company_id=payload.company_id,
        name=payload.name,
        item_code=payload.item_code,
        unit=payload.unit,
        gst_rate=payload.gst_rate,
        category=payload.category,
        unit_cost=payload.unit_cost,
        markup_value=payload.markup_value,
        markup_type=payload.markup_type,
        unit_sale_price=_sale_price(payload.unit_cost, payload.markup_value, payload.markup_type),
        note=payload.note,
        cost_code=payload.cost_code,
        hsn_sac=payload.hsn_sac
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item

@router.put("/rates/{item_id}")
def update_library_rate(item_id: uuid.UUID, payload: RateUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(models.LibraryRate).filter(models.LibraryRate.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Rate item not found")
    get_company_membership(db, current_user, item.company_id)
    require_permission(db, current_user, item.company_id, "library:edit")
    refuse_same_name_on_update(db, item, payload)
    if payload.cost_code:
        assert_cost_codes_known(db, item.company_id, codes=[payload.cost_code], status_code=422)
    for k, v in payload.model_dump(exclude_unset=True).items():
        if k == "unit_sale_price":
            continue
        setattr(item, k, v)
    item.unit_sale_price = _sale_price(item.unit_cost, item.markup_value, item.markup_type)
    db.commit()
    db.refresh(item)
    return item

@router.delete("/rates/{item_id}")
def delete_library_rate(item_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(models.LibraryRate).filter(models.LibraryRate.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Rate item not found")
    get_company_membership(db, current_user, item.company_id)
    require_permission(db, current_user, item.company_id, "data:delete")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, item.company_id, "rate", item.id, f"Rate: {item.name}", deleted_by=current_user.name)
    db.delete(item)
    db.commit()
    return {"success": True}


# ─── RETENTIONS ───

class RetentionCreate(BaseModel):
    company_id: uuid.UUID
    name: str = Field(..., max_length=255)

class RetentionUpdate(BaseModel):
    name: str = Field(..., max_length=255)


@router.get("/retentions/{company_id}")
def get_library_retentions(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    return db.query(models.LibraryRetention).filter(models.LibraryRetention.company_id == company_id).all()


@router.post("/retentions")
def create_library_retention(payload: RetentionCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, payload.company_id)
    require_permission(db, current_user, payload.company_id, "library:edit")
    refuse_same_name_on_create(db, models.LibraryRetention, payload)
    item = models.LibraryRetention(company_id=payload.company_id, name=payload.name)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.put("/retentions/{item_id}")
def update_library_retention(item_id: uuid.UUID, payload: RetentionUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(models.LibraryRetention).filter(models.LibraryRetention.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Retention not found")
    get_company_membership(db, current_user, item.company_id)
    require_permission(db, current_user, item.company_id, "library:edit")
    refuse_same_name_on_update(db, item, payload)
    item.name = payload.name
    db.commit()
    db.refresh(item)
    return item


@router.delete("/retentions/{item_id}")
def delete_library_retention(item_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(models.LibraryRetention).filter(models.LibraryRetention.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Retention not found")
    get_company_membership(db, current_user, item.company_id)
    require_permission(db, current_user, item.company_id, "data:delete")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, item.company_id, "retention", item.id, f"Retention: {item.name}", deleted_by=current_user.name)
    db.delete(item)
    db.commit()
    return {"success": True}


# ─── MATERIAL CATEGORIES ───

class MaterialCategoryCreate(BaseModel):
    company_id: uuid.UUID
    name: str = Field(..., max_length=255)
    parent_id: Optional[uuid.UUID] = None

class MaterialCategoryUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=255)
    parent_id: Optional[uuid.UUID] = None


@router.get("/material-categories/{company_id}")
def get_material_categories(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    return db.query(models.MaterialCategory).filter(models.MaterialCategory.company_id == company_id).all()


@router.post("/material-categories")
def create_material_category(payload: MaterialCategoryCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, payload.company_id)
    require_permission(db, current_user, payload.company_id, "library:edit")
    refuse_same_name_on_create(db, models.MaterialCategory, payload)
    item = models.MaterialCategory(
        company_id=payload.company_id,
        name=payload.name,
        parent_id=payload.parent_id,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.put("/material-categories/{item_id}")
def update_material_category(item_id: uuid.UUID, payload: MaterialCategoryUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(models.MaterialCategory).filter(models.MaterialCategory.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Material category not found")
    get_company_membership(db, current_user, item.company_id)
    require_permission(db, current_user, item.company_id, "library:edit")
    refuse_same_name_on_update(db, item, payload)
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(item, k, v)
    db.commit()
    db.refresh(item)
    return item


@router.delete("/material-categories/{item_id}")
def delete_material_category(item_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(models.MaterialCategory).filter(models.MaterialCategory.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Material category not found")
    get_company_membership(db, current_user, item.company_id)
    require_permission(db, current_user, item.company_id, "data:delete")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, item.company_id, "material_category", item.id, f"Material Category: {item.name}", deleted_by=current_user.name)
    db.delete(item)
    db.commit()
    return {"success": True}


# ─── TODOS (Library preset labels) ───

class TodoCreate(BaseModel):
    company_id: uuid.UUID
    name: str = Field(..., max_length=255)

class TodoUpdate(BaseModel):
    name: str = Field(..., max_length=255)


@router.get("/todos/{company_id}")
def get_library_todos(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    return db.query(models.LibraryTodo).filter(models.LibraryTodo.company_id == company_id).all()


@router.post("/todos")
def create_library_todo(payload: TodoCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_company_membership(db, current_user, payload.company_id)
    require_permission(db, current_user, payload.company_id, "library:edit")
    item = models.LibraryTodo(company_id=payload.company_id, name=payload.name)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.put("/todos/{item_id}")
def update_library_todo(item_id: uuid.UUID, payload: TodoUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(models.LibraryTodo).filter(models.LibraryTodo.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="To Do not found")
    get_company_membership(db, current_user, item.company_id)
    require_permission(db, current_user, item.company_id, "library:edit")
    item.name = payload.name
    db.commit()
    db.refresh(item)
    return item


@router.delete("/todos/{item_id}")
def delete_library_todo(item_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    item = db.query(models.LibraryTodo).filter(models.LibraryTodo.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="To Do not found")
    get_company_membership(db, current_user, item.company_id)
    require_permission(db, current_user, item.company_id, "data:delete")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, item.company_id, "library_todo", item.id, f"Library Todo: {item.name}", deleted_by=current_user.name)
    db.delete(item)
    db.commit()
    return {"success": True}

