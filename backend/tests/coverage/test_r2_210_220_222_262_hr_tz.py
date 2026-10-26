"""R2-210 / R2-220 / R2-222 / R2-262 - naive/aware datetime mixing (HR + statutory).

AttendanceLog.punch_in/punch_out/attendance_date and StatutoryReport.due_date
are DateTime(timezone=True): they round-trip AWARE on Postgres but NAIVE on
SQLite. hr.py punched with naive datetime.utcnow() and subtracted it from the
loaded column, so punch-out raised TypeError (R2-210/R2-262), leaving rows
open with hours_worked NULL. The payroll month bounds were naive too
(R2-220), and Holiday.date was stored verbatim so an offset input shifted the
calendar day on Postgres. statutory._enrich mixed utcnow() with an aware
due_date (R2-222). All operands are now normalized to aware UTC.

Gate: a punch-in followed by punch-out returns 200 with hours_worked set even
when the loaded columns behave like Postgres (aware), holidays keep their
calendar date at UTC midnight for a +05:30 input, the payroll month filter
does not leak attendance across the month boundary, and the statutory overdue
delta computes instead of erroring.
"""
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import event
from sqlalchemy.orm import attributes

from app import models

_SUFFIX = uuid.uuid4().hex[:8]


def _aware_load(model, *columns):
    """Simulate Postgres result processing: coerce columns to aware UTC on load."""

    def _coerce(target, context):
        for col in columns:
            val = getattr(target, col, None)
            if val is not None and val.tzinfo is None:
                attributes.set_committed_value(
                    target, col, val.replace(tzinfo=timezone.utc)
                )

    class _Ctx:
        def __enter__(self):
            event.listen(model, "load", _coerce)
            return self

        def __exit__(self, *exc):
            event.remove(model, "load", _coerce)
            return False

    return _Ctx()


def _tenant(make_tenant, auth_headers):
    sfx = uuid.uuid4().hex[:8]
    comp, user, _team = make_tenant(
        company_name=f"R210TZ{sfx}", user_name=f"U{sfx}",
        mobile=f"+9199{sfx}", email=f"r210-{sfx}@test.com",
    )
    return comp, auth_headers(user, comp)


def _project(db, comp):
    p = models.Project(
        id=uuid.uuid4(), company_id=comp.id,
        name=f"P-TZ-{_SUFFIX}", code=f"PRJ-TZ-{uuid.uuid4().hex[:8]}", status="Ongoing",
    )
    db.add(p)
    db.commit()
    return p


def _employee(db, comp, project, name):
    e = models.StaffEmployee(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        name=f"{name}-{uuid.uuid4().hex[:6]}", basic_salary=Decimal("18000"),
    )
    db.add(e)
    db.commit()
    return e


def _punch(client, hdr, emp, project, kind):
    return client.post("/apis/v3/hr/attendance/punch", headers=hdr, json={
        "employee_id": str(emp.id), "project_id": str(project.id),
        "lat": 12.9716, "lng": 77.5946, "punch_type": kind,
    })


def test_punch_out_sets_hours_worked_and_open_row_repunch_works(client, db, make_tenant, auth_headers):
    comp, hdr = _tenant(make_tenant, auth_headers)
    project = _project(db, comp)
    emp1 = _employee(db, comp, project, f"W1{_SUFFIX}")
    emp2 = _employee(db, comp, project, f"W2{_SUFFIX}")

    with _aware_load(models.AttendanceLog, "attendance_date", "punch_in", "punch_out"):
        r_in = _punch(client, hdr, emp1, project, "in")
        assert r_in.status_code == 201, r_in.text

        # Backdate the open punch-in by 2h for a deterministic delta.
        row = db.query(models.AttendanceLog).filter(
            models.AttendanceLog.id == r_in.json()["id"]
        ).first()
        row.punch_in = row.punch_in - timedelta(hours=2)
        db.commit()

        # The crashed-punch-out leftover (open row, hours_worked NULL) must
        # close cleanly now instead of TypeError-ing. The route declares 201.
        r_out = _punch(client, hdr, emp1, project, "out")
        assert r_out.status_code == 201, r_out.text
        body = r_out.json()
        assert body["hours_worked"] is not None, r_out.text
        assert abs(body["hours_worked"] - 2.0) < 0.02, r_out.text
        assert body["overtime_hours"] == 0.0, r_out.text

        # A fresh punch cycle for the next employee still works afterwards.
        r2_in = _punch(client, hdr, emp2, project, "in")
        assert r2_in.status_code == 201, r2_in.text
        r2_out = _punch(client, hdr, emp2, project, "out")
        assert r2_out.status_code == 201, r2_out.text
        assert r2_out.json()["hours_worked"] is not None, r2_out.text


