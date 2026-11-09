"""The plan listed tasks in database order (a September slab above March
site clearance). Tasks now come in start-date order, in the list and the tree."""
import datetime
import uuid

from app import models


def test_tasks_listed_by_start_date(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(company_name=f"PT-{uuid.uuid4().hex[:6]}", user_name="PT")
    hdr = auth_headers(user, comp)
    p = models.Project(id=uuid.uuid4(), company_id=comp.id, name="P", code=f"P-{uuid.uuid4().hex[:6]}", status="Ongoing")
    db.add(p)
    db.flush()
    for name, month in (("Slab", 9), ("Clearance", 3), ("Raft", 5)):
        start = datetime.datetime(2026, month, 1, tzinfo=datetime.timezone.utc)
        db.add(models.Task(id=uuid.uuid4(), project_id=p.id, name=name, duration_days=10,
                           start_date=start, end_date=start + datetime.timedelta(days=9)))
    db.commit()
    flat = client.get(f"/apis/v3/planning/tasks?project_id={p.id}", headers=hdr)
    assert flat.status_code == 200, flat.text
    assert [t["name"] for t in flat.json()] == ["Clearance", "Raft", "Slab"]
    tree = client.get(f"/apis/v3/planning/tasks/hierarchy/{p.id}", headers=hdr)
    assert [t["name"] for t in tree.json()] == ["Clearance", "Raft", "Slab"]


def test_next_14_days_uses_the_whole_project_critical_path(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(company_name=f"PC-{uuid.uuid4().hex[:6]}", user_name="PC")
    hdr = auth_headers(user, comp)
    p = models.Project(id=uuid.uuid4(), company_id=comp.id, name="P", code=f"P-{uuid.uuid4().hex[:6]}", status="Ongoing")
    db.add(p)
    db.flush()
    now = datetime.datetime.now(datetime.timezone.utc)
    # Soon: inside the 14-day window. Late: ends a year out, so it is the
    # project's last task and the only critical one.
    db.add(models.Task(id=uuid.uuid4(), project_id=p.id, name="Soon", duration_days=5,
                       start_date=now + datetime.timedelta(days=2), end_date=now + datetime.timedelta(days=6)))
    db.add(models.Task(id=uuid.uuid4(), project_id=p.id, name="Late", duration_days=5,
                       start_date=now + datetime.timedelta(days=360), end_date=now + datetime.timedelta(days=365)))
    db.commit()
    full = {t["name"]: t["is_critical"] for t in client.get(f"/apis/v3/planning/tasks?project_id={p.id}", headers=hdr).json()}
    ahead = {t["name"]: t["is_critical"] for t in client.get(f"/apis/v3/planning/tasks/lookahead?project_id={p.id}&days=14", headers=hdr).json()}
    assert full == {"Soon": False, "Late": True}
    assert ahead == {"Soon": False}
