"""Regression cover for defects found seeding the Shivalik Infracon demo tenant
through the live API on 2026-10-26.
"""

import uuid as _uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def test_received_stock_takes_its_category_from_the_material_library(
    client, db, make_tenant, auth_headers
):
    """Observed: every material received by GRN appeared in stock as
    "Uncategorized", although the Material Library entry had a category. The GRN
    created the warehouse_inventory row without one and nothing ever set it."""
    from app import models

    sfx = _uuid.uuid4().hex[:8]
    comp, user, _team = make_tenant(
        company_name=f"GrnCat-{sfx}", user_name=f"UGrnCat-{sfx}",
        mobile=f"+9195{sfx}", email=f"grncat-{sfx}@test.com",
    )
    hdr = auth_headers(user, comp)

    project = models.Project(
        id=_uuid.uuid4(), company_id=comp.id, name="GRN Category Site", state="Maharashtra"
    )
    supplier = models.LibraryParty(
        id=_uuid.uuid4(), company_id=comp.id, name="Balaji Steels", party_type="Supplier"
    )
    material = models.LibraryMaterial(
        id=_uuid.uuid4(), company_id=comp.id, name="TMT Bar Fe500D 12mm",
        unit="MT", category="Steel & Reinforcement",
    )
    db.add_all([project, supplier, material])
    db.commit()

    po = client.post(
        "/apis/v3/procurement/pos",
        json={
            "company_id": str(comp.id),
            "project_id": str(project.id),
            "vendor_party_id": str(supplier.id),
            "po_number": f"PO-{sfx}",
            "po_date": "2026-10-01T00:00:00Z",
            "items": [{"material_name": "TMT Bar Fe500D 12mm", "quantity": 10,
                       "unit": "MT", "rate": 56000, "tax_pct": 18}],
        },
        headers=hdr,
    )
    assert po.status_code == 201, po.text
    po_body = po.json()
    assert client.post(f"/apis/v3/procurement/pos/{po_body['id']}/approve", headers=hdr).status_code == 200

    grn = client.post(
        "/apis/v3/procurement/grns",
        json={
            "company_id": str(comp.id),
            "project_id": str(project.id),
            "po_id": po_body["id"],
            "grn_number": f"GRN-{sfx}",
            "received_date": "2026-10-05T00:00:00Z",
            "items": [{"po_item_id": po_body["items"][0]["id"], "received_qty": 10}],
        },
        headers=hdr,
    )
    assert grn.status_code == 201, grn.text

    inv = db.query(models.WarehouseInventory).filter(
        models.WarehouseInventory.project_id == project.id
    ).one()
    assert inv.category == "Steel & Reinforcement", (
        f"received stock ignored the library category; got {inv.category!r}"
    )

    # Same GRN: vendor performance refresh crashed on CompanyTeam.user (no such
    # relationship), was swallowed, and the vendor scorecard stayed empty.
    perf = client.get(f"/apis/v3/procurement/vendors/performance/{project.id}", headers=hdr)
    assert perf.status_code == 200, perf.text
    names = [v["vendor_name"] for v in perf.json()]
    assert names == ["Balaji Steels"], f"vendor scorecard not built after a GRN: {names}"
    assert perf.json()[0]["total_grns"] == 1

    # And the PO PDF printed "Vendor: N/A" for every Party Library supplier.
    pdf = client.get(f"/apis/v3/procurement/pos/{po_body['id']}/pdf", headers=hdr)
    assert pdf.status_code == 200
    assert b"Vendor: Balaji Steels" in pdf.content, "PO PDF does not name the supplier"


def test_payment_request_stale_users_fk_has_a_migration():
    """Observed: POST /finance/payment-requests returned 409 'violates foreign key
    constraint payment_requests_party_company_user_id_fkey' for a valid
    company_team id. 20260825_000002 dropped only ONE of the two FKs pointing at
    users (LIMIT 1); the default-named one survived."""
    mig = ROOT / "supabase/migrations/20261026_000001_payment_requests_drop_stale_users_fk.sql"
    assert mig.exists(), "the stale users FK on payment_requests has no migration"
    sql = mig.read_text(encoding="utf-8")
    assert "LIMIT" not in sql.upper().split("$$")[1], (
        "dropping with LIMIT 1 is exactly the bug that left the second FK behind"
    )
    assert "confrelid = 'users'::regclass" in sql


