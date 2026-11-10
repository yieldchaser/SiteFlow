"""Team Schedule timesheets, as a site office uses them.

- A night shift (20:00 to 06:00) showed "10 Hr" on the form but saving it
  failed: the end time was sent on the same day as the start.
- The date filter used London midnight, so in India a timesheet dated
  10 Nov fell out of a "10 Nov to 10 Nov" filter.
- The person's name rendered white on a white card in the light theme.
- Delete removed the timesheet on one click, with no question.
- A person limited to some projects saw every project's timesheets.
- A party from another company could be put on a timesheet, showing their name.
"""
import uuid
from pathlib import Path

from app import models
from tests.coverage.test_r2_140_468_470_chat_membership_gate import _mk_colleague

PAGE = Path(__file__).resolve().parents[3] / "frontend" / "src" / "app" / "c" / "[company_id]" / "d" / "team-action" / "page.tsx"


def _tenant(make_tenant, auth_headers, tag):
    t = uuid.uuid4().hex[:8]
    comp, user, team = make_tenant(company_name=f"TS{tag}{t}", user_name=f"TS{t}",
                                   mobile="+9175" + str(int(t, 16))[-8:], email=f"ts-{t}@test.com")
    return comp, user, team, auth_headers(user, comp)


def _project(db, comp, name):
    p = models.Project(id=uuid.uuid4(), company_id=comp.id, name=name,
                       code=f"{name[:3]}-{uuid.uuid4().hex[:6]}", status="Ongoing")
    db.add(p)
    db.commit()
    return p


def _party(db, comp, name):
    p = models.LibraryParty(id=uuid.uuid4(), company_id=comp.id, name=name, party_type="Staff")
    db.add(p)
    db.commit()
    return p


def _post(client, hdr, comp, project, party, start="2026-11-10T09:00:00+05:30", end="2026-11-10T17:00:00+05:30"):
    return client.post("/apis/v3/team-schedule/timesheets", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id), "party_id": str(party.id),
        "entry_date": "2026-11-10T00:00:00+05:30", "start_time": start, "end_time": end,
    })


def test_party_must_be_from_this_company(client, db, make_tenant, auth_headers):
    comp, _u, _t, hdr = _tenant(make_tenant, auth_headers, "A")
    other, _ou, _ot, _oh = _tenant(make_tenant, auth_headers, "B")
    project = _project(db, comp, "Tower")
    theirs = _party(db, other, "Their Foreman")
    r = _post(client, hdr, comp, project, theirs)
    assert r.status_code == 400, r.text
    ours = _party(db, comp, "Ramesh")
    r = _post(client, hdr, comp, project, ours)
    assert r.status_code == 201 and r.json()["party_name"] == "Ramesh"
    put = client.put(f"/apis/v3/team-schedule/timesheets/{r.json()['id']}", headers=hdr,
                     json={"party_id": str(theirs.id)})
    assert put.status_code == 400


def test_night_shift_with_true_end_date_counts_ten_hours(client, db, make_tenant, auth_headers):
    comp, _u, _t, hdr = _tenant(make_tenant, auth_headers, "C")
    r = _post(client, hdr, comp, _project(db, comp, "Tower"), _party(db, comp, "Night guard"),
              start="2026-11-10T20:00:00+05:30", end="2026-11-11T06:00:00+05:30")
    assert r.status_code == 201 and r.json()["duration_minutes"] == 600


def test_limited_person_sees_only_their_projects(client, db, make_tenant, auth_headers):
    comp, _u, _team, hdr = _tenant(make_tenant, auth_headers, "D")
    mine, other = _project(db, comp, "Mine"), _project(db, comp, "Other")
    party = _party(db, comp, "Suresh")
    a = _post(client, hdr, comp, mine, party).json()["id"]
    b = _post(client, hdr, comp, other, party).json()["id"]
    colleague = _mk_colleague(db, comp, f"Site{uuid.uuid4().hex[:6]}")
    row = db.query(models.CompanyTeam).filter_by(company_id=comp.id, user_id=colleague.id).one()
    row.project_scope = "assigned"
    db.add(models.ProjectMember(project_id=mine.id, company_team_id=row.id))
    db.commit()
    chdr = auth_headers(colleague, comp)
    rows = client.get(f"/apis/v3/team-schedule/timesheets?company_id={comp.id}", headers=chdr).json()
    assert [r["id"] for r in rows] == [a]
    assert client.get(f"/apis/v3/team-schedule/timesheets/{b}", headers=chdr).status_code == 404


def test_screen_handles_night_shift_india_dates_and_asks_before_delete():
    src = PAGE.read_text(encoding="utf-8")
    assert "const endDate = tsEnd <= tsStart ? nextDayISO(tsDate) : tsDate;" in src
    assert "end_time: `${endDate}T${tsEnd}:00${tz}`" in src
    assert 'T00:00:00${localOffset()}' in src and "T00:00:00Z" not in src
    assert "font-bold text-white" not in src
    assert "if (!confirm(`Delete the timesheet for" in src
