"""Subcontractor scorecard: an NCR counts only against the firm it was raised
on, and a firm with no judged bills shows no on-time rate rather than 0%."""
import uuid

from app import models
from tests.coverage.test_domain_formula_fixes import _mk_project, _utc

_TAG = uuid.uuid4().hex[:8]
_MOB = "+9177" + str(int(_TAG, 16))[-8:]
_MAIL = f"t-{_TAG}@test.com"


def test_ncr_counts_only_against_its_own_subcontractor(client, db, make_tenant, auth_headers):
    comp, user, team_a = make_tenant(company_name="SC1", user_name="USC1", mobile=_MOB, email=_MAIL)
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)
    team_b = models.CompanyTeam(id=uuid.uuid4(), company_id=comp.id, priority_type="subcontractor")
    db.add(team_b)
    db.flush()
    for i, team in enumerate((team_a, team_b)):
        db.add(models.WorkOrder(
            id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
            subcontractor_id=team.id, wo_number=f"WO{i}", wo_date=_utc(2026, 1, 1), status="active"))
    # Two NCRs against A, none against B, one with no firm named.
    for n, vendor in enumerate((team_a.id, team_a.id, None)):
        db.add(models.NCR(project_id=project.id, ncr_number=f"NCR-{n}", title="t",
                          severity="Major", status="open", vendor_id=vendor))
    db.commit()

    r = client.get(f"/apis/v3/analytics/company/{comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    rows = {s["subcontractor_id"]: s for s in r.json()["subcontractor_scorecard"]}
    assert rows[str(team_a.id)]["ncr_count"] == 2
    assert rows[str(team_b.id)]["ncr_count"] == 0
    # No paid bill with a due date: nothing to judge, so no rate.
    assert rows[str(team_b.id)]["on_time_rate"] is None
