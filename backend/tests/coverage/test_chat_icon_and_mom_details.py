"""Chat group icons, chat list previews, and the meeting details a MOM lacked.

Found driving the demo tenant on 2026-10-26: a chat group could not be given a
picture or renamed, the chat list showed no last message, every message was
drawn as somebody else's, and a MOM had no title, meeting date, venue or action
items (the register's date filter matched the day the record was typed in).
"""

import uuid as _uuid


def _tenant(make_tenant, auth_headers, db, tag):
    from app import models

    sfx = _uuid.uuid4().hex[:8]
    comp, user, _team = make_tenant(
        company_name=f"{tag}-{sfx}", user_name=f"U{tag}-{sfx}",
        mobile=f"+9196{sfx}", email=f"{tag.lower()}-{sfx}@test.com",
    )
    project = models.Project(id=_uuid.uuid4(), company_id=comp.id, name=f"{tag} Site", state="Maharashtra")
    db.add(project)
    db.commit()
    return comp, user, project, auth_headers(user, comp)


def _project_file(db, project_id):
    from app import models

    f = models.ProjectFile(
        id=_uuid.uuid4(), project_id=project_id, name="icon.png",
        original_filename="icon.png", content_type="image/png", size=4, data=b"\x89PNG",
    )
    db.add(f)
    db.commit()
    return f


def test_group_admin_can_set_icon_and_rename(client, db, make_tenant, auth_headers):
    comp, _user, project, hdr = _tenant(make_tenant, auth_headers, db, "ChatIcon")
    g = client.post("/apis/v3/chat/groups", json={
        "company_id": str(comp.id), "project_id": str(project.id), "name": "Site team",
    }, headers=hdr)
    assert g.status_code == 201, g.text
    gid = g.json()["id"]
    icon = _project_file(db, project.id)
    path = f"/apis/v3/files/file/{icon.id}"

    r = client.patch(f"/apis/v3/chat/groups/{gid}", json={"name": "Tower A site team", "icon_url": path}, headers=hdr)
    assert r.status_code == 200, r.text
    assert r.json()["icon_url"] == path
    assert r.json()["name"] == "Tower A site team"

    listed = client.get(f"/apis/v3/chat/groups/{project.id}", headers=hdr).json()
    assert listed[0]["icon_url"] == path

    # Removing the icon.
    r = client.patch(f"/apis/v3/chat/groups/{gid}", json={"icon_url": ""}, headers=hdr)
    assert r.status_code == 200 and r.json()["icon_url"] is None


def test_icon_must_be_a_file_of_the_same_project(client, db, make_tenant, auth_headers):
    comp, _user, project, hdr = _tenant(make_tenant, auth_headers, db, "ChatIconX")
    from app import models

    other = models.Project(id=_uuid.uuid4(), company_id=comp.id, name="Other Site", state="Maharashtra")
    db.add(other)
    db.commit()
    foreign = _project_file(db, other.id)
    gid = client.post("/apis/v3/chat/groups", json={
        "company_id": str(comp.id), "project_id": str(project.id), "name": "G",
    }, headers=hdr).json()["id"]

    for bad in (f"/apis/v3/files/file/{foreign.id}", "javascript:alert(1)", "http://tracker.example/p.gif"):
        r = client.patch(f"/apis/v3/chat/groups/{gid}", json={"icon_url": bad}, headers=hdr)
        assert r.status_code == 400, (bad, r.text)


def test_chat_list_previews_last_message_and_marks_own_messages(client, db, make_tenant, auth_headers):
    comp, _user, project, hdr = _tenant(make_tenant, auth_headers, db, "ChatPrev")
    gid = client.post("/apis/v3/chat/groups", json={
        "company_id": str(comp.id), "project_id": str(project.id), "name": "G",
    }, headers=hdr).json()["id"]
    sent = client.post("/apis/v3/chat/messages", json={"group_id": gid, "message_text": "Pour at 7 am"}, headers=hdr)
    assert sent.status_code == 201, sent.text
    assert sent.json()["is_mine"] is True

    msgs = client.get(f"/apis/v3/chat/messages/{gid}", headers=hdr).json()
    assert msgs[-1]["is_mine"] is True

    g = client.get(f"/apis/v3/chat/groups/{project.id}", headers=hdr).json()[0]
    assert g["last_message"] == "Pour at 7 am"
    assert g["last_sender"] == "You"
    assert g["last_message_at"]

    empty = client.post("/apis/v3/chat/messages", json={"group_id": gid, "message_text": "  "}, headers=hdr)
    assert empty.status_code == 400


def test_mom_keeps_title_meeting_date_venue_and_action_items(client, db, make_tenant, auth_headers):
    comp, _user, project, hdr = _tenant(make_tenant, auth_headers, db, "MomDet")
    r = client.post(f"/apis/v3/mom/{comp.id}", json={
        "project_id": str(project.id),
        "title": "Monthly progress review",
        "meeting_date": "2026-10-20",
        "venue": "Site office, Tower A",
        "type": "Client Meeting",
        "attendees": ["R. Kulkarni"],
        "action_items": [{"text": "Submit revised L8 schedule", "owner": "R. Kulkarni", "due_date": "2026-10-28"}],
    }, headers=hdr)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "Monthly progress review"
    assert body["meeting_date"] == "2026-10-20"
    assert body["venue"] == "Site office, Tower A"
    assert body["action_items"] == [{"text": "Submit revised L8 schedule", "owner": "R. Kulkarni", "due_date": "2026-10-28", "done": False}]

    # The register's date filter is the meeting date, not the typing date.
    on_day = client.get(f"/apis/v3/mom/{comp.id}?date=2026-10-20", headers=hdr).json()
    assert [m["id"] for m in on_day] == [body["id"]]

    upd = client.put(f"/apis/v3/mom/{comp.id}/{body['id']}", json={
        "action_items": [{"text": "Submit revised L8 schedule", "owner": "R. Kulkarni", "due_date": "2026-10-28", "done": True}],
    }, headers=hdr)
    assert upd.status_code == 200, upd.text
    assert upd.json()["action_items"][0]["done"] is True


