import json
import uuid
from datetime import datetime
from typing import List, Literal, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from sqlalchemy import func
from sqlalchemy.orm import Session
from app.database import get_db
from app.auth import get_current_user, verify_project_in_company, verify_company_access, get_company_membership, require_permission
from app.models import (
    TallyConnection, TallyAgent, TallyLedgerMapping, TallyPartyMapping,
    TallyCostCentreMapping, TallyBankMapping, TallySyncLog,
    Company, Bill, Payment, CompanyTeam, User, LibraryParty, Project,
)
from app.tally_xml import build_tally_envelope
from pydantic import BaseModel
from app.constants import (
    REVENUE_INVOICE_TYPES,
    classify_invoice_type,
    is_expense_invoice_type,
    is_movement_invoice_type,
    is_revenue_invoice_type,
    is_settlement_invoice_type,
    is_settlement_money_in,
)

router = APIRouter(
    prefix="/tally",
    tags=["Tally ERP Integration"],
    dependencies=[Depends(get_current_user)]
)

# Schemas
class ConnectionCreateRequest(BaseModel):
    company_id: uuid.UUID
    tally_company_name: str
    registered_mobile: str
    sync_window_start_date: datetime
    voucher_number_template: str = "SF-{year}-{number}"
    auto_create_missing_ledgers: bool = False
    round_off_ledger: Optional[str] = None
    default_cash_ledger: Optional[str] = None

class ConnectionResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    tally_company_name: str
    registered_mobile: str
    sync_window_start_date: datetime
    voucher_number_template: str
    auto_create_missing_ledgers: bool
    round_off_ledger: Optional[str]
    default_cash_ledger: Optional[str]
    created_at: datetime

    class Config:
        from_attributes = True

class AgentCreateRequest(BaseModel):
    company_id: uuid.UUID
    machine_label: str
    auth_key: str

class AgentUpdateRequest(BaseModel):
    machine_label: Optional[str] = None
    auth_key: Optional[str] = None
    status: Optional[str] = None

class AgentResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    machine_label: str
    auth_key: str
    status: str
    created_at: datetime

    class Config:
        from_attributes = True

class LedgerMappingCreateRequest(BaseModel):
    company_id: uuid.UUID
    onsite_transaction_type: Literal["Material Purchase", "Subcon Expense", "Sales Invoice"]
    posting_mode: str = "lumpsum"
    tally_voucher_type: Literal["Sales", "Purchase", "Receipt", "Payment", "Journal"]
    tally_ledger_name: str
    freight_ledger: Optional[str] = None
    surcharge_ledger: Optional[str] = None

class LedgerMappingUpdateRequest(BaseModel):
    onsite_transaction_type: Optional[Literal["Material Purchase", "Subcon Expense", "Sales Invoice"]] = None
    posting_mode: Optional[str] = None
    tally_voucher_type: Optional[Literal["Sales", "Purchase", "Receipt", "Payment", "Journal"]] = None
    tally_ledger_name: Optional[str] = None
    freight_ledger: Optional[str] = None
    surcharge_ledger: Optional[str] = None

class LedgerMappingResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    onsite_transaction_type: str
    posting_mode: str
    tally_voucher_type: str
    tally_ledger_name: str
    freight_ledger: Optional[str]
    surcharge_ledger: Optional[str]

    class Config:
        from_attributes = True

class PartyMappingCreateRequest(BaseModel):
    company_id: uuid.UUID
    onsite_party_id: uuid.UUID
    tally_ledger_name: str

class PartyMappingUpdateRequest(BaseModel):
    onsite_party_id: Optional[uuid.UUID] = None
    tally_ledger_name: Optional[str] = None

class PartyMappingResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    onsite_party_id: uuid.UUID
    tally_ledger_name: str

    class Config:
        from_attributes = True

class CostCentreMappingCreateRequest(BaseModel):
    company_id: uuid.UUID
    project_id: uuid.UUID
    tally_cost_centre_name: str

class CostCentreMappingUpdateRequest(BaseModel):
    project_id: Optional[uuid.UUID] = None
    tally_cost_centre_name: Optional[str] = None

class CostCentreMappingResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    project_id: uuid.UUID
    tally_cost_centre_name: str

    class Config:
        from_attributes = True

class BankMappingCreateRequest(BaseModel):
    company_id: uuid.UUID
    onsite_bank_account_details: str
    tally_ledger_name: str

class BankMappingUpdateRequest(BaseModel):
    onsite_bank_account_details: Optional[str] = None
    tally_ledger_name: Optional[str] = None

class BankMappingResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    onsite_bank_account_details: str
    tally_ledger_name: str

    class Config:
        from_attributes = True

class ConnectionUpdateRequest(BaseModel):
    tally_company_name: Optional[str] = None
    registered_mobile: Optional[str] = None
    sync_window_start_date: Optional[datetime] = None
    voucher_number_template: Optional[str] = None
    auto_create_missing_ledgers: Optional[bool] = None
    round_off_ledger: Optional[str] = None
    default_cash_ledger: Optional[str] = None

class MarkSyncedRequest(BaseModel):
    bill_ids: List[uuid.UUID] = []
    payment_ids: List[uuid.UUID] = []

class SyncLogResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    exported_at: Optional[datetime]
    marked_synced_at: Optional[datetime]
    voucher_count: int
    created_at: datetime

    class Config:
        from_attributes = True


# --- Helpers ---

