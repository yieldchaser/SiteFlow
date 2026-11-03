"""Employee record: site, PF on/off, and how the salary is paid.

Asked for on 2026-11-03 before the VCPL rollout: every employee is entered
site by site with salary and PF, and some are paid in cash. The record had no
pay mode or bank details, the site could not be changed after saving, PF was
fixed at 12%, and any project id was accepted, even another company's.
"""
import uuid

from app import models

_SFX = uuid.uuid4().hex[:6]
URL = "/apis/v3/hr/employees"


def _project(db, company, name):
    p = models.Project(id=uuid.uuid4(), company_id=company.id, name=name)
    db.add(p)
    db.commit()
    return p


def test_site_pf_and_pay_mode(client, db, make_tenant, auth_headers):
    company, owner, _ = make_tenant(company_name=f"Pay Co {_SFX}", user_name="Owner",
                                    email=f"pay-{_SFX}@example.com")
    other, _, _ = make_tenant(company_name=f"Other Co {_SFX}", user_name="Other",
                              email=f"other-{_SFX}@example.com")
    h = auth_headers(owner, company)
    site = _project(db, company, "JNPT Berth 4")
    office = _project(db, company, "Head Office")
    foreign = _project(db, other, "Not ours")

    base = {"company_id": str(company.id), "basic_salary": 18000}

    r = client.post(URL, headers=h, json={**base, "name": "Ravi", "project_id": str(foreign.id)})
    assert r.status_code == 400, r.text

    r = client.post(URL, headers=h, json={**base, "name": "Ravi", "project_id": str(site.id),
                                          "salary_paid_by": "bank", "bank_ifsc": "BAD"})
    assert r.status_code == 422, r.text

    r = client.post(URL, headers=h, json={**base, "name": "Ravi", "project_id": str(site.id),
                                          "salary_paid_by": "bank", "bank_account": "1234 5678 9012",
                                          "bank_ifsc": "sbin0001234"})
    assert r.status_code == 201, r.text
    ravi = r.json()
    assert ravi["salary_paid_by"] == "bank"
    assert ravi["bank_account"] == "123456789012"
    assert ravi["bank_ifsc"] == "SBIN0001234"

    r = client.post(URL, headers=h, json={**base, "name": "Ganesh", "project_id": str(site.id),
                                          "salary_paid_by": "cash", "bank_account": "999999"})
    assert r.status_code == 201, r.text
    assert r.json()["salary_paid_by"] == "cash"
    assert r.json()["bank_account"] is None

    r = client.post(URL, headers=h, json={**base, "name": "Default"})
    assert r.json()["salary_paid_by"] == "bank"

    # Moved to head office, taken out of PF, switched to cash.
    r = client.put(f"{URL}/{ravi['id']}", headers=h, json={
        "project_id": str(office.id), "pf_employee_pct": 0, "pf_employer_pct": 0,
        "salary_paid_by": "cash"})
    assert r.status_code == 200, r.text
    moved = r.json()
    assert moved["project_id"] == str(office.id)
    assert moved["pf_employee_pct"] == 0 and moved["pf_employer_pct"] == 0
    assert moved["salary_paid_by"] == "cash" and moved["bank_account"] is None

    r = client.put(f"{URL}/{ravi['id']}", headers=h, json={"project_id": str(foreign.id)})
    assert r.status_code == 400, r.text
