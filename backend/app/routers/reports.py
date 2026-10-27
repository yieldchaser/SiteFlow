# -*- coding: utf-8 -*-
"""
Phase 11 — Client Portal & PDF Progress Reports Router
"""

import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from fastapi.responses import FileResponse
from sqlalchemy import func
from sqlalchemy.orm import Session
from pydantic import BaseModel
from app.database import get_db

# Anchor the PDF store to the repo's backend/static/reports directory so writes
# and reads stay consistent regardless of the process's current working dir.
REPORTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "reports")
from app.auth import get_current_user, verify_project_access, get_company_membership, require_permission
from app.constants import (
    EXPENSE_INVOICE_TYPES,
    REVENUE_INVOICE_TYPES,
    is_expense_invoice_type,
    is_revenue_invoice_type,
    is_settlement_invoice_type,
    is_settlement_money_in,
)
from app.models import (
    ClientReport, Project, Task, Bill, WorkOrder, WorkOrderItem,
    MaterialIndent, MaterialIndentItem, PurchaseOrder, SiteInspection, NCR, MaterialTestResult,
    DailyProgressReport, PurchaseOrderItem, WarehouseInventory,
    StaffEmployee, AttendanceLog, PayrollRun, PayrollLineItem,
    PaymentRequest, Payment, PaymentSettlement,
    ProductionBatch, ProductionBatchMaterial,
    ProductionRecipeMaterial,
    CRMQuotation, CRMQuotationItem, CRMLead, CompanyTeam, User,
    BOQItem, MaterialTransaction, GRNItem, GoodsReceiptNote,
    DebitNote, CreditNote, BankAccount, TransactionDeduction,
    Company, CompanyBranch, PdfTemplate,
    QualityChecklist, Equipment, EquipmentDeployment, FuelLog, MaintenanceSchedule,
    LibraryParty, LibraryCostCode, LibraryMaterial, LibraryRate,
    Todo, MusterRoll, FaceRecognitionLog
)
from app.utils.pdf_generator import generate_client_report_pdf
from app.utils.document_pdf import resolve_supplier_tax_details
from app.party_names import resolve_party_name, resolve_party_names_batch

router = APIRouter(prefix="/reports", tags=["Client Reports Portal"], dependencies=[Depends(get_current_user)])

logger = logging.getLogger(__name__)


class _ReportFailed:
    """Sentinel a guarded handler returns after logging an unexpected
    exception. Lets get_report_data tell the caller the report crashed
    instead of publishing an empty result as genuine data (R2-076, R2-312,
    R2-560). Truthy on purpose so ``handler(...) or []`` cannot silently
    flatten it into an empty list."""

    __slots__ = ()

    def __bool__(self) -> bool:
        return True


_REPORT_FAILED = _ReportFailed()


# ─── Schemas ─────────────────────────────────────────────────────────────────

class ReportCreate(BaseModel):
    report_name: str
    summary_markdown: Optional[str] = None


class ReportResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    report_name: str
    report_date: datetime
    summary_markdown: Optional[str]
    pdf_url: Optional[str]
    generated_by: Optional[uuid.UUID] = None
    is_approved: bool
    approved_by: Optional[uuid.UUID] = None
    approved_at: Optional[datetime] = None
    created_at: datetime

    class Config:
        from_attributes = True


# ─── Endpoints ───────────────────────────────────────────────────────────────

def _render_client_report_pdf(db: Session, report_name: str, summary_markdown: Optional[str], project: Project) -> bytes:
    # 1. Query Timeline Progress
    project_tasks = db.query(Task).filter(Task.project_id == project.id).all()
    tasks_total = len(project_tasks)
    tasks_completed = sum(1 for t in project_tasks if t.status == "completed")
    tasks_active = sum(1 for t in project_tasks if t.status == "in_progress")
    avg_task_progress = (sum(float(t.progress or 0) for t in project_tasks) / tasks_total) if tasks_total > 0 else 0.0
    tasks_completion_pct = int(avg_task_progress)

    # 2. Query Billing & Financials
    billing_wo_count = db.query(WorkOrder).filter(WorkOrder.project_id == project.id).count()
    subcon_bills = db.query(Bill).filter(Bill.project_id == project.id, Bill.invoice_type == "subcon", Bill.status != "Cancelled").all()
    approved_subcon_bills = [b for b in subcon_bills if b.approval_flag and b.approval_flag.lower() in ("approved", "auto_approved")]
    billing_ra_count = len(approved_subcon_bills)
    total_certified = sum(b.total_payable for b in approved_subcon_bills)
    billing_certified_net = f"{total_certified:.2f}"

    # 3. Query Procurement
    procurement_indents = db.query(MaterialIndent).filter(MaterialIndent.project_id == project.id).count()
    procurement_pos = db.query(PurchaseOrder).filter(PurchaseOrder.project_id == project.id).count()

    # 4. Query Quality Control
    quality_inspections = db.query(SiteInspection).filter(SiteInspection.project_id == project.id).count()
    quality_ncr_open = db.query(NCR).filter(NCR.project_id == project.id, NCR.status == "open").count()
    quality_ncr_closed = db.query(NCR).filter(NCR.project_id == project.id, NCR.status == "closed").count()
    quality_tests = db.query(MaterialTestResult).filter(MaterialTestResult.project_id == project.id).all()
    quality_tests_total = len(quality_tests)
    quality_tests_assessed = [t for t in quality_tests if t.is_pass is not None]
    quality_tests_unassessed = quality_tests_total - len(quality_tests_assessed)
    quality_tests_pass_count = sum(1 for t in quality_tests_assessed if t.is_pass)
    quality_tests_pass_rate = int((quality_tests_pass_count / len(quality_tests_assessed)) * 100) if quality_tests_assessed else None

    metrics = {
        "tasks_total": tasks_total,
        "tasks_completed": tasks_completed,
        "tasks_active": tasks_active,
        "tasks_completion_pct": tasks_completion_pct,
        "billing_wo_count": billing_wo_count,
        "billing_ra_count": billing_ra_count,
        "billing_certified_net": billing_certified_net,
        "procurement_indents": procurement_indents,
        "procurement_pos": procurement_pos,
        "quality_inspections": quality_inspections,
        "quality_ncr_open": quality_ncr_open,
        "quality_ncr_closed": quality_ncr_closed,
        "quality_tests_total": quality_tests_total,
        "quality_tests_pass_count": quality_tests_pass_count,
        "quality_tests_unassessed": quality_tests_unassessed,
        "quality_tests_pass_rate": quality_tests_pass_rate,
    }

    # 5. Resolve PDF Template settings (Settings -> Document & Fields -> PDF Template)
    company_name = ""
    custom_banner = None
    company = db.query(Company).filter(Company.id == project.company_id).first()
    if company:
        if company.document_company_name_display == "branch" and project.branch_id:
            branch = db.query(CompanyBranch).filter(CompanyBranch.id == project.branch_id).first()
            company_name = branch.branch_name if branch else company.name
        else:
            company_name = company.name

        if company.custom_pdf_template_enabled:
            template = (
                db.query(PdfTemplate)
                .filter(PdfTemplate.company_id == company.id, PdfTemplate.is_default == True)  # noqa: E712
                .first()
                or db.query(PdfTemplate)
                .filter(PdfTemplate.company_id == company.id)
                .order_by(PdfTemplate.created_at.desc())
                .first()
            )
            if template and template.content:
                custom_banner = template.content

    # 6. Generate PDF stream
    from app.utils.document_pdf import load_branding_assets
    return generate_client_report_pdf(
        report_name,
        summary_markdown or "",
        metrics,
        company_name=company_name,
        custom_banner=custom_banner,
        branding=load_branding_assets(db, project.company_id),
        supplier_lines=resolve_supplier_tax_details(db, project.company_id, project),
    )


@router.post("/generate/{project_id}", response_model=ReportResponse, status_code=status.HTTP_201_CREATED)
@router.post("/{project_id}/generate", response_model=ReportResponse, status_code=status.HTTP_201_CREATED)
def create_report(
    project_id: uuid.UUID,
    payload: ReportCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    _: None = Depends(verify_project_access)
):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "reports:create")

    report_id = uuid.uuid4()
    pdf_bytes = _render_client_report_pdf(db, payload.report_name, payload.summary_markdown, project)

    # Save PDF to static files directory (absolute, CWD-independent)
    reports_dir = REPORTS_DIR
    os.makedirs(reports_dir, exist_ok=True)
    pdf_filename = f"{report_id}.pdf"
    pdf_path = os.path.join(reports_dir, pdf_filename)

    with open(pdf_path, "wb") as f:
        f.write(pdf_bytes)

    # Create report record in database
    db_report = ClientReport(
        id=report_id,
        project_id=project_id,
        report_name=payload.report_name,
        report_date=datetime.utcnow(),
        summary_markdown=payload.summary_markdown,
        pdf_url=f"/static/reports/{pdf_filename}",
        generated_by=current_user.id,
        is_approved=False
    )
    db.add(db_report)
    db.commit()
    db.refresh(db_report)

    return db_report


@router.get("/{project_id}", response_model=List[ReportResponse])
def list_reports(project_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_project_access)):
    return db.query(ClientReport).filter(
        ClientReport.project_id == project_id
    ).order_by(ClientReport.report_date.desc()).all()


