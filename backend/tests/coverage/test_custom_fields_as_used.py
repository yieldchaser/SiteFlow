"""Custom fields, as a company uses them.

- A required "Invoice" field (sales invoices) or "Bill" field (subcontractor
  bills) was required on every bill of every type, so one required field
  blocked purchases, expenses and the other kind of bill.
- A required field counted as filled once its id was sent, even blank.
- Values were saved against a field from any company or record type.
- Subcontractor bill values were filed as "invoice" values.
- Settings had a second manager that sent "Project" in capitals, which the
  server refused, so every save there failed. The Custom Fields page filled
  values in by typing a record's internal ID and could not mark a field
  must-fill.
"""
import json
import uuid
from pathlib import Path

from app import models

FRONT = Path(__file__).resolve().parents[3] / "frontend" / "src" / "app" / "c" / "[company_id]"


def _setup(db, make_tenant, auth_headers):
    t = uuid.uuid4().hex[:8]
    comp, user, _ = make_tenant(company_name=f"CF{t}", user_name=f"CF{t}",
                                mobile="+9175" + str(int(t, 16))[-8:], email=f"cf-{t}@test.com")
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Jetty", status="Ongoing", state="Maharashtra")
    lib = models.LibraryParty(id=uuid.uuid4(), company_id=comp.id, name=f"Party {t}", party_type="Material Supplier")
    db.add_all([project, lib])
    db.flush()
    party = models.CompanyTeam(id=uuid.uuid4(), company_id=comp.id, user_id=None, library_party_id=lib.id)
    db.add(party)
    db.commit()
    return comp, project, party, auth_headers(user, comp)


def _field(client, hdr, comp, entity, label="Client PO", required=True, **kw):
    body = {"company_id": str(comp.id), "entity_type": entity, "field_name": label, "field_label": label,
            "field_type": "text", "is_required": required, "options": []}
    body.update(kw)
    return client.post("/apis/v3/custom-fields/fields", headers=hdr, json=body)


def _bill(client, hdr, comp, project, party, invoice_type, custom_fields=()):
    line = {"desc": "Work", "hsn_sac": "9954", "qty": 1, "rate": 1000, "amount": 1000}
    return client.post("/apis/v3/billing/bills", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id),
        "party_company_user_id": str(party.id), "invoice_number": f"N-{uuid.uuid4().hex[:6]}",
        "invoice_date": "2026-11-02T00:00:00Z", "invoice_type": invoice_type,
        "subtotal": 1000, "gst_pct": 18, "items_json": json.dumps([line]),
        "custom_fields": list(custom_fields),
    })


def test_required_invoice_field_applies_only_to_sales_invoices(client, db, make_tenant, auth_headers):
    comp, project, party, hdr = _setup(db, make_tenant, auth_headers)
    f = _field(client, hdr, comp, "invoice")
    assert f.status_code == 201, f.text
    fid = f.json()["id"]
    assert _bill(client, hdr, comp, project, party, "purchase").status_code == 201
    r = _bill(client, hdr, comp, project, party, "sale")
    assert r.status_code == 422 and "Client PO" in r.json()["detail"]
    # Sent but blank is not filled in.
    assert _bill(client, hdr, comp, project, party, "sale", [{"field_id": fid, "value": "  "}]).status_code == 422
    assert _bill(client, hdr, comp, project, party, "sale", [{"field_id": fid, "value": "PO-77"}]).status_code == 201


def test_subcon_bill_field_values_are_filed_as_bill_values(client, db, make_tenant, auth_headers):
    comp, project, party, hdr = _setup(db, make_tenant, auth_headers)
    fid = _field(client, hdr, comp, "bill", label="RA number").json()["id"]
    assert _bill(client, hdr, comp, project, party, "sale").status_code == 201
    r = _bill(client, hdr, comp, project, party, "subcon", [{"field_id": fid, "value": "RA-3"}])
    assert r.status_code == 201, r.text
    v = db.query(models.CustomFieldValue).filter(models.CustomFieldValue.field_id == uuid.UUID(fid)).one()
    assert (v.entity_type, v.value_text) == ("bill", "RA-3")


def test_value_for_another_companys_field_is_ignored(client, db, make_tenant, auth_headers):
    comp_a, _p, _party, hdr_a = _setup(db, make_tenant, auth_headers)
    other = _field(client, hdr_a, comp_a, "invoice", required=False).json()["id"]
    comp, project, party, hdr = _setup(db, make_tenant, auth_headers)
    r = _bill(client, hdr, comp, project, party, "sale", [{"field_id": other, "value": "x"}])
    assert r.status_code == 201, r.text
    assert db.query(models.CustomFieldValue).filter(models.CustomFieldValue.field_id == uuid.UUID(other)).count() == 0


def test_field_needs_a_name_and_pick_lists_need_choices(client, db, make_tenant, auth_headers):
    comp, _p, _party, hdr = _setup(db, make_tenant, auth_headers)
    assert _field(client, hdr, comp, "project", label="  ").status_code == 422
    r = _field(client, hdr, comp, "project", label="Zone", field_type="select", options=[" ", ""])
    assert r.status_code == 422 and "choices" in r.text
    r = _field(client, hdr, comp, "project", label="Zone", field_type="select", options=[" North ", "South"])
    assert r.status_code == 201 and r.json()["options"] == ["North", "South"]


def test_one_manager_and_no_internal_id_box():
    page = (FRONT / "d" / "custom-fields" / "page.tsx").read_text(encoding="utf-8")
    assert "Entity ID" not in page and "custom-fields/values" not in page
    assert "is_required: form.is_required" in page
    settings = (FRONT / "settings" / "page.tsx").read_text(encoding="utf-8")
    assert '"Project", "Task", "Lead"' not in settings
    assert "/d/custom-fields" in settings
