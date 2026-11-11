"""Daily report: add a missing task or material without leaving the form.

A site engineer whose task or material was not set up had to close the
report, go to Planning or the Library, and start again. The M.B. sheet also
took negative numbers: a negative "No." subtracted from the total.
"""
import uuid
from pathlib import Path

from app import models

PAGE = Path(__file__).resolve().parents[3] / "frontend" / "src" / "app" / "c" / "[company_id]" / "d" / "dpr" / "page.tsx"


def test_form_offers_new_task_and_new_material_and_no_negative_measurements():
    src = PAGE.read_text(encoding="utf-8")
    assert "+ New task" in src and "/apis/v3/planning/tasks`" in src and "createTaskHere" in src
    assert "Material not in the list? Add it" in src and "/apis/v3/library/materials`" in src
    for f in ("nos", "l", "w", "h"):
        assert f"next[idx].{f} = Math.max(0, parseFloat(e.target.value) || 0);" in src


def test_a_supervisor_can_add_the_task_the_form_creates(client, db, make_tenant, auth_headers):
    t = uuid.uuid4().hex[:8]
    comp, owner, _team = make_tenant(company_name=f"DT{t}", user_name=f"DT{t}",
                                     mobile="+9177" + str(int(t, 16))[-8:], email=f"dt-{t}@test.com")
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Tower", status="Ongoing")
    db.add(project)
    db.commit()
    # The same body the form sends: name, days, report date at noon, in progress.
    r = client.post("/apis/v3/planning/tasks", headers=auth_headers(owner, comp), json={
        "project_id": str(project.id), "name": "Slab casting, 2nd floor", "duration_days": 1,
        "start_date": "2026-11-11T06:30:00Z", "status": "in_progress",
    })
    assert r.status_code == 201, r.text
    task_id = r.json()["id"]
    r = client.post("/apis/v3/dpr", headers=auth_headers(owner, comp), json={
        "project_id": str(project.id), "task_id": task_id, "reported_by": "x",
        "dpr_date": "2026-11-11T06:30:00Z", "executed_qty": 12, "workers_deployed": 8,
        "weather": "Clear", "notes": "", "issues": "", "materials_consumed": [], "photos": [],
    })
    assert r.status_code in (200, 201), r.text


def test_reports_are_filed_and_read_site_by_site():
    """The client could not see which site a report was for: it followed the
    sidebar's project. The page and the form now pick the site, and the feed
    can show every site at once."""
    src = PAGE.read_text(encoding="utf-8")
    assert '<option value="__all">All sites</option>' in src
    assert "pickSite(e.target.value)" in src and src.count("pickSite(e.target.value)") == 2
    assert "!p.is_office" in src


def test_feed_names_the_task_so_a_many_site_feed_can_show_it(client, db, make_tenant, auth_headers):
    t = uuid.uuid4().hex[:8]
    comp, owner, _team = make_tenant(company_name=f"DF{t}", user_name=f"DF{t}",
                                     mobile="+9178" + str(int(t, 16))[-8:], email=f"df-{t}@test.com")
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Bridge", status="Ongoing")
    db.add(project)
    db.commit()
    hdr = auth_headers(owner, comp)
    r = client.post("/apis/v3/planning/tasks", headers=hdr, json={
        "project_id": str(project.id), "name": "Pier 3 casting", "duration_days": 1,
        "start_date": "2026-11-11T06:30:00Z"})
    assert r.status_code == 201, r.text
    r = client.post("/apis/v3/dpr", headers=hdr, json={
        "project_id": str(project.id), "task_id": r.json()["id"], "reported_by": "x",
        "dpr_date": "2026-11-11T06:30:00Z", "executed_qty": 3, "workers_deployed": 4,
        "weather": "Clear", "notes": "", "issues": "", "materials_consumed": [], "photos": []})
    assert r.status_code in (200, 201), r.text
    feed = client.get(f"/apis/v3/dpr?project_id={project.id}", headers=hdr).json()
    assert feed[0]["task_name"] == "Pier 3 casting", feed[0]
    assert feed[0]["project_id"] == str(project.id)
