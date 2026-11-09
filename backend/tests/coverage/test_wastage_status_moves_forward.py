"""Wastage moves one step at a time and needs a real quantity.

The status endpoint took any status in any order: a fresh report could be
marked disposed without review or approval, and a disposed record could be
walked back to reported. Quantity 0 was accepted, so empty records reached
the register and reports.
"""
import uuid
from decimal import Decimal

from app import models

_TAG = uuid.uuid4().hex[:8]


def _setup(db, make_tenant, auth_headers, n):
    comp, user, _ = make_tenant(company_name=f"WSF{n}-{_TAG}", user_name=f"WSF{n}",
                                mobile=f"+917{n}" + str(int(_TAG, 16))[-8:], email=f"wsf{n}-{_TAG}@test.com")
    hdr = auth_headers(user, comp)
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="P", status="Ongoing")
    db.add(project)
    db.commit()
    db.add(models.WarehouseInventory(id=uuid.uuid4(), project_id=project.id, material_name="Cement",
                                     on_hand_qty=Decimal("50"), reserved_qty=Decimal("0"), unit="bag"))
    db.commit()
    return comp, project, hdr


def _payload(comp, project, qty):
    return {"company_id": str(comp.id), "project_id": str(project.id), "material_name": "Cement",
            "wastage_type": "damaged", "quantity": qty, "unit": "bag"}


def test_status_moves_one_step_at_a_time(client, db, make_tenant, auth_headers):
    comp, project, hdr = _setup(db, make_tenant, auth_headers, 3)
    w = client.post("/apis/v3/wastage", json=_payload(comp, project, 2), headers=hdr)
    assert w.status_code == 201, w.text
    wid = w.json()["id"]

    skip = client.patch(f"/apis/v3/wastage/{wid}/status?status=disposed", headers=hdr)
    assert skip.status_code == 400, skip.text

    for s in ("reviewed", "approved", "disposed"):
        r = client.patch(f"/apis/v3/wastage/{wid}/status?status={s}", headers=hdr)
        assert r.status_code == 200, r.text
        assert r.json()["status"] == s

    back = client.patch(f"/apis/v3/wastage/{wid}/status?status=reported", headers=hdr)
    assert back.status_code == 400, back.text


def test_zero_quantity_is_refused(client, db, make_tenant, auth_headers):
    comp, project, hdr = _setup(db, make_tenant, auth_headers, 4)
    r = client.post("/apis/v3/wastage", json=_payload(comp, project, 0), headers=hdr)
    assert r.status_code == 422, r.text
