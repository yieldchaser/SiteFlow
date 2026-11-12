"""A double click on Save added the same vendor twice (VCPL, 2026-11-12).

The library now refuses a second entry with the same name, ignoring case and
extra spaces, on add and on rename, and the form sends one save at a time.
"""
import pathlib
import uuid

API = "/apis/v3/library"
PAGE = (pathlib.Path(__file__).resolve().parents[3] / "frontend" / "src" / "app" / "c" / "[company_id]"
        / "d" / "library" / "page.tsx")


def _tenant(make_tenant, auth_headers):
    sfx = uuid.uuid4().hex[:8]
    comp, user, _ = make_tenant(company_name=f"LIBDUP-{sfx}", user_name=f"ULD-{sfx}",
                                mobile=f"+9194{sfx}", email=f"libdup-{sfx}@test.com")
    return str(comp.id), auth_headers(user, comp)


def _party(client, hdr, cid, name, kind="Vendor"):
    return client.post(f"{API}/parties", headers=hdr, json={"company_id": cid, "name": name, "party_type": kind})


def test_second_vendor_with_same_name_is_refused(client, make_tenant, auth_headers):
    cid, hdr = _tenant(make_tenant, auth_headers)
    assert _party(client, hdr, cid, "Shree Cement Traders").status_code in (200, 201)
    again = _party(client, hdr, cid, "Shree Cement Traders")
    assert again.status_code == 409, again.text
    assert "already in the library" in again.text
    # Case and spacing do not make a new vendor.
    assert _party(client, hdr, cid, "  shree   cement TRADERS ").status_code == 409
    rows = client.get(f"{API}/parties/{cid}", headers=hdr).json()
    rows = rows.get("items", rows) if isinstance(rows, dict) else rows
    assert sum(1 for r in rows if r["name"].lower().startswith("shree cement")) == 1


def test_same_name_as_a_different_party_type_is_allowed(client, make_tenant, auth_headers):
    cid, hdr = _tenant(make_tenant, auth_headers)
    assert _party(client, hdr, cid, "Patel Infra").status_code in (200, 201)
    assert _party(client, hdr, cid, "Patel Infra", "Client").status_code in (200, 201)


def test_rename_onto_an_existing_vendor_is_refused(client, make_tenant, auth_headers):
    cid, hdr = _tenant(make_tenant, auth_headers)
    _party(client, hdr, cid, "Alpha Steel")
    beta = _party(client, hdr, cid, "Beta Steel").json()
    r = client.put(f"{API}/parties/{beta['id']}", headers=hdr, json={"name": "ALPHA steel"})
    assert r.status_code == 409, r.text
    # Saving a vendor without changing its name still works.
    r = client.put(f"{API}/parties/{beta['id']}", headers=hdr, json={"name": "Beta Steel", "phone": "9876543210"})
    assert r.status_code == 200, r.text


def test_materials_and_rates_refuse_repeats(client, make_tenant, auth_headers):
    cid, hdr = _tenant(make_tenant, auth_headers)
    m = {"company_id": cid, "name": "OPC Cement 53", "unit": "Bag"}
    assert client.post(f"{API}/materials", headers=hdr, json=m).status_code in (200, 201)
    assert client.post(f"{API}/materials", headers=hdr, json=m).status_code == 409
    r = {"company_id": cid, "name": "Excavation", "unit": "Cum"}
    assert client.post(f"{API}/rates", headers=hdr, json=r).status_code in (200, 201)
    assert client.post(f"{API}/rates", headers=hdr, json=r).status_code == 409
    # The same work in another unit is a different rate.
    assert client.post(f"{API}/rates", headers=hdr, json={**r, "unit": "Sqm"}).status_code in (200, 201)


def test_subcontractor_quick_add_refuses_repeat(client, make_tenant, auth_headers):
    cid, hdr = _tenant(make_tenant, auth_headers)
    body = {"company_id": cid, "name": "Ravi Shuttering Works"}
    assert client.post("/apis/v3/billing/subcontractors", headers=hdr, json=body).status_code == 201
    assert client.post("/apis/v3/billing/subcontractors", headers=hdr, json=body).status_code == 409


def test_library_form_sends_one_save_at_a_time():
    src = PAGE.read_text(encoding="utf-8")
    for h in ("handleCreateSimple", "handleCreateParty", "handleCreateMaterial", "handleCreateRate"):
        assert f"onSubmit={{onceAtATime({h})}}" in src, h
    assert src.count("disabled={saving}") >= 4
