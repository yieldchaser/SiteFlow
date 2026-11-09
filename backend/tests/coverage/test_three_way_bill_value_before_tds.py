"""A three-way match compared the goods with the bill's payable amount, which
is after TDS. TDS is withheld from the supplier, not a price difference, so a
correct bill with 1% TDS read as a mismatch. The bill's value is work + GST."""
import uuid

from app import models
from tests.coverage.test_r2_241_three_way_verdict import _mk_po_grn, _mk_project


def test_bill_with_tds_matches_goods_on_value_before_deductions(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name=f"TW-{uuid.uuid4().hex[:6]}", user_name="TW")
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp, 7)
    po, grn = _mk_po_grn(db, comp, project, total=118000)
    # Work 1,00,000 + GST 18,000 = 1,18,000; 2% TDS on work held back.
    bill = models.Bill(id=uuid.uuid4(), company_id=comp.id, project_id=project.id, party_company_user_id=team.id,
                       invoice_number=f"INV-TW-{uuid.uuid4().hex[:6]}", invoice_date=po.po_date,
                       invoice_type="purchase", subtotal=100000, gst_amount=18000, total_payable=116000)
    db.add(bill)
    db.commit()
    r = client.post("/apis/v3/three-way", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id),
        "po_id": str(po.id), "grn_id": str(grn.id), "invoice_id": str(bill.id),
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["invoiced_amount"] == 118000.0
    assert body["variance_amount"] == 0.0
    assert body["match_status"] == "matched"
