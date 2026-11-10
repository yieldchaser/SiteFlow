"""Overtime starts after the employee's own shift, not after a fixed 8 hours.

Payroll details let you set a 10-hour shift for site staff, but every punch
(biometric machine and phone punch-out) counted overtime after 8 hours, so a
normal 10-hour day became 2 hours of paid overtime. The default overtime rate
also took the hourly basic from an 8-hour day.
"""
import uuid
from decimal import Decimal

from app import models
from app.routers.hr import _compute_payslip
from tests.coverage.test_biometric_attendance import _setup


def test_biometric_overtime_after_a_ten_hour_shift(client, db, make_tenant, auth_headers):
    comp, hdr, project, rajesh, _sunil, sfx = _setup(db, make_tenant, auth_headers, "OT")
    db.add(models.PayrollProfile(employee_id=rajesh.id, company_id=comp.id, salary_amount=Decimal("0"),
                                 shift_hours=Decimal("10"), overtime_rate=Decimal("0")))
    db.commit()
    sn = f"OT{sfx}"
    assert client.post("/apis/v3/biometric/devices", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id), "serial_number": sn, "name": "Gate",
    }).status_code == 201
    body = "101\t2026-10-21 08:00:00\t0\t1\t0\t0\n101\t2026-10-21 19:00:00\t1\t1\t0\t0\n"
    assert client.post(f"/iclock/cdata?SN={sn}&table=ATTLOG", content=body).status_code == 200
    log = db.query(models.AttendanceLog).filter(models.AttendanceLog.employee_id == rajesh.id).one()
    assert float(log.hours_worked) == 11.0
    assert float(log.overtime_hours) == 1.0


def test_default_overtime_rate_uses_the_shift_length():
    emp = models.StaffEmployee(id=uuid.uuid4(), company_id=uuid.uuid4(), name="X",
                               basic_salary=Decimal("30000"), hra=Decimal("0"), other_allowances=Decimal("0"),
                               pf_employee_pct=Decimal("12"), pf_employer_pct=Decimal("12"),
                               esi_employee_pct=Decimal("0.75"), esi_employer_pct=Decimal("3.25"),
                               tds_monthly=Decimal("0"), is_esi_applicable=False, pt_applicable=False)
    # 30000 / 30 days / 10 hours = 100 an hour; 1.5x = 150; 4 hours = 600.
    calc = _compute_payslip(emp, 30, 30, overtime_hours=4, shift_hours=10)
    assert calc["overtime_amount"] == 600.0
