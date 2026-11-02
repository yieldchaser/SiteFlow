"""Subcontractor defects found raising a work order and an RA bill as a piling
company would (Konkan Piling, 600 rmt at Rs 6,200 = Rs 37,20,000).

1. TDS was taken on the work value after retention (2% of 95,000 = 1,900).
   Sec 194C TDS is on the whole sum credited to the subcontractor, and the
   retention held back is still credited to them: 2% of 1,00,000 = 2,000.
2. The work-order list showed "billed value" and progress from the net
   payable (with GST, after TDS and retention), so an RA bill for Rs 6,20,000
   of work read as more or less than 1/6 of the order depending on GST and
   deductions. Both now use the work value billed.
3. Releasing retention only stamped the deduction. The released money never
   went back onto the bill, so the subcontractor's balance stayed at zero and
   a payment for it could not settle anything.
4. A subcontractor added in the Party Library never showed on the Subcon
   page, so it had to be entered a second time to raise a work order.
5. Once billed on a project the subcontractor was on the project's Party
   register but not in the Transaction screen's party list, so its next
   payment could not be recorded there.
"""
import uuid

from app import models

_SFX = uuid.uuid4().hex[:6]


def _setup(db, make_tenant, auth_headers, tag):
    comp, user, _team = make_tenant(
        company_name=f"SCW-{tag}-{_SFX}", user_name=f"SCW-{tag}",
        mobile=f"+9179{_SFX}{tag:02d}", email=f"scw-{tag}-{_SFX}@test.com",
    )
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Jetty", status="Ongoing", state="Maharashtra")
    lib = models.LibraryParty(id=uuid.uuid4(), company_id=comp.id, name=f"Konkan Piling {_SFX}", party_type="Subcontractor")
    db.add_all([project, lib])
    db.flush()
    subcon = models.CompanyTeam(id=uuid.uuid4(), company_id=comp.id, user_id=None, library_party_id=lib.id)
    db.add(subcon)
    db.commit()
    return comp, project, subcon, auth_headers(user, comp)


def _work_order(client, hdr, comp, project, subcon):
    r = client.post("/apis/v3/billing/work-orders", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id), "subcontractor_id": str(subcon.id),
        "wo_date": "2026-11-02T00:00:00Z",
        "items": [{"boq_item_id": None, "task_id": None, "quantity": 600, "rate": 6200}],
    })
    assert r.status_code in (200, 201), r.text
    return r.json()


def _ra_bill(client, hdr, comp, project, subcon, subtotal, number):
    return client.post("/apis/v3/billing/bills", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id),
        "party_company_user_id": str(subcon.id), "invoice_number": number,
        "invoice_date": "2026-11-02T00:00:00Z", "invoice_type": "subcon",
        "subtotal": subtotal, "gst_pct": 18,
        "deductions": [
            {"deduction_type": "TDS", "amount": 0, "percentage": 2},
            {"deduction_type": "Retention", "amount": 0, "percentage": 5},
        ],
    })


def test_tds_is_on_the_full_work_value_not_after_retention(client, db, make_tenant, auth_headers):
    comp, project, subcon, hdr = _setup(db, make_tenant, auth_headers, 1)
    r = _ra_bill(client, hdr, comp, project, subcon, 100000, "KPW-RA-1")
    assert r.status_code == 201, r.text
    body = r.json()
    ded = {d["deduction_type"]: float(d["amount"]) for d in body["deductions"]}
    assert ded["TDS"] == 2000.0
    assert ded["Retention"] == 5000.0
    # 1,00,000 - 2,000 - 5,000 + 18,000 GST
    assert float(body["total_payable"]) == 111000.0


def test_work_order_list_counts_the_work_billed(client, db, make_tenant, auth_headers):
    comp, project, subcon, hdr = _setup(db, make_tenant, auth_headers, 2)
    wo = _work_order(client, hdr, comp, project, subcon)
    assert float(wo["estimated_work_amount"]) == 3720000.0

    # 100 rmt of 600 billed: Rs 6,20,000 of work. Net payable is 6,92,920.
    r = _ra_bill(client, hdr, comp, project, subcon, 620000, "KPW-RA-1")
    assert r.status_code == 201, r.text
    assert r.json()["wo_id"] == wo["id"]

    rows = client.get(f"/apis/v3/billing/work-orders?project_id={project.id}", headers=hdr).json()
    row = next(x for x in rows if x["id"] == wo["id"])
    assert row["billed_amount"] == 620000.0
    assert row["progress_pct"] == 16.7


