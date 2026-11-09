"""Purchase orders came back in database order, so the list jumped
PO-001..PO-020 then PO-009. Newest order first."""
import datetime
import uuid

from app import models


def test_purchase_orders_listed_newest_first(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(company_name=f"PL-{uuid.uuid4().hex[:6]}", user_name="PL")
    hdr = auth_headers(user, comp)
    p = models.Project(id=uuid.uuid4(), company_id=comp.id, name="P", code=f"P-{uuid.uuid4().hex[:6]}", status="Ongoing")
    db.add(p)
    db.flush()
    for num, day in (("PO-OLD", 1), ("PO-NEW", 20), ("PO-MID", 10)):
        db.add(models.PurchaseOrder(id=uuid.uuid4(), company_id=comp.id, project_id=p.id, po_number=num,
                                    po_date=datetime.datetime(2026, 9, day, tzinfo=datetime.timezone.utc),
                                    status="approved"))
    db.commit()
    r = client.get(f"/apis/v3/procurement/pos?project_id={p.id}", headers=hdr)
    assert r.status_code == 200, r.text
    assert [x["po_number"] for x in r.json()] == ["PO-NEW", "PO-MID", "PO-OLD"]
