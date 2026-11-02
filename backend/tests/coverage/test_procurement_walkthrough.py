"""Procurement defects found buying cement end to end as a new company would:
indent, PO, goods received, supplier bill, three-way match, payment.

1. An indent raised without picking a requester was saved with nobody on it,
   and the screen showed "Auto-synced". The person raising it is the requester.
2. A PO raised from an approved indent carries the link and marks the indent
   ordered, which the Raise PO button on the indent card relies on.
3. A PO saved with no number had a blank number. It gets the next PO-####.
4. Cancelling or rejecting the PO left the indent "ordered" for ever, so the
   material could never be ordered again.
5. A GRN entered without picking a receiver was saved with nobody on it.
6. A blank PO number was flagged as a duplicate of every old unnumbered PO.
7. Three-way match took a cancelled bill, another supplier's bill, and a GRN
   from a different PO.
8. A payment was set against an approved bill that was later cancelled.
9. Finance rows did not say whether a bill was approved or what was still owed.
"""
import datetime
import uuid

from app import models

_SFX = uuid.uuid4().hex[:6]


def _setup(db, make_tenant, auth_headers, tag):
    comp, user, team = make_tenant(
        company_name=f"PRW-{tag}-{_SFX}", user_name=f"PRW-{tag}",
        mobile=f"+9177{_SFX}{tag:02d}", email=f"prw-{tag}-{_SFX}@test.com",
    )
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Jetty", status="Ongoing")
    db.add(project)
    db.commit()
    return comp, project, team, auth_headers(user, comp)


def _indent(client, hdr, comp, project, **extra):
    r = client.post("/apis/v3/procurement/indents", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id),
        "items": [{"material_name": "OPC Cement 53 Grade", "quantity": 200, "unit": "Bag"}],
        **extra})
    assert r.status_code == 201, r.text
    return r.json()


def test_indent_without_a_picked_requester_is_on_the_person_raising_it(client, db, make_tenant, auth_headers):
    comp, project, team, hdr = _setup(db, make_tenant, auth_headers, 1)
    ind = _indent(client, hdr, comp, project, requested_by=None)
    assert ind["requested_by"] == str(team.id), ind


def test_po_raised_from_an_approved_indent_marks_it_ordered(client, db, make_tenant, auth_headers):
    comp, project, _team, hdr = _setup(db, make_tenant, auth_headers, 2)
    ind = _indent(client, hdr, comp, project)
    assert client.post(f"/apis/v3/procurement/indents/{ind['id']}/approve", headers=hdr).status_code == 200

    body = {
        "company_id": str(comp.id), "project_id": str(project.id), "po_number": f"PO-{_SFX}",
        "po_date": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "items": [{"material_name": "OPC Cement 53 Grade", "quantity": 250, "unit": "Bag",
                   "rate": 380, "tax_pct": 18}],
        "indent_id": ind["id"],
    }
    over = client.post("/apis/v3/procurement/pos", headers=hdr, json=body)
    assert over.status_code == 422, over.text

    body["items"][0]["quantity"] = 200
    r = client.post("/apis/v3/procurement/pos", headers=hdr, json=body)
    assert r.status_code == 201, r.text
    po = r.json()
    assert po["indent_id"] == ind["id"]
    assert po["gross_amount"] == 76000.0 and po["tax_amount"] == 13680.0 and po["total_amount"] == 89680.0
    status = db.query(models.MaterialIndent).filter(models.MaterialIndent.id == uuid.UUID(ind["id"])).one().status
    assert status == "ordered"


def _approved_indent(client, hdr, comp, project):
    ind = _indent(client, hdr, comp, project)
    assert client.post(f"/apis/v3/procurement/indents/{ind['id']}/approve", headers=hdr).status_code == 200
    return ind


def _po_from(client, hdr, comp, project, ind, po_number=""):
    r = client.post("/apis/v3/procurement/pos", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id), "po_number": po_number,
        "po_date": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "items": [{"material_name": "OPC Cement 53 Grade", "quantity": 200, "unit": "Bag",
                   "rate": 380, "tax_pct": 18}],
        "indent_id": ind["id"]})
    assert r.status_code == 201, r.text
    return r.json()


def _indent_status(db, ind):
    db.expire_all()
    return db.query(models.MaterialIndent).filter(models.MaterialIndent.id == uuid.UUID(ind["id"])).one().status


