import uuid
from sqlalchemy import Column, String, ForeignKey, DateTime, Date, Integer, Boolean, Table, Numeric, Float, Text, BigInteger, LargeBinary, UniqueConstraint
from sqlalchemy.sql import func
from app.database import Base, engine

# Database-agnostic fallback for SQLite testing
if engine.url.drivername.startswith("sqlite"):
    import uuid as _uuid_mod
    from sqlalchemy import JSON
    from sqlalchemy.types import TypeDecorator

    class SQLiteUUID(TypeDecorator):
        """SQLite-safe UUID: stores as STRING(36), always reads back as uuid.UUID.

        SQLAlchemy's generic UUID result processor mis-handles UUID PK reads on
        SQLite (returns the value as a float), which 500s every row read. This
        type sidesteps that by serialising to a plain hyphenated string. Only used
        on SQLite; Postgres keeps its native UUID type.
        """
        impl = String(36)
        cache_ok = True

        def __init__(self, as_uuid=None, **kwargs):
            super().__init__()

        def process_bind_param(self, value, dialect):
            return str(value) if value is not None else None

        def process_result_value(self, value, dialect):
            if value is None:
                return None
            if isinstance(value, _uuid_mod.UUID):
                return value
            try:
                return _uuid_mod.UUID(str(value))
            except Exception:
                return value

    UUID = SQLiteUUID
    JSONB = JSON
else:
    from sqlalchemy.dialects.postgresql import UUID, JSONB

class Company(Base):
    __tablename__ = "companies"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(255), nullable=False)
    slug = Column(String(255), unique=True, index=True, nullable=True)
    parent_company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="SET NULL"), nullable=True, index=True)
    legal_business_name = Column(String(255))
    gstin = Column(String(15))
    phone = Column(String(20), nullable=True)
    billing_address = Column(String)
    currency_decimal_places = Column(Integer, default=2, nullable=False)
    quantity_decimal_places = Column(Integer, default=3, nullable=False)
    back_dated_limit_days = Column(Integer, default=7, nullable=False)
    negative_stock_lock = Column(Boolean, default=False, server_default="0", nullable=False)
    bom_restriction = Column(Boolean, default=False, server_default="0", nullable=False)
    po_restriction = Column(Boolean, default=False, server_default="0", nullable=False)
    material_request_restriction = Column(Boolean, default=False, server_default="0", nullable=False)
    negative_balance_warning = Column(Boolean, default=False, server_default="0", nullable=False)
    custom_pdf_template_enabled = Column(Boolean, default=False, server_default="0", nullable=False)
    document_company_name_display = Column(String(20), default="company", server_default="company", nullable=False)  # company | branch
    google_sheets_auth_phone = Column(String(50), nullable=True)
    google_sheets_enabled = Column(Boolean, default=False, server_default="0", nullable=False)
    google_sheets_authorized_phones = Column(JSONB, default=list, nullable=False)  # whitelist of authorized phone numbers
    subscription_plan = Column(String(50), nullable=True)  # display-only; set by billing backend
    subscription_start = Column(DateTime(timezone=True), nullable=True)
    subscription_end = Column(DateTime(timezone=True), nullable=True)
    subscription_renewal = Column(DateTime(timezone=True), nullable=True)
    onboarding_segment = Column(String(255), nullable=True)
    onboarding_categories = Column(String(500), nullable=True)
    onboarding_city = Column(String(100), nullable=True)
    onboarding_completed = Column(Boolean, default=False, nullable=False)
    is_zatca_enable = Column(Boolean, default=False, server_default="0", nullable=False)
    vat_number = Column(String(50), nullable=True)  # ZATCA VAT registration number (Saudi). Falls back to gstin.
    business_segment = Column(String(50), nullable=True)  # avg business / year
    company_size = Column(String(50), nullable=True)  # headcount band
    construction_types = Column(JSONB, default=list, nullable=False)
    weekly_off = Column(String(20), nullable=True)
    weekly_off_days = Column(JSONB, default=list, nullable=False)
    # ── Workflow Controls (Entry / Progress / Finance / Material) ──
    restrict_entry_creation_enabled = Column(Boolean, default=False, nullable=False)
    restrict_entry_creation_days = Column(Integer, default=0, nullable=False)
    restrict_entry_editing_enabled = Column(Boolean, default=False, nullable=False)
    restrict_entry_editing_days = Column(Integer, default=0, nullable=False)
    restrict_progress_over_estimate = Column(Boolean, default=False, nullable=False)
    pretax_deduction_retention = Column(Boolean, default=False, nullable=False)
    restrict_subcon_material_issue = Column(Boolean, default=False, nullable=False)
    restrict_material_transfer = Column(Boolean, default=False, nullable=False)
    restrict_production_material = Column(Boolean, default=False, nullable=False)
    grn_numbering = Column(String(20), default="Project Level", nullable=False)
    # D7 (R2-073/R2-113/R2-169) per-tenant fail-closed switch. Tri-state:
    # None inherits the global RBAC_EMPTY_PERMS_POLICY default (legacy
    # fail-open); True denies empty/unconfigured role permissions for this
    # tenant when the global policy is "per_company". Nullable on purpose so
    # the boot schema sync can add it to existing databases.
    permissions_fail_closed = Column(Boolean, nullable=True)
    # D2 (R2-033) zero-attendance payroll policy: False = no punch = zero pay
    # (default). True = assume full month when no attendance recorded.
    # ALWAYS returned as attendance_source badge. Nullable so boot sync handles
    # existing databases without a migration.
    assume_full_month_when_no_attendance = Column(Boolean, nullable=True, default=False, server_default="0")
    # CD-4 EPF wage ceiling: default 15000 per month basic. Nullable for boot sync.
    pf_wage_ceiling = Column(Numeric(14, 2), nullable=True, default=15000.0)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)

class CompanyBranch(Base):
    __tablename__ = "company_branches"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"))
    branch_name = Column(String(100), nullable=False)
    gstin = Column(String(15), nullable=False)
    billing_address = Column(String, nullable=False)
    is_primary = Column(Boolean, default=False, server_default="0", nullable=False)
    geo_location = Column(String, nullable=True)  # Google Address textarea
    address_line1 = Column(String, nullable=True)
    city = Column(String(100), nullable=True)
    state = Column(String(100), nullable=True)
    zip = Column(String(20), nullable=True)
    country = Column(String(100), default="India", nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class CompanyFile(Base):
    """Company-scoped branding assets (logo/signature/stamp/watermark).

    Bytes live in Supabase Storage (path stored in ``storage_path``) when the
    service is configured; otherwise they fall back to the ``data`` bytea
    column. ``data`` is kept nullable for the transition period.
    """
    __tablename__ = "company_files"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    asset_type = Column(String(30), nullable=False)  # logo, signature, stamp, watermark
    filename = Column(String(255), nullable=False)
    content_type = Column(String(100), nullable=True)
    storage_path = Column(String(512), nullable=True)  # object key in Supabase Storage
    data = Column(LargeBinary, nullable=True)  # legacy/fallback BLOB (nullable during migration)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class Project(Base):
    __tablename__ = "projects"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"))
    branch_id = Column(UUID(as_uuid=True), ForeignKey("company_branches.id", ondelete="SET NULL"), nullable=True)
    name = Column(String(255), nullable=False)
    code = Column(String(50), nullable=True)
    status = Column(String(50), default="Ongoing", nullable=False)
    address = Column(String)
    city = Column(String(100))
    state = Column(String(100))
    # Note: geography point will be handled via raw SQL or custom type if PostGIS is queried, mapping as String for basic schema
    location = Column(String, nullable=True) 
    attendance_radius_meters = Column(Integer, default=500, nullable=False)
    is_location_required = Column(Boolean, default=True, nullable=False)
    custom_pdf_template_enabled = Column(Boolean, default=False, nullable=False)
    health = Column(String(50), default="Good", nullable=True)
    category = Column(String(100), nullable=True)
    stage = Column(String(100), nullable=True)
    key_personnel_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id", ondelete="SET NULL"), nullable=True)
    project_value = Column(Numeric(18, 2), default=0.0, nullable=False)
    planned_start_date = Column(DateTime(timezone=True), nullable=True)
    planned_end_date = Column(DateTime(timezone=True), nullable=True)
    actual_start_date = Column(DateTime(timezone=True), nullable=True)
    actual_end_date = Column(DateTime(timezone=True), nullable=True)
    orientation = Column(String(255), nullable=True)
    dimension = Column(String(255), nullable=True)
    scope_of_work = Column(String, nullable=True)
    project_avatar = Column(String, nullable=True)
    is_pinned = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)

