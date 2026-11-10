"""Tier 2 Parity Item 5: Custom fields for lead and vendor.
"""
from pathlib import Path
import uuid

from app import models

_SUFFIX = uuid.uuid4().hex[:8]


def _tenant(make_tenant, auth_headers):
    comp, user, team = make_tenant(
        company_name=f"P5-{_SUFFIX}",
        user_name="U-P5",
        mobile=f"+9191{uuid.uuid4().hex[:8]}",
        email=f"p5-{uuid.uuid4().hex[:8]}@test.com",
    )
    return comp, user, team, auth_headers(user, comp)


def test_parity_tier2_custom_fields_lead_and_vendor(client, db, make_tenant, auth_headers):
    comp, user, team, hdr = _tenant(make_tenant, auth_headers)

    # 1. Verify custom field creation for lead
    res_lead = client.post(
        "/apis/v3/custom-fields/fields",
        headers=hdr,
        json={
            "company_id": str(comp.id),
            "entity_type": "lead",
            "field_name": "lead_source_detail",
            "field_label": "Lead Source Detail",
            "field_type": "text",
            "is_required": False,
        },
    )
    assert res_lead.status_code == 201, res_lead.text
    lead_cf = res_lead.json()
    assert lead_cf["entity_type"] == "lead"

    # 2. Verify custom field creation for vendor
    res_vendor = client.post(
        "/apis/v3/custom-fields/fields",
        headers=hdr,
        json={
            "company_id": str(comp.id),
            "entity_type": "vendor",
            "field_name": "vendor_compliance_grade",
            "field_label": "Vendor Compliance Grade",
            "field_type": "text",
            "is_required": False,
        },
    )
    assert res_vendor.status_code == 201, res_vendor.text
    vendor_cf = res_vendor.json()
    assert vendor_cf["entity_type"] == "vendor"

    # 3. Verify querying fields filtered by entity_type
    fields_lead = client.get(f"/apis/v3/custom-fields/fields/{comp.id}?entity_type=lead", headers=hdr)
    assert fields_lead.status_code == 200
    assert any(f["field_name"] == "lead_source_detail" for f in fields_lead.json())

    fields_vendor = client.get(f"/apis/v3/custom-fields/fields/{comp.id}?entity_type=vendor", headers=hdr)
    assert fields_vendor.status_code == 200
    assert any(f["field_name"] == "vendor_compliance_grade" for f in fields_vendor.json())

    # 4. No form shows lead or vendor fields, so the page does not offer to
    # make them; any that exist are listed under "Not on any form" to delete.
    page_path = (
        Path(__file__).resolve().parents[3]
        / "frontend" / "src" / "app" / "c" / "[company_id]" / "d" / "custom-fields" / "page.tsx"
    )
    page_content = page_path.read_text(encoding="utf-8")
    assert "Not on any form" in page_content