def test_holiday_keeps_calendar_date_for_ist_offset_company(client, db, make_tenant, auth_headers):
    comp, hdr = _tenant(make_tenant, auth_headers)

    # Midnight IST (+05:30) is 18:30 UTC the previous evening; storing the
    # value verbatim shifts the calendar day on Postgres.
    r = client.post(f"/apis/v3/hr/holidays/{comp.id}", headers=hdr, json={
        "name": f"Diwali-{_SUFFIX}", "date": "2026-11-08T00:00:00+05:30",
    })
    assert r.status_code == 201, r.text
    assert r.json()["date"].startswith("2026-11-08T00:00:00"), r.text

    hid = r.json()["id"]
    r2 = client.put(f"/apis/v3/hr/holidays/{hid}", headers=hdr, json={
        "date": "2027-01-26T09:00:00+05:30",
    })
    assert r2.status_code == 200, r2.text
    assert r2.json()["date"].startswith("2027-01-26T00:00:00"), r2.text

    r3 = client.get(f"/apis/v3/hr/holidays/{comp.id}", headers=hdr)
    assert r3.status_code == 200, r3.text
    dates = [x["date"] for x in r3.json() if x["id"] == hid]
    assert dates and dates[0].startswith("2027-01-26T00:00:00"), r3.text


def test_payroll_month_filter_does_not_leak_across_boundary(client, db, make_tenant, auth_headers):
    comp, hdr = _tenant(make_tenant, auth_headers)
    project = _project(db, comp)
    emp = _employee(db, comp, project, f"WB{_SUFFIX}")

    # Days are Indian calendar days: 19:30Z on 31 Jan is 01:00 IST on 1 Feb, so it
    # belongs to February (a UTC-day reading put it in January).
    jan_last = datetime(2026, 1, 31, 12, 0, tzinfo=timezone.utc)
    feb_first = datetime(2026, 1, 31, 19, 30, tzinfo=timezone.utc)
    for dt, ot in ((jan_last, "1.5"), (feb_first, "4.0")):
        db.add(models.AttendanceLog(
            id=uuid.uuid4(), employee_id=emp.id, project_id=project.id,
            attendance_date=dt, punch_in=dt, status="Present",
            is_within_geofence=True, shift_multiplier=Decimal("1"),
            hours_worked=Decimal("8"), overtime_hours=Decimal(ot),
        ))
    db.commit()

    def _ot_amount(days_in_month, ot_hours):
        rate = (18000.0 / days_in_month / 8.0) * 1.5
        return round(ot_hours * rate, 2)

    r = client.post("/apis/v3/hr/payroll/run", headers=hdr, json={
        "company_id": str(comp.id), "payroll_month": "2026-01",
        "days_in_month": 31,
    })
    assert r.status_code == 201, r.text
    slip_jan = r.json()["payslips"][0]
    assert slip_jan["days_present"] == pytest.approx(1.0), r.text
    assert slip_jan["overtime_amount"] == pytest.approx(_ot_amount(31, 1.5)), r.text

    r2 = client.post("/apis/v3/hr/payroll/run", headers=hdr, json={
        "company_id": str(comp.id), "payroll_month": "2026-02",
        "days_in_month": 28,
    })
    assert r2.status_code == 201, r2.text
    slip_feb = [p for p in r2.json()["payslips"] if p["employee_id"] == str(emp.id)][0]
    assert slip_feb["days_present"] == pytest.approx(1.0), r2.text
    assert slip_feb["overtime_amount"] == pytest.approx(_ot_amount(28, 4.0)), r2.text


def test_statutory_overdue_delta_computes_with_aware_due_date(client, db, make_tenant, auth_headers):
    comp, hdr = _tenant(make_tenant, auth_headers)

    overdue = models.StatutoryReport(
        id=uuid.uuid4(), company_id=comp.id, report_type="pf",
        return_period="2026-06", status="draft",
        due_date=datetime.now(timezone.utc) - timedelta(days=10, hours=1),
    )
    filed = models.StatutoryReport(
        id=uuid.uuid4(), company_id=comp.id, report_type="esi",
        return_period="2026-06", status="filed",
        due_date=datetime.now(timezone.utc) - timedelta(days=99),
    )
    db.add_all([overdue, filed])
    db.commit()

    with _aware_load(models.StatutoryReport, "due_date"):
        r = client.get(f"/apis/v3/statutory/{comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    by_type = {x["report_type"]: x for x in r.json()}
    assert by_type["pf"]["days_overdue"] == 10, r.text
    assert by_type["esi"]["days_overdue"] == 0, r.text
