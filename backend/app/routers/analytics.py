"""
Phase 14 - Advanced Analytics Dashboard Router

Aggregates executive KPIs across budgeting, planning, billing, procurement,
labour, and quality modules for a company-wide dashboard.
"""

import calendar
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import Date, cast, func
from sqlalchemy.orm import Session

from app.database import get_db
from app.auth import get_current_user, verify_company_access
from app.constants import (
    EXPENSE_INVOICE_TYPES,
    REVENUE_INVOICE_TYPES,
    SETTLEMENT_INVOICE_TYPES,
    classify_invoice_type,
    is_expense_invoice_type,
    is_revenue_invoice_type,
    is_settlement_money_in,
    is_settlement_money_out,
)
from app.models import (
    AttendanceLog,
    Bill,
    BOQItem,
    Company,
    CompanyTeam,
    LibraryParty,
    NCR,
    Payment,
    Project,
    ProjectBudget,
    ProjectParty,
    PurchaseOrder,
    PurchaseOrderItem,
    MaterialTransaction,
    MaterialWastage,
    Task,
    User,
    WorkOrder,
)

from app.routers.projects import _project_progress

router = APIRouter(prefix="/analytics", tags=["Analytics & Executive Dashboard"], dependencies=[Depends(get_current_user)])

AREA_UNITS = {
    "m2",
    "m²",
    "sqm",
    "sq.m",
    "sq m",
    "square meter",
    "square metres",
    "square meters",
}

COMPLETED_TASK_STATUSES = {
    "completed",
    "done",
    "closed",
    "finished",
}


def _task_is_completed(task) -> bool:
    if (task.status or "").lower() in COMPLETED_TASK_STATUSES:
        return True
    return float(task.progress or 0) >= 100


def _to_float(value) -> float:
    if value is None:
        return 0.0
    return float(value)


def _to_date(value) -> Optional[date]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return None


def _month_start(dt: datetime) -> datetime:
    return datetime(dt.year, dt.month, 1, tzinfo=dt.tzinfo)


def _next_month(dt: datetime) -> datetime:
    if dt.month == 12:
        return datetime(dt.year + 1, 1, 1, tzinfo=dt.tzinfo)
    return datetime(dt.year, dt.month + 1, 1, tzinfo=dt.tzinfo)


def _month_label(dt: datetime) -> str:
    return dt.strftime("%b %Y")


def _month_range(start: datetime, end: datetime) -> List[datetime]:
    if end < start:
        return [start]

    cursor = _month_start(start)
    months: List[datetime] = []
    while cursor <= end:
        months.append(cursor)
        cursor = _next_month(cursor)
    return months


def _resolve_team_name(db: Session, team: CompanyTeam, users_by_id: Dict[uuid.UUID, User]) -> str:
    if team.user_id and team.user_id in users_by_id and users_by_id[team.user_id].name:
        return users_by_id[team.user_id].name
    if team.library_party_id:
        party = db.query(LibraryParty).filter(LibraryParty.id == team.library_party_id).first()
        if party and party.name:
            return party.name
    return f"Team {str(team.id)[:8]}"


