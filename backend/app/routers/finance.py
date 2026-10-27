import hashlib
import logging
import uuid
from datetime import datetime, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, File, Form, UploadFile, Response, Query
from sqlalchemy import func
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import Payment, PaymentSettlement, Bill, PayrollRun, PayrollLineItem, StaffEmployee, ProjectBudget, Project, CompanyTeam, User, Equipment, EquipmentDeployment, FuelLog, BankAccount, PaymentRequest, PaymentRequestPayment, CashAccount, LibraryParty, Company, ApprovalRule, LibraryCostCode, MaterialWastage
from app.auth import (
    get_current_user,
    verify_project_in_company,
    verify_company_access,
    verify_project_access,
    get_company_membership,
    require_permission,
    require_module_view,
    assert_cost_codes_known,
)
from app.approvals import (
    find_matching_rule,
    match_approver,
    levels_approved,
    user_already_acted,
    record_action,
    PAYMENT_ENTRIES_FEATURE_TYPE,
    PAYMENT_REQUEST_FEATURE_TYPE,
)
from pydantic import BaseModel, Field, field_validator
from app.constants import (
    EXPENSE_INVOICE_TYPES,
    REVENUE_INVOICE_TYPES,
    classify_invoice_type,
    is_expense_invoice_type,
    is_revenue_invoice_type,
    is_settlement_invoice_type,
    is_settlement_money_in,
    is_settlement_money_out,
)
from app.workflow_controls import enforce_entry_creation_window
from app.party_names import resolve_party_name

logger = logging.getLogger(__name__)

# Tolerance for "fully paid" money comparisons (1 paisa/cent). Mirrors the 0.01
# tolerance used in routers/three_way.py for variance matching, so float drift
# across many partial payments can't leave a bill stuck at "Partially Paid".
MONEY_EPSILON = 0.01

# R2-346: FIFO settlement may only apply money to bills that have passed review.
# "approved" is written by PATCH /finance/approve/{id}; "auto_approved" is the
# legacy value reports.py already treats as approved. A pending/rejected bill is
# never settled: the payment simply stays unsettled until the bill is approved.
SETTLEMENT_APPROVAL_FLAGS = ("approved", "auto_approved")


# R2-236: ledger timestamp columns are NULL-able in legacy rows and tz-aware
# on Postgres but naive on SQLite, so sorting raw values against naive
# datetime.min raises TypeError and 500s /finance/ledger on mixed-timestamp
# data. Normalize every sort key to an aware UTC datetime: None becomes
# datetime.min (UTC), naive values are stamped UTC, aware values untouched.
def _ledger_sort_dt(value):
    if value is None:
        return datetime.min.replace(tzinfo=timezone.utc)
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value

router = APIRouter(
    prefix="/finance",
    tags=["Finance & P&L"],
    dependencies=[Depends(get_current_user)]
)

# Pydantic Schemas
class PaymentCreateRequest(BaseModel):
    company_id: uuid.UUID
    project_id: Optional[uuid.UUID] = None
    party_company_user_id: Optional[uuid.UUID] = None
    # R2-316/R2-344: payment_type is two-valued. "transfer" used to be admitted
    # here but no consumer handled it (FIFO settlement treated it as an expense
    # outflow, balances dropped it and reports mislabelled it), so it is
    # rejected with a pointer to the P2P transfer endpoint.
    payment_type: str

    @field_validator("payment_type")
    @classmethod
    def _payment_type_must_be_in_or_out(cls, v: str) -> str:
        if v not in ("in", "out"):
            raise ValueError(
                "payment_type must be 'in' or 'out'. To record an internal transfer between "
                "team members, use the P2P transfer endpoint POST /apis/v3/finance/cashbook/p2p."
            )
        return v
    amount: float = Field(..., gt=0)
    payment_method: str = Field(..., pattern="(?i)^(Cash|Bank Transfer|Bank|Cheque|UPI|Online)$")  # Cash, Bank Transfer, Cheque
    reference_number: Optional[str] = None
    description: Optional[str] = None
    payment_date: datetime
    account_name: Optional[str] = None
    # R2-100/R2-315: bank/UPI/cheque/online movements may name their BankAccount;
    # the payment posts to that account's balance in-transaction.
    account_id: Optional[uuid.UUID] = None
    cost_code: Optional[str] = None
    sub_cost_code: Optional[str] = None
    category: Optional[str] = None

class PaymentResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    project_id: Optional[uuid.UUID]
    party_company_user_id: Optional[uuid.UUID]
    payment_type: str
    amount: float
    unsettled_amount: float
    payment_method: str
    reference_number: Optional[str]
    description: Optional[str]
    payment_date: datetime
    created_at: datetime
    account_name: Optional[str]
    account_id: Optional[uuid.UUID]
    cost_code: Optional[str]
    sub_cost_code: Optional[str]
    category: Optional[str]
    approval_flag: Optional[str] = None

    class Config:
        from_attributes = True

class LedgerTransactionResponse(BaseModel):
    id: str
    date: str
    type: str  # "Receipt" or "Expense"
    category: str
    description: str
    amount: float
    party: str
    ref: str
    ledger: str
    debit: float = 0.0
    credit: float = 0.0
    balance: float = 0.0

class PLItemResponse(BaseModel):
    head: str
    budget: float
    actual: float
    variance: float


# --- Endpoints ---

