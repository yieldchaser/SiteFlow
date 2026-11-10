# -*- coding: utf-8 -*-
"""
D4 (R2-041,R2-125,R2-319): place of supply derives from Project.state vs supplier GSTIN prefix.

POS = Project.state. Compare vs supplier GSTIN prefix (first 2 chars).
Same state -> CGST+SGST halves. Different -> IGST full.
Never unconditional 50/50; forward-only no rewrite.
"""

import uuid
import datetime
import json

from app import models
from app.gst_utils import gst_split, project_state_code, supplier_state_code, is_inter_state


def _mk_company_with_gstin(db, comp, gstin):
    comp.gstin = gstin
    db.commit()
    return comp


def _mk_project(db, comp, state, name="P-D4"):
    p = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name=name + "-" + uuid.uuid4().hex[:4],
        code=f"PRJ-{uuid.uuid4().hex[:6]}", status="Ongoing", state=state
    )
    db.add(p)
    db.commit()
    return p


def _mk_bill(db, comp, project, team_id, gst_amount=180.0, total_payable=1180.0, subtotal=1000.0, invoice_type="sale"):
    bill = models.Bill(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        party_company_user_id=team_id,
        invoice_number=f"INV-D4-{uuid.uuid4().hex[:6]}",
        invoice_date=datetime.datetime(2026, 2, 1), invoice_type=invoice_type,
        subtotal=subtotal, gst_amount=gst_amount, total_payable=total_payable,
        paid_amount=0.0, status="Unpaid", approval_flag="pending",
        items_json=json.dumps([{"desc": "Slab work", "hsn_sac": "990722", "qty": "1", "rate": "1000", "amount": "1000"}]),
    )
    db.add(bill)
    db.commit()
    return bill


def _get_pdf(client, hdr, bill):
    r = client.get(f"/apis/v3/billing/bills/{bill.id}/pdf", headers=hdr)
    assert r.status_code == 200, r.text
    return r.content


# ---------------------------------------------------------------------------
# Unit — gst_utils helper
# ---------------------------------------------------------------------------

def test_gst_split_same_state_halves():
    cgst, sgst, igst, utgst = gst_split(180.0, project_state="27", supplier_gstin="27ABCDE1234F1Z5")
    assert cgst == 90.0 and sgst == 90.0 and igst == 0.0
    # Name variant
    cgst2, sgst2, igst2, _ = gst_split(180.0, project_state="Maharashtra", supplier_gstin="27ABCDE1234F1Z5")
    assert cgst2 == 90.0 and sgst2 == 90.0 and igst2 == 0.0
    # Numeric 29 vs 29
    cgst3, sgst3, igst3, _ = gst_split(100.0, project_state="29", supplier_gstin="29ABCDE1234F1Z5")
    assert cgst3 == 50.0 and igst3 == 0.0


def test_gst_split_inter_state_igst():
    cgst, sgst, igst, utgst = gst_split(180.0, project_state="29", supplier_gstin="27ABCDE1234F1Z5")
    assert igst == 180.0 and cgst == 0.0 and sgst == 0.0
    # Name variant Karnataka vs Maharashtra GSTIN
    cgst2, sgst2, igst2, _ = gst_split(180.0, project_state="Karnataka", supplier_gstin="27ABCDE1234F1Z5")
    assert igst2 == 180.0
    # 27 project vs 29 supplier
    cgst3, sgst3, igst3, _ = gst_split(200.0, project_state="27", supplier_gstin="29XYZAB1234C1Z5")
    assert igst3 == 200.0


def test_project_state_code_helper():
    assert project_state_code("27") == "27"
    assert project_state_code("Maharashtra") == "27"
    assert project_state_code("maharashtra ") == "27"
    assert project_state_code("27-Maharashtra") == "27"
    assert project_state_code("Karnataka") == "29"
    assert project_state_code("29") == "29"
    assert project_state_code("KA") == "29"
    assert project_state_code("") is None
    assert project_state_code(None) is None
    assert supplier_state_code("27ABCDE1234F1Z5") == "27"
    assert supplier_state_code("29ABCDE1234F1Z5") == "29"
    assert is_inter_state("27", "27ABCDE1234F1Z5") is False
    assert is_inter_state("29", "27ABCDE1234F1Z5") is True
    assert is_inter_state(None, "27ABCDE1234F1Z5") is None
    assert is_inter_state("27", None) is None


