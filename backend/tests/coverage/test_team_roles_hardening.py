"""Team and role management, as a company owner actually uses it.

Pins the holes found by driving Settings > Team and Roles:
  - every company is born with an Owner role, so "add the standard roles"
    refused forever (409) and real companies had no Supervisor, Accountant...;
  - a Manager (team:manage, no full access) could make themselves Admin, or
    invite an Admin, or demote the Admin;
  - "No role" silently meant full access;
  - there was no way to take someone out of the company;
  - invite codes died after 5 minutes and could never be re-sent;
  - any member, even a Client, could mark any employee present (payroll days);
  - the Supervisor preset could read payroll and the company accounts.
"""
import uuid
from datetime import datetime, timedelta, timezone

from app import models
from app.config import settings
from app.permissions import DEFAULT_ROLE_PRESETS

INVITE_URL = "/apis/v3/auth/team/invite"


def _role(db, company, name, perms):
    role = models.CompanyRole(id=uuid.uuid4(), company_id=company.id, role_name=name, permissions=perms)
    db.add(role)
    db.flush()
    return role


def _member(db, company, role, name):
    user = models.User(id=uuid.uuid4(), name=name, mobile=f"+919{uuid.uuid4().int % 10**9:09d}")
    db.add(user)
    db.flush()
    team = models.CompanyTeam(
        id=uuid.uuid4(), company_id=company.id, user_id=user.id, role_id=role.id, priority_type="employee"
    )
    db.add(team)
    db.commit()
    return user, team


def _company_with_manager(db, make_tenant):
    company, owner, owner_team = make_tenant(company_name=f"Roles Co {uuid.uuid4().hex[:6]}", user_name="Owner")
    admin_role = _role(db, company, "Admin", {"all": True})
    manager_role = _role(db, company, "Manager", dict(DEFAULT_ROLE_PRESETS["Manager"]))
    supervisor_role = _role(db, company, "Supervisor", dict(DEFAULT_ROLE_PRESETS["Supervisor"]))
    db.commit()
    manager, manager_team = _member(db, company, manager_role, "Manager Mehta")
    return company, owner, manager, manager_team, admin_role, supervisor_role


def test_standard_roles_are_added_beside_owner(client, db, make_tenant, auth_headers):
    company, owner, _ = make_tenant(company_name="Seed Co", user_name="Owner")
    _role(db, company, "Owner", {"all": True})
    db.commit()
    r = client.post(f"/apis/v3/settings/roles/seed/{company.id}", headers=auth_headers(owner, company))
    assert r.status_code == 200, r.text
    names = {x["role_name"] for x in r.json()}
    assert {"Supervisor", "Site Engineer", "Accountant", "Admin"} <= names
    again = client.post(f"/apis/v3/settings/roles/seed/{company.id}", headers=auth_headers(owner, company))
    assert again.status_code == 409


def test_manager_cannot_make_themselves_admin(client, db, make_tenant, auth_headers):
    company, owner, manager, manager_team, admin_role, _ = _company_with_manager(db, make_tenant)
    r = client.put(
        f"/apis/v3/settings/team/{manager_team.id}/role",
        headers=auth_headers(manager, company),
        json={"role_id": str(admin_role.id)},
    )
    assert r.status_code == 403, r.text
    ok = client.put(
        f"/apis/v3/settings/team/{manager_team.id}/role",
        headers=auth_headers(owner, company),
        json={"role_id": str(admin_role.id)},
    )
    assert ok.status_code == 200, ok.text


def test_manager_cannot_demote_an_admin(client, db, make_tenant, auth_headers):
    company, _owner, manager, _mt, admin_role, supervisor_role = _company_with_manager(db, make_tenant)
    _admin, admin_team = _member(db, company, admin_role, "Admin Anand")
    r = client.put(
        f"/apis/v3/settings/team/{admin_team.id}/role",
        headers=auth_headers(manager, company),
        json={"role_id": str(supervisor_role.id)},
    )
    assert r.status_code == 403, r.text


def test_no_role_is_not_a_choice_for_staff(client, db, make_tenant, auth_headers):
    company, owner, _manager, manager_team, _a, _s = _company_with_manager(db, make_tenant)
    r = client.put(
        f"/apis/v3/settings/team/{manager_team.id}/role",
        headers=auth_headers(owner, company),
        json={"role_id": None},
    )
    assert r.status_code == 400, r.text