@router.post("/payments", response_model=PaymentResponse, status_code=status.HTTP_201_CREATED)
def create_payment(req: PaymentCreateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    comp_uuid = uuid.UUID(str(req.company_id))
    get_company_membership(db, current_user, comp_uuid)
    require_permission(db, current_user, comp_uuid, "finance:edit")
    proj_uuid = uuid.UUID(str(req.project_id)) if req.project_id else None
    party_uuid = uuid.UUID(str(req.party_company_user_id)) if req.party_company_user_id else None

    # Verify project
    if proj_uuid:
        project = db.query(Project).filter(Project.id == proj_uuid).first()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        if project.company_id != comp_uuid:
            raise HTTPException(status_code=403, detail="Project does not belong to this company")

    # R2-609: payment cost codes must exist in the company's Cost Code
    # Library (same gate as budgeting.py's BOQ import). A free-text typo
    # used to be written as-is, silently forking a code that never rolls
    # up with the rest. Rejected before anything is written.
    assert_cost_codes_known(
        db,
        comp_uuid,
        codes=[req.cost_code] if req.cost_code else None,
        sub_cost_codes=[req.sub_cost_code] if req.sub_cost_code else None,
        status_code=422,
    )

    # R2-381: money entries obey the same Entry Controls back-dating window as bills.
    enforce_entry_creation_window(db, req.company_id, req.payment_date)

    # R2-100/R2-315: a named bank account posts the movement into
    # BankAccount.balance in the same transaction as the payment row, so
    # recorded receipts/expenses actually reach Company Balance (= cash wallet
    # + bank accounts). Cash stays derived from the payments themselves and
    # must never double-post through an account.
    bank_account = None
    if req.account_id:
        bank_account = db.query(BankAccount).filter(
            BankAccount.id == req.account_id,
            BankAccount.company_id == comp_uuid,
        ).first()
        if not bank_account:
            raise HTTPException(status_code=404, detail="Bank account not found")
        if str(req.payment_method).strip().lower() == "cash":
            raise HTTPException(
                status_code=422,
                detail="account_id applies to non-cash payments; cash movements post to the derived cash wallet",
            )

    payment = Payment(
        id=uuid.uuid4(),
        company_id=comp_uuid,
        project_id=proj_uuid,
        party_company_user_id=party_uuid,
        payment_type=req.payment_type,
        amount=req.amount,
        unsettled_amount=req.amount,
        payment_method=req.payment_method,
        reference_number=req.reference_number,
        description=req.description,
        payment_date=req.payment_date,
        account_name=req.account_name,
        account_id=req.account_id,
        cost_code=req.cost_code,
        sub_cost_code=req.sub_cost_code,
        category=req.category
    )

    # DEFECT-07 fix: reject duplicate reference_number within the same company
    if req.reference_number:
        existing = db.query(Payment).filter(
            Payment.company_id == comp_uuid,
            Payment.reference_number == req.reference_number
        ).first()
        if existing:
            raise HTTPException(
                status_code=409,
                detail=f"A payment with reference_number '{req.reference_number}' already exists for this company. Use a unique reference number."
            )

    db.add(payment)
    db.flush()

    # A payment to or from a Party Library party on a project puts that party on
    # the project's Party register, as a bill does (R2-487); otherwise an advance
    # paid before the first bill never appeared there.
    if proj_uuid and party_uuid:
        party_team = db.query(CompanyTeam).filter(
            CompanyTeam.id == party_uuid, CompanyTeam.company_id == comp_uuid
        ).first()
        if party_team and party_team.library_party_id:
            from app.routers.projects import ensure_project_party_link
            ensure_project_party_link(db, proj_uuid, party_team.library_party_id)

    # R2-100/R2-315: post the movement to the named bank account in-transaction
    # (same commit as the payment row, so one never lands without the other).
    if bank_account:
        delta = float(req.amount) if req.payment_type == "in" else -float(req.amount)
        bank_account.balance = float(bank_account.balance or 0.0) + delta
        db.add(bank_account)

    # FIFO Auto-Settlement Logic against Outstanding Bills.
    # R2-231: the engine used to run only when the body carried a party id,
    # but the product's sole payment caller never sends one, so the loop was
    # unreachable and every bill stayed permanently Unpaid with paid_amount 0.
    # Without a party we settle FIFO over the payment's natural scope: company
    # always, project when provided, revenue invoices for "in" payments and
    # expense invoices for "out". A supplied party keeps the exact prior
    # party-scoped behavior.
    target_inv_type = list(REVENUE_INVOICE_TYPES) if req.payment_type == "in" else list(EXPENSE_INVOICE_TYPES)

    # R2-346: settlement is gated on approval. Every bill created through
    # the product starts approval_flag="pending"; flipping an unreviewed
    # bill to Paid is a control failure, so only approved bills are
    # eligible and the payment simply stays unsettled until review happens.
    query = db.query(Bill).filter(
        Bill.status != "Paid",
        Bill.approval_flag.in_(SETTLEMENT_APPROVAL_FLAGS),
    )
    if party_uuid:
        query = query.filter(Bill.party_company_user_id == party_uuid)
    else:
        query = query.filter(Bill.company_id == comp_uuid)
    if proj_uuid:
        query = query.filter(Bill.project_id == proj_uuid)
    query = query.filter(Bill.invoice_type.in_(target_inv_type))

    open_bills = query.order_by(Bill.invoice_date.asc()).all()

    for bill in open_bills:
        if payment.unsettled_amount <= 0:
            break

        remaining = float(bill.total_payable) - float(bill.paid_amount)
        if remaining <= 0:
            continue

        settled = min(float(payment.unsettled_amount), remaining)
        bill.paid_amount = float(bill.paid_amount) + settled

        if float(bill.paid_amount) >= float(bill.total_payable) - MONEY_EPSILON:
            bill.status = "Paid"
        else:
            bill.status = "Partially Paid"

        db.add(bill)

        # Record Settlement
        settlement = PaymentSettlement(
            id=uuid.uuid4(),
            payment_id=payment.id,
            bill_id=bill.id,
            settled_amount=settled
        )
        db.add(settlement)
        payment.unsettled_amount = float(payment.unsettled_amount) - settled

    db.commit()
    db.refresh(payment)
    return payment


@router.delete("/payments/{payment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_payment(payment_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Delete a finance payment. Tenant-scoped: the caller must belong to the
    payment's company, and the deletion is written to the DeleteLog audit trail."""
    payment = db.query(Payment).filter(Payment.id == payment_id).first()
    if not payment:
        raise HTTPException(status_code=404, detail="Payment not found")
    get_company_membership(db, current_user, payment.company_id)
    require_permission(db, current_user, payment.company_id, "data:delete")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, payment.company_id, "payment", payment.id, f"Payment {payment.id}", deleted_by=current_user.name)

    # Reverse any FIFO settlements this payment recorded against bills. The DB
    # cascade-deletes the PaymentSettlement rows at commit, so we read them first
    # to know how much to unwind from each linked Bill's paid_amount/status.
    settlements = db.query(PaymentSettlement).filter(PaymentSettlement.payment_id == payment.id).all()
    for s in settlements:
        bill = db.query(Bill).filter(Bill.id == s.bill_id).first()
        if not bill:
            continue
        bill.paid_amount = max(0.0, float(bill.paid_amount) - float(s.settled_amount))
        if float(bill.paid_amount) >= float(bill.total_payable) - MONEY_EPSILON:
            bill.status = "Paid"
        elif float(bill.paid_amount) > 0:
            bill.status = "Partially Paid"
        else:
            bill.status = "Unpaid"
        db.add(bill)

    # R2-100/R2-315: reverse the bank posting this payment made when it was
    # created (non-cash methods only; the cash wallet derives from payments).
    if payment.account_id and str(payment.payment_method or "").strip().lower() != "cash":
        acc = db.query(BankAccount).filter(
            BankAccount.id == payment.account_id,
            BankAccount.company_id == payment.company_id,
        ).first()
        if acc:
            amount = float(payment.amount or 0.0)
            acc.balance = float(acc.balance or 0.0) - (amount if payment.payment_type == "in" else -amount)
            db.add(acc)

    db.delete(payment)
    db.commit()


@router.get("/ledger", response_model=List[LedgerTransactionResponse])
def get_ledger(project_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access), current_user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    require_module_view(db, current_user, project.company_id, "finance")
    proj_uuid = uuid.UUID(str(project_id))
    
    # 1. Fetch payments
    payments = db.query(Payment).filter(Payment.project_id == proj_uuid).all()
    # 2. Fetch bills
    bills = db.query(Bill).filter(Bill.project_id == proj_uuid).all()
    # 3. Fetch salary line items
    salaries = db.query(PayrollLineItem).join(PayrollRun).filter(PayrollRun.project_id == proj_uuid).all()

    # Payments that settled one or more bills are already reflected in those
    # bills' Receipt/Expense lines (accrual basis). Posting them again here would
    # double-count the same economic event, so collect their ids to skip below.
    # Standalone cash movements (no settlement) are still shown for the audit trail.
    settled_payment_ids = set(
        row[0]
        for row in db.query(PaymentSettlement.payment_id)
        .filter(PaymentSettlement.payment_id.in_([p.id for p in payments]))
        .all()
    )

    raw_entries = []
    for p in payments:
        raw_entries.append((p.payment_date, "payment", p))
    for b in bills:
        raw_entries.append((b.invoice_date, "bill", b))
    for s in salaries:
        raw_entries.append((s.created_at, "salary", s))
        
    # Sort ascending chronologically to compute running balance.
    # R2-236: keys must be tz-normalized (see _ledger_sort_dt) or mixed
    # naive/aware/NULL timestamps raise TypeError and 500 the endpoint.
    raw_entries.sort(key=lambda x: _ledger_sort_dt(x[0]))

    ledger_entries = []
    running_balance = 0.0

    for dt, entry_type, obj in raw_entries:
        if entry_type == "payment":
            if obj.id in settled_payment_ids:
                continue
            # R2-276: shared resolution (linked user, then linked LibraryParty)
            # instead of the silent users-only walk that printed "Walk-in Party"
            # for real parties.
            party_name = _txn_party_name(db, obj.party_company_user_id)
            
            is_in = obj.payment_type == "in"
            amount = float(obj.amount)
            debit = amount if is_in else 0.0
            credit = 0.0 if is_in else amount
            if is_in:
                running_balance += amount
            else:
                running_balance -= amount
                
            ledger_entries.append(
                LedgerTransactionResponse(
                    id=str(obj.id),
                    date=obj.payment_date.strftime("%b %d") if obj.payment_date else "",
                    type="Receipt" if is_in else "Expense",
                    category="Client Payment" if is_in else "Direct Payment",
                    description=obj.description or ("Receipt Payment" if is_in else "Expense Payment"),
                    amount=amount if is_in else -amount,
                    party=party_name,
                    ref=obj.reference_number or "",
                    ledger="Revenue" if is_in else "General Ledger",
                    debit=debit,
                    credit=credit,
                    balance=running_balance
                )
            )
        elif entry_type == "bill":
            # R2-276: shared resolution (linked user, then linked LibraryParty)
            # instead of the silent users-only walk that printed "Vendor/Client"
            # for real parties.
            party_name = _txn_party_name(db, obj.party_company_user_id)
            # R2-238 + D3: settlement vouchers are cash movements, not revenue or
            # cost accruals. Use the single shared classifier so the buckets
            # cannot drift per call site.
            if is_settlement_invoice_type(obj.invoice_type):
                money_in = is_settlement_money_in(obj.invoice_type)
                settlement_amount = float(obj.total_payable)
                if money_in:
                    running_balance += settlement_amount
                else:
                    running_balance -= settlement_amount
                ledger_entries.append(
                    LedgerTransactionResponse(
                        id=str(obj.id),
                        date=obj.invoice_date.strftime("%b %d") if obj.invoice_date else "",
                        type="Receipt" if money_in else "Expense",
                        category="Settlement",
                        description=f"Invoice {obj.invoice_number}",
                        amount=settlement_amount if money_in else -settlement_amount,
                        party=party_name,
                        ref=obj.invoice_number,
                        ledger="Cash Movement",
                        debit=settlement_amount if money_in else 0.0,
                        credit=0.0 if money_in else settlement_amount,
                        balance=running_balance
                    )
                )
                continue
            is_receipt = is_revenue_invoice_type(obj.invoice_type)
            amount = float(obj.total_payable)
            debit = amount if is_receipt else 0.0
            credit = 0.0 if is_receipt else amount
            if is_receipt:
                running_balance += amount
            else:
                running_balance -= amount

            category = "Client Invoice" if is_revenue_invoice_type(obj.invoice_type) else ("Subcon Invoice" if obj.invoice_type == "subcon" else "Material Bill")
            ledger_head = "Revenue" if is_revenue_invoice_type(obj.invoice_type) else ("Subcon Cost" if obj.invoice_type == "subcon" else "Material Cost")
            
            ledger_entries.append(
                LedgerTransactionResponse(
                    id=str(obj.id),
                    date=obj.invoice_date.strftime("%b %d") if obj.invoice_date else "",
                    type="Receipt" if is_receipt else "Expense",
                    category=category,
                    description=f"Invoice {obj.invoice_number}",
                    amount=amount if is_receipt else -amount,
                    party=party_name,
                    ref=obj.invoice_number,
                    ledger=ledger_head,
                    debit=debit,
                    credit=credit,
                    balance=running_balance
                )
            )
        elif entry_type == "salary":
            party_name = "Staff Member"
            if obj.employee_id:
                emp = db.query(StaffEmployee).filter(StaffEmployee.id == obj.employee_id).first()
                if emp and emp.name:
                    party_name = emp.name
            amount = float(obj.net_payable)
            debit = 0.0
            credit = amount
            running_balance -= amount
            
            ledger_entries.append(
                LedgerTransactionResponse(
                    id=str(obj.id),
                    date=obj.created_at.strftime("%b %d") if obj.created_at else "",
                    type="Expense",
                    category="Labour Wages",
                    description="Salary Payout",
                    amount=-amount,
                    party=party_name,
                    ref="PAYROLL",
                    ledger="Labour Cost",
                    debit=debit,
                    credit=credit,
                    balance=running_balance
                )
            )

    # Sort descending (most recent first) for response presentation
    ledger_entries.reverse()
    return ledger_entries


@router.get("/pl", response_model=List[PLItemResponse])
def get_project_pl(project_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access), current_user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == project_id).first()
    require_module_view(db, current_user, project.company_id, "finance")
    proj_uuid = uuid.UUID(str(project_id))
    
    # Fetch project budgets
    budget = db.query(ProjectBudget).filter(ProjectBudget.project_id == proj_uuid).first()
    
    # Fallback to zero budgets if not configured
    mat_budget = float(budget.material_budget) if budget else 0.0
    lab_budget = float(budget.labour_budget) if budget else 0.0
    sub_budget = float(budget.subcon_budget) if budget else 0.0
    eq_budget = float(budget.equipment_budget) if budget else 0.0
    
    # Load actual values by summing corresponding entries in bills and salaries
    # 1. Revenue: Client invoices & material sales (invoice_type in ["sale", "material_sale"])
    revenue_actual = db.query(func.sum(Bill.total_payable)).filter(
        Bill.project_id == proj_uuid,
        Bill.invoice_type.in_(REVENUE_INVOICE_TYPES),
        Bill.status != "Cancelled"
    ).scalar() or 0.0

    # 2. Material Cost: Vendor purchase bills (invoice_type == "purchase") + wastage.
    # R2-749: Partition expense invoice types into their respective heads:
    # Material = purchase, Subcontractor = subcon, Plant & Machinery = equipment + deployments + fuel, Overhead = expense.
    material_actual = db.query(func.sum(Bill.total_payable)).filter(
        Bill.project_id == proj_uuid,
        Bill.invoice_type == "purchase",
        Bill.status != "Cancelled"
    ).scalar() or 0.0
    material_wastage_actual = db.query(func.sum(MaterialWastage.estimated_value)).filter(
        MaterialWastage.project_id == proj_uuid
    ).scalar() or 0.0
    material_actual = float(material_actual) + float(material_wastage_actual)

    # 3. Labour Cost: Salary expenses (C2: finalized payroll runs only)
    labour_actual = (
        db.query(func.sum(PayrollLineItem.net_payable))
        .join(PayrollRun)
        .filter(
            PayrollRun.project_id == proj_uuid,
            PayrollRun.status == "finalized",
        )
        .scalar()
        or 0.0
    )

    # 4. Subcontractor Cost: Subcon bills (invoice_type == "subcon")
    subcon_actual = db.query(func.sum(Bill.total_payable)).filter(
        Bill.project_id == proj_uuid,
        Bill.invoice_type == "subcon",
        Bill.status != "Cancelled"
    ).scalar() or 0.0

    # 5. Plant & Machinery (Equipment bills + equipment deployment cost + fuel costs)
    equipment_bills_actual = db.query(func.sum(Bill.total_payable)).filter(
        Bill.project_id == proj_uuid,
        Bill.invoice_type == "equipment",
        Bill.status != "Cancelled"
    ).scalar() or 0.0

    deployments = db.query(EquipmentDeployment).filter(EquipmentDeployment.project_id == proj_uuid).all()
    dep_cost = 0.0
    for dep in deployments:
        eq = db.query(Equipment).filter(Equipment.id == dep.equipment_id).first()
        if not eq:
            continue
        # R2-358a: this used to be `if eq and eq.hourly_rate:` -- a truthiness
        # test on a Numeric column whose default is 0.0. A machine with no
        # configured rate (the ordinary case for a Hired machine whose rate
        # lives on the hire invoice) was skipped silently and contributed
        # nothing forever, indistinguishable from a machine that was never
        # deployed. The cost is still zero -- there is no rate to invent -- but
        # the omission is now reported instead of swallowed.
        rate = float(eq.hourly_rate or 0.0)
        if rate <= 0.0:
            logger.warning(
                "P&L: equipment %s (%s) is deployed on project %s with no "
                "hourly_rate configured, so its deployment contributes 0.00 "
                "to Plant & Machinery.", eq.id, eq.code, proj_uuid,
            )
        if dep.hours_used is not None:
            # R2-357: recorded engine/shift hours are the billed truth;
            # wall-clock (24 h/day) is only the fallback when never recorded.
            hours = float(dep.hours_used)
        else:
            # R2-727: EquipmentDeployment columns are timezone-aware on Postgres
            # but round-trip naive on SQLite; normalize both operands so the
            # "still deployed" fallback (end_date NULL) can't raise TypeError.
            start = dep.start_date
            if start.tzinfo is None:
                start = start.replace(tzinfo=timezone.utc)
            end = dep.end_date if dep.end_date else datetime.now(timezone.utc)
            if end.tzinfo is None:
                end = end.replace(tzinfo=timezone.utc)
            hours = (end - start).total_seconds() / 3600.0
        dep_cost += round(max(0.0, hours * rate), 2)

    fuel_logs = db.query(FuelLog).filter(FuelLog.project_id == proj_uuid).all()
    fuel_cost = sum(float(log.total_cost or 0.0) for log in fuel_logs)
    equipment_actual = round(float(equipment_bills_actual) + dep_cost + fuel_cost, 2)

    # 6. Overhead: General expense bills (invoice_type == "expense")
    overhead_actual = db.query(func.sum(Bill.total_payable)).filter(
        Bill.project_id == proj_uuid,
        Bill.invoice_type == "expense",
        Bill.status != "Cancelled"
    ).scalar() or 0.0

    # Variance: for Revenue, variance = Actual - Budget. For Cost, variance = Budget - Actual.
    # To keep it standard: return positive variance for positive variance outcomes, negative for cost overruns.
    pl_data = [
        PLItemResponse(
            head="Revenue (Billed)",
            budget=0.0, # Budget for project revenue isn't direct in budgets, but we can set actual
            actual=float(revenue_actual),
            variance=float(revenue_actual)
        ),
        PLItemResponse(
            head="Material Cost",
            budget=mat_budget,
            actual=float(material_actual),
            variance=mat_budget - float(material_actual)
        ),
        PLItemResponse(
            head="Labour Cost",
            budget=lab_budget,
            actual=float(labour_actual),
            variance=lab_budget - float(labour_actual)
        ),
        PLItemResponse(
            head="Subcontractor Cost",
            budget=sub_budget,
            actual=float(subcon_actual),
            variance=sub_budget - float(subcon_actual)
        ),
        PLItemResponse(
            head="Plant & Machinery",
            budget=eq_budget,
            actual=float(equipment_actual),
            variance=eq_budget - float(equipment_actual)
        ),
        PLItemResponse(
            head="Overhead",
            budget=0.0,
            actual=float(overhead_actual),
            variance=0.0 - float(overhead_actual)
        )
    ]
    return pl_data


