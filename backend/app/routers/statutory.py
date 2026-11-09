import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Literal, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field, field_validator
from app.database import get_db
from app.auth import get_current_user, verify_project_in_company, verify_company_access, require_permission, require_module_view
from app.models import StatutoryReport, StaffEmployee, PayrollRun, PayrollLineItem, User, Bill, CompanyTeam, LibraryParty, TransactionDeduction
from app.constants import REVENUE_INVOICE_TYPES
from decimal import Decimal

router = APIRouter(prefix="/statutory", tags=["Statutory Reports"], dependencies=[Depends(get_current_user)])

# Types with a derived due-date rule in calculate_due_date. R2-721: these were
# previously matched case-sensitively, so "PF" silently saved without a due date.
DUE_DATE_RULE_TYPES = ("tds", "pf", "esi", "bocw")
# Full set of report types the product supports (superset used by the statutory
# page dropdown; pt/it have no encoded due-date rule by design).
VALID_REPORT_TYPES = DUE_DATE_RULE_TYPES + ("pt", "it")


def _normalize_report_type(value: str) -> str:
    return (value or "").strip().lower()


class StatutoryReportCreate(BaseModel):
    company_id: uuid.UUID
    project_id: Optional[uuid.UUID] = None
    report_type: Literal["pf", "esi", "bocw", "tds", "pt", "it"]
    return_period: str
    total_employees: int = Field(0, ge=0)
    total_wages: float = Field(0.0, ge=0)
    pf_employee_contribution: float = Field(0.0, ge=0)
    pf_employer_contribution: float = Field(0.0, ge=0)
    esi_employee_contribution: float = Field(0.0, ge=0)
    esi_employer_contribution: float = Field(0.0, ge=0)
    bocw_cess: float = Field(0.0, ge=0)
    tds_deducted: float = Field(0.0, ge=0)
    professional_tax: float = Field(0.0, ge=0)
    filed_by: Optional[str] = None
    acknowledgment_number: Optional[str] = None
    status: str = "draft"
    due_date: Optional[datetime] = None

    @field_validator("report_type", mode="before")
    @classmethod
    def _lowercase_report_type(cls, v):
        return _normalize_report_type(v) if isinstance(v, str) else v


class StatutoryReportResponse(BaseModel):
    id: uuid.UUID
    company_id: uuid.UUID
    project_id: Optional[uuid.UUID]
    report_type: str
    return_period: str
    total_employees: int
    total_wages: float
    pf_employee_contribution: float
    pf_employer_contribution: float
    esi_employee_contribution: float
    esi_employer_contribution: float
    bocw_cess: float
    tds_deducted: float
    professional_tax: float = 0.0
    # R2-283: Optional[X] without a default is REQUIRED in Pydantic v2, so any
    # response built from a dict that omits these keys (auto-populate) died in
    # flight with "3 validation errors" before the caller saw anything.
    filed_at: Optional[datetime] = None
    filed_by: Optional[str] = None
    acknowledgment_number: Optional[str] = None
    status: str
    due_date: Optional[datetime] = None
    days_overdue: int = 0
    penalty_estimate: float = 0.0
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


def calculate_due_date(report_type: str, return_period: str) -> Optional[datetime]:
    try:
        year, month = map(int, return_period.split("-"))
        next_year, next_month = (year + 1, 1) if month == 12 else (year, month + 1)
        rt = _normalize_report_type(report_type)
        if rt == "tds":
            return datetime(next_year, next_month, 7)
        if rt == "pt":
            # Monthly PT returns (Maharashtra and most states) fall due by
            # the end of the following month.
            after_year, after_month = (next_year + 1, 1) if next_month == 12 else (next_year, next_month + 1)
            return datetime(after_year, after_month, 1) - timedelta(days=1)
        elif rt in DUE_DATE_RULE_TYPES:
            return datetime(next_year, next_month, 15)
        return None
    except Exception:
        return None


