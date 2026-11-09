"""One rule for a project's health, used by the dashboard, analytics and
reports. Before this the reports printed 'Good' or 'On Track' for a
cancelled project while the dashboard said Cancelled."""
from sqlalchemy.orm import Session

from app.models import ProjectBudget


def _f(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def budget_total(db: Session, project_id) -> float:
    """Sum of the four cost heads in the project's budget; 0 when none is set."""
    b = db.query(ProjectBudget).filter(ProjectBudget.project_id == project_id).first()
    if not b:
        return 0.0
    return _f(b.material_budget) + _f(b.labour_budget) + _f(b.subcon_budget) + _f(b.equipment_budget)


def project_health(status, spend: float, budget: float) -> str:
    """Status decides first; otherwise spend against budget. Returns the wire
    value the dashboard already understands ('Onhold' for on hold)."""
    s = (status or "").strip()
    if s == "Completed":
        return "Completed"
    if s in ("Onhold", "On Hold"):
        return "Onhold"
    if s == "Cancelled":
        return "Cancelled"
    if budget > 0 and spend > budget:
        return "Critical"
    if budget > 0 and spend > 0.9 * budget:
        return "Warning"
    return "Healthy"


def health_label(health: str) -> str:
    return "On Hold" if health == "Onhold" else health