# R2-342: approving money must honour the Settings > Multi Level Approval rules
# configured for "Payment Entries" (the label admins see), refuse to re-approve
# an already-approved or cancelled document, and leave a per-decision
# ApprovalAction row naming the approver (approver_user_id) and the time
# (created_at). Bills have no matching category label today, so their manual
# approval records the action ungated; wiring one for bills is CD-1 territory.
# R2-179: PAYMENT_ENTRIES_FEATURE_TYPE comes from app/approvals.py.

_APPROVED_FLAGS = ("approved", "auto_approved")


@router.patch("/approve/{transaction_id}")
def approve_transaction(transaction_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    bill = db.query(Bill).filter(Bill.id == transaction_id).first()
    if bill:
        get_company_membership(db, current_user, bill.company_id)
        require_permission(db, current_user, bill.company_id, "finance:approve")
        if bill.status == "Cancelled":
            raise HTTPException(status_code=409, detail="Bill is cancelled and cannot be approved")
        if (bill.approval_flag or "").lower() in _APPROVED_FLAGS:
            raise HTTPException(status_code=409, detail="Bill has already been approved")
        record_action(
            db, company_id=bill.company_id, rule_id=None, entity_type="bill",
            entity_id=bill.id, level=1, action="approved", user=current_user, matched_label=None,
        )
        bill.approval_flag = "approved"
        db.commit()
        return {"status": "success", "message": "Bill approved successfully", "type": "bill"}

    payment = db.query(Payment).filter(Payment.id == transaction_id).first()
    if payment:
        get_company_membership(db, current_user, payment.company_id)
        require_permission(db, current_user, payment.company_id, "finance:approve")
        if (payment.approval_flag or "").lower() in _APPROVED_FLAGS:
            raise HTTPException(status_code=409, detail="Payment has already been approved")
        # A configured Payment Entries rule gates this call; with no rule the
        # pre-existing ungated behaviour is unchanged.
        rule = find_matching_rule(db, payment.company_id, PAYMENT_ENTRIES_FEATURE_TYPE, float(payment.amount or 0.0))
        if rule:
            matched = match_approver(rule.approvers, current_user)
            if not matched:
                raise HTTPException(status_code=403, detail="You are not a configured approver for this payment")
            if user_already_acted(db, "payment", payment.id, current_user.id):
                raise HTTPException(status_code=409, detail="You have already recorded a decision on this payment")
            next_level = levels_approved(db, "payment", payment.id) + 1
            record_action(
                db, company_id=payment.company_id, rule_id=rule.id, entity_type="payment",
                entity_id=payment.id, level=next_level, action="approved", user=current_user, matched_label=matched,
            )
            if next_level < rule.levels:
                db.commit()
                return {"status": "success", "message": f"Approval level {next_level} of {rule.levels} recorded; awaiting further sign-off", "type": "payment"}
            # else: final level reached, flip below
        else:
            record_action(
                db, company_id=payment.company_id, rule_id=None, entity_type="payment",
                entity_id=payment.id, level=1, action="approved", user=current_user, matched_label=None,
            )
        payment.approval_flag = "approved"
        db.commit()
        return {"status": "success", "message": "Payment confirmed", "type": "payment"}

    raise HTTPException(status_code=404, detail="Transaction not found")


class BankAccountCreate(BaseModel):
    account_holder_name: str
    bank_name: str
    account_number: str
    ifsc_code: str
    upi_id: Optional[str] = None
    balance: float = 0.0

class BankAccountUpdate(BaseModel):
    account_holder_name: Optional[str] = None
    bank_name: Optional[str] = None
    account_number: Optional[str] = None
    ifsc_code: Optional[str] = None
    upi_id: Optional[str] = None
    balance: Optional[float] = None

class BankAccountResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    account_holder_name: str
    bank_name: str
    account_number: str
    ifsc_code: str
    upi_id: Optional[str]
    balance: float
    created_at: datetime

    class Config:
        from_attributes = True

class PaymentRequestCreate(BaseModel):
    party_company_user_id: uuid.UUID
    project_id: Optional[uuid.UUID] = None
    amount: float = Field(..., gt=0)
    # R2-053: matches models.PaymentRequest.details (nullable=True); leaving
    # Ship To blank must not 422 the create.
    details: Optional[str] = None
    due_date: Optional[datetime] = None
    approval_status: Optional[str] = None
    request_type: Optional[str] = None
    request_no: Optional[str] = None

class PaymentRequestResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    project_id: Optional[uuid.UUID]
    party_company_user_id: uuid.UUID
    party_name: str
    amount: float
    details: str
    status: str
    due_date: Optional[datetime]
    approval_status: str = "Pending"
    approval_rule_id: Optional[uuid.UUID] = None
    approvals_required: int = 0
    approvals_completed: int = 0
    request_type: Optional[str] = None
    request_no: Optional[str] = None
    created_at: datetime
    payment: Optional[dict] = None

    class Config:
        from_attributes = True

class PaymentRequestPaymentCreate(BaseModel):
    payment_date: datetime
    payment_mode: str  # Cash, Bank, UPI, Cheque
    paid_amount: float = Field(..., gt=0)
    deduction: float = Field(0.0, ge=0)
    tds: float = Field(0.0, ge=0)
    remarks: Optional[str] = None
    reference_no: Optional[str] = None
    attachment_name: Optional[str] = None


@router.get("/accounts/{company_id}", response_model=List[BankAccountResponse])
def get_bank_accounts(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access), current_user: User = Depends(get_current_user)):
    require_module_view(db, current_user, company_id, "finance")
    return db.query(BankAccount).filter(BankAccount.company_id == company_id).all()


