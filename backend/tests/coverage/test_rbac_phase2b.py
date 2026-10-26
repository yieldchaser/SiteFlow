"""RBAC Phase 2b regression tests: <module>:edit on everyday writes + sensitive
financial/payroll :view reads.

Covers the four failsafe permutations on a representative write (create_payment
→ finance:edit) and a sensitive-read (GET /finance/accounts/{company_id}
→ finance :view):
  - view-only role (no finance:edit)               -> 403
  - role WITH finance:edit                          -> allowed
  - partner member                                  -> allowed
  - un-configured empty {} role (fail-open)         -> allowed
  - sensitive read: no finance access               -> 403
  - sensitive read: finance:view                    -> allowed
"""
import uuid

from app import models


def _make_employee(db, company, perms, auth_headers):
    """Create an employee-priority member with a custom role (perms dict)."""
    user = models.User(id=uuid.uuid4(), name="Emp", mobile=f"+919{uuid.uuid4().hex[:9]}")
    db.add(user)
    db.flush()
    role = models.CompanyRole(
        company_id=company.id,
        role_name=f"Role-{uuid.uuid4().hex[:6]}",
        permissions=perms,
    )
    db.add(role)
    db.flush()
    team = models.CompanyTeam(
        id=uuid.uuid4(),
        company_id=company.id,
        user_id=user.id,
        priority_type="employee",
        role_id=role.id,
    )
    db.add(team)
    db.commit()
    return user, role, auth_headers(user, company)


def _payment_payload(company_id):
    return {
        "company_id": str(company_id),
        "payment_type": "out",
        "amount": 100.0,
        "payment_method": "Cash",
        "payment_date": "2026-01-01T00:00:00",
    }


# ── write gate: finance:edit on POST /finance/payments ───────────────────────

def test_create_payment_denies_view_only(client, db, make_tenant, auth_headers):
    comp, _, _ = make_tenant(company_name="A", user_name="UA", mobile="+919888802001", email="v1@t.com")
    _, _, hdr = _make_employee(db, comp, {"finance:view": True}, auth_headers)
    r = client.post("/apis/v3/finance/payments", json=_payment_payload(comp.id), headers=hdr)
    assert r.status_code == 403


def test_create_payment_allows_with_edit(client, db, make_tenant, auth_headers):
    comp, _, _ = make_tenant(company_name="A", user_name="UA", mobile="+919888802002", email="v2@t.com")
    _, _, hdr = _make_employee(db, comp, {"finance:edit": True}, auth_headers)
    r = client.post("/apis/v3/finance/payments", json=_payment_payload(comp.id), headers=hdr)
    assert r.status_code != 403


def test_create_payment_allows_partner(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="A", user_name="UA", mobile="+919888802003", email="v3@t.com")
    hdr = auth_headers(user, comp)
    r = client.post("/apis/v3/finance/payments", json=_payment_payload(comp.id), headers=hdr)
    assert r.status_code != 403


def test_create_payment_fail_open_empty_perms(client, db, make_tenant, auth_headers):
    comp, _, _ = make_tenant(company_name="A", user_name="UA", mobile="+919888802004", email="v4@t.com")
    _, _, hdr = _make_employee(db, comp, {}, auth_headers)
    r = client.post("/apis/v3/finance/payments", json=_payment_payload(comp.id), headers=hdr)
    assert r.status_code != 403


# ── sensitive read gate: finance :view on GET /finance/accounts/{company_id} ──

def test_finance_read_denies_without_access(client, db, make_tenant, auth_headers):
    comp, _, _ = make_tenant(company_name="A", user_name="UA", mobile="+919888802005", email="r1@t.com")
    _, _, hdr = _make_employee(db, comp, {"projects:view": True}, auth_headers)
    r = client.get(f"/apis/v3/finance/accounts/{comp.id}", headers=hdr)
    assert r.status_code == 403


def test_finance_read_allows_with_view(client, db, make_tenant, auth_headers):
    comp, _, _ = make_tenant(company_name="A", user_name="UA", mobile="+919888802006", email="r2@t.com")
    _, _, hdr = _make_employee(db, comp, {"finance:view": True}, auth_headers)
    r = client.get(f"/apis/v3/finance/accounts/{comp.id}", headers=hdr)
    assert r.status_code != 403


# ── self-service endpoints must NOT require an admin :edit permission ────────
# (tenant guard / company membership still applies; only the RBAC edit gate is
# removed so an ordinary member — e.g. Manager with payroll:view only — can do
# basic self-service: request their own leave, clock their own attendance.)

def _make_project(db, company):
    project = models.Project(
        id=uuid.uuid4(), company_id=company.id, name="P", code=uuid.uuid4().hex[:6], status="Ongoing"
    )
    db.add(project)
    db.commit()
    return project


def test_create_leave_request_allows_view_only_self_service(client, db, make_tenant, auth_headers):
    comp, _, _ = make_tenant(company_name="A", user_name="UA", mobile="+919888803001", email="ls1@t.com")
    _, _, hdr = _make_employee(db, comp, {"payroll:view": True}, auth_headers)
    project = _make_project(db, comp)
    r = client.post(
        f"/apis/v3/hr/leaves/{comp.id}",
        json={
            "project_id": str(project.id),
            "employee_id": str(uuid.uuid4()),
            "employee_name": "Self User",
            "leave_type": "Casual",
            "start_date": "2026-02-01T00:00:00",
            "end_date": "2026-02-02T00:00:00",
            "days_count": 2,
        },
        headers=hdr,
    )
    assert r.status_code != 403


def test_punch_denies_view_only(client, db, make_tenant, auth_headers):
    # A punch names any employee and feeds payroll days; staff records are not
    # linked to logins, so it was never self-service. It needs attendance:edit.
    comp, _, _ = make_tenant(company_name="A", user_name="UA", mobile="+919888803002", email="ls2@t.com")
    _, _, hdr = _make_employee(db, comp, {"payroll:view": True, "attendance:view": True}, auth_headers)
    project = _make_project(db, comp)
    r = client.post(
        "/apis/v3/hr/attendance/punch",
        json={
            "employee_id": str(uuid.uuid4()),
            "project_id": str(project.id),
            "lat": 12.0,
            "lng": 77.0,
            "punch_type": "in",
        },
        headers=hdr,
    )
    assert r.status_code == 403


def test_punch_allows_attendance_edit(client, db, make_tenant, auth_headers):
    comp, _, _ = make_tenant(company_name="A", user_name="UA", mobile="+919888803012", email="ls3@t.com")
    _, _, hdr = _make_employee(db, comp, {"attendance:view": True, "attendance:edit": True}, auth_headers)
    project = _make_project(db, comp)
    r = client.post(
        "/apis/v3/hr/attendance/punch",
        json={
            "employee_id": str(uuid.uuid4()),
            "project_id": str(project.id),
            "lat": 12.0,
            "lng": 77.0,
            "punch_type": "in",
        },
        headers=hdr,
    )
    assert r.status_code != 403