@router.get("/company/{company_id}")
def get_company_analytics(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    company = db.query(Company).filter(Company.id == company_id).first()
    if not company:
        raise HTTPException(status_code=404, detail="Company not found")

    projects = (
        db.query(Project)
        .filter(Project.company_id == company_id)
        .order_by(Project.created_at.asc())
        .all()
    )
    project_ids = [p.id for p in projects]

    budgets = (
        db.query(ProjectBudget)
        .filter(ProjectBudget.project_id.in_(project_ids))
        .all()
        if project_ids
        else []
    )
    tasks = (
        db.query(Task)
        .filter(Task.project_id.in_(project_ids))
        .all()
        if project_ids
        else []
    )
    boq_items = (
        db.query(BOQItem)
        .filter(BOQItem.project_id.in_(project_ids))
        .all()
        if project_ids
        else []
    )
    bills = (
        db.query(Bill)
        .filter(Bill.project_id.in_(project_ids))
        .all()
        if project_ids
        else []
    )
    purchase_orders = (
        db.query(PurchaseOrder)
        .filter(PurchaseOrder.project_id.in_(project_ids))
        .all()
        if project_ids
        else []
    )
    purchase_order_items = []
    if purchase_orders:
        po_ids = [po.id for po in purchase_orders]
        purchase_order_items = db.query(PurchaseOrderItem).filter(PurchaseOrderItem.po_id.in_(po_ids)).all()
    material_transactions = (
        db.query(MaterialTransaction)
        .filter(MaterialTransaction.project_id.in_(project_ids), MaterialTransaction.type == "used")
        .all()
        if project_ids
        else []
    )
    attendance_logs = (
        db.query(AttendanceLog)
        .filter(AttendanceLog.project_id.in_(project_ids))
        .all()
        if project_ids
        else []
    )
    ncrs = (
        db.query(NCR)
        .filter(NCR.project_id.in_(project_ids))
        .all()
        if project_ids
        else []
    )
    work_orders = (
        db.query(WorkOrder)
        .filter(WorkOrder.project_id.in_(project_ids))
        .all()
        if project_ids
        else []
    )
    teams = db.query(CompanyTeam).filter(CompanyTeam.company_id == company_id).all()
    user_ids = [team.user_id for team in teams if team.user_id]
    users = db.query(User).filter(User.id.in_(user_ids)).all() if user_ids else []
    users_by_id = {user.id: user for user in users}

    budget_by_project = {budget.project_id: budget for budget in budgets}
    tasks_by_project = defaultdict(list)
    boq_by_id = {boq.id: boq for boq in boq_items}
    for task in tasks:
        tasks_by_project[task.project_id].append(task)

    bills_by_project = defaultdict(list)
    for bill in bills:
        bills_by_project[bill.project_id].append(bill)

    work_orders_by_subcontractor = defaultdict(list)
    projects_by_subcontractor = defaultdict(set)
    for work_order in work_orders:
        work_orders_by_subcontractor[work_order.subcontractor_id].append(work_order)
        projects_by_subcontractor[work_order.subcontractor_id].add(work_order.project_id)

    total_budget = 0.0
    total_spend = 0.0
    project_summary = []
    for project in projects:
        budget = budget_by_project.get(project.id)
        project_budget_total = 0.0
        if budget:
            project_budget_total = (
                _to_float(budget.material_budget)
                + _to_float(budget.labour_budget)
                + _to_float(budget.subcon_budget)
                + _to_float(budget.equipment_budget)
            )

        project_spend = sum(_to_float(bill.total_payable) for bill in bills_by_project.get(project.id, []) if is_expense_invoice_type(bill.invoice_type) and bill.status != "Cancelled")
        project_variance = project_budget_total - project_spend
        total_tasks = len(tasks_by_project.get(project.id, []))
        completed_tasks = sum(
            1
            for task in tasks_by_project.get(project.id, [])
            if _task_is_completed(task)
        )
        completion_pct = round((completed_tasks / total_tasks) * 100, 1) if total_tasks else 0.0

        total_budget += project_budget_total
        total_spend += project_spend

        project_summary.append(
            {
                "project_id": str(project.id),
                "project_name": project.name,
                "code": project.code,
                "budget": round(project_budget_total, 2),
                "spend": round(project_spend, 2),
                "variance": round(project_variance, 2),
                "completion_pct": completion_pct,
                "task_count": total_tasks,
                "completed_tasks": completed_tasks,
                "health": project.health or "Good",
                "category": project.category,
                "stage": project.stage,
                "key_personnel_id": str(project.key_personnel_id) if project.key_personnel_id else None
            }
        )

    total_tasks = len(tasks)
    completed_tasks = sum(
        1 for task in tasks if _task_is_completed(task)
    )
    burn_rate_pct = round((total_spend / total_budget) * 100, 2) if total_budget else None
    budget_variance = round(total_budget - total_spend, 2)

    date_candidates = []
    for collection in (tasks, bills, attendance_logs, purchase_orders):
        for item in collection:
            for attr in ("start_date", "end_date", "invoice_date", "due_date", "attendance_date", "po_date", "created_at"):
                value = getattr(item, attr, None)
                d = _to_date(value)
                if d:
                    date_candidates.append(d)

    if date_candidates:
        start_date = datetime.combine(min(date_candidates), datetime.min.time())
        end_date = datetime.combine(max(date_candidates), datetime.max.time())
    else:
        start_date = datetime.utcnow()
        end_date = start_date

    s_curve = []
    monthly_burn = []
    month_starts = _month_range(start_date, end_date)
    cumulative_spend = 0.0
    for month in month_starts:
        month_end = _next_month(month) - timedelta(seconds=1)
        month_end_d = month_end.date()
        planned = sum(1 for task in tasks if task.end_date and _to_date(task.end_date) and _to_date(task.end_date) <= month_end_d)
        actual = sum(
            1
            for task in tasks
            if task.end_date
            and _to_date(task.end_date)
            and _to_date(task.end_date) <= month_end_d
            and _task_is_completed(task)
        )
        # R2-303/R2-497: the old filter counted every bill up to month end, so
        # month_spend was already cumulative and adding it into cumulative_spend
        # multiplied spend by the number of months elapsed. Each month
        # contributes only the bills dated inside it.
        month_start_d = month.date()
        month_spend = sum(
            _to_float(bill.total_payable)
            for bill in bills
            if is_expense_invoice_type(bill.invoice_type)
            and bill.status != "Cancelled"
            and bill.invoice_date
            and _to_date(bill.invoice_date)
            and month_start_d <= _to_date(bill.invoice_date) <= month_end_d
        )
        cumulative_spend += month_spend
        s_curve.append(
            {
                "label": _month_label(month),
                "planned_pct": round((planned / total_tasks) * 100, 1) if total_tasks else 0.0,
                "actual_pct": round((actual / total_tasks) * 100, 1) if total_tasks else 0.0,
            }
        )
        monthly_burn.append(
            {
                "label": _month_label(month),
                "burn_pct": round((cumulative_spend / total_budget) * 100, 1) if total_budget else 0.0,
                "spend": round(cumulative_spend, 2),
            }
        )

    # R2-304: a log with no hours_worked is an open punch-in (punch-out is
    # broken upstream, R2-262), not a completed eight-hour day. Fabricating 8.0
    # for it invented labour nobody worked; sum only recorded hours and expose
    # the count of hourless logs so the data gap stays visible.
    total_hours = 0.0
    logs_without_hours = 0
    for log in attendance_logs:
        if log.hours_worked is not None:
            total_hours += _to_float(log.hours_worked)
        else:
            logs_without_hours += 1

    labour_days = round(total_hours / 8.0, 2) if attendance_logs and total_hours else None
    completed_area = 0.0
    for task in tasks:
        if _task_is_completed(task) and task.boq_item_id:
            boq = boq_by_id.get(task.boq_item_id)
            if boq and (boq.unit or "").strip().lower() in AREA_UNITS:
                completed_area += _to_float(boq.quantity)
    labour_productivity = round(completed_area / labour_days, 2) if labour_days else None

    ordered_qty = sum(_to_float(item.quantity) for item in purchase_order_items)
    consumed_qty = sum(_to_float(tx.qty) for tx in material_transactions)
    has_consumption = len(material_transactions) > 0

    # Wastage is what the MaterialWastage log records (scrap/damage/theft).
    # Ordered-minus-consumed is inventory still on site, not waste; it is kept
    # as a stock reconciliation and never clamped, so over-consumption stays
    # visible as a negative variance.
    wastage_records = (
        db.query(MaterialWastage)
        .filter(MaterialWastage.project_id.in_(project_ids))
        .all()
        if project_ids
        else []
    )
    recorded_wastage_qty = sum(_to_float(record.quantity) for record in wastage_records)
    has_wastage_records = len(wastage_records) > 0
    wastage_qty = recorded_wastage_qty
    stock_variance_qty = ordered_qty - consumed_qty
    wastage_pct = (
        round((recorded_wastage_qty / ordered_qty) * 100, 2)
        if has_wastage_records and has_consumption and ordered_qty
        else None
    )

    # Stock reconciliation per material and per unit: summing bags, tonnes and
    # cft into one scalar makes the comparison meaningless, so each material
    # line is compared in its own unit.
    ordered_by_material = defaultdict(float)
    for item in purchase_order_items:
        ordered_by_material[(item.material_name, (item.unit or "").strip().lower())] += _to_float(item.quantity)
    consumed_by_material = defaultdict(float)
    for tx in material_transactions:
        consumed_by_material[(tx.material_name, (tx.unit or "").strip().lower())] += _to_float(tx.qty)
    material_reconciliation = []
    for material, unit in sorted(set(ordered_by_material) | set(consumed_by_material)):
        ordered_m = ordered_by_material.get((material, unit), 0.0)
        consumed_m = consumed_by_material.get((material, unit), 0.0)
        material_reconciliation.append(
            {
                "material_name": material,
                "unit": unit,
                "ordered_qty": round(ordered_m, 2),
                "consumed_qty": round(consumed_m, 2),
                "variance_qty": round(ordered_m - consumed_m, 2),
                "over_consumed": consumed_m > ordered_m,
            }
        )

    subcontractor_scorecard = []
    for subcontractor_id, orders in work_orders_by_subcontractor.items():
        company_team = next((team for team in teams if team.id == subcontractor_id), None)
        bills_for_subcontractor = [
            bill
            for bill in bills
            if bill.invoice_type == "subcon" and bill.party_company_user_id == subcontractor_id
        ]
        # On-time definition: only PAID bills WITH a real due_date count toward
        # the metric. A bill is on-time when its last-modified (settled) time is
        # on/before the due date. Unpaid/partially-paid bills and bills without a
        # due_date are excluded from the denominator (can't judge on-time-ness).
        in_scope_bills = [
            bill
            for bill in bills_for_subcontractor
            if (bill.status or "").lower() == "paid" and bill.due_date is not None
        ]
        on_time_bills = sum(
            1
            for bill in in_scope_bills
            if bill.updated_at is not None and _to_date(bill.updated_at) and _to_date(bill.due_date) and _to_date(bill.updated_at) <= _to_date(bill.due_date)
        )
        linked_projects = projects_by_subcontractor.get(subcontractor_id, set())
        ncr_count = sum(1 for ncr in ncrs if ncr.project_id in linked_projects)
        subcontractor_scorecard.append(
            {
                "subcontractor_id": str(subcontractor_id),
                "subcontractor_name": _resolve_team_name(db, company_team, users_by_id) if company_team else str(subcontractor_id),
                "project_names": [
                    project.name
                    for project in projects
                    if project.id in linked_projects
                ],
                "bill_count": len(bills_for_subcontractor),
                "on_time_rate": round((on_time_bills / len(in_scope_bills)) * 100, 1) if in_scope_bills else 0.0,
                "ncr_count": ncr_count,
                "late_bills": max(len(in_scope_bills) - on_time_bills, 0),
            }
        )

    subcontractor_scorecard.sort(key=lambda row: (-row["on_time_rate"], row["ncr_count"], row["subcontractor_name"]))

    return {
        "company_id": str(company.id),
        "company_name": company.name,
        "project_count": len(projects),
        "total_tasks": total_tasks,
        "completed_tasks": completed_tasks,
        "task_completion_pct": round((completed_tasks / total_tasks) * 100, 1) if total_tasks else 0.0,
        "total_budget": round(total_budget, 2),
        "total_spend": round(total_spend, 2),
        "budget_variance": budget_variance,
        "burn_rate_pct": burn_rate_pct,
        "s_curve": s_curve,
        "budget_burn_series": monthly_burn,
        "labour_productivity": {
            "total_hours": round(total_hours, 2) if attendance_logs else None,
            "logs_without_hours": logs_without_hours,
            "labour_days": labour_days,
            "completed_area_m2": round(completed_area, 2),
            "productivity_m2_per_labour_day": labour_productivity,
        },
        "material_wastage": {
            "ordered_qty": round(ordered_qty, 2),
            "consumed_qty": round(consumed_qty, 2),
            "stock_variance_qty": round(stock_variance_qty, 2),
            "wastage_qty": round(wastage_qty, 2),
            "wastage_pct": wastage_pct,
        },
        "material_reconciliation": material_reconciliation,
        "projects": project_summary,
        "subcontractor_scorecard": subcontractor_scorecard,
    }


@router.get("/company/{company_id}/operational")
def get_company_operational_analytics(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    company = db.query(Company).filter(Company.id == company_id).first()
    if not company:
        raise HTTPException(status_code=404, detail="Company not found")

    projects = db.query(Project).filter(Project.company_id == company_id).all()
    project_ids = [p.id for p in projects]

    # Calculate Project Health and Progress
    project_summary = []
    health_counts = {"Healthy": 0, "Warning": 0, "Critical": 0, "Onhold": 0, "Completed": 0}
    status_counts = {"Not Started": 0, "Ongoing": 0, "On Hold": 0, "Cancelled": 0, "Planning": 0, "Completed": 0, "Other": 0}

    # The customer is the Client party linked to the project; key personnel is
    # the company_team member named on it. Projects carry neither as text.
    client_names: Dict[uuid.UUID, str] = {}
    if project_ids:
        for pid, pname in (
            db.query(ProjectParty.project_id, LibraryParty.name)
            .join(LibraryParty, LibraryParty.id == ProjectParty.party_id)
            .filter(ProjectParty.project_id.in_(project_ids), func.lower(LibraryParty.party_type).in_(("client", "customer")))
            .order_by(ProjectParty.created_at)
            .all()
        ):
            client_names.setdefault(pid, pname)
    personnel_ids = {p.key_personnel_id for p in projects if p.key_personnel_id}
    personnel_names: Dict[uuid.UUID, str] = {}
    if personnel_ids:
        for tid, uname, lpname in (
            db.query(CompanyTeam.id, User.name, LibraryParty.name)
            .outerjoin(User, User.id == CompanyTeam.user_id)
            .outerjoin(LibraryParty, LibraryParty.id == CompanyTeam.library_party_id)
            .filter(CompanyTeam.id.in_(personnel_ids), CompanyTeam.company_id == company_id)
            .all()
        ):
            if uname or lpname:
                personnel_names[tid] = uname or lpname

    for p in projects:
        # Determine status
        p_status = p.status or "—"
        count_status = "On Hold" if p_status == "Onhold" else p_status
        if count_status in status_counts:
            status_counts[count_status] += 1
        else:
            status_counts["Other"] += 1

        # Budget vs Spend
        budget = db.query(ProjectBudget).filter(ProjectBudget.project_id == p.id).first()
        budget_total = 0.0
        if budget:
            budget_total = (
                _to_float(budget.material_budget)
                + _to_float(budget.labour_budget)
                + _to_float(budget.subcon_budget)
                + _to_float(budget.equipment_budget)
            )
        spend = sum(_to_float(b.total_payable) for b in db.query(Bill).filter(Bill.project_id == p.id, Bill.invoice_type.in_(EXPENSE_INVOICE_TYPES), Bill.status != "Cancelled").all())

        # Determine Health
        if p_status == "Completed":
            health = "Completed"
        elif count_status == "On Hold":
            health = "Onhold"
        elif p_status == "Cancelled":
            health = "Cancelled"
        elif spend > budget_total and budget_total > 0:
            health = "Critical"
        elif spend > 0.9 * budget_total and budget_total > 0:
            health = "Warning"
        else:
            health = "Healthy"
        
        if health in health_counts:
            health_counts[health] += 1

        # Same duration-weighted progress the project page shows; counting
        # completed tasks gave a different figure for the same project.
        progress_pct = _project_progress(db, p.id)

        s_val = getattr(p, "actual_start_date", None) or getattr(p, "planned_start_date", None) or getattr(p, "created_at", None)
        e_val = getattr(p, "actual_end_date", None) or getattr(p, "planned_end_date", None)
        s_dt = _to_date(s_val)
        e_dt = _to_date(e_val)

        project_summary.append({
            "project_id": str(p.id),
            "project_name": p.name,
            "code": p.code or "—",
            "status": p_status,
            "health": health,
            "start_date": s_dt.strftime("%Y-%m-%d") if s_dt else "—",
            "end_date": e_dt.strftime("%Y-%m-%d") if e_dt else "—",
            "progress": progress_pct,
            "customer_name": client_names.get(p.id, "—"),
            "key_personnel": personnel_names.get(p.key_personnel_id, "Unassigned")
        })

    # Last 7 Days Attendance Sparkline
    attendance_series = []
    # Last 7 Days Material Received Sparkline
    material_series = []
    
    today = datetime.utcnow().date()
    for i in range(6, -1, -1):
        target_date = today - timedelta(days=i)
        date_str = target_date.strftime("%Y-%m-%d")
        t_start = datetime.combine(target_date, datetime.min.time())
        t_end = t_start + timedelta(days=1)
        
        # Attendance counts
        att_logs = db.query(AttendanceLog).filter(
            AttendanceLog.project_id.in_(project_ids),
            AttendanceLog.attendance_date >= t_start,
            AttendanceLog.attendance_date < t_end
        ).all() if project_ids else []
        
        present = sum(1 for log in att_logs if log.status in ("Present", "Present (Off-Site)"))
        absent = sum(1 for log in att_logs if log.status == "Absent")
        
        attendance_series.append({
            "date": date_str,
            "present": present,
            "absent": absent
        })

        # Material receipt logs count
        mat_txs = db.query(MaterialTransaction).filter(
            MaterialTransaction.project_id.in_(project_ids),
            MaterialTransaction.created_at >= t_start,
            MaterialTransaction.created_at < t_end,
            MaterialTransaction.type == "received"
        ).count() if project_ids else 0
        
        material_series.append({
            "date": date_str,
            "count": mat_txs
        })

    return {
        "company_id": str(company_id),
        "health_counts": health_counts,
        "status_counts": status_counts,
        "attendance_series": attendance_series,
        "material_series": material_series,
        "projects": project_summary
    }


@router.get("/company/{company_id}/financial")
def get_company_financial_analytics(company_id: uuid.UUID, db: Session = Depends(get_db), _: None = Depends(verify_company_access)):
    company = db.query(Company).filter(Company.id == company_id).first()
    if not company:
        raise HTTPException(status_code=404, detail="Company not found")

    projects = db.query(Project).filter(Project.company_id == company_id).all()
    project_ids = [p.id for p in projects]

    bills = db.query(Bill).filter(Bill.project_id.in_(project_ids), Bill.status != "Cancelled").all() if project_ids else []

    to_pay = 0.0
    to_receive = 0.0
    advance_paid = 0.0
    advance_received = 0.0

    for b in bills:
        val = _to_float(b.total_payable) - _to_float(b.paid_amount)
        if is_revenue_invoice_type(b.invoice_type):
            to_receive += max(0.0, val)
        elif is_expense_invoice_type(b.invoice_type):
            to_pay += max(0.0, val)
        # settlement and movement bills do not contribute to payable/receivable
        # totals - they are cash movements, not accruals (D3)

    # An advance is money that moved to or from a party ahead of any bill it
    # could settle against: the unsettled balance the FIFO engine in
    # finance.create_payment leaves on a party payment. This used to count
    # "Paid" bills with a total of zero, which can never carry a paid amount,
    # so both cards read empty for every company. Payments with no party are
    # direct expenses or receipts, not advances, and stay out.
    unsettled = (
        db.query(Payment.payment_type, func.coalesce(func.sum(Payment.unsettled_amount), 0))
        .join(CompanyTeam, CompanyTeam.id == Payment.party_company_user_id)
        .filter(
            Payment.company_id == company_id,
            # Party Library parties only: P2P cash transfers between team
            # members are Payment rows too, and are not advances.
            CompanyTeam.library_party_id.isnot(None),
            Payment.unsettled_amount > 0,
        )
        .group_by(Payment.payment_type)
        .all()
    )
    for ptype, amt in unsettled:
        if ptype == "in":
            advance_received += _to_float(amt)
        elif ptype == "out":
            advance_paid += _to_float(amt)

    project_summaries = []
    monthly_sales = defaultdict(float)
    monthly_expense = defaultdict(float)
    expense_by_type = defaultdict(float)
    party_balances = defaultdict(float)

    for p in projects:
        p_status = p.status or "—"
        budget = db.query(ProjectBudget).filter(ProjectBudget.project_id == p.id).first()
        budget_total = 0.0
        if budget:
            budget_total = (
                _to_float(budget.material_budget)
                + _to_float(budget.labour_budget)
                + _to_float(budget.subcon_budget)
                + _to_float(budget.equipment_budget)
            )

        p_bills = [b for b in bills if b.project_id == p.id]
        total_expense = sum(_to_float(b.total_payable) for b in p_bills if is_expense_invoice_type(b.invoice_type))
        total_sales = sum(_to_float(b.total_payable) for b in p_bills if is_revenue_invoice_type(b.invoice_type))
        # D3: settlement money direction is explicit - payment_in / i_received are
        # cash in, payment_out / i_paid are cash out. Do not mix all settlement
        # types into both sides.
        payment_in = sum(_to_float(b.paid_amount) for b in p_bills if is_revenue_invoice_type(b.invoice_type) or is_settlement_money_in(b.invoice_type))
        payment_out = sum(_to_float(b.paid_amount) for b in p_bills if is_expense_invoice_type(b.invoice_type) or is_settlement_money_out(b.invoice_type))

        if p_status == "Completed":
            health = "Completed"
        elif p_status in ("Onhold", "On Hold"):
            health = "Onhold"
        elif p_status == "Cancelled":
            health = "Cancelled"
        elif total_expense > budget_total and budget_total > 0:
            health = "Critical"
        elif total_expense > 0.9 * budget_total and budget_total > 0:
            health = "Warning"
        else:
            health = "Healthy"

        project_summaries.append({
            "project_id": str(p.id),
            "project_name": p.name,
            "project_status": p_status,
            "project_health": health,
            "project_budget": round(budget_total, 2),
            "total_expense": round(total_expense, 2),
            "budget_remaining": round(budget_total - total_expense, 2),
            "total_sales": round(total_sales, 2),
            "project_margin": round(total_sales - total_expense, 2),
            "payment_in": round(payment_in, 2),
            "payment_out": round(payment_out, 2),
            "cash_balance": round(payment_in - payment_out, 2),
        })

    for b in bills:
        m_label = b.invoice_date.strftime("%b %Y") if b.invoice_date else "Jan 2026"
        if is_revenue_invoice_type(b.invoice_type):
            monthly_sales[m_label] += _to_float(b.total_payable)
        elif is_expense_invoice_type(b.invoice_type):
            monthly_expense[m_label] += _to_float(b.total_payable)
            t_label = "Subcontractor Bill" if b.invoice_type == "subcon" else "Purchase Invoice"
            expense_by_type[t_label] += _to_float(b.total_payable)
        # settlement and movement do not book revenue or cost (D3)

        # D3: party outstanding is only revenue/expense accruals; settlement
        # cash movements are not payables or receivables.
        if is_revenue_invoice_type(b.invoice_type) or is_expense_invoice_type(b.invoice_type):
            party_balances[str(b.party_company_user_id)] += (_to_float(b.total_payable) - _to_float(b.paid_amount))

    # R2-603: a company with no bills gets an honestly empty chart; the
    # fabricated demo months/points ("Jun 2026" + 1000 expense) are gone.
    chart_months = sorted(list(set(list(monthly_sales.keys()) + list(monthly_expense.keys()))), key=lambda x: datetime.strptime(x, "%b %Y") if x else datetime.now())

    sales_series = [monthly_sales[m] for m in chart_months]
    expense_series = [monthly_expense[m] for m in chart_months]
    margin_series = [monthly_sales[m] - monthly_expense[m] for m in chart_months]

    party_list = []
    for pid, bal in party_balances.items():
        if bal != 0.0:
            party_list.append({
                "party_id": pid,
                "party_name": "Vendor Party" if bal > 0 else "Client Party",
                "balance": round(bal, 2)
            })

    return {
        "advance_paid": round(advance_paid, 2),
        "to_pay": round(to_pay, 2),
        "to_receive": round(to_receive, 2),
        "advance_received": round(advance_received, 2),
        "chart_months": chart_months,
        "sales_series": sales_series,
        "expense_series": expense_series,
        "margin_series": margin_series,
        "expense_by_type": [
            {"name": k, "value": round(v, 2)} for k, v in expense_by_type.items()
        ],
        "party_balances": party_list[:5],
        "project_summaries": project_summaries,
    }