@router.post("/accounts/{company_id}", response_model=BankAccountResponse)
def create_bank_account(company_id: uuid.UUID, data: BankAccountCreate, db: Session = Depends(get_db), _: None = Depends(verify_company_access), current_user: User = Depends(get_current_user)):
    require_permission(db, current_user, company_id, "finance:edit")
    new_acc = BankAccount(
        company_id=company_id,
        account_holder_name=data.account_holder_name,
        bank_name=data.bank_name,
        account_number=data.account_number,
        ifsc_code=data.ifsc_code,
        upi_id=data.upi_id,
        balance=data.balance
    )
    db.add(new_acc)
    db.commit()
    db.refresh(new_acc)
    return new_acc


@router.put("/accounts/{account_id}", response_model=BankAccountResponse)
def update_bank_account(account_id: uuid.UUID, data: BankAccountUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    acc = db.query(BankAccount).filter(BankAccount.id == account_id).first()
    if not acc:
        raise HTTPException(status_code=404, detail="Bank account not found")
    get_company_membership(db, current_user, acc.company_id)
    require_permission(db, current_user, acc.company_id, "finance:edit")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(acc, k, v)
    db.commit()
    db.refresh(acc)
    return acc


@router.delete("/accounts/{account_id}")
def delete_bank_account(account_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    acc = db.query(BankAccount).filter(BankAccount.id == account_id).first()
    if not acc:
        raise HTTPException(status_code=404, detail="Bank account not found")
    get_company_membership(db, current_user, acc.company_id)
    require_permission(db, current_user, acc.company_id, "finance:edit")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, acc.company_id, "bank_account", acc.id, f"Bank Account: {acc.bank_name} - {acc.account_number}", deleted_by=current_user.name)
    db.delete(acc)
    db.commit()
    return {"success": True}


# --- Cash Account (Finance tab: Accounts sub-tab) ---
def _cash_running_balance(db, company_id: uuid.UUID) -> float:
    """Running cash balance = opening balance + (cash-in payments - cash-out payments)."""
    cash_acc = db.query(CashAccount).filter(CashAccount.company_id == company_id).first()
    opening = float(cash_acc.opening_balance) if cash_acc else 0.0
    cash_in = db.query(func.coalesce(func.sum(Payment.amount), 0)).filter(
        Payment.company_id == company_id, Payment.payment_type == "in",
        Payment.payment_method.ilike("%cash%"),
    ).scalar() or 0
    cash_out = db.query(func.coalesce(func.sum(Payment.amount), 0)).filter(
        Payment.company_id == company_id, Payment.payment_type == "out",
        Payment.payment_method.ilike("%cash%"),
    ).scalar() or 0
    return round(opening + float(cash_in) - float(cash_out), 2)


class CashAccountCreate(BaseModel):
    name: Optional[str] = "Cash Account"
    opening_balance: float = Field(0.0, ge=0)


class CashAccountUpdate(BaseModel):
    name: Optional[str] = None
    opening_balance: Optional[float] = Field(None, ge=0)


class CashAccountResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    name: str
    opening_balance: float
    running_balance: float
    created_at: datetime

    class Config:
        from_attributes = True


@router.get("/cash-account/{company_id}", response_model=Optional[CashAccountResponse])
def get_cash_account(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access), current_user: User = Depends(get_current_user)):
    require_module_view(db, current_user, company_id, "finance")
    acc = db.query(CashAccount).filter(CashAccount.company_id == company_id).first()
    if not acc:
        return None
    return CashAccountResponse(
        id=acc.id,
        company_id=acc.company_id,
        name=acc.name,
        opening_balance=acc.opening_balance,
        running_balance=_cash_running_balance(db, company_id),
        created_at=acc.created_at,
    )


@router.post("/cash-account/{company_id}", response_model=CashAccountResponse)
def create_cash_account(company_id: uuid.UUID, data: CashAccountCreate, db: Session = Depends(get_db), _: None = Depends(verify_company_access), current_user: User = Depends(get_current_user)):
    require_permission(db, current_user, company_id, "finance:edit")
    existing = db.query(CashAccount).filter(CashAccount.company_id == company_id).first()
    if existing:
        raise HTTPException(status_code=400, detail="Cash account already exists for this company")
    new_acc = CashAccount(
        company_id=company_id,
        name=data.name or "Cash Account",
        opening_balance=data.opening_balance,
    )
    db.add(new_acc)
    db.commit()
    db.refresh(new_acc)
    return CashAccountResponse(
        id=new_acc.id,
        company_id=new_acc.company_id,
        name=new_acc.name,
        opening_balance=new_acc.opening_balance,
        running_balance=_cash_running_balance(db, company_id),
        created_at=new_acc.created_at,
    )


@router.put("/cash-account/{account_id}", response_model=CashAccountResponse)
def update_cash_account(account_id: uuid.UUID, data: CashAccountUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    acc = db.query(CashAccount).filter(CashAccount.id == account_id).first()
    if not acc:
        raise HTTPException(status_code=404, detail="Cash account not found")
    get_company_membership(db, current_user, acc.company_id)
    require_permission(db, current_user, acc.company_id, "finance:edit")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(acc, k, v)
    db.commit()
    db.refresh(acc)
    return CashAccountResponse(
        id=acc.id,
        company_id=acc.company_id,
        name=acc.name,
        opening_balance=acc.opening_balance,
        running_balance=_cash_running_balance(db, acc.company_id),
        created_at=acc.created_at,
    )


@router.delete("/cash-account/{account_id}")
def delete_cash_account(account_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    acc = db.query(CashAccount).filter(CashAccount.id == account_id).first()
    if not acc:
        raise HTTPException(status_code=404, detail="Cash account not found")
    get_company_membership(db, current_user, acc.company_id)
    require_permission(db, current_user, acc.company_id, "finance:edit")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, acc.company_id, "cash_account", acc.id, f"Cash Account: {acc.name}", deleted_by=current_user.name)
    db.delete(acc)
    db.commit()
    return {"success": True}


# --- Company-level Party aggregation (Finance tab: Party sub-tab) ---
def _company_party_team_ids(db, party_id: uuid.UUID):
    """Resolve the billing-side company_team ids linked to a library party (company-wide)."""
    team_ids = [
        t.id
        for t in db.query(CompanyTeam).filter(CompanyTeam.library_party_id == party_id).all()
    ]
    if not team_ids:
        lp = db.query(LibraryParty).filter(LibraryParty.id == party_id).first()
        if lp and lp.name:
            teams = (
                db.query(CompanyTeam)
                .join(User, User.id == CompanyTeam.user_id)
                .filter(
                    CompanyTeam.company_id == lp.company_id,
                    func.lower(func.trim(User.name)) == lp.name.strip().lower(),
                )
                .all()
            )
            team_ids = [t.id for t in teams]
    return team_ids


def _net_balance(advance_paid: float, to_receive: float, advance_received: float, to_pay: float) -> float:
    """Net position across all parties (R2-726): advance_paid and to_receive are
    assets owed to us; advance_received and to_pay are liabilities we owe.
    Positive result = receivables exceed payables."""
    return round(advance_paid + to_receive - advance_received - to_pay, 2)


class CompanyPartyResponse(BaseModel):
    id: uuid.UUID
    party_id_custom: Optional[str] = None
    name: str
    party_type: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    bank_account_id: Optional[uuid.UUID] = None
    contractor_role: Optional[str] = None
    service_rate_categories: Optional[str] = None
    # Computed company-wide metrics
    advance_paid: float = 0.0       # money advanced/paid to party (vendor/subcon)
    to_pay: float = 0.0             # outstanding payable to party
    to_receive: float = 0.0         # outstanding receivable from party (client)
    advance_received: float = 0.0   # advance taken from party (client)
    balance: float = 0.0            # net balance (positive = party owes us / advance paid)
    status: str = "To Pay"

    class Config:
        from_attributes = True


@router.get("/parties/{company_id}", response_model=List[CompanyPartyResponse])
def get_company_parties(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access), current_user: User = Depends(get_current_user)):
    require_module_view(db, current_user, company_id, "finance")
    parties = db.query(LibraryParty).filter(LibraryParty.company_id == company_id).all()
    result = []
    for lp in parties:
        team_ids = _company_party_team_ids(db, lp.id)
        opening_pay = float(lp.opening_balance or 0.0) if lp.opening_balance_type == "pay" else 0.0
        opening_receive = float(lp.opening_balance or 0.0) if lp.opening_balance_type == "receive" else 0.0

        # Payable side (purchase / subcon bills)
        pay_net = opening_pay
        recv_net = opening_receive
        if team_ids:
            bills = db.query(Bill).filter(Bill.party_company_user_id.in_(team_ids)).all()
            for b in bills:
                delta = float(b.paid_amount or 0.0) - float(b.total_payable or 0.0)
                # R2-326 + D3: single shared classifier - a bare == "sale"
                # pushed material_sale revenue and settlement vouchers into
                # the payable side; is_* helpers keep buckets from drifting.
                if is_revenue_invoice_type(b.invoice_type):
                    recv_net += delta
                elif is_expense_invoice_type(b.invoice_type):
                    pay_net += delta
                # settlement and movement are not payables/receivables (D3)

        advance_paid = round(max(0.0, pay_net), 2)
        to_pay = round(max(0.0, -pay_net), 2)
        advance_received = round(max(0.0, recv_net), 2)
        to_receive = round(max(0.0, -recv_net), 2)

        balance = _net_balance(advance_paid, to_receive, advance_received, to_pay)

        if balance > 0:
            status = "To Receive"
        elif balance < 0:
            status = "To Pay"
        else:
            status = "Settled"

        result.append(CompanyPartyResponse(
            id=lp.id,
            party_id_custom=lp.party_id_custom,
            name=lp.name,
            party_type=lp.party_type,
            phone=lp.phone,
            email=lp.email,
            address=lp.address,
            bank_account_id=lp.bank_account_id,
            contractor_role=lp.contractor_role,
            service_rate_categories=lp.service_rate_categories,
            advance_paid=advance_paid,
            to_pay=to_pay,
            to_receive=to_receive,
            advance_received=advance_received,
            balance=balance,
            status=status,
        ))
    return result