def _resolve_party_ledger(db: Session, company_id: uuid.UUID, party_company_user_id, default: str) -> str:
    if party_company_user_id:
        pm = db.query(TallyPartyMapping).filter(
            TallyPartyMapping.company_id == company_id,
            TallyPartyMapping.onsite_party_id == party_company_user_id,
        ).first()
        if pm:
            return pm.tally_ledger_name
        member = db.query(CompanyTeam).filter(CompanyTeam.id == party_company_user_id).first()
        if member:
            # User-backed rows resolve to the member's display name.
            if member.user_id:
                user = db.query(User).filter(User.id == member.user_id).first()
                if user and user.name:
                    return user.name
            # Userless subcontractors (no login) fall back to the linked
            # LibraryParty name so the ledger shows the real vendor, not "Vendor".
            if member.library_party_id:
                party = db.query(LibraryParty).filter(LibraryParty.id == member.library_party_id).first()
                if party and party.name:
                    return party.name
    return default


def _render_number(template: str, source, year: int, seq: int) -> str:
    if source:
        return str(source)
    try:
        return template.format(year=year, number=seq)
    except Exception:
        return f"{year}-{seq}"


def _cash_bank_type(name: str, default_cash: Optional[str]) -> str:
    if name == default_cash:
        return "cash"
    return "cash" if "cash" in (name or "").lower() else "bank"


def _bill_gst_split(db: Session, company_id, bill):
    """R2-744: the D4 tax split for one bill, as (cgst, sgst, igst, utgst).

    Place of supply derives from Project.state (the site) versus the supplier
    GSTIN prefix, per IGST Act s.12(3). reports.py, the CRM quotations and the
    invoice PDF all resolve it this way; tally.py used to split every supply
    into unconditional 50/50 CGST/SGST halves, so an inter-state works contract
    was exported under heads the GSTR-2B reconciliation will not match.

    This mirrors _rep_gstr1_sales (reports.py:1130-1143) exactly -- same
    project state, same branch-GSTIN precedence, same helper -- so the export
    cannot drift from the return again.
    """
    project = (
        db.query(Project).filter(Project.id == bill.project_id).first()
        if bill.project_id else None
    )
    supplier_gstin = None
    try:
        comp = db.query(Company).filter(Company.id == company_id).first()
        supplier_gstin = getattr(comp, "gstin", None)
        # A branch GSTIN wins when the document masthead resolves to a branch.
        if project and getattr(project, "branch_id", None):
            from app.models import CompanyBranch as _Br
            br = db.query(_Br).filter(_Br.id == project.branch_id).first()
            if br and getattr(br, "gstin", None):
                supplier_gstin = br.gstin
    except Exception:
        supplier_gstin = None

    try:
        from app.gst_utils import gst_split as _d4_split
        return _d4_split(
            bill.gst_amount,
            getattr(project, "state", None) if project else None,
            supplier_gstin,
        )
    except Exception:
        # Pre-D4 halves, so an unexpected helper failure still balances.
        tax = float(bill.gst_amount or 0.0)
        half = round(tax / 2.0, 2)
        return half, round(tax - half, 2), 0.0, 0.0


def _gst_tax_entries(db: Session, company_id, bill, prefix, debit):
    """Emit the tax legs for a bill: IGST whole, or CGST/SGST halves.

    `prefix` is "Output" for a sale and "Input" for a purchase.
    """
    cgst, sgst, igst, utgst = _bill_gst_split(db, company_id, bill)
    legs = []
    if igst:
        legs.append({"ledger": f"{prefix} IGST", "amount": igst, "debit": debit,
                     "ledger_type": "output_tax" if prefix == "Output" else "input_tax"})
    else:
        if cgst:
            legs.append({"ledger": f"{prefix} CGST", "amount": cgst, "debit": debit,
                         "ledger_type": "output_tax" if prefix == "Output" else "input_tax"})
        if sgst:
            legs.append({"ledger": f"{prefix} SGST", "amount": sgst, "debit": debit,
                         "ledger_type": "output_tax" if prefix == "Output" else "input_tax"})
    # app.gst_utils returns 0.0 for UTGST today; emitted when it ever is not, so
    # a union-territory supply cannot silently lose its tax.
    if utgst:
        legs.append({"ledger": f"{prefix} UTGST", "amount": utgst, "debit": debit,
                     "ledger_type": "output_tax" if prefix == "Output" else "input_tax"})
    return legs


