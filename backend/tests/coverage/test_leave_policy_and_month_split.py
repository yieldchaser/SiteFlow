"""Leave, driven as a company would use it.

1. A leave crossing a month end was paid in full in both months: 30 Oct to
   2 Nov added 4 paid days to October and 4 again to November.
2. Approving never looked at the leave policy, so 10 casual days could be
   approved against a 2-day quota and paid.
3. An application whose end date is before its start date was accepted.
"""
import datetime
import uuid

from app import models
from tests.coverage.test_payroll_muster_and_undo import _mark_month, _run, _setup

UTC = datetime.timezone.utc


def _apply(client, hdr, comp, emp, start, end, days, kind="Casual"):
    return client.post(f"/apis/v3/hr/leaves/{comp.id}", headers=hdr, json={
        "employee_id": str(emp.id), "employee_name": emp.name, "leave_type": kind,
        "start_date": start.isoformat(), "end_date": end.isoformat(), "days_count": days})


def test_leave_across_month_end_is_paid_once(client, db, make_tenant, auth_headers):
    comp, project, emp, hdr = _setup(db, make_tenant, auth_headers, 31)
    # Absent 26-31 Oct (6 working days); leave 30 Oct - 2 Nov is 4 days, 2 in October.
    _mark_month(client, hdr, project, emp, {d: None for d in range(26, 32)})
    db.add(models.LeaveRequest(
        id=uuid.uuid4(), company_id=comp.id, employee_id=emp.id, employee_name=emp.name,
        leave_type="Casual", status="Approved", days_count=4.0,
        start_date=datetime.datetime(2026, 10, 30, tzinfo=UTC),
        end_date=datetime.datetime(2026, 11, 2, tzinfo=UTC)))
    db.commit()
    r = _run(client, hdr, comp, project)
    assert r.status_code == 201, r.text
    assert r.json()["payslips"][0]["days_present"] == 23.0


def test_approval_respects_the_leave_policy(client, db, make_tenant, auth_headers):
    comp, project, emp, hdr = _setup(db, make_tenant, auth_headers, 32)
    db.add(models.LeaveTemplate(id=uuid.uuid4(), company_id=comp.id, name="Site staff",
                                casual_leave_days=2, sick_leave_days=0, earned_leave_days=0))
    db.commit()

    bad = _apply(client, hdr, comp, emp, datetime.datetime(2026, 11, 5, tzinfo=UTC),
                 datetime.datetime(2026, 11, 3, tzinfo=UTC), 3)
    assert bad.status_code == 400, bad.text

    first = _apply(client, hdr, comp, emp, datetime.datetime(2026, 11, 3, tzinfo=UTC),
                   datetime.datetime(2026, 11, 3, tzinfo=UTC), 1)
    assert first.status_code == 200, first.text
    r = client.put(f"/apis/v3/hr/leaves/approve/{first.json()['id']}", headers=hdr, json={"status": "Approved"})
    assert r.status_code == 200, r.text

    second = _apply(client, hdr, comp, emp, datetime.datetime(2026, 11, 9, tzinfo=UTC),
                    datetime.datetime(2026, 11, 10, tzinfo=UTC), 2)
    assert second.status_code == 200, second.text
    r = client.put(f"/apis/v3/hr/leaves/approve/{second.json()['id']}", headers=hdr, json={"status": "Approved"})
    assert r.status_code == 400, r.text
    assert "1 day(s) of casual leave left" in r.json()["detail"]
    r = client.put(f"/apis/v3/hr/leaves/approve/{second.json()['id']}", headers=hdr, json={"status": "Rejected"})
    assert r.status_code == 200, r.text


def test_policy_made_on_the_settings_screen_sets_the_balance(client, db, make_tenant, auth_headers):
    """The Leave Policy screen saves named rows, not the fixed columns, so its
    policies showed 0 days entitled and every approval would be refused."""
    comp, project, emp, hdr = _setup(db, make_tenant, auth_headers, 33)
    r = client.post(f"/apis/v3/hr/leave-templates/{comp.id}", headers=hdr, json={
        "name": "Site staff", "leave_types": [{"type": "Casual", "days": 12}, {"type": "SL", "days": 7}]})
    assert r.status_code == 201, r.text

    bal = client.get(f"/apis/v3/hr/leave-balances/{comp.id}", headers=hdr)
    assert bal.status_code == 200, bal.text
    row = next(e for e in bal.json()["employees"] if e["employee_id"] == str(emp.id))
    assert row["casual"]["entitled"] == 12 and row["sick"]["entitled"] == 7, row

    lv = _apply(client, hdr, comp, emp, datetime.datetime(2026, 11, 3, tzinfo=UTC),
                datetime.datetime(2026, 11, 5, tzinfo=UTC), 3)
    r = client.put(f"/apis/v3/hr/leaves/approve/{lv.json()['id']}", headers=hdr, json={"status": "Approved"})
    assert r.status_code == 200, r.text