# --- Enterprise / multi-company roll-up ---
def _descendant_company_ids(db: Session, root_id: uuid.UUID):
    """Recursively collect all company ids that sit under root_id in the
    parent_company_id grouping tree (breadth-first)."""
    frontier = [root_id]
    seen: set = set()
    descendants: list = []
    while frontier:
        children = db.query(Company).filter(
            Company.parent_company_id.in_(frontier)
        ).all()
        frontier = []
        for c in children:
            if c.id not in seen:
                seen.add(c.id)
                descendants.append(c.id)
                frontier.append(c.id)
    return descendants


def _company_party_totals(db: Session, company_id: uuid.UUID) -> dict:
    """Aggregated party balance totals for a single company (reuses the same
    bill math as get_company_parties but summed, not per-party)."""
    parties = db.query(LibraryParty).filter(
        LibraryParty.company_id == company_id
    ).all()
    to_pay = to_receive = advance_paid = advance_received = 0.0
    for lp in parties:
        team_ids = _company_party_team_ids(db, lp.id)
        opening_pay = float(lp.opening_balance or 0.0) if lp.opening_balance_type == "pay" else 0.0
        opening_receive = float(lp.opening_balance or 0.0) if lp.opening_balance_type == "receive" else 0.0
        pay_net = opening_pay
        recv_net = opening_receive
        if team_ids:
            bills = db.query(Bill).filter(
                Bill.party_company_user_id.in_(team_ids)
            ).all()
            for b in bills:
                delta = float(b.paid_amount or 0.0) - float(b.total_payable or 0.0)
                # R2-326 + D3: single shared classifier - a bare == "sale"
                # pushed material_sale revenue and settlement vouchers into
                # the payable side; is_* helpers keep buckets from drifting.
                if is_revenue_invoice_type(b.invoice_type):
                    recv_net += delta
                elif is_expense_invoice_type(b.invoice_type):
                    pay_net += delta
                # settlement and movement are not payables/receivables (D3)
        advance_paid += max(0.0, pay_net)
        to_pay += max(0.0, -pay_net)
        advance_received += max(0.0, recv_net)
        to_receive += max(0.0, -recv_net)
    return {
        "to_pay": round(to_pay, 2),
        "to_receive": round(to_receive, 2),
        "advance_paid": round(advance_paid, 2),
        "advance_received": round(advance_received, 2),
        "party_count": len(parties),
    }


class EnterpriseRollupCompanyOut(BaseModel):
    id: str
    name: str
    project_count: int
    party_count: int
    to_pay: float
    to_receive: float
    advance_paid: float
    advance_received: float
    balance: float


class EnterpriseRollupResponse(BaseModel):
    enterprise_id: str
    enterprise_name: str
    company_count: int
    project_count: int
    party_count: int
    total_to_pay: float
    total_to_receive: float
    total_advance_paid: float
    total_advance_received: float
    total_balance: float
    companies: list[EnterpriseRollupCompanyOut]


