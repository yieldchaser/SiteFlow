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
