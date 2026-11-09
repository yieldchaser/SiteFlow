"""A payslip downloads as that one employee's PDF on the company letterhead.

The Download button beside each employee used to print the whole dashboard:
sidebar, every other employee's pay, and no payslip layout at all."""
import datetime
import uuid

from app import models

_TAG = uuid.uuid4().hex[:8]


def _run_with_slip(db, comp, other_comp=False):
    run = models.PayrollRun(id=uuid.uuid4(), company_id=comp.id, payroll_month="2026-09",
                            status="finalized", total_gross=0, total_deductions=0, total_net=0)
    db.add(run)
    db.flush()
    emp = models.StaffEmployee(
        id=uuid.uuid4(), company_id=comp.id, name=f"Asha Patil {_TAG}", status="active",
        employee_code="VC-014", designation="Site Engineer", uan="100200300400",
        bank_account="001234567890", bank_name="HDFC Bank", salary_paid_by="bank",
        basic_salary=15000.0, hra=6000.0, other_allowances=3000.0,
        pf_employee_pct=12.0, pf_employer_pct=12.0, esi_employee_pct=0.0,
        esi_employer_pct=0.0, tds_monthly=0.0, is_esi_applicable=False,
        date_of_joining=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc))
    db.add(emp)
    db.flush()
    line = models.PayrollLineItem(
        id=uuid.uuid4(), payroll_run_id=run.id, employee_id=emp.id,
        days_present=26, days_in_month=26, gross_salary=24000, basic=15000, hra=6000,
        other_allowances=3000, pf_employee=1800, pf_employer=1800, esi_employee=0, esi_employer=0,
        tds=0, professional_tax=200, advance_recovery=0, total_deductions=2000, net_payable=22000)
    db.add(line)
    db.commit()
    return run, line


def test_payslip_pdf_is_one_employee_on_letterhead(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(
        company_name=f"PSP-{_TAG}", user_name=f"PSP-{_TAG}",
        mobile="+917" + str(int(_TAG, 16))[-8:], email=f"psp-{_TAG}@test.com",
    )
    run, line = _run_with_slip(db, comp)
    r = client.get(f"/apis/v3/hr/payroll/{run.id}/payslips/{line.id}/pdf", headers=auth_headers(user, comp))
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    assert f"Payslip-Asha Patil {_TAG}-2026-09.pdf" in r.headers["content-disposition"]
    body = r.content
    assert body.startswith(b"%PDF-1.4")
    for expected in (
        b"Payslip for September 2026",
        f"Employee: Asha Patil {_TAG}".encode(),
        b"Employee Code: VC-014",
        b"Days Paid: 26 of 26",
        b"UAN: 100200300400",
        b"Bank Account: XXXX7890",
        b"Professional Tax",
        b"Net Pay: 22,000.00",
        b"Twenty Two Thousand",
        b"PF Rs 1,800.00",
    ):
        assert expected in body, expected
    assert b"001234567890" not in body  # full account number never printed


def test_payslip_pdf_refuses_another_company(client, db, make_tenant, auth_headers):
    comp, _user, _team = make_tenant(
        company_name=f"PSP2-{_TAG}", user_name=f"PSP2-{_TAG}",
        mobile="+916" + str(int(_TAG, 16))[-8:], email=f"psp2-{_TAG}@test.com",
    )
    run, line = _run_with_slip(db, comp)
    other, outsider, _t = make_tenant(
        company_name=f"PSP3-{_TAG}", user_name=f"PSP3-{_TAG}",
        mobile="+918" + str(int(_TAG, 16))[-8:], email=f"psp3-{_TAG}@test.com",
    )
    r = client.get(f"/apis/v3/hr/payroll/{run.id}/payslips/{line.id}/pdf", headers=auth_headers(outsider, other))
    assert r.status_code in (403, 404), r.status_code
