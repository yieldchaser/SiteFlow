"""A role that cannot see a module gets a 403 on that module's reads.

Before: the menu hid Finance from a Supervisor, but typing the URL or
calling the API still returned the company's books. VCPL must not hand out
restricted roles until this holds.
"""
import uuid

from app import models

_SFX = uuid.uuid4().hex[:6]


def _member(db, company, perms, auth_headers):
    user = models.User(id=uuid.uuid4(), name="Member", mobile=f"+919{uuid.uuid4().hex[:9]}")
    db.add(user)
    db.flush()
    role = models.CompanyRole(company_id=company.id, role_name=f"R-{uuid.uuid4().hex[:6]}", permissions=perms)
    db.add(role)
    db.flush()
    db.add(models.CompanyTeam(id=uuid.uuid4(), company_id=company.id, user_id=user.id,
                              priority_type="employee", role_id=role.id))
    db.commit()
    return auth_headers(user, company)


def test_supervisor_cannot_read_finance_or_crm_but_can_read_site_work(client, db, make_tenant, auth_headers):
    comp, owner, _ = make_tenant(company_name=f"View Co {_SFX}", user_name="Owner",
                                 email=f"view-{_SFX}@example.com")
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Site", status="Ongoing")
    db.add(project)
    db.commit()
    sup = _member(db, comp, {"quality:view": True, "safety:view": True, "equipment:view": True,
                             "projects:view": True, "library:view": True}, auth_headers)
    own = auth_headers(owner, comp)

    blocked = [
        f"/apis/v3/finance/accounts/{comp.id}",
        f"/apis/v3/finance/cash-account/{comp.id}",
        f"/apis/v3/crm/leads?company_id={comp.id}",
    ]
    for url in blocked:
        r = client.get(url, headers=sup)
        assert r.status_code == 403, (url, r.status_code)
        assert client.get(url, headers=own).status_code != 403, url

    assert client.get(f"/apis/v3/equipment/{comp.id}", headers=sup).status_code == 200


def test_shared_lists_stay_open_to_every_role(client, db, make_tenant, auth_headers):
    """The project list, team list and subcontractor list feed pickers on
    every screen, so a role without planning, crm or billing still gets them."""
    comp, _, _ = make_tenant(company_name=f"Open Co {_SFX}", user_name="Owner2",
                             email=f"open-{_SFX}@example.com")
    db.add(models.Project(id=uuid.uuid4(), company_id=comp.id, name="Head Office - Pune", status="Ongoing",
                          is_head_office=True))
    db.commit()
    client_role = _member(db, comp, {"projects:view": True, "reports:view": True}, auth_headers)
    r = client.get(f"/apis/v3/planning/projects?company_id={comp.id}", headers=client_role)
    assert r.status_code == 200, r.text
    assert r.json()[0]["is_office"] is True
    assert client.get(f"/apis/v3/crm/team-members/{comp.id}", headers=client_role).status_code == 200
    assert client.get(f"/apis/v3/billing/subcontractors?company_id={comp.id}", headers=client_role).status_code == 200
