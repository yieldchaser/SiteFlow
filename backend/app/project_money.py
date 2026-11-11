"""One project's revenue and cost, the way the Profit & Loss sheet counts them.

The dashboard's project table used to count bills only. Salaries, owned
equipment and fuel never reached it, so a head office (mostly salaries)
looked almost free and every site looked more profitable than its P&L.
Every money view now reads the same heads from here.

Bills count at their work value (subtotal): before GST, which is reclaimed
as input credit, and before TDS and retention, which are still cost.
"""
from sqlalchemy import func

from app import payroll_scope
from app.constants import REVENUE_INVOICE_TYPES
from app.equipment_cost import owned_deployment_cost
from app.models import Bill, FuelLog, MaterialWastage, PayrollLineItem, PayrollRun


def _bill_sum(db, project_id, types) -> float:
    return float(
        db.query(func.sum(Bill.subtotal))
        .filter(Bill.project_id == project_id, Bill.invoice_type.in_(types), Bill.status != "Cancelled")
        .scalar()
        or 0.0
    )


def project_money(db, project_id) -> dict:
    revenue = _bill_sum(db, project_id, REVENUE_INVOICE_TYPES)
    material = _bill_sum(db, project_id, ("purchase",)) + float(
        db.query(func.sum(MaterialWastage.estimated_value)).filter(MaterialWastage.project_id == project_id).scalar()
        or 0.0
    )
    # Cost to the company: gross pay plus employer PF and ESI, finalized runs only.
    labour = float(
        payroll_scope.for_project(
            db.query(func.sum(PayrollLineItem.gross_salary + PayrollLineItem.pf_employer + PayrollLineItem.esi_employer))
            .join(PayrollRun)
            .filter(PayrollRun.status == "finalized"),
            project_id,
        ).scalar()
        or 0.0
    )
    subcon = _bill_sum(db, project_id, ("subcon",))
    fuel = float(db.query(func.sum(FuelLog.total_cost)).filter(FuelLog.project_id == project_id).scalar() or 0.0)
    equipment = round(_bill_sum(db, project_id, ("equipment",)) + owned_deployment_cost(db, project_id) + fuel, 2)
    overhead = _bill_sum(db, project_id, ("expense",))
    cost = material + labour + subcon + equipment + overhead
    return {
        "revenue": round(revenue, 2),
        "material": round(material, 2),
        "labour": round(labour, 2),
        "subcon": round(subcon, 2),
        "equipment": round(equipment, 2),
        "overhead": round(overhead, 2),
        "cost": round(cost, 2),
    }