# ---------------------------------------------------------------------------
# Integration — bill PDF derives POS from Project.state (not recipient GSTIN)
# ---------------------------------------------------------------------------

def test_same_state_bill_splits_cgst_sgst(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="D4-Same", user_name="U-D4-Same")
    hdr = auth_headers(user, comp)
    _mk_company_with_gstin(db, comp, "27ABCDE1234F1Z5")  # Maharashtra supplier
    proj = _mk_project(db, comp, state="27")  # same site state
    # Party GSTIN intentionally DIFFERENT to prove POS ignores party (recipient 29 would have been IGST old logic)
    lp = models.LibraryParty(id=uuid.uuid4(), company_id=comp.id, name="D4 Buyer Same", tax_no="29AACCL5678G1Z3")
    db.add(lp)
    db.commit()
    team.library_party_id = lp.id
    db.commit()
    bill = _mk_bill(db, comp, proj, team.id, gst_amount=180.0)
    body = _get_pdf(client, hdr, bill)
    assert b"Place of Supply: 27" in body
    assert b"CGST: 90.00" in body
    assert b"SGST: 90.00" in body
    assert b"IGST:" not in body
    # Recipient GSTIN still printed but does not drive head
    assert b"Recipient GSTIN: 29AACCL5678G1Z3" in body


def test_inter_state_bill_shows_igst(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="D4-Inter", user_name="U-D4-Inter")
    hdr = auth_headers(user, comp)
    _mk_company_with_gstin(db, comp, "27ABCDE1234F1Z5")  # supplier 27
    proj = _mk_project(db, comp, state="29")  # site in Karnataka -> inter-state
    lp = models.LibraryParty(id=uuid.uuid4(), company_id=comp.id, name="D4 Buyer Inter", tax_no="27AAECS1234F1Z5")  # recipient same as supplier but POS is site
    db.add(lp)
    db.commit()
    team.library_party_id = lp.id
    db.commit()
    bill = _mk_bill(db, comp, proj, team.id, gst_amount=180.0)
    body = _get_pdf(client, hdr, bill)
    assert b"Place of Supply: 29" in body
    assert b"IGST: 180.00" in body
    assert b"CGST:" not in body
    assert b"SGST:" not in body


def test_inter_state_via_state_name(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="D4-Name", user_name="U-D4-Name")
    hdr = auth_headers(user, comp)
    _mk_company_with_gstin(db, comp, "29ABCDE1234F1Z5")  # Karnataka supplier 29
    proj = _mk_project(db, comp, state="Maharashtra")  # site Maharashtra 27 -> inter
    bill = _mk_bill(db, comp, proj, team.id, gst_amount=200.0)
    body = _get_pdf(client, hdr, bill)
    assert b"Place of Supply: 27" in body
    assert b"IGST: 200.00" in body


# ---------------------------------------------------------------------------
# 422 — Project.state required for invoiceable writes
# ---------------------------------------------------------------------------

def test_missing_state_422_on_project_create(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="D4-422-Proj", user_name="U-D4-422-P")
    hdr = auth_headers(user, comp)
    # Missing state
    r = client.post("/apis/v3/projects/", headers=hdr, json={
        "company_id": str(comp.id),
        "name": "No State Project",
        "state": "",
    })
    assert r.status_code == 422, r.text
    assert "state the site is in" in r.text
    # No state key at all also 422 (payload state Optional but D4 makes it required)
    r2 = client.post("/apis/v3/projects/", headers=hdr, json={
        "company_id": str(comp.id),
        "name": "Also No State",
    })
    assert r2.status_code == 422, r2.text
    # Invalid state code
    r3 = client.post("/apis/v3/projects/", headers=hdr, json={
        "company_id": str(comp.id),
        "name": "Bad State",
        "state": "ZZ",
    })
    assert r3.status_code == 422, r3.text


