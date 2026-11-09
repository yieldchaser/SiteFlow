"""The planning screen saved new tasks as "pending" and progress updates set
"ongoing". The daily report only moves "not_started" tasks on, and reports
count "in_progress" as active, so such tasks were never moved or counted.
Tasks now keep one set of statuses: not_started, in_progress, completed."""
import uuid

from app import models


def _project(db, comp):
    p = models.Project(id=uuid.uuid4(), company_id=comp.id, name="P", code=f"P-{uuid.uuid4().hex[:6]}", status="Ongoing")
    db.add(p)
    db.commit()
    return p


def test_pending_task_is_saved_as_not_started(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(company_name=f"TS-{uuid.uuid4().hex[:6]}", user_name="TS")
    hdr = auth_headers(user, comp)
    p = _project(db, comp)
    r = client.post("/apis/v3/planning/tasks", headers=hdr, json={
        "project_id": str(p.id), "name": "Raft", "duration_days": 5,
        "start_date": "2026-11-10T00:00:00+05:30", "status": "pending"})
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "not_started"


def test_progress_update_sets_in_progress(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(company_name=f"TU-{uuid.uuid4().hex[:6]}", user_name="TU")
    hdr = auth_headers(user, comp)
    p = _project(db, comp)
    r = client.post("/apis/v3/planning/tasks", headers=hdr, json={
        "project_id": str(p.id), "name": "Raft", "duration_days": 5,
        "start_date": "2026-11-10T00:00:00+05:30"})
    assert r.status_code == 201, r.text
    tid = r.json()["id"]
    u = client.put(f"/apis/v3/planning/tasks/{tid}", headers=hdr, json={"progress": 40})
    assert u.status_code == 200, u.text
    assert u.json()["status"] == "in_progress"


def test_unknown_task_status_is_refused(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(company_name=f"TX-{uuid.uuid4().hex[:6]}", user_name="TX")
    hdr = auth_headers(user, comp)
    p = _project(db, comp)
    r = client.post("/apis/v3/planning/tasks", headers=hdr, json={
        "project_id": str(p.id), "name": "Raft", "duration_days": 5,
        "start_date": "2026-11-10T00:00:00+05:30", "status": "delayed"})
    assert r.status_code == 422, r.text


def test_milestone_status_from_screen_is_accepted(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(company_name=f"TM-{uuid.uuid4().hex[:6]}", user_name="TM")
    hdr = auth_headers(user, comp)
    p = _project(db, comp)
    r = client.post("/apis/v3/planning/milestones", headers=hdr, json={
        "project_id": str(p.id), "name": "Slab cast", "milestone_date": "2026-12-01T00:00:00+05:30",
        "type": "critical", "status": "upcoming"})
    assert r.status_code == 201, r.text
    # The old screen sent "pending", which was refused.
    bad = client.post("/apis/v3/planning/milestones", headers=hdr, json={
        "project_id": str(p.id), "name": "Slab cast", "milestone_date": "2026-12-01T00:00:00+05:30",
        "type": "critical", "status": "pending"})
    assert bad.status_code == 422