def test_a_client_added_to_a_project_can_be_billed(client, db, make_tenant, auth_headers):
    """Observed: no sales invoice could be raised to a client. The transaction
    screen offers only project members, and a Party Library client never got the
    company_team row a bill's party_company_user_id must point at."""
    from app import models

    sfx = _uuid.uuid4().hex[:8]
    comp, user, _team = make_tenant(
        company_name=f"ClientBill-{sfx}", user_name=f"UClientBill-{sfx}",
        mobile=f"+9194{sfx}", email=f"clientbill-{sfx}@test.com",
    )
    hdr = auth_headers(user, comp)
    project = models.Project(
        id=_uuid.uuid4(), company_id=comp.id, name="Client Bill Site", state="Maharashtra"
    )
    clientp = models.LibraryParty(
        id=_uuid.uuid4(), company_id=comp.id, name="Kolte Patil Developers", party_type="Client"
    )
    db.add_all([project, clientp])
    db.commit()

    res = client.post(
        f"/apis/v3/projects/{project.id}/parties",
        json={"party_id": str(clientp.id)}, headers=hdr,
    )
    assert res.status_code == 200, res.text

    members = client.get(f"/apis/v3/projects/{project.id}/members", headers=hdr).json()
    match = [m for m in members if m["name"] == "Kolte Patil Developers"]
    assert match, f"a client added to the project is not a billable member: {members}"

    bill = client.post(
        "/apis/v3/billing/bills",
        json={
            "company_id": str(comp.id), "project_id": str(project.id),
            "party_company_user_id": match[0]["company_team_id"],
            "invoice_number": f"INV-{sfx}", "invoice_date": "2026-10-20T00:00:00Z",
            "invoice_type": "sale", "subtotal": 1000000, "gst_pct": 18,
            "items_json": '[{"desc": "RA-1 civil works", "hsn_sac": "995411", "qty": 1, "rate": 1000000}]',
        },
        headers=hdr,
    )
    assert bill.status_code == 201, bill.text


def test_a_party_from_another_company_cannot_be_added_to_a_project(
    client, db, make_tenant, auth_headers
):
    from app import models

    sfx = _uuid.uuid4().hex[:8]
    comp, user, _ = make_tenant(
        company_name=f"PA-{sfx}", user_name=f"UPA-{sfx}",
        mobile=f"+9193{sfx}", email=f"pa-{sfx}@test.com",
    )
    other, _u2, _ = make_tenant(
        company_name=f"PB-{sfx}", user_name=f"UPB-{sfx}",
        mobile=f"+9192{sfx}", email=f"pb-{sfx}@test.com",
    )
    project = models.Project(id=_uuid.uuid4(), company_id=comp.id, name="S", state="Goa")
    foreign = models.LibraryParty(id=_uuid.uuid4(), company_id=other.id, name="Foreign Co")
    db.add_all([project, foreign])
    db.commit()
    res = client.post(
        f"/apis/v3/projects/{project.id}/parties",
        json={"party_id": str(foreign.id)}, headers=auth_headers(user, comp),
    )
    assert res.status_code == 404, res.text


def test_billing_list_labels_pre_tax_from_the_stored_flag_not_the_milestone_flag():
    """Observed: every bill in the RA bill list said "Post-Tax", including bills
    created with pre_tax_deductions true. The list read is_milestone_fixed_amount,
    an unrelated column that is always false, and the real flag was never stored."""
    src = (ROOT / "frontend/src/app/c/[company_id]/d/billing/page.tsx").read_text(encoding="utf-8")
    assert "preTax: bill.is_milestone_fixed_amount" not in src
    assert "preTax: Boolean(bill.pre_tax_deductions)" in src


def test_a_pre_tax_bill_reports_itself_as_pre_tax(client, db, make_tenant, auth_headers):
    from app import models

    sfx = _uuid.uuid4().hex[:8]
    comp, user, team = make_tenant(
        company_name=f"PreTax-{sfx}", user_name=f"UPreTax-{sfx}",
        mobile=f"+9191{sfx}", email=f"pretax-{sfx}@test.com",
    )
    project = models.Project(id=_uuid.uuid4(), company_id=comp.id, name="S", state="Maharashtra")
    db.add(project)
    db.commit()
    res = client.post(
        "/apis/v3/billing/bills",
        json={
            "company_id": str(comp.id), "project_id": str(project.id),
            "party_company_user_id": str(team.id), "invoice_number": f"RA-{sfx}",
            "invoice_date": "2026-10-20T00:00:00Z", "invoice_type": "subcon",
            "subtotal": 100000, "gst_pct": 18, "pre_tax_deductions": True,
            "deductions": [{"deduction_type": "TDS", "percentage": 2, "amount": 2000}],
        },
        headers=auth_headers(user, comp),
    )
    assert res.status_code == 201, res.text
    assert res.json()["pre_tax_deductions"] is True


