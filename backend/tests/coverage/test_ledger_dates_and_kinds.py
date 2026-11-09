"""The project ledger carries full dates, true categories and row kinds.

Dates came back as "Oct 26" with no year, so the page's date filter
(YYYY-MM-DD) matched nothing and rows from different years looked alike.
Equipment and other expense bills were filed as "Material Bill". The page
offered Delete on every row and sent bill ids to the payment delete
endpoint; rows now say what they are.
"""
import datetime
import uuid

from app import models

_TAG = uuid.uuid4().hex[:8]


def test_ledger_rows_have_iso_dates_categories_and_kinds(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name=f"LDK-{_TAG}", user_name="LDK",
                                   mobile="+9176" + str(int(_TAG, 16))[-8:], email=f"ldk-{_TAG}@test.com")
    hdr = auth_headers(user, comp)
    p = models.Project(id=uuid.uuid4(), company_id=comp.id, name="P", code=f"LDK-{_TAG}", status="Ongoing")
    db.add(p)
    db.commit()
    d = datetime.datetime(2026, 10, 25)
    db.add(models.Bill(id=uuid.uuid4(), company_id=comp.id, project_id=p.id, party_company_user_id=team.id,
                       invoice_number=f"EQ-{_TAG}", invoice_date=d, invoice_type="equipment",
                       subtotal=1000, total_payable=1000, approval_flag="approved", status="Unpaid"))
    db.add(models.Payment(id=uuid.uuid4(), company_id=comp.id, project_id=p.id, party_company_user_id=team.id,
                          payment_type="out", amount=500, unsettled_amount=500, payment_method="Bank Transfer", payment_date=d, description="Advance"))
    db.commit()

    r = client.get(f"/apis/v3/finance/ledger?project_id={p.id}", headers=hdr)
    assert r.status_code == 200, r.text
    rows = r.json()
    bill = next(x for x in rows if x["ref"] == f"EQ-{_TAG}")
    assert bill["date"] == "2026-10-25", bill
    assert bill["category"] == "Equipment Bill", bill
    assert bill["kind"] == "bill", bill
    pay = next(x for x in rows if x["description"] == "Advance")
    assert pay["kind"] == "payment", pay
    assert pay["date"] == "2026-10-25", pay