def _build_vouchers(db: Session, conn: TallyConnection, bills, payments, advance_sequence: bool = False):
    """Resolve Bill + Payment rows into Tally voucher dicts (double entry).

    Voucher numbers use a durable, per-company monotonic counter
    (`conn.last_voucher_seq`) so numbers never repeat across confirmed syncs.
    This helper NEVER consumes the counter: both `/pending` and `/export`
    render the same preview numbers on every call until the import is
    confirmed via `/mark-synced`, which is what advances it (R2-369). A
    re-downloaded file therefore carries identical voucher numbers instead of
    re-numbering the same economic events past Tally's duplicate detection.
    The `advance_sequence` flag is kept for backwards compatibility and no
    longer has any effect.
    """
    vouchers = []
    pending = []

    ledger_map = {
        m.onsite_transaction_type: m
        for m in db.query(TallyLedgerMapping).filter(TallyLedgerMapping.company_id == conn.company_id).all()
    }
    cc_map = {
        str(m.project_id): m.tally_cost_centre_name
        for m in db.query(TallyCostCentreMapping).filter(TallyCostCentreMapping.company_id == conn.company_id).all()
    }
    bank_maps = {
        m.onsite_bank_account_details: m.tally_ledger_name
        for m in db.query(TallyBankMapping).filter(TallyBankMapping.company_id == conn.company_id).all()
    }

    seq = (conn.last_voucher_seq or 0) + 1

    for b in bills:
        total = float(b.total_payable or 0)
        cost_centre = cc_map.get(str(b.project_id)) if b.project_id else None
        year = b.invoice_date.year if b.invoice_date else datetime.utcnow().year
        date_str = b.invoice_date.strftime("%Y%m%d") if b.invoice_date else ""
        vnumber = _render_number(conn.voucher_number_template, b.invoice_number, year, seq)

        if is_settlement_invoice_type(b.invoice_type):
            # D3: settlement rows move money, not goods - money-in bills are
            # Receipt vouchers and money-out are Payment vouchers, never
            # Purchase/Sales. Routed through the single shared classifier.
            money_in = is_settlement_money_in(b.invoice_type)
            vchtype = "Receipt" if money_in else "Payment"
            cash_ledger = (
                bank_maps.get(b.payment_bank_name)
                if b.payment_bank_name
                else None
            ) or conn.default_cash_ledger or "Bank/Cash"
            party_ledger = _resolve_party_ledger(
                db, conn.company_id, b.party_company_user_id,
                "Client Ledger" if money_in else "Vendor Ledger",
            )
            narration = f"SiteFlow {b.invoice_type} settlement {b.invoice_number}."
            if money_in:
                entries = [
                    {"ledger": cash_ledger, "amount": total, "debit": True, "ledger_type": _cash_bank_type(cash_ledger, conn.default_cash_ledger)},
                    {"ledger": party_ledger, "amount": total, "debit": False, "ledger_type": "party_debtor"},
                ]
            else:
                entries = [
                    {"ledger": party_ledger, "amount": total, "debit": True, "ledger_type": "party_creditor"},
                    {"ledger": cash_ledger, "amount": total, "debit": False, "ledger_type": _cash_bank_type(cash_ledger, conn.default_cash_ledger)},
                ]
        elif is_revenue_invoice_type(b.invoice_type):
            vchtype = "Sales"
            ledger_key = "Sales Invoice"
            fallback_ledger = "Sales A/c"
            party_default = "Client Ledger"
            mapped = ledger_map.get(ledger_key)
            expense_ledger = mapped.tally_ledger_name if mapped else fallback_ledger
            party_ledger = _resolve_party_ledger(db, conn.company_id, b.party_company_user_id, party_default)
            narration = f"SiteFlow {b.invoice_type} invoice {b.invoice_number}."
        elif is_expense_invoice_type(b.invoice_type):
            vchtype = "Purchase"
            ledger_key = "Subcon Expense" if b.invoice_type == "subcon" else "Material Purchase"
            fallback_ledger = "Purchase A/c"
            party_default = "Vendor Ledger"
            mapped = ledger_map.get(ledger_key)
            expense_ledger = mapped.tally_ledger_name if mapped else fallback_ledger
            party_ledger = _resolve_party_ledger(db, conn.company_id, b.party_company_user_id, party_default)
            narration = f"SiteFlow {b.invoice_type} invoice {b.invoice_number}."
        else:
            # D3: movement (material_transfer/material_return) and unknown
            # types are not financial accruals - they do not book revenue or
            # cost. Previously they fell through to Purchase and leaked stock
            # movements into cost. Now classified explicitly and skipped for
            # Tally financial export.
            if is_movement_invoice_type(b.invoice_type):
                continue
            continue

        if is_settlement_invoice_type(b.invoice_type):
            # D3: settlement is a cash movement, not a taxable supply.
            # Entries were built above and must not be overwritten by the
            # Sales/Purchase GST splitting below.
            pass
        elif vchtype == "Sales":
            # Sale: the customer now owes us, so DEBIT the party (Sundry
            # Debtor, receivable up) and CREDIT the sales ledger (revenue up).
            # The mirror image (Dr Sales / Cr Debtor) would understate both
            # revenue and receivables, so the debit/credit flags are inverted
            # relative to the purchase branch below.
            #
            # R2-410: revenue is posted at the tax-exclusive base and the GST
            # goes to Output tax ledgers under Duties & Taxes - posting the
            # gross figure on the sales leg booked the output liability as
            # turnover.
            #
            # R2-744: the tax HEAD follows D4, not a fixed convention. The
            # comment that used to sit here claimed the 50/50 halves "follow the
            # same documented convention as reports._gst_split (no
            # place-of-supply column)". Both clauses were false: reports.
            # _gst_split takes project_state and supplier_gstin and documents
            # itself as "Never unconditional 50/50", and the place-of-supply
            # column the comment said does not exist is the one the rest of the
            # system is now validated against. That comment is why this site
            # looked already-considered.
            gst = float(b.gst_amount or 0.0)
            net = round(total - gst, 2)
            entries = [
                {"ledger": expense_ledger, "amount": net, "debit": False, "cost_centre": cost_centre,
                 "ledger_type": "sales"},
                {"ledger": party_ledger, "amount": total, "debit": True,
                 "ledger_type": "party_debtor"},
            ]
            if gst > 0:
                entries.extend(_gst_tax_entries(db, conn.company_id, b, "Output", debit=False))
        else:
            # Purchase / subcon: debit the expense ledger, credit the party.
            # R2-410: the expense is the tax-exclusive base and the GST is
            # debited to Input tax ledgers under Duties & Taxes, so input
            # credit reaches the ledger GSTR reconciliation reads instead of
            # being expensed into the P&L.
            gst = float(b.gst_amount or 0.0)
            net = round(total - gst, 2)
            entries = [
                {"ledger": expense_ledger, "amount": net, "debit": True, "cost_centre": cost_centre,
                 "ledger_type": "purchase"},
                {"ledger": party_ledger, "amount": total, "debit": False,
                 "ledger_type": "party_creditor"},
            ]
            if gst > 0:
                # R2-744: same D4 split as the sales branch -- an inter-state
                # purchase takes input credit as IGST, under the head the return
                # will report.
                entries.extend(_gst_tax_entries(db, conn.company_id, b, "Input", debit=True))
        vouchers.append({
            "vchtype": vchtype,
            "voucher_type_name": vchtype,
            "voucher_number": vnumber,
            "reference": b.invoice_number,
            "date": date_str,
            "party_ledger_name": party_ledger,
            "narration": narration,
            "entries": entries,
        })
        pending.append({
            "type": vchtype,
            "number": vnumber,
            "party": party_ledger,
            "amount": total,
            "date": date_str,
        })
        seq += 1

    for p in payments:
        total = float(p.amount or 0)
        if p.payment_type == "in":
            vchtype = "Receipt"
            # Money comes IN: debit bank/cash, credit party. The bank/cash
            # ledger follows the payment's own account when a bank mapping
            # exists for it, so payments from different accounts post to
            # different ledgers instead of one shared CASH ledger.
            cash_ledger = (
                bank_maps.get(p.account_name)
                if p.account_name
                else None
            ) or conn.default_cash_ledger or "Bank/Cash"
            party_ledger = _resolve_party_ledger(db, conn.company_id, p.party_company_user_id, cash_ledger)
            entries = [
                {"ledger": cash_ledger, "amount": total, "debit": True, "ledger_type": _cash_bank_type(cash_ledger, conn.default_cash_ledger)},
                {"ledger": party_ledger, "amount": total, "debit": False, "ledger_type": "party_debtor"},
            ]
        else:
            vchtype = "Payment"
            # Money goes OUT: debit party, credit bank/cash.
            cash_ledger = (
                bank_maps.get(p.account_name)
                if p.account_name
                else None
            ) or conn.default_cash_ledger or "Bank/Cash"
            party_ledger = _resolve_party_ledger(db, conn.company_id, p.party_company_user_id, cash_ledger)
            entries = [
                {"ledger": party_ledger, "amount": total, "debit": True, "ledger_type": "party_creditor"},
                {"ledger": cash_ledger, "amount": total, "debit": False, "ledger_type": _cash_bank_type(cash_ledger, conn.default_cash_ledger)},
            ]

        year = p.payment_date.year if p.payment_date else datetime.utcnow().year
        date_str = p.payment_date.strftime("%Y%m%d") if p.payment_date else ""
        vnumber = _render_number(conn.voucher_number_template, p.reference_number, year, seq)
        narration = p.description or f"SiteFlow {p.payment_type} payment."

        vouchers.append({
            "vchtype": vchtype,
            "voucher_type_name": vchtype,
            "voucher_number": vnumber,
            "reference": p.reference_number,
            "date": date_str,
            "party_ledger_name": party_ledger,
            "narration": narration,
            "entries": entries,
        })
        pending.append({
            "type": vchtype,
            "number": vnumber,
            "party": party_ledger,
            "amount": total,
            "date": date_str,
        })
        seq += 1

    if advance_sequence and (bills or payments):
        conn.last_voucher_seq = seq - 1
        db.add(conn)
        db.commit()

    return vouchers, pending


