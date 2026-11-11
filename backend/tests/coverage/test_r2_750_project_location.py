"""R2-750 - a project must be able to hold site coordinates, and a punch that
could not be measured must not be recorded as verified.

R2-475 filed the symptom ("a project with no site coordinates passes every
geofence check"). This finding is the root cause underneath it: there is no
supported way to give a project coordinates at all.

ProjectCreate lists 18 fields -- including attendance_radius_meters, defaulting
to 500 -- and `location` is not among them, nor is it in ProjectUpdate. The API
lets you configure a radius around a point it gives you no way to specify.
Measured in production: 7 of 7 projects have a null or empty location.

With location null, site_lat is always None, so `within_geofence` was
unconditionally True, distance was stored as NULL, and every punch was written
with location_verified=True and status "Present". That makes R2-474's fix inert:
correct code, zero effect, because there is nothing to compute against.
Attendance drives payroll and "GPS Verified" is an assurance shown to whoever
reviews the muster.

Three clauses: the create API accepts coordinates, the update API can add them
later, and an unmeasurable punch is recorded as unverified.
"""
import pathlib
import uuid

from app import models

PROJECTS = "/apis/v3/projects/"
PUNCH = "/apis/v3/hr/attendance/punch"

# parents: [0]=tests/coverage [1]=tests [2]=backend [3]=repo root
_REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
_ATTENDANCE = _REPO_ROOT / "frontend" / "src" / "app" / "c" / "[company_id]" / "d" / "attendance" / "page.tsx"


def test_geofence_settings_panel_can_enter_coordinates():
    """The location tab was decorative -- a map icon with no input at all.

    Source pin, not behavioural proof: the repo ships no React test runner.
    """
    src = _ATTENDANCE.read_text(encoding="utf-8-sig")
    assert "projectSettings.location" in src, (
        "the geofence settings panel has no coordinate input, so no one can "
        "give a site a position through the console"
    )

# A Gujarat site (~22.3, 73.2) vs the Mumbai default the finding warns about.
SITE = "22.3072,73.1812"


def _employee(db, company_id, project_id, name="Site Engineer"):
    e = models.StaffEmployee(
        id=uuid.uuid4(),
        company_id=company_id,
        project_id=project_id,
        name=name,
        status="active",
    )
    db.add(e)
    db.commit()
    return e


def _create_project(client, hdr, company_id, name, location=None, extra=None):
    payload = {"company_id": str(company_id), "name": name, "state": "Gujarat"}
    if location is not None:
        payload["location"] = location
    if extra:
        payload.update(extra)
    return client.post(PROJECTS, json=payload, headers=hdr)


# --- clause 1: creation ----------------------------------------------------

def test_project_can_be_created_with_coordinates(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(company_name="R750A", user_name="U750A")
    hdr = auth_headers(user, comp)

    r = _create_project(client, hdr, comp.id, "R750A Site", location=SITE)
    assert r.status_code in (200, 201), r.text
    body = r.json()
    assert body.get("location") == SITE, (
        "a coordinate supplied to the project API is not readable back"
    )

    stored = db.query(models.Project).filter(models.Project.id == uuid.UUID(body["id"])).first()
    assert stored.location == SITE


def test_malformed_coordinates_are_rejected_not_stored(client, db, make_tenant, auth_headers):
    """A silently unparseable value re-creates the same inertness, harder to see."""
    comp, user, _team = make_tenant(company_name="R750B", user_name="U750B")
    hdr = auth_headers(user, comp)

    for bad in ("not-a-coordinate", "22.3", "abc,def", "999,999"):
        r = _create_project(client, hdr, comp.id, f"R750B {bad}", location=bad)
        assert r.status_code == 422, f"{bad!r} was accepted: {r.text}"


def test_project_without_coordinates_is_still_allowed(client, db, make_tenant, auth_headers):
    """Optional: existing callers must not break."""
    comp, user, _team = make_tenant(company_name="R750C", user_name="U750C")
    hdr = auth_headers(user, comp)

    r = _create_project(client, hdr, comp.id, "R750C Site")
    assert r.status_code in (200, 201), r.text
    assert not r.json().get("location")


# --- clause 2: update ------------------------------------------------------

def test_coordinates_can_be_added_later(client, db, make_tenant, auth_headers):
    """Every project in production was created without them."""
    comp, user, _team = make_tenant(company_name="R750D", user_name="U750D")
    hdr = auth_headers(user, comp)

    created = _create_project(client, hdr, comp.id, "R750D Site")
    assert created.status_code in (200, 201), created.text
    assert not created.json().get("location")
    pid = created.json()["id"]

    r = client.put(f"{PROJECTS}{pid}", json={"location": SITE}, headers=hdr)
    assert r.status_code == 200, r.text
    assert r.json()["location"] == SITE

    stored = db.query(models.Project).filter(models.Project.id == uuid.UUID(pid)).first()
    assert stored.location == SITE


def test_planning_create_no_longer_invents_a_mumbai_coordinate(
    client, db, make_tenant, auth_headers
):
    """The finding is explicit: a wrong coordinate is worse than none."""
    comp, user, _team = make_tenant(company_name="R750H", user_name="U750H")
    hdr = auth_headers(user, comp)

    r = client.post(
        "/apis/v3/planning/projects",
        # state is required on this route as of the E2E fixes: it used to accept
        # and drop the field, which produced projects that could never be
        # invoiced. This test is about the location default, so supply one.
        json={
            "company_id": str(comp.id),
            "name": "R750H Gujarat Site",
            "city": "Vadodara",
            "state": "Gujarat",
        },
        headers=hdr,
    )
    assert r.status_code == 201, r.text
    body = r.json()

    assert not body.get("location"), (
        "a project with no coordinates was given a fabricated Mumbai default; "
        "that makes the geofence confidently wrong rather than absent"
    )
    assert "19.0760" not in (body.get("location") or "")


# --- clause 3: an unmeasurable punch is not a verified punch ---------------

def test_punch_without_site_coords_is_not_location_verified(
    client, db, make_tenant, auth_headers
):
    comp, user, _team = make_tenant(company_name="R750E", user_name="U750E")
    hdr = auth_headers(user, comp)

    project = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name="R750E No Coords",
        status="Ongoing", state="Gujarat",
    )
    db.add(project)
    db.commit()
    emp = _employee(db, comp.id, project.id)

    r = client.post(PUNCH, json={
        "employee_id": str(emp.id),
        "project_id": str(project.id),
        "lat": 22.3072,
        "lng": 73.1812,
        "punch_type": "in",
    }, headers=hdr)
    assert r.status_code == 201, r.text
    assert r.json()["location_verified"] is False, (
        "a punch that could not be measured was recorded as GPS-verified"
    )