def test_dashboard_reports_unsettled_party_payments_as_advances(
    client, db, make_tenant, auth_headers
):
    """Observed: Advance Paid and Advance Received were always zero on the company
    financial dashboard. They were computed from bills marked Paid with nothing
    payable, which never happens; an advance is a payment with no bill to settle
    against, held in Payment.unsettled_amount."""
    from app import models

    sfx = _uuid.uuid4().hex[:8]
    comp, user, team = make_tenant(
        company_name=f"Adv-{sfx}", user_name=f"UAdv-{sfx}",
        mobile=f"+9190{sfx}", email=f"adv-{sfx}@test.com",
    )
    hdr = auth_headers(user, comp)
    project = models.Project(id=_uuid.uuid4(), company_id=comp.id, name="S", state="Maharashtra")
    nhai = models.LibraryParty(id=_uuid.uuid4(), company_id=comp.id, name="NHAI PIU Pune", party_type="Client")
    elec = models.LibraryParty(id=_uuid.uuid4(), company_id=comp.id, name="Shree Electricals", party_type="Subcontractor")
    db.add_all([project, nhai, elec])
    db.commit()
    ids = {}
    for party in (nhai, elec):
        r = client.post(f"/apis/v3/projects/{project.id}/parties", json={"party_id": str(party.id)}, headers=hdr)
        ids[party.name] = r.json()["company_team_id"]
    # The last row is a cash hand-over to a staff member, not a party advance.
    for party_team, ptype, amt in (
        (ids["NHAI PIU Pune"], "in", 500000),
        (ids["Shree Electricals"], "out", 120000),
        (str(team.id), "out", 9000),
    ):
        res = client.post(
            "/apis/v3/finance/payments",
            json={
                "company_id": str(comp.id), "project_id": str(project.id),
                "party_company_user_id": party_team, "payment_type": ptype,
                "amount": amt, "payment_method": "Bank Transfer",
                "payment_date": "2026-10-20", "description": "Mobilisation advance",
            },
            headers=hdr,
        )
        assert res.status_code in (200, 201), res.text

    fin = client.get(f"/apis/v3/analytics/company/{comp.id}/financial", headers=hdr)
    assert fin.status_code == 200, fin.text
    body = fin.json()
    assert body["advance_received"] == 500000, body
    assert body["advance_paid"] == 120000, body


def test_operational_dashboard_rows_name_the_client_and_the_key_person(
    client, db, make_tenant, auth_headers
):
    """Observed: the company dashboard project table showed the project category
    ("Residential") as the customer, "Supervisor" as key personnel for every
    project, and an On Hold project as Healthy."""
    from app import models

    sfx = _uuid.uuid4().hex[:8]
    comp, user, team = make_tenant(
        company_name=f"Ops-{sfx}", user_name=f"Anita Kulkarni {sfx}",
        mobile=f"+9189{sfx}", email=f"ops-{sfx}@test.com",
    )
    hdr = auth_headers(user, comp)
    project = models.Project(
        id=_uuid.uuid4(), company_id=comp.id, name="Kharadi Mall", state="Maharashtra",
        category="Commercial", status="On Hold", key_personnel_id=team.id,
    )
    clientp = models.LibraryParty(
        id=_uuid.uuid4(), company_id=comp.id, name="Panchshil Realty", party_type="Client"
    )
    db.add_all([project, clientp])
    db.commit()
    from datetime import datetime as _dt
    db.add_all([
        models.Task(id=_uuid.uuid4(), project_id=project.id, name="Excavation", duration_days=10,
                    start_date=_dt(2026, 2, 1), end_date=_dt(2026, 2, 11), status="completed", progress=100),
        models.Task(id=_uuid.uuid4(), project_id=project.id, name="Shoring", duration_days=30,
                    start_date=_dt(2026, 2, 11), end_date=_dt(2026, 3, 13), status="in_progress", progress=50),
    ])
    db.commit()
    assert client.post(
        f"/apis/v3/projects/{project.id}/parties", json={"party_id": str(clientp.id)}, headers=hdr
    ).status_code == 200

    res = client.get(f"/apis/v3/analytics/company/{comp.id}/operational", headers=hdr)
    assert res.status_code == 200, res.text
    row = [r for r in res.json()["projects"] if r["project_id"] == str(project.id)][0]
    assert row["customer_name"] == "Panchshil Realty", row
    assert row["key_personnel"] == f"Anita Kulkarni {sfx}", row
    assert row["health"] == "Onhold", row
    assert res.json()["health_counts"]["Onhold"] == 1
    # The project page shows duration-weighted progress, (10 + 15) / 40; the
    # company table counted completed tasks (1 of 2) and showed 50%.
    page = client.get(f"/apis/v3/projects/{project.id}", headers=hdr).json()
    assert row["progress"] == page["progress"] == 62.5, (row["progress"], page["progress"])


