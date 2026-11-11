"""A project custom field must not ask again for a box the form already has.

VCPL added "Location" and "Start Date" as project custom fields. The project
form then asked for coordinates and a start date twice; staff filled the
custom boxes, and the real ones (read by attendance and the schedule) stayed
wrong or empty.
"""
import uuid


def _make(client, hdr, comp, name, entity="project"):
    return client.post("/apis/v3/custom-fields/fields", headers=hdr, json={
        "company_id": str(comp.id), "entity_type": entity, "field_name": name, "field_label": name,
        "field_type": "text"})


def test_built_in_names_and_repeats_are_refused(client, db, make_tenant, auth_headers):
    t = uuid.uuid4().hex[:8]
    comp, owner, _ = make_tenant(company_name=f"CF{t}", user_name=f"CF{t}",
                                 mobile="+9179" + str(int(t, 16))[-8:], email=f"cf-{t}@test.com")
    hdr = auth_headers(owner, comp)
    for name in ("Location", "Start Date", "start-date", "Site Coordinates", "Planned End Date"):
        r = _make(client, hdr, comp, name)
        assert r.status_code == 400 and "already ask for this" in r.text, (name, r.status_code, r.text)
    r = _make(client, hdr, comp, "Client PO Number")
    assert r.status_code == 201, r.text
    r = _make(client, hdr, comp, "client po number")
    assert r.status_code == 400 and "already a custom field" in r.text, r.text
    # Other records keep their own vocabulary: a bill may well want a "Location".
    assert _make(client, hdr, comp, "Location", entity="bill").status_code == 201
