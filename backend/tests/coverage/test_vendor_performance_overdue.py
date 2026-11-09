"""Vendor performance showed a supplier who never delivered an overdue order
as 0 days late, counted cancelled orders, and kept figures from the last
receipt even as orders grew more overdue."""
import datetime
import uuid

from app import models


def test_overdue_undelivered_order_counts_late_and_cancelled_is_ignored(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name=f"VP-{uuid.uuid4().hex[:6]}", user_name="VP")
    hdr = auth_headers(user, comp)
    p = models.Project(id=uuid.uuid4(), company_id=comp.id, name="P", code=f"P-{uuid.uuid4().hex[:6]}", status="Ongoing")
    db.add(p)
    db.flush()
    now = datetime.datetime.now(datetime.timezone.utc)
    for status, due_days_ago in (("approved", 10), ("cancelled", 30)):
        po = models.PurchaseOrder(id=uuid.uuid4(), company_id=comp.id, project_id=p.id, vendor_id=team.id,
                                  po_number=f"PO-{uuid.uuid4().hex[:6]}", po_date=now - datetime.timedelta(days=40),
                                  expected_delivery_date=now - datetime.timedelta(days=due_days_ago), status=status)
        db.add(po)
        db.flush()
        db.add(models.PurchaseOrderItem(id=uuid.uuid4(), po_id=po.id, material_name="Cement", quantity=100,
                                        unit="bag", rate=400))
    db.commit()
    r = client.get(f"/apis/v3/procurement/vendors/performance/{p.id}", headers=hdr)
    assert r.status_code == 200, r.text
    row = r.json()[0]
    assert row["total_pos"] == 1                 # cancelled order left out
    assert row["total_grns"] == 0
    assert row["overdue_orders"] == 1
    assert 9 <= row["avg_delay_days"] <= 10      # 10 days overdue, not 0