def test_todo_cannot_be_assigned_to_another_companys_member(client, db, make_tenant, auth_headers):
    comp, _user, project, hdr = _tenant(make_tenant, auth_headers, db, "TodoAsg")
    sfx = _uuid.uuid4().hex[:8]
    _other_comp, _other_user, other_team = make_tenant(
        company_name=f"TodoOther-{sfx}", user_name=f"UTodoOther-{sfx}",
        mobile=f"+9197{sfx}", email=f"todoother-{sfx}@test.com",
    )
    r = client.post("/apis/v3/todos/", json={
        "company_id": str(comp.id), "title": "Book fire NOC inspection",
        "assignee_ids": [str(other_team.id)],
    }, headers=hdr)
    assert r.status_code == 400, r.text

    ok = client.post("/apis/v3/todos/", json={"company_id": str(comp.id), "title": "Book fire NOC inspection"}, headers=hdr)
    assert ok.status_code in (200, 201), ok.text
    put = client.put(f"/apis/v3/todos/{ok.json()['id']}", json={"assignee_ids": [str(other_team.id)]}, headers=hdr)
    assert put.status_code == 400, put.text


def test_member_list_says_which_row_is_the_caller(client, db, make_tenant, auth_headers):
    """The chat screen matched the login's user id against company-team ids,
    never found the caller, and treated every admin and viewer as a member."""
    comp, _user, project, hdr = _tenant(make_tenant, auth_headers, db, "ChatMe")
    gid = client.post("/apis/v3/chat/groups", json={
        "company_id": str(comp.id), "project_id": str(project.id), "name": "G",
    }, headers=hdr).json()["id"]
    members = client.get(f"/apis/v3/chat/groups/{gid}/members", headers=hdr).json()
    mine = [m for m in members if m["is_me"]]
    assert len(mine) == 1 and mine[0]["role"] == "admin"


def test_mom_attendee_filter_matches_part_of_a_name(client, db, make_tenant, auth_headers):
    """The register's attendee box said "Attendee name..." but only an exact,
    case-sensitive full name ever matched."""
    comp, _user, project, hdr = _tenant(make_tenant, auth_headers, db, "MomAtt")
    r = client.post(f"/apis/v3/mom/{comp.id}", json={
        "project_id": str(project.id), "attendees": ["Rajesh Kulkarni", "Imran Shaikh"],
    }, headers=hdr)
    assert r.status_code == 200, r.text
    found = client.get(f"/apis/v3/mom/{comp.id}?attendee=kulkarni", headers=hdr).json()
    assert [m["id"] for m in found] == [r.json()["id"]]


def test_mom_project_can_be_changed_on_edit_but_not_to_another_company(client, db, make_tenant, auth_headers):
    from app import models

    comp, _user, project, hdr = _tenant(make_tenant, auth_headers, db, "MomProj")
    second = models.Project(id=_uuid.uuid4(), company_id=comp.id, name="Second Site", state="Maharashtra")
    db.add(second)
    db.commit()
    mid = client.post(f"/apis/v3/mom/{comp.id}", json={"project_id": str(project.id)}, headers=hdr).json()["id"]

    moved = client.put(f"/apis/v3/mom/{comp.id}/{mid}", json={"project_id": str(second.id)}, headers=hdr)
    assert moved.status_code == 200 and moved.json()["project_id"] == str(second.id), moved.text
    wide = client.put(f"/apis/v3/mom/{comp.id}/{mid}", json={"project_id": None}, headers=hdr)
    assert wide.status_code == 200 and wide.json()["project_id"] is None, wide.text

    _oc, _ou, _ot = make_tenant(company_name=f"MomOther-{_uuid.uuid4().hex[:6]}", user_name=f"UMomOther-{_uuid.uuid4().hex[:6]}",
                                mobile=f"+9198{_uuid.uuid4().hex[:8]}", email=f"momother-{_uuid.uuid4().hex[:6]}@test.com")
    foreign = models.Project(id=_uuid.uuid4(), company_id=_oc.id, name="Foreign", state="Maharashtra")
    db.add(foreign)
    db.commit()
    bad = client.put(f"/apis/v3/mom/{comp.id}/{mid}", json={"project_id": str(foreign.id)}, headers=hdr)
    assert bad.status_code in (403, 404), bad.text


def test_todo_due_today_is_not_overdue(client, db, make_tenant, auth_headers):
    from datetime import datetime, timezone

    comp, _user, _project, hdr = _tenant(make_tenant, auth_headers, db, "TodoDue")
    today = datetime.now(timezone.utc).date().isoformat()
    r = client.post("/apis/v3/todos/", json={"company_id": str(comp.id), "title": "Pour L8 slab", "due_date": today}, headers=hdr)
    assert r.status_code in (200, 201), r.text
    assert r.json()["is_overdue"] is False
