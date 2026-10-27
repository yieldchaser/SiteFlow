"""Procurement > Record Usage: the "Consumption Reference (Location / Lorry No.)"
box was drawn but never sent, and the API dropped any note on a non-adjustment
movement anyway. The note now travels and comes back on the stock ledger."""
import uuid

from app import models


def test_usage_keeps_its_location_note(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(company_name=f"Stock Co {uuid.uuid4().hex[:6]}", user_name="Owner")
    hdr = auth_headers(user, comp)
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Tower", status="Ongoing")
    db.add(project)
    db.commit()

    r = client.post("/apis/v3/procurement/transactions", headers=hdr,
                    json={"project_id": str(project.id), "material_name": "Cement OPC 53", "type": "received", "qty": 100})
    assert r.status_code == 201, r.text
    r = client.post("/apis/v3/procurement/transactions", headers=hdr,
                    json={"project_id": str(project.id), "material_name": "Cement OPC 53", "type": "used", "qty": 20,
                          "reason": "Tower A L6 slab, lorry MH12 AB 1234"})
    assert r.status_code == 201, r.text
    assert r.json()["reason"] == "Tower A L6 slab, lorry MH12 AB 1234"

    rows = client.get(f"/apis/v3/procurement/transactions?project_id={project.id}", headers=hdr).json()
    used = [t for t in rows if t["type"] == "used"]
    assert [t["reason"] for t in used] == ["Tower A L6 slab, lorry MH12 AB 1234"]
