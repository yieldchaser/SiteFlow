"""Chat rules, as a site team uses them.

- Adding a member did not check the person belonged to this company or could
  open the project, and the same person could be added twice.
- A "viewer" (read only) could still send messages.
- Messages could be sent to a deleted group.
- A group could be made on another company's project, or with a blank name.
"""
import uuid
from pathlib import Path

from app import models
from tests.coverage.test_r2_140_468_470_chat_membership_gate import _mk_project, _mk_colleague

FRONT = Path(__file__).resolve().parents[3] / "frontend" / "src" / "app" / "c" / "[company_id]" / "d" / "chat" / "page.tsx"


def _tenant(make_tenant, auth_headers, tag):
    t = uuid.uuid4().hex[:8]
    comp, user, team = make_tenant(company_name=f"CH{tag}{t}", user_name=f"CH{t}",
                                   mobile="+9173" + str(int(t, 16))[-8:], email=f"ch-{t}@test.com")
    return comp, user, team, auth_headers(user, comp)


def _group(client, hdr, comp, project, name="Site team"):
    return client.post("/apis/v3/chat/groups", headers=hdr,
                       json={"company_id": str(comp.id), "project_id": str(project.id), "name": name})


def _team_row(db, comp, user):
    return db.query(models.CompanyTeam).filter_by(company_id=comp.id, user_id=user.id).one()


def test_member_must_be_from_this_company_and_added_once(client, db, make_tenant, auth_headers):
    comp, _u, _t, hdr = _tenant(make_tenant, auth_headers, "A")
    project = _mk_project(db, comp, "Tower")
    gid = _group(client, hdr, comp, project).json()["id"]
    colleague = _team_row(db, comp, _mk_colleague(db, comp, "Ramesh"))
    other, _ou, other_team, _oh = _tenant(make_tenant, auth_headers, "B")

    def add(uid):
        return client.post(f"/apis/v3/chat/groups/{gid}/members", headers=hdr,
                           json={"group_id": gid, "user_id": str(uid), "role": "member"})

    assert add(other_team.id).status_code == 400
    assert add(uuid.uuid4()).status_code == 400
    assert add(colleague.id).status_code == 201
    assert add(colleague.id).status_code == 409


def test_member_needs_access_to_the_project(client, db, make_tenant, auth_headers):
    comp, _u, _t, hdr = _tenant(make_tenant, auth_headers, "C")
    project = _mk_project(db, comp, "Tower")
    gid = _group(client, hdr, comp, project).json()["id"]
    colleague = _team_row(db, comp, _mk_colleague(db, comp, "Suresh"))
    colleague.project_scope = "assigned"  # limited to projects they are put on; none yet
    db.commit()
    r = client.post(f"/apis/v3/chat/groups/{gid}/members", headers=hdr,
                    json={"group_id": gid, "user_id": str(colleague.id), "role": "member"})
    assert r.status_code == 400 and "access to this project" in r.json()["detail"]


def test_viewer_cannot_send_and_deleted_group_takes_no_messages(client, db, make_tenant, auth_headers):
    comp, user, _t, hdr = _tenant(make_tenant, auth_headers, "D")
    project = _mk_project(db, comp, "Tower")
    gid = _group(client, hdr, comp, project).json()["id"]
    me = db.query(models.ChatGroupMember).filter_by(group_id=uuid.UUID(gid)).one()
    me.role = "viewer"
    db.commit()
    r = client.post("/apis/v3/chat/messages", headers=hdr, json={"group_id": gid, "message_text": "hi"})
    assert r.status_code == 403
    me.role = "admin"
    db.query(models.ChatGroup).filter_by(id=uuid.UUID(gid)).one().is_archived = True
    db.commit()
    r = client.post("/apis/v3/chat/messages", headers=hdr, json={"group_id": gid, "message_text": "hi"})
    assert r.status_code == 404


def test_group_needs_a_name_and_this_companys_project(client, db, make_tenant, auth_headers):
    comp, _u, _t, hdr = _tenant(make_tenant, auth_headers, "E")
    other, _ou, _ot, _oh = _tenant(make_tenant, auth_headers, "F")
    theirs = _mk_project(db, other, "Theirs")
    assert _group(client, hdr, comp, theirs).status_code == 403
    assert _group(client, hdr, comp, _mk_project(db, comp, "Ours"), name="   ").status_code == 422


def test_screen_shows_viewers_and_hides_people_already_in_the_group():
    src = FRONT.read_text(encoding="utf-8")
    assert '<option value="viewer">Viewer (read only)</option>' in src
    assert 'm.role === "viewer" ? "Viewer (read only)"' in src
    assert "teamOptions.filter((t) => !members.some((mm) => mm.user_id === t.id))" in src
