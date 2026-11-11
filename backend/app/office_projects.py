"""Head office and other office "projects".

In a construction firm the head office is a cost centre, not a contract:
corporate staff salaries, rent and admin. It has no client, BOQ, daily
reports, RA bills or progress. Office staff still need somewhere to belong,
so the head office is kept as a project marked `is_head_office`.

- Site counts (progress, health, status) and site analytics leave it out.
- Site-only records (daily reports, tasks, BOQ, client bills, work orders)
  are refused on it.
- Its money is shown as head office overheads: company profit is the sites'
  profit minus head office costs.
"""
from fastapi import HTTPException

OFFICE_CATEGORY = "Head Office / Office"
# Used only to tick the box by default when a project is first created.
_OFFICE_PHRASES = ("head office", "corporate office", "registered office", "regional office")
_OFFICE_NAMES = {"ho", "office", "hq"}


def looks_like_office_name(name) -> bool:
    n = " ".join((name or "").lower().split())
    return n in _OFFICE_NAMES or any(p in n for p in _OFFICE_PHRASES)


def is_office_project(project) -> bool:
    if project is None:
        return False
    if getattr(project, "is_head_office", False):
        return True
    return (getattr(project, "category", None) or "").strip() == OFFICE_CATEGORY


def refuse_on_office(db, project_id, what: str) -> None:
    """Site-only records do not belong on the head office."""
    if project_id is None:
        return
    from app.models import Project
    project = db.query(Project).filter(Project.id == project_id).first()
    if is_office_project(project):
        raise HTTPException(
            status_code=400,
            detail=f"{project.name} is your head office, not a site. {what} belong to a site: pick the site at the top.",
        )
