"""Head office and other office "projects".

Office staff need a project to belong to, so a company makes one called
Head Office. It is not a site: it has no progress, health or stage to report,
so portfolio progress and status counts leave it out. Its money (salaries,
rent, bills) still counts everywhere money is summed.
"""
OFFICE_CATEGORY = "Head Office / Office"
_OFFICE_NAMES = {"head office", "ho", "corporate office", "registered office", "office"}


def is_office_project(project) -> bool:
    if (getattr(project, "category", None) or "").strip() == OFFICE_CATEGORY:
        return True
    return (getattr(project, "name", None) or "").strip().lower() in _OFFICE_NAMES
