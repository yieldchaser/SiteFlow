"""Limiting a team member to chosen projects.

Before this, every member of a company could open every project: project
membership rows existed but nothing read them. A member set to "assigned"
must now be refused any other project, wherever the request names it (URL
path, query string or JSON body), and must not see the others in lists.
Owners and full-access roles always see everything.
"""
import uuid

from app import models
from app.permissions import DEFAULT_ROLE_PRESETS

REFUSED = "not one of yours"


def _project(db, company, name):
    p = models.Project(id=uuid.uuid4(), company_id=company.id, name=name)
    db.add(p)
    db.flush()
    return p


def _member(db, company, role, name, scope="all"):
    user = models.User(id=uuid.uuid4(), name=name, mobile=f"+919{uuid.uuid4().int % 10**9:09d}")
    db.add(user)
    db.flush()
    team = models.CompanyTeam(
        id=uuid.uuid4(), company_id=company.id, user_id=user.id, role_id=role.id,
        priority_type="employee", project_scope=scope,
    )
    db.add(team)
    db.flush()
    return user, team


def _setup(db, make_tenant):
    company, owner, owner_team = make_tenant(company_name=f"Scope Co {uuid.uuid4().hex[:6]}", user_name="Owner")
    manager_role = models.CompanyRole(
        id=uuid.uuid4(), company_id=company.id, role_name="Manager", permissions=dict(DEFAULT_ROLE_PRESETS["Manager"])
    )
    admin_role = models.CompanyRole(id=uuid.uuid4(), company_id=company.id, role_name="Admin", permissions={"all": True})
    db.add_all([manager_role, admin_role])
    db.flush()
    mine = _project(db, company, "Tower A")
    other = _project(db, company, "Tower B")
    limited, limited_team = _member(db, company, manager_role, "Limited Lal", scope="assigned")
    db.add(models.ProjectMember(project_id=mine.id, company_team_id=limited_team.id))
    free, free_team = _member(db, company, manager_role, "Free Farhan")
    admin, admin_team = _member(db, company, admin_role, "Admin Anand", scope="assigned")
    db.commit()
    return dict(
        company=company, owner=owner, owner_team=owner_team, mine=mine, other=other,
        limited=limited, limited_team=limited_team, free=free, free_team=free_team,
        admin=admin, admin_team=admin_team,
    )


def test_limited_member_is_refused_another_project_by_path(client, db, make_tenant, auth_headers):
    s = _setup(db, make_tenant)
    hdr = auth_headers(s["limited"], s["company"])
    r = client.get(f"/apis/v3/projects/{s['other'].id}", headers=hdr)
    assert r.status_code == 403 and REFUSED in r.text, r.text
    ok = client.get(f"/apis/v3/projects/{s['mine'].id}", headers=hdr)
    assert ok.status_code == 200, ok.text


def test_limited_member_is_refused_another_project_by_query(client, db, make_tenant, auth_headers):
    s = _setup(db, make_tenant)
    hdr = auth_headers(s["limited"], s["company"])
    r = client.get(f"/apis/v3/dpr/export?project_id={s['other'].id}", headers=hdr)
    assert r.status_code == 403 and REFUSED in r.text, r.text


def test_limited_member_is_refused_another_project_by_body(client, db, make_tenant, auth_headers):
    s = _setup(db, make_tenant)
    hdr = auth_headers(s["limited"], s["company"])
    body = {"company_id": str(s["company"].id), "project_id": str(s["other"].id), "title": "Check rebar"}
    r = client.post("/apis/v3/todos/", headers=hdr, json=body)
    assert r.status_code == 403 and REFUSED in r.text, r.text
    body["project_id"] = str(s["mine"].id)
    ok = client.post("/apis/v3/todos/", headers=hdr, json=body)
    assert REFUSED not in ok.text, ok.text


def test_project_lists_show_only_their_projects(client, db, make_tenant, auth_headers):
    s = _setup(db, make_tenant)
    cid = s["company"].id
    hdr = auth_headers(s["limited"], s["company"])
    for url in (f"/apis/v3/projects/company/{cid}", f"/apis/v3/planning/projects?company_id={cid}"):
        r = client.get(url, headers=hdr)
        assert r.status_code == 200, (url, r.text)
        names = {p["name"] for p in r.json()}
        assert names == {"Tower A"}, (url, names)


def test_everyone_else_still_sees_every_project(client, db, make_tenant, auth_headers):
    s = _setup(db, make_tenant)
    cid = s["company"].id
    # The admin is marked "assigned" with no projects, but full access wins.
    for who in ("owner", "free", "admin"):
        hdr = auth_headers(s[who], s["company"])
        r = client.get(f"/apis/v3/projects/company/{cid}", headers=hdr)
        assert {p["name"] for p in r.json()} == {"Tower A", "Tower B"}, (who, r.text)
        assert client.get(f"/apis/v3/projects/{s['other'].id}", headers=hdr).status_code == 200, who


