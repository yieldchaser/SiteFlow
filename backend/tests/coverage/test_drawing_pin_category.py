"""A drawing pin keeps its kind.

The drawing screen lets you drop an RFI, Clash, Observation or Approval pin
and filter by kind, but the API neither took nor stored the kind: every pin
came back as an Observation after a reload, so the RFI filter never showed
an RFI. The pin now carries its category end to end.
"""
import uuid

from app import models

_TAG = uuid.uuid4().hex[:8]
_MOB = "+9172" + str(int(_TAG, 16))[-8:]


def test_pin_category_round_trips(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name=f"PinCat-{_TAG}", user_name="PinCat",
                                mobile=_MOB, email=f"pincat-{_TAG}@test.com")
    hdr = auth_headers(user, comp)
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Tower", status="Ongoing")
    db.add(project)
    db.flush()
    drawing = models.Drawing(id=uuid.uuid4(), project_id=project.id, name="GA Plan", category="2D Layout")
    db.add(drawing)
    db.flush()
    rev = models.DrawingRevision(id=uuid.uuid4(), drawing_id=drawing.id, version_code="V1",
                                 file_url="/plans/ga_v1.pdf", approval_status="pending")
    db.add(rev)
    db.commit()

    r = client.post(f"/apis/v3/drawings/revisions/{rev.id}/pins", headers=hdr, json={
        "x_coordinate": 10, "y_coordinate": 20, "comment": "Beam depth clashes with duct", "category": "Clash",
    })
    assert r.status_code in (200, 201), r.text
    assert r.json()["category"] == "Clash"

    plain = client.post(f"/apis/v3/drawings/revisions/{rev.id}/pins", headers=hdr, json={
        "x_coordinate": 30, "y_coordinate": 40, "comment": "Note",
    })
    assert plain.status_code in (200, 201), plain.text
    assert plain.json()["category"] == "Observation"

    bad = client.post(f"/apis/v3/drawings/revisions/{rev.id}/pins", headers=hdr, json={
        "x_coordinate": 1, "y_coordinate": 1, "comment": "x", "category": "Gossip",
    })
    assert bad.status_code == 422

    listed = client.get(f"/apis/v3/drawings?project_id={project.id}", headers=hdr)
    assert listed.status_code == 200, listed.text
    pins = listed.json()[0]["revisions"][0]["pins"]
    assert sorted(p["category"] for p in pins) == ["Clash", "Observation"]