def test_key_personnel_must_belong_to_the_project_company(client, db, make_tenant, auth_headers):
    from app import models

    sfx = _uuid.uuid4().hex[:8]
    comp, user, _ = make_tenant(
        company_name=f"KP-{sfx}", user_name=f"UKP-{sfx}", mobile=f"+9188{sfx}", email=f"kp-{sfx}@test.com",
    )
    _other, _u2, foreign_team = make_tenant(
        company_name=f"KPB-{sfx}", user_name=f"UKPB-{sfx}", mobile=f"+9187{sfx}", email=f"kpb-{sfx}@test.com",
    )
    project = models.Project(id=_uuid.uuid4(), company_id=comp.id, name="S", state="Goa")
    db.add(project)
    db.commit()
    res = client.patch(
        f"/apis/v3/planning/projects/{project.id}",
        json={"key_personnel_id": str(foreign_team.id)}, headers=auth_headers(user, comp),
    )
    assert res.status_code == 400, res.text


def _walk_pdf(pdf: bytes):
    """Follow a PDF the way a viewer does: trailer Root -> Catalog -> Pages ->
    each Page, checking every xref offset lands on its object. Returns the
    page content streams."""
    import re

    objs = {int(m.group(1)): m.start() for m in re.finditer(rb"(\d+) 0 obj\n", pdf)}

    def body(oid):
        start = pdf.index(b"obj\n", objs[oid]) + 4
        return pdf[start:pdf.index(b"endobj", start)]

    xref = pdf[int(pdf.rsplit(b"startxref\n", 1)[1].split()[0]):]
    assert xref.startswith(b"xref"), "startxref does not point at the xref table"
    for oid, line in enumerate(xref.split(b"\n")[3:3 + len(objs)], start=1):
        assert int(line[:10]) == objs[oid], f"xref offset wrong for object {oid}"

    root = int(re.search(rb"/Root (\d+) 0 R", pdf.rsplit(b"trailer", 1)[1]).group(1))
    assert b"/Type /Catalog" in body(root), f"trailer /Root {root} is not the Catalog"
    pages_id = int(re.search(rb"/Pages (\d+) 0 R", body(root)).group(1))
    pages = body(pages_id)
    assert b"/Type /Pages" in pages, f"Catalog /Pages {pages_id} is not a Pages tree: {pages[:60]!r}"
    streams = []
    for kid in re.findall(rb"(\d+) 0 R", pages.split(b"/Kids", 1)[1].split(b"]", 1)[0]):
        page = body(int(kid))
        assert b"/Type /Page" in page
        assert re.search(rb"/Parent (\d+) 0 R", page) and int(
            re.search(rb"/Parent (\d+) 0 R", page).group(1)) == pages_id, "Page /Parent is not the Pages tree"
        streams.append(body(int(re.search(rb"/Contents (\d+) 0 R", page).group(1))))
    assert streams, "PDF has no pages"
    return streams


def test_document_and_report_pdfs_have_reachable_pages():
    """Observed: a PO downloaded as PDF opened blank. The file held the text,
    but the Catalog and Page pointed /Pages and /Parent at "2 0 R", the
    Helvetica font object, so no viewer could find a page. Client report PDFs
    had /Root pointing at the content stream."""
    from app.utils.pdf_generator import generate_client_report_pdf, generate_document_pdf

    po = generate_document_pdf(
        title="Purchase Order", party_lines=["Vendor: Balaji Steels"],
        table_headers=["Material", "Qty"], table_rows=[["TMT Bar 12mm", "10"]],
        col_widths=[30, 8], totals_lines=["Total: 731600.00"], company_name="Shivalik Infracon",
    )
    streams = _walk_pdf(po)
    assert b"TMT Bar 12mm" in b"".join(streams)

    long_po = generate_document_pdf(
        title="Purchase Order", table_headers=["Material", "Qty"],
        table_rows=[[f"Item {i}", "1"] for i in range(150)], col_widths=[30, 8],
    )
    assert len(_walk_pdf(long_po)) > 1

    report = generate_client_report_pdf(title="Monthly Report", summary="Progress on track.", metrics={"Progress": "46%"})
    assert b"Monthly Report" in b"".join(_walk_pdf(report))


