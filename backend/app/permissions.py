"""RBAC permission taxonomy, default-role presets, and evaluation helpers.

This is the PHASE 1 backend foundation only. No endpoint enforcement is added
here (that is Phase 2). Everything in this module is pure (no DB / request
access) so it can be imported anywhere without side effects.

Failsafe rules baked into the evaluation helpers (see SECURITY_rbac_design.md):
- Owner / partner bypass: a superuser (`"all": True`) or a `partner` member is
  never denied — this prevents lockout.
- Fail-open on missing / un-migrated data: an empty permission dict or a null
  role_id grants nothing explicitly, but enforcement (Phase 2) treats it as
  "allow" until a real permission set withholds the key.
"""

from typing import Dict, Optional

# ── Taxonomy ──────────────────────────────────────────────────────────────────

# Functional areas of the product (align with the sidebar / modules).
MODULES = [
    "dashboard",
    "projects",
    "finance",
    "billing",
    "procurement",
    "budgeting",
    "payroll",
    "attendance",
    "crm",
    "library",
    "production",
    "quality",
    "safety",
    "drawings",
    "equipment",
    "reports",
    "planning",
    "subcontractor",
]

# Modules that support a workflow `approve` action (in addition to view/edit).
# R2-172: this set must cover every module DEFAULT_ROLE_PRESETS grants `:approve`
# for - a preset key outside ALL_PERMISSION_KEYS is rejected by
# validate_permissions, so re-saving such a role 400s on the direct-API path
# while the permission-matrix UI silently strips the key instead.
WORKFLOW_MODULES = {
    "finance",
    "billing",
    "procurement",
    "budgeting",
    "payroll",
    "attendance",
    "drawings",
    "reports",
    "subcontractor",
    "projects",
    "crm",
    "production",
    "quality",
    "safety",
    "equipment",
    "planning",
}

# Cross-cutting high-risk capabilities (not tied to a single module's CRUD).
GLOBAL_CAPABILITY_KEYS = {
    "settings:manage",   # company config, roles, approval rules, branches
    "team:manage",       # add/remove members, assign roles
    "payroll:run",       # run payroll
    "data:delete",       # destructive deletes across modules
}

# Superuser flag: bypasses every permission check.
SUPERUSER_KEY = "all"

# Every valid permission key. Used to validate incoming permission dicts and to
# render the frontend editor. Includes the superuser flag.
ALL_PERMISSION_KEYS: set = {SUPERUSER_KEY}
for _m in MODULES:
    ALL_PERMISSION_KEYS.add(f"{_m}:view")
    ALL_PERMISSION_KEYS.add(f"{_m}:edit")
    if _m in WORKFLOW_MODULES:
        ALL_PERMISSION_KEYS.add(f"{_m}:approve")
ALL_PERMISSION_KEYS |= GLOBAL_CAPABILITY_KEYS

# Canonical ordered list of keys (handy for the frontend matrix editor).
ALL_PERMISSION_KEY_LIST = sorted(ALL_PERMISSION_KEYS)


# ── Pure evaluation / validation helpers ──────────────────────────────────────

def has_permission(perms: Optional[Dict], key: str) -> bool:
    """True if the caller is a superuser (`all`) or explicitly holds `key`."""
    if not perms:
        return False
    return bool(perms.get(SUPERUSER_KEY) is True or perms.get(key) is True)


def has_module_access(perms: Optional[Dict], module: str) -> bool:
    """True if the caller has ANY permission on `module` (view/edit/approve) or
    is a superuser. Used for sensitive-read gating where "being able to edit or
    approve clearly implies being able to view".
    """
    if not perms:
        return False
    if perms.get(SUPERUSER_KEY) is True:
        return True
    return bool(
        perms.get(f"{module}:view") is True
        or perms.get(f"{module}:edit") is True
        or perms.get(f"{module}:approve") is True
    )


def validate_permissions(perms: Dict) -> Dict:
    """Validate an incoming permission dict against the canonical key set.

    - Unknown keys are rejected (typo-perms must never silently match).
    - Values are coerced to bool.
    - Sparse input is allowed: keys absent from `perms` are treated as not
      granted (False) by `has_permission`.

    Returns a normalized dict containing only the provided keys (as bool).
    """
    if not isinstance(perms, dict):
        raise ValueError("permissions must be a JSON object")
    normalized: Dict[str, bool] = {}
    for k, v in perms.items():
        if k not in ALL_PERMISSION_KEYS:
            raise ValueError(f"Unknown permission key: {k!r}")
        normalized[k] = bool(v)
    return normalized


