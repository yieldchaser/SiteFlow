"""A new company can invite a site engineer on day one.

Found driving Settings > Team: a company was created with only the Owner role,
so the first "Add person" offered nothing but Owner until someone found the
"Add standard roles" button under Roles & Access. The standard roles now come
with the company.
"""
import uuid

from app import models

_SFX = uuid.uuid4().hex[:6]


def test_create_company_seeds_the_standard_roles(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name=f"Seed-{_SFX}", user_name="Founder",
                                mobile=f"+9176{_SFX}01", email=f"founder-{_SFX}@test.com")
    name = f"Vidson Infra {_SFX}"
    r = client.post("/apis/v3/auth/onboarding/create-company", headers=auth_headers(user, comp),
                    json={"name": name})
    assert r.status_code == 200, r.text

    company = db.query(models.Company).filter(models.Company.name == name).one()
    roles = {r.role_name for r in db.query(models.CompanyRole).filter(models.CompanyRole.company_id == company.id)}
    assert {"Owner", "Site Engineer", "Accountant", "Supervisor", "Viewer"} <= roles
    assert len(roles) == 11
