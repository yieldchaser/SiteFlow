"""R2-409 - the payslip CSV export carried no pay period, no payroll run id and no company/project, so the file could not be filed, archived or reconciled.

The exported header stopped at the money columns: `Days In Month 26` appeared
but the month did not, three same-named rows shared one name with nothing to
tell them apart, and there was no way to tie a downloaded file back to the run
that produced it. Employee Code had already been added by an earlier wave;
the schema-supported identity block (pay period, run id, company, project)
was still missing. PAN/PF/UAN/ESI numbers have no source columns on
StaffEmployee and remain a report-only gap.

Gate: every row now carries Pay Period, Payroll Run ID, Company and Project
(appended after the original columns so index-based readers keep working),
and same-named employees stay distinguishable through the employee-code
column including its per-row uuid fallback.
"""
import csv
import io
import uuid
from decimal import Decimal

from app import models


def _mk_employee(db, comp, project, name, code):
    emp = models.StaffEmployee(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        name=name, employee_code=code, designation="Site Engineer",
        basic_salary=Decimal("15000"), hra=Decimal("5400"),
        other_allowances=Decimal("3000"), status="active",
    )
    db.add(emp)
    return emp


def test_r2_409_payslip_csv_carries_pay_period_run_and_reconciliation_ids(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(
        company_name="R2409 Co", user_name="U409",
        mobile="+9192409001", email="r409@test.com",
    )
    hdr = auth_headers(user, comp)
    project = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name="P409",
        code="PRJ-409", status="Ongoing",
    )
    db.add(project)
    # Two employees sharing one name: one coded, one uncoded (uuid fallback).
    e1 = _mk_employee(db, comp, project, "ZZ QA Dup", "EMP-409-1")
    e2 = _mk_employee(db, comp, project, "ZZ QA Dup", None)
    run = models.PayrollRun(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        payroll_month="2026-07", status="finalized",
    )
    db.add(run)
    db.add_all([
        models.PayrollLineItem(
            payroll_run_id=run.id, employee_id=e1.id,
            days_present=Decimal("26.0"), days_in_month=26,
            gross_salary=Decimal("23400"), net_payable=Decimal("21240"),
        ),
        models.PayrollLineItem(
            payroll_run_id=run.id, employee_id=e2.id,
            days_present=Decimal("20.0"), days_in_month=26,
            gross_salary=Decimal("18000"), net_payable=Decimal("16000"),
        ),
    ])
    db.commit()

    r = client.get(f"/apis/v3/hr/payroll/{run.id}/payslips/export", headers=hdr)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/csv"), r.headers

    rows = list(csv.DictReader(io.StringIO(r.content.decode("utf-8-sig"))))
    assert len(rows) == 2, r.text

    # The original money columns are untouched and the identity block exists.
    assert list(rows[0].keys())[:15] == [
        "Employee Code", "Employee Name", "Designation", "Days Present", "Days In Month",
        "Gross", "PF Employee", "PF Employer", "ESI Employee", "ESI Employer",
        "TDS", "Advance Recovery", "Other Deductions", "Total Deductions", "Net Pay",
    ]
    assert list(rows[0].keys())[15:] == ["Pay Period", "Payroll Run ID", "Company", "Project", "Professional Tax"]

    # Every row names its period, run, company and project.
    assert {row["Pay Period"] for row in rows} == {"2026-07"}, rows
    assert {row["Payroll Run ID"] for row in rows} == {str(run.id)}, rows
    assert {row["Company"] for row in rows} == {"R2409 Co"}, rows
    assert {row["Project"] for row in rows} == {"P409"}, rows

    # Same-named employees stay distinguishable through the identifier columns.
    codes = [row["Employee Code"] for row in rows]
    assert len(set(codes)) == 2, codes
    assert "EMP-409-1" in codes
