"""Regression tests for Prompt 12 — Theme B (soft flag): link vendor/subcon bills
to an approved ThreeWayMatch.

Covers:
  - purchase/subcon bill with a valid APPROVED match -> 201, match linked, match_status=="approved"
  - purchase/subcon bill with a match_id that is NOT approved -> 400
  - purchase/subcon bill with a match_id from another company/project -> 400
  - purchase/subcon bill WITHOUT match_id -> 201, match_status=="unmatched" (soft flag, not blocked)
  - sale bill WITH match_id -> 201, match_id is None (ignored)
  - get_bills surfaces match_id + match_status for a linked approved match
  - PATCH /bills/{id}/match links an approved match on an existing unmatched bill
"""
import datetime
import json
import uuid

from app import models


def _project(db, company):
    p = models.Project(
        id=uuid.uuid4(), company_id=company.id, name="ThemeBProj",
        code=uuid.uuid4().hex[:6], status="Ongoing", state="Karnataka",
    )
    db.add(p)
    db.commit()
    return p


def _bill_payload(company_id, project_id, party_id, **kw):
    payload = {
        "company_id": str(company_id),
        "project_id": str(project_id),
        "party_company_user_id": str(party_id),
        "invoice_number": "INV-TB1",
        "invoice_date": datetime.datetime.now().isoformat(),
        "invoice_type": "subcon",
        "subtotal": 100000.0,
        "gst_pct": 18.0,
        "deductions": [
            {"deduction_type": "Retention", "amount": 0.0, "percentage": 5.0},
            {"deduction_type": "TDS", "amount": 0.0, "percentage": 10.0},
        ],
    }
    payload.update(kw)
    return payload


def _po_grn_match(db, company, project, match_status, invoice_id=None, invoiced_amount=100000):
    po = models.PurchaseOrder(
        id=uuid.uuid4(), company_id=company.id, project_id=project.id,
        po_number=f"PO-{uuid.uuid4().hex[:6]}", po_date=datetime.datetime.now(),
        status="sent", gross_amount=0, tax_amount=0, total_amount=0,
    )
    db.add(po)
    db.flush()
    grn = models.GoodsReceiptNote(
        id=uuid.uuid4(), company_id=company.id, project_id=project.id, po_id=po.id,
        grn_number=f"GRN-{uuid.uuid4().hex[:6]}", received_date=datetime.datetime.now(),
    )
    db.add(grn)
    db.flush()
    match = models.ThreeWayMatch(
        id=uuid.uuid4(), company_id=company.id, project_id=project.id,
        po_id=po.id, grn_id=grn.id, invoice_id=invoice_id,
        match_status=match_status, po_amount=100000, grn_qty=10,
        invoiced_amount=invoiced_amount, variance_amount=0,
    )
    db.add(match)
    db.commit()
    return match


def test_subcon_bill_with_approved_match(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="A", user_name="UA", mobile="+919888781001")
    proj = _project(db, comp)
    hdr = auth_headers(user, comp)
    match = _po_grn_match(db, comp, proj, "approved")

    r = client.post("/apis/v3/billing/bills", json=_bill_payload(comp.id, proj.id, team.id, match_id=str(match.id)), headers=hdr)
    assert r.status_code == 201, r.text
    body = r.json()
    assert str(body["match_id"]) == str(match.id)
    assert body["match_status"] == "approved"
    # Reverse link (ThreeWayMatch.invoice_id back-fill) is populated. Expire the
    # session identity map so we re-read the committed value (not the cached stub
    # created by _po_grn_match above).
    db.expire_all()
    db_match = db.query(models.ThreeWayMatch).filter(models.ThreeWayMatch.id == match.id).first()
    assert db_match.invoice_id is not None


def test_subcon_bill_with_non_approved_match_rejected(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="A", user_name="UB", mobile="+919888781002")
    proj = _project(db, comp)
    hdr = auth_headers(user, comp)
    match = _po_grn_match(db, comp, proj, "pending")

    r = client.post("/apis/v3/billing/bills", json=_bill_payload(comp.id, proj.id, team.id, match_id=str(match.id)), headers=hdr)
    assert r.status_code == 400, r.text
    assert "not approved" in r.json()["detail"]


