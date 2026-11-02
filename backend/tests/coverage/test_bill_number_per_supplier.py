"""A supplier's bill number is unique per supplier, not across the company.

Found entering cement bills: bill numbers were unique company-wide, so when two
suppliers both sent "1123" the second could not be entered, and a bill
cancelled for a typing mistake blocked its own real number for ever.

Supplier-numbered bills (purchase, subcon, expense, equipment) are now unique
per supplier among bills not cancelled. The company's own invoices stay unique
company-wide, cancelled or not.
"""
import uuid

import pytest
from sqlalchemy.exc import IntegrityError

from app import models

_SFX = uuid.uuid4().hex[:6]


def _setup(db, make_tenant, auth_headers, tag):
    comp, user, _team = make_tenant(
        company_name=f"BNS-{tag}-{_SFX}", user_name=f"BNS-{tag}",
        mobile=f"+9178{_SFX}{tag:02d}", email=f"bns-{tag}-{_SFX}@test.com",
    )
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Jetty", status="Ongoing", state="Maharashtra")
    db.add(project)
    db.commit()
    return comp, project, auth_headers(user, comp)


def _party(db, comp, name, kind="Material Supplier"):
    lib = models.LibraryParty(id=uuid.uuid4(), company_id=comp.id, name=f"{name} {_SFX}", party_type=kind)
    db.add(lib)
    db.flush()
    team = models.CompanyTeam(id=uuid.uuid4(), company_id=comp.id, user_id=None, library_party_id=lib.id)
    db.add(team)
    db.commit()
    return team


def _bill(client, hdr, comp, project, party, number, invoice_type="purchase"):
    line = {"desc": "OPC Cement", "hsn_sac": "2523", "qty": 1, "rate": 1000, "amount": 1000}
    return client.post("/apis/v3/billing/bills", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id),
        "party_company_user_id": str(party.id), "invoice_number": number,
        "invoice_date": "2026-11-02T00:00:00Z", "invoice_type": invoice_type,
        "subtotal": 1000, "gst_pct": 18, "items_json": f"[{__import__('json').dumps(line)}]",
    })


def test_two_suppliers_can_both_send_bill_1123(client, db, make_tenant, auth_headers):
    comp, project, hdr = _setup(db, make_tenant, auth_headers, 1)
    cement = _party(db, comp, "Cement Depot")
    steel = _party(db, comp, "Steel Traders")

    assert _bill(client, hdr, comp, project, cement, "1123").status_code == 201
    r = _bill(client, hdr, comp, project, steel, "1123")
    assert r.status_code == 201, r.text


def test_same_supplier_cannot_send_the_same_number_twice(client, db, make_tenant, auth_headers):
    comp, project, hdr = _setup(db, make_tenant, auth_headers, 2)
    cement = _party(db, comp, "Cement Depot")

    assert _bill(client, hdr, comp, project, cement, "1123").status_code == 201
    r = _bill(client, hdr, comp, project, cement, "1123")
    assert r.status_code == 400 and "already has a bill numbered 1123" in r.json()["detail"], r.text


def test_a_cancelled_supplier_bill_frees_its_number(client, db, make_tenant, auth_headers):
    comp, project, hdr = _setup(db, make_tenant, auth_headers, 3)
    cement = _party(db, comp, "Cement Depot")

    wrong = _bill(client, hdr, comp, project, cement, "NMCD/1123")
    assert wrong.status_code == 201, wrong.text
    r = client.post(f"/apis/v3/billing/bills/{wrong.json()['id']}/cancel", headers=hdr)
    assert r.status_code == 200, r.text

    r = _bill(client, hdr, comp, project, cement, "NMCD/1123")
    assert r.status_code == 201, r.text


def test_own_sales_invoice_numbers_stay_unique_company_wide(client, db, make_tenant, auth_headers):
    comp, project, hdr = _setup(db, make_tenant, auth_headers, 4)
    port = _party(db, comp, "Port Authority", kind="Client")
    other = _party(db, comp, "Other Client", kind="Client")

    first = _bill(client, hdr, comp, project, port, "INV-001", invoice_type="sale")
    assert first.status_code == 201, first.text
    r = _bill(client, hdr, comp, project, other, "INV-001", invoice_type="sale")
    assert r.status_code == 400 and "already used" in r.json()["detail"], r.text

    # Cancelling does not free a GST serial.
    assert client.post(f"/apis/v3/billing/bills/{first.json()['id']}/cancel", headers=hdr).status_code == 200
    r = _bill(client, hdr, comp, project, other, "INV-001", invoice_type="sale")
    assert r.status_code == 400, r.text


def test_database_refuses_a_duplicate_live_supplier_bill(db, make_tenant):
    comp, _user, _team = make_tenant(
        company_name=f"BNS-db-{_SFX}", user_name="BNS-db", mobile=f"+9178{_SFX}99", email=f"bns-db-{_SFX}@test.com",
    )
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="P", status="Ongoing")
    db.add(project)
    db.commit()
    cement = _party(db, comp, "Cement Depot")
    steel = _party(db, comp, "Steel Traders")

    def row(party, status="Unpaid", invoice_type="purchase"):
        import datetime
        return models.Bill(
            id=uuid.uuid4(), company_id=comp.id, project_id=project.id, party_company_user_id=party.id,
            invoice_number="DB-1", invoice_date=datetime.datetime(2026, 11, 2), invoice_type=invoice_type,
            status=status, subtotal=1, gst_amount=0, total_payable=1)

    db.add_all([row(cement, status="Cancelled"), row(cement), row(steel)])
    db.commit()

    db.add(row(cement))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()
