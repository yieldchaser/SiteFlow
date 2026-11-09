"""BOQ budgeting shows each line's real progress and orders.

The page spread the project's total client billing across BOQ lines by
value, so every line showed the same made-up percentage (-89.8% on all 17
demo lines). /budgeting/boq-progress reports, per line, the average
progress of its linked tasks and the work orders placed against it.
"""
import datetime
import uuid

from app import models

_TAG = uuid.uuid4().hex[:8]


def test_progress_and_orders_are_per_line(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name=f"BQP-{_TAG}", user_name="BQP",
                                   mobile="+9175" + str(int(_TAG, 16))[-8:], email=f"bqp-{_TAG}@test.com")
    hdr = auth_headers(user, comp)
    p = models.Project(id=uuid.uuid4(), company_id=comp.id, name="P", code=f"BQP-{_TAG}", status="Ongoing")
    db.add(p)
    db.commit()
    a = models.BOQItem(id=uuid.uuid4(), project_id=p.id, item_name="Excavation", unit="cum", quantity=100, rate=200, amount=20000)
    b = models.BOQItem(id=uuid.uuid4(), project_id=p.id, item_name="PCC", unit="cum", quantity=10, rate=5000, amount=50000)
    db.add_all([a, b])
    db.commit()
    d = datetime.datetime(2026, 1, 1)
    for pct in (40, 60):
        db.add(models.Task(id=uuid.uuid4(), project_id=p.id, name=f"Dig {pct}", duration_days=5, start_date=d,
                           end_date=d, boq_item_id=a.id, progress=pct))
    live = models.WorkOrder(id=uuid.uuid4(), company_id=comp.id, project_id=p.id, subcontractor_id=team.id,
                            wo_number=f"WO-L-{_TAG}", wo_date=d, status="active", estimated_work_amount=1500)
    dead = models.WorkOrder(id=uuid.uuid4(), company_id=comp.id, project_id=p.id, subcontractor_id=team.id,
                            wo_number=f"WO-C-{_TAG}", wo_date=d, status="cancelled", estimated_work_amount=9999)
    db.add_all([live, dead])
    db.commit()
    db.add_all([
        models.WorkOrderItem(id=uuid.uuid4(), wo_id=live.id, boq_item_id=a.id, quantity=100, rate=150, amount=15000),
        models.WorkOrderItem(id=uuid.uuid4(), wo_id=dead.id, boq_item_id=a.id, quantity=100, rate=999, amount=99900),
    ])
    db.commit()

    r = client.get(f"/apis/v3/budgeting/boq-progress?project_id={p.id}", headers=hdr)
    assert r.status_code == 200, r.text
    rows = {x["boq_item_id"]: x for x in r.json()}
    assert rows[str(a.id)]["done_pct"] == 50.0
    assert rows[str(a.id)]["work_done_value"] == 10000.0
    assert rows[str(a.id)]["ordered_value"] == 15000.0
    assert rows[str(a.id)]["ordered_qty"] == 100.0
    assert rows[str(b.id)]["done_pct"] == 0.0
    assert rows[str(b.id)]["ordered_value"] == 0.0
