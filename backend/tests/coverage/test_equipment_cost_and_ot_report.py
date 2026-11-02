"""Machine cost and the overtime report follow the same rules as P&L and payroll.

Found driving a piling project with one owned crane and one hired rig:

1. Budget and the BI feed costed every deployment at 24 hours a day and
   ignored the machine hours recorded on site, so an owned crane that ran 80
   hours over ten days was booked at 240 hours.
2. They also costed hired machines at hours x rate, on top of the hire
   invoices that already carry that cost.
3. The OT report priced an hour of overtime at basic / 30 / 8 x 1.5 while
   payroll uses the month's real working days and the employee's own
   overtime rate, so the report and the payslip disagreed.
"""
import datetime
import uuid

from app import models
from app.routers.bi_export import _hash_key

_SFX = uuid.uuid4().hex[:6]
START = datetime.datetime(2026, 10, 1, tzinfo=datetime.timezone.utc)
END = datetime.datetime(2026, 10, 11, tzinfo=datetime.timezone.utc)


def _world(db, make_tenant, auth_headers, tag):
    comp, user, _team = make_tenant(
        company_name=f"ECO-{tag}-{_SFX}", user_name=f"ECO-{tag}",
        mobile=f"+9175{_SFX}{tag:02d}", email=f"eco-{tag}-{_SFX}@test.com",
    )
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Jetty", status="Ongoing", state="Maharashtra")
    db.add(project)
    db.commit()
    return comp, project, auth_headers(user, comp)


def _deploy(db, comp, project):
    crane = models.Equipment(id=uuid.uuid4(), company_id=comp.id, name="Crawler crane", code=f"CR-{_SFX}",
                             category="Crane", ownership_type="Owned", hourly_rate=1000)
    rig = models.Equipment(id=uuid.uuid4(), company_id=comp.id, name="Piling rig", code=f"RG-{_SFX}",
                           category="Rig", ownership_type="Hired", hourly_rate=1500)
    db.add_all([crane, rig])
    db.flush()
    db.add_all([
        models.EquipmentDeployment(id=uuid.uuid4(), equipment_id=crane.id, project_id=project.id,
                                   start_date=START, end_date=END, hours_used=80),
        models.EquipmentDeployment(id=uuid.uuid4(), equipment_id=rig.id, project_id=project.id,
                                   start_date=START, end_date=END),
    ])
    db.commit()


def test_budget_pnl_and_bi_cost_owned_machines_at_recorded_hours(client, db, make_tenant, auth_headers):
    comp, project, hdr = _world(db, make_tenant, auth_headers, 1)
    _deploy(db, comp, project)

    b = client.get(f"/apis/v3/budget/committed/{project.id}", headers=hdr).json()
    assert b["equipment_actual"] == 80000.0

    pl = {r["head"]: r for r in client.get(f"/apis/v3/finance/pl?project_id={project.id}", headers=hdr).json()}
    assert pl["Plant & Machinery"]["actual"] == 80000.0

    raw = f"bi-{_SFX}"
    db.add(models.BiApiKey(id=uuid.uuid4(), company_id=comp.id, label="test", key_hash=_hash_key(raw)))
    db.commit()
    r = client.get(f"/apis/v3/integrations/bi/feed/{comp.id}/budget-variance?fmt=json", headers={"X-API-Key": raw})
    assert r.status_code == 200, r.text
    body = r.json()
    rows = body if isinstance(body, list) else body.get("rows", body.get("data"))
    row = next(x for x in rows if str(x.get("project_id")) == str(project.id))
    assert row["equipment_actual"] == 80000.0


def test_ot_report_uses_payroll_rate(client, db, make_tenant, auth_headers):
    comp, project, hdr = _world(db, make_tenant, auth_headers, 2)
    comp.weekly_off_days = ["Sunday"]
    # November 2026 has five Sundays, so 25 working days.
    welder = models.StaffEmployee(id=uuid.uuid4(), company_id=comp.id, name=f"Welder {_SFX}", basic_salary=25000)
    fitter = models.StaffEmployee(id=uuid.uuid4(), company_id=comp.id, name=f"Fitter {_SFX}", basic_salary=25000)
    db.add_all([welder, fitter])
    db.flush()
    db.add(models.PayrollProfile(id=uuid.uuid4(), employee_id=fitter.id, company_id=comp.id, overtime_rate=200))
    day = datetime.datetime(2026, 11, 3, tzinfo=datetime.timezone.utc)
    db.add_all([
        models.AttendanceLog(id=uuid.uuid4(), employee_id=welder.id, project_id=project.id, attendance_date=day,
                             hours_worked=8, overtime_hours=4),
        models.AttendanceLog(id=uuid.uuid4(), employee_id=fitter.id, project_id=project.id, attendance_date=day,
                             hours_worked=8, overtime_hours=3),
    ])
    db.commit()

    r = client.get(f"/apis/v3/reports/data/ot-shift?company_id={comp.id}&project_id={project.id}", headers=hdr)
    assert r.status_code == 200, r.text
    rows = {row["Party Name"]: row for row in r.json()["rows"]}
    # 25000 / 25 / 8 x 1.5 = 187.50 an hour.
    assert rows[welder.name]["Overtime Earnings (INR)"] == 750.0
    assert rows[fitter.name]["Overtime Earnings (INR)"] == 600.0