def test_po_left_unnumbered_gets_the_next_number(client, db, make_tenant, auth_headers):
    comp, project, _team, hdr = _setup(db, make_tenant, auth_headers, 3)
    first = _po_from(client, hdr, comp, project, _approved_indent(client, hdr, comp, project), po_number="  ")
    second = _po_from(client, hdr, comp, project, _approved_indent(client, hdr, comp, project))
    assert first["po_number"] == "PO-0001", first
    assert second["po_number"] == "PO-0002", second


def test_cancelling_the_po_lets_the_indent_be_ordered_again(client, db, make_tenant, auth_headers):
    comp, project, _team, hdr = _setup(db, make_tenant, auth_headers, 4)
    ind = _approved_indent(client, hdr, comp, project)
    po = _po_from(client, hdr, comp, project, ind)
    assert _indent_status(db, ind) == "ordered"

    r = client.post(f"/apis/v3/procurement/pos/{po['id']}/cancel", headers=hdr)
    assert r.status_code == 200, r.text
    assert _indent_status(db, ind) == "approved"
    _po_from(client, hdr, comp, project, ind)
    assert _indent_status(db, ind) == "ordered"


def test_rejecting_the_po_lets_the_indent_be_ordered_again(client, db, make_tenant, auth_headers):
    comp, project, _team, hdr = _setup(db, make_tenant, auth_headers, 5)
    ind = _approved_indent(client, hdr, comp, project)
    po = _po_from(client, hdr, comp, project, ind)

    r = client.post(f"/apis/v3/procurement/pos/{po['id']}/reject", headers=hdr)
    assert r.status_code == 200, r.text
    assert _indent_status(db, ind) == "approved"


def test_grn_without_a_picked_receiver_is_on_the_person_entering_it(client, db, make_tenant, auth_headers):
    comp, project, team, hdr = _setup(db, make_tenant, auth_headers, 6)
    po = _po_from(client, hdr, comp, project, _approved_indent(client, hdr, comp, project))
    assert client.post(f"/apis/v3/procurement/pos/{po['id']}/approve", headers=hdr).status_code == 200

    r = client.post("/apis/v3/procurement/grns", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id), "po_id": po["id"],
        "received_date": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "items": [{"po_item_id": po["items"][0]["id"], "received_qty": 150}]})
    assert r.status_code == 201, r.text
    assert r.json()["received_by"] == str(team.id), r.json()


def test_blank_po_number_is_not_a_duplicate_of_old_unnumbered_pos(client, db, make_tenant, auth_headers):
    comp, project, _team, hdr = _setup(db, make_tenant, auth_headers, 7)
    db.add(models.PurchaseOrder(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, po_number="",
        po_date=datetime.datetime.now(datetime.timezone.utc), status="cancelled",
        gross_amount=0, tax_amount=0, total_amount=0))
    db.commit()
    r = client.get(f"/apis/v3/procurement/duplicate-po-check?company_id={comp.id}&po_number=", headers=hdr)
    assert r.status_code == 200, r.text
    assert r.json()["is_duplicate"] is False, r.json()


def _received(client, db, hdr, comp, project, qty=150):
    po = _po_from(client, hdr, comp, project, _approved_indent(client, hdr, comp, project))
    assert client.post(f"/apis/v3/procurement/pos/{po['id']}/approve", headers=hdr).status_code == 200
    r = client.post("/apis/v3/procurement/grns", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id), "po_id": po["id"],
        "received_date": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "items": [{"po_item_id": po["items"][0]["id"], "received_qty": qty}]})
    assert r.status_code == 201, r.text
    return po, r.json()


def _bill(db, comp, project, party_id, number, status="Unpaid", total=67260):
    bill = models.Bill(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, party_company_user_id=party_id,
        invoice_number=f"{number}-{_SFX}", invoice_date=datetime.datetime.now(datetime.timezone.utc),
        invoice_type="purchase", status=status, subtotal=57000, gst_amount=10260, total_payable=total)
    db.add(bill)
    db.commit()
    return bill


def _match(client, hdr, comp, project, po, grn, bill):
    return client.post("/apis/v3/three-way", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id),
        "po_id": po["id"], "grn_id": grn["id"], "invoice_id": str(bill.id)})