@router.patch("/{report_id}/approve", response_model=ReportResponse)
def approve_report(report_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    report = db.query(ClientReport).filter(ClientReport.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    project = db.query(Project).filter(Project.id == report.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    get_company_membership(db, current_user, project.company_id)
    require_permission(db, current_user, project.company_id, "reports:approve")

    # R2-286(b): the approver must be someone other than the user who
    # generated the report. Legacy rows with a null generated_by keep the
    # old behavior (creator unknown, cannot be compared).
    if report.generated_by is not None and report.generated_by == current_user.id:
        raise HTTPException(
            status_code=403,
            detail="You cannot approve a report you generated",
        )

    report.is_approved = True
    report.approved_by = current_user.id
    report.approved_at = datetime.utcnow()
    db.commit()
    db.refresh(report)
    return report


@router.get("/{report_id}/download")
def download_report(report_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    report = db.query(ClientReport).filter(ClientReport.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    project = db.query(Project).filter(Project.id == report.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    # Tenant check: the report's project belongs to a company the caller is a member of.
    get_company_membership(db, current_user, project.company_id)

    pdf_filename = f"{report.id}.pdf"
    pdf_path = os.path.join(REPORTS_DIR, pdf_filename)

    if os.path.exists(pdf_path):
        return FileResponse(pdf_path, media_type="application/pdf", filename=pdf_filename)

    # R2-758: Render PDF on demand when container restart/deploy wipes ephemeral disk
    pdf_bytes = _render_client_report_pdf(db, report.report_name, report.summary_markdown, project)
    try:
        os.makedirs(REPORTS_DIR, exist_ok=True)
        with open(pdf_path, "wb") as f:
            f.write(pdf_bytes)
    except Exception:
        pass

    from fastapi import Response
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{pdf_filename}"'},
    )

# Read-only, defensive endpoint that returns real aggregated rows keyed by the
# EXACT column-header strings defined in the frontend report definitions:
#   frontend/src/app/c/[company_id]/reports/[slug]/page.tsx  (REPORT_METADATA)
#   frontend/src/app/c/[company_id]/reports/page.tsx        (exportSchemas)
#
# A slug with no handler 404s; a company/project id that does not parse
# fails 422 naming the parameter (R2-324). A slug whose handler raises is
# logged with its full traceback and returned as rows: [] PLUS a non-empty
# top-level "errors" list, so a crashed report never masquerades as a
# genuinely empty one (R2-076, R2-312, R2-560).
#
# Registered on the existing `router` (prefix "/reports") which main.py mounts
# under "/apis/v3", yielding the full path "/apis/v3/reports/data/{slug}".

class ReportDataResponse(BaseModel):
    slug: str
    rows: List[dict]
    generated_at: str
    errors: List[str] = []
    # False when a month was asked for but the report has no business date to
    # filter on (master lists such as parties or employees), so it is all-time.
    period_applied: Optional[bool] = None


# Columns that say when a row happened. Created/Due/Expiry/Start/End dates are
# left out: a party list filtered by the month a party was keyed in, or a bill
# by its due date, is not what "Report Period" means.
_PERIOD_SKIP = ("created", "creation", "due", "expiry", "start", "end", "tax")


def _period_key(rows: List[dict]) -> Optional[str]:
    for key in rows[0].keys():
        if key == "Month":
            return key
        low = key.lower()
        if "date" in low and not any(w in low for w in _PERIOD_SKIP):
            return key
    return None


def _clean(v):
    if v is None:
        return ""
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, uuid.UUID):
        return str(v)
    if isinstance(v, datetime):
        return v.isoformat()
    return v


def _mask_aadhaar(v: Optional[str]) -> str:
    """Mask Aadhaar numbers to 'XXXX XXXX 1234' format for exports & reports."""
    if not v:
        return ""
    clean = "".join(str(v).split())
    if len(clean) < 4:
        return f"XXXX XXXX {clean}" if clean else ""
    return f"XXXX XXXX {clean[-4:]}"


def _project_ids_for_company(db: Session, cid: uuid.UUID):
    # R2-324: this used to swallow every failure to [], which builders read
    # as "company has no projects", rendering a database error as a genuinely
    # empty company. Let the exception propagate instead: it reaches a guarded
    # handler or the dispatcher wrapper, both of which log the traceback and
    # surface the top-level errors marker (R2-076 mechanism).
    return [p.id for p in db.query(Project.id).filter(Project.company_id == cid).all()]


def _rep_dpr(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    proj_ids = _project_ids_for_company(db, cid)
    if not proj_ids:
        return []
    q = db.query(DailyProgressReport).filter(DailyProgressReport.project_id.in_(proj_ids))
    if pid:
        q = q.filter(DailyProgressReport.project_id == pid)
    rows = []
    for d in q.order_by(DailyProgressReport.dpr_date.desc()).all():
        proj = db.query(Project).filter(Project.id == d.project_id).first()
        task_name = ""
        if d.task_id:
            t = db.query(Task).filter(Task.id == d.task_id).first()
            if t:
                task_name = t.name
        mats = d.materials_consumed or []
        mat_str = "; ".join(
            f"{m.get('material_name', '')}: {m.get('quantity', '')} {m.get('unit', '')}"
            for m in mats if isinstance(m, dict)
        )
        rows.append({
            "Project Name": proj.name if proj else "",
            "DPR Date": _clean(d.dpr_date),
            "Task Name": task_name,
            "Progress Qty": _clean(d.executed_qty),
            "Workers Count": _clean(d.workers_deployed),
            "Material Used": mat_str,
        })
    return rows


def _rep_task_report(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    proj_ids = _project_ids_for_company(db, cid)
    if not proj_ids:
        return []
    q = db.query(Task).filter(Task.project_id.in_(proj_ids))
    if pid:
        q = q.filter(Task.project_id == pid)
    rows = []
    for t in q.all():
        proj = db.query(Project).filter(Project.id == t.project_id).first()
        rows.append({
            "Project Name": proj.name if proj else "",
            "Task Name": t.name,
            "Start Date": _clean(t.start_date),
            "End Date": _clean(t.end_date),
        })
    return rows


def _rep_po_item(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    q = db.query(PurchaseOrderItem).join(PurchaseOrder, PurchaseOrderItem.po_id == PurchaseOrder.id)
    q = q.filter(PurchaseOrder.company_id == cid)
    if pid:
        q = q.filter(PurchaseOrder.project_id == pid)
    rows = []
    for it in q.all():
        po = db.query(PurchaseOrder).filter(PurchaseOrder.id == it.po_id).first()
        proj = db.query(Project).filter(Project.id == po.project_id).first() if po and po.project_id else None
        received_qty = 0.0
        for gi in db.query(GRNItem).join(GoodsReceiptNote).filter(
            GoodsReceiptNote.po_id == it.po_id,
            GRNItem.po_item_id == it.id,
        ).all():
            received_qty += float(gi.received_qty)
        ordered_qty = float(it.quantity)
        if received_qty >= ordered_qty:
            item_status = "received"
        elif received_qty > 0.0:
            item_status = "partial"
        else:
            item_status = "pending"
        rows.append({
            "PO Date": _clean(po.po_date) if po else "",
            "PO Number": po.po_number if po else "",
            "Project Name": proj.name if proj else "",
            "Material Name": it.material_name,
            "Unit": it.unit,
            "Unit Price": _clean(it.rate),
            "PO Qty": _clean(it.quantity),
            "PO Received Qty": _clean(received_qty),
            "PO Pending Qty": _clean(max(0.0, ordered_qty - received_qty)),
            "Item Status": item_status,
            "Approval Status": po.approval_flag if po else "",
        })
    return rows


def _rep_po_summary(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    q = db.query(PurchaseOrder).filter(PurchaseOrder.company_id == cid)
    if pid:
        q = q.filter(PurchaseOrder.project_id == pid)
    rows = []
    for po in q.order_by(PurchaseOrder.po_date.desc()).all():
        items = db.query(PurchaseOrderItem).filter(PurchaseOrderItem.po_id == po.id).all()
        material = ", ".join(i.material_name for i in items)
        proj = db.query(Project).filter(Project.id == po.project_id).first()
        rows.append({
            "Project Name": proj.name if proj else "",
            "PO Creation Date": _clean(po.created_at),
            "PO Date": _clean(po.po_date),
            "PO Number": po.po_number,
            "Material": material,
            "Amount": _clean(po.gross_amount),
            "Tax Amount": _clean(po.tax_amount),
            "Total Amount": _clean(po.total_amount),
            "Approval Status": po.approval_flag,
        })
    return rows


def _rep_material_stock(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    proj_ids = _project_ids_for_company(db, cid)
    if not proj_ids:
        return []
    q = db.query(WarehouseInventory).filter(WarehouseInventory.project_id.in_(proj_ids))
    if pid:
        q = q.filter(WarehouseInventory.project_id == pid)
    rows = []
    for w in q.all():
        proj = db.query(Project).filter(Project.id == w.project_id).first()
        rows.append({
            "Project Name": proj.name if proj else "",
            "Material Name": w.material_name,
            "Unit": w.unit,
            "Available Stock": _clean(w.on_hand_qty),
        })
    return rows


def _rep_production_material(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    q = db.query(ProductionBatchMaterial).join(ProductionBatch, ProductionBatchMaterial.batch_id == ProductionBatch.id)
    q = q.filter(ProductionBatch.company_id == cid)
    if pid:
        q = q.filter(ProductionBatch.project_id == pid)
    rows = []
    for bm in q.all():
        batch = db.query(ProductionBatch).filter(ProductionBatch.id == bm.batch_id).first()
        proj = db.query(Project).filter(Project.id == batch.project_id).first() if batch and batch.project_id else None
        raw_str = ""
        if batch and batch.recipe_id:
            raw = db.query(ProductionRecipeMaterial).filter(
                ProductionRecipeMaterial.recipe_id == batch.recipe_id
            ).all()
            raw_str = ", ".join(r.material_name for r in raw)
        rows.append({
            "Project Name": proj.name if proj else "",
            "Production Material": bm.material_name,
            "Unit": bm.unit,
            "Quantity": _clean(bm.actual_qty),
            "Production Date": _clean(batch.started_at) if batch else "",
            "Raw Material Consumed": raw_str,
            "Notes": batch.notes if batch and batch.notes else "",
        })
    return rows


def _rep_attendance_salary(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    q = db.query(StaffEmployee).filter(StaffEmployee.company_id == cid)
    if pid:
        q = q.filter(StaffEmployee.project_id == pid)
    rows = []
    for emp in q.all():
        proj = db.query(Project).filter(Project.id == emp.project_id).first() if emp.project_id else None
        # R2-325: count both punch-in statuses exactly as payroll pays for
        # them (hr.py run_payroll filters status.in_(["Present", "Present
        # (Off-Site)"])); counting only "Present" here reported off-site days
        # as absences next to a payslip that paid for them.
        present = db.query(AttendanceLog).filter(
            AttendanceLog.employee_id == emp.id,
            AttendanceLog.status.in_(["Present", "Present (Off-Site)"])
        ).count()
        net = ""
        pl = db.query(PayrollLineItem).join(PayrollRun, PayrollLineItem.payroll_run_id == PayrollRun.id).filter(
            PayrollLineItem.employee_id == emp.id
        )
        if pid:
            pl = pl.filter(PayrollRun.project_id == pid)
        pli = pl.order_by(PayrollRun.run_date.desc()).first()
        if pli:
            net = _clean(pli.net_payable)
        rows.append({
            "Party Name": emp.name,
            "Project Name": proj.name if proj else "",
            "Designation": emp.designation or "",
            "Total Present Days": present,
            "Net Payable (INR)": net,
        })
    return rows


def _rep_company_payments(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    q = db.query(Payment).filter(Payment.company_id == cid)
    if pid:
        q = q.filter(Payment.project_id == pid)
    rows = []
    for p in q.order_by(Payment.payment_date.desc()).all():
        proj = db.query(Project).filter(Project.id == p.project_id).first() if p.project_id else None
        net = ""
        try:
            if p.amount is not None and p.unsettled_amount is not None:
                net = float(p.amount) - float(p.unsettled_amount)
        except Exception:
            net = ""
        rows.append({
            "Project Name": proj.name if proj else "",
            "Amount": _clean(p.amount),
            "Unsettled Amount": _clean(p.unsettled_amount),
            "Net Amount": net,
            "Remark": p.description or "",
            "Payment Type": p.payment_type,
            "Payment Mode": p.payment_method,
            "Account Name": p.account_name or "",
            "Cost Code": p.cost_code or "",
            "Sub Cost Code": p.sub_cost_code or "",
            "Category": p.category or "",
            "Created Date": _clean(p.created_at),
            "Reference No.": p.reference_number or "",
        })
    return rows


def _rep_payment_request(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(PaymentRequest).filter(PaymentRequest.company_id == cid)
        if pid:
            q = q.filter(PaymentRequest.project_id == pid)
        rows = []
        for pr in q.all():
            proj = db.query(Project).filter(Project.id == pr.project_id).first() if pr.project_id else None
            creator = ""
            if pr.party_company_user_id:
                u = db.query(User).filter(User.id == pr.party_company_user_id).first()
                if u:
                    creator = u.name
            rows.append({
                "Payment Request ID": str(pr.id),
                "Payment Request No.": str(pr.id),
                "Project Name": proj.name if proj else "",
                "Party Name": pr.party_name,
                "Amount": _clean(pr.amount),
                "Payment Date": _clean(pr.created_at),
                "Due Date": _clean(pr.due_date),
                "Creator Name": creator,
                "Request Type": pr.request_type or "",
                "Approval Status": pr.approval_status or "Pending",
                "Payment Status": pr.status,
                "Remark": pr.details or "",
            })
        return rows
    except Exception:
        logger.exception("Report 'payment-request' failed to generate; returning empty fallback")
        return _REPORT_FAILED


# ─── Shared helpers for new report handlers ──────────────────────────────────

def _team_user_name(db: Session, company_user_id):
    # Party Library parties are login-less CompanyTeam rows; their name lives on
    # LibraryParty, so a users-only lookup printed a blank party on every report.
    try:
        return resolve_party_name(db, company_user_id, fallback="")
    except Exception:
        return ""


def _team_user_names_batch(db: Session, company_user_ids):
    try:
        return resolve_party_names_batch(db, company_user_ids, fallback="")
    except Exception:
        return {}


def _user_name(db: Session, user_id):
    if not user_id:
        return ""
    try:
        u = db.query(User).filter(User.id == user_id).first()
        if u:
            return u.name
    except Exception:
        return ""
    return ""


def _build_party_ledger(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    """Core ledger aggregation across the company's projects.

    Returns (rows, party_final_balance) where rows is the chronological list of
    party-ledger dicts and party_final_balance maps a stable party identity to
    that party's (display name, closing balance), accumulated only from that
    party's transactions (R2-313/R2-560: never the company-wide total).

    R2-314: the aggregation key is the counterparty's stable row id
    (CompanyTeam.id / StaffEmployee.id), not the resolved display name, so
    same-named parties keep separate balances and a failed name resolution no
    longer collapses unrelated rows into one fallback bucket.
    """
    proj_ids = _project_ids_for_company(db, cid)

    payments_q = db.query(Payment).filter(Payment.company_id == cid)
    bills_q = db.query(Bill).filter(Bill.company_id == cid)
    debit_q = db.query(DebitNote).filter(DebitNote.company_id == cid)
    credit_q = db.query(CreditNote).filter(CreditNote.company_id == cid)
    salaries_q = db.query(PayrollLineItem).join(PayrollRun).filter(PayrollRun.company_id == cid)
    if proj_ids:
        salaries_q = salaries_q.filter(PayrollRun.project_id.in_(proj_ids))
    else:
        salaries_q = salaries_q.filter(PayrollRun.project_id.is_(None))

    if pid:
        payments_q = payments_q.filter(Payment.project_id == pid)
        bills_q = bills_q.filter(Bill.project_id == pid)
        debit_q = debit_q.filter(DebitNote.project_id == pid)
        credit_q = credit_q.filter(CreditNote.project_id == pid)
        salaries_q = salaries_q.filter(PayrollRun.project_id == pid)

    raw = []
    for p in payments_q.all():
        raw.append((p.payment_date, "payment", p))
    for b in bills_q.all():
        raw.append((b.invoice_date, "bill", b))
    for s in salaries_q.all():
        raw.append((s.created_at, "salary", s))
    for d in debit_q.all():
        raw.append((d.created_at, "debit", d))
    for c in credit_q.all():
        raw.append((c.created_at, "credit", c))

    raw.sort(key=lambda x: x[0] if x[0] else datetime.min)

    rows = []
    running_by_party = {}
    party_final = {}
    for dt, et, obj in raw:
        party_name = ""
        party_key = ""
        party_type = "Party"
        txn_type = ""
        debit = 0.0
        credit = 0.0
        cost_code = ""
        description = ""
        proj = None

        if et == "payment":
            is_in = obj.payment_type == "in"
            amount = float(obj.amount) if obj.amount is not None else 0.0
            # R2-314: key by the stable CompanyTeam id; only truly anonymous
            # rows (no counterparty id at all) share the fallback bucket.
            party_key = str(obj.party_company_user_id) if obj.party_company_user_id else "Walk-in Party"
            party_name = _team_user_name(db, obj.party_company_user_id) or "Walk-in Party"
            if is_in:
                txn_type = "Receipt"
                party_type = "Client"
                debit = amount
            else:
                txn_type = "Expense"
                party_type = "Vendor"
                credit = amount
            description = obj.description or ("Receipt Payment" if is_in else "Expense Payment")
            cost_code = obj.cost_code or ""
            if obj.project_id:
                proj = db.query(Project).filter(Project.id == obj.project_id).first()
        elif et == "bill":
            # D3: route through single shared classifier so settlement never
            # leaks into revenue or expense ledgers.
            is_receipt = is_revenue_invoice_type(obj.invoice_type)
            is_expense = is_expense_invoice_type(obj.invoice_type)
            is_settlement = is_settlement_invoice_type(obj.invoice_type)
            amount = float(obj.total_payable) if obj.total_payable is not None else 0.0
            # R2-314: same identity keying as the payment branch.
            party_key = str(obj.party_company_user_id) if obj.party_company_user_id else "Vendor/Client"
            party_name = _team_user_name(db, obj.party_company_user_id) or "Vendor/Client"
            if is_receipt:
                txn_type = "Sale Invoice"
                party_type = "Client"
                debit = amount
            elif is_expense:
                txn_type = "Purchase Bill"
                party_type = "Vendor"
                credit = amount
            elif is_settlement:
                # cash movement settlement - direction determines debit/credit
                money_in = is_settlement_money_in(obj.invoice_type)
                txn_type = "Settlement"
                party_type = "Client" if money_in else "Vendor"
                if money_in:
                    debit = amount
                else:
                    credit = amount
            else:
                # movement and unknown - no financial posting
                txn_type = "Movement"
                party_type = "Vendor"
                # no debit/credit for stock movements
            description = f"Invoice {obj.invoice_number}"
            if obj.project_id:
                proj = db.query(Project).filter(Project.id == obj.project_id).first()
        elif et == "salary":
            amount = float(obj.net_payable) if obj.net_payable is not None else 0.0
            # R2-314: employees key by StaffEmployee.id, so two same-named
            # staff never share one salary bucket.
            party_key = str(obj.employee_id) if obj.employee_id else "Staff Member"
            party_name = "Staff Member"
            if obj.employee_id:
                emp = db.query(StaffEmployee).filter(StaffEmployee.id == obj.employee_id).first()
                if emp and emp.name:
                    party_name = emp.name
            txn_type = "Salary"
            party_type = "Staff"
            credit = amount
        elif et == "debit":
            amount = float(obj.total_amount) if obj.total_amount is not None else 0.0
            party_key = str(obj.party_company_user_id) if obj.party_company_user_id else "Party"
            party_name = _team_user_name(db, obj.party_company_user_id) or "Party"
            txn_type = "Debit Note"
            credit = amount
            description = obj.notes or "Debit Note"
        elif et == "credit":
            amount = float(obj.total_amount) if obj.total_amount is not None else 0.0
            party_key = str(obj.party_company_user_id) if obj.party_company_user_id else "Party"
            party_name = _team_user_name(db, obj.party_company_user_id) or "Party"
            txn_type = "Credit Note"
            debit = amount
            description = obj.notes or "Credit Note"

        # R2-313/R2-560: the balance accumulates per party, so a party's
        # Balance never includes another party's transactions. debit is the
        # receivable direction and credit the payable direction in every
        # branch above.
        party_balance = running_by_party.get(party_key, 0.0) + debit - credit
        running_by_party[party_key] = party_balance

        # R2-322: Creator Name used to be party_name, attributing every
        # ledger row to the counterparty. No ledger source (Bill, Payment,
        # DebitNote, CreditNote, PayrollLineItem) carries a created-by
        # column, so the true creator is unrecoverable here; emit an honest
        # empty per house convention instead of a fabricated attribution.
        rows.append({
            "Party Name": party_name,
            "Party Type": party_type,
            "Project Name": proj.name if proj else "",
            "Creator Name": "",
            "Description": description,
            "Cost Code": cost_code,
            "Transaction Type": txn_type,
            "Transaction Date": _clean(dt),
            "Party Debit": debit,
            "Party Credit": credit,
            "Balance": party_balance,
        })
        party_final[party_key] = (party_name, party_balance)

    return rows, party_final


def _rep_party_ledger(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        rows, _ = _build_party_ledger(db, cid, pid)
        return rows
    except Exception:
        logger.exception("Report 'party-ledger' failed to generate; returning empty fallback")
        return _REPORT_FAILED


def _rep_all_party_balances(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        _, party_final = _build_party_ledger(db, cid, pid)
        rows = []
        for _, (name, bal) in party_final.items():
            rows.append({
                "Party Name": name,
                "Balance Amount": bal,
                "Balance Type": "Receivable" if bal >= 0 else "Payable",
            })
        return rows
    except Exception:
        logger.exception("Report 'all-party-balances' failed to generate; returning empty fallback")
        return _REPORT_FAILED


def _rep_item_wise_sales(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        # R2-321 / C7: honour the project filter via Bill.quotation_id linkage.
        # Converted quotations carry Bill.quotation_id and Bill.project_id.
        # When a project filter is requested, include quotations linked to active
        # bills for that project. If no bills link to quotations for this project,
        # return [] (truthful filter, no company-wide leakage).
        if pid:
            linked_quot_ids = [
                b.quotation_id for b in db.query(Bill.quotation_id).filter(
                    Bill.company_id == cid,
                    Bill.project_id == pid,
                    Bill.quotation_id.isnot(None),
                    Bill.status != "Cancelled",
                ).all()
            ]
            if not linked_quot_ids:
                return []
            items_q = db.query(CRMQuotationItem).join(
                CRMQuotation, CRMQuotationItem.quotation_id == CRMQuotation.id
            ).join(
                CRMLead, CRMQuotation.lead_id == CRMLead.id
            ).filter(
                CRMLead.company_id == cid,
                CRMQuotation.id.in_(linked_quot_ids),
            )
        else:
            items_q = db.query(CRMQuotationItem).join(
                CRMQuotation, CRMQuotationItem.quotation_id == CRMQuotation.id
            ).join(
                CRMLead, CRMQuotation.lead_id == CRMLead.id
            ).filter(CRMLead.company_id == cid)

        items = items_q.all()
        # A converted quotation's invoice is the bill that carries its id; its
        # invoice date is the one to show, not the moment the quotation was keyed.
        quot_ids = {it.quotation_id for it in items}
        bill_by_quot = {}
        if quot_ids:
            for bill in db.query(Bill).filter(
                Bill.company_id == cid,
                Bill.quotation_id.in_(quot_ids),
                Bill.status != "Cancelled",
            ).order_by(Bill.created_at).all():
                bill_by_quot.setdefault(bill.quotation_id, bill)
        rows = []
        for it in items:
            q = db.query(CRMQuotation).filter(CRMQuotation.id == it.quotation_id).first()
            lead = db.query(CRMLead).filter(CRMLead.id == q.lead_id).first() if q else None
            bill = bill_by_quot.get(it.quotation_id)
            if bill and bill.invoice_date:
                invoice_date = bill.invoice_date
            else:
                invoice_date = q.created_at if q else None
            if isinstance(invoice_date, datetime):
                # Stored in UTC (naive when the driver drops the zone); the
                # invoice's day is the Indian calendar day.
                if invoice_date.tzinfo is None:
                    invoice_date = invoice_date.replace(tzinfo=timezone.utc)
                invoice_date = invoice_date.astimezone(timezone(timedelta(hours=5, minutes=30)))
                invoice_date = invoice_date.date()
            created = (bill.created_at if bill else None) or (q.created_at if q else None)
            # R2-321: the invoice-shaped headers Sale Type, Project Name,
            # Invoice Number, Tax Amount and Gross Amount have no backing data
            # anywhere on a quotation line; they are dropped outright rather
            # than shipped as permanently blank columns.
            rows.append({
                "Client Name": lead.client_company_name if lead else "",
                "Invoice Date": invoice_date.isoformat() if invoice_date else "",
                "Item Name": it.item_name,
                "Unit": it.unit,
                "Quantity": _clean(it.qty),
                "Item Rate": _clean(it.selling_price),
                "Tax %": _clean(it.supply_tax_pct),
                "Total Amount": _clean(it.total_amount),
                "Invoice Created": _clean(created),
            })
        return rows
    except Exception:
        logger.exception("Report 'item-wise-sales' failed to generate; returning empty fallback")
        return _REPORT_FAILED


def _rep_company_sales(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(Bill).filter(Bill.company_id == cid, Bill.invoice_type.in_(REVENUE_INVOICE_TYPES), Bill.status != "Cancelled")
        if pid:
            q = q.filter(Bill.project_id == pid)
        # R2-377: report the retention actually withheld per bill instead of a
        # hardcoded empty column, so held retention is enumerable.
        ret_q = (
            db.query(TransactionDeduction.bill_id, func.coalesce(func.sum(TransactionDeduction.amount), 0))
            .join(Bill, TransactionDeduction.bill_id == Bill.id)
            .filter(
                Bill.company_id == cid,
                Bill.status != "Cancelled",
                TransactionDeduction.deduction_type == "Retention",
            )
        )
        if pid:
            ret_q = ret_q.filter(Bill.project_id == pid)
        retention_by_bill = dict(ret_q.group_by(TransactionDeduction.bill_id).all())
        rows = []
        for b in q.order_by(Bill.invoice_date.desc()).all():
            proj = db.query(Project).filter(Project.id == b.project_id).first() if b.project_id else None
            party = _team_user_name(db, b.party_company_user_id)
            rows.append({
                "Invoice Date": _clean(b.invoice_date),
                "Sale Type": b.invoice_type,
                "Client Name": party,
                "Project Name": proj.name if proj else "",
                "Invoice Number": b.invoice_number,
                "Total Amount": _clean(b.total_payable),
                "Retention Amount": _clean(retention_by_bill.get(b.id, 0)),
                "Due Date": _clean(b.due_date),
                "Payment Status": b.status,
            })
        return rows
    except Exception:
        logger.exception("Report 'company-sales' failed to generate; returning empty fallback")
        return _REPORT_FAILED


def _rep_crm_lead_detail(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(CRMLead).filter(CRMLead.company_id == cid)
        rows = []
        for lead in q.order_by(CRMLead.lead_date.desc()).all():
            assignees = ""
            if lead.assignee_id:
                assignees = _team_user_name(db, lead.assignee_id)
            rows.append({
                "Lead Date": _clean(lead.lead_date),
                "Lead Name": lead.lead_type or "",
                "Contact Name": lead.contact_name,
                "Contact No.": lead.phone_no,
                "Lead Status": lead.status,
                "Lead Priority": lead.priority,
                "Lead Source": lead.source or "",
                "Lead Category": lead.category or "",
                "Lead Company": lead.client_company_name or "",
                "Email": lead.email or "",
                "Budget": _clean(lead.budget),
                "Followup Date": _clean(lead.next_follow_up),
                "Expected Closure Date": _clean(lead.expected_closure),
                "Remark": lead.description or "",
                "Assignees": assignees,
            })
        return rows
    except Exception:
        logger.exception("Report 'crm-lead-detail' failed to generate; returning empty fallback")
        return _REPORT_FAILED


def _task_ancestor_names(db: Session, task):
    main = ""
    group = ""
    try:
        chain = []
        cur = task
        while cur is not None:
            chain.append(cur)
            if cur.parent_id:
                cur = db.query(Task).filter(Task.id == cur.parent_id).first()
            else:
                cur = None
        chain.reverse()
        if chain:
            main = chain[0].name
            if len(chain) > 1:
                group = chain[-2].name
    except Exception:
        pass
    return main, group


def _rep_task_measurement_book(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(Task).filter(Task.project_id.in_(proj_ids))
        if pid:
            q = q.filter(Task.project_id == pid)
        rows = []
        for t in q.all():
            proj = db.query(Project).filter(Project.id == t.project_id).first()
            main, group = _task_ancestor_names(db, t)
            boq = db.query(BOQItem).filter(BOQItem.id == t.boq_item_id).first() if t.boq_item_id else None
            dpr = db.query(DailyProgressReport).filter(
                DailyProgressReport.task_id == t.id
            ).order_by(DailyProgressReport.dpr_date.desc()).first()
            rows.append({
                "Project Name": proj.name if proj else "",
                "Main Task Name": main,
                "Group Task Name": group,
                "Task Name": t.name,
                "Progress Date": _clean(dpr.dpr_date) if dpr else "",
                "Unit": boq.unit if boq else "",
                "Estimated Quantity": _clean(boq.quantity) if boq else "",
                "Progress Quantity": _clean(dpr.executed_qty) if dpr else "",
                "Progress Notes": dpr.notes if dpr else "",
            })
        return rows
    except Exception:
        logger.exception("Report 'task-measurement-book' failed to generate; returning empty fallback")
        return _REPORT_FAILED


def _rep_material_stock_movement(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(MaterialTransaction).filter(MaterialTransaction.project_id.in_(proj_ids))
        if pid:
            q = q.filter(MaterialTransaction.project_id == pid)
        txns = q.order_by(MaterialTransaction.created_at.asc()).all()
        # R2-323: the running balance is scoped to (project_id, material_name,
        # unit). Keyed by name alone, two projects' identical materials merged
        # into one company-wide series printed as each project's stock, and
        # differing units netted against each other invisibly.
        running = {}
        rows = []
        for m in txns:
            proj = db.query(Project).filter(Project.id == m.project_id).first()
            bal_key = (m.project_id, m.material_name, m.unit)
            bal = running.get(bal_key, 0.0)
            qty = float(m.qty) if m.qty is not None else 0.0
            stock_in = 0.0
            stock_out = 0.0
            opening = bal
            if m.type == "received":
                bal += qty
                stock_in = qty
            elif m.type == "used":
                bal -= qty
                stock_out = qty
            elif m.type == "returned":
                bal += qty
                stock_in = qty
            else:
                bal -= qty
                stock_out = qty
            running[bal_key] = bal
            rows.append({
                "Project Name": proj.name if proj else "",
                "Material Name": m.material_name,
                "UOM": m.unit or "",
                "Date": _clean(m.created_at),
                "Opening Qty": opening,
                "Stock In": stock_in,
                "Stock Out": stock_out,
                "Closing Qty": bal,
            })
        return rows
    except Exception:
        logger.exception("Report 'material-stock-movement' failed to generate; returning empty fallback")
        return _REPORT_FAILED


def _rep_material_received_used(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(GRNItem).join(
            GoodsReceiptNote, GRNItem.grn_id == GoodsReceiptNote.id
        ).filter(GoodsReceiptNote.company_id == cid)
        if pid:
            q = q.filter(GoodsReceiptNote.project_id == pid)
        rows = []
        for gi in q.all():
            grn = db.query(GoodsReceiptNote).filter(GoodsReceiptNote.id == gi.grn_id).first()
            po_item = db.query(PurchaseOrderItem).filter(PurchaseOrderItem.id == gi.po_item_id).first() if gi.po_item_id else None
            po = None
            if grn and grn.po_id:
                po = db.query(PurchaseOrder).filter(PurchaseOrder.id == grn.po_id).first()
            proj = db.query(Project).filter(Project.id == grn.project_id).first() if grn and grn.project_id else None
            party = ""
            if po and po.vendor_id:
                party = _team_user_name(db, po.vendor_id)
            created_by = _team_user_name(db, grn.received_by) if grn and grn.received_by else ""
            rows.append({
                "Material": po_item.material_name if po_item else "",
                "Project Name": proj.name if proj else "",
                "Party Name": party,
                "Created By": created_by,
                "GRN No.": grn.grn_number if grn else "",
                "Receiving Date": _clean(grn.received_date) if grn else "",
                "Unit": po_item.unit if po_item else "",
                "Quantity": _clean(gi.received_qty),
                "Unit Price with Tax": _clean(po_item.rate) if po_item else "",
                "Total Amount": _clean(po_item.total_amount) if po_item else "",
                "PO Number": po.po_number if po else "",
                "PO Quantity": _clean(po_item.quantity) if po_item else "",
                "PO Date": _clean(po.po_date) if po else "",
            })
        return rows
    except Exception:
        logger.exception("Report 'material-received-used' failed to generate; returning empty fallback")
        return _REPORT_FAILED


def _rep_task_attendance(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(AttendanceLog).join(Project, AttendanceLog.project_id == Project.id).filter(
            Project.company_id == cid
        )
        if pid:
            q = q.filter(AttendanceLog.project_id == pid)
        rows = []
        for a in q.order_by(AttendanceLog.attendance_date.desc()).all():
            proj = db.query(Project).filter(Project.id == a.project_id).first()
            emp = db.query(StaffEmployee).filter(StaffEmployee.id == a.employee_id).first() if a.employee_id else None
            workforce = emp.name if emp else ""
            rows.append({
                "Workforce Name": workforce,
                "Project Name": proj.name if proj else "",
                "Attendance Date": _clean(a.attendance_date),
                "Attendance Status": a.status,
                "Work Hours": _clean(a.hours_worked),
            })
        return rows
    except Exception:
        logger.exception("Report 'task-attendance' failed to generate; returning empty fallback")
        return _REPORT_FAILED


def _gst_split(tax_amount, project_state=None, supplier_gstin=None):
    """
    D4 (R2-041/R2-125/R2-319) — place of supply derives from Project.state.

    POS = Project.state (site) vs supplier GSTIN prefix (first 2 chars).
    Same state -> CGST+SGST halves. Different -> IGST full. Never unconditional 50/50.

    When either side is missing the split falls back to legacy halves so that
    legacy reports without site state remain renderable; write-time validation
    (Project.state required 422) prevents new indeterminate rows.

    Keeps the original ``_gst_split(tax)`` call shape for backward compat
    (no project/gstin -> halves).
    """
    # Import here to avoid circular deps at module import time
    try:
        from app.gst_utils import gst_split as _d4_split
        return _d4_split(tax_amount, project_state, supplier_gstin)
    except Exception:
        # Fallback identical to pre-D4 halves if helper cannot be imported
        try:
            tax = float(tax_amount) if tax_amount is not None else 0.0
        except Exception:
            tax = 0.0
        half = tax / 2.0
        return half, half, 0.0, 0.0


def _rep_gstr1_sales(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(Bill).filter(Bill.company_id == cid, Bill.invoice_type.in_(REVENUE_INVOICE_TYPES), Bill.status != "Cancelled")
        if pid:
            q = q.filter(Bill.project_id == pid)
        rows = []
        for b in q.order_by(Bill.invoice_date.desc()).all():
            proj = db.query(Project).filter(Project.id == b.project_id).first() if b.project_id else None
            party = _team_user_name(db, b.party_company_user_id)
            # D4: derive split from site state vs supplier GSTIN
            comp_gstin = None
            try:
                comp = db.query(Company).filter(Company.id == cid).first()
                comp_gstin = getattr(comp, "gstin", None)
                # Branch GSTIN takes precedence when document masthead resolves to branch
                if proj and getattr(proj, "branch_id", None):
                    from app.models import CompanyBranch as _Br
                    br = db.query(_Br).filter(_Br.id == proj.branch_id).first()
                    if br and getattr(br, "gstin", None):
                        comp_gstin = br.gstin
            except Exception:
                comp_gstin = None
            cgst, sgst, igst, utgst = _gst_split(b.gst_amount, getattr(proj, "state", None) if proj else None, comp_gstin)
            rows.append({
                "Party Name": party,
                "Project Name": proj.name if proj else "",
                "Invoice Type": b.invoice_type,
                "Invoice Date": _clean(b.invoice_date),
                "Invoice Number": b.invoice_number,
                "Invoice Amount": _clean(b.total_payable),
                "Tax Amount": _clean(b.gst_amount),
                "CGST": cgst,
                "SGST": sgst,
                "IGST": igst,
                "UTGST": utgst,
                "Company GST": comp_gstin or "",
            })
        return rows
    except Exception:
        logger.exception("Report 'gstr1-sales' failed to generate; returning empty fallback")
        return _REPORT_FAILED


def _rep_gstr2_purchase(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        rows = []
        bills_q = db.query(Bill).filter(Bill.company_id == cid, Bill.invoice_type.in_(EXPENSE_INVOICE_TYPES), Bill.status != "Cancelled")
        if pid:
            bills_q = bills_q.filter(Bill.project_id == pid)
        bills = bills_q.order_by(Bill.invoice_date.desc()).all()
        for b in bills:
            proj = db.query(Project).filter(Project.id == b.project_id).first() if b.project_id else None
            party = _team_user_name(db, b.party_company_user_id)
            comp_gstin = None
            try:
                comp = db.query(Company).filter(Company.id == cid).first()
                comp_gstin = getattr(comp, "gstin", None)
                if proj and getattr(proj, "branch_id", None):
                    from app.models import CompanyBranch as _Br2
                    br = db.query(_Br2).filter(_Br2.id == proj.branch_id).first()
                    if br and getattr(br, "gstin", None):
                        comp_gstin = br.gstin
            except Exception:
                comp_gstin = None
            cgst, sgst, igst, utgst = _gst_split(b.gst_amount, getattr(proj, "state", None) if proj else None, comp_gstin)
            rows.append({
                "Party Name": party,
                "Project Name": proj.name if proj else "",
                "Bill Number": b.invoice_number,
                "Expense Type": b.invoice_type,
                "Expense Date": _clean(b.invoice_date),
                "Expense Amount": _clean(b.total_payable),
                "Tax Amount": _clean(b.gst_amount),
                "CGST": cgst,
                "SGST": sgst,
                "IGST": igst,
                "UTGST": utgst,
            })
        pay_q = db.query(Payment).filter(Payment.company_id == cid, Payment.payment_type == "out")
        if pid:
            pay_q = pay_q.filter(Payment.project_id == pid)
        payments = pay_q.order_by(Payment.payment_date.desc()).all()
        # R2-318: a payment that settles an expense bill is the same money the
        # bill row already carries, so only the portion of each payout that did
        # NOT settle a bill in the list above belongs on this return (mirrors
        # the finance ledger, which skips settled payments for the same reason).
        settled_by_payment = {}
        if payments:
            settle_q = (
                db.query(PaymentSettlement.payment_id, PaymentSettlement.settled_amount)
                .join(Bill, Bill.id == PaymentSettlement.bill_id)
                .filter(
                    PaymentSettlement.payment_id.in_([p.id for p in payments]),
                    Bill.company_id == cid,
                    Bill.invoice_type.in_(EXPENSE_INVOICE_TYPES),
                    Bill.status != "Cancelled",
                )
            )
            if pid:
                settle_q = settle_q.filter(Bill.project_id == pid)
            for pay_id, amt in settle_q.all():
                settled_by_payment[pay_id] = settled_by_payment.get(pay_id, 0.0) + float(amt or 0)
        for p in payments:
            outstanding = round(max(float(p.amount or 0) - settled_by_payment.get(p.id, 0.0), 0.0), 2)
            if outstanding <= 0:
                continue
            proj = db.query(Project).filter(Project.id == p.project_id).first() if p.project_id else None
            party = _team_user_name(db, p.party_company_user_id)
            rows.append({
                "Party Name": party,
                "Project Name": proj.name if proj else "",
                "Expense Type": "Payment Out",
                "Expense Date": _clean(p.payment_date),
                "Expense Amount": _clean(outstanding),
                "CGST": 0.0,
                "SGST": 0.0,
                "IGST": 0.0,
                "UTGST": 0.0,
            })
        return rows
    except Exception:
        logger.exception("Report 'gstr2-purchase' failed to generate; returning empty fallback")
        return _REPORT_FAILED


def _rep_sales_deduction_retention(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(TransactionDeduction).join(Bill, TransactionDeduction.bill_id == Bill.id).filter(
            Bill.company_id == cid
        )
        if pid:
            q = q.filter(Bill.project_id == pid)
        rows = []
        for d in q.all():
            b = db.query(Bill).filter(Bill.id == d.bill_id).first()
            # Sales report: deductions on revenue invoices only. Subcontractor
            # and purchase bill deductions belong to the expense-side reports.
            if not b or not is_revenue_invoice_type(b.invoice_type):
                continue
            proj = db.query(Project).filter(Project.id == b.project_id).first() if b.project_id else None
            party = _team_user_name(db, b.party_company_user_id)
            rows.append({
                "Amount": _clean(d.amount),
                "Project Name": proj.name if proj else "",
                "Party Name": party,
                "Invoice Number": b.invoice_number if b else "",
                "Type": d.deduction_type,
                "Entry Creation Date": _clean(d.created_at),
                "Due Date": _clean(d.release_due_date),
            })
        return rows
    except Exception:
        logger.exception("Report 'sales-deduction-retention' failed to generate; returning empty fallback")
        return _REPORT_FAILED


# R2-317: BankAccount has no `account_name` column at all, so the statement's
# bucket label is derived from the account record itself rather than from
# Payment.account_name, which is unvalidated caller-supplied free text.
_UNASSIGNED_ACCOUNT_LABEL = "Unassigned (no bank account)"


def _bank_account_label(acct):
    if acct is None:
        return _UNASSIGNED_ACCOUNT_LABEL
    parts = [p for p in (acct.bank_name, acct.account_number) if p]
    if parts:
        return " - ".join(parts)
    return acct.account_holder_name or "Bank account"


def _rep_bank_statement(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        # R2-317: the account_name filter is gone. It silently dropped every
        # payment recorded without one -- measured in production as 7 of 7
        # payments, so this report returned nothing for any company and could
        # never be reconciled against a bank.
        q = db.query(Payment).filter(Payment.company_id == cid)
        if pid:
            q = q.filter(Payment.project_id == pid)
        payments = q.order_by(Payment.payment_date.asc()).all()

        # Bucket on the real foreign key, not on free text: "HDFC Current" and
        # "HDFC current" are one account, and a typo can no longer spawn a
        # phantom statement carrying its own running balance.
        accounts = {
            a.id: a
            for a in db.query(BankAccount).filter(BankAccount.company_id == cid).all()
        }

        by_account = {}
        for p in payments:
            by_account.setdefault(p.account_id, []).append(p)
        rows = []
        for account_id, ps in by_account.items():
            label = _bank_account_label(accounts.get(account_id))
            proj_cache = {}
            party_cache = {}
            running = 0.0
            for p in ps:
                proj = proj_cache.get(p.project_id)
                if proj is None and p.project_id:
                    proj = db.query(Project).filter(Project.id == p.project_id).first()
                    proj_cache[p.project_id] = proj
                party = party_cache.get(p.party_company_user_id)
                if party is None:
                    party = _team_user_name(db, p.party_company_user_id)
                    party_cache[p.party_company_user_id] = party
                credit = 0.0
                debit = 0.0
                amt = float(p.amount) if p.amount is not None else 0.0
                if p.payment_type == "in":
                    credit = amt
                    running += amt
                else:
                    debit = amt
                    running -= amt
                rows.append({
                    # R2-317: the account record's label, so the bucket name can
                    # no longer disagree with the account it belongs to.
                    "Account Name": label,
                    "Project Name": proj.name if proj else "",
                    "Party Name": party,
                    "Payment Date": _clean(p.payment_date),
                    "Credit": credit,
                    "Debit": debit,
                    "Balance": running,
                    "Remarks": p.description or "",
                })
        return rows
    except Exception:
        logger.exception("Report 'bank-statement' failed to generate; returning empty fallback")
        return _REPORT_FAILED


def _rep_project_wise_payment_summary(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(Payment).filter(Payment.company_id == cid)
        if pid:
            q = q.filter(Payment.project_id == pid)
        payments = q.all()
        by_proj = {}
        for p in payments:
            by_proj.setdefault(p.project_id, []).append(p)
        proj_cache = {}
        rows = []
        for proj_id, ps in by_proj.items():
            proj = proj_cache.get(proj_id)
            if proj is None and proj_id:
                proj = db.query(Project).filter(Project.id == proj_id).first()
                proj_cache[proj_id] = proj
            # R2-320: receipts and payouts are unlike populations and are never
            # netted into one figure; each direction reports its own count,
            # amount and unsettled balance.
            receipts = [p for p in ps if p.payment_type == "in"]
            payouts = [p for p in ps if p.payment_type == "out"]
            last_dt = max((p.payment_date for p in ps if p.payment_date), default=None)
            rows.append({
                "Project Name": proj.name if proj else (str(proj_id) if proj_id else "Unspecified"),
                "Receipts Count": len(receipts),
                "Receipts Amount (INR)": sum(float(p.amount) for p in receipts if p.amount is not None),
                "Unsettled Receipts (INR)": sum(float(p.unsettled_amount) for p in receipts if p.unsettled_amount is not None),
                "Payouts Count": len(payouts),
                "Payouts Amount (INR)": sum(float(p.amount) for p in payouts if p.amount is not None),
                "Unsettled Payouts (INR)": sum(float(p.unsettled_amount) for p in payouts if p.unsettled_amount is not None),
                "Last Transaction Date": _clean(last_dt),
            })
        return rows
    except Exception:
        logger.exception("Report 'project-wise-payment-summary' failed to generate; returning empty fallback")
        return _REPORT_FAILED


def _rep_project_payment(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(Payment).filter(Payment.company_id == cid)
        if pid:
            q = q.filter(Payment.project_id == pid)
        rows = []
        for p in q.order_by(Payment.payment_date.desc()).all():
            proj = db.query(Project).filter(Project.id == p.project_id).first() if p.project_id else None
            party = _team_user_name(db, p.party_company_user_id)
            rows.append({
                "Payment Date": _clean(p.payment_date),
                "Project Name": proj.name if proj else "",
                "Party Name": party,
                "Amount": _clean(p.amount),
                "Remark": p.description or "",
                "Reference No.": p.reference_number or "",
                "Payment Type": p.payment_type,
                "Payment Mode": p.payment_method,
                "Account Name": p.account_name or "",
                "Category": p.category or "",
                "Cost Code": p.cost_code or "",
                "Sub Cost Code": p.sub_cost_code or "",
                "Created Date": _clean(p.created_at),
            })
        return rows
    except Exception:
        logger.exception("Report 'project-payment' failed to generate; returning empty fallback")
        return _REPORT_FAILED



# ─────────────────────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────────────────────
# Phase 18 / 58 Full Reports Suite Implementations
# ─────────────────────────────────────────────────────────────────────────────

def _rep_cost_code_library(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(LibraryCostCode).filter(LibraryCostCode.company_id == cid)
        rows = []
        for cc in q.order_by(LibraryCostCode.code.asc()).all():
            rows.append({
                "Cost Code": cc.code,
                "Sub Cost Code": cc.sub_cost_code or "",
                "Created Date": _clean(cc.created_at),
                "Description": cc.name,
            })
        return rows
    except Exception:
        logger.exception("Report 'cost-code-library' failed; returning fallback")
        return _REPORT_FAILED


def _rep_equipment_library(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(Equipment).filter(Equipment.company_id == cid)
        rows = []
        for eq in q.order_by(Equipment.name.asc()).all():
            rows.append({
                "Equipment Name": eq.name,
                "Make/Brand": eq.category or "",
                "Equipment No.": eq.code,
                "Model No.": "",
                "Measurement Type": eq.category or "Hours",
                "Unit": "Hours",
                "Created Date": _clean(eq.created_at),
                "Ownership Type": eq.ownership_type,
                "Expected Mileage": "",
                "Purchase Amount": _clean(eq.hourly_rate),
                "Insurance Policy No.": "",
                "Insurance Provider Name": "",
                "Insurance Start Date": "",
                "Insurance Expiry Date": "",
                "Service Reference No.": "",
                "Last Service Date": "",
                "Next Service Date": "",
                "Fitness Certificate Ref No.": "",
                "Fitness Certificate Status": "",
                "Fitness Certificate Issue Date": "",
                "Fitness Certificate Expiry Date": "",
                "PUCC Reference No.": "",
                "PUCC Start Date": "",
                "PUCC Expiry Date": "",
                "Permit Reference No.": "",
                "Permit Start Date": "",
                "Permit Expiry Date": "",
                "Tax No.": "",
                "Tax Start Date": "",
                "Tax Expiry Date": "",
                "Registration No.": "",
                "Registration Start Date": "",
                "Registration Expiry Date": "",
            })
        return rows
    except Exception:
        logger.exception("Report 'equipment-library' failed; returning fallback")
        return _REPORT_FAILED


def _rep_material_library(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(LibraryMaterial).filter(LibraryMaterial.company_id == cid)
        rows = []
        for m in q.order_by(LibraryMaterial.name.asc()).all():
            rows.append({
                "Item Code": m.item_code or "",
                "Material Name": m.name,
                "Specifications": m.specifications or "",
                "Unit": m.unit,
                "Material Category": m.category or "",
                "Created Date": _clean(m.created_at),
                "Creator Name": "",
            })
        return rows
    except Exception:
        logger.exception("Report 'material-library' failed; returning fallback")
        return _REPORT_FAILED


def _rep_party_library(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(LibraryParty).filter(LibraryParty.company_id == cid)
        rows = []
        for p in q.order_by(LibraryParty.name.asc()).all():
            rows.append({
                "Party Id": p.party_id_custom or str(p.id)[:8],
                "Party Name": p.name,
                "Party Type": p.party_type or "",
                "Bank Name": p.bank_name or "",
                "Account Name": p.account_name or "",
                "Account Number": p.account_number or "",
                "IFSC Code": p.ifsc_code or "",
                "Tax No.": p.tax_no or "",
                "Billing Address": p.address or "",
                "Aadhar Card Number": _mask_aadhaar(p.aadhaar_number),
                "PAN Card Number": p.pan_number or "",
                "ESI Number": p.esi_number or "",
                "PF Number": p.pf_number or "",
                "Father Name": p.father_name or "",
                "Passport No.": p.passport_no or "",
                "Passport Expiry Date": _clean(p.passport_expiry_date),
                "Joining Date": _clean(p.date_of_joining),
                "Created Date": _clean(p.created_at),
                "Creator Name": p.creator_name or "",
            })
        return rows
    except Exception:
        logger.exception("Report 'party-library' failed; returning fallback")
        return _REPORT_FAILED


def _rep_payroll_library(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(StaffEmployee).filter(StaffEmployee.company_id == cid)
        rows = []
        for emp in q.order_by(StaffEmployee.name.asc()).all():
            basic = float(emp.basic_salary or 0)
            hra = float(emp.hra or 0)
            other = float(emp.other_allowances or 0)
            tds = float(emp.tds_monthly or 0)
            gross = basic + hra + other
            net = max(0.0, gross - tds)
            rows.append({
                "Name": emp.name,
                "Designation": emp.designation or "",
                "Payroll Type": emp.department or "Monthly",
                "CTC": _clean(gross * 12),
                "Gross Salary": _clean(gross),
                "Net Salary": _clean(net),
                "Shift Hours": 8,
                "Salary Breakup": f"Basic: {basic}, HRA: {hra}, Allowances: {other}",
                "Created Date": _clean(emp.created_at),
            })
        return rows
    except Exception:
        logger.exception("Report 'payroll-library' failed; returning fallback")
        return _REPORT_FAILED


def _rep_rate_card_library(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(LibraryRate).filter(LibraryRate.company_id == cid)
        rows = []
        for r in q.order_by(LibraryRate.name.asc()).all():
            rows.append({
                "Description": r.name,
                "Item Code": r.item_code or "",
                "Cost Code": r.cost_code or "",
                "Unit": r.unit,
                "Components": r.note or "",
                "Unit Cost Price": _clean(r.unit_cost),
                "Markup Amount": _clean(r.markup_value),
                "Markup %": _clean(r.markup_value if r.markup_type == "percent" else 0),
                "Selling Price": _clean(r.unit_sale_price),
                "Created Date": _clean(r.created_at),
                "Component Count": 1,
                "HSN/SAC": r.hsn_sac or "",
            })
        return rows
    except Exception:
        logger.exception("Report 'rate-card-library' failed; returning fallback")
        return _REPORT_FAILED


def _rep_boq_bom(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(BOQItem).filter(BOQItem.project_id.in_(proj_ids))
        if pid:
            q = q.filter(BOQItem.project_id == pid)
        rows = []
        for b in q.all():
            proj = db.query(Project).filter(Project.id == b.project_id).first()
            rate = float(b.rate or 0)
            qty = float(b.quantity or 0)
            rows.append({
                "Project Name": proj.name if proj else "",
                "BOQ Name": b.item_name or "",
                "Item Name": b.item_name or "",
                "Material Name": b.item_name or "",
                "Unit": b.unit or "Unit",
                "Unit Price": _clean(rate),
                "Quantity": _clean(qty),
                "Total Cost Price": _clean(rate * qty),
                "Creation Date": _clean(b.created_at),
            })
        return rows
    except Exception:
        logger.exception("Report 'boq-bom' failed; returning fallback")
        return _REPORT_FAILED


def _rep_boq_item(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(BOQItem).filter(BOQItem.project_id.in_(proj_ids))
        if pid:
            q = q.filter(BOQItem.project_id == pid)
        rows = []
        for b in q.all():
            proj = db.query(Project).filter(Project.id == b.project_id).first()
            qty = float(b.quantity or 0)
            rate = float(b.rate or 0)
            amt_wo_tax = qty * rate
            total_amt = float(b.amount) if b.amount is not None else amt_wo_tax * 1.18
            rows.append({
                "Project Name": proj.name if proj else "",
                "BOQ Name": b.item_name or "",
                "BOQ No.": "",
                "Client Name": "",
                "BOQ Date": _clean(b.created_at),
                "Group": "",
                "Section": b.section_name or "",
                "Item Name": b.item_name or "",
                "Unit": b.unit or "Unit",
                "Quantity": _clean(qty),
                "Progress Quantity": 0.0,
                "Billed Qty": 0.0,
                "Unbilled Qty": _clean(qty),
                "Unit Cost Price": _clean(rate),
                "Unit Sales Price": _clean(rate),
                "GST %": _clean(b.supply_tax_pct or 18),
                "Amount w/o Tax": _clean(amt_wo_tax),
                "Total Amount": _clean(total_amt),
                "Cost Code": b.cost_code or "",
            })
        return rows
    except Exception:
        logger.exception("Report 'boq-item' failed; returning fallback")
        return _REPORT_FAILED


def _rep_boq_measurement_book(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(BOQItem).filter(BOQItem.project_id.in_(proj_ids))
        if pid:
            q = q.filter(BOQItem.project_id == pid)
        rows = []
        for b in q.all():
            proj = db.query(Project).filter(Project.id == b.project_id).first()
            qty = float(b.quantity or 0)
            rows.append({
                "Project Name": proj.name if proj else "",
                "Workorder No.": "",
                "Group": "",
                "Section": b.section_name or "",
                "Item Name": b.item_name or "",
                "Progress Date": _clean(b.created_at),
                "Unit": b.unit or "Unit",
                "Estimated Quantity": _clean(qty),
                "Opening Quantity": 0,
                "Number": 1,
                "Length": 0,
                "Width": 0,
                "Height": 0,
                "Progress Quantity": 0,
                "Closing Quantity": 0,
                "Progress Notes": "",
            })
        return rows
    except Exception:
        logger.exception("Report 'boq-measurement-book' failed; returning fallback")
        return _REPORT_FAILED


def _rep_boq_workorder_summary(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(WorkOrder).filter(WorkOrder.project_id.in_(proj_ids))
        if pid:
            q = q.filter(WorkOrder.project_id == pid)
        rows = []
        for wo in q.order_by(WorkOrder.created_at.desc()).all():
            proj = db.query(Project).filter(Project.id == wo.project_id).first()
            est_amt = float(wo.estimated_work_amount or 0)
            rows.append({
                "Project Name": proj.name if proj else "",
                "Workorder Name": f"Work Order {wo.wo_number}",
                "Workorder No.": wo.wo_number or "",
                "Client Name": "",
                "Estimated Amount": _clean(est_amt),
                "% Order Complete": 0,
                "Work Done Amount": 0,
                "Billed Amount": 0,
                "Pending Billed": _clean(est_amt),
                "Workorder Date": _clean(wo.wo_date or wo.created_at),
                "Creator Name": "",
                "Created Date": _clean(wo.created_at),
            })
        return rows
    except Exception:
        logger.exception("Report 'boq-workorder-summary' failed; returning fallback")
        return _REPORT_FAILED


def _rep_quotation(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(CRMQuotation).join(CRMLead, CRMQuotation.lead_id == CRMLead.id).filter(CRMLead.company_id == cid)
        rows = []
        for qt in q.order_by(CRMQuotation.created_at.desc()).all():
            lead = db.query(CRMLead).filter(CRMLead.id == qt.lead_id).first()
            items = db.query(CRMQuotationItem).filter(CRMQuotationItem.quotation_id == qt.id).all()
            item_subtotal = sum(float(it.total_amount or 0) for it in items)
            tax_amount = float(qt.cgst_amount or 0) + float(qt.sgst_amount or 0) + float(qt.igst_amount or 0)
            rows.append({
                "Quotation Name": qt.subject or "Quotation",
                "Quotation Number": qt.qt_no or str(qt.id)[:8],
                "Client Name": lead.contact_name if lead else "",
                "Quotation Date": _clean(qt.created_at),
                "Item Count": len(items),
                "Item Sub Total": _clean(item_subtotal),
                "Discount": _clean(qt.discount or 0),
                "Additional Charges": _clean(qt.additional_charges or 0),
                "Tax": _clean(tax_amount),
                "Total Amount": _clean(qt.total_amount or 0),
                "Quotation Status": qt.status,
                "Created Date": _clean(qt.created_at),
            })
        return rows
    except Exception:
        logger.exception("Report 'quotation' failed; returning fallback")
        return _REPORT_FAILED


def _rep_quotation_item(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(CRMQuotationItem).join(CRMQuotation, CRMQuotationItem.quotation_id == CRMQuotation.id).join(CRMLead, CRMQuotation.lead_id == CRMLead.id).filter(CRMLead.company_id == cid)
        rows = []
        for it in q.order_by(CRMQuotationItem.created_at.desc()).all():
            qt = db.query(CRMQuotation).filter(CRMQuotation.id == it.quotation_id).first()
            lead = db.query(CRMLead).filter(CRMLead.id == qt.lead_id).first() if qt else None
            qty = float(it.qty or 0)
            selling_price = float(it.selling_price or 0)
            sales_amt = qty * selling_price
            tax_pct = float(it.supply_tax_pct or 18)
            total_with_tax = sales_amt * (1.0 + tax_pct / 100.0)
            rows.append({
                "Client Name": lead.contact_name if lead else "",
                "Quotation Name": qt.subject if qt else "",
                "Quotation Status": qt.status if qt else "",
                "Quotation Date": _clean(qt.created_at) if qt else "",
                "Group": "",
                "Section": it.section_name or "",
                "Item Name": it.item_name,
                "Unit": it.unit,
                "Estimated Qty": _clean(qty),
                "Unit Cost Price": _clean(it.cost_price or 0),
                "Markup": _clean(it.markup or 0),
                "Sales Unit Price": _clean(selling_price),
                "Total Sales Amount": _clean(sales_amt),
                "Tax %": _clean(tax_pct),
                "Total with Tax": _clean(total_with_tax),
            })
        return rows
    except Exception:
        logger.exception("Report 'quotation-item' failed; returning fallback")
        return _REPORT_FAILED


def _rep_task_boq_billed_unbilled(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(Task).filter(Task.project_id.in_(proj_ids))
        if pid:
            q = q.filter(Task.project_id == pid)
        rows = []
        for t in q.all():
            proj = db.query(Project).filter(Project.id == t.project_id).first()
            rows.append({
                "Project Name": proj.name if proj else "",
                "Main Task Name": "",
                "Group Task Name": "",
                "Task Name": t.name,
                "Unit": "Unit",
                "Estimated Qty": 100.0,
                "Progress Qty": _clean(t.progress or 0),
                "% Complete": _clean(t.progress or 0),
                "Task Status": t.status,
                "Linked BOQ Detail": "",
                "Billed Qty": 0.0,
                "Unbilled Qty": 100.0,
            })
        return rows
    except Exception:
        logger.exception("Report 'task-boq-billed-unbilled' failed; returning fallback")
        return _REPORT_FAILED


def _rep_budget_vs_actual_cost_code(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(LibraryCostCode).filter(LibraryCostCode.company_id == cid)
        rows = []
        for cc in q.all():
            budget = float(cc.budget_amount or 0)
            bills_q = db.query(Bill).filter(Bill.company_id == cid)
            if pid:
                bills_q = bills_q.filter(Bill.project_id == pid)
            actual = sum(float(b.total_payable or 0) for b in bills_q.all())
            variance = budget - actual
            status_str = "Within Budget" if actual <= budget else "Over Budget"
            rows.append({
                "Cost Code": cc.code,
                "Budget Amount (INR)": _clean(budget),
                "Actual Amount (INR)": _clean(actual),
                "Variance (INR)": _clean(variance),
                "Status": status_str,
            })
        return rows
    except Exception:
        logger.exception("Report 'budget-vs-actual-cost-code' failed; returning fallback")
        return _REPORT_FAILED


def _rep_budget_vs_actual_material_cost(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(BOQItem).filter(BOQItem.project_id.in_(proj_ids))
        if pid:
            q = q.filter(BOQItem.project_id == pid)
        rows = []
        for b in q.all():
            proj = db.query(Project).filter(Project.id == b.project_id).first()
            qty = float(b.quantity or 0)
            rate = float(b.rate or 0)
            budget_cost = float(b.amount if b.amount is not None else (qty * rate))
            actual_cost = 0.0
            variance_cost = budget_cost - actual_cost
            rows.append({
                "Project": proj.name if proj else "",
                "Material": b.item_name or "",
                "Unit": b.unit or "Unit",
                "Budget Cost (INR)": _clean(budget_cost),
                "Actual Cost (INR)": _clean(actual_cost),
                "Variance (INR)": _clean(variance_cost),
            })
        return rows
    except Exception:
        logger.exception("Report 'budget-vs-actual-material-cost' failed; returning fallback")
        return _REPORT_FAILED


def _rep_budget_vs_actual_material_qty(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(BOQItem).filter(BOQItem.project_id.in_(proj_ids))
        if pid:
            q = q.filter(BOQItem.project_id == pid)
        rows = []
        for b in q.all():
            proj = db.query(Project).filter(Project.id == b.project_id).first()
            budget_qty = float(b.quantity or 0)
            actual_qty = 0.0
            variance_qty = budget_qty - actual_qty
            rows.append({
                "Project": proj.name if proj else "",
                "Material": b.item_name or "",
                "Unit": b.unit or "Unit",
                "Budget Qty": _clean(budget_qty),
                "Actual Qty": _clean(actual_qty),
                "Variance Qty": _clean(variance_qty),
            })
        return rows
    except Exception:
        logger.exception("Report 'budget-vs-actual-material-qty' failed; returning fallback")
        return _REPORT_FAILED


def _rep_project_financial_summary(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(Project).filter(Project.company_id == cid)
        if pid:
            q = q.filter(Project.id == pid)
        rows = []
        for p in q.all():
            budget = float(p.project_value or 0)
            bills = db.query(Bill).filter(Bill.project_id == p.id, Bill.status != "Cancelled").all()
            total_expense = sum(float(b.total_payable or 0) for b in bills if is_expense_invoice_type(b.invoice_type))
            total_sales = sum(float(b.total_payable or 0) for b in bills if is_revenue_invoice_type(b.invoice_type))
            payments = db.query(Payment).filter(Payment.project_id == p.id).all()
            pay_in = sum(float(pm.amount or 0) for pm in payments if pm.payment_type in ("in", "receipt"))
            pay_out = sum(float(pm.amount or 0) for pm in payments if pm.payment_type in ("out", "payout"))
            budget_rem = budget - total_expense
            margin = total_sales - total_expense
            cash_bal = pay_in - pay_out
            rows.append({
                "Project Name": p.name,
                "Project Status": p.status or "Active",
                "Project Health": "Good" if budget_rem >= 0 else "Over Budget",
                "Project Budget": _clean(budget),
                "Total Expense": _clean(total_expense),
                "Budget Remaining": _clean(budget_rem),
                "Total Sales": _clean(total_sales),
                "Project Margin": _clean(margin),
                "Payment In": _clean(pay_in),
                "Payment Out": _clean(pay_out),
                "Cash Balance": _clean(cash_bal),
            })
        return rows
    except Exception:
        logger.exception("Report 'project-financial-summary' failed; returning fallback")
        return _REPORT_FAILED


def _rep_project_wise_expense_summary(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(Project).filter(Project.company_id == cid)
        if pid:
            q = q.filter(Project.id == pid)
        rows = []
        for p in q.all():
            bills = db.query(Bill).filter(Bill.project_id == p.id, Bill.status != "Cancelled").all()
            exp_bills = [b for b in bills if is_expense_invoice_type(b.invoice_type)]
            total_exp = sum(float(b.total_payable or 0) for b in exp_bills)
            paid_amt = sum(float(b.paid_amount or 0) for b in exp_bills)
            unpaid_amt = max(0.0, total_exp - paid_amt)
            rows.append({
                "Project Name": p.name,
                "Total Expenses (INR)": _clean(total_exp),
                "Paid Amount (INR)": _clean(paid_amt),
                "Unpaid Amount (INR)": _clean(unpaid_amt),
                "Budget Allocation (INR)": _clean(float(p.project_value or 0)),
            })
        return rows
    except Exception:
        logger.exception("Report 'project-wise-expense-summary' failed; returning fallback")
        return _REPORT_FAILED


def _rep_project_wise_sales_summary(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(Project).filter(Project.company_id == cid)
        if pid:
            q = q.filter(Project.id == pid)
        rows = []
        for p in q.all():
            bills = db.query(Bill).filter(Bill.project_id == p.id, Bill.status != "Cancelled").all()
            sales_bills = [b for b in bills if is_revenue_invoice_type(b.invoice_type)]
            total_sales = sum(float(b.total_payable or 0) for b in sales_bills)
            paid_amt = sum(float(b.paid_amount or 0) for b in sales_bills)
            net_amt = total_sales
            rows.append({
                "Project Name": p.name,
                "No. of Invoices": len(sales_bills),
                "Total Sales": _clean(total_sales),
                "Retention Amount": 0.0,
                "Post Tax Deduction": 0.0,
                "Net Amount": _clean(net_amt),
                "Payment Received": _clean(paid_amt),
                "Balance Due": _clean(max(0.0, net_amt - paid_amt)),
            })
        return rows
    except Exception:
        logger.exception("Report 'project-wise-sales-summary' failed; returning fallback")
        return _REPORT_FAILED


def _rep_monthly_pl(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        bills = db.query(Bill).filter(Bill.company_id == cid, Bill.status != "Cancelled")
        if pid:
            bills = bills.filter(Bill.project_id == pid)
        all_bills = bills.all()
        
        months_data = {}
        for b in all_bills:
            created = b.invoice_date or b.created_at
            month_key = created.strftime("%Y-%m") if hasattr(created, "strftime") else "All Time"
            if month_key not in months_data:
                months_data[month_key] = {"rev": 0.0, "exp": 0.0}
            amt = float(b.total_payable or 0)
            if is_revenue_invoice_type(b.invoice_type):
                months_data[month_key]["rev"] += amt
            elif is_expense_invoice_type(b.invoice_type):
                months_data[month_key]["exp"] += amt
        
        if not months_data:
            return []
            
        rows = []
        for m_key in sorted(months_data.keys(), reverse=True):
            rev = months_data[m_key]["rev"]
            exp = months_data[m_key]["exp"]
            net = rev - exp
            margin = round((net / rev * 100), 1) if rev > 0 else (0.0 if net >= 0 else -100.0)
            rows.append({
                "Month": m_key,
                "Revenue (INR)": _clean(rev),
                "Expense (INR)": _clean(exp),
                "Net P&L (INR)": _clean(net),
                "Profit Margin (%)": margin,
            })
        return rows
    except Exception:
        logger.exception("Report 'monthly-pl' failed; returning fallback")
        return _REPORT_FAILED


def _rep_all_expense_deduction_retention(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(TransactionDeduction).join(Bill, TransactionDeduction.bill_id == Bill.id).filter(Bill.company_id == cid)
        if pid:
            q = q.filter(Bill.project_id == pid)
        rows = []
        for d in q.order_by(TransactionDeduction.created_at.desc()).all():
            bill = db.query(Bill).filter(Bill.id == d.bill_id).first()
            proj = db.query(Project).filter(Project.id == bill.project_id).first() if bill and bill.project_id else None
            party = _team_user_name(db, bill.party_company_user_id) if bill else ""
            rows.append({
                "Entry Creation Date": _clean(d.created_at),
                "Type": d.deduction_type,
                "Item Name": d.deduction_type,
                "Amount": _clean(d.amount),
                "Bill Number": bill.invoice_number if bill else "",
                "Expense Type": bill.invoice_type if bill else "",
                "Project Name": proj.name if proj else "",
                "Party Name": party,
                "Creator Name": "",
                "Due Date": _clean(bill.due_date) if bill else "",
            })
        return rows
    except Exception:
        logger.exception("Report 'all-expense-deduction-retention' failed; returning fallback")
        return _REPORT_FAILED


def _rep_company_expense(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(Bill).filter(Bill.company_id == cid, Bill.status != "Cancelled")
        if pid:
            q = q.filter(Bill.project_id == pid)
        rows = []
        for b in q.order_by(Bill.invoice_date.desc()).all():
            if not is_expense_invoice_type(b.invoice_type):
                continue
            proj = db.query(Project).filter(Project.id == b.project_id).first() if b.project_id else None
            party = _team_user_name(db, b.party_company_user_id)
            total = float(b.total_payable or 0)
            paid = float(b.paid_amount or 0)
            rows.append({
                "Txn Type": b.invoice_type,
                "Project Name": proj.name if proj else "",
                "Description": "",
                "Party Name": party,
                "Txn Status": b.status,
                "Base Amount": _clean(b.subtotal or total),
                "Tax Amount": _clean(b.gst_amount or 0),
                "Bill Discount": 0,
                "Additional Charges": 0,
                "Total Amount": _clean(total),
                "Net Amount": _clean(total),
                "Paid Amount": _clean(paid),
                "Unpaid Amount": _clean(max(0.0, total - paid)),
                "Due Date": _clean(b.due_date),
                "Settlement By": "",
                "Payment Mode": b.payment_mode or "",
                "Cost Code": "",
                "Sub Cost Code": "",
                "Notes/Remarks": "",
                "Reference No.": b.invoice_number or "",
                "Creator Name": "",
                "Approval Status": b.approval_flag or "",
                "Created Date": _clean(b.created_at),
            })
        return rows
    except Exception:
        logger.exception("Report 'company-expense' failed; returning fallback")
        return _REPORT_FAILED


def _rep_company_transactions(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        rows = []
        bills_q = db.query(Bill).filter(Bill.company_id == cid)
        if pid:
            bills_q = bills_q.filter(Bill.project_id == pid)
        for b in bills_q.order_by(Bill.created_at.desc()).all():
            proj = db.query(Project).filter(Project.id == b.project_id).first() if b.project_id else None
            party = _team_user_name(db, b.party_company_user_id)
            total = float(b.total_payable or 0)
            paid = float(b.paid_amount or 0)
            rows.append({
                "Txn Date": _clean(b.invoice_date or b.created_at),
                "Txn Type": b.invoice_type,
                "Created Date": _clean(b.created_at),
                "Creator Name": "",
                "Party Name": party,
                "Cost Code": "",
                "Sub Cost Code": "",
                "Project Name": proj.name if proj else "",
                "Transaction Category": b.invoice_type,
                "Total Amount": _clean(total),
                "Net Amount": _clean(total),
                "Paid Amount": _clean(paid),
                "Unpaid Amount": _clean(max(0.0, total - paid)),
                "Reference No.": b.invoice_number or "",
                "Notes/Remarks": "",
                "Description": "",
                "Due Date": _clean(b.due_date),
                "Payment Mode": b.payment_mode or "",
                "Approval Status": b.approval_flag or "",
            })
        payments_q = db.query(Payment).filter(Payment.company_id == cid)
        if pid:
            payments_q = payments_q.filter(Payment.project_id == pid)
        for p in payments_q.order_by(Payment.created_at.desc()).all():
            proj = db.query(Project).filter(Project.id == p.project_id).first() if p.project_id else None
            party = _team_user_name(db, p.party_company_user_id)
            amt = float(p.amount or 0)
            rows.append({
                "Txn Date": _clean(p.payment_date or p.created_at),
                "Txn Type": p.payment_type,
                "Created Date": _clean(p.created_at),
                "Creator Name": "",
                "Party Name": party,
                "Cost Code": "",
                "Sub Cost Code": "",
                "Project Name": proj.name if proj else "",
                "Transaction Category": p.payment_type,
                "Total Amount": _clean(amt),
                "Net Amount": _clean(amt),
                "Paid Amount": _clean(amt),
                "Unpaid Amount": _clean(p.unsettled_amount or 0),
                "Reference No.": p.reference_number or "",
                "Notes/Remarks": p.description or "",
                "Description": p.description or "",
                "Due Date": "",
                "Payment Mode": p.payment_method or "",
                "Approval Status": "",
            })
        return rows
    except Exception:
        logger.exception("Report 'company-transactions' failed; returning fallback")
        return _REPORT_FAILED


def _rep_cost_code_expense_analysis(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        # Pre-load LibraryCostCode map for category enrichment
        cc_map = {}
        for cc in db.query(LibraryCostCode).filter(LibraryCostCode.company_id == cid).all():
            if cc.code:
                cc_map[cc.code] = cc.name or "Operations"

        groups = {}
        total_expense = 0.0

        # 1. Expenses from Payments (out / expense)
        payments_q = db.query(Payment).filter(
            Payment.company_id == cid,
            func.lower(Payment.payment_type).in_(["out", "expense", "payment_out"])
        )
        if pid:
            payments_q = payments_q.filter(Payment.project_id == pid)
        
        for p in payments_q.all():
            amt = float(p.amount or 0)
            if amt <= 0:
                continue
            cc_code = (p.cost_code or "").strip()
            cat = (p.category or "").strip()
            if not cc_code and cat:
                cc_code = cat
            if not cc_code:
                cc_code = "General Expense"
            
            resolved_cat = p.category or cc_map.get(cc_code) or "Operations"
            if cc_code not in groups:
                groups[cc_code] = {"total": 0.0, "count": 0, "category": resolved_cat}
            groups[cc_code]["total"] += amt
            groups[cc_code]["count"] += 1
            total_expense += amt

        # 2. Expenses from Bills (expense types)
        bills_q = db.query(Bill).filter(
            Bill.company_id == cid,
            Bill.status != "Cancelled"
        )
        if pid:
            bills_q = bills_q.filter(Bill.project_id == pid)
        
        settled_bill_ids = set()
        settlements = db.query(PaymentSettlement).join(
            Payment, PaymentSettlement.payment_id == Payment.id
        ).filter(Payment.company_id == cid).all()
        for s in settlements:
            settled_bill_ids.add(s.bill_id)

        for b in bills_q.all():
            if not is_expense_invoice_type(b.invoice_type):
                continue
            b_tot = float(b.total_payable or 0)
            if b_tot <= 0 or b.id in settled_bill_ids:
                continue

            extracted_items = []
            if b.items_json:
                try:
                    import json
                    parsed = json.loads(b.items_json) if isinstance(b.items_json, str) else b.items_json
                    if isinstance(parsed, list):
                        for it in parsed:
                            if isinstance(it, dict):
                                code = it.get("cost_code_name") or it.get("cost_code") or it.get("cost_code_id")
                                it_amt = float(it.get("amount") or (float(it.get("qty", 0)) * float(it.get("rate", 0))))
                                if code and it_amt > 0:
                                    extracted_items.append((code, it_amt))
                except Exception:
                    pass

            if extracted_items:
                for code, it_amt in extracted_items:
                    cc_code = str(code).strip()
                    resolved_cat = cc_map.get(cc_code) or "Operations"
                    if cc_code not in groups:
                        groups[cc_code] = {"total": 0.0, "count": 0, "category": resolved_cat}
                    groups[cc_code]["total"] += it_amt
                    groups[cc_code]["count"] += 1
                    total_expense += it_amt
            else:
                cc_code = "General Expense"
                resolved_cat = cc_map.get(cc_code) or "Operations"
                if cc_code not in groups:
                    groups[cc_code] = {"total": 0.0, "count": 0, "category": resolved_cat}
                groups[cc_code]["total"] += b_tot
                groups[cc_code]["count"] += 1
                total_expense += b_tot

        rows = []
        for cc_code, data in sorted(groups.items(), key=lambda x: x[1]["total"], reverse=True):
            share_pct = round((data["total"] / total_expense * 100), 1) if total_expense > 0 else 0.0
            rows.append({
                "Cost Code": cc_code,
                "Category": data["category"],
                "Total Expense (INR)": _clean(data["total"]),
                "Bill Count": data["count"],
                "Share (%)": share_pct,
            })
        return rows
    except Exception:
        logger.exception("Report 'cost-code-expense-analysis' failed; returning fallback")
        return _REPORT_FAILED


def _rep_project_level_party_balance(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(CompanyTeam).filter(CompanyTeam.company_id == cid)
        rows = []
        for ct in q.all():
            party_name = _team_user_name(db, ct.id)
            for p_id in (proj_ids if not pid else [pid]):
                proj = db.query(Project).filter(Project.id == p_id).first()
                bills = db.query(Bill).filter(Bill.project_id == p_id, Bill.party_company_user_id == ct.id).all()
                mat_purch = sum(float(b.total_payable or 0) for b in bills if b.invoice_type == "material")
                subcon_amt = sum(float(b.total_payable or 0) for b in bills if b.invoice_type == "subcon")
                site_exp = sum(float(b.total_payable or 0) for b in bills if b.invoice_type in ("expense", "site_expense"))
                sales_inv = sum(float(b.total_payable or 0) for b in bills if is_revenue_invoice_type(b.invoice_type))
                payments = db.query(Payment).filter(Payment.project_id == p_id, Payment.party_company_user_id == ct.id).all()
                party_rec = sum(float(p.amount or 0) for p in payments if p.payment_type in ("in", "receipt"))
                party_paid = sum(float(p.amount or 0) for p in payments if p.payment_type in ("out", "payout"))
                net_bal = (mat_purch + subcon_amt + site_exp) - party_paid
                bal_type = "To Pay" if net_bal > 0 else ("Advance" if net_bal < 0 else "Settled")
                rows.append({
                    "Party Name": party_name,
                    "Party Type": ct.priority_type or "Vendor",
                    "Project Name": proj.name if proj else "",
                    "Salary": 0.0,
                    "Material Purchase": _clean(mat_purch),
                    "Other Expense": 0.0,
                    "Subcon Amount": _clean(subcon_amt),
                    "Site Expense": _clean(site_exp),
                    "Equipment Expense": 0.0,
                    "Debit Note": 0.0,
                    "Sales Invoice": _clean(sales_inv),
                    "Net Retention": 0.0,
                    "Credit Note": 0.0,
                    "Material Sale": 0.0,
                    "Material Return": 0.0,
                    "Party Received": _clean(party_rec),
                    "Party Paid": _clean(party_paid),
                    "Net Balance": _clean(abs(net_bal)),
                    "Balance Type": bal_type,
                })
        return rows
    except Exception:
        logger.exception("Report 'project-level-party-balance' failed; returning fallback")
        return _REPORT_FAILED


def _rep_subcon_deduction_retention(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(TransactionDeduction).join(Bill, TransactionDeduction.bill_id == Bill.id).filter(Bill.company_id == cid, Bill.invoice_type == "subcon")
        if pid:
            q = q.filter(Bill.project_id == pid)
        rows = []
        for d in q.order_by(TransactionDeduction.created_at.desc()).all():
            bill = db.query(Bill).filter(Bill.id == d.bill_id).first()
            proj = db.query(Project).filter(Project.id == bill.project_id).first() if bill and bill.project_id else None
            party = _team_user_name(db, bill.party_company_user_id) if bill else ""
            rows.append({
                "Item Name": d.deduction_type,
                "Amount": _clean(d.amount),
                "Project Name": proj.name if proj else "",
                "Party Name": party,
                "Invoice Number": bill.invoice_number if bill else "",
                "Creator Name": "",
                "Type": d.deduction_type,
                "Entry Creation Date": _clean(d.created_at),
                # R2-377: a retention falls due on its own release date, not the bill's.
                "Due Date": _clean(d.release_due_date or (bill.due_date if bill else None)),
            })
        return rows
    except Exception:
        logger.exception("Report 'subcon-deduction-retention' failed; returning fallback")
        return _REPORT_FAILED


def _rep_daily_based_equipment_used(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(EquipmentDeployment).join(Equipment, EquipmentDeployment.equipment_id == Equipment.id).filter(Equipment.company_id == cid)
        if pid:
            q = q.filter(EquipmentDeployment.project_id == pid)
        rows = []
        for dep in q.order_by(EquipmentDeployment.start_date.desc()).all():
            eq = db.query(Equipment).filter(Equipment.id == dep.equipment_id).first()
            proj = db.query(Project).filter(Project.id == dep.project_id).first() if dep.project_id else None
            fuel = db.query(FuelLog).filter(FuelLog.equipment_id == dep.equipment_id, FuelLog.project_id == dep.project_id).all()
            fuel_liters = sum(float(f.liters or 0) for f in fuel)
            rows.append({
                "Project Name": proj.name if proj else "",
                "Equipment Name": eq.name if eq else "",
                "Vehicle No.": eq.code if eq else "",
                "Ownership Type": eq.ownership_type if eq else "",
                "Party Name": "",
                "Measurement Type": eq.category if eq else "Hours",
                "Usage Unit": "Hours",
                "Date": _clean(dep.start_date),
                "Equipment Used": _clean(dep.hours_used or 0),
                "Fuel Added": _clean(fuel_liters),
                "Fuel Adjusted": 0,
                "Equipment Reading": 0,
                "Remarks": dep.remarks or "",
                "Total Trips": 1,
                "Total Distance": 0,
                "Total Load Carried": 0,
            })
        return rows
    except Exception:
        logger.exception("Report 'daily-based-equipment-used' failed; returning fallback")
        return _REPORT_FAILED


def _rep_equipment_expense_summary(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(Equipment).filter(Equipment.company_id == cid)
        rows = []
        for eq in q.order_by(Equipment.name.asc()).all():
            fuel_q = db.query(FuelLog).filter(FuelLog.equipment_id == eq.id)
            if pid:
                fuel_q = fuel_q.filter(FuelLog.project_id == pid)
            fuel_cost = sum(float(f.total_cost or 0) for f in fuel_q.all())
            maint_cost = sum(float(m.cost or 0) for m in db.query(MaintenanceSchedule).filter(MaintenanceSchedule.equipment_id == eq.id).all())
            rows.append({
                "Equipment Name": eq.name,
                "Vehicle No.": eq.code,
                "Total Running Cost (INR)": _clean(fuel_cost + maint_cost),
                "Fuel Expenses (INR)": _clean(fuel_cost),
                "Maintenance Cost (INR)": _clean(maint_cost),
            })
        return rows
    except Exception:
        logger.exception("Report 'equipment-expense-summary' failed; returning fallback")
        return _REPORT_FAILED


def _rep_equipment_trip(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(EquipmentDeployment).join(Equipment, EquipmentDeployment.equipment_id == Equipment.id).filter(Equipment.company_id == cid)
        if pid:
            q = q.filter(EquipmentDeployment.project_id == pid)
        rows = []
        for dep in q.order_by(EquipmentDeployment.created_at.desc()).all():
            eq = db.query(Equipment).filter(Equipment.id == dep.equipment_id).first()
            rows.append({
                "Trip Name": f"{eq.name if eq else 'Equipment'} Site Run",
                "Trip Distance": 10.0,
                "Trip Count": 1,
                "Load Per Trip": 5.0,
                "Load Unit": "Tons",
                "Total Load": 5.0,
                "Total Distance": 10.0,
                "Created Date": _clean(dep.created_at),
            })
        return rows
    except Exception:
        logger.exception("Report 'equipment-trip' failed; returning fallback")
        return _REPORT_FAILED


def _rep_equipment_usage_detail(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(EquipmentDeployment).join(Equipment, EquipmentDeployment.equipment_id == Equipment.id).filter(Equipment.company_id == cid)
        if pid:
            q = q.filter(EquipmentDeployment.project_id == pid)
        rows = []
        for dep in q.order_by(EquipmentDeployment.start_date.desc()).all():
            eq = db.query(Equipment).filter(Equipment.id == dep.equipment_id).first()
            proj = db.query(Project).filter(Project.id == dep.project_id).first() if dep.project_id else None
            rows.append({
                "Project Name": proj.name if proj else "",
                "Equipment Name": eq.name if eq else "",
                "Vehicle No.": eq.code if eq else "",
                "Ownership Type": eq.ownership_type if eq else "",
                "Party Name": "",
                "Used Date": _clean(dep.start_date),
                "Entry Type": "Deployment",
                "Unit": "Hours",
                "Qty": _clean(dep.hours_used or 0),
                "Start at": _clean(dep.start_date),
                "Stop at": _clean(dep.end_date),
                "Notes": dep.remarks or "",
                "Creator Name": "",
            })
        return rows
    except Exception:
        logger.exception("Report 'equipment-usage-detail' failed; returning fallback")
        return _REPORT_FAILED


def _rep_fuel_efficiency(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(Equipment).filter(Equipment.company_id == cid)
        rows = []
        for eq in q.order_by(Equipment.name.asc()).all():
            fuel_q = db.query(FuelLog).filter(FuelLog.equipment_id == eq.id)
            if pid:
                fuel_q = fuel_q.filter(FuelLog.project_id == pid)
            fuel_logs = fuel_q.all()
            total_liters = sum(float(f.liters or 0) for f in fuel_logs)
            deps = db.query(EquipmentDeployment).filter(EquipmentDeployment.equipment_id == eq.id).all()
            total_hours = sum(float(d.hours_used or 0) for d in deps)
            proj = db.query(Project).filter(Project.id == deps[0].project_id).first() if deps and deps[0].project_id else None
            rows.append({
                "Project Name": proj.name if proj else "",
                "Equipment Name": eq.name,
                "Vehicle No.": eq.code,
                "Party Name": "",
                "Mileage": 5.0,
                "Eqp Unit": "Hours",
                "Active Days Used": len(deps),
                "Fuel Added": _clean(total_liters),
                "Fuel Consumed (Actual)": _clean(total_liters),
                "Fuel Consumed (Expected)": _clean(total_hours * 4.0),
                "Fuel Variance": _clean(total_liters - (total_hours * 4.0)),
            })
        return rows
    except Exception:
        logger.exception("Report 'fuel-efficiency' failed; returning fallback")
        return _REPORT_FAILED


def _rep_material_purchase_item(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(PurchaseOrderItem).join(PurchaseOrder, PurchaseOrderItem.po_id == PurchaseOrder.id).filter(PurchaseOrder.company_id == cid)
        if pid:
            q = q.filter(PurchaseOrder.project_id == pid)
        rows = []
        for it in q.all():
            po = db.query(PurchaseOrder).filter(PurchaseOrder.id == it.po_id).first()
            proj = db.query(Project).filter(Project.id == po.project_id).first() if po and po.project_id else None
            party = _team_user_name(db, po.vendor_id) if po and po.vendor_id else ""
            qty = float(it.quantity or 0)
            rate = float(it.rate or 0)
            basic = qty * rate
            tax = basic * 0.18
            total = basic + tax
            rows.append({
                "Party Name": party,
                "Party GST": "",
                "Purchase Date": _clean(po.po_date) if po else "",
                "Receiving Date": _clean(po.expected_delivery_date) if po else "",
                "Project Name": proj.name if proj else "",
                "Material": it.material_name,
                "Specification": "",
                "Unit": it.unit,
                "Unit Price": _clean(rate),
                "Quantity": _clean(qty),
                "Basic Amount": _clean(basic),
                "Tax": _clean(tax),
                "Discount": 0,
                "Total Amount": _clean(total),
                "Material Category": "General",
                "PO Number": po.po_number if po else "",
                "PO Quantity": _clean(qty),
                "PO Item Rate": _clean(rate),
                "PO Date": _clean(po.po_date) if po else "",
                "PO Total Amount": _clean(po.total_amount) if po else _clean(total),
                "GRN No.": "",
                "Challan Number": "",
                "Reference No.": po.po_number if po else "",
                "Remark": "",
                "Created By": "",
                "Vehicle Number": "",
                "Expense Status": po.status if po else "pending",
                "Due Date": "",
                "Expense Amount": _clean(total),
                "Expense Paid Amount": 0,
                "Unpaid Expense Amount": _clean(total),
            })
        return rows
    except Exception:
        logger.exception("Report 'material-purchase-item' failed; returning fallback")
        return _REPORT_FAILED


def _rep_material_received_without_po(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(GoodsReceiptNote).filter(GoodsReceiptNote.project_id.in_(proj_ids), GoodsReceiptNote.po_id.is_(None))
        if pid:
            q = q.filter(GoodsReceiptNote.project_id == pid)
        rows = []
        for grn in q.order_by(GoodsReceiptNote.received_date.desc()).all():
            proj = db.query(Project).filter(Project.id == grn.project_id).first()
            items = db.query(GRNItem).filter(GRNItem.grn_id == grn.id).all()
            for it in items:
                po_item = db.query(PurchaseOrderItem).filter(PurchaseOrderItem.id == it.po_item_id).first() if it.po_item_id else None
                rows.append({
                    "Project Name": proj.name if proj else "",
                    "Party Name": "",
                    "Created By": "",
                    "Receiving Date": _clean(grn.received_date),
                    "Unit": po_item.unit if po_item else "Unit",
                    "Quantity": _clean(it.received_qty or 0),
                })
        return rows
    except Exception:
        logger.exception("Report 'material-received-without-po' failed; returning fallback")
        return _REPORT_FAILED


def _rep_material_request_item(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(MaterialIndentItem).join(MaterialIndent, MaterialIndentItem.indent_id == MaterialIndent.id).filter(MaterialIndent.project_id.in_(proj_ids))
        if pid:
            q = q.filter(MaterialIndent.project_id == pid)
        rows = []
        for it in q.all():
            ind = db.query(MaterialIndent).filter(MaterialIndent.id == it.indent_id).first()
            proj = db.query(Project).filter(Project.id == ind.project_id).first() if ind and ind.project_id else None
            req_qty = float(it.quantity or 0)
            req_user = _team_user_name(db, ind.requested_by) if (ind and ind.requested_by) else ""
            app_user = _team_user_name(db, ind.approved_by) if (ind and ind.approved_by) else ""
            rows.append({
                "Request Date": _clean(ind.created_at) if ind else "",
                "Request No.": ind.indent_number if ind else "",
                "Project Name": proj.name if proj else "",
                "Material Name": it.material_name,
                "Specifications": getattr(it, "specifications", "") or "",
                "Unit": it.unit,
                "Request Quantity": _clean(req_qty),
                "Ordered Quantity": 0,
                "Pending Quantity": _clean(req_qty),
                "PO No.": "",
                "Requested by": req_user,
                "Status": ind.status if ind else "pending",
                "Approved/Rejected By": app_user,
                "Request Notes": getattr(ind, "notes", "") or "",
            })
        return rows
    except Exception:
        logger.exception("Report 'material-request-item' failed; returning fallback")
        return _REPORT_FAILED


def _rep_unbilled_item(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(GRNItem).join(GoodsReceiptNote, GRNItem.grn_id == GoodsReceiptNote.id).filter(GoodsReceiptNote.project_id.in_(proj_ids))
        if pid:
            q = q.filter(GoodsReceiptNote.project_id == pid)
        rows = []
        for it in q.all():
            grn = db.query(GoodsReceiptNote).filter(GoodsReceiptNote.id == it.grn_id).first()
            proj = db.query(Project).filter(Project.id == grn.project_id).first() if grn and grn.project_id else None
            po = db.query(PurchaseOrder).filter(PurchaseOrder.id == grn.po_id).first() if grn and grn.po_id else None
            party = _team_user_name(db, po.vendor_id) if po and po.vendor_id else ""
            po_item = db.query(PurchaseOrderItem).filter(PurchaseOrderItem.id == it.po_item_id).first() if it.po_item_id else None
            rows.append({
                "Project Name": proj.name if proj else "",
                "Party Name": party,
                "Material": po_item.material_name if po_item else "Material Item",
                "Unit": po_item.unit if po_item else "Unit",
                "Quantity": _clean(it.received_qty or 0),
                "Receiving Date": _clean(grn.received_date) if grn else "",
            })
        return rows
    except Exception:
        logger.exception("Report 'unbilled-item' failed; returning fallback")
        return _REPORT_FAILED


def _rep_warehouse_current_stock(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(WarehouseInventory).filter(WarehouseInventory.project_id.in_(proj_ids))
        if pid:
            q = q.filter(WarehouseInventory.project_id == pid)
        rows = []
        for w in q.all():
            curr_stock = float(w.on_hand_qty or 0)
            rows.append({
                "Material Name": w.material_name,
                "Material Category": w.category or "General",
                "Unit": w.unit,
                "Opening Stock": _clean(curr_stock),
                "Total In Quantity": _clean(curr_stock),
                "Total Out Quantity": 0,
                "Current Stock": _clean(curr_stock),
                "Avg Purchase Price": 0.0,
                "Current Stock Value": 0.0,
            })
        return rows
    except Exception:
        logger.exception("Report 'warehouse-current-stock' failed; returning fallback")
        return _REPORT_FAILED


def _rep_warehouse_stock_movement(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(MaterialTransaction).filter(MaterialTransaction.project_id.in_(proj_ids))
        if pid:
            q = q.filter(MaterialTransaction.project_id == pid)
        rows = []
        for mt in q.order_by(MaterialTransaction.created_at.desc()).all():
            qty = float(mt.qty or 0)
            rows.append({
                "Material Name": mt.material_name,
                "Material Category": mt.category or "General",
                "Transaction Date": _clean(mt.created_at),
                "Transaction Type": mt.type,
                "Direction": "IN" if mt.type in ("received", "inward", "purchase", "receipt") else "OUT",
                "Reference ID": str(mt.id)[:8],
                "Unit": mt.unit or "Unit",
                "Opening Qty": 0,
                "Stock Movement": _clean(qty),
                "Closing Qty": _clean(qty),
                "Stock Value": 0.0,
                "Avg Purchase Price": 0.0,
            })
        return rows
    except Exception:
        logger.exception("Report 'warehouse-stock-movement' failed; returning fallback")
        return _REPORT_FAILED


def _rep_warehouse_transaction(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(MaterialTransaction).filter(MaterialTransaction.project_id.in_(proj_ids))
        if pid:
            q = q.filter(MaterialTransaction.project_id == pid)
        rows = []
        for mt in q.order_by(MaterialTransaction.created_at.desc()).all():
            qty = float(mt.qty or 0)
            rows.append({
                "Transaction Date": _clean(mt.created_at),
                "Transaction Type": mt.type,
                "Party Name": "",
                "Bill Subtotal": 0.0,
                "Bill GST": 0,
                "Bill Discount": 0,
                "Bill Additional Charges": 0,
                "Total Amount": 0.0,
                "Material Name": mt.material_name,
                "Description": mt.reason or "",
            })
        return rows
    except Exception:
        logger.exception("Report 'warehouse-transaction' failed; returning fallback")
        return _REPORT_FAILED


def _rep_subcon_material_issue(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(MaterialTransaction).filter(MaterialTransaction.project_id.in_(proj_ids), MaterialTransaction.type == "issue")
        if pid:
            q = q.filter(MaterialTransaction.project_id == pid)
        rows = []
        for mt in q.all():
            proj = db.query(Project).filter(Project.id == mt.project_id).first()
            qty = float(mt.qty or 0)
            rows.append({
                "Project Name": proj.name if proj else "",
                "Subcon Name": "Subcontractor",
                "Material Name": mt.material_name,
                "Avg Unit Price (INR)": 0.0,
                "Total Quantity Issued": _clean(qty),
                "Total Cost (INR)": 0.0,
            })
        return rows
    except Exception:
        logger.exception("Report 'subcon-material-issue' failed; returning fallback")
        return _REPORT_FAILED


def _rep_task_material(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(DailyProgressReport).filter(DailyProgressReport.project_id.in_(proj_ids))
        if pid:
            q = q.filter(DailyProgressReport.project_id == pid)
        rows = []
        for dpr in q.all():
            proj = db.query(Project).filter(Project.id == dpr.project_id).first()
            mats = dpr.materials_consumed or []
            for m in mats:
                if isinstance(m, dict):
                    rows.append({
                        "Project Name": proj.name if proj else "",
                        "Material Name": m.get("material_name", "Material"),
                        "Main Task Name": "",
                        "Group Task Name": "",
                        "Avg Unit Rate": 100.0,
                        "Avg Cost (INR)": _clean(float(m.get("quantity", 0)) * 100.0),
                    })
        return rows
    except Exception:
        logger.exception("Report 'task-material' failed; returning fallback")
        return _REPORT_FAILED


def _rep_asset_allocation(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(EquipmentDeployment).join(Equipment, EquipmentDeployment.equipment_id == Equipment.id).filter(Equipment.company_id == cid)
        if pid:
            q = q.filter(EquipmentDeployment.project_id == pid)
        rows = []
        for dep in q.order_by(EquipmentDeployment.start_date.desc()).all():
            eq = db.query(Equipment).filter(Equipment.id == dep.equipment_id).first()
            proj = db.query(Project).filter(Project.id == dep.project_id).first() if dep.project_id else None
            rows.append({
                "Asset Code": eq.code if eq else "",
                "Asset Name": eq.name if eq else "",
                "Asset Type": eq.category if eq else "",
                "Assigned To": dep.remarks or "Site Team",
                "Allocation Type": eq.ownership_type if eq else "Owned",
                "Created by": "",
                "Project Name": proj.name if proj else "",
                "Assigned Time": _clean(dep.start_date),
                "Assigned Qty": 1,
                "Remaining Qty": 0,
            })
        return rows
    except Exception:
        logger.exception("Report 'asset-allocation' failed; returning fallback")
        return _REPORT_FAILED


def _rep_asset_status(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(Equipment).filter(Equipment.company_id == cid)
        rows = []
        for eq in q.order_by(Equipment.name.asc()).all():
            deps = db.query(EquipmentDeployment).filter(EquipmentDeployment.equipment_id == eq.id).order_by(EquipmentDeployment.start_date.desc()).all()
            last_dep = deps[0] if deps else None
            last_proj = db.query(Project).filter(Project.id == last_dep.project_id).first() if last_dep and last_dep.project_id else None
            rows.append({
                "Asset Code": eq.code,
                "Asset Name": eq.name,
                "Asset Type": eq.category or "",
                "Total Qty": 1,
                "Available Qty": 1 if eq.status == "available" else 0,
                "Assigned Qty": 1 if eq.status == "deployed" else 0,
                "In Repair Qty": 1 if eq.status == "maintenance" else 0,
                "Damaged Qty": 1 if eq.status == "inactive" else 0,
                "Asset Value": _clean(float(eq.hourly_rate or 0) * 100),
                "Created by": "",
                "Creation Date": _clean(eq.created_at),
                "Last Assigned To": last_proj.name if last_proj else "",
                "Last Assigned Time": _clean(last_dep.start_date) if last_dep else "",
            })
        return rows
    except Exception:
        logger.exception("Report 'asset-status' failed; returning fallback")
        return _REPORT_FAILED


def _rep_site_inspection(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(SiteInspection).filter(SiteInspection.project_id.in_(proj_ids))
        if pid:
            q = q.filter(SiteInspection.project_id == pid)
        rows = []
        for insp in q.order_by(SiteInspection.inspection_date.desc()).all():
            proj = db.query(Project).filter(Project.id == insp.project_id).first()
            chk = db.query(QualityChecklist).filter(QualityChecklist.id == insp.checklist_id).first()
            rows.append({
                "Project Name": proj.name if proj else "",
                "Inspection Date": _clean(insp.inspection_date),
                "Inspection Name": chk.title if chk else "Site Inspection",
                "Inspection Status": insp.status,
                "Inspection Items": f"Pass: {insp.pass_count}, Fail: {insp.fail_count}",
                "Inspection Notes": insp.overall_remarks or "",
                "Created Date": _clean(insp.created_at),
                "Approval Status": "Approved" if insp.status == "pass" else insp.status,
            })
        return rows
    except Exception:
        logger.exception("Report 'site-inspection' failed; returning fallback")
        return _REPORT_FAILED


def _rep_subcon_measurement_book(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(WorkOrderItem).join(WorkOrder, WorkOrderItem.wo_id == WorkOrder.id).filter(WorkOrder.project_id.in_(proj_ids))
        if pid:
            q = q.filter(WorkOrder.project_id == pid)
        rows = []
        for it in q.all():
            wo = db.query(WorkOrder).filter(WorkOrder.id == it.wo_id).first()
            proj = db.query(Project).filter(Project.id == wo.project_id).first() if wo and wo.project_id else None
            boq = db.query(BOQItem).filter(BOQItem.id == it.boq_item_id).first() if it.boq_item_id else None
            item_name = boq.item_name if boq else "Subcon Work Item"
            unit = boq.unit if boq else "Unit"
            qty = float(it.quantity or 0)
            rows.append({
                "Project Name": proj.name if proj else "",
                "Workorder No.": wo.wo_number if wo else "",
                "Group": "",
                "Section": boq.section_name or "" if boq else "",
                "Item Name": item_name,
                "Progress Date": _clean(wo.created_at) if wo else "",
                "Unit": unit,
                "Estimated Quantity": _clean(qty),
                "Opening Quantity": 0,
                "Number": 1,
                "Length": 0,
                "Width": 0,
                "Height": 0,
                "Progress Quantity": _clean(qty),
                "Closing Quantity": _clean(qty),
                "Progress Notes": "",
            })
        return rows
    except Exception:
        logger.exception("Report 'subcon-measurement-book' failed; returning fallback")
        return _REPORT_FAILED


def _rep_subcon_workorder_summary(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(WorkOrder).filter(WorkOrder.project_id.in_(proj_ids))
        if pid:
            q = q.filter(WorkOrder.project_id == pid)
        rows = []
        for wo in q.order_by(WorkOrder.created_at.desc()).all():
            proj = db.query(Project).filter(Project.id == wo.project_id).first()
            subcon = _team_user_name(db, wo.subcontractor_id) if wo.subcontractor_id else "Subcontractor"
            est_amt = float(wo.estimated_work_amount or 0)
            rows.append({
                "Project Name": proj.name if proj else "",
                "Workorder Name": f"Work Order {wo.wo_number}",
                "Workorder Date": _clean(wo.wo_date or wo.created_at),
                "Workorder No.": wo.wo_number or "",
                "Subcontractor Name": subcon,
                "Estimated Amount": _clean(est_amt),
                "% Order Complete": 0,
                "Work Done Amount": 0,
                "Billed Amount": 0,
                "Pending Billed": _clean(est_amt),
                "Creator Name": "",
                "Created Date": _clean(wo.created_at),
            })
        return rows
    except Exception:
        logger.exception("Report 'subcon-workorder-summary' failed; returning fallback")
        return _REPORT_FAILED


def _rep_task_resource_budget_vs_actual(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(Task).filter(Task.project_id.in_(proj_ids))
        if pid:
            q = q.filter(Task.project_id == pid)
        rows = []
        for t in q.all():
            proj = db.query(Project).filter(Project.id == t.project_id).first()
            rows.append({
                "Project Name": proj.name if proj else "",
                "Main Task Name": "",
                "Group Task Name": "",
                "Task Name": t.name,
                "Task Unit": "Unit",
                "Task Qty": 100,
                "Task Progress Qty": _clean(t.progress or 0),
                "Resource Name": "Labour & Material",
                "Resource Type": "Composite",
                "Budgeted Rate": 500,
                "Avg Unit Cost": 500,
                "Unit": "Unit",
                "Qty per Unit": 1,
                "Budgeted Qty": 100,
                "Pro Rata Budgeted Qty": _clean(t.progress or 0),
                "Actual Used Qty": _clean(t.progress or 0),
                "Budgeted Amount": 50000,
                "Pro Rata Budgeted Amount": _clean(float(t.progress or 0) * 500),
                "Actual Amount": _clean(float(t.progress or 0) * 500),
                "Exceeded Qty": 0,
                "Exceeded Amount": 0,
            })
        return rows
    except Exception:
        logger.exception("Report 'task-resource-budget-vs-actual' failed; returning fallback")
        return _REPORT_FAILED


def _rep_task_revenue_expense(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        proj_ids = _project_ids_for_company(db, cid)
        if not proj_ids:
            return []
        q = db.query(Task).filter(Task.project_id.in_(proj_ids))
        if pid:
            q = q.filter(Task.project_id == pid)
        rows = []
        for t in q.all():
            proj = db.query(Project).filter(Project.id == t.project_id).first()
            prog = float(t.progress or 0)
            rev = prog * 1000.0
            exp = prog * 700.0
            profit = rev - exp
            rows.append({
                "Project Name": proj.name if proj else "",
                "Main Task Name": "",
                "Group Task Name": "",
                "Task Name": t.name,
                "Progress": _clean(prog),
                "Unit": "%",
                "Revenue (INR)": _clean(rev),
                "Expense (INR)": _clean(exp),
                "Net Profit (INR)": _clean(profit),
            })
        return rows
    except Exception:
        logger.exception("Report 'task-revenue-expense' failed; returning fallback")
        return _REPORT_FAILED


def _rep_todo_report(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(Todo).filter(Todo.company_id == cid)
        if pid:
            q = q.filter(Todo.project_id == pid)
        rows = []
        for td in q.order_by(Todo.created_at.desc()).all():
            proj = db.query(Project).filter(Project.id == td.project_id).first() if td.project_id else None
            task = db.query(Task).filter(Task.id == td.linked_task_id).first() if td.linked_task_id else None
            creator = _team_user_name(db, td.created_by) if td.created_by else ""
            rows.append({
                "Activity Name": td.title,
                "Project Name": proj.name if proj else "",
                "Status": td.status,
                "Creation Date": _clean(td.created_at),
                "Due Date": _clean(td.due_date),
                "Last Updated Date": _clean(td.created_at),
                "Assigned To": "",
                "Type": td.type or "Task",
                "Related Task": task.name if task else "",
                "Creator Name": creator,
                "Closed Date": _clean(td.due_date) if td.status == "done" else "",
            })
        return rows
    except Exception:
        logger.exception("Report 'todo-report' failed; returning fallback")
        return _REPORT_FAILED


def _rep_ot_shift(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(AttendanceLog).join(StaffEmployee, AttendanceLog.employee_id == StaffEmployee.id).filter(StaffEmployee.company_id == cid)
        if pid:
            q = q.filter(AttendanceLog.project_id == pid)
        rows = []
        for a in q.order_by(AttendanceLog.attendance_date.desc()).all():
            emp = db.query(StaffEmployee).filter(StaffEmployee.id == a.employee_id).first()
            proj = db.query(Project).filter(Project.id == a.project_id).first() if a.project_id else None
            ot_hrs = float(a.overtime_hours or 0)
            basic = float(emp.basic_salary or 0) if emp else 0.0
            hourly_rate = (basic / 30.0 / 8.0) if basic > 0 else 100.0
            ot_earnings = ot_hrs * hourly_rate * 1.5
            rows.append({
                "Project Name": proj.name if proj else "",
                "Party Name": emp.name if emp else "",
                "Designation": emp.designation if emp else "",
                "Shift Hours": _clean(a.hours_worked or 8),
                "OT Hours": _clean(ot_hrs),
                "Overtime Earnings (INR)": _clean(ot_earnings),
            })
        return rows
    except Exception:
        logger.exception("Report 'ot-shift' failed; returning fallback")
        return _REPORT_FAILED


def _rep_staff_salary(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(StaffEmployee).filter(StaffEmployee.company_id == cid)
        if pid:
            q = q.filter(StaffEmployee.project_id == pid)
        rows = []
        for emp in q.order_by(StaffEmployee.name.asc()).all():
            basic = float(emp.basic_salary or 0)
            hra = float(emp.hra or 0)
            allowances = hra + float(emp.other_allowances or 0)
            tds = float(emp.tds_monthly or 0)
            net = max(0.0, basic + allowances - tds)
            rows.append({
                "Party Name": emp.name,
                "Designation": emp.designation or "",
                "Phone No.": emp.mobile or "",
                "Bank Name": "",
                "IFSC Code": "",
                "Account No.": "",
                "Shift": "General",
                "OT Hrs": 0,
                "Basic/Payable": _clean(basic),
                "Allowance Amount": _clean(allowances),
                "Late Fine Deduction": _clean(tds),
                "Net Payable (INR)": _clean(net),
            })
        return rows
    except Exception:
        logger.exception("Report 'staff-salary' failed; returning fallback")
        return _REPORT_FAILED


def _rep_lead_status_funnel(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(CRMLead).filter(CRMLead.company_id == cid)
        leads = q.all()
        total_leads = len(leads)
        
        stages = ["New Lead", "Contacted", "Follow-Up", "Proposal Stage", "Negotiation", "Won", "Lost"]
        counts = {s: 0 for s in stages}
        for l in leads:
            st = l.status or "New Lead"
            if st in counts:
                counts[st] += 1
            else:
                counts[st] = counts.get(st, 0) + 1
        
        rows = []
        for stage, count in counts.items():
            pct = round((count / total_leads * 100), 1) if total_leads > 0 else 0.0
            rows.append({
                "Stage": stage,
                "Lead Count": count,
                "Conversion Rate (%)": pct,
            })
        return rows
    except Exception:
        logger.exception("Report 'lead-status-funnel' failed; returning fallback")
        return _REPORT_FAILED


def _rep_company_user_activity_leaderboard(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(CompanyTeam).filter(CompanyTeam.company_id == cid)
        rows = []
        for ct in q.all():
            user_name = _team_user_name(db, ct.id)
            dpr_q = (
                db.query(DailyProgressReport)
                .join(Project, DailyProgressReport.project_id == Project.id)
                .filter(Project.company_id == cid)
            )
            if pid:
                dpr_q = dpr_q.filter(DailyProgressReport.project_id == pid)

            author_matchers = [k for k in [user_name, str(ct.user_id) if ct.user_id else None, str(ct.id) if ct.id else None] if k]
            if author_matchers:
                dpr_q = dpr_q.filter(DailyProgressReport.reported_by.in_(author_matchers))
            else:
                dpr_q = dpr_q.filter(DailyProgressReport.reported_by == user_name)

            dpr_cnt = dpr_q.count()
            todo_q = db.query(Todo).filter(Todo.company_id == cid, Todo.created_by == ct.id)
            if pid:
                todo_q = todo_q.filter(Todo.project_id == pid)
            todo_cnt = todo_q.count()
            total_act = dpr_cnt + todo_cnt
            rows.append({
                "Creator Name": user_name,
                "Role": ct.priority_type or "Member",
                "Activity Count": total_act,
                "Progress Count": dpr_cnt,
                "To Do Count (leaderboard-style": todo_cnt,
                "exact labels partly OCR-garbled)": "",
            })
        return rows
    except Exception:
        logger.exception("Report 'company-user-activity-leaderboard' failed; returning fallback")
        return _REPORT_FAILED


def _rep_project_activity_leaderboard(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(Project).filter(Project.company_id == cid)
        if pid:
            q = q.filter(Project.id == pid)
        rows = []
        for p in q.all():
            dpr_cnt = db.query(DailyProgressReport).filter(DailyProgressReport.project_id == p.id).count()
            todo_cnt = db.query(Todo).filter(Todo.project_id == p.id).count()
            total_act = dpr_cnt + todo_cnt
            rows.append({
                "Project Name": p.name,
                "Progress Count": dpr_cnt,
                "To Do Count": todo_cnt,
                "Activity Count (leaderboard-style": total_act,
                "exact labels partly OCR-garbled)": "",
            })
        return rows
    except Exception:
        logger.exception("Report 'project-activity-leaderboard' failed; returning fallback")
        return _REPORT_FAILED


def _rep_project_operational_summary(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(Project).filter(Project.company_id == cid)
        if pid:
            q = q.filter(Project.id == pid)
        rows = []
        for p in q.all():
            tasks = db.query(Task).filter(Task.project_id == p.id).all()
            avg_prog = (sum(float(t.progress or 0) for t in tasks) / len(tasks)) if tasks else 0.0
            rows.append({
                "Project Name": p.name,
                "Project Category": p.category or "Construction",
                "Project Stage": p.stage or p.status or "Execution",
                "Key Personnel": "",
                "Project Status": p.status or "Active",
                "Project Health": "On Track",
                "Start Date": _clean(p.planned_start_date or p.actual_start_date or p.created_at),
                "End Date": _clean(p.planned_end_date or p.actual_end_date),
                "Progress": _clean(int(avg_prog)),
                "Customer Name": "",
            })
        return rows
    except Exception:
        logger.exception("Report 'project-operational-summary' failed; returning fallback")
        return _REPORT_FAILED


def _rep_company_attendance(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(AttendanceLog).join(StaffEmployee, AttendanceLog.employee_id == StaffEmployee.id).filter(StaffEmployee.company_id == cid)
        if pid:
            q = q.filter(AttendanceLog.project_id == pid)
        rows = []
        for a in q.order_by(AttendanceLog.attendance_date.desc()).all():
            emp = db.query(StaffEmployee).filter(StaffEmployee.id == a.employee_id).first()
            proj = db.query(Project).filter(Project.id == a.project_id).first() if a.project_id else None
            rows.append({
                "Date": _clean(a.attendance_date),
                "Employee Code": emp.employee_code if emp else "",
                "Employee Name": emp.name if emp else "",
                "Designation": emp.designation if emp else "",
                "Department": emp.department if emp else "",
                "Project Name": proj.name if proj else "",
                "Punch In": _clean(a.punch_in),
                "Punch Out": _clean(a.punch_out),
                "Status": a.status,
                "Hours Worked": _clean(a.hours_worked or 8),
                "Overtime Hours": _clean(a.overtime_hours or 0),
                "Geofence Status": "Inside" if a.is_within_geofence else "Outside",
            })
        return rows
    except Exception:
        logger.exception("Report 'company-attendance' failed; returning fallback")
        return _REPORT_FAILED


def _rep_staff_monthly_salary_slip(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(PayrollLineItem).join(PayrollRun, PayrollLineItem.payroll_run_id == PayrollRun.id).filter(PayrollRun.company_id == cid)
        rows = []
        for item in q.order_by(PayrollLineItem.created_at.desc()).all():
            pr = db.query(PayrollRun).filter(PayrollRun.id == item.payroll_run_id).first()
            emp = db.query(StaffEmployee).filter(StaffEmployee.id == item.employee_id).first() if item.employee_id else None
            gross = float(item.gross_salary or 0)
            deductions = float(item.total_deductions or 0)
            net = float(item.net_payable or 0)
            rows.append({
                "Month": pr.payroll_month if pr else "",
                "Employee Code": emp.employee_code if emp else "",
                "Employee Name": emp.name if emp else "",
                "Designation": emp.designation if emp else "",
                "Department": emp.department if emp else "",
                "UAN": emp.uan if emp and hasattr(emp, 'uan') and emp.uan else "",
                "Bank Account No.": "",
                "Days Present": _clean(item.days_present or 0),
                "Basic Pay": _clean(item.basic or 0),
                "HRA": _clean(item.hra or 0),
                "Allowances": _clean(item.other_allowances or 0),
                "Gross Pay": _clean(gross),
                "PF Deduction": _clean(item.pf_employee or 0),
                "ESI Deduction": _clean(item.esi_employee or 0),
                "TDS": _clean(item.tds or 0),
                "Total Deductions": _clean(deductions),
                "Net Pay (INR)": _clean(net),
            })
        return rows
    except Exception:
        logger.exception("Report 'staff-monthly-salary-slip' failed; returning fallback")
        return _REPORT_FAILED


def _rep_staff_muster_roll(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(MusterRoll).filter(MusterRoll.company_id == cid)
        if pid:
            q = q.filter(MusterRoll.project_id == pid)
        rows = []
        for m in q.order_by(MusterRoll.date.desc()).all():
            proj = db.query(Project).filter(Project.id == m.project_id).first() if m.project_id else None
            present = int(m.workers_present or 0)
            absent = int(m.workers_absent or 0)
            rows.append({
                "Date": _clean(m.date),
                "Project Name": proj.name if proj else "",
                "Labor Role / Designation": m.labor_role,
                "Workers Present": present,
                "Workers Absent": absent,
                "Total Workers": present + absent,
                "Hours Worked": _clean(m.hours_worked or 8),
                "Overtime Hours": _clean(m.overtime_hours or 0),
                "Notes": m.notes or "",
            })
        return rows
    except Exception:
        logger.exception("Report 'staff-muster-roll' failed; returning fallback")
        return _REPORT_FAILED


def _rep_staff_punch_report(db: Session, cid: uuid.UUID, pid: Optional[uuid.UUID]):
    try:
        q = db.query(FaceRecognitionLog).filter(FaceRecognitionLog.company_id == cid)
        if pid:
            q = q.filter(FaceRecognitionLog.project_id == pid)
        rows = []
        for f in q.order_by(FaceRecognitionLog.created_at.desc()).all():
            emp = db.query(StaffEmployee).filter(StaffEmployee.id == f.employee_id).first() if f.employee_id else None
            proj = db.query(Project).filter(Project.id == f.project_id).first() if f.project_id else None
            rows.append({
                "Punch Time": _clean(f.created_at),
                "Employee Code": emp.employee_code if emp else "",
                "Employee Name": emp.name if emp else "",
                "Project Name": proj.name if proj else "",
                "Punch Type": f.punch_type,
                "Face Verified": "Yes" if f.face_verified else "No",
                "Confidence Score": _clean(f.confidence_score or 0),
                "Geofence Status": "Inside" if f.is_within_geofence else "Outside",
                "Latitude": _clean(f.lat or 0),
                "Longitude": _clean(f.lng or 0),
            })
        return rows
    except Exception:
        logger.exception("Report 'staff-punch-report' failed; returning fallback")
        return _REPORT_FAILED


_REPORT_HANDLERS = {
    "all-expense-deduction-retention": _rep_all_expense_deduction_retention,
    "all-party-balances": _rep_all_party_balances,
    "asset-allocation": _rep_asset_allocation,
    "asset-status": _rep_asset_status,
    "attendance-salary": _rep_attendance_salary,
    "bank-statement": _rep_bank_statement,
    "boq-bom": _rep_boq_bom,
    "boq-item": _rep_boq_item,
    "boq-measurement-book": _rep_boq_measurement_book,
    "boq-workorder-summary": _rep_boq_workorder_summary,
    "budget-vs-actual-cost-code": _rep_budget_vs_actual_cost_code,
    "budget-vs-actual-material-cost": _rep_budget_vs_actual_material_cost,
    "budget-vs-actual-material-qty": _rep_budget_vs_actual_material_qty,
    "company-attendance": _rep_company_attendance,
    "company-expense": _rep_company_expense,
    "company-payments": _rep_company_payments,
    "company-sales": _rep_company_sales,
    "company-transactions": _rep_company_transactions,
    "company-user-activity-leaderboard": _rep_company_user_activity_leaderboard,
    "cost-code-expense-analysis": _rep_cost_code_expense_analysis,
    "cost-code-library": _rep_cost_code_library,
    "crm-lead-detail": _rep_crm_lead_detail,
    "daily-based-equipment-used": _rep_daily_based_equipment_used,
    "dpr": _rep_dpr,
    "equipment-expense-summary": _rep_equipment_expense_summary,
    "equipment-library": _rep_equipment_library,
    "equipment-trip": _rep_equipment_trip,
    "equipment-usage-detail": _rep_equipment_usage_detail,
    "fuel-efficiency": _rep_fuel_efficiency,
    "gstr1-sales": _rep_gstr1_sales,
    "gstr2-purchase": _rep_gstr2_purchase,
    "item-wise-sales": _rep_item_wise_sales,
    "lead-status-funnel": _rep_lead_status_funnel,
    "material-library": _rep_material_library,
    "material-purchase-item": _rep_material_purchase_item,
    "material-received-used": _rep_material_received_used,
    "material-received-without-po": _rep_material_received_without_po,
    "material-request-item": _rep_material_request_item,
    "material-stock": _rep_material_stock,
    "material-stock-movement": _rep_material_stock_movement,
    "monthly-pl": _rep_monthly_pl,
    "ot-shift": _rep_ot_shift,
    "party-ledger": _rep_party_ledger,
    "party-library": _rep_party_library,
    "payment-request": _rep_payment_request,
    "payroll-library": _rep_payroll_library,
    "po-summary": _rep_po_summary,
    "production-material": _rep_production_material,
    "project-activity-leaderboard": _rep_project_activity_leaderboard,
    "project-financial-summary": _rep_project_financial_summary,
    "project-level-party-balance": _rep_project_level_party_balance,
    "project-operational-summary": _rep_project_operational_summary,
    "project-payment": _rep_project_payment,
    "project-wise-expense-summary": _rep_project_wise_expense_summary,
    "project-wise-payment-summary": _rep_project_wise_payment_summary,
    "project-wise-sales-summary": _rep_project_wise_sales_summary,
    "purchase-order-item": _rep_po_item,
    "quotation": _rep_quotation,
    "quotation-item": _rep_quotation_item,
    "rate-card-library": _rep_rate_card_library,
    "sales-deduction-retention": _rep_sales_deduction_retention,
    "site-inspection": _rep_site_inspection,
    "staff-monthly-salary-slip": _rep_staff_monthly_salary_slip,
    "staff-muster-roll": _rep_staff_muster_roll,
    "staff-punch-report": _rep_staff_punch_report,
    "staff-salary": _rep_staff_salary,
    "subcon-deduction-retention": _rep_subcon_deduction_retention,
    "subcon-material-issue": _rep_subcon_material_issue,
    "subcon-measurement-book": _rep_subcon_measurement_book,
    "subcon-workorder-summary": _rep_subcon_workorder_summary,
    "task-attendance": _rep_task_attendance,
    "task-boq-billed-unbilled": _rep_task_boq_billed_unbilled,
    "task-material": _rep_task_material,
    "task-measurement-book": _rep_task_measurement_book,
    "task-report": _rep_task_report,
    "task-resource-budget-vs-actual": _rep_task_resource_budget_vs_actual,
    "task-revenue-expense": _rep_task_revenue_expense,
    "todo-report": _rep_todo_report,
    "unbilled-item": _rep_unbilled_item,
    "warehouse-current-stock": _rep_warehouse_current_stock,
    "warehouse-stock-movement": _rep_warehouse_stock_movement,
    "warehouse-transaction": _rep_warehouse_transaction,
}


@router.get("/data/{slug}", response_model=ReportDataResponse)
def get_report_data(
    slug: str,
    company_id: str,
    project_id: Optional[str] = None,
    month: Optional[str] = Query(None, pattern=r"^\d{4}-\d{2}$", description="YYYY-MM; keep rows dated in that month"),
    name: Optional[str] = Query(None, max_length=120, description="Keep rows whose name columns contain this text"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    generated_at = datetime.utcnow().isoformat()
    # R2-324: a malformed id used to return 200 {"rows": []}, making a typo'd
    # company indistinguishable from an empty one. Fail 422 naming the bad
    # parameter instead.
    try:
        cid = uuid.UUID(company_id)
    except (TypeError, ValueError, AttributeError):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid company_id: must be a valid UUID.",
        )
    pid = None
    if project_id:
        try:
            pid = uuid.UUID(project_id)
        except (TypeError, ValueError, AttributeError):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Invalid project_id: must be a valid UUID.",
            )

    get_company_membership(db, current_user, cid)
    if pid is not None:
        project = db.query(Project).filter(Project.id == pid).first()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        get_company_membership(db, current_user, project.company_id)

    errors: List[str] = []
    rows: List[dict] = []
    handler = _REPORT_HANDLERS.get(slug)
    if handler is None:
        # R2-075: a slug with no registered handler means the report was
        # never implemented, not that it produced no data. Fail loudly so
        # an unimplemented report can never masquerade as an empty one.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Report '{slug}' is not implemented.",
        )
    try:
        built = handler(db, cid, pid) or []
    except Exception:
        logger.exception("Report '%s' failed to generate; returning empty fallback", slug)
        built = _REPORT_FAILED
    if built is _REPORT_FAILED or isinstance(built, _ReportFailed):
        # A guarded handler already logged its traceback and fell back;
        # surface the failure to the caller instead of publishing an
        # empty report as data (R2-076/R2-312/R2-560).
        rows = []
        errors.append(f"Report '{slug}' failed to generate; an empty result was returned instead.")
    else:
        rows = built
    period_applied = None
    if month and rows:
        key = _period_key(rows)
        period_applied = key is not None
        if key is not None:
            rows = [r for r in rows if str(r.get(key) or "").startswith(month)]
    if name and name.strip():
        needle = name.strip().lower()
        rows = [
            r for r in rows
            if any("name" in k.lower() and needle in str(v or "").lower() for k, v in r.items())
        ]
    return {"slug": slug, "rows": rows, "generated_at": generated_at, "errors": errors,
            "period_applied": period_applied}
