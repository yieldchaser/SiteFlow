"""Cost of the company's own machines deployed on a project.

One rule for the P&L, the Budget page and the BI feed, which used to disagree:
Budget and BI always counted wall-clock hours (24 a day) and ignored the
machine hours recorded on the deployment.

- Hired machines are costed by their hire invoices (equipment bills). Adding
  hours x rate for them as well counted the same crane twice.
- Recorded engine/shift hours (hours_used) are the truth (R2-357); wall-clock
  time is only the fallback when nothing was recorded.
- A machine with no hourly rate contributes nothing; there is no rate to
  invent (R2-358a), and the omission is logged.
"""
import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models import Equipment, EquipmentDeployment

logger = logging.getLogger(__name__)


def owned_deployment_cost(db: Session, project_id) -> float:
    total = 0.0
    for dep in db.query(EquipmentDeployment).filter(EquipmentDeployment.project_id == project_id).all():
        eq = db.query(Equipment).filter(Equipment.id == dep.equipment_id).first()
        if not eq or (eq.ownership_type or "").strip().lower() == "hired":
            continue
        rate = float(eq.hourly_rate or 0.0)
        if rate <= 0.0:
            logger.warning(
                "Equipment %s (%s) is deployed on project %s but has no hourly_rate configured, "
                "so its deployment costs 0.00.", eq.id, eq.code, project_id,
            )
            continue
        if dep.hours_used is not None:
            hours = float(dep.hours_used)
        else:
            # R2-727: timezone-aware on Postgres, naive on SQLite.
            start = dep.start_date
            if start.tzinfo is None:
                start = start.replace(tzinfo=timezone.utc)
            end = dep.end_date if dep.end_date else datetime.now(timezone.utc)
            if end.tzinfo is None:
                end = end.replace(tzinfo=timezone.utc)
            hours = (end - start).total_seconds() / 3600.0
        total += round(max(0.0, hours * rate), 2)
    return round(total, 2)
