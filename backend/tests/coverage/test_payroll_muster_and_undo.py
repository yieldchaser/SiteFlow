"""Payroll defects found running a month end to end as a new company would.

1. The supervisor muster offers Half Day and Paid Leave, but payroll counted
   only Present, so a half day paid nothing and a muster paid leave was docked.
2. A muster Paid Leave on a day an approved leave request already covers is
   still one day, not two.
3. A run is finalized as soon as it is computed and only one run per month is
   allowed, so a run made too early could never be redone. It can now be
   undone, unless a PF/ESI return for the month is already filed.
"""
import datetime
import uuid

from app import models

_SFX = uuid.uuid4().hex[:6]


def _setup(db, make_tenant, auth_headers, tag):
    comp, user, _team = make_tenant(
        company_name=f"PMU-{tag}-{_SFX}", user_name=f"PMU-{tag}",
        mobile=f"+9188{_SFX}{tag:02d}", email=f"pmu-{tag}-{_SFX}@test.com",
    )
    comp.weekly_off_days = ["Sunday"]
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Jetty", status="Ongoing")
    db.add(project)
    db.flush()
    emp = models.StaffEmployee(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, name=f"Mohan {tag}",
        status="active", basic_salary=27000.0, hra=0.0, other_allowances=0.0,
        pf_employee_pct=0.0, pf_employer_pct=0.0, esi_employee_pct=0.0,
        esi_employer_pct=0.0, tds_monthly=0.0, is_esi_applicable=False,
        date_of_joining=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc))
    db.add(emp)
    db.commit()
    return comp, project, emp, auth_headers(user, comp)


def _mark_month(client, hdr, project, emp, special):
    # October 2026: 27 working days with Sunday off.
    for d in range(1, 32):
        day = datetime.date(2026, 10, d)
        if day.weekday() == 6:
            continue
        status = special.get(d, "Present")
        if status is None:
            continue
        r = client.post("/apis/v3/hr/attendance/manual", headers=hdr, json={
            "employee_id": str(emp.id), "project_id": str(project.id),
            "attendance_date": day.isoformat(), "status": status})
        assert r.status_code == 200, r.text


def _run(client, hdr, comp, project):
    return client.post("/apis/v3/hr/payroll/run", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id), "payroll_month": "2026-10"})


def test_half_day_and_muster_paid_leave_are_paid(client, db, make_tenant, auth_headers):
    comp, project, emp, hdr = _setup(db, make_tenant, auth_headers, 1)
    # 24 present, 1 half day, 2 paid leave on the muster: 26.5 of 27 paid days.
    _mark_month(client, hdr, project, emp, {14: "Half Day", 15: "Paid Leave", 16: "Paid Leave"})

    r = _run(client, hdr, comp, project)
    assert r.status_code == 201, r.text
    slip = r.json()["payslips"][0]
    assert slip["days_in_month"] == 27, slip
    assert slip["days_present"] == 26.5, slip
    assert slip["gross_salary"] == 26500.0, slip


def test_muster_paid_leave_on_an_approved_leave_day_counts_once(client, db, make_tenant, auth_headers):
    comp, project, emp, hdr = _setup(db, make_tenant, auth_headers, 2)
    # Absent on the 15th and 16th apart from leave; the muster also says
    # Paid Leave on the 15th, which the approved request already covers.
    _mark_month(client, hdr, project, emp, {15: "Paid Leave", 16: None})
    db.add(models.LeaveRequest(
        id=uuid.uuid4(), company_id=comp.id, employee_id=emp.id, employee_name=emp.name,
        leave_type="casual", status="Approved", days_count=2.0,
        start_date=datetime.datetime(2026, 10, 15, tzinfo=datetime.timezone.utc),
        end_date=datetime.datetime(2026, 10, 16, tzinfo=datetime.timezone.utc)))
    db.commit()

    slip = _run(client, hdr, comp, project).json()["payslips"][0]
    assert slip["days_present"] == 27.0, slip


def test_payroll_run_can_be_undone_and_run_again(client, db, make_tenant, auth_headers):
    comp, project, emp, hdr = _setup(db, make_tenant, auth_headers, 3)
    _mark_month(client, hdr, project, emp, {20: None, 21: None})
    first = _run(client, hdr, comp, project)
    assert first.status_code == 201, first.text
    run_id = first.json()["id"]
    assert _run(client, hdr, comp, project).status_code == 409

    # The two missing days turn out to have been worked.
    _mark_month(client, hdr, project, emp, {})
    r = client.delete(f"/apis/v3/hr/payroll/{run_id}", headers=hdr)
    assert r.status_code == 204, r.text
    assert db.query(models.PayrollLineItem).filter(models.PayrollLineItem.payroll_run_id == uuid.UUID(run_id)).count() == 0
    log = db.query(models.DeleteLog).filter(models.DeleteLog.entity_id == run_id).one()
    assert log.entity_type == "payroll_run" and log.deleted_by

    again = _run(client, hdr, comp, project)
    assert again.status_code == 201, again.text
    assert again.json()["payslips"][0]["days_present"] == 27.0


def test_payroll_run_cannot_be_undone_after_its_return_is_filed(client, db, make_tenant, auth_headers):
    comp, project, emp, hdr = _setup(db, make_tenant, auth_headers, 4)
    _mark_month(client, hdr, project, emp, {})
    run_id = _run(client, hdr, comp, project).json()["id"]
    db.add(models.StatutoryReport(
        id=uuid.uuid4(), company_id=comp.id, report_type="pf", return_period="2026-10", status="filed"))
    db.commit()

    r = client.delete(f"/apis/v3/hr/payroll/{run_id}", headers=hdr)
    assert r.status_code == 409, r.text
    assert "filed" in r.json()["detail"]
    assert db.query(models.PayrollRun).filter(models.PayrollRun.id == uuid.UUID(run_id)).count() == 1


def test_payroll_run_undo_is_tenant_scoped(client, db, make_tenant, auth_headers):
    comp, project, emp, hdr = _setup(db, make_tenant, auth_headers, 5)
    _mark_month(client, hdr, project, emp, {})
    run_id = _run(client, hdr, comp, project).json()["id"]
    _c2, _p2, _e2, other_hdr = _setup(db, make_tenant, auth_headers, 6)

    r = client.delete(f"/apis/v3/hr/payroll/{run_id}", headers=other_hdr)
    assert r.status_code in (403, 404), r.text
    assert db.query(models.PayrollRun).filter(models.PayrollRun.id == uuid.UUID(run_id)).count() == 1


def test_attendance_salary_report_counts_a_half_day_as_half(client, db, make_tenant, auth_headers):
    comp, project, emp, hdr = _setup(db, make_tenant, auth_headers, 7)
    _mark_month(client, hdr, project, emp, {14: "Half Day", 15: "Paid Leave"})

    r = client.get(f"/apis/v3/reports/data/attendance-salary?company_id={comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    row = [x for x in r.json()["rows"] if x["Party Name"] == emp.name][0]
    # 25 present plus one half day; the paid leave is not a present day.
    assert row["Total Present Days"] == 25.5, row