def test_manager_cannot_invite_an_admin_but_can_invite_a_supervisor(client, db, make_tenant, auth_headers, monkeypatch):
    monkeypatch.setattr(settings, "EMAIL_OTP_DEMO_ALLOWLIST", "a@example.com,s@example.com")
    monkeypatch.setattr(settings, "OTP_DEMO_CODE", "111222")
    company, _owner, manager, _mt, admin_role, supervisor_role = _company_with_manager(db, make_tenant)
    hdr = auth_headers(manager, company)
    bad = client.post(INVITE_URL, headers=hdr, json={"email": "a@example.com", "name": "A", "role_id": str(admin_role.id)})
    assert bad.status_code == 403, bad.text
    good = client.post(INVITE_URL, headers=hdr, json={"email": "s@example.com", "name": "S", "role_id": str(supervisor_role.id)})
    assert good.status_code == 200, good.text

    team = client.get(f"/apis/v3/settings/team/{company.id}", headers=hdr).json()
    invited = next(m for m in team if m["email"] == "s@example.com")
    assert invited["invite_pending"] is True
    me = next(m for m in team if m["name"] == "Manager Mehta")
    assert me["is_me"] is True and me["invite_pending"] is False


def test_invite_code_lasts_a_week(client, db, make_tenant, auth_headers, monkeypatch):
    monkeypatch.setattr(settings, "EMAIL_OTP_DEMO_ALLOWLIST", "late@example.com")
    monkeypatch.setattr(settings, "OTP_DEMO_CODE", "333444")
    company, owner, _m, _mt, _a, supervisor_role = _company_with_manager(db, make_tenant)
    r = client.post(
        INVITE_URL, headers=auth_headers(owner, company),
        json={"email": "late@example.com", "name": "Late", "role_id": str(supervisor_role.id)},
    )
    assert r.status_code == 200, r.text
    otp = db.query(models.OTPCode).filter(models.OTPCode.identifier == "late@example.com").first()
    expires = otp.expires_at if otp.expires_at.tzinfo else otp.expires_at.replace(tzinfo=timezone.utc)
    assert expires > datetime.now(timezone.utc) + timedelta(days=6)


def test_removed_member_loses_access(client, db, make_tenant, auth_headers):
    company, owner, _m, _mt, _a, supervisor_role = _company_with_manager(db, make_tenant)
    sup, sup_team = _member(db, company, supervisor_role, "Supervisor Sunil")
    sup_hdr = auth_headers(sup, company)
    assert client.get(f"/apis/v3/mom/{company.id}", headers=sup_hdr).status_code == 200

    r = client.delete(f"/apis/v3/settings/team/{sup_team.id}", headers=auth_headers(owner, company))
    assert r.status_code == 204, r.text
    assert client.get(f"/apis/v3/mom/{company.id}", headers=sup_hdr).status_code == 403
    names = [m["name"] for m in client.get(f"/apis/v3/settings/team/{company.id}", headers=auth_headers(owner, company)).json()]
    assert "Supervisor Sunil" not in names


def test_cannot_remove_owner_self_or_admin_without_full_access(client, db, make_tenant, auth_headers):
    company, owner, manager, manager_team, admin_role, _s = _company_with_manager(db, make_tenant)
    owner_team = db.query(models.CompanyTeam).filter(models.CompanyTeam.user_id == owner.id).first()
    _admin, admin_team = _member(db, company, admin_role, "Admin Anand")
    hdr = auth_headers(manager, company)
    assert client.delete(f"/apis/v3/settings/team/{owner_team.id}", headers=hdr).status_code == 400
    assert client.delete(f"/apis/v3/settings/team/{manager_team.id}", headers=hdr).status_code == 400
    assert client.delete(f"/apis/v3/settings/team/{admin_team.id}", headers=hdr).status_code == 403


def test_client_role_cannot_mark_face_attendance(client, db, make_tenant, auth_headers):
    company, _owner, _m, _mt, _a, _s = _company_with_manager(db, make_tenant)
    client_role = _role(db, company, "Client", dict(DEFAULT_ROLE_PRESETS["Client"]))
    db.commit()
    viewer, _ = _member(db, company, client_role, "Client Kolte")
    project = models.Project(id=uuid.uuid4(), company_id=company.id, name="Tower", code="TW1")
    db.add(project)
    db.commit()
    r = client.post(
        "/apis/v3/face/punch",
        headers=auth_headers(viewer, company),
        json={"company_id": str(company.id), "project_id": str(project.id), "employee_id": str(uuid.uuid4()),
              "punch_type": "in", "face_verified": True, "confidence_score": 0.9},
    )
    assert r.status_code == 403, r.text


def test_supervisor_preset_sees_site_work_not_money():
    sup = DEFAULT_ROLE_PRESETS["Supervisor"]
    for key in ("attendance:edit", "quality:edit", "safety:edit", "planning:edit", "drawings:view"):
        assert sup.get(key) is True, key
    for key in ("payroll:view", "finance:view", "billing:view", "budgeting:view", "crm:view"):
        assert not sup.get(key), key
    eng = DEFAULT_ROLE_PRESETS["Site Engineer"]
    assert eng.get("budgeting:view") and eng.get("billing:view")
    assert not eng.get("payroll:view") and not eng.get("finance:view")
