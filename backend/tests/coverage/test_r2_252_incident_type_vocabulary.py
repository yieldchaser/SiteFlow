"""R2-252 - an incident typed "Fatality" must not vanish from the safety stats.

`incident_type` was unvalidated free text while the LTIF calculation selected
on exact strings ("LTI", "Fatal"), so the ordinary English word "Fatality"
produced a project with a recorded death and a perfect safety record. The
vocabulary is now enforced at the create boundary, and rows stored before the
constraint (the audit project's own "Fatality" row) are mapped into the metric
by the read-side alias so existing data is migrated in effect if not on disk.
"""
import uuid
from datetime import datetime, timedelta, timezone

from app import models

_SUFFIX = uuid.uuid4().hex[:8]

_PAST = datetime.now(timezone.utc) - timedelta(days=1)


def _payload(project_id, incident_type):
    return {
        "project_id": str(project_id),
        "incident_type": incident_type,
        "severity": "Critical",
        "description": "R2-252 regression probe incident",
        "lost_time_days": 4,
        "reported_by": "R2-252 tester",
        "reported_at": _PAST.isoformat(),
    }


def _seed_project(db, comp):
    p = models.Project(
        id=uuid.uuid4(), company_id=comp.id,
        name=f"R2252-P-{_SUFFIX}", code=f"R2252-{_SUFFIX}", status="Ongoing",
    )
    db.add(p)
    db.commit()
    return p


def test_off_vocabulary_incident_type_rejected(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(
        company_name=f"R2252A-{_SUFFIX}", user_name="U2252A",
        mobile=f"+9193{_SUFFIX}", email=f"r2252a-{_SUFFIX}@test.com",
    )
    proj = _seed_project(db, comp)
    hdr = auth_headers(user, comp)

    r = client.post("/apis/v3/safety/incidents", json=_payload(proj.id, "Fatality"), headers=hdr)
    assert r.status_code == 422, r.text
    listing = client.get(f"/apis/v3/safety/incidents/{proj.id}", headers=hdr)
    assert listing.json() == [], listing.text


def test_canonical_types_accepted_and_counted(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(
        company_name=f"R2252B-{_SUFFIX}", user_name="U2252B",
        mobile=f"+9194{_SUFFIX}", email=f"r2252b-{_SUFFIX}@test.com",
    )
    proj = _seed_project(db, comp)
    hdr = auth_headers(user, comp)

    ok = client.post("/apis/v3/safety/incidents", json=_payload(proj.id, "LTI"), headers=hdr)
    assert ok.status_code == 200, ok.text

    stats = client.get(f"/apis/v3/safety/stats/{proj.id}", headers=hdr)
    assert stats.status_code == 200, stats.text
    body = stats.json()
    assert body["total_incidents"] == 1, body
    assert body["lti_count"] == 1, body
    assert body["total_lost_days"] == 4, body
    assert body["ltif"] > 0, body


def test_legacy_stored_row_still_counts_as_lti(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(
        company_name=f"R2252C-{_SUFFIX}", user_name="U2252C",
        mobile=f"+9195{_SUFFIX}1", email=f"r2252c-{_SUFFIX}@test.com",
    )
    proj = _seed_project(db, comp)
    hdr = auth_headers(user, comp)

    # A row stored before the pattern existed: bypass today's schema validator.
    legacy = models.SafetyIncident(
        id=uuid.uuid4(), project_id=proj.id, incident_type="Fatality",
        severity="Critical", description="stored pre-constraint",
        lost_time_days=7, reported_by="audit", reported_at=_PAST.replace(tzinfo=None),
        status="open",
    )
    db.add(legacy)
    db.commit()

    stats = client.get(f"/apis/v3/safety/stats/{proj.id}", headers=hdr)
    assert stats.status_code == 200, stats.text
    body = stats.json()
    assert body["total_incidents"] == 1, body
    assert body["lti_count"] == 1, body
    assert body["total_lost_days"] == 7, body
    assert body["ltif"] > 0, body


def test_lost_days_refused_on_near_miss(client, db, make_tenant, auth_headers):
    """Lost days on a near miss were accepted and then silently left out of
    every statistic (only LTI and Fatal count). They are refused instead."""
    comp, user, _team = make_tenant(
        company_name=f"R2252D-{_SUFFIX}", user_name="U2252D",
        mobile=f"+9192{_SUFFIX}", email=f"r2252d-{_SUFFIX}@test.com",
    )
    proj = _seed_project(db, comp)
    hdr = auth_headers(user, comp)

    r = client.post("/apis/v3/safety/incidents", json=_payload(proj.id, "Near Miss"), headers=hdr)
    assert r.status_code == 422, r.text
    clean = dict(_payload(proj.id, "Near Miss"), lost_time_days=0)
    ok = client.post("/apis/v3/safety/incidents", json=clean, headers=hdr)
    assert ok.status_code in (200, 201), ok.text
