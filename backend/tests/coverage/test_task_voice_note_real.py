"""The task panel's voice-note button recorded nothing: after four seconds it
saved a comment pointing at a made-up web address. Voice notes are now real
recordings uploaded to the project's files, and a comment can only point at one."""
import uuid

from app import models

WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 64


def _task(db, comp):
    p = models.Project(id=uuid.uuid4(), company_id=comp.id, name="P", code=f"P-{uuid.uuid4().hex[:6]}", status="Ongoing")
    db.add(p)
    db.flush()
    import datetime
    start = datetime.datetime(2026, 11, 1, tzinfo=datetime.timezone.utc)
    t = models.Task(id=uuid.uuid4(), project_id=p.id, name="Raft", duration_days=5,
                    start_date=start, end_date=start + datetime.timedelta(days=4))
    db.add(t)
    db.commit()
    return p, t


def test_made_up_voice_address_is_refused(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(company_name=f"VN-{uuid.uuid4().hex[:6]}", user_name="VN")
    hdr = auth_headers(user, comp)
    _p, t = _task(db, comp)
    r = client.post(f"/apis/v3/planning/tasks/{t.id}/comments", headers=hdr, json={
        "message_text": "Voice note logged",
        "voice_note_url": "https://siteflow-voice-records.s3.amazonaws.com/rec-0051.mp3"})
    assert r.status_code == 422, r.text


def test_recorded_voice_note_uploads_and_attaches(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(company_name=f"VR-{uuid.uuid4().hex[:6]}", user_name="VR")
    hdr = auth_headers(user, comp)
    p, t = _task(db, comp)
    up = client.post("/apis/v3/files/upload", headers=hdr, data={"project_id": str(p.id)},
                     files={"file": ("Voice note.webm", WEBM, "audio/webm")})
    assert up.status_code == 201, up.text
    assert up.json()["content_type"] == "audio/webm"
    url = f"/apis/v3/files/file/{up.json()['id']}"
    c = client.post(f"/apis/v3/planning/tasks/{t.id}/comments", headers=hdr, json={
        "message_text": "Voice note", "voice_note_url": url})
    assert c.status_code == 201, c.text
    assert c.json()["voice_note_url"] == url
    got = client.get(url, headers=hdr)
    assert got.status_code == 200 and got.content == WEBM


def test_voice_note_from_another_project_is_refused(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(company_name=f"VX-{uuid.uuid4().hex[:6]}", user_name="VX")
    hdr = auth_headers(user, comp)
    p1, _t1 = _task(db, comp)
    _p2, t2 = _task(db, comp)
    up = client.post("/apis/v3/files/upload", headers=hdr, data={"project_id": str(p1.id)},
                     files={"file": ("Voice note.webm", WEBM, "audio/webm")})
    assert up.status_code == 201, up.text
    c = client.post(f"/apis/v3/planning/tasks/{t2.id}/comments", headers=hdr, json={
        "voice_note_url": f"/apis/v3/files/file/{up.json()['id']}"})
    assert c.status_code == 422, c.text
