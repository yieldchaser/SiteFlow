"""Invoice, PO and BOQ PDFs padded table columns with spaces in a
proportional font, printed raw floats, said "Twenty Zero Paise", and were
named with slashes ("SIC/26-27/INV-007.pdf"). Amounts now carry Indian digit
grouping, words read correctly, and downloads get a safe filename.
"""
import datetime
import json
import uuid

from app import models
from app.routers.billing import _amount_in_words


def test_amount_in_words_has_no_twenty_zero():
    assert _amount_in_words(3653327.20) == (
        "Thirty Six Lakh Fifty Three Thousand Three Hundred Twenty Seven Rupees and Twenty Paise Only")
    assert _amount_in_words(0.29) == "Zero Rupees and Twenty Nine Paise Only"


def test_invoice_pdf_groups_amounts_and_names_file_safely(client, db, make_tenant, auth_headers):
    tag = uuid.uuid4().hex[:8]
    comp, user, team = make_tenant(company_name=f"PDF-{tag}", user_name=f"PDF-{tag}",
                                   mobile="+917" + str(int(tag, 16))[-8:])
    comp.gstin = "27AABCV1234F1Z5"
    hdr = auth_headers(user, comp)
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Tower", code=f"T-{tag}",
                             status="Ongoing", state="27")
    db.add(project)
    db.flush()
    bill = models.Bill(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, party_company_user_id=team.id,
        invoice_number=f"SIC/26-27/INV-{tag}", invoice_date=datetime.datetime(2026, 10, 20),
        invoice_type="sale", subtotal=3096040.0, gst_amount=557287.2, total_payable=3653327.2,
        paid_amount=0.0, status="Unpaid", approval_flag="approved",
        items_json=json.dumps([{"desc": "RCC frame", "hsn_sac": "995411", "qty": "1450.5",
                                "rate": "1450", "amount": "2103225"}]))
    db.add(bill)
    db.commit()

    r = client.get(f"/apis/v3/billing/bills/{bill.id}/pdf", headers=hdr)
    assert r.status_code == 200, r.text
    body = r.content
    assert b"Total Payable: 36,53,327.20" in body, body[:400]
    assert b"21,03,225.00" in body
    assert b"Place of Supply: 27 \(Maharashtra\)" in body
    assert b"Invoice Date: 20 Oct 2026" in body
    assert b"Twenty Zero" not in body
    disp = r.headers["content-disposition"]
    assert f"SIC-26-27-INV-{tag}.pdf" in disp and "/" not in disp.split("filename=")[1], disp
