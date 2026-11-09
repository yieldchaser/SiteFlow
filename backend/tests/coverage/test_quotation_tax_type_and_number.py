"""A quotation saved with tax type "GST" fell through both tax branches: it
showed 18% and charged nothing. Unknown types are refused, "GST" means tax
on the bill, and a quote saved without a number gets QT-001, QT-002 ...
"""
import uuid

_TAG = uuid.uuid4().hex[:8]
ITEM = {"item_name": "RCC frame", "qty": 10, "unit": "sqft", "cost_price": 800,
        "selling_price": 1000, "supply_rate": 0, "installation_rate": 0,
        "supply_tax_pct": 18, "installation_tax_pct": 12, "markup": 0}


def test_gst_tax_type_charges_tax_and_quotes_get_numbers(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name=f"QT-{_TAG}", user_name=f"QT-{_TAG}",
                                mobile="+917" + str(int(_TAG, 16))[-8:])
    hdr = auth_headers(user, comp)
    r = client.post("/apis/v3/crm/leads", headers=hdr, json={
        "company_id": str(comp.id), "lead_type": "Client", "contact_name": "Vikram",
        "phone_no": "9820011122"})
    assert r.status_code == 201, r.text
    lead_id = r.json()["id"]

    r = client.post(f"/apis/v3/crm/leads/{lead_id}/quotations", headers=hdr, json={
        "subject": "Tower civil", "tax_type": "GST", "gst_pct": 18.0, "items": [ITEM]})
    assert r.status_code == 201, r.text
    q = r.json()
    assert q["tax_type"] == "bill_level", q
    assert round(q["cgst_amount"] + q["sgst_amount"], 2) == 1800.0, q
    assert q["total_amount"] == 11800.0, q
    assert q["qt_no"] == "QT-001", q

    r = client.post(f"/apis/v3/crm/leads/{lead_id}/quotations", headers=hdr, json={
        "subject": "Tower finishing", "items": [ITEM]})
    assert r.json()["qt_no"] == "QT-002", r.text

    r = client.post(f"/apis/v3/crm/leads/{lead_id}/quotations", headers=hdr, json={
        "subject": "Bad", "tax_type": "VAT", "items": [ITEM]})
    assert r.status_code == 422, r.text
