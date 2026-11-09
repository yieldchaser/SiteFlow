"""R2-399 - the invoice PDF must be a valid Indian tax invoice.

Rule 46 of the CGST Rules requires the supplier's name, address and GSTIN; the
recipient's GSTIN; HSN/SAC per line; the rate and amount of tax split into
CGST/SGST/IGST; place of supply; amount in words; and a signature. Earlier
passes on this lineage landed supplier identity (R2-403), recipient GSTIN +
place of supply + HSN/SAC column + tax split (R2-272); this pins the whole
statutory set on one rendered document, including the amount in words, the
reverse-charge declaration and an authorised-signatory block.

Gate: GET /billing/bills/{id}/pdf for a 1,00,000 + 18% intra-state sale
carries every Rule 46 element in the PDF text stream.
"""
import json
import uuid
from datetime import datetime, timezone

from app import models

_SUFFIX = uuid.uuid4().hex[:8]


def test_r2_399_tax_invoice_carries_rule_46_elements(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="R2399 Traders", user_name="U399")
    hdr = auth_headers(user, comp)
    comp.gstin = "29ABCDE1234F1Z5"
    comp.billing_address = "12 MG Road, Bengaluru 560001"
    party = models.LibraryParty(
        id=uuid.uuid4(), company_id=comp.id, name="ZZ QA Client Ltd",
        party_type="Client", tax_no="29FGHIJ5678K1Z2",
    )
    team.library_party_id = party.id
    project = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name="P399",
        code=f"PRJ-399-{_SUFFIX}", status="Ongoing", state="Karnataka",
    )
    db.add_all([party, project])
    db.commit()

    lines = json.dumps([
        {"desc": "Structural steel supply", "hsn_sac": "7214", "qty": 10, "rate": 10000.0, "amount": 100000.0},
    ])
    r = client.post(
        "/apis/v3/billing/bills",
        headers=hdr,
        json={
            "company_id": str(comp.id),
            "project_id": str(project.id),
            "party_company_user_id": str(team.id),
            "invoice_number": f"INV-R399-{_SUFFIX[:6]}",
            "invoice_date": datetime.now(timezone.utc).isoformat(),
            "invoice_type": "sale",
            "subtotal": 100000.0,
            "gst_pct": 18.0,
            "items_json": lines,
            "deductions": [],
        },
    )
    assert r.status_code == 201, r.text
    bill_id = r.json()["id"]

    pdf = client.get(f"/apis/v3/billing/bills/{bill_id}/pdf", headers=hdr)
    assert pdf.status_code == 200, pdf.text
    body = pdf.content
    assert body.startswith(b"%PDF-1.4")

    # Supplier identity (R2-403) and recipient identity / place of supply.
    assert b"GSTIN: 29ABCDE1234F1Z5" in body
    assert b"Address: 12 MG Road" in body
    assert b"Recipient GSTIN: 29FGHIJ5678K1Z2" in body
    assert b"Place of Supply: 29" in body
    # Per-line HSN/SAC and the intra-state CGST/SGST split.
    assert b"HSN/SAC" in body and b"7214" in body
    assert b"CGST: 9,000.00" in body and b"SGST: 9,000.00" in body  # Indian digit grouping
    # The previously-missing statutory elements.
    assert b"Amount in Words: One Lakh Eighteen Thousand Rupees Only" in body
    assert b"Tax Payable Under Reverse Charge: No" in body
    assert b"For R2399 Traders" in body and b"Authorised Signatory" in body