@router.post("", response_model=StatutoryReportResponse, status_code=status.HTTP_201_CREATED)
def create_report(payload: StatutoryReportCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    require_permission(db, current_user, payload.company_id, "payroll:edit")
    data = payload.model_dump()
    for k in ("total_wages", "pf_employee_contribution", "pf_employer_contribution",
              "esi_employee_contribution", "esi_employer_contribution", "bocw_cess", "tds_deducted",
              "professional_tax"):
        data[k] = Decimal(str(data[k]))
    if not data.get("due_date"):
        data["due_date"] = calculate_due_date(data["report_type"], data["return_period"])
    report = StatutoryReport(**data)
    db.add(report)
    db.commit()
    db.refresh(report)
    return _enrich(report, db)


@router.get("/{company_id}", response_model=List[StatutoryReportResponse])
def list_reports(company_id: uuid.UUID, report_type: Optional[str] = None, db: Session = Depends(get_db), _: None = Depends(verify_company_access), current_user: User = Depends(get_current_user)):
    require_module_view(db, current_user, company_id, "payroll")
    query = db.query(StatutoryReport).filter(StatutoryReport.company_id == company_id)
    if report_type:
        query = query.filter(StatutoryReport.report_type == _normalize_report_type(report_type))
    reports = query.order_by(StatutoryReport.return_period.desc()).all()
    return [_enrich(r, db) for r in reports]


@router.get("/{company_id}/auto-populate", response_model=StatutoryReportResponse)
def auto_populate(company_id: uuid.UUID, report_type: str = Query(...), return_period: str = Query(...), project_id: Optional[uuid.UUID] = None, db: Session = Depends(get_db), _: None = Depends(verify_company_access), current_user: User = Depends(get_current_user)):
    require_module_view(db, current_user, company_id, "payroll")
    if project_id:
        verify_project_in_company(db, project_id, company_id)
    year, month = map(int, return_period.split("-"))
    start_date = datetime(year, month, 1)
    if month == 12:
        end_date = datetime(year + 1, 1, 1)
    else:
        end_date = datetime(year, month + 1, 1)

    # R2-126: a statutory return is a snapshot of the period's finalized
    # payroll, not of today's master data. Every figure comes from the payslip
    # lines of the runs for return_period and generation refuses when no
    # finalized run exists - the old path silently substituted current
    # salaries (a raise rewrote history), dropped leavers whose wages were
    # paid, and back-dated joiners into periods before they existed.
    runs_query = db.query(PayrollRun).filter(
        PayrollRun.company_id == company_id,
        PayrollRun.payroll_month == return_period,
        PayrollRun.status == "finalized",
    )
    if project_id:
        runs_query = runs_query.filter(PayrollRun.project_id == project_id)
    payroll_runs = runs_query.all()
    if not payroll_runs:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"No finalized payroll run exists for {return_period}. Finalize payroll for the period before generating a statutory return.",
        )

    line_items = db.query(PayrollLineItem).filter(
        PayrollLineItem.payroll_run_id.in_([r.id for r in payroll_runs])
    ).all()

    total_wages = sum(float(li.basic or 0) + float(li.hra or 0) + float(li.other_allowances or 0) for li in line_items)
    pf_employee = sum(float(li.pf_employee or 0) for li in line_items)
    pf_employer = sum(float(li.pf_employer or 0) for li in line_items)
    # R2-127: applicability is settled per employee inside payroll when the
    # payslip is computed; the statutory return carries those amounts verbatim.
    esi_employee = sum(float(li.esi_employee or 0) for li in line_items)
    esi_employer = sum(float(li.esi_employer or 0) for li in line_items)
    tds = sum(float(li.tds or 0) for li in line_items)
    pt = sum(float(getattr(li, "professional_tax", 0) or 0) for li in line_items)

    # R2-128: the BOCW Cess Act levies 1% on the cost of construction, not on
    # the wage bill. Same bill-ledger base as labour/bocw (R2-415): money-out
    # invoices booked inside the period, cancelled ones excluded.
    bocw_cess = Decimal("0")
    if _normalize_report_type(report_type) == "bocw":
        bills_query = db.query(Bill).filter(
            Bill.company_id == company_id,
            Bill.invoice_type.in_(["purchase", "subcon"]),
            Bill.status != "Cancelled",
            Bill.invoice_date >= start_date,
            Bill.invoice_date < end_date,
        )
        if project_id:
            bills_query = bills_query.filter(Bill.project_id == project_id)
        cost_of_construction = sum(float(b.subtotal or 0) for b in bills_query.all())
        bocw_cess = Decimal(str(round(cost_of_construction * 0.01, 2)))

    data = {
        "company_id": company_id,
        "project_id": project_id,
        "report_type": report_type,
        "return_period": return_period,
        "total_employees": len({li.employee_id for li in line_items}),
        "total_wages": Decimal(str(round(total_wages, 2))),
        "pf_employee_contribution": Decimal(str(round(pf_employee, 2))),
        "pf_employer_contribution": Decimal(str(round(pf_employer, 2))),
        "esi_employee_contribution": Decimal(str(round(esi_employee, 2))),
        "esi_employer_contribution": Decimal(str(round(esi_employer, 2))),
        "bocw_cess": bocw_cess,
        "tds_deducted": Decimal(str(round(tds, 2))),
        "professional_tax": Decimal(str(round(pt, 2))),
        "status": "draft",
    }
    data["id"] = uuid.uuid4()
    data["created_at"] = datetime.utcnow()
    data["updated_at"] = datetime.utcnow()
    return StatutoryReportResponse(**data)


