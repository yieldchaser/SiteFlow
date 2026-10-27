"""Analytics > Labour Intelligence read 0 hours for a fully staffed site.

Every day a supervisor marks on the muster is stored with no hours (there was
no punch), and the hours total skipped them all. A hand-marked Present day is
a worked 8-hour shift, a Half Day is 4; open GPS punches still count nothing.
"""
import datetime
import uuid

from app import models


def test_hand_marked_days_count_as_worked_hours(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(company_name=f"Lab Co {uuid.uuid4().hex[:6]}", user_name="Owner")
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Tower", status="Ongoing")
    emp = models.StaffEmployee(id=uuid.uuid4(), company_id=comp.id, name="Ravi")
    db.add_all([project, emp])
    db.flush()
    now = datetime.datetime.now(datetime.timezone.utc)
    rows = [("Present", True, None), ("Present", True, None), ("Half Day", True, None),
            ("Absent", True, None), ("Present", False, now)]  # last one: open GPS punch
    for i, (status, manual, punch_in) in enumerate(rows):
        db.add(models.AttendanceLog(id=uuid.uuid4(), employee_id=emp.id, project_id=project.id,
                                    attendance_date=now - datetime.timedelta(days=i), status=status,
                                    marked_manually=manual, punch_in=punch_in))
    db.commit()

    r = client.get(f"/apis/v3/analytics/company/{comp.id}", headers=auth_headers(user, comp))
    assert r.status_code == 200, r.text
    lp = r.json()["labour_productivity"]
    assert lp["total_hours"] == 20.0, lp
    assert lp["labour_days"] == 2.5, lp
