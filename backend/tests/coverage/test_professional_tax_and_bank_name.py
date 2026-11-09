"""Professional tax on payslips, and the employee's bank name.

Raised by VCPL in the 2026-11-09 demo: payroll deducted PF, ESI and TDS but
never professional tax, and the employee form had no place for the bank name.
The company picks its state once; payroll applies that state's slab to each
payslip, except for staff marked as not liable.
"""
import datetime
import uuid

from app import models
from app.professional_tax import professional_tax

_SFX = uuid.uuid4().hex[:6]


def test_state_slabs():
    assert professional_tax("Maharashtra", 7000, 10) == 0
    assert professional_tax("Maharashtra", 9000, 10) == 175
    assert professional_tax("Maharashtra", 30000, 10) == 200
    assert professional_tax("Maharashtra", 30000, 2) == 300
    assert professional_tax("Gujarat", 11000, 10) == 0
    assert professional_tax("Gujarat", 12000, 10) == 200
    assert professional_tax("Karnataka", 30000, 2) == 300
    assert professional_tax(None, 50000, 10) == 0
    assert professional_tax("Nowhere", 50000, 10) == 0


def _run(client, hdr, comp, project):
    return client.post("/apis/v3/hr/payroll/run", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id),
        "payroll_month": "2026-10", "assume_full_month": True})


def test_payroll_deducts_pt_for_the_company_state(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name=f"PT Co {_SFX}", user_name="PT Owner",
                                email=f"pt-{_SFX}@example.com")
    hdr = auth_headers(user, comp)
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Berth 4", status="Ongoing")
    db.add(project)
    db.commit()

    r = client.put(f"/apis/v3/settings/payroll/{comp.id}", headers=hdr,
                   json={"pt_state": "Atlantis", "confirm_changes": True})
    assert r.status_code == 422, r.text
    r = client.put(f"/apis/v3/settings/payroll/{comp.id}", headers=hdr,
                   json={"pt_state": "Maharashtra", "confirm_changes": True})
    assert r.status_code == 200, r.text
    assert r.json()["pt_state"] == "Maharashtra"
    assert "Gujarat" in r.json()["pt_states"]

    base = {"company_id": str(comp.id), "project_id": str(project.id), "basic_salary": 30000,
            "pf_employee_pct": 0, "pf_employer_pct": 0}
    r = client.post("/apis/v3/hr/employees", headers=hdr, json={
        **base, "name": "Sanjay", "mobile": "9800000001",
        "bank_name": "  HDFC Bank ", "bank_account": "50100123456789", "bank_ifsc": "HDFC0000123"})
    assert r.status_code == 201, r.text
    assert r.json()["bank_name"] == "HDFC Bank"
    assert r.json()["pt_applicable"] is True
    r = client.post("/apis/v3/hr/employees", headers=hdr, json={
        **base, "name": "Exempt", "mobile": "9800000002", "pt_applicable": False})
    assert r.status_code == 201, r.text
    exempt_id = r.json()["id"]

    # Switching to cash drops the bank name with the other bank details.
    r = client.post("/apis/v3/hr/employees", headers=hdr, json={
        **base, "name": "Cashman", "mobile": "9800000003", "salary_paid_by": "cash", "bank_name": "SBI"})
    assert r.json()["bank_name"] is None

    run = _run(client, hdr, comp, project)
    assert run.status_code == 201, run.text
    slips = {p["employee_name"]: p for p in run.json()["payslips"]}
    assert slips["Sanjay"]["professional_tax"] == 200
    assert slips["Sanjay"]["net_payable"] == slips["Sanjay"]["gross_salary"] - 200
    assert slips["Exempt"]["professional_tax"] == 0
    stored = db.query(models.PayrollLineItem).filter(
        models.PayrollLineItem.employee_id == uuid.UUID(exempt_id)).one()
    assert float(stored.professional_tax) == 0

    r = client.get(f"/apis/v3/hr/payroll/{run.json()['id']}/payslips", headers=hdr)
    assert {p["employee_name"]: p["professional_tax"] for p in r.json()}["Sanjay"] == 200


