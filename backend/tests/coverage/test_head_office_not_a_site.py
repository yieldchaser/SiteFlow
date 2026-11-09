"""Head Office is a project only so office staff have somewhere to belong.

Asked for during the VCPL rollout: it must not show up as a site in progress,
health or status counts. Its money still counts.
"""
import uuid

from app import models

_SFX = uuid.uuid4().hex[:6]


def test_head_office_left_out_of_site_counts(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name=f"HO Co {_SFX}", user_name="HO",
                                email=f"ho-{_SFX}@example.com")
    hdr = auth_headers(user, comp)
    db.add_all([
        models.Project(id=uuid.uuid4(), company_id=comp.id, name="JNPT Berth", status="Ongoing"),
        models.Project(id=uuid.uuid4(), company_id=comp.id, name="Head Office", status="Ongoing"),
        models.Project(id=uuid.uuid4(), company_id=comp.id, name="Mumbai HQ", status="Ongoing",
                       category="Head Office / Office"),
    ])
    db.commit()

    r = client.get(f"/apis/v3/analytics/company/{comp.id}/operational", headers=hdr)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status_counts"]["Ongoing"] == 1
    assert len(body["projects"]) == 1

    r = client.get(f"/apis/v3/projects/company/{comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    rows = r.json() if isinstance(r.json(), list) else r.json().get("projects", r.json().get("items", []))
    office = {p["name"]: p.get("is_office") for p in rows}
    assert office["Head Office"] is True and office["Mumbai HQ"] is True and office["JNPT Berth"] is False
