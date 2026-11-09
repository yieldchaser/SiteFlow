"""Editing a lead dropped the description it was sent, and a follow-up date
could never be cleared once set because blank fields were ignored. Fields
the caller sends now apply, blank included; fields left out stay as they were.
"""
import uuid

_TAG = uuid.uuid4().hex[:8]


def test_lead_edit_saves_description_and_clears_follow_up(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name=f"LE-{_TAG}", user_name=f"LE-{_TAG}",
                                mobile="+917" + str(int(_TAG, 16))[-8:])
    hdr = auth_headers(user, comp)
    r = client.post("/apis/v3/crm/leads", headers=hdr, json={
        "company_id": str(comp.id), "lead_type": "Client", "contact_name": "Meera",
        "phone_no": "9890044455", "next_follow_up": "2026-11-05T00:00:00Z",
        "description": "Wants a G+4 school block"})
    assert r.status_code == 201, r.text
    lead_id = r.json()["id"]

    r = client.put(f"/apis/v3/crm/leads/{lead_id}", headers=hdr, json={
        "description": "Site visit done, sending rates", "next_follow_up": None})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["description"] == "Site visit done, sending rates", body
    assert body["next_follow_up"] is None, body
    # Not sent, so not touched.
    assert body["contact_name"] == "Meera", body
