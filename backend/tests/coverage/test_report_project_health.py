"""Project reports use the same health rule as the dashboard: a cancelled
project is Cancelled (it printed 'Good' and 'On Track'), and the budget is
the cost budget, not the contract value."""
import uuid

from app import models
from tests.coverage.test_domain_formula_fixes import _mk_project

_TAG = uuid.uuid4().hex[:8]
_MOB = "+9177" + str(int(_TAG, 16))[-8:]
_MAIL = f"t-{_TAG}@test.com"


def test_project_reports_share_dashboard_health(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(company_name="PH1", user_name="UPH1", mobile=_MOB, email=_MAIL)
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)
    project.status = "Cancelled"
    project.project_value = 5_000_000
    db.add(models.ProjectBudget(id=uuid.uuid4(), project_id=project.id, material_budget=100_000,
                                labour_budget=0, subcon_budget=0, equipment_budget=0))
    db.commit()

    for slug in ("project-financial-summary", "project-operational-summary"):
        r = client.get(f"/apis/v3/reports/data/{slug}?company_id={comp.id}", headers=hdr)
        assert r.status_code == 200, r.text
        row = next(x for x in r.json()["rows"] if x["Project Name"] == project.name)
        assert row["Project Health"] == "Cancelled", (slug, row)

    r = client.get(f"/apis/v3/reports/data/project-financial-summary?company_id={comp.id}", headers=hdr)
    row = next(x for x in r.json()["rows"] if x["Project Name"] == project.name)
    assert float(row["Project Budget"]) == 100_000
    assert float(row["Contract Value"]) == 5_000_000