def test_missing_state_422_on_bill_create(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="D4-422-Bill", user_name="U-D4-422-B")
    hdr = auth_headers(user, comp)
    _mk_company_with_gstin(db, comp, "27ABCDE1234F1Z5")
    # Create project without state via DB (bypass API) to simulate legacy row
    proj = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Legacy No State", state=None, status="Ongoing")
    db.add(proj)
    db.commit()
    # Attempt to create bill via API for that project — must 422
    r = client.post("/apis/v3/billing/bills", headers=hdr, json={
        "company_id": str(comp.id),
        "project_id": str(proj.id),
        "party_company_user_id": str(team.id),
        "invoice_number": f"INV-422-{uuid.uuid4().hex[:6]}",
        "invoice_date": "2026-02-01T00:00:00",
        "invoice_type": "sale",
        "subtotal": 1000.0,
        "gst_pct": 18.0,
        "items_json": json.dumps([{"desc": "Test", "qty": 1, "rate": 1000, "amount": 1000}]),
    })
    assert r.status_code == 422, r.text
    assert "state the site is in" in r.text


def test_missing_state_422_on_project_update_clearing_state(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="D4-422-Upd", user_name="U-D4-422-U")
    hdr = auth_headers(user, comp)
    # Create with valid state
    r = client.post("/apis/v3/projects/", headers=hdr, json={
        "company_id": str(comp.id),
        "name": "Has State",
        "state": "27",
    })
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    # Try to clear state
    r2 = client.put(f"/apis/v3/projects/{pid}", headers=hdr, json={"state": ""})
    assert r2.status_code == 422, r2.text


# ---------------------------------------------------------------------------
# Quotation parity — same POS rule
# ---------------------------------------------------------------------------

def test_quotation_parity_same_and_inter_state(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="D4-Quot", user_name="U-D4-Quot")
    hdr = auth_headers(user, comp)
    _mk_company_with_gstin(db, comp, "27ABCDE1234F1Z5")
    # Create lead via API (ensures lookup seeding)
    r_lead = client.post("/apis/v3/crm/leads", headers=hdr, json={
        "company_id": str(comp.id),
        "lead_type": "General",
        "contact_name": "Lead D4",
        "phone_no": "9999999999",
        "status": "New Lead",
    })
    assert r_lead.status_code == 201, r_lead.text
    lead_id = r_lead.json()["id"]
    # Same-state project
    proj_same = _mk_project(db, comp, state="27", name="QuotSame")
    # Inter-state project
    proj_inter = _mk_project(db, comp, state="29", name="QuotInter")

    item = {"item_name": "Test Item", "qty": 1, "unit": "sqft", "cost_price": 800, "selling_price": 1000, "supply_rate": 0, "installation_rate": 0, "supply_tax_pct": 18, "installation_tax_pct": 12, "markup": 0}

    # Same-state quotation -> CGST/SGST halves, IGST 0
    r_same = client.post(f"/apis/v3/crm/leads/{lead_id}/quotations", headers=hdr, json={
        "subject": "Same State Quot",
        "tax_type": "bill_level",
        "gst_pct": 18.0,
        "project_id": str(proj_same.id),
        "items": [item],
    })
    assert r_same.status_code == 201, r_same.text
    q_same = r_same.json()
    assert q_same["cgst_amount"] > 0 and q_same["sgst_amount"] > 0
    assert float(q_same.get("igst_amount", 0.0)) == 0.0
    assert abs(float(q_same["cgst_amount"]) - float(q_same["sgst_amount"])) < 0.01
    assert q_same["igst_pct"] == 0.0

    # Inter-state quotation -> IGST full, CGST/SGST 0
    r_inter = client.post(f"/apis/v3/crm/leads/{lead_id}/quotations", headers=hdr, json={
        "subject": "Inter State Quot",
        "tax_type": "bill_level",
        "gst_pct": 18.0,
        "project_id": str(proj_inter.id),
        "items": [item],
    })
    assert r_inter.status_code == 201, r_inter.text
    q_inter = r_inter.json()
    assert float(q_inter["cgst_amount"]) == 0.0
    assert float(q_inter["sgst_amount"]) == 0.0
    assert float(q_inter["igst_amount"]) > 0
    assert q_inter["igst_pct"] == 18.0
    assert abs(float(q_inter["igst_amount"]) - float(q_inter["tax_amount"])) < 0.01


