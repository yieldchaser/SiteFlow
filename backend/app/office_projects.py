"""Head office and other office "projects".

Office staff need a project to belong to, so a company makes one called
Head Office. It is not a site: it has no progress, health or stage to report,
so portfolio progress and status counts leave it out. Its money (salaries,
rent, bills) still counts everywhere money is summed.
"""
OFFICE_CATEGORY = "Head Office / Office"
# Matched anywhere in the name, so "Head Office - Navi Mumbai" counts.
_OFFICE_PHRASES = ("head office", "corporate office", "registered office", "regional office")
_OFFICE_NAMES = {"ho", "office", "hq"}


def is_office_project(project) -> bool:
    if (getattr(project, "category", None) or "").strip() == OFFICE_CATEGORY:
        return True
    name = " ".join((getattr(project, "name", None) or "").lower().split())
    return name in _OFFICE_NAMES or any(p in name for p in _OFFICE_PHRASES)
