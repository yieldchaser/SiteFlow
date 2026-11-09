"""The payslip list looked up each employee with its own query, so a run of
18 staff took four seconds on the live database and the Payroll tab showed
"No payroll run yet" the whole time. Employees now load in one query and the
slips come back sorted by name.
"""
import datetime
import uuid

from sqlalchemy import event

from app import models

_TAG = uuid.uuid4().hex[:8]


def test_payslips_load_employees_once_and_sort_by_name(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(
        company_name=f"PSQ-{_TAG}", user_name=f"PSQ-{_TAG}",
        mobile="+917" + str(int(_TAG, 16))[-8:],
        email=f"psq-{_TAG}@test.com",
    )
    hdr = auth_headers(user, comp)
    run = models.PayrollRun(id=uuid.uuid4(), company_id=comp.id, payroll_month="2026-09",
                            status="finalized", total_gross=0, total_deductions=0, total_net=0)
    db.add(run)
    db.flush()
    for name in ["Zubin", "Asha", "Mohan", "Kiran"]:
        emp = models.StaffEmployee(
            id=uuid.uuid4(), company_id=comp.id, name=f"{name} {_TAG}", status="active",
            basic_salary=20000.0, hra=0.0, other_allowances=0.0,
            pf_employee_pct=0.0, pf_employer_pct=0.0, esi_employee_pct=0.0,
            esi_employer_pct=0.0, tds_monthly=0.0, is_esi_applicable=False,
            date_of_joining=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc))
        db.add(emp)
        db.flush()
        db.add(models.PayrollLineItem(
            id=uuid.uuid4(), payroll_run_id=run.id, employee_id=emp.id,
            days_present=30, days_in_month=30, gross_salary=20000, basic=20000, hra=0,
            other_allowances=0, pf_employee=0, pf_employer=0, esi_employee=0, esi_employer=0,
            tds=0, advance_recovery=0, total_deductions=0, net_payable=20000))
    db.commit()

    bind = db.get_bind()
    staff_selects = []

    def _count(conn, cursor, statement, params, context, executemany):
        s = statement.lower()
        if s.lstrip().startswith("select") and "from staff_employees" in s and "payroll_line_items" not in s:
            staff_selects.append(statement)

    event.listen(bind, "before_cursor_execute", _count)
    try:
        r = client.get(f"/apis/v3/hr/payroll/{run.id}/payslips", headers=hdr)
    finally:
        event.remove(bind, "before_cursor_execute", _count)

    assert r.status_code == 200, r.text
    names = [p["employee_name"].split(" ")[0] for p in r.json()]
    assert names == ["Asha", "Kiran", "Mohan", "Zubin"], names
    assert len(staff_selects) <= 1, f"{len(staff_selects)} employee queries for 4 payslips"