def _supplier(db, comp, name):
    party = models.CompanyTeam(id=uuid.uuid4(), company_id=comp.id, user_id=None)
    db.add(party)
    db.commit()
    return party


def test_three_way_match_refuses_a_cancelled_bill_then_takes_the_right_one(client, db, make_tenant, auth_headers):
    comp, project, _team, hdr = _setup(db, make_tenant, auth_headers, 8)
    po, grn = _received(client, db, hdr, comp, project)
    supplier = _supplier(db, comp, "Cement Depot")
    db.query(models.PurchaseOrder).filter(models.PurchaseOrder.id == uuid.UUID(po["id"])).update({"vendor_id": supplier.id})
    db.commit()

    wrong = _bill(db, comp, project, supplier.id, "NMCD-1", status="Cancelled", total=67327260)
    r = _match(client, hdr, comp, project, po, grn, wrong)
    assert r.status_code == 422 and "cancelled" in r.json()["detail"], r.text

    right = _bill(db, comp, project, supplier.id, "NMCD-1A")
    r = _match(client, hdr, comp, project, po, grn, right)
    assert r.status_code == 201, r.text
    assert r.json()["match_status"] == "matched", r.json()


def test_three_way_match_refuses_another_suppliers_bill(client, db, make_tenant, auth_headers):
    comp, project, _team, hdr = _setup(db, make_tenant, auth_headers, 9)
    po, grn = _received(client, db, hdr, comp, project)
    supplier = _supplier(db, comp, "Cement Depot")
    other = _supplier(db, comp, "Steel Traders")
    db.query(models.PurchaseOrder).filter(models.PurchaseOrder.id == uuid.UUID(po["id"])).update({"vendor_id": supplier.id})
    db.commit()

    r = _match(client, hdr, comp, project, po, grn, _bill(db, comp, project, other.id, "STL-1"))
    assert r.status_code == 422 and "different supplier" in r.json()["detail"], r.text


def test_three_way_match_refuses_a_grn_from_another_po(client, db, make_tenant, auth_headers):
    comp, project, team, hdr = _setup(db, make_tenant, auth_headers, 10)
    po_a, _grn_a = _received(client, db, hdr, comp, project)
    _po_b, grn_b = _received(client, db, hdr, comp, project)

    r = _match(client, hdr, comp, project, po_a, grn_b, _bill(db, comp, project, team.id, "X-1"))
    assert r.status_code == 422 and "different purchase order" in r.json()["detail"], r.text


def test_payment_is_not_set_against_an_approved_then_cancelled_bill(client, db, make_tenant, auth_headers):
    comp, project, team, hdr = _setup(db, make_tenant, auth_headers, 11)
    supplier = _supplier(db, comp, "Cement Depot")
    old = _bill(db, comp, project, supplier.id, "OLD-1", total=1000)
    old.approval_flag = "approved"
    old.status = "Cancelled"
    old.invoice_date = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
    live = _bill(db, comp, project, supplier.id, "NEW-1", total=67260)
    live.approval_flag = "approved"
    db.commit()

    r = client.post("/apis/v3/finance/payments", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id),
        "party_company_user_id": str(supplier.id), "payment_type": "out",
        "amount": 67260, "payment_method": "Bank",
        "payment_date": datetime.datetime.now(datetime.timezone.utc).isoformat()})
    assert r.status_code in (200, 201), r.text
    db.expire_all()
    assert float(db.get(models.Bill, old.id).paid_amount) == 0.0
    fresh = db.get(models.Bill, live.id)
    assert fresh.status == "Paid" and float(fresh.paid_amount) == 67260.0


def test_finance_rows_say_whether_a_bill_is_approved_and_what_is_owed(client, db, make_tenant, auth_headers):
    comp, project, team, hdr = _setup(db, make_tenant, auth_headers, 12)
    bill = _bill(db, comp, project, team.id, "NMCD-9")

    rows = client.get(f"/apis/v3/finance/transactions/{comp.id}", headers=hdr).json()["transactions"]
    row = [x for x in rows if x["id"] == str(bill.id)][0]
    assert row["kind"] == "bill" and row["approval"] == "pending", row
    assert row["balance_due"] == 67260.0 and row["paid_amount"] == 0.0, row
