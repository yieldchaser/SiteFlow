"""Company attendance report: an absent day is 0 hours (it showed 8), and a
manual marking is not reported as 'Outside' the site fence."""
import uuid

from app import models
from tests.coverage.test_domain_formula_fixes import _mk_project, _utc

_TAG = uuid.uuid4().hex[:8]
_MOB = "+9177" + str(int(_TAG, 16))[-8:]
_MAIL = f"t-{_TAG}@test.com"


def test_absent_day_reports_zero_hours(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(company_name="AR1", user_name="UAR1", mobile=_MOB, email=_MAIL)
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)
    emp = models.StaffEmployee(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, name="Mason",
        status="active", basic_salary=1000.0, hra=0.0, other_allowances=0.0,
        pf_employee_pct=0.0, pf_employer_pct=0.0, esi_employee_pct=0.0,
        esi_employer_pct=0.0, tds_monthly=0.0, is_esi_applicable=False)
    db.add(emp)
    db.flush()
    for d, status in ((1, "Absent"), (2, "Half Day"), (3, "Present")):
        db.add(models.AttendanceLog(
            id=uuid.uuid4(), employee_id=emp.id, project_id=project.id,
            attendance_date=_utc(2026, 1, d, 9), status=status, marked_manually=True))
    db.commit()

    r = client.get(f"/apis/v3/reports/data/company-attendance?company_id={comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    by_status = {row["Status"]: row for row in r.json()["rows"]}
    assert float(by_status["Absent"]["Hours Worked"]) == 0
    assert float(by_status["Half Day"]["Hours Worked"]) == 4
    assert float(by_status["Present"]["Hours Worked"]) == 8
    assert by_status["Present"]["Geofence Status"] == "Marked manually"