def test_project_party_register_shows_client_dues_and_advances(client, db, make_tenant, auth_headers):
    """Observed on the project Party page: the client showed Rs 0 balance with
    Rs 4 Cr of its invoices unpaid, Advance Paid showed Rs 0 after a Rs 7.5 L
    advance to a subcontractor, and that subcontractor was not on the list at
    all. Only expense bills fed the ledger, and a payment never linked its party
    to the project."""
    from app import models

    sfx = _uuid.uuid4().hex[:8]
    comp, user, _team = make_tenant(
        company_name=f"PPL-{sfx}", user_name=f"UPPL-{sfx}", mobile=f"+9186{sfx}", email=f"ppl-{sfx}@test.com",
    )
    hdr = auth_headers(user, comp)
    project = models.Project(id=_uuid.uuid4(), company_id=comp.id, name="Shivalik Heights", state="Maharashtra")
    kolte = models.LibraryParty(id=_uuid.uuid4(), company_id=comp.id, name="Kolte Patil", party_type="Client")
    elec = models.LibraryParty(id=_uuid.uuid4(), company_id=comp.id, name="Shree Electricals", party_type="Subcontractor")
    db.add_all([project, kolte, elec])
    db.commit()
    kolte_team = client.post(
        f"/apis/v3/projects/{project.id}/parties", json={"party_id": str(kolte.id)}, headers=hdr
    ).json()["company_team_id"]

    bill = client.post(
        "/apis/v3/billing/bills",
        json={
            "company_id": str(comp.id), "project_id": str(project.id),
            "party_company_user_id": kolte_team, "invoice_number": f"INV-{sfx}",
            "invoice_date": "2026-10-01T00:00:00Z", "invoice_type": "sale", "subtotal": 1000000, "gst_pct": 18,
            "items_json": '[{"desc": "RA-1 civil works", "hsn_sac": "995411", "qty": 1, "rate": 1000000}]',
        },
        headers=hdr,
    )
    assert bill.status_code == 201, bill.text

    # Shree Electricals is paid an advance before it is ever added to the project.
    from app.routers.procurement import _company_team_id_for_party
    elec_team = _company_team_id_for_party(db, comp.id, elec.id)
    db.commit()
    res = client.post(
        "/apis/v3/finance/payments",
        json={
            "company_id": str(comp.id), "project_id": str(project.id),
            "party_company_user_id": str(elec_team), "payment_type": "out", "amount": 75000,
            "payment_method": "Bank Transfer", "payment_date": "2026-10-05", "description": "Mobilisation advance",
        },
        headers=hdr,
    )
    assert res.status_code in (200, 201), res.text

    rows = {r["name"]: r for r in client.get(f"/apis/v3/projects/{project.id}/parties", headers=hdr).json()}
    assert "Shree Electricals" in rows, f"a party paid on the project is missing from its register: {list(rows)}"
    assert rows["Shree Electricals"]["advance_paid"] == 75000, rows["Shree Electricals"]
    assert rows["Kolte Patil"]["to_receive"] == 1180000, rows["Kolte Patil"]
    assert rows["Kolte Patil"]["balance"] == 1180000

    totals = client.get(f"/apis/v3/projects/{project.id}/parties/balances", headers=hdr).json()
    assert totals["advance_paid"] == 75000 and totals["to_receive"] == 1180000, totals


def test_finance_feed_names_equipment_and_other_expense_bills(client, db, make_tenant, auth_headers):
    """Observed: equipment hire bills appeared in the transaction feed typed
    "equipment", a raw key, beside "Sales Invoice" and "Material Purchase"."""
    from app import models

    sfx = _uuid.uuid4().hex[:8]
    comp, user, team = make_tenant(
        company_name=f"Feed-{sfx}", user_name=f"UFeed-{sfx}", mobile=f"+9185{sfx}", email=f"feed-{sfx}@test.com",
    )
    hdr = auth_headers(user, comp)
    project = models.Project(id=_uuid.uuid4(), company_id=comp.id, name="S", state="Maharashtra")
    db.add(project)
    db.commit()
    for itype, num in (("equipment", "SER/1"), ("expense", "EXP/1")):
        r = client.post(
            "/apis/v3/billing/bills",
            json={
                "company_id": str(comp.id), "project_id": str(project.id),
                "party_company_user_id": str(team.id), "invoice_number": f"{num}-{sfx}",
                "invoice_date": "2026-10-20T00:00:00Z", "invoice_type": itype, "subtotal": 10000, "gst_pct": 18,
            },
            headers=hdr,
        )
        assert r.status_code == 201, r.text
    feed = client.get(f"/apis/v3/finance/transactions/{comp.id}", headers=hdr).json()["transactions"]
    assert sorted(t["type"] for t in feed) == ["Equipment Expense", "Other Expense"], [t["type"] for t in feed]
