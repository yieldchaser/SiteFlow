"""R2-528 / R2-529 - leave-status vocabulary and timesheet approval audit trail.

R2-528: LeaveStatusUpdate.status was a bare str assigned verbatim while every
balance query filtered LeaveRequest.status == "Approved" case-sensitively, so
"approved"/"APPROVED" were stored but never counted. The endpoint must reject
anything outside the model's vocabulary (Pending/Approved/Rejected -> 422
naming the valid values), and the balance comparisons must count approved
leave regardless of how legacy rows were cased on disk.

R2-529: approve_timesheet held the attendance:approve permission but wrote
only ts.status, leaving the approved_by column (models.py:757) null forever;
submit_timesheet had no permission gate at all. Approval must stamp the
approver from the session user, and submission must be gated.
"""
import uuid
from datetime import datetime, timezone

from app import models

_SUFFIX = uuid.uuid4().hex[:8]

_WEEK_START = datetime(2026, 8, 17, 0, 0, tzinfo=timezone.utc)
_WEEK_END = datetime(2026, 8, 23, 23, 59, tzinfo=timezone.utc)


def _year_date(month: int, day: int) -> datetime:
    return datetime(datetime.now(timezone.utc).year, month, day, tzinfo=timezone.utc)


def _seed_project_and_employee(db, comp):
    project = models.Project(
        id=uuid.uuid4(), company_id=comp.id,
        name=f"P-{_SUFFIX}", code=f"PRJ-{_SUFFIX}", status="Ongoing",
    )
    db.add(project)
    emp = models.StaffEmployee(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        name=f"E-{_SUFFIX}", basic_salary=18000,
    )
    db.add(emp)
    return project, emp


def test_invalid_leave_status_rejected_with_vocabulary(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(
        company_name=f"R2528A-{_SUFFIX}", user_name="U2528A",
        mobile=f"+9197{_SUFFIX}", email=f"r2528a-{_SUFFIX}@test.com",
    )
    hdr = auth_headers(user, comp)
    emp = models.StaffEmployee(id=uuid.uuid4(), company_id=comp.id, name=f"E-{_SUFFIX}", status="active")
    db.add(emp)
    db.commit()

    r = client.post(
        f"/apis/v3/hr/leaves/{comp.id}",
        headers=hdr,
        json={
            "employee_id": str(emp.id),
            "employee_name": f"E-{_SUFFIX}",
            "leave_type": "Sick",
            "start_date": "2026-08-10T00:00:00Z",
            "end_date": "2026-08-11T00:00:00Z",
            "days_count": 2,
        },
    )
    assert r.status_code == 200, r.text
    leave_id = r.json()["id"]

    for bad in ("approved", "APPROVED", "Sanctioned", "approved "):
        r = client.put(
            f"/apis/v3/hr/leaves/approve/{leave_id}", headers=hdr, json={"status": bad}
        )
        assert r.status_code == 422, (bad, r.text)
        body = r.text
        assert "'Pending'" in body and "'Approved'" in body and "'Rejected'" in body, (bad, body)

    stored = db.query(models.LeaveRequest).filter(models.LeaveRequest.id == uuid.UUID(leave_id)).first()
    assert stored.status == "Pending", stored.status


def test_valid_approval_counts_toward_balance_despite_legacy_casing(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(
        company_name=f"R2528B-{_SUFFIX}", user_name="U2528B",
        mobile=f"+9198{_SUFFIX}", email=f"r2528b-{_SUFFIX}@test.com",
    )
    hdr = auth_headers(user, comp)
    _project, emp = _seed_project_and_employee(db, comp)
    db.commit()

    r = client.post(
        f"/apis/v3/hr/leaves/{comp.id}",
        headers=hdr,
        json={
            "employee_id": str(emp.id),
            "employee_name": emp.name,
            "leave_type": "Sick",
            "start_date": _year_date(8, 10).isoformat(),
            "end_date": _year_date(8, 11).isoformat(),
            "days_count": 2,
        },
    )
    assert r.status_code == 200, r.text
    canonical_id = r.json()["id"]

    legacy = models.LeaveRequest(
        company_id=comp.id,
        employee_id=emp.id,
        employee_name=f"E-{_SUFFIX}",
        leave_type="Casual",
        start_date=_year_date(8, 12),
        end_date=_year_date(8, 12),
        days_count=1,
        status="approved",
    )
    db.add(legacy)
    db.commit()

    r = client.put(
        f"/apis/v3/hr/leaves/approve/{canonical_id}", headers=hdr, json={"status": "Approved"}
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "Approved", r.text

    r = client.get(f"/apis/v3/hr/leave-balances/{comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    employees = r.json()["employees"]
    row = next(e for e in employees if e["employee_name"] == f"E-{_SUFFIX}")
    assert row["sick"]["used"] == 2.0, row
    assert row["casual"]["used"] == 1.0, row


def _approved_timesheet(db, client, comp, hdr):
    project, emp = _seed_project_and_employee(db, comp)
    ts = models.Timesheet(
        id=uuid.uuid4(), employee_id=emp.id, project_id=project.id,
        week_start=_WEEK_START, week_end=_WEEK_END,
        total_hours=8, status="draft",
    )
    db.add(ts)
    db.commit()

    r = client.patch(f"/apis/v3/hr/timesheets/{ts.id}/submit", headers=hdr)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "submitted", r.text

    r = client.patch(f"/apis/v3/hr/timesheets/{ts.id}/approve", headers=hdr)
    assert r.status_code == 200, r.text
    return ts


def test_approved_timesheet_carries_approver_id(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(
        company_name=f"R2529A-{_SUFFIX}", user_name="U2529A",
        mobile=f"+9199{_SUFFIX}", email=f"r2529a-{_SUFFIX}@test.com",
    )
    ts = _approved_timesheet(db, client, comp, auth_headers(user, comp))

    db.refresh(ts)
    assert str(ts.approved_by) == str(user.id), ts.approved_by


def test_submit_timesheet_requires_attendance_edit(client, db, make_tenant, auth_headers):
    comp, _user, _team = make_tenant(
        company_name=f"R2529B-{_SUFFIX}", user_name="U2529B",
        mobile=f"+9192{_SUFFIX}", email=f"r2529b-{_SUFFIX}@test.com",
    )
    role = models.CompanyRole(
        id=uuid.uuid4(), company_id=comp.id, role_name=f"Clerk-{_SUFFIX}",
        permissions={"dashboard:view": True},
    )
    db.add(role)
    db.flush()
    clerk = models.User(id=uuid.uuid4(), name="Clerk2529", email=f"clerk-{_SUFFIX}@test.com")
    db.add(clerk)
    db.flush()
    db.add(models.CompanyTeam(
        id=uuid.uuid4(), company_id=comp.id, user_id=clerk.id,
        priority_type="employee", role_id=role.id,
    ))
    db.commit()

    project, emp = _seed_project_and_employee(db, comp)
    ts = models.Timesheet(
        id=uuid.uuid4(), employee_id=emp.id, project_id=project.id,
        week_start=_WEEK_START, week_end=_WEEK_END,
        total_hours=8, status="draft",
    )
    db.add(ts)
    db.commit()

    hdr = auth_headers(clerk, comp)
    r = client.patch(f"/apis/v3/hr/timesheets/{ts.id}/submit", headers=hdr)
    assert r.status_code == 403, r.text
    assert "attendance:edit" in r.text, r.text
    db.refresh(ts)
    assert ts.status == "draft", ts.status
