import re
import uuid
from typing import List, Optional, Literal
from datetime import datetime
from decimal import Decimal
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Response
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field, field_validator, model_validator
from app.database import get_db
from app.auth import get_current_user, verify_company_access, get_company_membership, require_permission, is_owner_equivalent, role_grants_full_access, invite_never_claimed, allowed_project_ids
from app import models, supabase_storage
from app.models import (
    Company, CompanyBranch, ApprovalRule, CompanyFile, CompanyRole, CompanyTeam,
    CompanyPayrollSettings, SalaryTemplate, PdfTemplate, CompanyTerms, User,
)
from app.permissions import (
    DEFAULT_ROLE_PRESETS,
    validate_permissions,
    default_view_permissions,
)
from app.approvals import APPROVAL_FEATURE_TYPES

router = APIRouter(prefix="/settings", tags=["Settings & Configurations"], dependencies=[Depends(get_current_user)])


# ─── Pydantic Schemas ────────────────────────────────────────────────────────

_GSTIN_RE = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")
_GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def _gstin_checksum_ok(gstin: str) -> bool:
    total = 0
    factor = 2
    for ch in reversed(gstin[:14]):
        val = _GSTIN_CHARS.index(ch)
        product = factor * val
        total += (product // 36) + (product % 36)
        factor = 1 if factor == 2 else 2
    return _GSTIN_CHARS[(36 - (total % 36)) % 36] == gstin[14]


def _validate_gstin(cls, v):
    if v is None:
        return v
    v = v.strip()
    if not v:
        return v
    if not _GSTIN_RE.fullmatch(v):
        raise ValueError("GSTIN must match the 15-character format NNAAAAANNNNANAN")
    if not _gstin_checksum_ok(v):
        raise ValueError("GSTIN check digit is invalid")
    return v


class CompanySettingsResponse(BaseModel):
    id: uuid.UUID
    name: str
    legal_business_name: Optional[str]
    gstin: Optional[str]
    billing_address: Optional[str]
    currency_decimal_places: int
    quantity_decimal_places: int
    back_dated_limit_days: int
    negative_stock_lock: bool
    bom_restriction: bool
    po_restriction: bool
    material_request_restriction: bool
    negative_balance_warning: bool
    custom_pdf_template_enabled: bool
    document_company_name_display: str = "company"
    google_sheets_auth_phone: Optional[str]
    google_sheets_enabled: bool = False
    google_sheets_authorized_phones: Optional[List[str]] = None
    subscription_plan: Optional[str] = None
    subscription_start: Optional[datetime] = None
    subscription_end: Optional[datetime] = None
    subscription_renewal: Optional[datetime] = None
    phone: Optional[str] = None
    business_segment: Optional[str] = None
    company_size: Optional[str] = None
    construction_types: Optional[List[str]] = None
    weekly_off: Optional[str] = None
    weekly_off_days: Optional[List[str]] = None
    restrict_entry_creation_enabled: Optional[bool] = None
    restrict_entry_creation_days: Optional[int] = None
    restrict_entry_editing_enabled: Optional[bool] = None
    restrict_entry_editing_days: Optional[int] = None
    restrict_progress_over_estimate: Optional[bool] = None
    pretax_deduction_retention: Optional[bool] = None
    restrict_subcon_material_issue: Optional[bool] = None
    restrict_material_transfer: Optional[bool] = None
    restrict_production_material: Optional[bool] = None
    grn_numbering: Optional[str] = None
    logo_url: Optional[str] = None
    signature_url: Optional[str] = None
    stamp_url: Optional[str] = None
    watermark_url: Optional[str] = None
    onboarding_segment: Optional[str] = None
    onboarding_categories: Optional[str] = None
    onboarding_city: Optional[str] = None
    onboarding_completed: bool = False
    is_zatca_enable: bool = False
    vat_number: Optional[str] = None
    # D2: zero-attendance payroll policy, default OFF
    assume_full_month_when_no_attendance: Optional[bool] = None
    # CD-4: EPF wage ceiling, default 15000
    pf_wage_ceiling: Optional[float] = None

    class Config:
        from_attributes = True


class CompanySettingsUpdate(BaseModel):
    name: Optional[str] = None
    legal_business_name: Optional[str] = None
    gstin: Optional[str] = None
    vat_number: Optional[str] = None
    is_zatca_enable: Optional[bool] = None
    phone: Optional[str] = None
    billing_address: Optional[str] = None
    business_segment: Optional[str] = None
    company_size: Optional[str] = None
    construction_types: Optional[List[str]] = None
    weekly_off: Optional[str] = None
    weekly_off_days: Optional[List[str]] = None
    restrict_entry_creation_enabled: Optional[bool] = None
    restrict_entry_creation_days: Optional[int] = Field(None, ge=0)
    restrict_entry_editing_enabled: Optional[bool] = None
    restrict_entry_editing_days: Optional[int] = Field(None, ge=0)
    restrict_progress_over_estimate: Optional[bool] = None
    pretax_deduction_retention: Optional[bool] = None
    restrict_subcon_material_issue: Optional[bool] = None
    restrict_material_transfer: Optional[bool] = None
    restrict_production_material: Optional[bool] = None
    grn_numbering: Optional[Literal["Project Level", "Company Level"]] = None
    currency_decimal_places: Optional[int] = Field(None, ge=0, le=4)
    quantity_decimal_places: Optional[int] = Field(None, ge=0, le=4)
    back_dated_limit_days: Optional[int] = Field(None, ge=0)
    negative_stock_lock: Optional[bool] = None
    bom_restriction: Optional[bool] = None
    po_restriction: Optional[bool] = None
    material_request_restriction: Optional[bool] = None
    negative_balance_warning: Optional[bool] = None
    custom_pdf_template_enabled: Optional[bool] = None
    document_company_name_display: Optional[Literal["company", "branch"]] = None
    google_sheets_auth_phone: Optional[str] = None
    google_sheets_enabled: Optional[bool] = None
    google_sheets_authorized_phones: Optional[List[str]] = None
    subscription_plan: Optional[str] = None
    subscription_start: Optional[datetime] = None
    subscription_end: Optional[datetime] = None
    subscription_renewal: Optional[datetime] = None
    assume_full_month_when_no_attendance: Optional[bool] = None
    pf_wage_ceiling: Optional[float] = Field(None, ge=0)

    _check_gstin = field_validator("gstin")(_validate_gstin)


class BranchCreate(BaseModel):
    branch_name: str
    gstin: str = Field(..., pattern=r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")
    billing_address: str
    geo_location: Optional[str] = None
    address_line1: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    zip: Optional[str] = None
    country: str = "India"

    _check_gstin = field_validator("gstin")(_validate_gstin)


class BranchResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    branch_name: str
    gstin: str
    billing_address: str
    is_primary: bool = False
    geo_location: Optional[str] = None
    address_line1: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    zip: Optional[str] = None
    country: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


class ApprovalRuleCreate(BaseModel):
    # R2-179: derived from APPROVAL_FEATURE_TYPES in app/approvals.py - an
    # unknown label is now rejected here (422) at creation/update time instead
    # of being stored under a string no enforcement site will ever match.
    feature_type: Literal[tuple(APPROVAL_FEATURE_TYPES)]
    min_amount: float = Field(..., ge=0)
    max_amount: Optional[float] = Field(None, ge=0)
    levels: int = Field(..., ge=1)
    approvers: str

    @model_validator(mode="after")
    def _check_amount_band(self):
        if self.max_amount is not None and self.max_amount <= self.min_amount:
            raise ValueError("max_amount must be greater than min_amount")
        return self


class ApprovalRuleResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    feature_type: str
    min_amount: float
    max_amount: Optional[float]
    levels: int
    approvers: str
    created_at: datetime

    class Config:
        from_attributes = True


class RoleCreate(BaseModel):
    role_name: str
    # Optional initial permission dict (validated against the taxonomy). When
    # omitted a new custom role defaults to read-only across every module.
    permissions: Optional[dict] = None


class RolePermissionsUpdate(BaseModel):
    permissions: dict


class RoleResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    role_name: str
    permissions: Optional[dict] = None
    created_at: datetime

    class Config:
        from_attributes = True


# Default flat roles seeded on demand (no permission matrix in this build).
# Verbatim from the Setting-tab reconciliation — do not reword.
DEFAULT_ROLES = [
    "Admin",
    "Client",
    "Accountant",
    "Sub Contractor",
    "Associate HR",
    "Project partner",
    "Site Engineer",
    "Manager",
    "Supervisor",
    "Viewer",
]


# ─── Endpoints ───────────────────────────────────────────────────────────────

@router.get("/company/{company_id}", response_model=CompanySettingsResponse)
def get_company_settings(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    company = db.query(Company).filter(Company.id == company_id).first()
    if not company:
        raise HTTPException(status_code=404, detail="Company not found")

    base = f"/settings/company-file/{company_id}"
    existing = {f.asset_type: True for f in db.query(CompanyFile).filter(CompanyFile.company_id == company_id).all()}
    data = CompanySettingsResponse.model_validate(company)
    data.logo_url = f"{base}/logo" if existing.get("logo") else None
    data.signature_url = f"{base}/signature" if existing.get("signature") else None
    data.stamp_url = f"{base}/stamp" if existing.get("stamp") else None
    data.watermark_url = f"{base}/watermark" if existing.get("watermark") else None
    return data


@router.put("/company/{company_id}", response_model=CompanySettingsResponse)
def update_company_settings(company_id: uuid.UUID, settings_data: CompanySettingsUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user), _: None = Depends(verify_company_access)):
    require_permission(db, current_user, company_id, "settings:manage")
    company = db.query(Company).filter(Company.id == company_id).first()
    if not company:
        raise HTTPException(status_code=404, detail="Company not found")

    for field, val in settings_data.model_dump(exclude_unset=True).items():
        setattr(company, field, val)

    db.commit()
    db.refresh(company)

    base = f"/settings/company-file/{company_id}"
    existing = {f.asset_type: True for f in db.query(CompanyFile).filter(CompanyFile.company_id == company_id).all()}
    data = CompanySettingsResponse.model_validate(company)
    data.logo_url = f"{base}/logo" if existing.get("logo") else None
    data.signature_url = f"{base}/signature" if existing.get("signature") else None
    data.stamp_url = f"{base}/stamp" if existing.get("stamp") else None
    data.watermark_url = f"{base}/watermark" if existing.get("watermark") else None
    return data


@router.get("/branches/{company_id}", response_model=List[BranchResponse])
def list_branches(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    return db.query(CompanyBranch).filter(CompanyBranch.company_id == company_id).all()


@router.post("/branches/{company_id}", response_model=BranchResponse)
def create_branch(company_id: uuid.UUID, branch_data: BranchCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user), _: None = Depends(verify_company_access)):
    require_permission(db, current_user, company_id, "settings:manage")
    existing_count = db.query(CompanyBranch).filter(CompanyBranch.company_id == company_id).count()
    new_branch = CompanyBranch(
        company_id=company_id,
        branch_name=branch_data.branch_name,
        gstin=branch_data.gstin,
        billing_address=branch_data.billing_address,
        is_primary=(existing_count == 0),
        geo_location=branch_data.geo_location,
        address_line1=branch_data.address_line1,
        city=branch_data.city,
        state=branch_data.state,
        zip=branch_data.zip,
        country=branch_data.country,
    )
    db.add(new_branch)
    db.commit()
    db.refresh(new_branch)
    return new_branch


@router.patch("/branches/{branch_id}/primary", response_model=BranchResponse)
def set_primary_branch(branch_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    branch = db.query(CompanyBranch).filter(CompanyBranch.id == branch_id).first()
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")
    get_company_membership(db, current_user, branch.company_id)
    require_permission(db, current_user, branch.company_id, "settings:manage")
    db.query(CompanyBranch).filter(CompanyBranch.company_id == branch.company_id).update({"is_primary": False})
    branch.is_primary = True
    db.commit()
    db.refresh(branch)
    return branch


@router.delete("/branches/{branch_id}")
def delete_branch(branch_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    branch = db.query(CompanyBranch).filter(CompanyBranch.id == branch_id).first()
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")
    get_company_membership(db, current_user, branch.company_id)
    require_permission(db, current_user, branch.company_id, "settings:manage")
    if branch.is_primary:
        other = db.query(CompanyBranch).filter(CompanyBranch.company_id == branch.company_id, CompanyBranch.id != branch_id).first()
        if other:
            other.is_primary = True
    from app.routers.delete_logs import log_deletion
    log_deletion(db, branch.company_id, "branch", branch.id, f"Branch: {branch.branch_name}", deleted_by=current_user.name)
    db.delete(branch)
    db.commit()
    return {"success": True}


@router.get("/approval-rules/{company_id}", response_model=List[ApprovalRuleResponse])
def list_approval_rules(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    return db.query(ApprovalRule).filter(ApprovalRule.company_id == company_id).all()


def _validate_rule_approvers(db: Session, company_id: uuid.UUID, approvers: str) -> None:
    members = (
        db.query(CompanyTeam, User)
        .join(User, User.id == CompanyTeam.user_id)
        .filter(CompanyTeam.company_id == company_id)
        .all()
    )
    known = set()
    for team_row, member_user in members:
        if member_user.email:
            known.add(member_user.email.strip().lower())
        if member_user.name:
            known.add(member_user.name.strip().lower())
        known.add(str(team_row.id).lower())
    unknown = [
        raw.strip()
        for raw in (approvers or "").split(",")
        if raw.strip() and raw.strip().lower() not in known
    ]
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown approver(s): {', '.join(unknown)}. Approvers must be team members of this company (email or name).",
        )


def _reject_overlapping_band(db: Session, company_id: uuid.UUID, feature_type: str, min_amount: float, max_amount: Optional[float], exclude_id=None) -> None:
    query = db.query(ApprovalRule).filter(
        ApprovalRule.company_id == company_id,
        ApprovalRule.feature_type == feature_type,
    )
    if exclude_id is not None:
        query = query.filter(ApprovalRule.id != exclude_id)
    for existing in query.all():
        existing_min = existing.min_amount or 0
        existing_max = existing.max_amount
        if (existing_max is None or min_amount <= existing_max) and (max_amount is None or existing_min <= max_amount):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"The amount band overlaps an existing {feature_type} approval rule",
            )


@router.post("/approval-rules/{company_id}", response_model=ApprovalRuleResponse)
def create_approval_rule(company_id: uuid.UUID, rule_data: ApprovalRuleCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user), _: None = Depends(verify_company_access)):
    require_permission(db, current_user, company_id, "settings:manage")
    _validate_rule_approvers(db, company_id, rule_data.approvers)
    _reject_overlapping_band(db, company_id, rule_data.feature_type, rule_data.min_amount, rule_data.max_amount)
    new_rule = ApprovalRule(
        company_id=company_id,
        feature_type=rule_data.feature_type,
        min_amount=rule_data.min_amount,
        max_amount=rule_data.max_amount,
        levels=rule_data.levels,
        approvers=rule_data.approvers
    )
    db.add(new_rule)
    db.commit()
    db.refresh(new_rule)
    return new_rule


@router.put("/approval-rules/{rule_id}", response_model=ApprovalRuleResponse)
def update_approval_rule(rule_id: uuid.UUID, rule_data: ApprovalRuleCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    rule = db.query(ApprovalRule).filter(ApprovalRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Approval rule not found")
    get_company_membership(db, current_user, rule.company_id)
    require_permission(db, current_user, rule.company_id, "settings:manage")
    _validate_rule_approvers(db, rule.company_id, rule_data.approvers)
    _reject_overlapping_band(db, rule.company_id, rule_data.feature_type, rule_data.min_amount, rule_data.max_amount, exclude_id=rule.id)
    for field, val in rule_data.model_dump(exclude_unset=True).items():
        setattr(rule, field, val)
    db.commit()
    db.refresh(rule)
    return rule


@router.delete("/approval-rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_approval_rule(rule_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    rule = db.query(ApprovalRule).filter(ApprovalRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Approval rule not found")
    get_company_membership(db, current_user, rule.company_id)
    require_permission(db, current_user, rule.company_id, "settings:manage")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, rule.company_id, "approval_rule", rule.id, f"Approval Rule: {rule.feature_type}", deleted_by=current_user.name)
    db.delete(rule)
    db.commit()

@router.get("/roles/{company_id}", response_model=List[RoleResponse])
def list_roles(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    return db.query(CompanyRole).filter(CompanyRole.company_id == company_id).order_by(CompanyRole.created_at).all()


@router.post("/roles/{company_id}", response_model=RoleResponse)
def create_role(company_id: uuid.UUID, role_data: RoleCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user), _: None = Depends(verify_company_access)):
    require_permission(db, current_user, company_id, "settings:manage")
    name = role_data.role_name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Role name is required")
    existing = db.query(CompanyRole).filter(
        CompanyRole.company_id == company_id, CompanyRole.role_name.ilike(name)
    ).first()
    if existing:
        raise HTTPException(status_code=409, detail="Role already exists")
    if role_data.permissions is not None:
        try:
            perms = validate_permissions(role_data.permissions)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
    else:
        perms = default_view_permissions()
    role = CompanyRole(company_id=company_id, role_name=name, permissions=perms)
    db.add(role)
    db.commit()
    db.refresh(role)
    return role


@router.post("/roles/seed/{company_id}", response_model=List[RoleResponse])
def seed_default_roles(company_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user), _: None = Depends(verify_company_access)):
    require_permission(db, current_user, company_id, "settings:manage")
    # Every company is born with an Owner role, so "no roles yet" never happens.
    # Add whichever standard roles are missing and leave existing ones untouched.
    existing = {
        (r.role_name or "").strip().lower()
        for r in db.query(CompanyRole).filter(CompanyRole.company_id == company_id).all()
    }
    missing = [name for name in DEFAULT_ROLES if name.lower() not in existing]
    if not missing:
        raise HTTPException(status_code=409, detail="The standard roles are already added for this company")
    created = []
    for name in missing:
        # Seed with the real preset (not {}); fall back to read-only for any
        # role name without a preset.
        preset = DEFAULT_ROLE_PRESETS.get(name, default_view_permissions())
        role = CompanyRole(company_id=company_id, role_name=name, permissions=preset)
        db.add(role)
        created.append(role)
    db.commit()
    for role in created:
        db.refresh(role)
    return created


def _load_role_and_verify_access(
    role_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CompanyRole:
    """Resolve a role by id and verify the caller belongs to its company.

    Mirrors the `verify_company_access` dependency but resolves the company via
    the role's own `company_id` (the path carries `role_id`, not `company_id`).
    """
    role = db.query(CompanyRole).filter(CompanyRole.id == role_id).first()
    if not role:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Role not found")
    get_company_membership(db, current_user, role.company_id)
    return role


# Locked roles must keep full access; never allow them to be restricted.
_LOCKED_ROLES = {"Owner", "Admin"}


@router.put("/roles/{role_id}/permissions", response_model=RoleResponse)
def update_role_permissions(
    role: CompanyRole = Depends(_load_role_and_verify_access),
    payload: RolePermissionsUpdate = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Replace a role's permission set.

    - Keys are validated against the canonical taxonomy; unknown keys are 400'd.
    - Owner / Admin are locked to full access (`all=true`) so they can never be
      locked out (failsafe).
    """
    require_permission(db, current_user, role.company_id, "settings:manage")
    if payload is None:
        raise HTTPException(status_code=400, detail="permissions body is required")
    if not payload.permissions:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="permissions cannot be empty; deny-all must be an explicit all-false matrix",
        )
    if role.role_name in _LOCKED_ROLES and not payload.permissions.get("all"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"The {role.role_name} role must retain full access (all=true) and cannot be restricted.",
        )
    membership = get_company_membership(db, current_user, role.company_id)
    caller_role_perms: dict = {}
    if membership.role_id is not None:
        caller_role = db.query(CompanyRole).filter(CompanyRole.id == membership.role_id).first()
        if caller_role is not None:
            caller_role_perms = caller_role.permissions or {}
    owner_equivalent = membership.priority_type == "partner" or caller_role_perms.get("all") is True
    if "all" in payload.permissions and not owner_equivalent:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only owner-equivalent members may grant the all superuser flag",
        )
    try:
        normalized = validate_permissions(payload.permissions)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    role.permissions = normalized
    db.commit()
    db.refresh(role)
    return role


@router.delete("/roles/{role_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_role(
    role: CompanyRole = Depends(_load_role_and_verify_access),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a custom (non-default) role that is not assigned to any member."""
    require_permission(db, current_user, role.company_id, "settings:manage")
    if role.role_name in DEFAULT_ROLES or role.role_name in _LOCKED_ROLES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Built-in roles cannot be deleted",
        )
    assigned = (
        db.query(CompanyTeam).filter(CompanyTeam.role_id == role.id).first()
    )
    if assigned:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Role is assigned to members and cannot be deleted",
        )
    db.delete(role)
    db.commit()


# ─── Company team members (RBAC role assignment) ────────────────────────────
# Phase 3 frontend surface: list members with their current role and (re)assign
# a role. Both endpoints require `team:manage`; partners / superusers always pass
# via the failsafe in `require_permission`.

class TeamMemberResponse(BaseModel):
    id: uuid.UUID
    name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    role_id: Optional[uuid.UUID] = None
    role_name: Optional[str] = None
    priority_type: str
    # Invited but has not yet set a password with the emailed code.
    invite_pending: bool = False
    is_me: bool = False
    # "all": every project. "assigned": only project_ids. Owners and full-access
    # roles always see every project, so full_access says the choice is moot.
    project_scope: str = "all"
    project_ids: List[uuid.UUID] = []
    full_access: bool = False

    class Config:
        from_attributes = True


def _invite_pending(user: Optional[User]) -> bool:
    return invite_never_claimed(user)


class TeamMemberRoleUpdate(BaseModel):
    role_id: Optional[uuid.UUID] = None


class TeamMemberProjectsUpdate(BaseModel):
    scope: Literal["all", "assigned"]
    project_ids: List[uuid.UUID] = []


def _member_projects(db: Session, member: CompanyTeam) -> dict:
    ids = [r[0] for r in db.query(models.ProjectMember.project_id).filter(
        models.ProjectMember.company_team_id == member.id
    ).all()]
    return {
        "project_scope": member.project_scope or "all",
        "project_ids": ids,
        "full_access": is_owner_equivalent(db, member),
    }


@router.get("/team/{company_id}", response_model=List[TeamMemberResponse])
def list_team_members(
    company_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    _: None = Depends(verify_company_access),
):
    """List every CompanyTeam member of `company_id` with their assigned role."""
    require_permission(db, current_user, company_id, "team:manage")
    rows = (
        db.query(CompanyTeam, User, CompanyRole)
        .join(User, User.id == CompanyTeam.user_id)
        .outerjoin(CompanyRole, CompanyRole.id == CompanyTeam.role_id)
        .filter(CompanyTeam.company_id == company_id)
        .order_by(User.name)
        .all()
    )
    return [
        TeamMemberResponse(
            id=t.id,
            name=u.name,
            email=u.email,
            phone=u.mobile,
            role_id=t.role_id,
            role_name=r.role_name if r else None,
            priority_type=t.priority_type,
            invite_pending=_invite_pending(u),
            is_me=u.id == current_user.id,
            **_member_projects(db, t),
        )
        for t, u, r in rows
    ]


@router.put("/team/{member_id}/role", response_model=TeamMemberResponse)
def assign_member_role(
    member_id: uuid.UUID,
    payload: TeamMemberRoleUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Assign (or clear) a CompanyRole on a team member.

    The target role must belong to the same company as the member (cross-company
    role assignment is rejected). Partners keep their `priority_type` regardless of
    the chosen role, so this can never lock an owner out.
    """
    member = db.query(CompanyTeam).filter(CompanyTeam.id == member_id).first()
    if not member:
        raise HTTPException(status_code=404, detail="Team member not found")
    caller = get_company_membership(db, current_user, member.company_id)
    require_permission(db, current_user, member.company_id, "team:manage")
    caller_is_owner = is_owner_equivalent(db, caller)

    current_role = (
        db.query(CompanyRole).filter(CompanyRole.id == member.role_id).first()
        if member.role_id else None
    )
    # Full access is handed out, or taken away, only by an owner-equivalent
    # member. Otherwise a Manager could promote themselves to Admin.
    if role_grants_full_access(current_role) and not caller_is_owner:
        raise HTTPException(
            status_code=403,
            detail="Only the owner or an admin can change the role of someone with full access.",
        )

    if payload.role_id is not None:
        role = db.query(CompanyRole).filter(CompanyRole.id == payload.role_id).first()
        if not role:
            raise HTTPException(status_code=404, detail="Role not found")
        if role.company_id != member.company_id:
            raise HTTPException(
                status_code=400,
                detail="Role does not belong to this company",
            )
        if role_grants_full_access(role) and not caller_is_owner:
            raise HTTPException(
                status_code=403,
                detail="Only the owner or an admin can give someone full access.",
            )
        member.role_id = role.id
    else:
        # A member with no role is not limited at all, so only the owner's own
        # partner seat may go without one.
        if member.priority_type != "partner":
            raise HTTPException(status_code=400, detail="Pick a role for this member.")
        member.role_id = None

    db.commit()
    role = (
        db.query(CompanyRole).filter(CompanyRole.id == member.role_id).first()
        if member.role_id else None
    )
    # R2-390: resolve the member's user once and never crash after the commit —
    # this endpoint must answer 200 with the new role even when the backing
    # user row has gone, instead of committing the change and returning 500.
    user = db.query(User).filter(User.id == member.user_id).first()
    return TeamMemberResponse(
        id=member.id,
        name=user.name if user else "Unknown member",
        email=user.email if user else None,
        phone=user.mobile if user else None,
        role_id=member.role_id,
        role_name=role.role_name if role else None,
        priority_type=member.priority_type,
        invite_pending=_invite_pending(user),
        is_me=bool(user is not None and user.id == current_user.id),
        **_member_projects(db, member),
    )


@router.put("/team/{member_id}/projects", response_model=TeamMemberResponse)
def set_member_projects(
    member_id: uuid.UUID,
    payload: TeamMemberProjectsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Let a member see every project, or only the ones picked here."""
    member = db.query(CompanyTeam).filter(CompanyTeam.id == member_id).first()
    if not member or member.user_id is None:
        raise HTTPException(status_code=404, detail="Team member not found")
    caller = get_company_membership(db, current_user, member.company_id)
    require_permission(db, current_user, member.company_id, "team:manage")
    # Someone limited to a few projects could otherwise hand themselves the rest.
    if allowed_project_ids(db, caller) is not None:
        raise HTTPException(
            status_code=403,
            detail="Only someone who can see every project can choose projects for others.",
        )
    if is_owner_equivalent(db, member):
        raise HTTPException(
            status_code=400,
            detail="The owner and people with full access always see every project.",
        )
    wanted = set(payload.project_ids)
    if payload.scope == "assigned":
        if not wanted:
            raise HTTPException(status_code=400, detail="Pick at least one project.")
        found = {r[0] for r in db.query(models.Project.id).filter(
            models.Project.id.in_(list(wanted)),
            models.Project.company_id == member.company_id,
        ).all()}
        if found != wanted:
            raise HTTPException(status_code=400, detail="One of those projects is not in this company.")
    current = {r[0] for r in db.query(models.ProjectMember.project_id).filter(
        models.ProjectMember.company_team_id == member.id
    ).all()}
    if payload.scope == "assigned":
        for pid in wanted - current:
            db.add(models.ProjectMember(project_id=pid, company_team_id=member.id))
        stale = current - wanted
        if stale:
            db.query(models.ProjectMember).filter(
                models.ProjectMember.company_team_id == member.id,
                models.ProjectMember.project_id.in_(list(stale)),
            ).delete(synchronize_session=False)
    member.project_scope = payload.scope
    db.commit()
    user = db.query(User).filter(User.id == member.user_id).first()
    role = db.query(CompanyRole).filter(CompanyRole.id == member.role_id).first() if member.role_id else None
    return TeamMemberResponse(
        id=member.id,
        name=user.name if user else "Unknown member",
        email=user.email if user else None,
        phone=user.mobile if user else None,
        role_id=member.role_id,
        role_name=role.role_name if role else None,
        priority_type=member.priority_type,
        invite_pending=_invite_pending(user),
        is_me=bool(user is not None and user.id == current_user.id),
        **_member_projects(db, member),
    )


@router.delete("/team/{member_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_team_member(
    member_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Take someone out of the company. Their login stays (they may belong to
    other companies); they simply stop seeing this one.

    The team row is unlinked from the login rather than deleted: approvals,
    stock receipts and other records point at it, and a delete would either
    fail on those references or cascade away real history. Every access check
    looks the member up by login, so an unlinked row grants nothing."""
    member = db.query(CompanyTeam).filter(CompanyTeam.id == member_id).first()
    if not member:
        raise HTTPException(status_code=404, detail="Team member not found")
    caller = get_company_membership(db, current_user, member.company_id)
    require_permission(db, current_user, member.company_id, "team:manage")
    if member.user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot remove yourself from the company.")
    if member.priority_type == "partner":
        raise HTTPException(status_code=400, detail="The company owner cannot be removed.")
    role = db.query(CompanyRole).filter(CompanyRole.id == member.role_id).first() if member.role_id else None
    if role_grants_full_access(role) and not is_owner_equivalent(db, caller):
        raise HTTPException(
            status_code=403,
            detail="Only the owner or an admin can remove someone with full access.",
        )
    db.query(models.ProjectMember).filter(models.ProjectMember.company_team_id == member.id).delete(
        synchronize_session=False
    )
    user = db.query(User).filter(User.id == member.user_id).first()
    from app.routers.delete_logs import log_deletion
    log_deletion(
        db, member.company_id, "team_member", member.id,
        f"Team member: {user.name if user else 'Unknown'} ({role.role_name if role else 'no role'})",
        deleted_by=current_user.name,
    )
    member.user_id = None
    member.role_id = None
    member.priority_type = "removed"
    db.commit()


# ─── Payroll Settings (company-level default statutory rates) ───────────────

class PayrollSettingsResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    pf_employee_pct: float
    pf_employer_pct: float
    esi_employee_pct: float
    esi_employer_pct: float
    tds_monthly: float
    is_esi_applicable: bool
    pf_wage_ceiling: Optional[float] = 15000.0
    assume_full_month_when_no_attendance: Optional[bool] = False

    class Config:
        from_attributes = True


class PayrollSettingsUpdate(BaseModel):
    pf_employee_pct: Optional[float] = Field(None, ge=0, le=12)
    pf_employer_pct: Optional[float] = Field(None, ge=0, le=12)
    esi_employee_pct: Optional[float] = Field(None, ge=0, le=1)
    esi_employer_pct: Optional[float] = Field(None, ge=0, le=5)
    tds_monthly: Optional[float] = Field(None, ge=0)
    is_esi_applicable: Optional[bool] = None
    pf_wage_ceiling: Optional[float] = Field(None, ge=0)
    assume_full_month_when_no_attendance: Optional[bool] = None
    confirm_changes: bool = False


def _get_or_create_payroll_settings(company_id: uuid.UUID, db: Session):
    row = db.query(CompanyPayrollSettings).filter(CompanyPayrollSettings.company_id == company_id).first()
    if not row:
        row = CompanyPayrollSettings(company_id=company_id)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


@router.get("/payroll/{company_id}", response_model=PayrollSettingsResponse)
def get_payroll_settings(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    row = _get_or_create_payroll_settings(company_id, db)
    comp = db.query(models.Company).filter(models.Company.id == company_id).first()
    res = PayrollSettingsResponse.model_validate(row)
    res.assume_full_month_when_no_attendance = bool(comp.assume_full_month_when_no_attendance) if comp else False
    if res.pf_wage_ceiling is None:
        res.pf_wage_ceiling = float(comp.pf_wage_ceiling) if comp and comp.pf_wage_ceiling else 15000.0
    return res


@router.put("/payroll/{company_id}", response_model=PayrollSettingsResponse)
def update_payroll_settings(company_id: uuid.UUID, payload: PayrollSettingsUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user), _: None = Depends(verify_company_access)):
    require_permission(db, current_user, company_id, "settings:manage")
    changes = payload.model_dump(exclude_unset=True)
    changes.pop("confirm_changes", None)
    if changes and not payload.confirm_changes:
        raise HTTPException(status_code=400, detail="confirm_changes must be true to modify statutory payroll rates")
    row = _get_or_create_payroll_settings(company_id, db)
    assume_full = changes.pop("assume_full_month_when_no_attendance", None)
    if assume_full is not None:
        comp = db.query(models.Company).filter(models.Company.id == company_id).first()
        if comp:
            comp.assume_full_month_when_no_attendance = assume_full
    for field, val in changes.items():
        setattr(row, field, val)
    if "pf_wage_ceiling" in changes and changes["pf_wage_ceiling"] is not None:
        comp = db.query(models.Company).filter(models.Company.id == company_id).first()
        if comp:
            comp.pf_wage_ceiling = Decimal(str(changes["pf_wage_ceiling"]))
    db.commit()
    db.refresh(row)
    comp = db.query(models.Company).filter(models.Company.id == company_id).first()
    res = PayrollSettingsResponse.model_validate(row)
    res.assume_full_month_when_no_attendance = bool(comp.assume_full_month_when_no_attendance) if comp else False
    if res.pf_wage_ceiling is None:
        res.pf_wage_ceiling = float(comp.pf_wage_ceiling) if comp and comp.pf_wage_ceiling else 15000.0
    return res


# ─── Salary Templates (reusable named salary breakup cascade) ────────────────

class SalaryTemplateResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    name: str
    description: Optional[str] = None
    status: str
    breakup: dict
    created_at: datetime

    class Config:
        from_attributes = True


def _validate_salary_breakup(cls, v):
    if not v:
        return v
    if all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in v.values()):
        if abs(sum(v.values()) - 100) > 0.01:
            raise ValueError("breakup components must sum to 100")
    pct = v.get("basic_pct")
    if isinstance(pct, (int, float)) and not (0 <= pct <= 100):
        raise ValueError("basic_pct must be between 0 and 100")
    return v


class SalaryTemplateCreate(BaseModel):
    name: str
    description: Optional[str] = None
    status: Optional[Literal["Active", "Inactive"]] = "Active"
    breakup: dict

    _validate_breakup = field_validator("breakup")(_validate_salary_breakup)


class SalaryTemplateUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    status: Optional[Literal["Active", "Inactive"]] = None
    breakup: Optional[dict] = None

    _validate_breakup = field_validator("breakup")(_validate_salary_breakup)


@router.get("/salary-templates/{company_id}", response_model=List[SalaryTemplateResponse])
def list_salary_templates(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    return db.query(SalaryTemplate).filter(SalaryTemplate.company_id == company_id).order_by(SalaryTemplate.name).all()


@router.post("/salary-templates/{company_id}", response_model=SalaryTemplateResponse, status_code=status.HTTP_201_CREATED)
def create_salary_template(company_id: uuid.UUID, payload: SalaryTemplateCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user), _: None = Depends(verify_company_access)):
    require_permission(db, current_user, company_id, "settings:manage")
    data = payload.model_dump()
    data["breakup"] = payload.breakup
    obj = SalaryTemplate(company_id=company_id, **data)
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


@router.put("/salary-templates/{template_id}", response_model=SalaryTemplateResponse)
def update_salary_template(template_id: uuid.UUID, payload: SalaryTemplateUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    obj = db.query(SalaryTemplate).filter(SalaryTemplate.id == template_id).first()
    if not obj:
        raise HTTPException(status_code=404, detail="Salary template not found")
    get_company_membership(db, current_user, obj.company_id)
    require_permission(db, current_user, obj.company_id, "settings:manage")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(obj, k, v)
    db.commit()
    db.refresh(obj)
    return obj


@router.delete("/salary-templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_salary_template(template_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    obj = db.query(SalaryTemplate).filter(SalaryTemplate.id == template_id).first()
    if not obj:
        raise HTTPException(status_code=404, detail="Salary template not found")
    get_company_membership(db, current_user, obj.company_id)
    require_permission(db, current_user, obj.company_id, "data:delete")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, obj.company_id, "salary_template", obj.id, f"Salary Template: {obj.name}", deleted_by=current_user.name)
    db.delete(obj)
    db.commit()


# ─── Company Branding Files (Logo / Signature / Stamp / Watermark) ────────────

ALLOWED_ASSET_TYPES = {"logo", "signature", "stamp", "watermark"}

# Branding assets are embedded as PNG/JPEG images in generated PDFs (R2-404),
# so only bytes carrying one of those signatures are accepted (R2-614).
BRANDING_IMAGE_SIGNATURES = (
    b"\x89PNG\r\n\x1a\n",  # PNG
    b"\xff\xd8\xff",       # JPEG
)

# Branding slots hold small images; keep them well under the general
# project-file cap (files.py allows 50 MB for documents/CAD).
MAX_BRANDING_FILE_BYTES = 5 * 1024 * 1024  # 5 MB


@router.post("/company-file/{company_id}")
async def upload_company_file(
    company_id: uuid.UUID,
    asset_type: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    _: None = Depends(verify_company_access),
):
    require_permission(db, current_user, company_id, "settings:manage")
    if asset_type not in ALLOWED_ASSET_TYPES:
        raise HTTPException(status_code=400, detail="Invalid asset type")
    company = db.query(Company).filter(Company.id == company_id).first()
    if not company:
        raise HTTPException(status_code=404, detail="Company not found")

    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(contents) > MAX_BRANDING_FILE_BYTES:
        raise HTTPException(
            status_code=422,
            detail=f"Branding file exceeds the {MAX_BRANDING_FILE_BYTES // (1024 * 1024)} MB upload limit",
        )
    if not contents.startswith(BRANDING_IMAGE_SIGNATURES):
        raise HTTPException(
            status_code=422,
            detail="Branding files must be a valid PNG or JPEG image",
        )

    filename = file.filename or asset_type
    content_type = file.content_type or "application/octet-stream"
    storage_path = None
    data = None

    if supabase_storage.is_storage_configured():
        storage_path = f"{company_id}/{asset_type}"
        supabase_storage.upload_bytes(
            supabase_storage.BUCKET_COMPANY_FILES, storage_path, contents, content_type
        )
    else:
        # Local-dev fallback: keep the bytes in the DB column.
        data = contents

    db.query(CompanyFile).filter(
        CompanyFile.company_id == company_id, CompanyFile.asset_type == asset_type
    ).delete()

    cf = CompanyFile(
        company_id=company_id,
        asset_type=asset_type,
        filename=filename,
        content_type=content_type,
        storage_path=storage_path,
        data=data,
    )
    db.add(cf)
    db.commit()
    db.refresh(cf)
    return {"id": str(cf.id), "asset_type": asset_type}


@router.get("/company-file/{company_id}/{asset_type}")
def get_company_file(company_id: uuid.UUID, asset_type: str, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    if asset_type not in ALLOWED_ASSET_TYPES:
        raise HTTPException(status_code=400, detail="Invalid asset type")
    cf = (
        db.query(CompanyFile)
        .filter(CompanyFile.company_id == company_id, CompanyFile.asset_type == asset_type)
        .order_by(CompanyFile.created_at.desc())
        .first()
    )
    if not cf:
        raise HTTPException(status_code=404, detail="Not found")

    # Prefer object storage; fall back to the DB BLOB for legacy rows.
    if cf.storage_path and supabase_storage.is_storage_configured():
        try:
            signed_url = supabase_storage.create_signed_url(
                supabase_storage.BUCKET_COMPANY_FILES, cf.storage_path
            )
            from fastapi.responses import RedirectResponse

            return RedirectResponse(url=signed_url, status_code=307)
        except Exception:
            # Storage unavailable or signed-URL failed: fall through to BLOB.
            pass

    if cf.data:
        media_type = cf.content_type or "application/octet-stream"
        return Response(
            content=cf.data,
            media_type=media_type,
            headers={
                "Content-Disposition": f'inline; filename="{cf.filename}"',
                "Content-Type": media_type,
                "Content-Length": str(len(cf.data)),
                "Cache-Control": "no-store",
            },
        )

    raise HTTPException(status_code=404, detail="Not found")


@router.delete("/company-file/{company_id}/{asset_type}", status_code=status.HTTP_204_NO_CONTENT)
def delete_company_file(
    company_id: uuid.UUID,
    asset_type: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    _: None = Depends(verify_company_access),
):
    require_permission(db, current_user, company_id, "settings:manage")
    if asset_type not in ALLOWED_ASSET_TYPES:
        raise HTTPException(status_code=400, detail="Invalid asset type")
    cf = (
        db.query(CompanyFile)
        .filter(CompanyFile.company_id == company_id, CompanyFile.asset_type == asset_type)
        .first()
    )
    if not cf:
        raise HTTPException(status_code=404, detail="Company file not found")

    if cf.storage_path and supabase_storage.is_storage_configured():
        try:
            supabase_storage.delete_file(supabase_storage.BUCKET_COMPANY_FILES, cf.storage_path)
        except Exception:
            pass

    db.delete(cf)
    db.commit()


# ─── Company Terms & Conditions (5 documents; central source of default T&C) ───

class CompanyTermsResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    invoice_terms: Optional[str] = None
    quotation_terms: Optional[str] = None
    subcon_terms: Optional[str] = None
    boq_terms: Optional[str] = None
    purchase_order_terms: Optional[str] = None
    updated_at: datetime

    class Config:
        from_attributes = True


class CompanyTermsUpdate(BaseModel):
    invoice_terms: Optional[str] = None
    quotation_terms: Optional[str] = None
    subcon_terms: Optional[str] = None
    boq_terms: Optional[str] = None
    purchase_order_terms: Optional[str] = None


def _get_or_create_company_terms(company_id: uuid.UUID, db: Session) -> CompanyTerms:
    row = db.query(CompanyTerms).filter(CompanyTerms.company_id == company_id).first()
    if not row:
        row = CompanyTerms(company_id=company_id)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


@router.get("/company-terms/{company_id}", response_model=CompanyTermsResponse)
def get_company_terms(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    row = _get_or_create_company_terms(company_id, db)
    return row


@router.put("/company-terms/{company_id}", response_model=CompanyTermsResponse)
def update_company_terms(company_id: uuid.UUID, payload: CompanyTermsUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user), _: None = Depends(verify_company_access)):
    require_permission(db, current_user, company_id, "settings:manage")
    row = _get_or_create_company_terms(company_id, db)
    for field, val in payload.model_dump(exclude_unset=True).items():
        setattr(row, field, val)
    db.commit()
    db.refresh(row)
    return row