class User(Base):
    __tablename__ = "users"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(255), nullable=False)
    # Multi-provider auth: phone is no longer the sole identity. Email/Google/
    # password users may have no phone, so mobile is nullable. It stays unique;
    # both Postgres and SQLite allow multiple NULLs under a unique index, so many
    # phone-less users can coexist. Email becomes the primary identity for
    # email-OTP / Google / password users.
    mobile = Column(String(20), unique=True, nullable=True)
    email = Column(String(255), unique=True, nullable=True)
    # bcrypt hash (passlib), only set for email+password users. Never a plaintext.
    password_hash = Column(String(255), nullable=True)
    # True once the email has been proven via email OTP (or a verified Google
    # email). An unverified email is never treated as proof of identity.
    email_verified = Column(Boolean, default=False, server_default="0", nullable=False)
    # Audit trail of which login methods this user has linked, as a comma string
    # (e.g. "phone,google"). Kept as a plain string for SQLite/Postgres parity.
    auth_providers = Column(String(255), nullable=True)
    tokens_revoked_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class RevokedToken(Base):
    __tablename__ = "revoked_tokens"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    jti = Column(String(36), nullable=False, unique=True, index=True)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class OTPCode(Base):
    """Short-lived, hashed one-time login codes (SMS and email).

    Never stores the plaintext code: only an HMAC-SHA256 hash keyed by SECRET_KEY
    (see app/routers/auth.py). Codes expire quickly (OTP_TTL_SECONDS) and are
    invalidated after OTP_MAX_ATTEMPTS wrong tries or on successful use.

    The same hardened machinery serves both channels: ``channel`` records whether
    the code was sent by "sms" or "email" and ``identifier`` holds the phone or
    email it was bound to. ``mobile`` is retained (nullable) for the phone flow's
    backward-compatible column, but ``identifier`` is the generic key.
    """
    __tablename__ = "otp_codes"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    mobile = Column(String(20), nullable=True, index=True)
    channel = Column(String(10), default="sms", server_default="sms", nullable=False)  # sms | email
    identifier = Column(String(255), nullable=True, index=True)  # phone or email
    purpose = Column(String(20), default="login", server_default="login", nullable=False)  # login | password_reset
    code_hash = Column(String(128), nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    attempts = Column(Integer, default=0, nullable=False)
    consumed = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class OAuthHandoff(Base):
    """Single-use, short-lived handoff for OAuth logins (e.g. Google).

    After the OAuth callback authenticates a user, the real session JWT must NOT
    be placed in a redirect URL. Instead we store a one-time code (only its
    HMAC-SHA256 hash, like OTP codes) here and redirect the browser with that
    code. The frontend then POSTs the code to the exchange endpoint to receive
    the real JWT. The row is burned on first use and expires quickly.
    """
    __tablename__ = "oauth_handoffs"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    code_hash = Column(String(128), nullable=False, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=True)
    onboarding = Column(Boolean, default=False, server_default="0", nullable=False)
    provider = Column(String(20), default="google", server_default="google", nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    consumed = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class CompanyRole(Base):
    __tablename__ = "company_roles"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"))
    role_name = Column(String(100), nullable=False)
    permissions = Column(JSONB, nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class CompanyPayrollSettings(Base):
    """Company-level default statutory payroll rates.

    These are the default PF/ESI/TDS percentages and ESI applicability that new
    employees inherit; per-employee overrides remain on StaffEmployee. Field names
    match StaffEmployee exactly (no separate taxonomy).
    """
    __tablename__ = "company_payroll_settings"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), unique=True, nullable=False)
    pf_employee_pct = Column(Numeric(5, 2), default=12.0, nullable=False)
    pf_employer_pct = Column(Numeric(5, 2), default=12.0, nullable=False)
    esi_employee_pct = Column(Numeric(5, 2), default=0.75, nullable=False)
    esi_employer_pct = Column(Numeric(5, 2), default=3.25, nullable=False)
    tds_monthly = Column(Numeric(14, 2), default=0.0, nullable=False)
    is_esi_applicable = Column(Boolean, default=True, nullable=False)
    # CD-4 EPF wage ceiling mirrored here for payroll settings consumers; nullable for boot sync.
    pf_wage_ceiling = Column(Numeric(14, 2), nullable=True, default=15000.0)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class CompanyTeam(Base):
    __tablename__ = "company_team"
    __table_args__ = (
        UniqueConstraint("company_id", "user_id", name="uq_company_team_company_id_user_id"),
    )
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"))
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    role_id = Column(UUID(as_uuid=True), ForeignKey("company_roles.id", ondelete="SET NULL"), nullable=True)
    priority_type = Column(String(50), default="employee", nullable=False)
    library_party_id = Column(UUID(as_uuid=True), ForeignKey("library_parties.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class BOQItem(Base):
    __tablename__ = "boq_items"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    section_name = Column(String(100), nullable=True)
    item_name = Column(String(255), nullable=False)
    # R2-334: same width as library_cost_codes.code, so any code the library
    # accepts can be stored on a BOQ item without truncation.
    cost_code = Column(String(100), nullable=True)
    unit = Column(String(50), nullable=False)
    quantity = Column(Numeric(18, 4), nullable=False)
    rate = Column(Numeric(18, 2), default=0.0, nullable=False)
    supply_rate = Column(Numeric(18, 2), default=0.0, nullable=False)
    installation_rate = Column(Numeric(18, 2), default=0.0, nullable=False)
    supply_tax_pct = Column(Numeric(5, 2), default=18.00, nullable=False)
    installation_tax_pct = Column(Numeric(5, 2), default=12.00, nullable=False)
    quantity_float_limit = Column(Integer, default=2, nullable=False)
    amount = Column(Numeric(18, 2), nullable=True)
    boq_document_id = Column(UUID(as_uuid=True), ForeignKey("boq_documents.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class BOQDocument(Base):
    __tablename__ = "boq_documents"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    client_party_id = Column(UUID(as_uuid=True), ForeignKey("library_parties.id", ondelete="SET NULL"), nullable=True)
    title = Column(String(255), nullable=False)
    milestone_done = Column(Integer, default=0, nullable=False)
    milestone_total = Column(Integer, default=0, nullable=False)
    # Budget currently in force: set when a BOQRevision is applied. Null until
    # the first revision, in which case the line-item sum is the budget.
    revised_amount = Column(Numeric(18, 2), nullable=True)
    terms = Column(Text, nullable=True)  # Terms & Conditions; pre-filled from CompanyTerms on create
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class BOQRevision(Base):
    """Immutable history row recording each time a BOQ document's budget/amount is
    revised. ``revision_no`` is assigned incrementally per document by the API.
    ``previous_amount`` captures the prior revision's amount so deltas are exact.
    """
    __tablename__ = "boq_revisions"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    boq_document_id = Column(UUID(as_uuid=True), ForeignKey("boq_documents.id", ondelete="CASCADE"), nullable=False, index=True)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    revision_no = Column(Integer, nullable=False)
    revised_amount = Column(Numeric(18, 2), nullable=False)
    previous_amount = Column(Numeric(18, 2), nullable=True)
    reason = Column(Text, nullable=True)
    revised_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class ProjectBudget(Base):
    __tablename__ = "project_budgets"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), unique=True, nullable=False)
    material_budget = Column(Numeric(18, 2), default=0.0, nullable=False)
    labour_budget = Column(Numeric(18, 2), default=0.0, nullable=False)
    subcon_budget = Column(Numeric(18, 2), default=0.0, nullable=False)
    equipment_budget = Column(Numeric(18, 2), default=0.0, nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class Task(Base):
    __tablename__ = "tasks"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    parent_id = Column(UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=True)
    name = Column(String(255), nullable=False)
    duration_days = Column(Integer, nullable=False)
    start_date = Column(DateTime(timezone=True), nullable=False)
    end_date = Column(DateTime(timezone=True), nullable=False)
    status = Column(String(50), default="not_started", nullable=False)
    priority = Column(String(50), default="medium", nullable=False)
    assigned_to = Column(UUID(as_uuid=True), ForeignKey("company_team.id"), nullable=True)
    boq_item_id = Column(UUID(as_uuid=True), ForeignKey("boq_items.id", ondelete="SET NULL"), nullable=True)
    progress = Column(Numeric(5, 2), default=0.0, nullable=False)  # actual physical progress %, 0-100
    # Baseline (planned) schedule: snapshotted from start_date/end_date on create,
    # or explicitly via POST /planning/tasks/{id}/set-baseline. Null until captured.
    baseline_start = Column(DateTime(timezone=True), nullable=True)
    baseline_end = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class ProjectMilestone(Base):
    __tablename__ = "project_milestones"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    milestone_date = Column(DateTime(timezone=True), nullable=False)
    type = Column(String(50), default="start", nullable=False)  # start | inspection | critical | payment | handover
    status = Column(String(50), default="upcoming", nullable=False)  # upcoming | achieved
    description = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class TaskPredecessor(Base):
    __tablename__ = "task_predecessors"
    task_id = Column(UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True)
    predecessor_id = Column(UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True)
    type = Column(String(50), default="finish_to_start", nullable=False)

class Drawing(Base):
    __tablename__ = "drawings"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    category = Column(String(50), nullable=False) # e.g. "2D Layout", "3D Layout", "Production File"
    created_by = Column(UUID(as_uuid=True), ForeignKey("company_team.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class DrawingRevision(Base):
    __tablename__ = "drawing_revisions"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    drawing_id = Column(UUID(as_uuid=True), ForeignKey("drawings.id", ondelete="CASCADE"), nullable=False)
    version_code = Column(String(20), nullable=False) # e.g. "V1", "V2", "V3"
    file_url = Column(String, nullable=False)
    approval_status = Column(String(50), default="pending", nullable=False) # e.g. "pending", "approved", "rejected"
    # R2-365: when this revision stopped being the drawing's current sheet;
    # an approved revision with a NULL value is the one site teams build from
    # (exactly one per drawing after any approval).
    superseded_at = Column(DateTime(timezone=True), nullable=True)
    approved_by = Column(UUID(as_uuid=True), ForeignKey("company_team.id"), nullable=True)
    comments = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class DrawingRevisionApproval(Base):
    __tablename__ = "drawing_revision_approvals"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    revision_id = Column(UUID(as_uuid=True), ForeignKey("drawing_revisions.id", ondelete="CASCADE"), nullable=False)
    decision = Column(String(50), nullable=False) # "approved", "rejected", "pending"
    decided_by = Column(UUID(as_uuid=True), ForeignKey("company_team.id"), nullable=False)
    comments = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class DrawingPin(Base):
    __tablename__ = "drawing_pins"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    revision_id = Column(UUID(as_uuid=True), ForeignKey("drawing_revisions.id", ondelete="CASCADE"), nullable=False)
    x_coordinate = Column(Numeric(6, 2), nullable=False)
    y_coordinate = Column(Numeric(6, 2), nullable=False)
    comment = Column(String, nullable=False)
    tagged_user_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id"), nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("company_team.id"), nullable=True)
    resolved = Column(Boolean, default=False, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class MaterialIndent(Base):
    __tablename__ = "material_indents"
    __table_args__ = (
        UniqueConstraint("company_id", "indent_number", name="uq_material_indents_company_id_indent_number"),
    )
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    requested_by = Column(UUID(as_uuid=True), ForeignKey("company_team.id"), nullable=True)
    approved_by = Column(UUID(as_uuid=True), ForeignKey("company_team.id"), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    indent_number = Column(String(100), nullable=False)
    status = Column(String(50), default="pending", nullable=False) # pending, approved, ordered, rejected
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class MaterialIndentItem(Base):
    __tablename__ = "material_indent_items"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    indent_id = Column(UUID(as_uuid=True), ForeignKey("material_indents.id", ondelete="CASCADE"), nullable=False)
    material_name = Column(String(255), nullable=False)
    quantity = Column(Numeric(18, 4), nullable=False)
    reserved_qty = Column(Numeric(18, 4), default=0.0, nullable=False)
    unit = Column(String(50), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"
    __table_args__ = (
        UniqueConstraint("company_id", "po_number", name="uq_purchase_orders_company_id_po_number"),
    )
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    vendor_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id"), nullable=True)
    po_number = Column(String(100), nullable=False)
    po_date = Column(DateTime(timezone=True), nullable=False)
    # Promised delivery date: the baseline vendor on-time delivery is measured
    # against. Null falls back to po_date for legacy rows.
    expected_delivery_date = Column(DateTime(timezone=True), nullable=True)
    status = Column(String(50), default="draft", nullable=False) # draft, sent, partial, received, closed, cancelled
    cancelled_at = Column(DateTime(timezone=True), nullable=True)
    cancelled_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    gross_amount = Column(Numeric(18, 2), default=0.0, nullable=False)
    tax_amount = Column(Numeric(18, 2), default=0.0, nullable=False)
    total_amount = Column(Numeric(18, 2), default=0.0, nullable=False)
    approval_flag = Column(String(50), default="pending", nullable=False) # pending, pending_approval, approved, rejected
    approval_rule_id = Column(UUID(as_uuid=True), ForeignKey("approval_rules.id", ondelete="SET NULL"), nullable=True)
    # R2-372: the approved indent this PO was raised from, when any. Null keeps
    # legacy direct-PO behaviour; a linked indent is flipped to "ordered" on
    # creation so one approval cannot be ordered repeatedly.
    indent_id = Column(UUID(as_uuid=True), ForeignKey("material_indents.id", ondelete="SET NULL"), nullable=True)
    terms = Column(Text, nullable=True)  # Terms & Conditions; pre-filled from CompanyTerms on create
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class PurchaseOrderItem(Base):
    __tablename__ = "purchase_order_items"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    po_id = Column(UUID(as_uuid=True), ForeignKey("purchase_orders.id", ondelete="CASCADE"), nullable=False)
    material_name = Column(String(255), nullable=False)
    quantity = Column(Numeric(18, 4), nullable=False)
    unit = Column(String(50), nullable=False)
    rate = Column(Numeric(18, 2), nullable=False)
    tax_pct = Column(Numeric(5, 2), default=18.00, nullable=False)
    total_amount = Column(Numeric(18, 2), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class GoodsReceiptNote(Base):
    __tablename__ = "goods_receipt_notes"
    __table_args__ = (
        UniqueConstraint("company_id", "grn_number", name="uq_goods_receipt_notes_company_id_grn_number"),
    )
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    po_id = Column(UUID(as_uuid=True), ForeignKey("purchase_orders.id", ondelete="SET NULL"), nullable=True)
    grn_number = Column(String(100), nullable=False)
    received_date = Column(DateTime(timezone=True), nullable=False)
    received_by = Column(UUID(as_uuid=True), ForeignKey("company_team.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class GRNItem(Base):
    __tablename__ = "grn_items"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    grn_id = Column(UUID(as_uuid=True), ForeignKey("goods_receipt_notes.id", ondelete="CASCADE"), nullable=False)
    po_item_id = Column(UUID(as_uuid=True), ForeignKey("purchase_order_items.id", ondelete="SET NULL"), nullable=True)
    received_qty = Column(Numeric(18, 4), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class WarehouseInventory(Base):
    __tablename__ = "warehouse_inventory"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    material_name = Column(String(255), nullable=False)
    category = Column(String(100), default="Uncategorized", nullable=False)
    on_hand_qty = Column(Numeric(18, 4), default=0.0, nullable=False)
    reserved_qty = Column(Numeric(18, 4), default=0.0, nullable=False)
    unit = Column(String(50), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class MaterialTransaction(Base):
    __tablename__ = "material_transactions"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    material_name = Column(String(255), nullable=False)
    category = Column(String(100), default="Uncategorized", nullable=False)
    qty = Column(Numeric(18, 4), nullable=False)
    type = Column(String(50), nullable=False) # received, used, transferred, returned
    unit = Column(String(50), nullable=True)
    source_ref_id = Column(UUID(as_uuid=True), nullable=True) # grn_id, dpr_id, etc.
    # R2-387: mandatory human justification for type="adjustment" stock
    # corrections; null for every ordinary movement.
    reason = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

#
# Phase 16 â€” Production Management, batch recipes & consumption tracking
#

class ProductionRecipe(Base):
    __tablename__ = "production_recipes"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    recipe_code = Column(String(100), nullable=False)
    product_name = Column(String(255), nullable=False)
    mix_type = Column(String(100), nullable=False)
    unit = Column(String(50), default="m3", nullable=False)
    target_output_qty = Column(Numeric(18, 4), default=1.0, nullable=False)
    wastage_pct = Column(Numeric(5, 2), default=5.0, nullable=False)
    status = Column(String(50), default="active", nullable=False)
    notes = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)


class ProductionRecipeMaterial(Base):
    __tablename__ = "production_recipe_materials"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    recipe_id = Column(UUID(as_uuid=True), ForeignKey("production_recipes.id", ondelete="CASCADE"), nullable=False)
    material_name = Column(String(255), nullable=False)
    planned_qty = Column(Numeric(18, 4), nullable=False)
    unit = Column(String(50), nullable=False)
    is_optional = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class ProductionBatch(Base):
    __tablename__ = "production_batches"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    recipe_id = Column(UUID(as_uuid=True), ForeignKey("production_recipes.id", ondelete="CASCADE"), nullable=False)
    task_id = Column(UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True)
    batch_number = Column(String(100), nullable=False)
    planned_output_qty = Column(Numeric(18, 4), default=0.0, nullable=False)
    actual_output_qty = Column(Numeric(18, 4), default=0.0, nullable=False)
    planned_material_qty = Column(Numeric(18, 4), default=0.0, nullable=False)
    actual_material_qty = Column(Numeric(18, 4), default=0.0, nullable=False)
    consumption_variance_qty = Column(Numeric(18, 4), default=0.0, nullable=False)
    status = Column(String(50), default="draft", nullable=False)
    started_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)
    notes = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)


class ProductionBatchMaterial(Base):
    __tablename__ = "production_batch_materials"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    batch_id = Column(UUID(as_uuid=True), ForeignKey("production_batches.id", ondelete="CASCADE"), nullable=False)
    material_name = Column(String(255), nullable=False)
    planned_qty = Column(Numeric(18, 4), nullable=False)
    actual_qty = Column(Numeric(18, 4), nullable=False)
    unit = Column(String(50), nullable=False)
    variance_qty = Column(Numeric(18, 4), default=0.0, nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class WorkOrder(Base):
    __tablename__ = "work_orders"
    __table_args__ = (
        UniqueConstraint("company_id", "wo_number", name="uq_work_orders_company_id_wo_number"),
    )
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    subcontractor_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id"), nullable=False)
    wo_number = Column(String(100), nullable=False)
    wo_date = Column(DateTime(timezone=True), nullable=False)
    status = Column(String(50), default="active", nullable=False)
    estimated_work_amount = Column(Numeric(18, 2), default=0.0, nullable=False)
    terms = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class WorkOrderItem(Base):
    __tablename__ = "work_order_items"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    wo_id = Column(UUID(as_uuid=True), ForeignKey("work_orders.id", ondelete="CASCADE"), nullable=False)
    boq_item_id = Column(UUID(as_uuid=True), ForeignKey("boq_items.id", ondelete="SET NULL"), nullable=True)
    task_id = Column(UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True)
    quantity = Column(Numeric(18, 4), nullable=False)
    rate = Column(Numeric(18, 2), nullable=False)
    amount = Column(Numeric(18, 2), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class Bill(Base):
    __tablename__ = "bills"
    __table_args__ = (
        UniqueConstraint("company_id", "invoice_number", name="uq_bills_company_id_invoice_number"),
    )
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    party_company_user_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id"), nullable=False)
    invoice_number = Column(String(100), nullable=False)
    invoice_date = Column(DateTime(timezone=True), nullable=False)
    due_date = Column(DateTime(timezone=True), nullable=True)
    invoice_type = Column(String(50), nullable=False) # sale, purchase, subcon
    status = Column(String(50), default="Unpaid", nullable=False) # Unpaid, Partially Paid, Paid, Cancelled
    cancelled_at = Column(DateTime(timezone=True), nullable=True)
    cancelled_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    subtotal = Column(Numeric(18, 2), nullable=False)
    gst_amount = Column(Numeric(18, 2), default=0.0, nullable=False)
    total_payable = Column(Numeric(18, 2), nullable=False)
    paid_amount = Column(Numeric(18, 2), default=0.0, nullable=False)
    approval_flag = Column(String(50), default="pending", nullable=False)
    is_milestone_fixed_amount = Column(Boolean, default=False, nullable=False)
    # Whether deductions came off before GST was computed. The billing list used
    # to read is_milestone_fixed_amount for this, so every bill said "Post-Tax".
    pre_tax_deductions = Column(Boolean, nullable=True)
    tally_synced = Column(Boolean, default=False, nullable=False)
    zoho_bill_id = Column(String(100), nullable=True)
    boq_document_id = Column(UUID(as_uuid=True), ForeignKey("boq_documents.id", ondelete="SET NULL"), nullable=True)
    # R2-360: the CRM quotation this sale invoice was created from. Null for
    # manually keyed invoices and legacy rows; while a non-cancelled bill
    # carries the link, CRM revenue and billed revenue can be reconciled.
    quotation_id = Column(UUID(as_uuid=True), ForeignKey("crm_quotations.id", ondelete="SET NULL"), nullable=True)
    # Subcontractor work order this bill bills against (subcon RA bills). Null for
    # non-subcon bills and legacy rows; when set, cumulative billing is validated
    # against the WO's estimated_work_amount.
    wo_id = Column(UUID(as_uuid=True), ForeignKey("work_orders.id", ondelete="SET NULL"), nullable=True)
    # R2-371: the purchase order this bill bills against. Null for non-purchase
    # bills and legacy rows. Without it, billed-vs-ordered is uncomputable and
    # over-invoicing against a PO is structurally undetectable -- a vendor can
    # bill ₹5,00,000 against a ₹1,00,000 PO and no query in the product can
    # relate the two documents. The only prior path was
    # Bill.match_id -> ThreeWayMatch.po_id, and of 7 purchase bills in
    # production zero carried a match_id.
    po_id = Column(UUID(as_uuid=True), ForeignKey("purchase_orders.id", ondelete="SET NULL"), nullable=True)
    match_id = Column(UUID(as_uuid=True), ForeignKey("three_way_matches.id", ondelete="SET NULL"), nullable=True)
    # Transaction sub-entity persistence (Project Tab Transaction build)
    items_json = Column(Text, nullable=True)  # JSON array of line items: {desc, cost_code_id, cost_code_name, qty, rate, amount}
    payment_mode = Column(String(20), nullable=True)  # Cash / Bank / Cheque (Payment In / Payment Out)
    payment_bank_name = Column(String(255), nullable=True)
    payment_ref = Column(String(255), nullable=True)  # cheque no / bank txn ref
    ship_to = Column(Text, nullable=True)  # Bill / Ship addressing
    terms = Column(Text, nullable=True)  # Terms & Conditions; pre-filled from CompanyTerms on create
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)

class TransactionDeduction(Base):
    __tablename__ = "transaction_deductions"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    bill_id = Column(UUID(as_uuid=True), ForeignKey("bills.id", ondelete="CASCADE"), nullable=False)
    deduction_type = Column(String(100), nullable=False) # TDS, Retention, Security Deposit, Advance Recovery, Material Recovery
    amount = Column(Numeric(18, 2), nullable=False)
    percentage = Column(Numeric(5, 2), nullable=True)
    notes = Column(String, nullable=True)
    # R2-377: retention lifecycle. release_due_date states when the withheld
    # amount falls due for release; released_at/released_amount record the
    # actual release. Nullable so TDS and other deduction rows are unaffected.
    release_due_date = Column(DateTime(timezone=True), nullable=True)
    released_at = Column(DateTime(timezone=True), nullable=True)
    released_amount = Column(Numeric(18, 2), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class DebitNote(Base):
    __tablename__ = "debit_notes"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    party_company_user_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id"), nullable=False)
    notes = Column(String, nullable=True)
    total_amount = Column(Numeric(18, 2), nullable=False)
    work_amount = Column(Numeric(18, 2), default=0.0, nullable=False)
    gst_amount = Column(Numeric(18, 2), default=0.0, nullable=False)
    bill_id = Column(UUID(as_uuid=True), ForeignKey("bills.id", ondelete="SET NULL"), nullable=True)
    reference_number = Column(String(100), nullable=True)
    approval_flag = Column(String(50), default="auto_approved", nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class CreditNote(Base):
    __tablename__ = "credit_notes"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    party_company_user_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id"), nullable=False)
    notes = Column(String, nullable=True)
    total_amount = Column(Numeric(18, 2), nullable=False)
    bill_id = Column(UUID(as_uuid=True), ForeignKey("bills.id", ondelete="SET NULL"), nullable=True)
    reference_number = Column(String(100), nullable=True)
    approval_flag = Column(String(50), default="pending", nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

# ─────────────────────────────────────────────────────────────────────────────
# Phase 9 — Staff Timesheets, Geofenced Attendance & Payroll
# ─────────────────────────────────────────────────────────────────────────────

class StaffEmployee(Base):
    """Master record for each staff member employed under a company/project."""
    __tablename__ = "staff_employees"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=True)
    name = Column(String(255), nullable=False)
    employee_code = Column(String(50), nullable=True)
    # User ID enrolled on the site biometric device (ZKTeco/eSSL "PIN").
    biometric_pin = Column(String(20), nullable=True)
    uan = Column(String(12), nullable=True)
    designation = Column(String(100), nullable=True)
    department = Column(String(100), nullable=True)
    mobile = Column(String(20), nullable=True)
    basic_salary = Column(Numeric(14, 2), default=0.0, nullable=False)
    hra = Column(Numeric(14, 2), default=0.0, nullable=False)
    other_allowances = Column(Numeric(14, 2), default=0.0, nullable=False)
    pf_employee_pct = Column(Numeric(5, 2), default=12.0, nullable=False)
    pf_employer_pct = Column(Numeric(5, 2), default=12.0, nullable=False)
    esi_employee_pct = Column(Numeric(5, 2), default=0.75, nullable=False)
    esi_employer_pct = Column(Numeric(5, 2), default=3.25, nullable=False)
    tds_monthly = Column(Numeric(14, 2), default=0.0, nullable=False)
    is_esi_applicable = Column(Boolean, default=True, nullable=False)
    status = Column(String(50), default="active", nullable=False)
    date_of_joining = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)


class AttendanceLog(Base):
    """GPS-stamped punch-in/out record per employee per day."""
    __tablename__ = "attendance_logs"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    employee_id = Column(UUID(as_uuid=True), ForeignKey("staff_employees.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    attendance_date = Column(DateTime(timezone=True), nullable=False)
    punch_in = Column(DateTime(timezone=True), nullable=True)
    punch_out = Column(DateTime(timezone=True), nullable=True)
    lat_in = Column(Numeric(10, 7), nullable=True)
    lng_in = Column(Numeric(10, 7), nullable=True)
    lat_out = Column(Numeric(10, 7), nullable=True)
    lng_out = Column(Numeric(10, 7), nullable=True)
    distance_from_site_m = Column(Numeric(10, 2), nullable=True)
    is_within_geofence = Column(Boolean, default=False, nullable=False)
    status = Column(String(50), default="Present", nullable=False)
    hours_worked = Column(Numeric(5, 2), nullable=True)
    overtime_hours = Column(Numeric(5, 2), default=0.0, nullable=False)
    shift_multiplier = Column(Numeric(5, 2), default=1.0, nullable=False)
    location_verified = Column(Boolean, default=True, nullable=False)
    photo_verified = Column(Boolean, default=False, nullable=False)
    # Set when a supervisor marks the muster by hand instead of the worker
    # punching with GPS. Attendance feeds payroll, so a hand-marked day has to be
    # distinguishable from a verified punch and attributable to whoever marked it.
    marked_manually = Column(Boolean, default=False, nullable=False)
    marked_by = Column(String(255), nullable=True)
    notes = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class BiometricDevice(Base):
    """A fingerprint/face attendance terminal that pushes punches over ADMS."""
    __tablename__ = "biometric_devices"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    serial_number = Column(String(64), nullable=False, unique=True)
    name = Column(String(255), nullable=False)
    # Device clocks have no zone; punches are read in this offset (IST default).
    tz_offset_minutes = Column(Integer, default=330, nullable=False)
    last_seen_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class BiometricPunch(Base):
    """Every punch a device sent, matched or not, so nothing a device records is
    lost when its user ID has not been mapped to an employee yet."""
    __tablename__ = "biometric_punches"
    __table_args__ = (
        UniqueConstraint("device_id", "device_pin", "punch_time", name="uq_biometric_punches_device_pin_time"),
    )
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    device_id = Column(UUID(as_uuid=True), ForeignKey("biometric_devices.id", ondelete="CASCADE"), nullable=False)
    device_pin = Column(String(20), nullable=False)
    punch_time = Column(DateTime(timezone=True), nullable=False)
    verify_mode = Column(String(20), nullable=True)
    employee_id = Column(UUID(as_uuid=True), ForeignKey("staff_employees.id", ondelete="SET NULL"), nullable=True)
    attendance_log_id = Column(UUID(as_uuid=True), ForeignKey("attendance_logs.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class Timesheet(Base):
    """Weekly timesheet header for one employee."""
    __tablename__ = "timesheets"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    employee_id = Column(UUID(as_uuid=True), ForeignKey("staff_employees.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    week_start = Column(DateTime(timezone=True), nullable=False)
    week_end = Column(DateTime(timezone=True), nullable=False)
    total_hours = Column(Numeric(6, 2), default=0.0, nullable=False)
    status = Column(String(50), default="draft", nullable=False)
    approved_by = Column(UUID(as_uuid=True), nullable=True)
    photo_verified = Column(Boolean, default=False, nullable=False)
    location_verified = Column(Boolean, default=False, nullable=False)
    notes = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)


class TimesheetEntry(Base):
    """One line in a timesheet: date + task + hours logged."""
    __tablename__ = "timesheet_entries"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    timesheet_id = Column(UUID(as_uuid=True), ForeignKey("timesheets.id", ondelete="CASCADE"), nullable=False)
    task_id = Column(UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True)
    entry_date = Column(DateTime(timezone=True), nullable=False)
    hours = Column(Numeric(5, 2), nullable=False)
    activity_description = Column(String, nullable=True)
    start_time = Column(DateTime(timezone=True), nullable=True)
    end_time = Column(DateTime(timezone=True), nullable=True)
    duration = Column(Integer, nullable=True) # in minutes
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class TeamScheduleTimesheet(Base):
    """Lightweight party-linked time log (Team Schedule tab).

    Deliberately separate from the HR/payroll weekly `Timesheet` model: this is
    one row per time-log entry (any party type + single date + start/end + project),
    with no week grouping or submit/approve workflow. See scratchpad decision (a).
    """
    __tablename__ = "team_schedule_timesheets"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    party_id = Column(UUID(as_uuid=True), ForeignKey("library_parties.id", ondelete="SET NULL"), nullable=True)
    party_name = Column(String(255), nullable=True)  # snapshot at log time
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    entry_date = Column(DateTime(timezone=True), nullable=False)
    start_time = Column(DateTime(timezone=True), nullable=True)
    end_time = Column(DateTime(timezone=True), nullable=True)
    duration_minutes = Column(Integer, nullable=True)
    remarks = Column(String, nullable=True)
    file_url = Column(String, nullable=True)  # e.g. /files/file/{project_file_id}
    file_name = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class PayrollRun(Base):
    """Monthly payroll run header for one company+month."""
    __tablename__ = "payroll_runs"
    # R2-353: one run per (company, project, month); hr.py run_payroll 409s
    # with a friendly message and this constraint is the race-condition
    # backstop (migration skips itself if historical duplicates exist).
    __table_args__ = (
        UniqueConstraint("company_id", "project_id", "payroll_month",
                         name="uq_payroll_runs_company_project_month"),
    )
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=True)
    payroll_month = Column(String(7), nullable=False)
    run_date = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    status = Column(String(50), default="draft", nullable=False)
    total_gross = Column(Numeric(18, 2), default=0.0, nullable=False)
    total_deductions = Column(Numeric(18, 2), default=0.0, nullable=False)
    total_net = Column(Numeric(18, 2), default=0.0, nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class PayrollLineItem(Base):
    """One employee's computed payslip within a PayrollRun."""
    __tablename__ = "payroll_line_items"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    payroll_run_id = Column(UUID(as_uuid=True), ForeignKey("payroll_runs.id", ondelete="CASCADE"), nullable=False)
    employee_id = Column(UUID(as_uuid=True), ForeignKey("staff_employees.id", ondelete="CASCADE"), nullable=False)
    days_present = Column(Numeric(5, 1), default=0.0, nullable=False)
    days_in_month = Column(Integer, default=26, nullable=False)
    gross_salary = Column(Numeric(14, 2), default=0.0, nullable=False)
    basic = Column(Numeric(14, 2), default=0.0, nullable=False)
    hra = Column(Numeric(14, 2), default=0.0, nullable=False)
    other_allowances = Column(Numeric(14, 2), default=0.0, nullable=False)
    overtime_amount = Column(Numeric(14, 2), default=0.0, nullable=False)
    pf_employee = Column(Numeric(14, 2), default=0.0, nullable=False)
    pf_employer = Column(Numeric(14, 2), default=0.0, nullable=False)
    esi_employee = Column(Numeric(14, 2), default=0.0, nullable=False)
    esi_employer = Column(Numeric(14, 2), default=0.0, nullable=False)
    tds = Column(Numeric(14, 2), default=0.0, nullable=False)
    advance_recovery = Column(Numeric(14, 2), default=0.0, nullable=False)
    other_deductions = Column(Numeric(14, 2), default=0.0, nullable=False)
    total_deductions = Column(Numeric(14, 2), default=0.0, nullable=False)
    net_payable = Column(Numeric(14, 2), default=0.0, nullable=False)
    # D2: whether this payslip's days_present was recorded punch/leave or assumed fallback
    attendance_source = Column(String(20), nullable=True, default="recorded")
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

# ─────────────────────────────────────────────────────────────────────────────
# Phase 10 — Quality Control, Site Inspections & Snag Lists
# ─────────────────────────────────────────────────────────────────────────────

class QualityChecklist(Base):
    """Master checklist template (e.g. IS 456 concrete work checklist)."""
    __tablename__ = "quality_checklists"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    title = Column(String(255), nullable=False)
    category = Column(String(100), nullable=True)        # Concrete, Masonry, Electrical, etc.
    is_code_reference = Column(String(100), nullable=True)  # IS 456, IS 1786, etc.
    description = Column(String, nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class ChecklistItem(Base):
    """Individual checkpoint within a QualityChecklist."""
    __tablename__ = "checklist_items"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    checklist_id = Column(UUID(as_uuid=True), ForeignKey("quality_checklists.id", ondelete="CASCADE"), nullable=False)
    sequence = Column(Integer, default=1, nullable=False)
    description = Column(String, nullable=False)
    acceptable_criteria = Column(String, nullable=True)   # e.g. "Cover ≥ 40mm"
    is_mandatory = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class SiteInspection(Base):
    """One inspection event (checklist instance) at a location/task."""
    __tablename__ = "site_inspections"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    checklist_id = Column(UUID(as_uuid=True), ForeignKey("quality_checklists.id", ondelete="RESTRICT"), nullable=False)
    task_id = Column(UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True)
    inspected_by = Column(UUID(as_uuid=True), nullable=True)   # user_id ref
    zone = Column(String(100), nullable=True)                   # e.g. "Floor 3 - Grid C-D"
    inspection_date = Column(DateTime(timezone=True), nullable=False)
    status = Column(String(50), default="pending", nullable=False)  # pending, pass, fail, partial
    pass_count = Column(Integer, default=0, nullable=False)
    fail_count = Column(Integer, default=0, nullable=False)
    na_count = Column(Integer, default=0, nullable=False)
    overall_remarks = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)


class InspectionResponse(Base):
    """Per-item pass/fail response within a SiteInspection."""
    __tablename__ = "inspection_responses"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    inspection_id = Column(UUID(as_uuid=True), ForeignKey("site_inspections.id", ondelete="CASCADE"), nullable=False)
    checklist_item_id = Column(UUID(as_uuid=True), ForeignKey("checklist_items.id", ondelete="CASCADE"), nullable=False)
    result = Column(String(10), nullable=False)   # Pass, Fail, NA
    remarks = Column(String, nullable=True)
    photo_url = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class NCR(Base):
    """Non-Conformance Report raised against a project or inspection."""
    __tablename__ = "ncrs"
    # R2-386 (Wave: H-verify-sweep): ncr_number is unique per project; enforced
    # in production via supabase/migrations/20260823_000002_orphan_unique_constraints.sql
    __table_args__ = (
        UniqueConstraint("project_id", "ncr_number", name="uq_ncrs_project_id_ncr_number"),
    )
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    inspection_id = Column(UUID(as_uuid=True), ForeignKey("site_inspections.id", ondelete="SET NULL"), nullable=True)
    ncr_number = Column(String(50), nullable=False)
    title = Column(String(255), nullable=False)
    description = Column(String, nullable=True)
    severity = Column(String(50), default="Major", nullable=False)  # Minor, Major, Critical
    # Optional vendor attribution: when set, the NCR counts toward that vendor's
    # quality_issues on the vendor performance scorecard.
    vendor_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id", ondelete="SET NULL"), nullable=True)
    raised_by = Column(UUID(as_uuid=True), nullable=True)
    assigned_to = Column(UUID(as_uuid=True), nullable=True)
    due_date = Column(DateTime(timezone=True), nullable=True)
    status = Column(String(50), default="open", nullable=False)   # open, under_review, closed
    resolution_notes = Column(String, nullable=True)
    reviewed_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    reviewed_at = Column(DateTime(timezone=True), nullable=True)
    closed_at = Column(DateTime(timezone=True), nullable=True)
    closed_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)


class MaterialTestResult(Base):
    """Lab/field test results for materials (cube strength, slump, compaction)."""
    __tablename__ = "material_test_results"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    test_type = Column(String(100), nullable=False)      # Cube Test, Slump Test, Compaction Test, etc.
    material = Column(String(100), nullable=True)         # Concrete M25, Steel Fe500, etc.
    sample_ref = Column(String(100), nullable=True)
    test_date = Column(DateTime(timezone=True), nullable=False)
    result_value = Column(Numeric(12, 3), nullable=False)
    unit = Column(String(20), nullable=True)              # MPa, mm, %
    min_acceptable = Column(Numeric(12, 3), nullable=True)
    max_acceptable = Column(Numeric(12, 3), nullable=True)
    is_pass = Column(Boolean, nullable=True)              # auto-computed or manual
    zone = Column(String(100), nullable=True)
    remarks = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


# ─────────────────────────────────────────────────────────────────────────────
# Phase 11 — Client Portal & PDF Progress Reports
# ─────────────────────────────────────────────────────────────────────────────

class ClientReport(Base):
    """Client Portal - Generated PDF Progress Reports for clients."""
    __tablename__ = "client_reports"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    report_name = Column(String(255), nullable=False)
    report_date = Column(DateTime(timezone=True), nullable=False)
    summary_markdown = Column(String, nullable=True)
    pdf_url = Column(String(500), nullable=True)
    generated_by = Column(UUID(as_uuid=True), nullable=True)
    # R2-286(b): approval must be attributable to a distinct approver.
    approved_by = Column(UUID(as_uuid=True), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    is_approved = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)


# ─────────────────────────────────────────────────────────────────────────────
# Phase 12 — Equipment & Machinery Tracking
# ─────────────────────────────────────────────────────────────────────────────

class Equipment(Base):
    """Assets/Machinery fleet owned or hired by the company."""
    __tablename__ = "equipment"
    # R2-049 / R2-358b: `code` used to be unique=True at column level, which
    # made it unique across every tenant on the platform. Two different
    # companies could not both register "EXC-01" -- whoever claimed a code
    # first squatted it platform-wide, and the resulting 400 confirmed to the
    # caller that some other tenant already held that code. Equipment codes are
    # short and conventional, so collisions were near-certain as tenants grew.
    # Every other duplicate guard in this codebase is company-scoped; this one
    # now is too, enforced by constraint so no call site can bypass it.
    __table_args__ = (
        UniqueConstraint("company_id", "code", name="uq_equipment_company_id_code"),
    )
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    code = Column(String(100), nullable=False)
    category = Column(String(100), nullable=False)        # Excavator, Crane, Mixer, Generator, etc.
    ownership_type = Column(String(50), nullable=False)     # Owned, Hired
    status = Column(String(50), default="available", nullable=False) # available, deployed, maintenance, inactive
    hourly_rate = Column(Numeric(12, 2), default=0.0, nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)


class EquipmentDeployment(Base):
    """Deployment history of a machinery asset to a specific construction project."""
    __tablename__ = "equipment_deployments"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    equipment_id = Column(UUID(as_uuid=True), ForeignKey("equipment.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    start_date = Column(DateTime(timezone=True), nullable=False)
    end_date = Column(DateTime(timezone=True), nullable=True)
    hours_used = Column(Numeric(12, 2), nullable=True)  # recorded engine/shift hours on site; NULL falls back to wall-clock billing
    # Odometer / hour-meter readings as real columns. These used to be stuffed
    # into the free-text `remarks` string ("Start reading: 4350."), which meant
    # the Odometer Run Logs tab could not compute mileage from them and the stop
    # reading was thrown away entirely by the return endpoint.
    start_meter = Column(Numeric(12, 2), nullable=True)
    end_meter = Column(Numeric(12, 2), nullable=True)
    remarks = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class FuelLog(Base):
    """Fuel refilling logs for heavy machinery to compute burn rates."""
    __tablename__ = "equipment_fuel_logs"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    equipment_id = Column(UUID(as_uuid=True), ForeignKey("equipment.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    logged_date = Column(DateTime(timezone=True), nullable=False)
    liters = Column(Numeric(10, 2), nullable=False)
    cost_per_liter = Column(Numeric(10, 2), nullable=False)
    total_cost = Column(Numeric(14, 2), nullable=False)
    odometer_hours = Column(Numeric(12, 2), nullable=True)  # odometer reading or engine hours run
    remarks = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class MaintenanceSchedule(Base):
    """Routine service and repair logs for heavy fleet machinery."""
    __tablename__ = "equipment_maintenance_schedules"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    equipment_id = Column(UUID(as_uuid=True), ForeignKey("equipment.id", ondelete="CASCADE"), nullable=False)
    service_type = Column(String(100), nullable=False)      # Routine Oil Change, Brake Overhaul, etc.
    scheduled_date = Column(DateTime(timezone=True), nullable=False)
    completed_date = Column(DateTime(timezone=True), nullable=True)
    cost = Column(Numeric(14, 2), default=0.0, nullable=False)
    status = Column(String(50), default="scheduled", nullable=False) # scheduled, completed, overdue
    remarks = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


# ─────────────────────────────────────────────────────────────────────────────
# Phase 13 — Safety & Incident Management (HSE)
# ─────────────────────────────────────────────────────────────────────────────

class SafetyIncident(Base):
    """OSHA-aligned incident records logged per project site."""
    __tablename__ = "safety_incidents"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    incident_type = Column(String(100), nullable=False)      # Near Miss, First Aid, LTI, Fatal
    severity = Column(String(50), nullable=False)            # Low, Medium, High, Critical
    description = Column(String, nullable=False)
    location = Column(String(255), nullable=True)
    injured_person = Column(String(255), nullable=True)
    lost_time_days = Column(Integer, default=0, nullable=False)
    status = Column(String(50), default="open", nullable=False)  # open, under_investigation, closed
    root_cause = Column(String, nullable=True)
    corrective_action = Column(String, nullable=True)
    reported_by = Column(String(255), nullable=False)
    reported_at = Column(DateTime(timezone=True), nullable=False)
    closed_at = Column(DateTime(timezone=True), nullable=True)
    closed_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class ToolboxTalk(Base):
    """Safety toolbox talk sessions conducted on site."""
    __tablename__ = "toolbox_talks"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    topic = Column(String(255), nullable=False)
    conducted_by = Column(String(255), nullable=False)
    conducted_at = Column(DateTime(timezone=True), nullable=False)
    attendee_count = Column(Integer, default=0, nullable=False)
    notes = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class PPECheck(Base):
    """Personal Protective Equipment compliance audit records per site visit."""
    __tablename__ = "ppe_checks"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    checked_by = Column(String(255), nullable=False)
    check_date = Column(DateTime(timezone=True), nullable=False)
    total_workers = Column(Integer, default=0, nullable=False)
    compliant_workers = Column(Integer, default=0, nullable=False)
    non_compliant_items = Column(JSONB, default=list, nullable=False)  # e.g. ["No helmet", "No safety vest"]
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class DailyProgressReport(Base):
    """Daily Progress Report (DPR) tracking daily execution metrics."""
    __tablename__ = "daily_progress_reports"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    task_id = Column(UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=True)
    reported_by = Column(String(255), nullable=False)
    dpr_date = Column(DateTime(timezone=True), nullable=False)
    weather = Column(String(100), default="Clear", nullable=False)
    executed_qty = Column(Numeric(18, 4), nullable=False)
    workers_deployed = Column(Integer, default=0, nullable=False)
    materials_consumed = Column(JSONB, default=list, nullable=False)  # List of {"material_name": str, "quantity": float, "unit": str}
    photos = Column(JSONB, default=list, nullable=False)  # List of image URLs
    notes = Column(String, nullable=True)
    issues = Column(String, nullable=True)
    status = Column(String(50), default="submitted", nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class CRMLead(Base):
    """CRM Lead details."""
    __tablename__ = "crm_leads"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    assignee_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id", ondelete="SET NULL"), nullable=True)
    lead_date = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    lead_type = Column(String(100), nullable=False)
    contact_name = Column(String(255), nullable=False)
    phone_no = Column(String(20), nullable=False)
    email = Column(String(255), nullable=True)
    client_company_name = Column(String(255), nullable=True)
    party_id = Column(UUID(as_uuid=True), ForeignKey("library_parties.id", ondelete="SET NULL"), nullable=True)
    address = Column(String, nullable=True)
    source = Column(String(100), nullable=True)
    category = Column(String(100), nullable=True)
    status = Column(String(100), default="New Lead", nullable=False)
    priority = Column(String(50), default="medium", nullable=False)
    budget = Column(Numeric(18, 2), default=0.0, nullable=False)
    description = Column(String, nullable=True)
    next_follow_up = Column(DateTime(timezone=True), nullable=True)
    expected_closure = Column(DateTime(timezone=True), nullable=True)
    country_code = Column(String(10), default="+91", nullable=False)
    last_contacted = Column(DateTime(timezone=True), nullable=True)
    lead_name = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)


class CRMQuotation(Base):
    """CRM Quotation generated for a Lead."""
    __tablename__ = "crm_quotations"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    lead_id = Column(UUID(as_uuid=True), ForeignKey("crm_leads.id", ondelete="CASCADE"), nullable=False)
    subject = Column(String(255), nullable=False)
    tax_type = Column(String(50), default="bill_level", nullable=False)  # item_level, bill_level
    status = Column(String(50), default="Draft", nullable=False)  # Draft, Sent, Confirmed, Rejected
    gst_pct = Column(Numeric(5, 2), default=18.00, nullable=False)
    cgst_pct = Column(Numeric(5, 2), default=9.00, nullable=False)
    sgst_pct = Column(Numeric(5, 2), default=9.00, nullable=False)
    cgst_amount = Column(Numeric(18, 2), default=0.0, nullable=False)
    sgst_amount = Column(Numeric(18, 2), default=0.0, nullable=False)
    # D4 (R2-041/R2-125/R2-319) — inter-state quotations carry IGST; intra-state split CGST/SGST.
    # Additive nullable columns so SQLite boot-sync can add them without a migration script;
    # backfill defaults to 0.0 for legacy rows that were always intra-state halves.
    igst_pct = Column(Numeric(5, 2), default=0.00, nullable=True)
    igst_amount = Column(Numeric(18, 2), default=0.0, nullable=True)
    discount = Column(Numeric(18, 2), default=0.0, nullable=False)
    additional_charges = Column(Numeric(18, 2), default=0.0, nullable=False)
    round_off = Column(Numeric(18, 2), default=0.0, nullable=False)
    qt_no = Column(String(100), nullable=True)
    qt_date = Column(Date, nullable=True)
    bank_account_id = Column(UUID(as_uuid=True), ForeignKey("bank_accounts.id", ondelete="SET NULL"), nullable=True)
    total_amount = Column(Numeric(18, 2), default=0.0, nullable=False)
    terms = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class CRMQuotationItem(Base):
    """Line items inside a CRM Quotation supporting Split Rates."""
    __tablename__ = "crm_quotation_items"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    quotation_id = Column(UUID(as_uuid=True), ForeignKey("crm_quotations.id", ondelete="CASCADE"), nullable=False)
    section_name = Column(String(100), nullable=True)
    item_name = Column(String(255), nullable=False)
    qty = Column(Numeric(18, 4), nullable=False)
    unit = Column(String(50), nullable=False)
    cost_price = Column(Numeric(18, 2), default=0.0, nullable=False)
    selling_price = Column(Numeric(18, 2), default=0.0, nullable=False)
    supply_rate = Column(Numeric(18, 2), default=0.0, nullable=False)
    installation_rate = Column(Numeric(18, 2), default=0.0, nullable=False)
    supply_tax_pct = Column(Numeric(5, 2), default=18.00, nullable=False)
    installation_tax_pct = Column(Numeric(5, 2), default=12.00, nullable=False)
    total_amount = Column(Numeric(18, 2), default=0.0, nullable=False)
    markup = Column(Numeric(18, 2), default=0.0, nullable=True)
    item_code = Column(String(50), nullable=True)
    hsn_sac = Column(String(20), nullable=True)
    cost_code = Column(String(100), nullable=True)
    length = Column(Numeric(18, 4), nullable=True)
    width = Column(Numeric(18, 4), nullable=True)
    height = Column(Numeric(18, 4), nullable=True)
    billed_qty = Column(Numeric(18, 4), default=0.0, nullable=True)
    unbilled_qty = Column(Numeric(18, 4), default=0.0, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class CRMLeadSource(Base):
    """Company-scoped creatable lookup for lead Sources (Website, Referral, ...)."""
    __tablename__ = "crm_lead_sources"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class CRMLeadCategory(Base):
    """Company-scoped creatable lookup for lead Categories."""
    __tablename__ = "crm_lead_categories"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class CRMLeadStatus(Base):
    """Company-scoped creatable lookup for lead Statuses (New Lead, Won, Lost, ...)."""
    __tablename__ = "crm_lead_statuses"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class Payment(Base):
    """Receipts or expense payments recorded for a project."""
    __tablename__ = "payments"
    # R2-543 (Wave: H-verify-sweep): reference_number is unique per company;
    # NULLs are never grouped (Postgres UNIQUE treats NULLs as distinct),
    # matching the router's `if req.reference_number:` 409 guard. Enforced in
    # production via supabase/migrations/20260823_000002_orphan_unique_constraints.sql
    __table_args__ = (
        UniqueConstraint("company_id", "reference_number", name="uq_payments_company_id_reference_number"),
    )
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    party_company_user_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id", ondelete="RESTRICT"), nullable=True)
    payment_type = Column(String(50), nullable=False)  # in, out
    amount = Column(Numeric(18, 2), nullable=False)
    unsettled_amount = Column(Numeric(18, 2), nullable=False)
    payment_method = Column(String(50), nullable=False)  # Cash, Bank Transfer, Cheque
    reference_number = Column(String(100), nullable=True)
    description = Column(String, nullable=True)
    payment_date = Column(DateTime(timezone=True), nullable=False)
    tally_synced = Column(Boolean, default=False, nullable=False)
    approval_pipeline_template_id = Column(String(100), nullable=True)
    account_name = Column(String(255), nullable=True)
    # R2-100/R2-315: optional link to the BankAccount this money moved through;
    # non-cash payments post to BankAccount.balance in-transaction (reversed on
    # delete), so recorded receipts/expenses reach Company Balance (= cash + bank).
    account_id = Column(UUID(as_uuid=True), ForeignKey("bank_accounts.id", ondelete="SET NULL"), nullable=True)
    cost_code = Column(String(100), nullable=True)
    sub_cost_code = Column(String(100), nullable=True)
    category = Column(String(100), nullable=True)
    approval_flag = Column(String(50), default="pending", nullable=False)  # pending, approved
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class PaymentSettlement(Base):
    """Settlement mapping between payments and bills."""
    __tablename__ = "payment_settlements"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    payment_id = Column(UUID(as_uuid=True), ForeignKey("payments.id", ondelete="CASCADE"), nullable=False)
    bill_id = Column(UUID(as_uuid=True), ForeignKey("bills.id", ondelete="CASCADE"), nullable=False)
    settled_amount = Column(Numeric(18, 2), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class TallyConnection(Base):
    """Tally connection profile for a company."""
    __tablename__ = "tally_connections"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), unique=True, nullable=False)
    tally_company_name = Column(String(255), nullable=False)
    registered_mobile = Column(String(20), nullable=False)
    sync_window_start_date = Column(DateTime(timezone=True), nullable=False)
    voucher_number_template = Column(String(100), default="SF-{year}-{number}", nullable=False)
    last_voucher_seq = Column(Integer, default=0, nullable=False)
    auto_create_missing_ledgers = Column(Boolean, default=False, nullable=False)
    round_off_ledger = Column(String(255), nullable=True)
    default_cash_ledger = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)


class TallyAgent(Base):
    """Registered desktop sync agents."""
    __tablename__ = "tally_agents"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    machine_label = Column(String(255), nullable=False)
    auth_key = Column(String(255), unique=True, nullable=False)
    status = Column(String(50), default="active", nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)


class TallyLedgerMapping(Base):
    """Ledger mappings between SiteFlow transaction types and Tally Ledgers."""
    __tablename__ = "tally_ledger_mappings"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    onsite_transaction_type = Column(String(100), nullable=False)  # Material Purchase, Subcon Expense, Sales Invoice
    posting_mode = Column(String(50), default="lumpsum", nullable=False)  # lumpsum, itemwise
    tally_voucher_type = Column(String(100), nullable=False)  # Purchase, Sales, Payment, Receipt, Journal
    tally_ledger_name = Column(String(255), nullable=False)
    freight_ledger = Column(String(255), nullable=True)
    surcharge_ledger = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class TallyPartyMapping(Base):
    """Party ledger mappings."""
    __tablename__ = "tally_party_mappings"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    onsite_party_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id", ondelete="CASCADE"), nullable=False)
    tally_ledger_name = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class TallyCostCentreMapping(Base):
    """Project-to-Cost-Centre mappings."""
    __tablename__ = "tally_cost_centre_mappings"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    tally_cost_centre_name = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class TallyBankMapping(Base):
    """Bank account details to Tally ledger mappings."""
    __tablename__ = "tally_bank_mappings"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    onsite_bank_account_details = Column(String(255), nullable=False)
    tally_ledger_name = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class TallySyncLog(Base):
    """Audit log of Tally XML exports / mark-synced actions per company."""
    __tablename__ = "tally_sync_logs"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    exported_at = Column(DateTime(timezone=True), nullable=True)
    marked_synced_at = Column(DateTime(timezone=True), nullable=True)
    voucher_count = Column(Integer, default=0, nullable=False)
    bill_ids = Column(Text, nullable=True)  # JSON list of exported/marked bill UUIDs
    payment_ids = Column(Text, nullable=True)  # JSON list of exported/marked payment UUIDs
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


# ─────────────────────────────────────────────────────────────────────────────
# Competitor Parity Models
# ─────────────────────────────────────────────────────────────────────────────

class SubcontractorAttendance(Base):
    """Logs subcontractor worker attendance count details per labor role per day."""
    __tablename__ = "subcontractor_attendance_logs"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    subcontractor_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id", ondelete="CASCADE"), nullable=False)
    attendance_date = Column(DateTime(timezone=True), nullable=False)
    labor_role = Column(String(100), nullable=False)  # Mason, Helper, Supervisor, etc.
    worker_count = Column(Integer, default=0, nullable=False)
    shift_multiplier = Column(Numeric(5, 2), default=1.0, nullable=False)
    overtime_hours = Column(Numeric(5, 2), default=0.0, nullable=False)
    allowance = Column(Numeric(18, 2), default=0.0, nullable=False)
    deduction = Column(Numeric(18, 2), default=0.0, nullable=False)
    notes = Column(String, nullable=True)
    photo_url = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class TaskTodo(Base):
    """Checklist item belonging to a planning Task (WBS).

    Boundary with Todo (CD-9 R2-385): TaskTodo is a subtask of a specific
    Task, scoped by task_id, using is_completed boolean. It has no assignees,
    repeat, or company/project scope. Todo is a standalone company or project
    action item with status vocabulary pending/done, assignees via
    TodoAssignee, due_date, repeat_type, and optional linked_task_id. The two
    are different domain objects with distinct lifecycles; do not merge
    vocabularies. Use TaskTodo only under planning tasks via
    /planning/tasks/{task_id}/todos; use Todo for general company/project
    to-dos via /todos. Both survive per CD-9. Verified 2026-08-27: grep
    confirms TaskTodo live in planning.py and frontend gantt, Todo live in
    todos.py and frontend todo pages, no dead class to delete.
    """
    __tablename__ = "task_todos"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    task_id = Column(UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False)
    title = Column(String(255), nullable=False)
    is_completed = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class TaskComment(Base):
    """Activity and progress feed logs under a task/WBS item."""
    __tablename__ = "task_comments"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    task_id = Column(UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id", ondelete="CASCADE"), nullable=False)
    user_name = Column(String(255), nullable=False)
    message_text = Column(String, nullable=True)
    media_url = Column(String, nullable=True)
    voice_note_url = Column(String, nullable=True)
    progress_qty_added = Column(Numeric(18, 4), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class BankAccount(Base):
    __tablename__ = "bank_accounts"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    account_holder_name = Column(String(255), nullable=False)
    bank_name = Column(String(255), nullable=False)
    account_number = Column(String(50), nullable=False)
    ifsc_code = Column(String(20), nullable=False)
    upi_id = Column(String(100), nullable=True)
    balance = Column(Float, default=0.0, nullable=False)
    opening_balance = Column(Float, default=0.0, nullable=False)
    iban = Column(String(100), nullable=True)
    bank_address = Column(String, nullable=True)
    overdraft_limit = Column(Float, default=0.0, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class CashAccount(Base):
    """Company-wide cash wallet; running balance = opening + net cash payments."""
    __tablename__ = "cash_accounts"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), default="Cash Account", nullable=False)
    opening_balance = Column(Float, default=0.0, nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class LeaveRequest(Base):
    __tablename__ = "leave_requests"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    employee_id = Column(UUID(as_uuid=True), ForeignKey("staff_employees.id", ondelete="SET NULL"), nullable=True)
    employee_name = Column(String(255), nullable=False)
    leave_type = Column(String(100), nullable=False) # Sick, Casual, Earned, etc.
    start_date = Column(DateTime(timezone=True), nullable=False)
    end_date = Column(DateTime(timezone=True), nullable=False)
    days_count = Column(Float, nullable=False)
    status = Column(String(50), default="Pending", nullable=False) # Pending, Approved, Rejected
    applied_on = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    reason = Column(Text, nullable=True)


class ApprovalRule(Base):
    __tablename__ = "approval_rules"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    # Set from Settings > Multi Level Approval. Values are the human-readable category labels
    # the UI presents (APPROVAL_CATEGORIES in settings/page.tsx), e.g. "Purchase Order",
    # "Payment Request", "GRN Material" — NOT snake_case identifiers.
    feature_type = Column(String(100), nullable=False)
    min_amount = Column(Float, default=0.0, nullable=False)
    max_amount = Column(Float, nullable=True)
    levels = Column(Integer, default=1, nullable=False)
    approvers = Column(String, nullable=False) # comma-separated emails/names
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class ApprovalAction(Base):
    """Per-level sign-off audit trail for entities gated by an ApprovalRule.

    One row per approve/reject decision. An entity is fully approved once the
    count of action="approved" rows for it reaches the governing rule's
    `levels`. A single action="rejected" row ends the chain immediately.
    """
    __tablename__ = "approval_actions"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    rule_id = Column(UUID(as_uuid=True), ForeignKey("approval_rules.id", ondelete="SET NULL"), nullable=True)
    entity_type = Column(String(50), nullable=False)  # "purchase_order", "payment_request"
    entity_id = Column(UUID(as_uuid=True), nullable=False)
    level = Column(Integer, nullable=False)  # 1-indexed level this action satisfies
    action = Column(String(20), nullable=False)  # approved, rejected
    approver_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    approver_label = Column(String(255), nullable=True)  # the matched entry from ApprovalRule.approvers, for audit
    comment = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class Holiday(Base):
    __tablename__ = "holidays"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    date = Column(DateTime(timezone=True), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class Designation(Base):
    """Company-scoped master-data lookup for employee designations."""
    __tablename__ = "designations"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class LeaveTemplate(Base):
    """Company-scoped leave policy: how many leave days of each type per year."""
    __tablename__ = "leave_templates"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    casual_leave_days = Column(Numeric(5, 1), default=0.0, nullable=False)
    sick_leave_days = Column(Numeric(5, 1), default=0.0, nullable=False)
    earned_leave_days = Column(Numeric(5, 1), default=0.0, nullable=False)
    leave_types = Column(JSONB, nullable=False, default=list)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class SalaryTemplate(Base):
    """Reusable named salary breakup cascade (company-scoped).

    The full computed cascade (monthly CTC, day off, basic %, allowances, gross,
    deductions, net) is stored as JSONB so it can be loaded into the Payroll tab's
    Salary Breakup modal as a template.
    """
    __tablename__ = "salary_templates"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    status = Column(String(20), default="Active", nullable=False)
    breakup = Column(JSONB, nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class PdfTemplate(Base):
    """Reusable named PDF document template (company-scoped)."""
    __tablename__ = "pdf_templates"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    content = Column(Text, nullable=True)
    is_default = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class CompanyTerms(Base):
    """Company-wide Terms & Conditions (one per company).

    Five independently-editable documents: Invoice, Quotation, Subcon Work Order,
    BOQ, and Purchase Order. These are the central source of default T&C text that
    the downstream document forms (Sales Invoice, Subcon Work Order, CRM Quotation)
    should pull from. The legacy `content` field is retained for backward compat.
    """
    __tablename__ = "company_terms"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), unique=True, nullable=False)
    content = Column(Text, nullable=True)
    invoice_terms = Column(Text, nullable=True)
    quotation_terms = Column(Text, nullable=True)
    subcon_terms = Column(Text, nullable=True)
    boq_terms = Column(Text, nullable=True)
    purchase_order_terms = Column(Text, nullable=True)
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)


class PayrollProfile(Base):
    """Per-employee payroll detail + salary breakup, linked 1:1 to StaffEmployee.

    Kept as a separate table (not altering staff_employees) so it is created
    automatically by Base.metadata.create_all without a migration.
    """
    __tablename__ = "payroll_profiles"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    employee_id = Column(UUID(as_uuid=True), ForeignKey("staff_employees.id", ondelete="CASCADE"), nullable=False, unique=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    salary_amount = Column(Numeric(14, 2), default=0.0, nullable=False)
    shift_start = Column(String(10), nullable=True)
    shift_end = Column(String(10), nullable=True)
    shift_hours = Column(Numeric(5, 2), default=8.0, nullable=False)
    overtime_rate = Column(Numeric(14, 2), default=0.0, nullable=False)
    cost_code = Column(String(100), nullable=True)
    leave_template_id = Column(UUID(as_uuid=True), ForeignKey("leave_templates.id", ondelete="SET NULL"), nullable=True)
    salary_breakup = Column(Text, nullable=True)  # JSON string
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)


class PaymentRequest(Base):
    __tablename__ = "payment_requests"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    # R2-052: same column name, same meaning as bills/debit_notes/credit_notes/
    # payments - the counterparty's company_team row, not a login user, so
    # external parties without a platform login can receive payment requests.
    party_company_user_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id"), nullable=False)
    party_name = Column(String(255), nullable=False)
    amount = Column(Float, nullable=False)
    details = Column(String, nullable=True)
    status = Column(String(50), default="Pending", nullable=False) # Pending, Paid, Rejected
    due_date = Column(DateTime(timezone=True), nullable=True)
    approval_status = Column(String(50), default="Pending", nullable=False)  # Pending, Approved, Rejected
    approval_rule_id = Column(UUID(as_uuid=True), ForeignKey("approval_rules.id", ondelete="SET NULL"), nullable=True)
    request_type = Column(String(100), nullable=True)  # Advance, Final, Material, Retention
    request_no = Column(String(50), nullable=True)  # e.g. PR-1
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class PaymentRequestPayment(Base):
    """Recorded actual payment against a PaymentRequest (Cash/Bank/UPI/Cheque)."""
    __tablename__ = "payment_request_payments"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    payment_request_id = Column(UUID(as_uuid=True), ForeignKey("payment_requests.id", ondelete="CASCADE"), nullable=False)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    payment_date = Column(DateTime(timezone=True), nullable=False)
    payment_mode = Column(String(50), nullable=False)  # Cash, Bank, UPI, Cheque
    paid_amount = Column(Float, nullable=False)
    deduction = Column(Float, default=0.0, nullable=False)
    tds = Column(Float, default=0.0, nullable=False)
    balance_due = Column(Float, default=0.0, nullable=False)
    remarks = Column(String, nullable=True)
    reference_no = Column(String(100), nullable=True)
    attachment_name = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

# ─────────────────────────────────────────────────────────────────────────────
# Competitor Parity — Asset Depreciation
# ─────────────────────────────────────────────────────────────────────────────

class AssetDepreciationSchedule(Base):
    """Depreciation schedule configuration per company asset."""
    __tablename__ = "asset_depreciation_schedules"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    asset_id = Column(UUID(as_uuid=True), ForeignKey("equipment.id", ondelete="CASCADE"), nullable=False)
    method = Column(String(50), default="straight_line", nullable=False) # straight_line, reducing_balance, written_down_value
    useful_life_years = Column(Integer, nullable=False)
    salvage_value = Column(Numeric(14, 2), default=0.0, nullable=False)
    depreciation_pct = Column(Numeric(5, 2), default=10.0, nullable=False)
    start_date = Column(DateTime(timezone=True), nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)


class AssetDepreciationEntry(Base):
    """Monthly depreciation ledger entry for an asset."""
    __tablename__ = "asset_depreciation_entries"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    schedule_id = Column(UUID(as_uuid=True), ForeignKey("asset_depreciation_schedules.id", ondelete="CASCADE"), nullable=False)
    asset_id = Column(UUID(as_uuid=True), ForeignKey("equipment.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    entry_date = Column(DateTime(timezone=True), nullable=False)
    depreciation_amount = Column(Numeric(14, 2), nullable=False)
    accumulated_depreciation = Column(Numeric(14, 2), nullable=False)
    book_value = Column(Numeric(14, 2), nullable=False)
    notes = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


# ─────────────────────────────────────────────────────────────────────────────
# Competitor Parity — 3-Way Matching (PO ↔ GRN ↔ Invoice)
# ─────────────────────────────────────────────────────────────────────────────

class ThreeWayMatch(Base):
    """Reconciliation record linking PO, GRN, and Vendor Invoice."""
    __tablename__ = "three_way_matches"
    # R2-594: one reconciliation record per PO/GRN pair — contradictory verdicts
    # for the same receipt must not be able to coexist.
    __table_args__ = (
        UniqueConstraint("po_id", "grn_id", name="uq_three_way_matches_po_grn"),
    )
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    po_id = Column(UUID(as_uuid=True), ForeignKey("purchase_orders.id", ondelete="CASCADE"), nullable=False)
    grn_id = Column(UUID(as_uuid=True), ForeignKey("goods_receipt_notes.id", ondelete="CASCADE"), nullable=False)
    invoice_id = Column(UUID(as_uuid=True), ForeignKey("bills.id", ondelete="SET NULL"), nullable=True)
    match_status = Column(String(50), default="pending", nullable=False) # pending, matched, mismatch, approved, rejected
    po_amount = Column(Numeric(18, 2), nullable=False)
    grn_qty = Column(Numeric(18, 4), nullable=False)
    invoiced_amount = Column(Numeric(18, 2), nullable=False)
    variance_amount = Column(Numeric(18, 2), default=0.0, nullable=False)
    variance_reason = Column(String, nullable=True)
    matched_by = Column(UUID(as_uuid=True), nullable=True)
    matched_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)


# ─────────────────────────────────────────────────────────────────────────────
# Competitor Parity — Material Wastage / Scrap Audit
# ─────────────────────────────────────────────────────────────────────────────

class MaterialWastage(Base):
    """Wastage / scrap / offcut log for materials on a project."""
    __tablename__ = "material_wastage"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    material_name = Column(String(255), nullable=False)
    wastage_type = Column(String(100), nullable=False) # scrap, offcut, damaged, expired, theft
    quantity = Column(Numeric(18, 4), nullable=False)
    unit = Column(String(50), nullable=False)
    estimated_value = Column(Numeric(14, 2), default=0.0, nullable=False)
    reason = Column(String, nullable=True)
    reported_by = Column(UUID(as_uuid=True), ForeignKey("company_team.id", ondelete="SET NULL"), nullable=True)
    photo_urls = Column(JSONB, default=list, nullable=False)
    task_id = Column(UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True)
    status = Column(String(50), default="reported", nullable=False) # reported, reviewed, approved, disposed
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


# ─────────────────────────────────────────────────────────────────────────────
# Competitor Parity — Chat Groups & MOM
# ─────────────────────────────────────────────────────────────────────────────

class ChatGroup(Base):
    """Project-level chat group for site teams."""
    __tablename__ = "chat_groups"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    group_type = Column(String(50), default="general", nullable=False) # general, site, finance, safety
    created_by = Column(UUID(as_uuid=True), ForeignKey("company_team.id"), nullable=True)
    is_archived = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class ChatMessage(Base):
    """Individual message inside a chat group."""
    __tablename__ = "chat_messages"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    group_id = Column(UUID(as_uuid=True), ForeignKey("chat_groups.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id"), nullable=True)
    user_name = Column(String(255), nullable=True)
    message_text = Column(String, nullable=True)
    media_url = Column(String, nullable=True)
    voice_note_url = Column(String, nullable=True)
    image_urls = Column(JSONB, nullable=True)
    is_mom = Column(Boolean, default=False, nullable=False)
    mom_date = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class ChatGroupMember(Base):
    """Member inside a chat group with role-based access."""
    __tablename__ = "chat_group_members"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    group_id = Column(UUID(as_uuid=True), ForeignKey("chat_groups.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id", ondelete="CASCADE"), nullable=False)
    role = Column(String(50), default="member", nullable=False)  # admin, member, viewer
    joined_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    # R2-765: persisted read watermark — NULL means the user has never read this group.
    # Written by POST /chat/groups/{group_id}/read, used by list_groups to compute
    # unread_count. Nullable, additive, no backfill needed.
    last_read_at = Column(DateTime(timezone=True), nullable=True)


# ─────────────────────────────────────────────────────────────────────────────
# Competitor Parity — Custom Fields Engine
# ─────────────────────────────────────────────────────────────────────────────

class CustomField(Base):
    """Dynamic custom field definition for entities."""
    __tablename__ = "custom_fields"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    entity_type = Column(String(100), nullable=False) # project, task, bill, invoice, lead, vendor, customer
    field_name = Column(String(100), nullable=False)
    field_label = Column(String(255), nullable=False)
    field_type = Column(String(50), nullable=False) # text, number, date, select, multiselect, checkbox
    is_required = Column(Boolean, default=False, nullable=False)
    options = Column(JSONB, default=list, nullable=False) # for select/multiselect
    display_order = Column(Integer, default=0, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    default_value = Column(Text, nullable=True) # default value pre-filled on new records
    set_default = Column(Boolean, default=False, server_default="0", nullable=False) # whether a default value is configured
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class CustomFieldValue(Base):
    """Stored value for a custom field on a specific record."""
    __tablename__ = "custom_field_values"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    field_id = Column(UUID(as_uuid=True), ForeignKey("custom_fields.id", ondelete="CASCADE"), nullable=False)
    entity_type = Column(String(100), nullable=False)
    entity_id = Column(UUID(as_uuid=True), nullable=False)
    value_text = Column(String, nullable=True)
    value_number = Column(Numeric(18, 4), nullable=True)
    value_date = Column(DateTime(timezone=True), nullable=True)
    value_json = Column(JSONB, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)


# ─────────────────────────────────────────────────────────────────────────────
# Competitor Parity — Statutory Reports (PF / ESI / BOCW / TDS)
# ─────────────────────────────────────────────────────────────────────────────

class StatutoryReport(Base):
    """PF, ESI, BOCW, TDS monthly return filing records."""
    __tablename__ = "statutory_reports"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    report_type = Column(String(50), nullable=False) # pf, esi, bocw, tds, pt, it
    return_period = Column(String(7), nullable=False) # YYYY-MM
    total_employees = Column(Integer, default=0, nullable=False)
    total_wages = Column(Numeric(18, 2), default=0.0, nullable=False)
    pf_employee_contribution = Column(Numeric(14, 2), default=0.0, nullable=False)
    pf_employer_contribution = Column(Numeric(14, 2), default=0.0, nullable=False)
    esi_employee_contribution = Column(Numeric(14, 2), default=0.0, nullable=False)
    esi_employer_contribution = Column(Numeric(14, 2), default=0.0, nullable=False)
    bocw_cess = Column(Numeric(14, 2), default=0.0, nullable=False)
    tds_deducted = Column(Numeric(14, 2), default=0.0, nullable=False)
    filed_at = Column(DateTime(timezone=True), nullable=True)
    filed_by = Column(String(255), nullable=True)
    acknowledgment_number = Column(String(100), nullable=True)
    status = Column(String(50), default="draft", nullable=False) # draft, filed, overdue
    due_date = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)


# ─────────────────────────────────────────────────────────────────────────────
# Competitor Parity — Face Recognition Attendance Logs
# ─────────────────────────────────────────────────────────────────────────────

class FaceRecognitionLog(Base):
    """Face verification audit trail for attendance punches."""
    __tablename__ = "face_recognition_logs"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    employee_id = Column(UUID(as_uuid=True), ForeignKey("staff_employees.id", ondelete="CASCADE"), nullable=False)
    punch_type = Column(String(10), nullable=False) # in, out
    face_verified = Column(Boolean, default=False, nullable=False)
    confidence_score = Column(Numeric(5, 2), nullable=True)
    image_url = Column(String, nullable=True)
    lat = Column(Numeric(10, 7), nullable=True)
    lng = Column(Numeric(10, 7), nullable=True)
    is_within_geofence = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=True)

# ─────────────────────────────────────────────────────────────────────────────
# Phase 17 — Advanced Subcontractor, Procurement, Labour & Multi-Tower
# ─────────────────────────────────────────────────────────────────────────────

class WorkOrderAmendment(Base):
    __tablename__ = "work_order_amendments"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    wo_id = Column(UUID(as_uuid=True), ForeignKey("work_orders.id", ondelete="CASCADE"), nullable=False)
    amendment_number = Column(Integer, nullable=False)
    amended_fields = Column(JSONB, nullable=False)
    amended_by = Column(String(255), nullable=True)
    amended_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    reason = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class SubcontractorPerformance(Base):
    __tablename__ = "subcontractor_performance"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    subcontractor_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id", ondelete="CASCADE"), nullable=False)
    period_start = Column(DateTime(timezone=True), nullable=False)
    period_end = Column(DateTime(timezone=True), nullable=False)
    on_time_pct = Column(Numeric(5, 2), default=0.0, nullable=False)
    billing_accuracy_pct = Column(Numeric(5, 2), default=0.0, nullable=False)
    quality_score = Column(Numeric(5, 2), default=0.0, nullable=False)
    tasks_completed = Column(Integer, default=0, nullable=False)
    tasks_delayed = Column(Integer, default=0, nullable=False)
    total_billed = Column(Numeric(18, 2), default=0.0, nullable=False)
    disputes_count = Column(Integer, default=0, nullable=False)
    notes = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)

class VendorPerformance(Base):
    __tablename__ = "vendor_performance"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    vendor_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id"), nullable=True)
    vendor_name = Column(String(255), nullable=False)
    total_pos = Column(Integer, default=0, nullable=False)
    total_grns = Column(Integer, default=0, nullable=False)
    on_time_deliveries = Column(Integer, default=0, nullable=False)
    quality_issues = Column(Integer, default=0, nullable=False)
    avg_delay_days = Column(Numeric(5, 2), default=0.0, nullable=False)
    last_updated = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class RFQ(Base):
    __tablename__ = "rfqs"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    rfq_number = Column(String(100), nullable=False)
    status = Column(String(50), default="draft", nullable=False) # draft, sent, closed
    valid_until = Column(DateTime(timezone=True), nullable=True)
    notes = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)

class RFQItem(Base):
    __tablename__ = "rfq_items"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    rfq_id = Column(UUID(as_uuid=True), ForeignKey("rfqs.id", ondelete="CASCADE"), nullable=False)
    material_name = Column(String(255), nullable=False)
    quantity = Column(Numeric(18, 4), nullable=False)
    unit = Column(String(50), nullable=False)
    specifications = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class RFQQuote(Base):
    __tablename__ = "rfq_quotes"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    rfq_id = Column(UUID(as_uuid=True), ForeignKey("rfqs.id", ondelete="CASCADE"), nullable=False)
    vendor_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id"), nullable=True)
    vendor_name = Column(String(255), nullable=False)
    item_id = Column(UUID(as_uuid=True), ForeignKey("rfq_items.id", ondelete="CASCADE"), nullable=False)
    quoted_rate = Column(Numeric(18, 2), nullable=False)
    delivery_days = Column(Integer, nullable=True)
    terms = Column(String, nullable=True)
    validity_days = Column(Integer, default=30, nullable=False)
    submitted_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class ProjectTower(Base):
    __tablename__ = "project_towers"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    tower_name = Column(String(100), nullable=False)
    tower_code = Column(String(50), nullable=False)
    status = Column(String(50), default="Ongoing", nullable=False)
    start_date = Column(DateTime(timezone=True), nullable=True)
    end_date = Column(DateTime(timezone=True), nullable=True)
    budget = Column(Numeric(18, 2), default=0.0, nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class BOCWRecord(Base):
    __tablename__ = "bocw_records"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    contractor_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id"), nullable=True)
    contractor_name = Column(String(255), nullable=False)
    month_year = Column(String(7), nullable=False) # YYYY-MM
    workers_count = Column(Integer, default=0, nullable=False)
    wages_paid = Column(Numeric(18, 2), default=0.0, nullable=False)
    contribution_amount = Column(Numeric(18, 2), default=0.0, nullable=False)
    acknowledgement_number = Column(String(100), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class MusterRoll(Base):
    __tablename__ = "muster_rolls"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    contractor_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id"), nullable=True)
    date = Column(DateTime(timezone=True), nullable=False)
    labor_role = Column(String(100), nullable=False)
    workers_present = Column(Integer, default=0, nullable=False)
    workers_absent = Column(Integer, default=0, nullable=False)
    hours_worked = Column(Numeric(5, 2), default=0.0, nullable=False)
    overtime_hours = Column(Numeric(5, 2), default=0.0, nullable=False)
    notes = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


# ─────────────────────────────────────────────────────────────────────────────
# Competitor Parity — Company Libraries
# ─────────────────────────────────────────────────────────────────────────────

class LibraryParty(Base):
    __tablename__ = "library_parties"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    party_id_custom = Column(String(100), nullable=True) # Prefilled Party ID (e.g. PID-1)
    name = Column(String(255), nullable=False)
    phone = Column(String(50), nullable=True)
    email = Column(String(255), nullable=True)
    party_type = Column(String(100), nullable=True) # e.g. Supplier, Subcontractor, Client
    address = Column(String, nullable=True)
    bank_name = Column(String(255), nullable=True)
    account_name = Column(String(255), nullable=True)
    account_number = Column(String(100), nullable=True)
    ifsc_code = Column(String(20), nullable=True)
    tax_no = Column(String(100), nullable=True)
    date_of_joining = Column(DateTime(timezone=True), nullable=True)
    aadhaar_number = Column(String(50), nullable=True)
    pan_number = Column(String(50), nullable=True)
    esi_number = Column(String(100), nullable=True)
    pf_number = Column(String(100), nullable=True)
    father_name = Column(String(255), nullable=True)
    passport_no = Column(String(100), nullable=True)
    passport_expiry_date = Column(DateTime(timezone=True), nullable=True)
    creator_name = Column(String(255), nullable=True)
    aadhaar_file = Column(String, nullable=True) # file path or name
    pan_file = Column(String, nullable=True) # file path or name
    # Company-level Finance extensions
    contractor_role = Column(String(100), nullable=True)  # role flag for Contractor/Subcontractor parties
    service_rate_categories = Column(Text, nullable=True)  # JSON list of tag strings
    opening_balance = Column(Float, default=0.0, nullable=False)
    opening_balance_type = Column(String(20), nullable=True)  # "pay" (To Pay) / "receive" (Advance Received)
    bank_account_id = Column(UUID(as_uuid=True), ForeignKey("bank_accounts.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class LibraryAssetType(Base):
    __tablename__ = "library_asset_types"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class LibraryCostCode(Base):
    __tablename__ = "library_cost_codes"
    __table_args__ = (
        UniqueConstraint("company_id", "code", name="uq_library_cost_codes_company_id_code"),
    )
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    code = Column(String(100), nullable=False)
    sub_cost_code = Column(String(100), nullable=True)
    parent_id = Column(UUID(as_uuid=True), ForeignKey("library_cost_codes.id", ondelete="CASCADE"), nullable=True)
    name = Column(String(255), nullable=False)
    budget_amount = Column(Numeric(18, 2), default=0.0, nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class LibraryDeduction(Base):
    __tablename__ = "library_deductions"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class LibraryProgress(Base):
    __tablename__ = "library_progresses"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class LibraryWorkforce(Base):
    __tablename__ = "library_workforces"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    rate_type = Column(String(50), nullable=True)
    salary_per_shift = Column(Numeric(12, 2), nullable=True)
    shift_hours = Column(Numeric(6, 2), nullable=True)
    cost_code = Column(String(100), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class LibraryMaterial(Base):
    __tablename__ = "library_materials"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    unit = Column(String(50), nullable=False)
    alternate_unit = Column(String(50), nullable=True)
    gst_rate = Column(Numeric(5, 2), default=0.0, nullable=False)
    category = Column(String(100), nullable=True)
    unit_cost = Column(Numeric(18, 2), default=0.0, nullable=False)
    lead_time_days = Column(Integer, default=0, nullable=False)
    hsn_sac = Column(String(50), nullable=True)
    item_code = Column(String(100), nullable=True)
    specifications = Column(String, nullable=True)
    # The Material Library table has always had a CREATOR NAME column and the
    # model had no field to fill it, so it rendered "-" forever. LibraryParty
    # records this already; mirror it rather than drop a useful column.
    creator_name = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)

class LibraryRate(Base):
    __tablename__ = "library_rates"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    item_code = Column(String(100), nullable=True)
    unit = Column(String(50), nullable=False)
    gst_rate = Column(Numeric(5, 2), default=0.0, nullable=False)
    category = Column(String(100), nullable=True)
    unit_cost = Column(Numeric(18, 2), default=0.0, nullable=False)
    markup_value = Column(Numeric(18, 2), default=0.0, nullable=False)
    markup_type = Column(String(10), default="percent", nullable=False) # percent or flat
    unit_sale_price = Column(Numeric(18, 2), default=0.0, nullable=False)
    note = Column(String, nullable=True)
    cost_code = Column(String(100), nullable=True)
    hsn_sac = Column(String(50), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class LibraryTodo(Base):
    """Canned To Do preset labels for the Library tab (distinct from project-scoped todos)."""
    __tablename__ = "library_todos"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class MoM(Base):
    """Minutes of Meeting (MOM) records captured per company/project site."""
    __tablename__ = "moms"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), index=True, nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), index=True, nullable=True)
    type = Column(String(100), nullable=False, default="Regular")  # Regular, Review, Client Meeting, Internal
    status = Column(String(50), nullable=False, default="Open")    # Open, Closed, Action Pending
    attendees = Column(JSONB, default=list, nullable=False)        # List of attendee names
    notes = Column(String, nullable=True)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


# ─────────────────────────────────────────────────────────────────────────────
# Competitor Parity — Delete Logs (Audit Trail of Deleted Records)
# ─────────────────────────────────────────────────────────────────────────────

class DeleteLog(Base):
    """Company-level audit trail recording deletions of business records."""
    __tablename__ = "delete_logs"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), index=True, nullable=True)
    entity_type = Column(String(50), nullable=False)  # project, task, lead, workorder, material, payment, timesheet
    entity_id = Column(String(255), nullable=False)
    entity_summary = Column(String, nullable=False)   # human-readable, e.g. "Project: Demo Tower"
    party_name = Column(String(255), nullable=True)
    deleted_by = Column(String(255), nullable=True)
    deleted_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class KYCAccessLog(Base):
    """Company-level audit trail recording reads and reveals of KYC identity documents."""
    __tablename__ = "kyc_access_logs"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), index=True, nullable=True)
    party_id = Column(UUID(as_uuid=True), ForeignKey("library_parties.id", ondelete="CASCADE"), index=True, nullable=False)
    party_name = Column(String(255), nullable=True)
    document_type = Column(String(50), nullable=False)  # "aadhaar_file", "pan_file", "aadhaar_number_reveal"
    accessed_by = Column(String(255), nullable=False)
    accessed_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


# ─────────────────────────────────────────────────────────────────────────────
# Project Tab Parity — Foundation tables (Project List, Party, Cost Code, Materials, Todos)
# ─────────────────────────────────────────────────────────────────────────────

class ProjectMember(Base):
    """Project-scoped membership linking a company team member to a project."""
    __tablename__ = "project_members"
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    company_team_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id", ondelete="CASCADE"), primary_key=True)


class ProjectLocation(Base):
    """Hierarchical location/zone structure inside a project (towers, floors, wings)."""
    __tablename__ = "project_locations"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    parent_id = Column(UUID(as_uuid=True), ForeignKey("project_locations.id", ondelete="CASCADE"), nullable=True)
    name = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class ProjectParty(Base):
    """Per-project party linkage with project-scoped balances (Advance Paid / To Pay)."""
    __tablename__ = "project_parties"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    party_id = Column(UUID(as_uuid=True), ForeignKey("library_parties.id", ondelete="CASCADE"), nullable=False)
    balance = Column(Numeric(18, 2), default=0.0, nullable=False)
    advance_paid = Column(Numeric(18, 2), default=0.0, nullable=False)
    to_pay = Column(Numeric(18, 2), default=0.0, nullable=False)
    status = Column(String(50), default="Active", nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class LibraryRetention(Base):
    """Reusable retention presets (mirrors LibraryDeduction)."""
    __tablename__ = "library_retentions"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class MaterialCategory(Base):
    """Hierarchical material categories (creatable, nested)."""
    __tablename__ = "material_categories"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    parent_id = Column(UUID(as_uuid=True), ForeignKey("material_categories.id", ondelete="CASCADE"), nullable=True)
    name = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class Todo(Base):
    """Standalone company or project to-do item.

    Boundary with TaskTodo (CD-9 R2-385): Todo is a company/project scoped
    action item with status vocabulary pending/done, supporting assignees
    via TodoAssignee, due_date, repeat_type, type, url, and optional
    linked_task_id that references a Task without being a child of it.
    TaskTodo is a checklist item strictly under a planning Task, scoped by
    task_id, using is_completed boolean, with no assignees or repeat.
    The two are different domain objects with distinct lifecycles; do not
    merge vocabularies. Use Todo for general action items via /todos;
    use TaskTodo only for per-task checklists. Both survive per CD-9.
    Verified 2026-08-27: grep confirms Todo live in todos.py and frontend
    todo pages, TaskTodo live in planning.py and frontend gantt, no dead
    class to delete.
    """
    __tablename__ = "todos"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("company_team.id", ondelete="SET NULL"), nullable=True)
    title = Column(String(500), nullable=False)
    due_date = Column(DateTime(timezone=True), nullable=True)
    repeat_type = Column(String(50), default="none", nullable=False)  # none, daily, weekly, monthly
    type = Column(String(100), nullable=True)
    linked_task_id = Column(UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True)
    url = Column(String(1024), nullable=True)
    status = Column(String(50), default="pending", nullable=False)  # pending, done
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class TodoAssignee(Base):
    """Many-to-many assignees for a Todo."""
    __tablename__ = "todo_assignees"
    todo_id = Column(UUID(as_uuid=True), ForeignKey("todos.id", ondelete="CASCADE"), primary_key=True)
    assignee_id = Column(UUID(as_uuid=True), ForeignKey("company_team.id", ondelete="CASCADE"), primary_key=True)


class FileFolder(Base):
    """Folder in the project document library (self-referencing for nesting)."""
    __tablename__ = "file_folders"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    parent_id = Column(UUID(as_uuid=True), ForeignKey("file_folders.id", ondelete="CASCADE"), nullable=True)
    name = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class ProjectFile(Base):
    """Uploaded document. Bytes live in Supabase Storage (``storage_path``) when
    configured; otherwise they fall back to the ``data`` bytea column. ``data``
    is kept nullable for the transition period.
    """
    __tablename__ = "project_files"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    folder_id = Column(UUID(as_uuid=True), ForeignKey("file_folders.id", ondelete="CASCADE"), nullable=True)
    name = Column(String(255), nullable=False)
    original_filename = Column(String(512), nullable=False)
    content_type = Column(String(128), nullable=True)
    size = Column(BigInteger, default=0, nullable=False)
    storage_path = Column(String(512), nullable=True)  # object key in Supabase Storage
    data = Column(LargeBinary, nullable=True)  # legacy/fallback BLOB (nullable during migration)
    uploaded_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class GoogleSheetsConnection(Base):
    """OAuth connection linking one company to a Google account for Sheets export.

    One connection per company (company_id is unique). Tokens are stored as-is
    for this proof-of-concept; encrypting them at rest is a follow-up (do not log
    token values anywhere).
    """
    __tablename__ = "google_sheets_connections"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), unique=True, nullable=False)
    access_token = Column(Text, nullable=True)
    refresh_token = Column(Text, nullable=True)
    token_expiry = Column(DateTime(timezone=True), nullable=True)
    connected_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class GoogleDriveConnection(Base):
    """OAuth connection linking one company to a Google account for Drive backup.

    One connection per company (company_id is unique). Access/refresh tokens are
    encrypted at rest via app/crypto.py Fernet. Never log token values.
    """
    __tablename__ = "google_drive_connections"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), unique=True, nullable=False)
    access_token = Column(Text, nullable=True)
    refresh_token = Column(Text, nullable=True)
    token_expiry = Column(DateTime(timezone=True), nullable=True)
    connected_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class ZohoBooksConnection(Base):
    """OAuth connection linking one company to a Zoho Books organization.

    One connection per company (company_id is unique). Access/refresh tokens are
    encrypted at rest via app/crypto.py Fernet. Zoho refresh tokens are
    long-lived but access tokens expire hourly, so the router implements the
    refresh-token grant. The Zoho ``organization_id`` is fetched on connect and
    stored so bill pushes target the right org. Never log token values.
    """
    __tablename__ = "zoho_books_connections"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), unique=True, nullable=False)
    organization_id = Column(String(64), nullable=True)
    access_token = Column(Text, nullable=True)
    refresh_token = Column(Text, nullable=True)
    token_expiry = Column(DateTime(timezone=True), nullable=True)
    connected_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class BiApiKey(Base):
    """Per-company API key for BI data export (PowerBI / Tableau feeds).

    The raw key is shown ONCE on creation; only a hash is stored. Feeds resolve
    the company from the key and only ever read that company's data.
    """
    __tablename__ = "bi_api_keys"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    label = Column(String(120), nullable=False)
    key_hash = Column(String(128), nullable=False)
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    last_used_at = Column(DateTime(timezone=True), nullable=True)
    revoked = Column(Boolean, default=False, nullable=False)


class MarketingLead(Base):
    """A prospect submission from the public marketing site (contact form,
    demo requests, etc). PUBLIC, tenant-less table: these are prospects, not
    customers, so there is no company_id FK.

    Mirrors OTPCode/OAuthHandoff's care around PII: ip_hash stores only an
    HMAC-SHA256 hash of the submitter's IP (keyed by SECRET_KEY, same approach
    as OTP code hashing), never the raw IP, so abuse investigation is possible
    without retaining PII. email_sent records whether the founder notification
    went out, so a mail-provider hiccup never silently loses a lead: the row
    is always written first, the email attempt happens after.
    """
    __tablename__ = "marketing_leads"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(120), nullable=False)
    company = Column(String(200), nullable=True)
    email = Column(String(255), nullable=False, index=True)
    phone = Column(String(32), nullable=True)
    role = Column(String(120), nullable=True)
    sites = Column(String(120), nullable=True)
    message = Column(Text, nullable=True)
    source = Column(String(60), default="contact_form", server_default="contact_form", nullable=False)
    page_url = Column(String(500), nullable=True)
    user_agent = Column(String(400), nullable=True)
    ip_hash = Column(String(128), nullable=True)
    email_sent = Column(Boolean, default=False, server_default="0", nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now(), server_default=func.now(), nullable=False)