def default_view_permissions() -> Dict[str, bool]:
    """A newly created custom role defaults to read-only across every module."""
    return {f"{m}:view": True for m in MODULES}


def effective_permissions(
    role_perms: Optional[Dict], priority_type: Optional[str]
) -> Dict:
    """Resolve the effective permission dict for `get_me` / UI gating.

    Failsafe rules:
    - A `partner` always has full access (never lockable out).
    - Otherwise fall back to the role's stored permissions, or `{}` (no perms)
      when the member has no role / empty perms.
    """
    if priority_type == "partner":
        return {"all": True}
    if role_perms:
        return role_perms
    return {}


# ── Default-role presets ──────────────────────────────────────────────────────

# Operational modules where a Manager holds full view+edit+approve.
_OPS_MODULES = [
    "projects", "finance", "billing", "procurement", "budgeting", "crm",
    "production", "quality", "safety", "drawings", "equipment", "reports",
    "planning", "subcontractor", "attendance",
]


def _preset(*grants: str) -> Dict[str, bool]:
    return {g: True for g in grants}


def _manager_grants(team_manage: bool) -> list:
    g = ["dashboard:view"]
    for m in _OPS_MODULES:
        g += [f"{m}:view", f"{m}:edit", f"{m}:approve"]
    g += ["library:view", "library:edit", "payroll:view"]
    if team_manage:
        g.append("team:manage")
    return g


def _accountant_grants() -> list:
    g = [f"{m}:view" for m in MODULES]
    for m in ("finance", "billing", "budgeting"):
        g += [f"{m}:edit", f"{m}:approve"]
    return g


# Salaries, the company's books and the sales pipeline are not site work.
_OFFICE_ONLY_MODULES = {"finance", "payroll", "crm"}


def _site_engineer_grants() -> list:
    # Sees BOQ and RA bills (budgeting/billing) to measure against, but not the
    # accounts, payroll or CRM.
    g = [f"{m}:view" for m in MODULES if m not in _OFFICE_ONLY_MODULES]
    for m in ("projects", "production", "quality", "safety", "drawings",
              "attendance", "planning", "procurement"):
        g.append(f"{m}:edit")
    return g


def _associate_hr_grants() -> list:
    g = [f"{m}:view" for m in MODULES]
    g += ["payroll:edit", "payroll:run", "attendance:edit"]
    # No finance:approve / settings:manage / team:manage / data:delete.
    return g


def _supervisor_grants() -> list:
    # Site work only: no money modules (accounts, bills, budgets, payroll, CRM)
    # and no company reports, which carry the financial summaries.
    site = ("dashboard", "projects", "planning", "drawings", "quality", "safety",
            "attendance", "equipment", "production", "procurement", "library",
            "subcontractor")
    g = [f"{m}:view" for m in site]
    # No projects:edit: a Supervisor files daily reports (planning:edit) but
    # does not create, rename or delete projects.
    for m in ("production", "quality", "safety", "attendance", "planning"):
        g.append(f"{m}:edit")
    return g


def _client_grants() -> list:
    return ["projects:view", "reports:view", "billing:view"]


def _subcontractor_grants() -> list:
    return ["subcontractor:view", "drawings:view", "projects:view"]


def _viewer_grants() -> list:
    return [f"{m}:view" for m in MODULES]


# Keyed by the exact `role_name` values seeded in settings.DEFAULT_ROLES (plus
# "Owner", which is created at onboarding rather than seeded).
DEFAULT_ROLE_PRESETS: Dict[str, Dict] = {
    "Owner": {"all": True},
    "Admin": {"all": True},
    "Manager": _preset(*_manager_grants(team_manage=True)),
    "Project partner": _preset(*_manager_grants(team_manage=False)),
    "Accountant": _preset(*_accountant_grants()),
    "Site Engineer": _preset(*_site_engineer_grants()),
    "Associate HR": _preset(*_associate_hr_grants()),
    "Supervisor": _preset(*_supervisor_grants()),
    "Client": _preset(*_client_grants()),
    "Sub Contractor": _preset(*_subcontractor_grants()),
    "Viewer": _preset(*_viewer_grants()),
}

# D7 (R2-073/R2-113/R2-169) fallback grant set: roles whose name matches no
# preset, and members with no resolvable role, resolve to this under the
# fail-closed policy. Always copy (dict(VIEWER_GRANTS)) before storing/sharing.
VIEWER_GRANTS: Dict[str, bool] = DEFAULT_ROLE_PRESETS["Viewer"]
