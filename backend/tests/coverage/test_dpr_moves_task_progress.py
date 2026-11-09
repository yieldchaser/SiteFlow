"""A daily report's executed quantity moves its task's progress.

Found driving a piling site: 6 rmt of a 600 rmt pile line reported in a DPR
left the task at 0%, so BOQ physical progress and the dashboards never moved
however much work was logged. Progress is now reported-to-date over the BOQ
line's quantity, and deleting a report takes its quantity back out.
"""
import datetime
import uuid

from app import models

_SFX = uuid.uuid4().hex[:6]


def test_dpr_executed_qty_moves_task_progress(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name=f"DPRP-{_SFX}", user_name="DPRP",
                                mobile=f"+9174{_SFX}01", email=f"dprp-{_SFX}@test.com")
    hdr = auth_headers(user, comp)
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Jetty", status="Ongoing")
    db.add(project)
    db.flush()
    doc = models.BOQDocument(id=uuid.uuid4(), project_id=project.id, title="Contract BOQ")
    db.add(doc)
    db.flush()
    item = models.BOQItem(id=uuid.uuid4(), project_id=project.id, boq_document_id=doc.id,
                          item_name="Bored pile 1000 dia", unit="Rmt", quantity=600, rate=18500)
    db.add(item)
    db.flush()
    task = models.Task(id=uuid.uuid4(), project_id=project.id, name="Bored piling",
                       duration_days=60, start_date=datetime.datetime(2026, 11, 1),
                       end_date=datetime.datetime(2026, 12, 31), boq_item_id=item.id)
    db.add(task)
    db.commit()

    def report(qty, day):
        r = client.post("/apis/v3/dpr", headers=hdr, json={
            "project_id": str(project.id), "task_id": str(task.id),
            "dpr_date": datetime.datetime(2026, 11, day, 10, tzinfo=datetime.timezone.utc).isoformat(),
            "executed_qty": qty, "workers_deployed": 15,
        })
        assert r.status_code in (200, 201), r.text
        return r.json()["id"]

    report(6, 2)
    db.expire_all()
    assert float(db.get(models.Task, task.id).progress) == 1.0
    second = report(144, 3)
    db.expire_all()
    assert float(db.get(models.Task, task.id).progress) == 25.0

    r = client.delete(f"/apis/v3/dpr/{second}", headers=hdr)
    assert r.status_code in (200, 204), r.text
    db.expire_all()
    assert float(db.get(models.Task, task.id).progress) == 1.0


def test_dpr_list_carries_the_task_unit(client, db, make_tenant, auth_headers):
    """The DPR feed printed 'Qty Executed: 46' with no unit; 46 what? The list
    now carries the unit of the BOQ line behind the task.

    Also: two activities on the same day each get a report (the duplicate
    check used to key on the project alone, so the second activity of any day
    was refused), while a second report of the same task that day is still a
    duplicate."""
    sfx = uuid.uuid4().hex[:6]
    comp, user, _ = make_tenant(company_name=f"DPRU-{sfx}", user_name="DPRU",
                                mobile=f"+9173{sfx}01", email=f"dpru-{sfx}@test.com")
    hdr = auth_headers(user, comp)
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Tower", status="Ongoing")
    db.add(project)
    db.flush()
    doc = models.BOQDocument(id=uuid.uuid4(), project_id=project.id, title="Contract BOQ")
    db.add(doc)
    db.flush()
    item = models.BOQItem(id=uuid.uuid4(), project_id=project.id, boq_document_id=doc.id,
                          item_name="RCC M30 slab", unit="Cum", quantity=400, rate=6500)
    db.add(item)
    db.flush()
    task = models.Task(id=uuid.uuid4(), project_id=project.id, name="L4 slab",
                       duration_days=10, start_date=datetime.datetime(2026, 11, 1),
                       end_date=datetime.datetime(2026, 11, 10), boq_item_id=item.id)
    loose = models.Task(id=uuid.uuid4(), project_id=project.id, name="Site cleaning",
                        duration_days=2, start_date=datetime.datetime(2026, 11, 1),
                        end_date=datetime.datetime(2026, 11, 2))
    db.add_all([task, loose])
    db.commit()
    for t, qty in ((task, 46), (loose, 1)):
        r = client.post("/apis/v3/dpr", headers=hdr, json={
            "project_id": str(project.id), "task_id": str(t.id),
            "dpr_date": datetime.datetime(2026, 11, 2, 10, tzinfo=datetime.timezone.utc).isoformat(),
            "executed_qty": qty, "workers_deployed": 5,
        })
        assert r.status_code in (200, 201), r.text

    dup = client.post("/apis/v3/dpr", headers=hdr, json={
        "project_id": str(project.id), "task_id": str(task.id),
        "dpr_date": datetime.datetime(2026, 11, 2, 15, tzinfo=datetime.timezone.utc).isoformat(),
        "executed_qty": 3, "workers_deployed": 2,
    })
    assert dup.status_code == 409, dup.text

    r = client.get(f"/apis/v3/dpr?project_id={project.id}", headers=hdr)
    assert r.status_code == 200, r.text
    units = {row["task_id"]: row.get("task_unit") for row in r.json()}
    assert units[str(task.id)] == "Cum"
    assert units[str(loose.id)] is None