def test_moved_employee_is_not_paid_twice_for_one_month(client, db, make_tenant, auth_headers):
    """Site A runs October payroll, then the person moves to Site B and Site B
    runs October. The person must be paid once, not on both sites."""
    comp, user, _ = make_tenant(company_name=f"Move Co {_SFX}", user_name="Mover",
                                email=f"move-{_SFX}@example.com")
    hdr = auth_headers(user, comp)
    a = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Site A", status="Ongoing")
    b = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Site B", status="Ongoing")
    db.add_all([a, b])
    db.commit()
    base = {"company_id": str(comp.id), "basic_salary": 20000, "pf_employee_pct": 0, "pf_employer_pct": 0}
    mover = client.post("/apis/v3/hr/employees", headers=hdr, json={**base, "name": "Mover", "project_id": str(a.id)}).json()
    client.post("/apis/v3/hr/employees", headers=hdr, json={**base, "name": "Stayer", "project_id": str(b.id)})

    assert _run(client, hdr, comp, a).status_code == 201
    r = client.put(f"/apis/v3/hr/employees/{mover['id']}", headers=hdr, json={"project_id": str(b.id)})
    assert r.status_code == 200, r.text
    run_b = _run(client, hdr, comp, b)
    assert run_b.status_code == 201, run_b.text
    assert [p["employee_name"] for p in run_b.json()["payslips"]] == ["Stayer"]
    paid = db.query(models.PayrollLineItem).filter(
        models.PayrollLineItem.employee_id == uuid.UUID(mover["id"])).count()
    assert paid == 1


def test_company_asset_keeps_serial_and_holder(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name=f"Asset Co {_SFX}", user_name="Asset",
                                email=f"asset-{_SFX}@example.com")
    hdr = auth_headers(user, comp)
    r = client.post("/apis/v3/equipment", headers=hdr, json={
        "company_id": str(comp.id), "name": "Dell Latitude", "code": "LAP-01", "category": "Laptop",
        "ownership_type": "Owned", "serial_number": "5CD123", "assigned_to": "Site Engineer Ravi"})
    assert r.status_code == 201, r.text
    assert r.json()["serial_number"] == "5CD123" and r.json()["assigned_to"] == "Site Engineer Ravi"
    r = client.put(f"/apis/v3/equipment/{r.json()['id']}", headers=hdr, json={"assigned_to": "Accounts Meena"})
    assert r.json()["assigned_to"] == "Accounts Meena"


def test_move_day_marked_at_both_sites_is_paid_once(client, db, make_tenant, auth_headers):
    """On the day someone moves, the old and new site supervisors both mark
    them Present. That is one day's pay, not two."""
    comp, user, _ = make_tenant(company_name=f"Day Co {_SFX}", user_name="Day",
                                email=f"day-{_SFX}@example.com")
    hdr = auth_headers(user, comp)
    a = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Old Site", status="Ongoing")
    b = models.Project(id=uuid.uuid4(), company_id=comp.id, name="New Site", status="Ongoing")
    db.add_all([a, b])
    db.commit()
    emp = client.post("/apis/v3/hr/employees", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(b.id), "name": "Shifter",
        "basic_salary": 26000, "pf_employee_pct": 0, "pf_employer_pct": 0}).json()
    for site in (a, b):
        r = client.post("/apis/v3/hr/attendance/manual", headers=hdr, json={
            "employee_id": emp["id"], "project_id": str(site.id),
            "attendance_date": "2026-10-15", "status": "Present"})
        assert r.status_code == 200, r.text
    logs = db.query(models.AttendanceLog).filter(models.AttendanceLog.employee_id == uuid.UUID(emp["id"])).all()
    assert len(logs) == 1 and logs[0].project_id == b.id

    # Even an older pair of entries for one day (e.g. a punch plus a muster)
    # is paid once.
    db.add(models.AttendanceLog(employee_id=uuid.UUID(emp["id"]), project_id=a.id,
                                attendance_date=datetime.datetime(2026, 10, 15, 6, 0, tzinfo=datetime.timezone.utc),
                                status="Present"))
    db.commit()
    run = client.post("/apis/v3/hr/payroll/run", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(b.id), "payroll_month": "2026-10"})
    assert run.status_code == 201, run.text
    assert run.json()["payslips"][0]["days_present"] == 1.0