# --- Connection ---

@router.post("/connections", response_model=ConnectionResponse, status_code=status.HTTP_201_CREATED)
def create_connection(req: ConnectionCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    comp_uuid = uuid.UUID(str(req.company_id))
    get_company_membership(db, current_user, comp_uuid)
    require_permission(db, current_user, comp_uuid, "settings:manage")
    company = db.query(Company).filter(Company.id == comp_uuid).first()
    if not company:
        raise HTTPException(status_code=404, detail="Company not found")

    conn = db.query(TallyConnection).filter(TallyConnection.company_id == comp_uuid).first()
    if conn:
        conn.tally_company_name = req.tally_company_name
        conn.registered_mobile = req.registered_mobile
        conn.sync_window_start_date = req.sync_window_start_date
        conn.voucher_number_template = req.voucher_number_template
        conn.auto_create_missing_ledgers = req.auto_create_missing_ledgers
        conn.round_off_ledger = req.round_off_ledger
        conn.default_cash_ledger = req.default_cash_ledger
    else:
        conn = TallyConnection(
            id=uuid.uuid4(),
            company_id=comp_uuid,
            tally_company_name=req.tally_company_name,
            registered_mobile=req.registered_mobile,
            sync_window_start_date=req.sync_window_start_date,
            voucher_number_template=req.voucher_number_template,
            auto_create_missing_ledgers=req.auto_create_missing_ledgers,
            round_off_ledger=req.round_off_ledger,
            default_cash_ledger=req.default_cash_ledger,
        )
        db.add(conn)

    db.commit()
    db.refresh(conn)
    return conn


@router.get("/connections")
def get_connection(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    comp_uuid = uuid.UUID(str(company_id))
    conn = db.query(TallyConnection).filter(TallyConnection.company_id == comp_uuid).first()
    if not conn:
        return {"connected": False}
    return conn


@router.put("/connections/{conn_id}", response_model=ConnectionResponse)
def update_connection(conn_id: uuid.UUID, req: ConnectionUpdateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    conn = db.query(TallyConnection).filter(TallyConnection.id == conn_id).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Tally connection not found")
    get_company_membership(db, current_user, conn.company_id)
    require_permission(db, current_user, conn.company_id, "settings:manage")
    for k, v in req.model_dump(exclude_unset=True).items():
        setattr(conn, k, v)
    db.commit()
    db.refresh(conn)
    return conn


@router.delete("/connections/{conn_id}")
def delete_connection(conn_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    conn = db.query(TallyConnection).filter(TallyConnection.id == conn_id).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Tally connection not found")
    get_company_membership(db, current_user, conn.company_id)
    require_permission(db, current_user, conn.company_id, "settings:manage")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, conn.company_id, "tally_connection", conn.id, f"Tally Connection: {conn.tally_company_name}", deleted_by=current_user.name)
    db.delete(conn)
    db.commit()
    return {"success": True}


# --- Agents ---

@router.post("/agents", response_model=AgentResponse, status_code=status.HTTP_201_CREATED)
def register_agent(req: AgentCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    comp_uuid = uuid.UUID(str(req.company_id))
    get_company_membership(db, current_user, comp_uuid)
    require_permission(db, current_user, comp_uuid, "settings:manage")
    agent = TallyAgent(
        id=uuid.uuid4(),
        company_id=comp_uuid,
        machine_label=req.machine_label,
        auth_key=req.auth_key,
        status="active",
    )
    db.add(agent)
    db.commit()
    db.refresh(agent)
    return agent


@router.get("/agents", response_model=List[AgentResponse])
def get_agents(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    comp_uuid = uuid.UUID(str(company_id))
    return db.query(TallyAgent).filter(TallyAgent.company_id == comp_uuid).all()


@router.put("/agents/{agent_id}", response_model=AgentResponse)
def update_agent(agent_id: uuid.UUID, req: AgentUpdateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    agent = db.query(TallyAgent).filter(TallyAgent.id == agent_id).first()
    if not agent:
        raise HTTPException(status_code=404, detail="Tally agent not found")
    get_company_membership(db, current_user, agent.company_id)
    require_permission(db, current_user, agent.company_id, "settings:manage")
    for k, v in req.model_dump(exclude_unset=True).items():
        setattr(agent, k, v)
    db.commit()
    db.refresh(agent)
    return agent


@router.delete("/agents/{agent_id}")
def delete_agent(agent_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    agent = db.query(TallyAgent).filter(TallyAgent.id == agent_id).first()
    if not agent:
        raise HTTPException(status_code=404, detail="Tally agent not found")
    get_company_membership(db, current_user, agent.company_id)
    require_permission(db, current_user, agent.company_id, "settings:manage")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, agent.company_id, "tally_agent", agent.id, f"Tally Agent: {agent.machine_label}", deleted_by=current_user.name)
    db.delete(agent)
    db.commit()
    return {"success": True}


# --- Ledger mappings ---

@router.post("/mappings/ledger", response_model=LedgerMappingResponse, status_code=status.HTTP_201_CREATED)
def create_ledger_mapping(req: LedgerMappingCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    comp_uuid = uuid.UUID(str(req.company_id))
    get_company_membership(db, current_user, comp_uuid)
    require_permission(db, current_user, comp_uuid, "settings:manage")

    mapping = db.query(TallyLedgerMapping).filter(
        TallyLedgerMapping.company_id == comp_uuid,
        TallyLedgerMapping.onsite_transaction_type == req.onsite_transaction_type,
    ).first()

    if mapping:
        mapping.posting_mode = req.posting_mode
        mapping.tally_voucher_type = req.tally_voucher_type
        mapping.tally_ledger_name = req.tally_ledger_name
        mapping.freight_ledger = req.freight_ledger
        mapping.surcharge_ledger = req.surcharge_ledger
    else:
        mapping = TallyLedgerMapping(
            id=uuid.uuid4(),
            company_id=comp_uuid,
            onsite_transaction_type=req.onsite_transaction_type,
            posting_mode=req.posting_mode,
            tally_voucher_type=req.tally_voucher_type,
            tally_ledger_name=req.tally_ledger_name,
            freight_ledger=req.freight_ledger,
            surcharge_ledger=req.surcharge_ledger,
        )
        db.add(mapping)

    db.commit()
    db.refresh(mapping)
    return mapping


@router.get("/mappings/ledger", response_model=List[LedgerMappingResponse])
def get_ledger_mappings(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    comp_uuid = uuid.UUID(str(company_id))
    return db.query(TallyLedgerMapping).filter(TallyLedgerMapping.company_id == comp_uuid).all()


@router.put("/mappings/ledger/{map_id}", response_model=LedgerMappingResponse)
def update_ledger_mapping(map_id: uuid.UUID, req: LedgerMappingUpdateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    mapping = db.query(TallyLedgerMapping).filter(TallyLedgerMapping.id == map_id).first()
    if not mapping:
        raise HTTPException(status_code=404, detail="Ledger mapping not found")
    get_company_membership(db, current_user, mapping.company_id)
    require_permission(db, current_user, mapping.company_id, "settings:manage")
    for k, v in req.model_dump(exclude_unset=True).items():
        setattr(mapping, k, v)
    db.commit()
    db.refresh(mapping)
    return mapping


@router.delete("/mappings/ledger/{map_id}")
def delete_ledger_mapping(map_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    mapping = db.query(TallyLedgerMapping).filter(TallyLedgerMapping.id == map_id).first()
    if not mapping:
        raise HTTPException(status_code=404, detail="Ledger mapping not found")
    get_company_membership(db, current_user, mapping.company_id)
    require_permission(db, current_user, mapping.company_id, "settings:manage")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, mapping.company_id, "tally_ledger_mapping", mapping.id, f"Tally Ledger Mapping: {mapping.onsite_transaction_type}", deleted_by=current_user.name)
    db.delete(mapping)
    db.commit()
    return {"success": True}


# --- Party mappings ---

@router.post("/mappings/party", response_model=PartyMappingResponse, status_code=status.HTTP_201_CREATED)
def create_party_mapping(req: PartyMappingCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    comp_uuid = uuid.UUID(str(req.company_id))
    get_company_membership(db, current_user, comp_uuid)
    require_permission(db, current_user, comp_uuid, "settings:manage")

    mapping = db.query(TallyPartyMapping).filter(
        TallyPartyMapping.company_id == comp_uuid,
        TallyPartyMapping.onsite_party_id == req.onsite_party_id,
    ).first()

    if mapping:
        mapping.tally_ledger_name = req.tally_ledger_name
    else:
        mapping = TallyPartyMapping(
            id=uuid.uuid4(),
            company_id=comp_uuid,
            onsite_party_id=req.onsite_party_id,
            tally_ledger_name=req.tally_ledger_name,
        )
        db.add(mapping)

    db.commit()
    db.refresh(mapping)
    return mapping


@router.get("/mappings/party", response_model=List[PartyMappingResponse])
def get_party_mappings(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    comp_uuid = uuid.UUID(str(company_id))
    return db.query(TallyPartyMapping).filter(TallyPartyMapping.company_id == comp_uuid).all()


@router.put("/mappings/party/{map_id}", response_model=PartyMappingResponse)
def update_party_mapping(map_id: uuid.UUID, req: PartyMappingUpdateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    mapping = db.query(TallyPartyMapping).filter(TallyPartyMapping.id == map_id).first()
    if not mapping:
        raise HTTPException(status_code=404, detail="Party mapping not found")
    get_company_membership(db, current_user, mapping.company_id)
    require_permission(db, current_user, mapping.company_id, "settings:manage")
    for k, v in req.model_dump(exclude_unset=True).items():
        setattr(mapping, k, v)
    db.commit()
    db.refresh(mapping)
    return mapping


@router.delete("/mappings/party/{map_id}")
def delete_party_mapping(map_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    mapping = db.query(TallyPartyMapping).filter(TallyPartyMapping.id == map_id).first()
    if not mapping:
        raise HTTPException(status_code=404, detail="Party mapping not found")
    get_company_membership(db, current_user, mapping.company_id)
    require_permission(db, current_user, mapping.company_id, "settings:manage")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, mapping.company_id, "tally_party_mapping", mapping.id, f"Tally Party Mapping: {mapping.tally_ledger_name}", deleted_by=current_user.name)
    db.delete(mapping)
    db.commit()
    return {"success": True}


# --- Cost centre mappings ---

@router.post("/mappings/cost-centre", response_model=CostCentreMappingResponse, status_code=status.HTTP_201_CREATED)
def create_cost_centre_mapping(req: CostCentreMappingCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    comp_uuid = uuid.UUID(str(req.company_id))
    get_company_membership(db, current_user, comp_uuid)
    verify_project_in_company(db, req.project_id, comp_uuid)
    require_permission(db, current_user, comp_uuid, "settings:manage")

    mapping = db.query(TallyCostCentreMapping).filter(
        TallyCostCentreMapping.company_id == comp_uuid,
        TallyCostCentreMapping.project_id == req.project_id,
    ).first()

    if mapping:
        mapping.tally_cost_centre_name = req.tally_cost_centre_name
    else:
        mapping = TallyCostCentreMapping(
            id=uuid.uuid4(),
            company_id=comp_uuid,
            project_id=req.project_id,
            tally_cost_centre_name=req.tally_cost_centre_name,
        )
        db.add(mapping)

    db.commit()
    db.refresh(mapping)
    return mapping


@router.get("/mappings/cost-centre", response_model=List[CostCentreMappingResponse])
def get_cost_centre_mappings(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    comp_uuid = uuid.UUID(str(company_id))
    return db.query(TallyCostCentreMapping).filter(TallyCostCentreMapping.company_id == comp_uuid).all()


@router.put("/mappings/cost-centre/{map_id}", response_model=CostCentreMappingResponse)
def update_cost_centre_mapping(map_id: uuid.UUID, req: CostCentreMappingUpdateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    mapping = db.query(TallyCostCentreMapping).filter(TallyCostCentreMapping.id == map_id).first()
    if not mapping:
        raise HTTPException(status_code=404, detail="Cost centre mapping not found")
    get_company_membership(db, current_user, mapping.company_id)
    require_permission(db, current_user, mapping.company_id, "settings:manage")
    if req.project_id:
        verify_project_in_company(db, req.project_id, mapping.company_id)
    for k, v in req.model_dump(exclude_unset=True).items():
        setattr(mapping, k, v)
    db.commit()
    db.refresh(mapping)
    return mapping


@router.delete("/mappings/cost-centre/{map_id}")
def delete_cost_centre_mapping(map_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    mapping = db.query(TallyCostCentreMapping).filter(TallyCostCentreMapping.id == map_id).first()
    if not mapping:
        raise HTTPException(status_code=404, detail="Cost centre mapping not found")
    get_company_membership(db, current_user, mapping.company_id)
    require_permission(db, current_user, mapping.company_id, "settings:manage")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, mapping.company_id, "tally_cost_centre_mapping", mapping.id, f"Tally Cost Centre Mapping: {mapping.tally_cost_centre_name}", deleted_by=current_user.name)
    db.delete(mapping)
    db.commit()
    return {"success": True}


# --- Bank mappings ---

@router.post("/mappings/bank", response_model=BankMappingResponse, status_code=status.HTTP_201_CREATED)
def create_bank_mapping(req: BankMappingCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    comp_uuid = uuid.UUID(str(req.company_id))
    get_company_membership(db, current_user, comp_uuid)
    require_permission(db, current_user, comp_uuid, "settings:manage")

    mapping = db.query(TallyBankMapping).filter(
        TallyBankMapping.company_id == comp_uuid,
        TallyBankMapping.onsite_bank_account_details == req.onsite_bank_account_details,
    ).first()

    if mapping:
        mapping.tally_ledger_name = req.tally_ledger_name
    else:
        mapping = TallyBankMapping(
            id=uuid.uuid4(),
            company_id=comp_uuid,
            onsite_bank_account_details=req.onsite_bank_account_details,
            tally_ledger_name=req.tally_ledger_name,
        )
        db.add(mapping)

    db.commit()
    db.refresh(mapping)
    return mapping


@router.get("/mappings/bank", response_model=List[BankMappingResponse])
def get_bank_mappings(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    comp_uuid = uuid.UUID(str(company_id))
    return db.query(TallyBankMapping).filter(TallyBankMapping.company_id == comp_uuid).all()


@router.put("/mappings/bank/{map_id}", response_model=BankMappingResponse)
def update_bank_mapping(map_id: uuid.UUID, req: BankMappingUpdateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    mapping = db.query(TallyBankMapping).filter(TallyBankMapping.id == map_id).first()
    if not mapping:
        raise HTTPException(status_code=404, detail="Bank mapping not found")
    get_company_membership(db, current_user, mapping.company_id)
    require_permission(db, current_user, mapping.company_id, "settings:manage")
    for k, v in req.model_dump(exclude_unset=True).items():
        setattr(mapping, k, v)
    db.commit()
    db.refresh(mapping)
    return mapping


@router.delete("/mappings/bank/{map_id}")
def delete_bank_mapping(map_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    mapping = db.query(TallyBankMapping).filter(TallyBankMapping.id == map_id).first()
    if not mapping:
        raise HTTPException(status_code=404, detail="Bank mapping not found")
    get_company_membership(db, current_user, mapping.company_id)
    require_permission(db, current_user, mapping.company_id, "settings:manage")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, mapping.company_id, "tally_bank_mapping", mapping.id, f"Tally Bank Mapping: {mapping.tally_ledger_name}", deleted_by=current_user.name)
    db.delete(mapping)
    db.commit()
    return {"success": True}


# --- Real export flow ---

@router.get("/pending")
def pending_vouchers(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    comp_uuid = uuid.UUID(str(company_id))
    conn = db.query(TallyConnection).filter(TallyConnection.company_id == comp_uuid).first()

    bill_ids: List[str] = []
    payment_ids: List[str] = []
    vouchers = []
    excluded_bills = 0
    excluded_payments = 0

    if conn:
        bills = db.query(Bill).filter(
            Bill.company_id == comp_uuid,
            Bill.status != "Cancelled",
            Bill.tally_synced == False,
            Bill.invoice_date >= conn.sync_window_start_date,
        ).all()
        payments = db.query(Payment).filter(
            Payment.company_id == comp_uuid,
            Payment.tally_synced == False,
            Payment.payment_date >= conn.sync_window_start_date,
        ).all()
        excluded_bills = db.query(func.count(Bill.id)).filter(
            Bill.company_id == comp_uuid,
            Bill.status != "Cancelled",
            Bill.tally_synced == False,
            Bill.invoice_date < conn.sync_window_start_date,
        ).scalar() or 0
        excluded_payments = db.query(func.count(Payment.id)).filter(
            Payment.company_id == comp_uuid,
            Payment.tally_synced == False,
            Payment.payment_date < conn.sync_window_start_date,
        ).scalar() or 0
        if bills or payments:
            _, vouchers = _build_vouchers(db, conn, bills, payments, advance_sequence=False)
            bill_ids = [str(b.id) for b in bills]
            payment_ids = [str(p.id) for p in payments]

    return {
        "count": len(vouchers),
        "bill_ids": bill_ids,
        "payment_ids": payment_ids,
        "vouchers": vouchers,
        "excluded_before_window": {"bills": excluded_bills, "payments": excluded_payments},
    }


@router.get("/export")
def export_tally_xml(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    """Return a Tally-importable XML for all unsynced, in-window vouchers.

    READ-ONLY and idempotent: this never marks anything as synced and never
    consumes the voucher sequence, so it can be re-downloaded safely until the
    user confirms the import in Tally Prime. Every download of the same queue
    renders identical voucher numbers (R2-369): the sequence is only advanced
    by POST /tally/mark-synced, i.e. when the import is actually confirmed.
    """
    comp_uuid = uuid.UUID(str(company_id))
    conn = db.query(TallyConnection).filter(TallyConnection.company_id == comp_uuid).first()
    if not conn:
        raise HTTPException(status_code=400, detail="Tally connection must be configured before exporting vouchers.")

    bills = db.query(Bill).filter(
        Bill.company_id == comp_uuid,
        Bill.status != "Cancelled",
        Bill.tally_synced == False,
        Bill.invoice_date >= conn.sync_window_start_date,
    ).all()
    payments = db.query(Payment).filter(
        Payment.company_id == comp_uuid,
        Payment.tally_synced == False,
        Payment.payment_date >= conn.sync_window_start_date,
    ).all()

    vouchers, _ = _build_vouchers(db, conn, bills, payments, advance_sequence=False)
    xml = build_tally_envelope(conn.tally_company_name, vouchers, auto_create=conn.auto_create_missing_ledgers)
    filename = f"siteflow-tally-{datetime.utcnow().strftime('%Y%m%d')}.xml"
    return Response(
        content=xml,
        media_type="application/xml",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/mark-synced")
def mark_synced(req: MarkSyncedRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Mark the given bills/payments as synced AFTER the user imports into Tally."""
    bill_ids = [uuid.UUID(str(x)) for x in req.bill_ids]
    payment_ids = [uuid.UUID(str(x)) for x in req.payment_ids]

    updated_bills = 0
    updated_payments = 0
    company_id = None
    authorized_companies = set()
    # R2-369: newly confirmed vouchers per company; each one consumes its
    # voucher number only here, at confirmation time.
    seq_consumption = {}

    if bill_ids:
        for b in db.query(Bill).filter(Bill.id.in_(bill_ids)).all():
            if b.company_id not in authorized_companies:
                get_company_membership(db, current_user, b.company_id)
                require_permission(db, current_user, b.company_id, "settings:manage")
                authorized_companies.add(b.company_id)
            if not b.tally_synced:
                b.tally_synced = True
                updated_bills += 1
                seq_consumption[b.company_id] = seq_consumption.get(b.company_id, 0) + 1
            company_id = b.company_id

    if payment_ids:
        for p in db.query(Payment).filter(Payment.id.in_(payment_ids)).all():
            if p.company_id not in authorized_companies:
                get_company_membership(db, current_user, p.company_id)
                require_permission(db, current_user, p.company_id, "settings:manage")
                authorized_companies.add(p.company_id)
            if not p.tally_synced:
                p.tally_synced = True
                updated_payments += 1
                seq_consumption[p.company_id] = seq_consumption.get(p.company_id, 0) + 1
            company_id = p.company_id

    db.commit()

    # R2-369: the export renders preview numbers from conn.last_voucher_seq
    # without consuming it, so a re-download is byte-identical and Tally's own
    # duplicate detection keeps working. Confirmation (this call) is what
    # advances the counter past the numbers the imported file carried.
    for marked_company_id, consumed in seq_consumption.items():
        marked_conn = db.query(TallyConnection).filter(
            TallyConnection.company_id == marked_company_id
        ).first()
        if marked_conn:
            marked_conn.last_voucher_seq = (marked_conn.last_voucher_seq or 0) + consumed
            db.add(marked_conn)
    if seq_consumption:
        db.commit()

    log = None
    if company_id and (updated_bills or updated_payments):
        log = TallySyncLog(
            id=uuid.uuid4(),
            company_id=company_id,
            voucher_count=updated_bills + updated_payments,
            marked_synced_at=datetime.utcnow(),
            bill_ids=json.dumps([str(x) for x in bill_ids]),
            payment_ids=json.dumps([str(x) for x in payment_ids]),
        )
        db.add(log)
        db.commit()

    return {
        "marked_bills": updated_bills,
        "marked_payments": updated_payments,
        "marked_synced_at": (log.marked_synced_at.isoformat() if log else None),
    }


@router.get("/synced")
def synced_records(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    """The latest bills and payments marked as imported into Tally, so a wrong
    mark can be undone by picking the record. The screen used to ask for the
    record's internal ID, which nobody can see."""
    from app.party_names import resolve_party_name
    names: dict = {}

    def party(pid):
        if pid not in names:
            names[pid] = resolve_party_name(db, pid, fallback="")
        return names[pid]

    bills = (
        db.query(Bill)
        .filter(Bill.company_id == company_id, Bill.tally_synced == True, Bill.status != "Cancelled")
        .order_by(Bill.invoice_date.desc())
        .limit(100)
        .all()
    )
    payments = (
        db.query(Payment)
        .filter(Payment.company_id == company_id, Payment.tally_synced == True)
        .order_by(Payment.payment_date.desc())
        .limit(100)
        .all()
    )
    out = [
        {
            "kind": "bill", "id": str(b.id), "number": b.invoice_number, "party": party(b.party_company_user_id),
            "date": b.invoice_date, "amount": float(b.total_payable or 0), "type": b.invoice_type,
        }
        for b in bills
    ] + [
        {
            "kind": "payment", "id": str(p.id), "number": p.reference_number or "", "party": party(p.party_company_user_id),
            "date": p.payment_date, "amount": float(p.amount or 0), "type": p.payment_type,
        }
        for p in payments
    ]
    out.sort(key=lambda r: r["date"], reverse=True)
    return out


@router.post("/unmark-synced")
def unmark_synced(req: MarkSyncedRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Undo a mark-synced so vouchers re-enter the export queue (e.g. a mark before the Tally import actually succeeded)."""
    bill_ids = [uuid.UUID(str(x)) for x in req.bill_ids]
    payment_ids = [uuid.UUID(str(x)) for x in req.payment_ids]

    unmarked_bills = 0
    unmarked_payments = 0
    authorized_companies = set()

    if bill_ids:
        for b in db.query(Bill).filter(Bill.id.in_(bill_ids)).all():
            if b.company_id not in authorized_companies:
                get_company_membership(db, current_user, b.company_id)
                require_permission(db, current_user, b.company_id, "settings:manage")
                authorized_companies.add(b.company_id)
            if b.tally_synced:
                b.tally_synced = False
                unmarked_bills += 1

    if payment_ids:
        for p in db.query(Payment).filter(Payment.id.in_(payment_ids)).all():
            if p.company_id not in authorized_companies:
                get_company_membership(db, current_user, p.company_id)
                require_permission(db, current_user, p.company_id, "settings:manage")
                authorized_companies.add(p.company_id)
            if p.tally_synced:
                p.tally_synced = False
                unmarked_payments += 1

    db.commit()

    return {
        "unmarked_bills": unmarked_bills,
        "unmarked_payments": unmarked_payments,
    }


@router.get("/sync-logs", response_model=List[SyncLogResponse])
def get_sync_logs(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    comp_uuid = uuid.UUID(str(company_id))
    return db.query(TallySyncLog).filter(TallySyncLog.company_id == comp_uuid).order_by(TallySyncLog.created_at.desc()).all()


@router.delete("/sync")
def sync_gone():
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail="The automatic Tally sync endpoint has been removed. Use GET /tally/export to download a real Tally-importable XML, then POST /tally/mark-synced after importing it in Tally Prime.",
    )