def test_quotation_missing_project_state_422(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="D4-Quot422", user_name="U-D4-Quot422")
    hdr = auth_headers(user, comp)
    _mk_company_with_gstin(db, comp, "27ABCDE1234F1Z5")
    r_lead = client.post("/apis/v3/crm/leads", headers=hdr, json={
        "company_id": str(comp.id),
        "lead_type": "General",
        "contact_name": "Lead 422",
        "phone_no": "8888888888",
        "status": "New Lead",
    })
    assert r_lead.status_code == 201, r_lead.text
    lead_id = r_lead.json()["id"]
    proj_nostate = models.Project(id=uuid.uuid4(), company_id=comp.id, name="NoStateQuot", state=None, status="Ongoing")
    db.add(proj_nostate)
    db.commit()
    item = {"item_name": "Test Item", "qty": 1, "unit": "sqft", "cost_price": 800, "selling_price": 1000, "supply_rate": 0, "installation_rate": 0, "supply_tax_pct": 18, "installation_tax_pct": 12, "markup": 0}
    r = client.post(f"/apis/v3/crm/leads/{lead_id}/quotations", headers=hdr, json={
        "subject": "Should 422",
        "tax_type": "bill_level",
        "gst_pct": 18.0,
        "project_id": str(proj_nostate.id),
        "items": [item],
    })
    assert r.status_code == 422, r.text
    assert "state the site is in" in r.text


# ---------------------------------------------------------------------------
# Management endpoint — would-change report (forward-only, no rewrite)
# ---------------------------------------------------------------------------

def test_would_change_report_lists_correctly(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="D4-Report", user_name="U-D4-Report")
    hdr = auth_headers(user, comp)
    _mk_company_with_gstin(db, comp, "27ABCDE1234F1Z5")  # supplier 27
    proj_same = _mk_project(db, comp, state="27", name="ReportSame")
    proj_inter = _mk_project(db, comp, state="29", name="ReportInter")
    # Same-state bill -> would NOT change (legacy halves == new halves)
    b_same = _mk_bill(db, comp, proj_same, team.id, gst_amount=180.0, total_payable=1180.0, subtotal=1000.0)
    # Inter-state bill -> would change (legacy halves vs new IGST)
    b_inter = _mk_bill(db, comp, proj_inter, team.id, gst_amount=180.0, total_payable=1180.0, subtotal=1000.0)
    # Zero-tax bill -> never counted
    b_zero = _mk_bill(db, comp, proj_inter, team.id, gst_amount=0.0, total_payable=1000.0, subtotal=1000.0)

    r = client.get(f"/apis/v3/admin/pos-would-change/{comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["company_id"] == str(comp.id)
    assert j["total_invoices"] >= 3
    assert "cut_off_note" in j
    assert "Forward-only" in j["cut_off_note"]
    # Would-change list should contain only the inter-state bill
    wc_ids = {x["bill_id"] for x in j["would_change"]}
    assert str(b_inter.id) in wc_ids
    assert str(b_same.id) not in wc_ids
    assert str(b_zero.id) not in wc_ids
    assert j["would_change_count"] == len(j["would_change"])
    # Verify head fields
    inter_row = next(x for x in j["would_change"] if x["bill_id"] == str(b_inter.id))
    assert inter_row["legacy_head"] == "CGST+SGST"
    assert inter_row["would_be_head"] == "IGST"
    assert inter_row["would_change"] is True
    # Same-state row is not in would_change but exists in total_invoices
    # Fetch full list via would_change only — so check total counts
    assert any(x["project_state_code"] == "29" for x in j["would_change"])