def test_punch_inside_the_geofence_is_verified(client, db, make_tenant, auth_headers):
    """The happy path: real coordinates, punch on site."""
    comp, user, _team = make_tenant(company_name="R750F", user_name="U750F")
    hdr = auth_headers(user, comp)

    project = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name="R750F Site",
        status="Ongoing", state="Gujarat", location=SITE,
        attendance_radius_meters=500,
    )
    db.add(project)
    db.commit()
    emp = _employee(db, comp.id, project.id)

    r = client.post(PUNCH, json={
        "employee_id": str(emp.id),
        "project_id": str(project.id),
        "lat": 22.3072,
        "lng": 73.1812,
        "punch_type": "in",
    }, headers=hdr)
    assert r.status_code == 201, r.text
    assert r.json()["location_verified"] is True


def test_punch_outside_the_geofence_is_not_verified(client, db, make_tenant, auth_headers):
    """A project with coordinates actually enforces them."""
    comp, user, _team = make_tenant(company_name="R750G", user_name="U750G")
    hdr = auth_headers(user, comp)

    project = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name="R750G Site",
        status="Ongoing", state="Gujarat", location=SITE,
        attendance_radius_meters=500,
    )
    db.add(project)
    db.commit()
    emp = _employee(db, comp.id, project.id)

    # Mumbai, ~350 km from the Gujarat site.
    r = client.post(PUNCH, json={
        "employee_id": str(emp.id),
        "project_id": str(project.id),
        "lat": 19.0760,
        "lng": 72.8777,
        "punch_type": "in",
    }, headers=hdr)
    assert r.status_code == 201, r.text
    assert r.json()["location_verified"] is False, (
        "a punch 350 km from site was recorded as GPS-verified"
    )


def test_coordinates_pasted_with_quotes_or_brackets_are_accepted(client, db, make_tenant, auth_headers):
    """VCPL typed '18.651125,72.868279' with the quotes, copied from the error
    message's own example, and the project could not be saved."""
    comp, user, _ = make_tenant(company_name=f"R750Q {uuid.uuid4().hex[:6]}", user_name="R750Q")
    hdr = auth_headers(user, comp)
    for i, typed in enumerate(("'18.651125,72.868279'", "(18.651125, 72.868279)", "18.651125 72.868279",
                               "18.651125°, 72.868279°")):
        r = _create_project(client, hdr, comp.id, f"R750Q {i}", location=typed)
        assert r.status_code in (200, 201), f"{typed!r}: {r.text}"
        assert r.json()["location"] == "18.651125,72.868279", r.json()
    r = _create_project(client, hdr, comp.id, "R750Q bad", location="abc")
    assert r.status_code == 422 and "'" not in r.json()["detail"][0]["msg"], r.text
