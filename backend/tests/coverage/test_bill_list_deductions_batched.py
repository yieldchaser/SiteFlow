"""The company bill list queried deductions once per bill (~10 s for 44
bills on prod). They are now loaded in one query, and still attach to the
right bill."""
import datetime
import uuid

from sqlalchemy import event

from app import models


def test_bill_list_query_count_does_not_grow_with_bills(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name=f"Bill Co {uuid.uuid4().hex[:6]}", user_name="Owner")
    hdr = auth_headers(user, comp)
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Tower", status="Ongoing")
    db.add(project)
    db.commit()

    def add_bills(n):
        ids = []
        for _ in range(n):
            bid = uuid.uuid4()
            ids.append(bid)
            db.add(models.Bill(
                id=bid, company_id=comp.id, project_id=project.id, party_company_user_id=team.id,
                invoice_number=f"INV-{uuid.uuid4().hex[:10]}", invoice_date=datetime.datetime.now(),
                invoice_type="subcon", status="Unpaid", subtotal=100.0, total_payable=100.0,
            ))
        db.commit()
        return ids

    engine = db.get_bind()

    def fetch():
        seen = []
        listener = lambda *a, **k: seen.append(1)
        event.listen(engine, "before_cursor_execute", listener)
        try:
            r = client.get(f"/apis/v3/billing/bills/{comp.id}", headers=hdr)
        finally:
            event.remove(engine, "before_cursor_execute", listener)
        assert r.status_code == 200, r.text
        return len(seen), r.json()

    first = add_bills(2)
    db.add(models.TransactionDeduction(id=uuid.uuid4(), bill_id=first[0], deduction_type="retention", amount=5.0))
    db.commit()
    few, body = fetch()
    by_id = {b["id"]: b for b in body}
    assert [d["amount"] for d in by_id[str(first[0])]["deductions"]] == [5.0]
    assert by_id[str(first[1])]["deductions"] == []

    add_bills(20)
    many, body = fetch()
    assert len(body) == 22
    assert many - few <= 2, (few, many)