@router.get("/enterprise-rollup/{company_id}", response_model=EnterpriseRollupResponse)
def get_enterprise_rollup(
    company_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Roll up financials across an enterprise group (the company identified by
    company_id plus all of its descendants in the parent_company_id tree).

    Authorization: the caller must be a member of the enterprise company or any
    of its child companies."""
    require_module_view(db, current_user, company_id, "finance")
    descendants = _descendant_company_ids(db, company_id)
    allowed_ids = [company_id] + descendants
    member = db.query(CompanyTeam).filter(
        CompanyTeam.user_id == current_user.id,
        CompanyTeam.company_id.in_(allowed_ids),
    ).first()
    if not member:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User is not a member of this enterprise or its companies",
        )

    enterprise = db.query(Company).filter(Company.id == company_id).first()
    enterprise_name = enterprise.name if enterprise else "Enterprise"

    per_company: list = []
    totals = dict(project_count=0, party_count=0, to_pay=0.0, to_receive=0.0,
                  advance_paid=0.0, advance_received=0.0)
    for cid in allowed_ids:
        comp = db.query(Company).filter(Company.id == cid).first()
        if not comp:
            continue
        proj_count = db.query(Project).filter(Project.company_id == cid).count()
        p = _company_party_totals(db, cid)
        balance = _net_balance(p["advance_paid"], p["to_receive"], p["advance_received"], p["to_pay"])
        per_company.append(EnterpriseRollupCompanyOut(
            id=str(cid),
            name=comp.name,
            project_count=proj_count,
            party_count=p["party_count"],
            to_pay=p["to_pay"],
            to_receive=p["to_receive"],
            advance_paid=p["advance_paid"],
            advance_received=p["advance_received"],
            balance=balance,
        ))
        totals["project_count"] += proj_count
        totals["party_count"] += p["party_count"]
        totals["to_pay"] += p["to_pay"]
        totals["to_receive"] += p["to_receive"]
        totals["advance_paid"] += p["advance_paid"]
        totals["advance_received"] += p["advance_received"]

    total_balance = _net_balance(
        totals["advance_paid"], totals["to_receive"], totals["advance_received"], totals["to_pay"]
    )
    return EnterpriseRollupResponse(
        enterprise_id=str(company_id),
        enterprise_name=enterprise_name,
        company_count=len(per_company),
        project_count=totals["project_count"],
        party_count=totals["party_count"],
        total_to_pay=round(totals["to_pay"], 2),
        total_to_receive=round(totals["to_receive"], 2),
        total_advance_paid=round(totals["advance_paid"], 2),
        total_advance_received=round(totals["advance_received"], 2),
        total_balance=total_balance,
        companies=per_company,
    )


# --- Company-level Transactions & Summary (Finance tab: Transaction sub-tab) ---
def _txn_party_name(db, team_id):
    if not team_id:
        return "Walk-in Party"
    return resolve_party_name(db, team_id, fallback="Unknown Party")


class TransactionRow(BaseModel):
    id: str
    date: str
    type: str
    party: str
    details: str
    status: str
    amount: float
    project_id: Optional[str] = None
    project_name: Optional[str] = None
    ref: str = ""
    due_date: Optional[str] = None

    class Config:
        from_attributes = True


class FinanceSummaryResponse(BaseModel):
    total_invoice: float = 0.0
    unpaid_invoice: float = 0.0
    total_expense: float = 0.0
    unpaid_expense: float = 0.0
    company_balance: float = 0.0
    cash_balance: float = 0.0
    in_total: float = 0.0
    out_total: float = 0.0
    transactions: List[TransactionRow] = []

    class Config:
        from_attributes = True


@router.get("/transactions/{company_id}", response_model=FinanceSummaryResponse)
def get_company_transactions(
    company_id: uuid.UUID,
    search: Optional[str] = None,
    limit: Optional[int] = Query(None, ge=1, le=500),
    offset: int = Query(0, ge=0),
    response: Response = None,
    db: Session = Depends(get_db),
    _: None = Depends(verify_company_access),
    current_user: User = Depends(get_current_user),
):
    require_module_view(db, current_user, company_id, "finance")
    # R2-328: scope by company, not current project membership - Payment.project_id
    # is nullable and SET NULL on project delete, so membership-scoping silently
    # dropped every project-less payment from totals/rows while cash_balance
    # (company-scoped) saw them; Bill.company_id/Payment.company_id are authoritative.
    bills = db.query(Bill).filter(Bill.company_id == company_id, Bill.status != "Cancelled").all()
    payments = db.query(Payment).filter(Payment.company_id == company_id).all()
    project_name_by_id = {p.id: p.name for p in db.query(Project).filter(Project.company_id == company_id).all()}

    total_invoice = 0.0
    unpaid_invoice = 0.0
    total_expense = 0.0
    unpaid_expense = 0.0
    in_total = 0.0
    out_total = 0.0

    rows: List[TransactionRow] = []

    # Each party name costs several queries; resolved per row it made this
    # screen take ~18 s for 74 rows on prod. Resolve each party once.
    party_names: dict = {}

    def party_name(team_id):
        if team_id not in party_names:
            party_names[team_id] = _txn_party_name(db, team_id)
        return party_names[team_id]

    for b in bills:
        party = party_name(b.party_company_user_id)
        payable = float(b.total_payable or 0.0)
        paid = float(b.paid_amount or 0.0)
        outstanding = round(max(0.0, payable - paid), 2)
        type_label = {
            "sale": "Sales Invoice",
            "material_sale": "Material Sales",
            "purchase": "Material Purchase",
            "subcon": "Subcon Bill",
            "expense": "Other Expense",
            "equipment": "Equipment Expense",
        }.get(b.invoice_type, b.invoice_type)
        # R2-326 + D3: revenue is every REVENUE_INVOICE_TYPES member
        # (sale AND material_sale) and expense is exactly EXPENSE_INVOICE_TYPES.
        # Settlement and movement belong in neither head and are classified
        # through the single shared helper so they cannot leak into totals.
        if is_revenue_invoice_type(b.invoice_type):
            total_invoice += payable
            unpaid_invoice += outstanding
        elif is_expense_invoice_type(b.invoice_type):
            total_expense += payable
            unpaid_expense += outstanding
        # settlement and movement are neither invoice nor expense (D3)
        rows.append(TransactionRow(
            id=str(b.id),
            date=(b.invoice_date.strftime("%Y-%m-%d") if b.invoice_date else ""),
            type=type_label,
            party=party,
            details=f"Invoice {b.invoice_number}",
            status=b.status,
            amount=payable,
            project_id=str(b.project_id) if b.project_id else None,
            project_name=project_name_by_id.get(b.project_id) if b.project_id else None,
            ref=b.invoice_number or "",
            due_date=(b.due_date.strftime("%Y-%m-%d") if b.due_date else None),
        ))

    for p in payments:
        party = party_name(p.party_company_user_id)
        amt = float(p.amount or 0.0)
        if p.payment_type == "in":
            in_total += amt
        else:
            out_total += amt
        rows.append(TransactionRow(
            id=str(p.id),
            date=(p.payment_date.strftime("%Y-%m-%d") if p.payment_date else ""),
            type="Payment In" if p.payment_type == "in" else "Payment Out",
            party=party,
            details=p.description or "",
            # R2-343: show the payment's real approval flag (default "pending"),
            # not a hardcoded "Approved" that misreports unreviewed money.
            status=(p.approval_flag or "pending"),
            amount=amt,
            project_id=str(p.project_id) if p.project_id else None,
            project_name=project_name_by_id.get(p.project_id) if p.project_id else None,
            ref=p.reference_number or "",
        ))

    # Company balance = cash wallet + all bank account balances
    cash_balance = _cash_running_balance(db, company_id)
    bank_balance = float(db.query(func.coalesce(func.sum(BankAccount.balance), 0.0)).filter(BankAccount.company_id == company_id).scalar() or 0.0)
    company_balance = round(cash_balance + bank_balance, 2)

    rows.sort(key=lambda r: r.date, reverse=True)

    if search and search.strip():
        term = search.strip().lower()
        rows = [
            r for r in rows
            if term in (r.details or "").lower()
            or term in (r.party or "").lower()
            or term in (r.ref or "").lower()
        ]

    total_txns = len(rows)
    if response is not None:
        response.headers["X-Total-Count"] = str(total_txns)
        if limit is not None:
            response.headers["X-Limit"] = str(limit)
            response.headers["X-Offset"] = str(offset)

    if offset:
        rows = rows[offset:]
    if limit is not None:
        rows = rows[:limit]

    return FinanceSummaryResponse(
        total_invoice=round(total_invoice, 2),
        unpaid_invoice=round(unpaid_invoice, 2),
        total_expense=round(total_expense, 2),
        unpaid_expense=round(unpaid_expense, 2),
        company_balance=company_balance,
        cash_balance=cash_balance,
        in_total=round(in_total, 2),
        out_total=round(out_total, 2),
        transactions=rows,
    )


# R2-179: PAYMENT_REQUEST_FEATURE_TYPE comes from app/approvals.py.


def _pr_response(db: Session, req: PaymentRequest, payment_row: Optional[PaymentRequestPayment] = None) -> PaymentRequestResponse:
    # R2-131: the id is a CompanyTeam reference; resolve through the shared
    # helper so external vendors surface their LibraryParty name.
    party_name = resolve_party_name(db, req.party_company_user_id, fallback="Unknown Party")
    if payment_row is None:
        payment_row = (
            db.query(PaymentRequestPayment)
            .filter(PaymentRequestPayment.payment_request_id == req.id)
            .order_by(PaymentRequestPayment.created_at.desc())
            .first()
        )
    payment_dict = None
    if payment_row:
        payment_dict = {
            "id": str(payment_row.id),
            "payment_date": payment_row.payment_date,
            "payment_mode": payment_row.payment_mode,
            "paid_amount": payment_row.paid_amount,
            "deduction": payment_row.deduction,
            "tds": payment_row.tds,
            "balance_due": payment_row.balance_due,
            "remarks": payment_row.remarks,
            "reference_no": payment_row.reference_no,
            "attachment_name": payment_row.attachment_name,
        }
    levels_required = 0
    if req.approval_rule_id:
        rule = db.query(ApprovalRule).filter(ApprovalRule.id == req.approval_rule_id).first()
        levels_required = rule.levels if rule else 0
    return PaymentRequestResponse(
        id=req.id,
        company_id=req.company_id,
        project_id=req.project_id,
        party_company_user_id=req.party_company_user_id,
        party_name=party_name,
        amount=req.amount,
        # R2-053: rows created without details must still serialize through
        # this plain-str response field; render the standard empty-value glyph.
        details=req.details or "\u2014",
        status=req.status,
        due_date=req.due_date,
        approval_status=req.approval_status,
        approval_rule_id=req.approval_rule_id,
        approvals_required=levels_required,
        approvals_completed=levels_approved(db, "payment_request", req.id) if req.approval_rule_id else 0,
        request_type=req.request_type,
        request_no=req.request_no,
        created_at=req.created_at,
        payment=payment_dict,
    )


@router.get("/payment-requests/{company_id}", response_model=List[PaymentRequestResponse])
def get_payment_requests(
    company_id: uuid.UUID,
    project_id: Optional[uuid.UUID] = None,
    status: Optional[str] = None,
    db: Session = Depends(get_db),
    _: None = Depends(verify_company_access),
    current_user: User = Depends(get_current_user),
):
    require_module_view(db, current_user, company_id, "finance")
    q = db.query(PaymentRequest).filter(PaymentRequest.company_id == company_id)
    if project_id:
        q = q.filter(PaymentRequest.project_id == project_id)
    if status:
        from sqlalchemy import func
        q = q.filter(func.lower(PaymentRequest.status) == status.strip().lower())
    requests = q.all()
    return [_pr_response(db, r) for r in requests]


@router.post("/payment-requests/{company_id}", response_model=PaymentRequestResponse)
def create_payment_request(company_id: uuid.UUID, data: PaymentRequestCreate, db: Session = Depends(get_db), _: None = Depends(verify_company_access), current_user: User = Depends(get_current_user)):
    require_permission(db, current_user, company_id, "finance:edit")
    if data.project_id:
        verify_project_in_company(db, data.project_id, company_id)
    # R2-131: store the counterparty's real name (login user or linked library
    # party), never the requesting login user's name or a bare placeholder.
    party_name = resolve_party_name(db, data.party_company_user_id, fallback="Unknown Party")
    # Auto-generate sequential request no (PR-1, PR-2, ...) per company
    if not data.request_no:
        count = db.query(PaymentRequest).filter(PaymentRequest.company_id == company_id).count()
        candidate = f"PR-{count + 1}"
        while db.query(PaymentRequest).filter(
                PaymentRequest.company_id == company_id,
                PaymentRequest.request_no == candidate).first():
            count += 1
            candidate = f"PR-{count + 1}"
        request_no = candidate
    else:
        request_no = data.request_no

    matched_rule = find_matching_rule(db, company_id, PAYMENT_REQUEST_FEATURE_TYPE, data.amount)
    # A configured ApprovalRule gates this request regardless of what the caller
    # passed in approval_status — it always starts "Pending" and only advances
    # through update_payment_request_status once the required levels sign off.
    approval_status = "Pending" if matched_rule else (data.approval_status or "Pending")

    new_req = PaymentRequest(
        company_id=company_id,
        project_id=data.project_id,
        party_company_user_id=data.party_company_user_id,
        party_name=party_name,
        amount=data.amount,
        details=data.details,
        due_date=data.due_date,
        approval_status=approval_status,
        approval_rule_id=matched_rule.id if matched_rule else None,
        request_type=data.request_type,
        request_no=request_no,
    )
    db.add(new_req)
    db.commit()
    db.refresh(new_req)
    return _pr_response(db, new_req, payment_row=None)


@router.post("/payment-requests/pay/{request_id}", response_model=PaymentRequestResponse)
def record_payment_request(request_id: uuid.UUID, data: PaymentRequestPaymentCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    req = db.query(PaymentRequest).filter(PaymentRequest.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Payment request not found")
    get_company_membership(db, current_user, req.company_id)
    require_permission(db, current_user, req.company_id, "billing:approve")
    if req.approval_rule_id and req.approval_status != "Approved":
        raise HTTPException(status_code=400, detail="Payment request is pending approval; it cannot be recorded as paid until all required levels have signed off")

    # R2-381: a recorded payment obeys the same back-dating window as bills.
    enforce_entry_creation_window(db, req.company_id, data.payment_date)

    # Balance due is cumulative across ALL recorded payments against this request,
    # not just the current call — otherwise each new payment resets the balance.
    prior = db.query(PaymentRequestPayment).filter(
        PaymentRequestPayment.payment_request_id == req.id
    ).all()
    prior_paid = sum(float(p.paid_amount) for p in prior)
    prior_deduction = sum(float(p.deduction) for p in prior)
    prior_tds = sum(float(p.tds) for p in prior)
    total_paid = prior_paid + float(data.paid_amount)
    total_deduction = prior_deduction + float(data.deduction)
    total_tds = prior_tds + float(data.tds)
    balance_due = max(0.0, req.amount - total_paid - total_deduction - total_tds)

    payment = PaymentRequestPayment(
        payment_request_id=req.id,
        company_id=req.company_id,
        payment_date=data.payment_date,
        payment_mode=data.payment_mode,
        paid_amount=data.paid_amount,
        deduction=data.deduction,
        tds=data.tds,
        balance_due=balance_due,
        remarks=data.remarks,
        reference_no=data.reference_no,
        attachment_name=data.attachment_name,
    )
    db.add(payment)

    # Status reflects the true cumulative balance: only "Paid" once fully settled.
    # Approval is a separate workflow (update_payment_request_status) and is left
    # untouched here.
    req.status = "Paid" if balance_due <= 0 else "Partially Paid"
    db.commit()
    db.refresh(req)
    return _pr_response(db, req, payment_row=payment)


class PaymentRequestStatusUpdate(BaseModel):
    status: str

@router.put("/payment-requests/approve/{request_id}", response_model=PaymentRequestResponse)
def update_payment_request_status(request_id: uuid.UUID, payload: PaymentRequestStatusUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    req = db.query(PaymentRequest).filter(PaymentRequest.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Payment request not found")
    get_company_membership(db, current_user, req.company_id)
    require_permission(db, current_user, req.company_id, "billing:approve")

    rule = db.query(ApprovalRule).filter(ApprovalRule.id == req.approval_rule_id).first() if req.approval_rule_id else None
    action_status = payload.status

    if action_status == "Rejected":
        if rule:
            matched = match_approver(rule.approvers, current_user)
            if not matched:
                raise HTTPException(status_code=403, detail="You are not a configured approver for this payment request")
            record_action(
                db, company_id=req.company_id, rule_id=rule.id, entity_type="payment_request", entity_id=req.id,
                level=levels_approved(db, "payment_request", req.id) + 1, action="rejected", user=current_user, matched_label=matched,
            )
        req.status = "Rejected"
        req.approval_status = "Rejected"

    elif action_status in ("Approved", "Paid"):
        if req.approval_status == "Rejected":
            raise HTTPException(status_code=400, detail="Payment request was rejected; cannot approve")
        if req.approval_status == "Approved":
            # Already fully signed off — idempotently move to the requested terminal status.
            req.status = action_status
        elif rule:
            if action_status == "Paid":
                raise HTTPException(status_code=400, detail="Payment request is pending approval; approve all required levels before marking it paid")
            matched = match_approver(rule.approvers, current_user)
            if not matched:
                raise HTTPException(status_code=403, detail="You are not a configured approver for this payment request")
            if user_already_acted(db, "payment_request", req.id, current_user.id):
                raise HTTPException(status_code=400, detail="You have already recorded a decision on this payment request")

            next_level = levels_approved(db, "payment_request", req.id) + 1
            record_action(
                db, company_id=req.company_id, rule_id=rule.id, entity_type="payment_request", entity_id=req.id,
                level=next_level, action="approved", user=current_user, matched_label=matched,
            )
            if next_level >= rule.levels:
                req.approval_status = "Approved"
                req.status = "Approved"
            # else: still pending_approval, awaiting further levels — status/approval_status unchanged
        else:
            req.status = action_status
            req.approval_status = "Approved"
    else:
        req.status = action_status

    db.commit()
    db.refresh(req)
    return _pr_response(db, req)


@router.delete("/payment-requests/{request_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_payment_request(request_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Delete a payment request. Tenant-scoped: the caller must belong to the
    request's company, and the deletion is written to the DeleteLog audit trail."""
    req = db.query(PaymentRequest).filter(PaymentRequest.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Payment request not found")
    get_company_membership(db, current_user, req.company_id)
    require_permission(db, current_user, req.company_id, "data:delete")
    from app.routers.delete_logs import log_deletion
    log_deletion(db, req.company_id, "payment_request", req.id, f"Payment Request: {req.request_no or req.id}", deleted_by=current_user.name)
    db.delete(req)
    db.commit()


# --- P2P Transfer Endpoints ---
class P2PTransferRequest(BaseModel):
    company_id: uuid.UUID
    sender_company_user_id: uuid.UUID
    receiver_company_user_id: uuid.UUID
    amount: float = Field(..., gt=0)
    payment_date: datetime
    description: Optional[str] = None

class P2PTransferResponse(BaseModel):
    sender_payment_id: uuid.UUID
    receiver_payment_id: uuid.UUID
    status: str

cashbook_router = APIRouter(
    prefix="/cashbook",
    tags=["Cashbook & P2P"],
    dependencies=[Depends(get_current_user)]
)

def perform_p2p_transfer(req: P2PTransferRequest, db: Session):
    comp_uuid = uuid.UUID(str(req.company_id))
    sender_uuid = uuid.UUID(str(req.sender_company_user_id))
    receiver_uuid = uuid.UUID(str(req.receiver_company_user_id))
    
    sender = db.query(CompanyTeam).filter(CompanyTeam.id == sender_uuid, CompanyTeam.company_id == comp_uuid).first()
    if not sender:
        raise HTTPException(status_code=404, detail="Sender not found in company team")
        
    receiver = db.query(CompanyTeam).filter(CompanyTeam.id == receiver_uuid, CompanyTeam.company_id == comp_uuid).first()
    if not receiver:
        raise HTTPException(status_code=404, detail="Receiver not found in company team")

    if sender_uuid == receiver_uuid:
        raise HTTPException(status_code=422, detail="Sender and receiver must be different parties")

    if req.amount <= 0:
        raise HTTPException(status_code=400, detail="Transfer amount must be greater than zero")

    # R2-381: P2P transfers are money entries and obey the back-dating window.
    enforce_entry_creation_window(db, comp_uuid, req.payment_date)

    sender_payment = Payment(
        id=uuid.uuid4(),
        company_id=comp_uuid,
        project_id=None,
        party_company_user_id=sender_uuid,
        payment_type="out",
        amount=req.amount,
        unsettled_amount=req.amount,
        payment_method="Cash",
        reference_number=f"P2P-OUT-{uuid.uuid4().hex[:6].upper()}",
        description=req.description or f"P2P transfer to team member {receiver_uuid}",
        payment_date=req.payment_date
    )
    db.add(sender_payment)

    receiver_payment = Payment(
        id=uuid.uuid4(),
        company_id=comp_uuid,
        project_id=None,
        party_company_user_id=receiver_uuid,
        payment_type="in",
        amount=req.amount,
        unsettled_amount=req.amount,
        payment_method="Cash",
        reference_number=f"P2P-IN-{uuid.uuid4().hex[:6].upper()}",
        description=req.description or f"P2P transfer from team member {sender_uuid}",
        payment_date=req.payment_date
    )
    db.add(receiver_payment)
    db.commit()

    return P2PTransferResponse(
        sender_payment_id=sender_payment.id,
        receiver_payment_id=receiver_payment.id,
        status="Success"
    )

@cashbook_router.post("/p2p", response_model=P2PTransferResponse, status_code=status.HTTP_201_CREATED)
def p2p_transfer_cashbook(req: P2PTransferRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # The frontend calls this exact route for team-member P2P transfers. It moves
    # money between two CompanyTeam members, so it must be tenant-scoped AND gated
    # by the same finance:edit permission as its /finance/cashbook/p2p twin.
    get_company_membership(db, current_user, req.company_id)
    require_permission(db, current_user, req.company_id, "finance:edit")
    return perform_p2p_transfer(req, db)

@router.post("/cashbook/p2p", response_model=P2PTransferResponse, status_code=status.HTTP_201_CREATED)
def p2p_transfer_finance(req: P2PTransferRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    require_permission(db, current_user, req.company_id, "finance:edit")
    return perform_p2p_transfer(req, db)


# ---------------------------------------------------------------------------
# R2-533 / R2-534 - payments CSV import.
#
# The importer used to carry four compounding defects. Each is fixed at the
# point of ingestion rather than at a call site, so no caller can reintroduce
# it: an unreadable value is rejected instead of being coerced, and a row's
# identity is derived from its own content instead of being invented.
# ---------------------------------------------------------------------------

# Money direction is a closed vocabulary with no default. The old importer
# treated everything that was not exactly "receipt" or "in" as outgoing, so
# "Credit", "Received", a stray trailing space or a blank cell silently turned
# a company's income into expenditure at a 100% rate.
PAYMENT_TYPE_INBOUND = frozenset({
    "in", "inward", "incoming", "receipt", "receipts", "received",
    "credit", "credited", "cr", "deposit", "deposited", "collection",
})
PAYMENT_TYPE_OUTBOUND = frozenset({
    "out", "outward", "outgoing", "payment", "payments", "paid",
    "debit", "debited", "dr", "expense", "withdrawal", "disbursement",
})

# Unambiguous ISO forms are always accepted. Day/month order in a slash or
# dash date (03/04/2026) is genuinely ambiguous, so it is only interpreted
# once the caller declares which convention the statement was exported in.
_ISO_DATE_FORMATS = ("%Y-%m-%d", "%Y/%m/%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S")
_AMBIGUOUS_DATE_FORMATS = {
    "DMY": ("%d/%m/%Y", "%d-%m-%Y"),
    "MDY": ("%m/%d/%Y", "%m-%d-%Y"),
}


def _normalise_payment_type(raw):
    """Map a statement's Payment Type to "in"/"out".

    Returns None for anything not in the vocabulary, including blank. There is
    deliberately no default: guessing "out" is how receipts were booked as
    expenditure.
    """
    token = " ".join((raw or "").split()).lower()
    if token in PAYMENT_TYPE_INBOUND:
        return "in"
    if token in PAYMENT_TYPE_OUTBOUND:
        return "out"
    return None


def _parse_payment_date(raw, date_format="DMY"):
    """Parse a statement date, returning None when it cannot be read.

    The old importer substituted datetime.utcnow() for anything unparseable,
    booking a payment from last quarter into today's period with no flag.
    There is no honest value to substitute, so the caller skips the row
    instead -- and says so.
    """
    token = (raw or "").strip()
    if not token:
        return None
    for fmt in _ISO_DATE_FORMATS:
        try:
            return datetime.strptime(token, fmt)
        except ValueError:
            continue
    for fmt in _AMBIGUOUS_DATE_FORMATS.get(date_format, _AMBIGUOUS_DATE_FORMATS["DMY"]):
        try:
            return datetime.strptime(token, fmt)
        except ValueError:
            continue
    return None


def _payment_import_reference(company_id, *, explicit_ref, payment_type, amount,
                              payment_date, party_name, method, remark):
    """Return a stable reference for an imported payment row.

    The importer used to mint "CSV-V-<random>" whenever the file carried no
    Payment Request ID, so no two uploads of the same statement produced the
    same value and every payment was booked twice. A row's own content is a
    perfectly good identity, so the reference is derived from it: re-uploading
    the same statement now collides with itself, and the existing
    (company_id, reference_number) unique constraint rejects the duplicate.
    """
    if explicit_ref:
        return explicit_ref
    basis = "|".join([
        str(company_id),
        payment_type,
        f"{float(amount):.2f}",
        payment_date.strftime("%Y-%m-%d"),
        " ".join((party_name or "").split()).lower(),
        " ".join((method or "").split()).lower(),
        " ".join((remark or "").split()).lower(),
    ])
    return "CSV-" + hashlib.sha256(basis.encode("utf-8")).hexdigest()[:16].upper()


@cashbook_router.post("/upload")
def upload_payments(
    company_id: uuid.UUID = Form(...),
    file: UploadFile = File(...),
    date_format: str = Form("DMY"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user)
):
    # company_id here comes from multipart form data (not the URL path/query),
    # so it can't share a value with a plain Depends(verify_company_access)
    # sub-dependency; verify membership + write permission inline instead.
    get_company_membership(db, current_user, company_id)
    require_permission(db, current_user, company_id, "finance:edit")

    # R2-533 clause 3: an ambiguous date is only interpreted when the
    # caller declares which day/month convention the statement uses.
    date_format = (date_format or "DMY").strip().upper()
    if date_format not in _AMBIGUOUS_DATE_FORMATS:
        raise HTTPException(
            status_code=422,
            detail="date_format must be one of: DMY, MDY",
        )

    import csv
    import io

    # R2-608: reading the upload is the only step a bad input alone can
    # break, so the old generic except Exception sat here returning raw
    # interpreter internals ("'utf-8' codec can't decode byte 0xff...") for
    # any non-text blob. An undecodable file is a user error and gets an
    # honest 400 naming the fix; anything unexpected is logged server-side
    # and surfaced honestly instead of masquerading.
    try:
        content = file.file.read().decode("utf-8")
        csv_reader = csv.reader(io.StringIO(content))
    except UnicodeDecodeError:
        raise HTTPException(
            status_code=400,
            detail="Uploaded file could not be decoded as UTF-8 text. Please upload a CSV export of payments.",
        )
    except Exception:
        logger.exception("Payment CSV upload failed while reading the uploaded file")
        raise HTTPException(status_code=400, detail="Failed to read the uploaded file. Please re-upload a valid CSV export.")
        
    headers = next(csv_reader, None)
    if not headers:
        raise HTTPException(status_code=400, detail="Empty CSV file")
        
    headers = [h.replace('\ufeff', '').strip() for h in headers]
    
    required = ["Payment Type", "Party Name", "Amount"]
    for col in required:
        if col not in headers:
            raise HTTPException(status_code=400, detail=f"Invalid CSV schema: '{col}' column is required")

    # R2-533 clause 3: "Payment Date" is optional in the schema, so a file with
    # no date column is a declared omission -- those rows are dated today and
    # the response says how many. A file that HAS the column but whose date
    # cells cannot be read is the actual defect: those rows are rejected rather
    # than silently booked into today's period.
    has_date_column = "Payment Date" in headers

    created_count = 0
    duplicate_count = 0
    dated_today = 0
    skipped = []
    # Reported line numbers count the header, so the operator can jump
    # straight to the offending row in the file they uploaded.
    line_no = 1

    # R2-533 clause 1: every reference this company already holds. The
    # (company_id, reference_number) unique constraint is the real guard; this
    # is the cheap pre-check that lets a duplicate be reported as a duplicate
    # instead of blowing up the whole batch at commit time.
    known_references = {
        ref
        for (ref,) in db.query(Payment.reference_number).filter(
            Payment.company_id == company_id,
            Payment.reference_number.isnot(None),
        )
    }

    for row_cells in csv_reader:
        line_no += 1
        if not row_cells or not any(row_cells):
            continue

        row = {}
        for idx, header in enumerate(headers):
            if idx < len(row_cells):
                row[header] = row_cells[idx].strip()

        party_name = (row.get("Party Name") or "").strip()
        amt_str = (row.get("Amount") or "").strip()

        # Clause 2 - direction. Unrecognised is rejected, never defaulted.
        payment_type = _normalise_payment_type(row.get("Payment Type"))
        if payment_type is None:
            skipped.append({
                "line": line_no,
                "reason": (
                    "Unrecognised Payment Type '{}'. Use an incoming form "
                    "(receipt, credit, in) or an outgoing one (payment, debit, out)."
                ).format(row.get("Payment Type") or ""),
            })
            continue

        try:
            amount = float(amt_str) if amt_str else 0.0
        except ValueError:
            skipped.append({
                "line": line_no,
                "reason": "Amount '{}' is not a number.".format(amt_str),
            })
            continue

        if amount <= 0:
            skipped.append({
                "line": line_no,
                "reason": "Amount {} must be greater than zero.".format(amount),
            })
            continue

        # Clause 3 - date. An unreadable value is rejected, never replaced by
        # today. The only exception is a file that declares no date column at
        # all, where dating the row today is the operator's stated intent and
        # is reported back to them.
        if has_date_column:
            payment_date = _parse_payment_date(row.get("Payment Date"), date_format)
            if payment_date is None:
                skipped.append({
                    "line": line_no,
                    "reason": (
                        "Payment Date '{}' could not be read. Export as YYYY-MM-DD, "
                        "or pass date_format=MDY for month-first statements."
                    ).format(row.get("Payment Date") or ""),
                })
                continue
        else:
            payment_date = datetime.now(timezone.utc)
            dated_today += 1

        # R2-534: resolve the party inside this company only. The old query
        # matched User.name across the whole platform and took .first(), so a
        # same-named member of another tenant shadowed this company's own and
        # the payment landed unattributed.
        party_team_id = None
        if party_name:
            member = (
                db.query(CompanyTeam.id)
                .join(User, User.id == CompanyTeam.user_id)
                .filter(
                    CompanyTeam.company_id == company_id,
                    User.name == party_name,
                )
                .first()
            )
            if member:
                party_team_id = member.id

        project_name = (row.get("Project Name") or "").strip()
        project_id = None
        if project_name:
            proj = db.query(Project).filter(
                Project.name == project_name,
                Project.company_id == company_id,
            ).first()
            if proj:
                project_id = proj.id

        method = row.get("Mode of Payment") or "Cash"
        remark = row.get("Remark") or f"CSV Uploaded Payment - Category: {row.get('Category')}"

        reference_number = _payment_import_reference(
            company_id,
            explicit_ref=(row.get("Payment Request ID") or "").strip(),
            payment_type=payment_type,
            amount=amount,
            payment_date=payment_date,
            party_name=party_name,
            method=method,
            remark=remark,
        )

        if reference_number in known_references:
            duplicate_count += 1
            continue
        known_references.add(reference_number)

        db.add(Payment(
            id=uuid.uuid4(),
            company_id=company_id,
            project_id=project_id,
            party_company_user_id=party_team_id,
            payment_type=payment_type,
            amount=amount,
            unsettled_amount=amount,
            payment_method=method,
            reference_number=reference_number,
            description=remark,
            payment_date=payment_date,
        ))
        created_count += 1

    db.commit()

    # Clause 4 - the response reports what it actually did. A batch that
    # dropped rows, or dated rows today because the file carried no date
    # column, no longer claims a clean success.
    warnings = []
    if dated_today:
        warnings.append(
            "{} row(s) were dated today because the file has no Payment Date "
            "column. Add that column to book payments into their real period.".format(dated_today)
        )

    return {
        "status": "success" if not skipped and not warnings else "completed_with_warnings",
        "created": created_count,
        "duplicates": duplicate_count,
        "dated_today": dated_today,
        "skipped": skipped,
        "warnings": warnings,
        "date_format": date_format,
    }