def test_owner_picks_projects_for_a_member(client, db, make_tenant, auth_headers):
    s = _setup(db, make_tenant)
    owner_hdr = auth_headers(s["owner"], s["company"])
    url = f"/apis/v3/settings/team/{s['free_team'].id}/projects"
    r = client.put(url, headers=owner_hdr, json={"scope": "assigned", "project_ids": [str(s["other"].id)]})
    assert r.status_code == 200, r.text
    assert r.json()["project_scope"] == "assigned"
    assert r.json()["project_ids"] == [str(s["other"].id)]

    free_hdr = auth_headers(s["free"], s["company"])
    assert client.get(f"/apis/v3/projects/{s['mine'].id}", headers=free_hdr).status_code == 403
    assert client.get(f"/apis/v3/projects/{s['other'].id}", headers=free_hdr).status_code == 200

    team = client.get(f"/apis/v3/settings/team/{s['company'].id}", headers=owner_hdr).json()
    row = next(m for m in team if m["name"] == "Free Farhan")
    assert row["project_scope"] == "assigned" and row["project_ids"] == [str(s["other"].id)]
    admin_row = next(m for m in team if m["name"] == "Admin Anand")
    assert admin_row["full_access"] is True

    back = client.put(url, headers=owner_hdr, json={"scope": "all", "project_ids": []})
    assert back.status_code == 200, back.text
    assert client.get(f"/apis/v3/projects/{s['mine'].id}", headers=free_hdr).status_code == 200


def test_project_picking_guards(client, db, make_tenant, auth_headers):
    s = _setup(db, make_tenant)
    owner_hdr = auth_headers(s["owner"], s["company"])
    url = f"/apis/v3/settings/team/{s['free_team'].id}/projects"

    # A member limited to some projects cannot hand out projects, not even to themselves.
    limited_hdr = auth_headers(s["limited"], s["company"])
    r = client.put(
        f"/apis/v3/settings/team/{s['limited_team'].id}/projects",
        headers=limited_hdr, json={"scope": "all", "project_ids": []},
    )
    assert r.status_code == 403, r.text

    # Full-access people always see everything.
    r = client.put(
        f"/apis/v3/settings/team/{s['admin_team'].id}/projects",
        headers=owner_hdr, json={"scope": "assigned", "project_ids": [str(s["mine"].id)]},
    )
    assert r.status_code == 400, r.text

    # Another company's project, or none at all, is refused.
    foreign_co, _o, _t = make_tenant(company_name=f"Other Co {uuid.uuid4().hex[:6]}", user_name="Other")
    foreign = _project(db, foreign_co, "Elsewhere")
    db.commit()
    r = client.put(url, headers=owner_hdr, json={"scope": "assigned", "project_ids": [str(foreign.id)]})
    assert r.status_code == 400, r.text
    r = client.put(url, headers=owner_hdr, json={"scope": "assigned", "project_ids": []})
    assert r.status_code == 400, r.text


def test_cannot_add_another_companys_member_to_a_project(client, db, make_tenant, auth_headers):
    s = _setup(db, make_tenant)
    _co, _user, foreign_team = make_tenant(company_name=f"Other Co {uuid.uuid4().hex[:6]}", user_name="Other")
    r = client.post(
        f"/apis/v3/projects/{s['mine'].id}/members?member_id={foreign_team.id}",
        headers=auth_headers(s["owner"], s["company"]),
    )
    assert r.status_code == 404, r.text


def test_site_roles_do_not_get_project_money(client, db, make_tenant, auth_headers):
    """A Supervisor opens projects but has no accounts access; the project
    record used to carry cash in, cash out and the contract value anyway."""
    company, owner, _ = make_tenant(company_name=f"Money Co {uuid.uuid4().hex[:6]}", user_name="Owner")
    sup_role = models.CompanyRole(
        id=uuid.uuid4(), company_id=company.id, role_name="Supervisor", permissions=dict(DEFAULT_ROLE_PRESETS["Supervisor"])
    )
    db.add(sup_role)
    db.flush()
    p = models.Project(id=uuid.uuid4(), company_id=company.id, name="Tower C", project_value=5000000)
    db.add(p)
    sup, _team = _member(db, company, sup_role, "Sup Sunil")
    db.commit()

    hdr = auth_headers(sup, company)
    one = client.get(f"/apis/v3/projects/{p.id}", headers=hdr).json()
    assert one["project_value"] is None and one["cash_in"] is None and one["cash_out"] is None, one
    listed = client.get(f"/apis/v3/projects/company/{company.id}", headers=hdr).json()
    assert listed[0]["project_value"] is None, listed

    mine = client.get(f"/apis/v3/projects/{p.id}", headers=auth_headers(owner, company)).json()
    assert mine["project_value"] == 5000000