def test_subcon_bill_with_foreign_match_rejected(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="A", user_name="UC", mobile="+919888781003")
    proj = _project(db, comp)
    hdr = auth_headers(user, comp)
    # Match belongs to a DIFFERENT company/project.
    comp2, user2, _ = make_tenant(company_name="B", user_name="U2", mobile="+919888781004")
    proj2 = _project(db, comp2)
    match = _po_grn_match(db, comp2, proj2, "approved")

    r = client.post("/apis/v3/billing/bills", json=_bill_payload(comp.id, proj.id, team.id, match_id=str(match.id)), headers=hdr)
    assert r.status_code == 400, r.text
    assert "does not belong" in r.json()["detail"]


def test_subcon_bill_without_match_is_unmatched(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="A", user_name="UD", mobile="+919888781005")
    proj = _project(db, comp)
    hdr = auth_headers(user, comp)

    r = client.post("/apis/v3/billing/bills", json=_bill_payload(comp.id, proj.id, team.id), headers=hdr)
    assert r.status_code == 201, r.text
    assert r.json()["match_id"] is None
    assert r.json()["match_status"] == "unmatched"


def test_sale_bill_with_match_id_ignored(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="A", user_name="UE", mobile="+919888781006")
    proj = _project(db, comp)
    hdr = auth_headers(user, comp)
    match = _po_grn_match(db, comp, proj, "approved")

    r = client.post("/apis/v3/billing/bills", json=_bill_payload(
        comp.id, proj.id, team.id, invoice_type="sale", invoice_number="INV-SALE1",
        match_id=str(match.id),
        # R2-401: tax invoices must carry line items reconciling to the subtotal.
        items_json=json.dumps([{"desc": "Supply", "qty": 1, "rate": 100000.0, "amount": 100000.0, "hsn_sac": "9954"}]),
    ), headers=hdr)
    assert r.status_code == 201, r.text
    assert r.json()["match_id"] is None
    assert r.json()["match_status"] == "unmatched"


def test_get_bills_surfaces_match_status(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="A", user_name="UF", mobile="+919888781007")
    proj = _project(db, comp)
    hdr = auth_headers(user, comp)
    match = _po_grn_match(db, comp, proj, "approved")
    r = client.post("/apis/v3/billing/bills", json=_bill_payload(comp.id, proj.id, team.id, match_id=str(match.id)), headers=hdr)
    assert r.status_code == 201, r.text

    g = client.get(f"/apis/v3/billing/bills?project_id={proj.id}&invoice_type=subcon", headers=hdr)
    assert g.status_code == 200, g.text
    body = g.json()
    assert len(body) == 1
    assert str(body[0]["match_id"]) == str(match.id)
    assert body[0]["match_status"] == "approved"


def test_patch_bill_link_match(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="A", user_name="UG", mobile="+919888781008")
    proj = _project(db, comp)
    hdr = auth_headers(user, comp)
    # Create an unmatched bill first.
    r = client.post("/apis/v3/billing/bills", json=_bill_payload(comp.id, proj.id, team.id), headers=hdr)
    assert r.status_code == 201, r.text
    bill_id = r.json()["id"]
    bill_value = round(float(r.json()["subtotal"]) + float(r.json()["gst_amount"]), 2)
    assert r.json()["match_status"] == "unmatched"

    # R2-594: the linked match's invoiced amount must agree with this bill's
    # value before deductions (work + GST), which is what a match records.
    match = _po_grn_match(db, comp, proj, "approved", invoiced_amount=bill_value)
    p = client.patch(f"/apis/v3/billing/bills/{bill_id}/match", json={"match_id": str(match.id)}, headers=hdr)
    assert p.status_code == 200, p.text
    assert str(p.json()["match_id"]) == str(match.id)
    assert p.json()["match_status"] == "approved"


def test_patch_bill_link_match_non_approved_rejected(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="A", user_name="UH", mobile="+919888781009")
    proj = _project(db, comp)
    hdr = auth_headers(user, comp)
    r = client.post("/apis/v3/billing/bills", json=_bill_payload(comp.id, proj.id, team.id), headers=hdr)
    assert r.status_code == 201, r.text
    bill_id = r.json()["id"]

    match = _po_grn_match(db, comp, proj, "pending")
    p = client.patch(f"/apis/v3/billing/bills/{bill_id}/match", json={"match_id": str(match.id)}, headers=hdr)
    assert p.status_code == 400, p.text
    assert "not approved" in p.json()["detail"]