def test_boq_billed_value_is_the_work_billed_not_the_amount_with_gst(client, db, make_tenant, auth_headers):
    """3. The BOQ's Billed Value added up the client invoices with GST, against
    a BOQ value without GST: Rs 10,00,000 of work read as Rs 11,80,000 billed."""
    comp, project, _subcon, hdr = _setup(db, make_tenant, auth_headers, 3)
    lib = models.LibraryParty(id=uuid.uuid4(), company_id=comp.id, name=f"Port Authority {_SFX}", party_type="Client")
    db.add(lib)
    db.flush()
    client_team = models.CompanyTeam(id=uuid.uuid4(), company_id=comp.id, user_id=None, library_party_id=lib.id)
    db.add(client_team)
    db.commit()
    doc = client.post("/apis/v3/budgeting/boq-documents", headers=hdr, json={
        "project_id": str(project.id), "title": "Berth BOQ", "client_party_id": str(lib.id)})
    assert doc.status_code in (200, 201), doc.text
    doc_id = doc.json()["id"]

    line = '[{"desc": "Bored pile", "hsn_sac": "995421", "qty": 1, "rate": 1000000, "amount": 1000000}]'
    r = client.post("/apis/v3/billing/bills", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id),
        "party_company_user_id": str(client_team.id), "invoice_number": "INV-RA-1",
        "invoice_date": "2026-11-02T00:00:00Z", "invoice_type": "sale",
        "subtotal": 1000000, "gst_pct": 18, "items_json": line, "boq_document_id": doc_id,
    })
    assert r.status_code == 201, r.text

    docs = client.get(f"/apis/v3/budgeting/boq-documents?project_id={project.id}", headers=hdr).json()
    assert next(d for d in docs if d["id"] == doc_id)["billed_value"] == 1000000.0


def test_released_retention_is_owed_and_a_payment_settles_it(client, db, make_tenant, auth_headers):
    comp, project, subcon, hdr = _setup(db, make_tenant, auth_headers, 4)
    r = _ra_bill(client, hdr, comp, project, subcon, 100000, "KPW-RA-4")
    assert r.status_code == 201, r.text
    body = r.json()
    retention = next(d for d in body["deductions"] if d["deduction_type"] == "Retention")
    bill = db.get(models.Bill, uuid.UUID(body["id"]))
    bill.approval_flag = "approved"
    bill.paid_amount = 111000
    bill.status = "Paid"
    db.commit()

    r = client.post(f"/apis/v3/billing/bills/{bill.id}/deductions/{retention['id']}/release", headers=hdr,
                    json={"released_amount": 5000})
    assert r.status_code == 200, r.text
    db.expire_all()
    bill = db.get(models.Bill, bill.id)
    assert float(bill.total_payable) == 116000.0
    assert bill.status == "Partially Paid"

    r = client.post("/apis/v3/finance/payments", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id),
        "party_company_user_id": str(subcon.id), "payment_type": "out",
        "amount": 5000, "payment_method": "Bank", "payment_date": "2026-11-02T00:00:00Z"})
    assert r.status_code in (200, 201), r.text
    db.expire_all()
    bill = db.get(models.Bill, bill.id)
    assert bill.status == "Paid" and float(bill.paid_amount) == 116000.0


def test_library_subcontractor_is_listed_for_work_orders(client, db, make_tenant, auth_headers):
    comp, project, subcon, hdr = _setup(db, make_tenant, auth_headers, 5)
    lib = models.LibraryParty(id=uuid.uuid4(), company_id=comp.id, name=f"Raigad Rigs {_SFX}", party_type="Subcontractor")
    db.add(lib)
    db.commit()
    r = client.get(f"/apis/v3/billing/subcontractors?company_id={comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    names = [s["name"] for s in r.json()]
    assert lib.name in names
    assert f"Konkan Piling {_SFX}" in names
    again = client.get(f"/apis/v3/billing/subcontractors?company_id={comp.id}", headers=hdr).json()
    assert [s["name"] for s in again].count(lib.name) == 1


def test_billed_party_is_offered_on_the_transaction_screen(client, db, make_tenant, auth_headers):
    comp, project, subcon, hdr = _setup(db, make_tenant, auth_headers, 6)
    assert _ra_bill(client, hdr, comp, project, subcon, 100000, "KPW-RA-6").status_code == 201
    members = client.get(f"/apis/v3/projects/{project.id}/members", headers=hdr).json()
    assert str(subcon.id) in [m["company_team_id"] for m in members]