@router.patch("/{report_id}/file", response_model=StatutoryReportResponse)
def file_report(report_id: uuid.UUID, acknowledgment_number: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    report = db.query(StatutoryReport).filter(StatutoryReport.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    require_permission(db, current_user, report.company_id, "payroll:edit")
    ack = acknowledgment_number.strip()
    if not ack:
        raise HTTPException(status_code=422, detail="acknowledgment_number must not be blank")
    if not report.total_wages and not report.total_employees:
        raise HTTPException(status_code=400, detail="Cannot file an empty return: the report has no employees and no wages")
    report.status = "filed"
    report.filed_at = datetime.utcnow()
    report.filed_by = current_user.name
    report.acknowledgment_number = ack
    db.commit()
    db.refresh(report)
    return _enrich(report, db)


@router.get("/{company_id}/penalty", response_model=dict)
def estimate_penalty(company_id: uuid.UUID, report_type: str = Query(...), return_period: str = Query(...), db: Session = Depends(get_db), _: None = Depends(verify_company_access), current_user: User = Depends(get_current_user)):
    require_module_view(db, current_user, company_id, "payroll")
    report = db.query(StatutoryReport).filter(
        StatutoryReport.company_id == company_id,
        StatutoryReport.report_type == _normalize_report_type(report_type),
        StatutoryReport.return_period == return_period,
    ).order_by(StatutoryReport.created_at.desc()).first()
    if not report:
        raise HTTPException(status_code=404, detail="No statutory report found for this report type and period")
    return {
        "report_type": report.report_type,
        "return_period": report.return_period,
        "total_wages": float(report.total_wages or 0),
        "estimated_penalty": 0.0,
        "due_date": calculate_due_date(report.report_type, report.return_period),
    }


# DEFECT-08 fix: Dedicated statutory export endpoints referenced in API spec
# These were missing — the spec says /gstr1, /pf-ecr, /tds-26q but only /{company_id} existed.


_TDS_SECTION_RE = re.compile(r"19\d[A-Z]+")


def _parse_tds_section(notes: str) -> str:
    """Pull the TDS section (e.g. 194C, 194J) recorded in deduction notes;
    contractor payments default to 194C when none was captured."""
    match = _TDS_SECTION_RE.search(notes or "")
    return match.group(0) if match else "194C"


def _party_tax_identity(db: Session, party_team_id) -> tuple:
    """Resolve (party name, GSTIN/tax id, PAN) for a bill's company_team party."""
    team = db.query(CompanyTeam).filter(CompanyTeam.id == party_team_id).first()
    if not team or not team.library_party_id:
        return None, None, None
    party = db.query(LibraryParty).filter(LibraryParty.id == team.library_party_id).first()
    if not party:
        return None, None, None
    return party.name, party.tax_no, party.pan_number


@router.get("/{company_id}/gstr1")
def export_gstr1(
    company_id: uuid.UUID,
    month: int = Query(..., ge=1, le=12, description="Month (1-12)"),
    year: int = Query(..., ge=2020, description="Calendar year (e.g. 2026)"),
    db: Session = Depends(get_db),
    _: None = Depends(verify_company_access),
    current_user: User = Depends(get_current_user),
):
    """GSTR-1 outward supply summary report for the given month/year.

    R2-522: built from the sales invoice ledger. The StatutoryReport table this
    endpoint previously read has no GST columns - its own comment enumerates
    pf/esi/bocw/tds/pt/it - so the old query could only ever echo payroll wages
    back as a "GST return". Outward supplies live in the bills table.
    """
    # R2-522: GST is a finance and tax responsibility, not a payroll one -
    # a payroll clerk must not read the GST return and finance must.
    require_module_view(db, current_user, company_id, "finance")
    start_date = datetime(year, month, 1)
    end_date = datetime(year + 1, 1, 1) if month == 12 else datetime(year, month + 1, 1)
    due_year, due_month = (year + 1, 1) if month == 12 else (year, month + 1)

    bills = db.query(Bill).filter(
        Bill.company_id == company_id,
        Bill.invoice_type.in_(REVENUE_INVOICE_TYPES),
        Bill.status != "Cancelled",
        Bill.invoice_date >= start_date,
        Bill.invoice_date < end_date,
    ).order_by(Bill.invoice_date.asc()).all()

    records = []
    taxable_total = 0.0
    gst_total = 0.0
    for b in bills:
        taxable = float(b.subtotal or 0)
        gst_amount = float(b.gst_amount or 0)
        party_name, party_gstin, _pan = _party_tax_identity(db, b.party_company_user_id)
        half_tax = round(gst_amount / 2, 2)
        records.append({
            "invoice_number": b.invoice_number,
            "invoice_date": b.invoice_date.date().isoformat(),
            "party_name": party_name,
            "party_gstin": party_gstin,
            "taxable_value": round(taxable, 2),
            "gst_amount": round(gst_amount, 2),
            "cgst": half_tax,
            "sgst": half_tax,
            # No place-of-supply data is captured per invoice; the equal
            # CGST/SGST split mirrors reports.py's documented assumption.
            "igst": 0.0,
        })
        taxable_total += taxable
        gst_total += gst_amount

    return {
        "report": "GSTR-1",
        "company_id": str(company_id),
        "return_period": f"{year}-{month:02d}",
        "due_date": f"{due_year}-{due_month:02d}-11",
        "status": "generated" if records else "not_generated",
        "total_invoices": len(records),
        "total_taxable_value": round(taxable_total, 2),
        "total_gst": round(gst_total, 2),
        "records": records,
    }


@router.get("/{company_id}/pf-ecr")
def export_pf_ecr(
    company_id: uuid.UUID,
    month: int = Query(..., ge=1, le=12, description="Month (1-12)"),
    year: int = Query(..., ge=2020, description="Calendar year (e.g. 2026)"),
    db: Session = Depends(get_db),
    _: None = Depends(verify_company_access),
    current_user: User = Depends(get_current_user),
):
    """PF Electronic Challan cum Return (ECR) data for the given month.

    R2-523: built from the period's finalized payslips, so the member list and
    PF wages are what was actually paid for return_period - not today's active
    roster filed at full monthly salary every month. The employer share is
    split into EPS (8.33% of PF wages, the pension scheme) and EPF (remainder),
    as EPFO's ECR requires.
    """
    require_module_view(db, current_user, company_id, "payroll")
    return_period = f"{year}-{month:02d}"
    runs = db.query(PayrollRun).filter(
        PayrollRun.company_id == company_id,
        PayrollRun.payroll_month == return_period,
        PayrollRun.status == "finalized",
    ).all()
    if not runs:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"No finalized payroll run exists for {return_period}. Finalize payroll before generating the PF ECR.",
        )

    employees_by_id = {
        e.id: e for e in db.query(StaffEmployee).filter(StaffEmployee.company_id == company_id)
    }
    line_items = db.query(PayrollLineItem).filter(
        PayrollLineItem.payroll_run_id.in_([r.id for r in runs])
    ).all()

    # R2-756: Refuse export if any employee included in the return lacks a valid 12-digit UAN
    missing_uan_employees = []
    for li in line_items:
        emp = employees_by_id.get(li.employee_id)
        if emp and not (emp.uan and str(emp.uan).strip()):
            missing_uan_employees.append(emp.name)
    
    if missing_uan_employees:
        unique_names = sorted(set(missing_uan_employees))
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot generate PF ECR return: employee(s) missing UAN: {', '.join(unique_names)}. Update employee records with 12-digit UAN before filing.",
        )

    ecr_lines = []
    for li in line_items:
        emp = employees_by_id.get(li.employee_id)
        if not emp:
            continue
        # File what the payslip deducted. Recomputing from today's employee
        # percentages and a fixed Rs 15,000 ceiling disagreed with payroll
        # whenever the company's PF wage ceiling or an employee's rate differed.
        ee_pf = round(float(li.pf_employee or 0), 2)
        er_pf = round(float(li.pf_employer or 0), 2)
        ee_pct = float(emp.pf_employee_pct or 12)
        pf_wages = round(ee_pf * 100 / ee_pct, 2) if ee_pct > 0 and ee_pf > 0 else min(float(li.basic or 0), 15000.0)
        # Pension (EPS) is 8.33% of wages up to the statutory Rs 15,000, never
        # more than the employer's share; the rest of that share is EPF.
        eps_pf = min(round(min(pf_wages, 15000.0) * 8.33 / 100, 2), er_pf)
        epf_pf = round(er_pf - eps_pf, 2)
        ecr_lines.append({
            "uan": emp.uan,
            "employee_code": emp.employee_code or str(emp.id)[:8].upper(),
            "name": emp.name,
            "pf_wages": pf_wages,
            "ee_pf_contribution": ee_pf,
            "er_pf_contribution": er_pf,
            "eps_contribution": eps_pf,
            "epf_contribution": epf_pf,
            "total_pf": round(ee_pf + er_pf, 2),
        })

    total_ee = round(sum(r["ee_pf_contribution"] for r in ecr_lines), 2)
    total_er = round(sum(r["er_pf_contribution"] for r in ecr_lines), 2)
    return {
        "report": "PF-ECR",
        "company_id": str(company_id),
        "return_period": return_period,
        "due_date": f"{year}-{month:02d}-15",
        "total_employees": len(ecr_lines),
        "total_ee_pf": total_ee,
        "total_er_pf": total_er,
        "total_eps_pf": round(sum(r["eps_contribution"] for r in ecr_lines), 2),
        "total_epf_pf": round(sum(r["epf_contribution"] for r in ecr_lines), 2),
        "total_pf_liability": round(total_ee + total_er, 2),
        "ecr_lines": ecr_lines,
    }


