"""Payroll + billing calculation tests. These target silent-wrong-number bugs:
PF/ESI/TDS math, the ESI threshold, overtime, and the order-sensitive
Retention/TDS deduction engine. They call the SAME functions production uses."""
import datetime
import uuid

import pytest

from app import models
from app.routers.hr import _compute_payslip
from app.routers.billing import _sequential_deduction_calc, DeductionItemSchema


def _emp(**kw):
    e = models.StaffEmployee(id=uuid.uuid4())
    for k, v in kw.items():
        setattr(e, k, v)
    return e


def test_payslip_basic_math():
    e = _emp(
        basic_salary=10000, hra=2000, other_allowances=1000,
        pf_employee_pct=12, pf_employer_pct=12, esi_employee_pct=0.75,
        esi_employer_pct=3.25, tds_monthly=500, is_esi_applicable=True,
    )
    c = _compute_payslip(e, days_present=26, days_in_month=26, overtime_hours=0)
    assert c["gross_salary"] == 13000.0
    assert c["basic"] == 10000.0
    assert c["hra"] == 2000.0
    assert c["other_allowances"] == 1000.0
    assert c["pf_employee"] == 1200.0
    assert c["pf_employer"] == 1200.0
    assert c["esi_employee"] == 97.5
    assert c["esi_employer"] == 422.5
    assert c["tds"] == 500.0
    assert c["total_deductions"] == 1797.5
    assert c["net_payable"] == 11202.5


def test_payslip_esi_threshold_zero_above_21000():
    # Statutory ESI rule: not applicable when gross > 21000. If this branch
    # regresses, ESI would be wrongly deducted on high-earner payslips.
    # CD-4: PF wage ceiling caps PF wages at 15000, so 30k basic yields 1800 not 3600.
    e = _emp(
        basic_salary=30000, hra=5000, other_allowances=5000,
        pf_employee_pct=12, pf_employer_pct=12, esi_employee_pct=0.75,
        esi_employer_pct=3.25, tds_monthly=0, is_esi_applicable=True,
    )
    c = _compute_payslip(e, days_present=26, days_in_month=26, overtime_hours=0)
    assert c["gross_salary"] == 40000.0
    assert c["pf_employee"] == 1800.0  # capped at 15000 *12%
    assert c["esi_employee"] == 0.0
    assert c["esi_employer"] == 0.0
    # net_payable = gross - PF_employee - ESI_employee - TDS (employer-side
    # PF/ESI is a company cost, never withheld from the employee's net pay).
    assert c["net_payable"] == 40000.0 - 1800.0


def test_payslip_overtime():
    e = _emp(
        basic_salary=10000, hra=0, other_allowances=0,
        pf_employee_pct=12, pf_employer_pct=12, esi_employee_pct=0.75,
        esi_employer_pct=3.25, tds_monthly=0, is_esi_applicable=True,
    )
    c = _compute_payslip(e, days_present=26, days_in_month=26, overtime_hours=8)
    assert c["overtime_amount"] == pytest.approx(576.92, abs=0.05)
    assert c["gross_salary"] == pytest.approx(10576.92, abs=0.05)


def test_deduction_order_default_retention_first():
    # base = subtotal 100000 + 18% GST = 118000
    deductions = [
        DeductionItemSchema(deduction_type="Retention", amount=0.0, percentage=5.0),
        DeductionItemSchema(deduction_type="TDS", amount=0.0, percentage=10.0),
    ]
    details, total = _sequential_deduction_calc(deductions, 118000.0, pretax_order=False)
    amts = {d.deduction_type: amt for d, amt in details}
    # TDS is on the full base (Sec 194C); retention on gross too.
    assert amts["Retention"] == 5900.0
    assert amts["TDS"] == 11800.0
    assert total == 17700.0


def test_deduction_order_pretax_tds_first():
    # Pre-tax ordering flips the contractual deductions; TDS stays on the full base.
    deductions = [
        DeductionItemSchema(deduction_type="Retention", amount=0.0, percentage=5.0),
        DeductionItemSchema(deduction_type="TDS", amount=0.0, percentage=10.0),
        DeductionItemSchema(deduction_type="Security Deposit", amount=0.0, percentage=10.0),
    ]
    details, total = _sequential_deduction_calc(deductions, 118000.0, pretax_order=True)
    amts = {d.deduction_type: amt for d, amt in details}
    assert amts["TDS"] == 11800.0
    assert amts["Security Deposit"] == 11800.0
    # Retention on what the deposit leaves: 5% of 106200.
    assert amts["Retention"] == 5310.0
    assert total == 28910.0
