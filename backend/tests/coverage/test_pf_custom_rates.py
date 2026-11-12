"""PF at 12%, 25% or any other rate: what VCPL asked for, and what follows from it.

1. Company payroll settings accept a PF rate above 12% (voluntary PF).
2. A person on 25% PF is deducted 25% of basic, capped at the PF wage ceiling.
3. The PF return lists only people who paid PF; a no-PF worker without a UAN
   no longer blocks it.
4. The PF return's wages are the month's basic up to the ceiling, even after
   the person's rate changes later.
5. The staff form offers 12%, 25% and any typed rate, and saving an employee
   sends the rate on screen (it used to reset everyone to 12%).
"""
import datetime
import pathlib
import uuid

from app import models
from app.routers.hr import _compute_payslip

FRONT = pathlib.Path(__file__).resolve().parents[3] / "frontend" / "src" / "app" / "c" / "[company_id]"


def _tenant(make_tenant, auth_headers):
    sfx = uuid.uuid4().hex[:8]
    comp, user, _ = make_tenant(
        company_name=f"PFR-{sfx}", user_name=f"UPFR-{sfx}", mobile=f"+9195{sfx}", email=f"pfr-{sfx}@test.com",
    )
    return comp, auth_headers(user, comp)


def _project(db, comp):
    p = models.Project(id=uuid.uuid4(), company_id=comp.id, name="PFR-Proj",
                       code=f"PRJ-PFR-{uuid.uuid4().hex[:6]}", status="Ongoing", state="Karnataka")
    db.add(p)
    db.commit()
    return p


def _employee(db, comp, project, name, basic, pf_ee, pf_er, uan):
    e = models.StaffEmployee(id=uuid.uuid4(), company_id=comp.id, project_id=project.id, name=name,
                             employee_code=f"E-{uuid.uuid4().hex[:5]}", basic_salary=basic, status="active",
                             pf_employee_pct=pf_ee, pf_employer_pct=pf_er, uan=uan)
    db.add(e)
    db.commit()
    return e


def test_payroll_settings_accept_25_percent_pf(client, make_tenant, auth_headers):
    comp, hdr = _tenant(make_tenant, auth_headers)
    res = client.put(f"/apis/v3/settings/payroll/{comp.id}", headers=hdr,
                     json={"pf_employee_pct": 25, "pf_employer_pct": 12, "confirm_changes": True})
    assert res.status_code == 200, res.text
    assert float(res.json()["pf_employee_pct"]) == 25.0


def test_payslip_takes_25_percent_of_capped_basic():
    emp = models.StaffEmployee(basic_salary=40000.0, hra=0.0, other_allowances=0.0, pf_employee_pct=25.0,
                               pf_employer_pct=12.0, esi_employee_pct=0.75, esi_employer_pct=3.25,
                               is_esi_applicable=False, tds_monthly=0.0)
    slip = _compute_payslip(emp, 30, 30, pf_wage_ceiling=15000.0)
    assert slip["pf_employee"] == 3750.0
    assert slip["pf_employer"] == 1800.0
    # A company with no ceiling set (cap above basic) takes 25% of the full basic.
    slip = _compute_payslip(emp, 30, 30, pf_wage_ceiling=100000.0)
    assert slip["pf_employee"] == 10000.0


def test_pf_return_skips_no_pf_staff_and_keeps_wages_after_rate_change(client, db, make_tenant, auth_headers):
    comp, hdr = _tenant(make_tenant, auth_headers)
    project = _project(db, comp)
    payer = _employee(db, comp, project, "Ramesh Vpf", 20000.0, 25.0, 12.0, "100200300400")
    _employee(db, comp, project, "Mohan NoPf", 12000.0, 0.0, 0.0, None)
    for emp in db.query(models.StaffEmployee).filter(models.StaffEmployee.company_id == comp.id):
        db.add(models.AttendanceLog(id=uuid.uuid4(), project_id=project.id, employee_id=emp.id, status="Present",
                                    attendance_date=datetime.datetime(2026, 8, 3, 9, 0, tzinfo=datetime.timezone.utc)))
    db.commit()
    run = client.post("/apis/v3/hr/payroll/run", headers=hdr,
                      json={"company_id": str(comp.id), "project_id": str(project.id), "payroll_month": "2026-08"})
    assert run.status_code == 201, run.text
    row = db.query(models.PayrollRun).filter(models.PayrollRun.id == uuid.UUID(run.json()["id"])).first()
    row.status = "finalized"
    li = db.query(models.PayrollLineItem).filter(models.PayrollLineItem.employee_id == payer.id).one()
    capped = min(float(li.basic), 15000.0)
    assert float(li.pf_employee) == round(capped * 0.25, 2)
    # The rate changes after the month was paid.
    payer.pf_employee_pct = 12.0
    db.commit()

    res = client.get(f"/apis/v3/statutory/{comp.id}/pf-ecr?month=8&year=2026", headers=hdr)
    assert res.status_code == 200, res.text
    lines = res.json()["ecr_lines"]
    assert [x["name"] for x in lines] == ["Ramesh Vpf"]
    assert lines[0]["pf_wages"] == round(capped, 2)
    assert lines[0]["ee_pf_contribution"] == round(capped * 0.25, 2)


def test_staff_form_offers_12_25_and_any_rate():
    src = (FRONT / "d" / "hr" / "page.tsx").read_text(encoding="utf-8")
    assert 'PF_PRESETS = ["12", "25"]' in src
    assert "Other rate" in src
    assert "pfOn ? 12" not in src
    assert "esi_employee_pct: 0.75" not in src
    assert "Employee 12%" not in src and "Employer 12%" not in src


def test_po_gst_offers_every_slab_and_any_rate():
    src = (FRONT / "d" / "procurement" / "page.tsx").read_text(encoding="utf-8")
    assert "GST_PRESETS = [0, 0.25, 3, 5, 12, 18, 28, 40]" in src
    assert "GST rate in percent" in src
