"""Finance > Transaction tab took ~18 s on prod for 74 rows.

Every row resolved its party name with fresh queries, so the query count
grew with the number of bills and payments. A party is now resolved once.
"""
import datetime
import uuid

from sqlalchemy import event

from app import models


def test_party_name_is_resolved_once_per_party(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name=f"Txn Co {uuid.uuid4().hex[:6]}", user_name="Owner")
    hdr = auth_headers(user, comp)
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Tower", status="Ongoing")
    db.add(project)
    db.commit()

    def add_bills(n):
        for _ in range(n):
            db.add(models.Bill(
                id=uuid.uuid4(), company_id=comp.id, project_id=project.id, party_company_user_id=team.id,
                invoice_number=f"INV-{uuid.uuid4().hex[:10]}", invoice_date=datetime.datetime.now(),
                invoice_type="purchase", status="Unpaid", subtotal=100.0, total_payable=100.0,
            ))
        db.commit()

    engine = db.get_bind()

    def count_queries():
        seen = []
        listener = lambda *a, **k: seen.append(1)
        event.listen(engine, "before_cursor_execute", listener)
        try:
            r = client.get(f"/apis/v3/finance/transactions/{comp.id}", headers=hdr)
        finally:
            event.remove(engine, "before_cursor_execute", listener)
        assert r.status_code == 200, r.text
        return len(seen), len(r.json()["transactions"])

    add_bills(2)
    few, n_few = count_queries()
    add_bills(20)
    many, n_many = count_queries()
    assert (n_few, n_many) == (2, 22)
    # Same party on every row: twenty more rows must not mean more queries.
    assert many - few <= 2, (few, many)
