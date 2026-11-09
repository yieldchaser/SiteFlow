"""A company-wide payroll run reaches each project's labour cost.

Most firms run payroll once for the company, with no project on the run.
Project labour cost matched the run's project only, so it read zero on
every site even after Rs 7.29 lakh of salaries were finalized. Each line
now counts against the project its employee is posted to.
"""
import uuid

from app import models

_TAG = uuid.uuid4().hex[:8]


def test_company_run_splits_by_employee_project(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name=f"CPR-{_TAG}", user_name="CPR",
                                mobile="+9174" + str(int(_TAG, 16))[-8:], email=f"cpr-{_TAG}@test.com")
    hdr = auth_headers(user, comp)
    a = models.Project(id=uuid.uuid4(), company_id=comp.id, name="A", code=f"A-{_TAG}", status="Ongoing")
    b = models.Project(id=uuid.uuid4(), company_id=comp.id, name="B", code=f"B-{_TAG}", status="Ongoing")
    db.add_all([a, b])
    db.commit()
    ea = models.StaffEmployee(id=uuid.uuid4(), company_id=comp.id, project_id=a.id, name="Site engineer A")
    eb = models.StaffEmployee(id=uuid.uuid4(), company_id=comp.id, project_id=b.id, name="Site engineer B")
    eh = models.StaffEmployee(id=uuid.uuid4(), company_id=comp.id, project_id=None, name="Accountant")
    db.add_all([ea, eb, eh])
    db.commit()

    run = models.PayrollRun(id=uuid.uuid4(), company_id=comp.id, project_id=None, payroll_month="2026-09", status="finalized")
    draft = models.PayrollRun(id=uuid.uuid4(), company_id=comp.id, project_id=None, payroll_month="2026-10", status="draft")
    own = models.PayrollRun(id=uuid.uuid4(), company_id=comp.id, project_id=a.id, payroll_month="2026-09", status="finalized")
    db.add_all([run, draft, own])
    db.commit()

    def line(r, e, gross, pf=0.0):
        return models.PayrollLineItem(id=uuid.uuid4(), payroll_run_id=r.id, employee_id=e.id,
                                      gross_salary=gross, pf_employer=pf, net_payable=gross)
    db.add_all([
        line(run, ea, 40000.0, 1800.0),
        line(run, eb, 35000.0),
        line(run, eh, 50000.0),
        line(draft, ea, 99999.0),
        line(own, eb, 1000.0),   # a project A run counts in full for A
    ])
    db.commit()

    ra = client.get(f"/apis/v3/budget/committed/{a.id}", headers=hdr)
    rb = client.get(f"/apis/v3/budget/committed/{b.id}", headers=hdr)
    assert ra.status_code == 200 and rb.status_code == 200, (ra.text, rb.text)
    assert ra.json()["labour_actual"] == 41800.0 + 1000.0, ra.json()
    assert rb.json()["labour_actual"] == 35000.0, rb.json()
