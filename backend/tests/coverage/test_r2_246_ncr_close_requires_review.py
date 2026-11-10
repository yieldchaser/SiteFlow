"""R2-246 — a Critical NCR can no longer be closed in one call straight from open.

Gate: PATCH /quality/ncr/{id}/close requires the NCR to have passed through
review first (status under_review, reviewer recorded by /review) before it can
be closed. Before the fix, an NCR raised and closed four seconds later recorded
no independent sign-off. Also, an NCR can no longer be born six years overdue:
a due_date in the past is rejected with a 422 at creation.
"""
import uuid

from app import models


def _mk_project(db, comp, tag):
    p = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name=f"P{tag}", code=f"PRJ-{uuid.uuid4().hex[:8]}-{tag}", status="Ongoing"
    )
    db.add(p)
    db.commit()
    return p


def _raise_ncr(client, comp, project, hdr, number, **extra):
    return client.post(
        "/apis/v3/quality/ncr",
        json={
            "project_id": str(project.id),
            "ncr_number": number,
            "title": "Honeycombing in column",
            "severity": "Critical",
            **extra,
        },
        headers=hdr,
    )


def test_open_ncr_cannot_be_closed_without_review(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="R246A", user_name="U246A")
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp, 1)
    r = _raise_ncr(client, comp, project, hdr, f"NCR-R246A-{uuid.uuid4().hex[:6]}")
    assert r.status_code == 201
    assert r.json()["status"] == "open"
    ncr_id = r.json()["id"]

    close = client.patch(
        f"/apis/v3/quality/ncr/{ncr_id}/close",
        json={"resolution_notes": "ZZ closed without review"},
        headers=hdr,
    )
    assert close.status_code == 400
    assert "reviewed" in close.json()["detail"].lower()

    db.expire_all()
    row = db.query(models.NCR).filter_by(id=ncr_id).first()
    assert row.status == "open"
    assert row.closed_at is None
    assert row.closed_by is None


def test_review_then_close_records_both_actors(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="R246B", user_name="U246B")
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp, 2)
    r = _raise_ncr(client, comp, project, hdr, f"NCR-R246B-{uuid.uuid4().hex[:6]}")
    ncr_id = r.json()["id"]

    rev = client.patch(f"/apis/v3/quality/ncr/{ncr_id}/review", headers=hdr)
    assert rev.status_code == 200
    body = rev.json()
    assert body["status"] == "under_review"
    assert body["reviewed_by"] == str(user.id)
    assert body["reviewed_at"] is not None

    cl = client.patch(
        f"/apis/v3/quality/ncr/{ncr_id}/close",
        json={"resolution_notes": "Rectified and re-poured"},
        headers=hdr,
    )
    assert cl.status_code == 200
    closed = cl.json()
    assert closed["status"] == "closed"
    assert closed["reviewed_by"] == str(user.id)
    assert closed["closed_by"] == str(user.id)
    assert closed["closed_at"] is not None
    assert closed["resolution_notes"] == "Rectified and re-poured"


def test_ncr_cannot_be_born_overdue(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="R246C", user_name="U246C")
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp, 3)

    past = _raise_ncr(
        client, comp, project, hdr,
        f"NCR-R246C-{uuid.uuid4().hex[:6]}", due_date="2020-01-01T00:00:00Z",
    )
    assert past.status_code == 422
    assert any("due_date" in str(err.get("msg", "")) for err in past.json().get("detail", []))

    future = _raise_ncr(
        client, comp, project, hdr,
        f"NCR-R246C-{uuid.uuid4().hex[:6]}", due_date="2099-01-01T00:00:00Z",
    )
    assert future.status_code == 201


def test_ncr_close_needs_what_was_done(client, db, make_tenant, auth_headers):
    """The screen closed every NCR with the same made-up "Resolved and verified
    on-site." It now asks; the server refuses a blank resolution."""
    import pathlib
    comp, user, team = make_tenant(company_name="R246D", user_name="U246D")
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp, 4)
    r = _raise_ncr(client, comp, project, hdr, f"NCR-R246D-{uuid.uuid4().hex[:6]}")
    ncr_id = r.json()["id"]
    assert client.patch(f"/apis/v3/quality/ncr/{ncr_id}/review", headers=hdr).status_code == 200
    blank = client.patch(f"/apis/v3/quality/ncr/{ncr_id}/close", json={"resolution_notes": "   "}, headers=hdr)
    assert blank.status_code == 422, blank.text
    front = pathlib.Path(__file__).resolve().parents[3] / "frontend" / "src" / "app" / "c"
    for f in front.rglob("quality/page.tsx"):
        assert "Resolved and verified on-site." not in f.read_text(encoding="utf-8"), f
