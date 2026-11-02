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