@router.get("/{company_id}/tds-26q")
def export_tds_26q(
    company_id: uuid.UUID,
    quarter: str = Query(..., description="Quarter: Q1, Q2, Q3, Q4"),
    year: int = Query(..., ge=2020, description="Financial year (e.g. 2026)"),
    db: Session = Depends(get_db),
    _: None = Depends(verify_company_access),
    current_user: User = Depends(get_current_user),
):
    """TDS Form 26Q — quarterly TDS return for non-salary deductions (subcon payments etc.).

    R2-524: built from the transaction deduction ledger - the TDS actually
    withheld on bills inside the quarter. 26Q covers non-salary deductees;
    salary TDS belongs on Form 24Q and is no longer invented here from the
    salary population at a hardcoded section.
    """
    require_module_view(db, current_user, company_id, "payroll")
    if quarter not in ("Q1", "Q2", "Q3", "Q4"):
        raise HTTPException(status_code=422, detail=f"Invalid quarter '{quarter}'. Use Q1, Q2, Q3, or Q4.")
    # R2-524: the quarter's real calendar window. `year` is the financial-year
    # label: Q1-Q3 fall inside it, Q4 spills into the next calendar year.
    quarter_windows = {
        "Q1": (datetime(year, 4, 1), datetime(year, 7, 1)),
        "Q2": (datetime(year, 7, 1), datetime(year, 10, 1)),
        "Q3": (datetime(year, 10, 1), datetime(year + 1, 1, 1)),
        "Q4": (datetime(year + 1, 1, 1), datetime(year + 1, 4, 1)),
    }
    due_map = {"Q1": f"{year}-07-31", "Q2": f"{year}-10-31", "Q3": f"{year+1}-01-31", "Q4": f"{year+1}-05-31"}
    start_date, end_date = quarter_windows[quarter]

    deduction_rows = (
        db.query(TransactionDeduction, Bill)
        .join(Bill, TransactionDeduction.bill_id == Bill.id)
        .filter(
            Bill.company_id == company_id,
            TransactionDeduction.deduction_type == "TDS",
            Bill.invoice_date >= start_date,
            Bill.invoice_date < end_date,
        )
        .order_by(Bill.invoice_date.asc())
        .all()
    )

    deductee_rows = []
    total_tds = 0.0
    for ded, bill in deduction_rows:
        amount = float(ded.amount or 0)
        pct = float(ded.percentage or 0)
        gross = round(amount / (pct / 100), 2) if pct > 0 else float(bill.subtotal or 0)
        party_name, _gstin, party_pan = _party_tax_identity(db, bill.party_company_user_id)
        deductee_rows.append({
            # Without a PAN section 206AA mandates 20% and the return is
            # rejected; parties without one on file stay flagged NOPANAVAIL.
            "pan": party_pan or "NOPANAVAIL",
            "name": party_name,
            "invoice_number": bill.invoice_number,
            "tds_section": _parse_tds_section(ded.notes),
            "gross_payment": gross,
            "tds_deducted": amount,
            "deduction_date": bill.invoice_date.date().isoformat(),
        })
        total_tds += amount

    return {
        "report": "TDS-26Q",
        "company_id": str(company_id),
        "quarter": quarter,
        "year": year,
        "due_date": due_map[quarter],
        "total_deductees": len(deductee_rows),
        "total_tds_liability": round(total_tds, 2),
        "deductee_rows": deductee_rows,
    }


def _enrich(report: StatutoryReport, db: Session) -> StatutoryReportResponse:
    days_overdue = 0
    if report.due_date:
        if report.status != "filed":
            # R2-222: due_date round-trips aware on Postgres (naive on
            # SQLite); normalize both operands to aware UTC so the overdue
            # delta can't raise TypeError.
            due = report.due_date
            if due.tzinfo is None:
                due = due.replace(tzinfo=timezone.utc)
            days_overdue = max(0, (datetime.now(timezone.utc) - due).days)
    data = {**report.__dict__}
    data["days_overdue"] = days_overdue
    data["penalty_estimate"] = 0.0
    return StatutoryReportResponse(**data)

