"""Attendance as a Supervisor uses it: who may see the staff list, what pay
detail they see, which day a punch lands on, and that a newly added member
cannot rename the company through the first-login questionnaire."""
import uuid
from datetime import datetime, timedelta, timezone

from app import models

IST = timezone(timedelta(hours=5, minutes=30))


def _member(db, company, perms, auth_headers):
    user = models.User(id=uuid.uuid4(), name="Member", mobile=f"+919{uuid.uuid4().hex[:9]}")
    db.add(user)
    db.flush()
    role = models.CompanyRole(company_id=company.id, role_name=f"R-{uuid.uuid4().hex[:6]}", permissions=perms)
    db.add(role)
    db.flush()
    db.add(models.CompanyTeam(id=uuid.uuid4(), company_id=company.id, user_id=user.id,
                              priority_type="employee", role_id=role.id))
    db.commit()
    return auth_headers(user, company)


def _site(db, company):
    project = models.Project(id=uuid.uuid4(), company_id=company.id, name="Site", code=uuid.uuid4().hex[:6],
                             status="Ongoing", location="18.5204,73.8567")
    db.add(project)
    db.flush()
    emp = models.StaffEmployee(id=uuid.uuid4(), company_id=company.id, project_id=project.id, name="Ravi",
                               basic_salary=21000, hra=4000, other_allowances=0)
    db.add(emp)
    db.commit()
    return project, emp


SUPERVISOR = {"attendance:view": True, "attendance:edit": True}


def test_supervisor_sees_staff_without_pay(client, db, make_tenant, auth_headers):
    comp, _, _ = make_tenant(company_name="A", user_name="UA", mobile="+919888804001", email="ar1@t.com")
    project, _ = _site(db, comp)
    hdr = _member(db, comp, SUPERVISOR, auth_headers)

    for url in (f"/apis/v3/hr/company/employees/{comp.id}", f"/apis/v3/hr/employees/{project.id}"):
        r = client.get(url, headers=hdr)
        assert r.status_code == 200, (url, r.text)
        rows = r.json()
        assert [e["name"] for e in rows] == ["Ravi"]
        assert rows[0]["basic_salary"] is None, url


def test_payroll_role_still_sees_pay(client, db, make_tenant, auth_headers):
    comp, _, _ = make_tenant(company_name="A", user_name="UA", mobile="+919888804002", email="ar2@t.com")
    project, _ = _site(db, comp)
    hdr = _member(db, comp, {"payroll:view": True}, auth_headers)
    r = client.get(f"/apis/v3/hr/employees/{project.id}", headers=hdr)
    assert r.status_code == 200
    assert float(r.json()[0]["basic_salary"]) == 21000


def test_staff_list_refused_without_attendance_or_payroll(client, db, make_tenant, auth_headers):
    comp, _, _ = make_tenant(company_name="A", user_name="UA", mobile="+919888804003", email="ar3@t.com")
    project, _ = _site(db, comp)
    hdr = _member(db, comp, {"drawings:view": True}, auth_headers)
    assert client.get(f"/apis/v3/hr/employees/{project.id}", headers=hdr).status_code == 403
    assert client.get(f"/apis/v3/hr/company/employees/{comp.id}", headers=hdr).status_code == 403


def test_early_morning_punch_lands_on_the_indian_day(client, db, make_tenant, auth_headers):
    comp, _, _ = make_tenant(company_name="A", user_name="UA", mobile="+919888804004", email="ar4@t.com")
    project, emp = _site(db, comp)
    hdr = _member(db, comp, SUPERVISOR, auth_headers)

    # The most recent 02:00 IST that is already in the past: 20:30Z the day before.
    now_ist = datetime.now(IST)
    at = now_ist.replace(hour=2, minute=0, second=0, microsecond=0)
    if at > now_ist:
        at -= timedelta(days=1)
    r = client.post("/apis/v3/hr/attendance/punch", headers=hdr, json={
        "employee_id": str(emp.id), "project_id": str(project.id), "lat": 18.5204, "lng": 73.8567,
        "punch_type": "in", "captured_at": at.astimezone(timezone.utc).isoformat(),
    })
    assert r.status_code == 201, r.text

    day = at.date().isoformat()
    r = client.get(f"/apis/v3/hr/attendance/{project.id}/{day}", headers=hdr)
    assert r.status_code == 200
    assert len(r.json()) == 1, f"punch at 02:00 IST missing from {day}"
    r = client.get(f"/apis/v3/hr/attendance/{project.id}/{(at.date() - timedelta(days=1)).isoformat()}", headers=hdr)
    assert r.json() == []


def test_new_member_cannot_rename_company_via_onboarding(client, db, make_tenant, auth_headers):
    comp, _, _ = make_tenant(company_name="Shivalik", user_name="UA", mobile="+919888804005", email="ar5@t.com")
    hdr = _member(db, comp, SUPERVISOR, auth_headers)
    r = client.post("/apis/v3/profile/onboarding", headers=hdr, json={
        "company_id": str(comp.id), "company_name": "Renamed", "city": "Pune", "segment": "Developer",
    })
    assert r.status_code == 403
    db.refresh(comp)
    assert comp.name == "Shivalik"


def _preset(name):
    from app.permissions import DEFAULT_ROLE_PRESETS
    return dict(DEFAULT_ROLE_PRESETS[name])


def test_supervisor_files_daily_report_but_cannot_create_projects(client, db, make_tenant, auth_headers):
    comp, _, _ = make_tenant(company_name="A", user_name="UA", mobile="+919888804006", email="ar6@t.com")
    project, _ = _site(db, comp)
    hdr = _member(db, comp, _preset("Supervisor"), auth_headers)

    r = client.post("/apis/v3/dpr", headers=hdr, json={
        "project_id": str(project.id), "dpr_date": datetime.now(timezone.utc).isoformat(),
        "executed_qty": 0, "workers_deployed": 12, "notes": "Slab shuttering",
    })
    assert r.status_code == 201, r.text

    r = client.post("/apis/v3/projects/", headers=hdr, json={"company_id": str(comp.id), "name": "Not mine", "state": "Maharashtra"})
    assert r.status_code == 403, r.text
