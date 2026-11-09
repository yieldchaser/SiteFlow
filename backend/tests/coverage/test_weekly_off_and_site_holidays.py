"""Weekly off per employee and holidays per site.

VCPL rollout: office staff are off on Sunday while a marine crew works seven
days, and a local festival is a holiday at one site only. Both were
company-wide, so payroll used the wrong number of working days for some.
"""
import uuid

from app import models

_SFX = uuid.uuid4().hex[:6]


def test_own_weekly_off_and_site_holiday_set_working_days(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name=f"WO Co {_SFX}", user_name="WO",
                                email=f"wo-{_SFX}@example.com")
    comp.weekly_off_days = ["Sunday"]
    hdr = auth_headers(user, comp)
    jetty = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Jetty", status="Ongoing")
    other = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Other", status="Ongoing")
    db.add_all([jetty, other])
    db.commit()
    base = {"company_id": str(comp.id), "project_id": str(jetty.id), "basic_salary": 30000,
            "pf_employee_pct": 0, "pf_employer_pct": 0}

    r = client.post("/apis/v3/hr/employees", headers=hdr, json={**base, "name": "Bad", "weekly_off_days": ["Funday"]})
    assert r.status_code == 422
    r = client.post("/apis/v3/hr/employees", headers=hdr, json={**base, "name": "Crew", "weekly_off_days": []})
    assert r.status_code == 201 and r.json()["weekly_off_days"] == []
    r = client.post("/apis/v3/hr/employees", headers=hdr, json={**base, "name": "Office"})
    assert r.json()["weekly_off_days"] is None
    r = client.post("/apis/v3/hr/employees", headers=hdr, json={**base, "name": "Fri", "weekly_off_days": ["fri"]})
    assert r.json()["weekly_off_days"] == ["Friday"]

    # Holiday at this site only, and one at another site that must not count.
    r = client.post(f"/apis/v3/hr/holidays/{comp.id}", headers=hdr,
                    json={"name": "Local fair", "date": "2026-10-07", "project_id": str(jetty.id)})
    assert r.status_code == 201, r.text
    assert r.json()["project_id"] == str(jetty.id)
    client.post(f"/apis/v3/hr/holidays/{comp.id}", headers=hdr,
                json={"name": "Elsewhere", "date": "2026-10-08", "project_id": str(other.id)})
    foreign, _, _ = make_tenant(company_name=f"WO Other {_SFX}", user_name="X", email=f"wox-{_SFX}@example.com")
    fp = models.Project(id=uuid.uuid4(), company_id=foreign.id, name="Theirs")
    db.add(fp)
    db.commit()
    r = client.post(f"/apis/v3/hr/holidays/{comp.id}", headers=hdr,
                    json={"name": "Nope", "date": "2026-10-09", "project_id": str(fp.id)})
    assert r.status_code == 400

    run = client.post("/apis/v3/hr/payroll/run", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(jetty.id), "payroll_month": "2026-10",
        "assume_full_month": True})
    assert run.status_code == 201, run.text
    days = {p["employee_name"]: p["days_in_month"] for p in run.json()["payslips"]}
    # October 2026: 31 days, 4 Sundays, 5 Fridays; one site holiday (a Wednesday).
    assert days["Crew"] == 30
    assert days["Office"] == 26
    assert days["Fri"] == 25
