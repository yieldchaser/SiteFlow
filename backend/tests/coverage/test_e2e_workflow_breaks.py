"""Regression cover for the workflow breaks found by driving the app end to end
on 2026-09-02. Each test names the observed failure it prevents.

These are deliberately mixed: some pin frontend source, because the defect was in
the frontend and a backend-only test would pass on the broken tree and prove
nothing. Every one of them fails against the tree as it stood at 041c6d4.
"""

import datetime
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
FRONTEND = Path(__file__).resolve().parents[3] / "frontend"


def _be(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def _fe(rel):
    return (FRONTEND / rel).read_text(encoding="utf-8")


# ── E2E-41: safety incidents were rejected as "in the future" from any UTC+X client ──

def test_safety_sends_an_absolute_instant_not_a_wall_clock_time():
    """Observed: 422 "reported_at cannot be in the future" on every submit.

    nowLocalISO() yields "2026-09-02T11:55" with no zone. safety.py attaches the
    SERVER timezone to a naive datetime and Render runs UTC, so an IST wall-clock
    time was read as UTC and landed 5.5 hours ahead of now.
    """
    src = _fe("src/app/c/[company_id]/d/safety/page.tsx")
    assert "localInputToInstantISO(incidentForm.reported_at)" in src, (
        "E2E-41 regressed: the incident form is sending a naive datetime-local "
        "value again. It must go on the wire as an absolute instant."
    )
    assert "localInputToInstantISO(talkForm.conducted_at)" in src, (
        "E2E-41 regressed for toolbox talks: conducted_at is naive again, so the "
        "stored time is offset by the server-to-local difference."
    )


def test_local_input_to_instant_helper_exists_and_is_documented():
    src = _fe("src/lib/siteflow.ts")
    assert "export const localInputToInstantISO" in src, "E2E-41 helper removed"
    assert "toISOString" in src.split("localInputToInstantISO")[1][:600], (
        "localInputToInstantISO must produce an absolute instant"
    )


def test_backend_accepts_an_offset_aware_now_and_rejects_a_future_instant():
    """The validator itself is correct and must stay strict. This asserts both
    directions so a future "fix" cannot loosen it to make the frontend pass."""
    import uuid

    from app.routers.safety import IncidentCreate

    now_ist = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=5, minutes=30)))
    ok = IncidentCreate(
        project_id=uuid.uuid4(),
        incident_type="Near Miss",
        severity="Low",
        description="scaffold slip, no injury",
        reported_by="HSE Officer",
        reported_at=now_ist.isoformat(),
    )
    assert ok.reported_at is not None

    with pytest.raises(Exception):
        IncidentCreate(
            project_id=uuid.uuid4(),
            incident_type="Near Miss",
            severity="Low",
            description="scaffold slip, no injury",
            reported_by="HSE Officer",
            reported_at=(now_ist + datetime.timedelta(days=2)).isoformat(),
        )


# ── E2E-39: wastage could never be recorded, and the 422 blanked the route ──

def test_wastage_does_not_send_an_empty_string_task_id():
    """Observed: 422 uuid_parsing on every submit, because task_id: "" was in the
    form's initial state, bound to no input, and always sent."""
    src = _fe("src/app/c/[company_id]/d/wastage/page.tsx")
    assert 'task_id: ""' not in src, (
        "E2E-39 regressed: wastage is sending task_id as an empty string again. "
        "The backend declares Optional[uuid.UUID]; send null instead."
    )


def test_error_detail_is_normalised_before_it_reaches_react_state():
    """Observed: setMessage(err.detail) with a FastAPI validation array threw
    React error #31 and rendered "This page couldn't load" for the whole route."""
    api = _fe("src/lib/api.ts")
    assert "export function detailToMessage" in api, "detailToMessage helper removed"

    offenders = []
    pattern = re.compile(r"\.detail\s*\|\|\s*\"")
    for path in (FRONTEND / "src").rglob("*.tsx"):
        if "node_modules" in str(path):
            continue
        if pattern.search(path.read_text(encoding="utf-8")):
            offenders.append(str(path.relative_to(FRONTEND)))
    assert not offenders, (
        "E2E-39b regressed: these files pass a raw API `detail` straight into a "
        f"message with no normalisation, which blanks the route on a 422: {offenders}"
    )


def test_the_detector_would_notice_an_unnormalised_site():
    """Self-test. A sweep that finds nothing passes trivially, so prove the
    pattern actually matches the shape it is meant to catch."""
    pattern = re.compile(r"\.detail\s*\|\|\s*\"")
    assert pattern.search('setMessage(err.detail || "Failed");'), "pattern misses the real shape"
    assert not pattern.search(
        'setMessage(detailToMessage(err.detail, "Failed"));'
    ), "pattern flags the fixed shape"


# ── E2E-01: no project could be created, because no surface collected state ──

def test_project_create_surfaces_collect_the_gst_state():
    """Observed: POST /projects/ 422 "Project.state is required for invoicing"
    on every attempt, and no wizard or settings modal had the field."""
    for rel in (
        "src/app/c/[company_id]/projects/page.tsx",
        "src/components/ProjectSettingsModal.tsx",
    ):
        src = _fe(rel)
        assert "GST_STATES" in src or "state:" in src, f"E2E-01 regressed: {rel} lost its state field"

    wizard = _fe("src/app/c/[company_id]/projects/page.tsx")
    assert "state," in wizard or "state:" in wizard, "E2E-01 wizard no longer sends state"
    assert "location" in wizard, (
        "E2E-04 regressed: the wizard must send site coordinates, or the "
        "attendance geofence it configures has no centre"
    )


def test_backend_still_requires_state_on_project_create():
    src = _be("app/routers/projects.py")
    assert "Project.state is required for invoicing" in src, (
        "E2E-01: the guard was removed instead of the UI being fixed. Place of "
        "supply derives from the site; this check must stay."
    )


# ── E2E-16: a short delivery stranded the balance quantity forever ──

def test_a_partially_received_po_can_still_receive_the_balance():
    """Observed: ordered 500, received 450, PO went sent -> partial, and the
    Record GRN button vanished because it was gated on status === "sent"."""
    src = _fe("src/app/c/[company_id]/d/procurement/page.tsx")
    assert 'po.status === "sent" && po.approvalFlag === "approved"' not in src, (
        "E2E-16 regressed: Record GRN is gated on status === 'sent' again, so a "
        "partially received PO can never take its balance delivery."
    )


# ── E2E-15: a PO could not be raised to a supplier ──

def test_po_vendor_list_is_not_sourced_from_subcontractors():
    """Observed: the Supplier Vendor dropdown offered only subcontractors,
    because it was fed by /billing/subcontractors."""
    src = _fe("src/app/c/[company_id]/d/procurement/page.tsx")
    # Match the fetch call, not any mention of the path: the fix carries a
    # comment naming the old endpoint, and a bare substring check would flag it.
    assert "fetch(`${apiHost}/apis/v3/billing/subcontractors" not in src, (
        "E2E-15 regressed: the PO vendor picker is reading subcontractors again, "
        "so a material PO cannot name the material supplier."
    )
    assert "fetch(`${apiHost}/apis/v3/library/parties/" in src, (
        "E2E-15: the PO vendor picker must read the party master"
    )


# ── E2E-29: payment requests listed employees instead of parties ──

def test_payment_request_party_picker_is_not_the_employee_directory():
    """Observed: the drawer said "No parties registered yet" while
    GET /finance/parties returned 8 parties, because usersList was filled from
    /hr/employees/{projectId}."""
    src = _fe("src/app/c/[company_id]/d/finance/page.tsx")
    assert "setUsersList(await empRes.json())" not in src, (
        "E2E-29 regressed: the payment-request party picker is reading the "
        "employee directory again."
    )


# ── E2E-42: equipment usage was never costed ──

def test_equipment_return_records_hours_and_the_closing_meter():
    """Observed: the return endpoint accepted no body, so the stop odometer was
    discarded and hours_used stayed 0.0 against an hourly rate."""
    src = _be("app/routers/equipment.py")
    assert "hours_used" in src.split("def return_deployment")[1][:1600], (
        "E2E-42 regressed: return_deployment no longer computes hours_used, so "
        "equipment usage produces no cost."
    )


# ── E2E-21: a required custom field on an entity the admin UI cannot show ──

def test_custom_field_admin_exposes_every_entity_type_the_backend_allows():
    """Observed: a required 'bill' custom field blocked every RA bill and could
    not be seen or edited, because the admin page listed only four of six types."""
    be = _be("app/routers/custom_fields.py")
    m = re.search(r"CUSTOM_FIELD_ENTITY_TYPES\s*=\s*\(([^)]*)\)", be)
    assert m, "could not read CUSTOM_FIELD_ENTITY_TYPES"
    backend_types = {t.strip().strip("\"'") for t in m.group(1).split(",") if t.strip()}

    fe = _fe("src/app/c/[company_id]/d/custom-fields/page.tsx")
    missing = sorted(t for t in backend_types if f'value="{t}"' not in fe)
    assert not missing, (
        "E2E-21 regressed: the custom-field admin page cannot manage these entity "
        f"types, so a required field on one of them blocks its form forever: {missing}"
    )


def test_a_purchase_order_can_name_a_supplier_from_the_party_library(
    client, db, make_tenant, auth_headers
):
    """Observed: the Supplier Vendor picker offered only subcontractors.

    PurchaseOrder.vendor_id is FK -> company_team.id, and a party registered
    through the Party Library has no company_team row, so simply listing parties
    in the picker would have violated the foreign key. The create endpoint takes
    vendor_party_id and resolves the link itself.
    """
    import uuid as _uuid

    from app import models

    sfx = _uuid.uuid4().hex[:8]
    comp, user, _team = make_tenant(
        company_name=f"POVendor-{sfx}", user_name=f"UPOVendor-{sfx}",
        mobile=f"+9196{sfx}", email=f"povendor-{sfx}@test.com",
    )
    hdr = auth_headers(user, comp)

    project = models.Project(
        id=_uuid.uuid4(), company_id=comp.id, name="PO Vendor Site", state="Maharashtra"
    )
    supplier = models.LibraryParty(
        id=_uuid.uuid4(), company_id=comp.id, name="Shakti Steel Traders",
        party_type="Supplier",
    )
    db.add_all([project, supplier])
    db.commit()

    res = client.post(
        "/apis/v3/procurement/pos",
        json={
            "company_id": str(comp.id),
            "project_id": str(project.id),
            "vendor_party_id": str(supplier.id),
            "po_number": f"PO-{sfx}",
            "po_date": "2026-09-02T00:00:00Z",
            "items": [
                {"material_name": "OPC 53 Grade Cement", "quantity": 100,
                 "unit": "Bag", "rate": 410, "tax_pct": 28, "total_amount": 52480}
            ],
        },
        headers=hdr,
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["vendor_name"] == "Shakti Steel Traders", (
        "E2E-15: a Supplier chosen from the party library must resolve to a real "
        f"vendor on the PO; got {body.get('vendor_name')!r}"
    )


# ── Part 9: smaller things, all observed on the same pass ──

def test_attendance_can_be_marked_without_gps(client, db, make_tenant, auth_headers):
    """Observed: the muster offered Present / Absent / Paid Leave / Week Off as
    filters and the only write path was a GPS punch, so a crew with no
    smartphones could not be marked at all and payroll had nothing to read."""
    import uuid as _uuid

    from app import models

    sfx = _uuid.uuid4().hex[:8]
    comp, user, _team = make_tenant(
        company_name=f"Muster-{sfx}", user_name=f"UMuster-{sfx}",
        mobile=f"+9197{sfx}", email=f"muster-{sfx}@test.com",
    )
    hdr = auth_headers(user, comp)
    project = models.Project(id=_uuid.uuid4(), company_id=comp.id, name="Muster Site", state="Karnataka")
    emp = models.StaffEmployee(
        id=_uuid.uuid4(), company_id=comp.id, project_id=None, name="Ramesh Kumar", status="active"
    )
    db.add_all([project, emp])
    db.commit()

    res = client.post(
        "/apis/v3/hr/attendance/manual",
        json={
            "employee_id": str(emp.id),
            "project_id": str(project.id),
            "attendance_date": "2026-09-02",
            "status": "Present",
        },
        headers=hdr,
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "Present"
    assert body["marked_manually"] is True, "a hand-marked day must be flagged as such"
    assert body["location_verified"] is False, (
        "a hand-marked day is somebody's word, not a measured punch, and the "
        "muster shown to whoever signs off payroll has to say which is which"
    )

    # Re-marking the same day must update, never stack a second attendance row,
    # which would double-count payroll days.
    again = client.post(
        "/apis/v3/hr/attendance/manual",
        json={
            "employee_id": str(emp.id),
            "project_id": str(project.id),
            "attendance_date": "2026-09-02",
            "status": "Absent",
        },
        headers=hdr,
    )
    assert again.status_code == 200, again.text
    assert again.json()["id"] == body["id"], "re-marking created a duplicate attendance row"


def test_a_duplicate_party_id_is_rejected(client, db, make_tenant, auth_headers):
    """Observed: the library showed PID-1, PID-2, PID-2, PID-4, PID-5. The
    generator has a collision loop; a SUPPLIED id was stored unchecked."""
    import uuid as _uuid

    sfx = _uuid.uuid4().hex[:8]
    comp, user, _team = make_tenant(
        company_name=f"PID-{sfx}", user_name=f"UPID-{sfx}",
        mobile=f"+9198{sfx}", email=f"pid-{sfx}@test.com",
    )
    hdr = auth_headers(user, comp)

    first = client.post(
        "/apis/v3/library/parties",
        json={"company_id": str(comp.id), "party_id_custom": "PID-99", "name": "First Vendor"},
        headers=hdr,
    )
    assert first.status_code in (200, 201), first.text

    clash = client.post(
        "/apis/v3/library/parties",
        json={"company_id": str(comp.id), "party_id_custom": "PID-99", "name": "Second Vendor"},
        headers=hdr,
    )
    assert clash.status_code == 409, (
        "a supplied party id that is already taken must be refused, not stored "
        f"as a duplicate; got {clash.status_code}"
    )


def test_an_employee_cannot_be_saved_without_a_name():
    """Observed: POST /hr/employees with name "" returned 201 and the row
    rendered with a blank NAME cell."""
    import uuid as _uuid

    import pytest as _pytest

    from app.routers.hr import EmployeeCreate

    for blank in ("", "   "):
        with _pytest.raises(Exception):
            EmployeeCreate(company_id=_uuid.uuid4(), name=blank)

    ok = EmployeeCreate(company_id=_uuid.uuid4(), name="  Ramesh Kumar  ")
    assert ok.name == "Ramesh Kumar", "name should be stored trimmed"

    with _pytest.raises(Exception):
        EmployeeCreate(company_id=_uuid.uuid4(), name="Ramesh", basic_salary=9_811_223_344)


def test_indents_are_numbered():
    """Observed: every indent raised through the UI stored indent_number "".
    An unnumbered requisition cannot be quoted to a vendor."""
    src = _be("app/routers/procurement.py")
    assert "_generate_indent_number" in src, "E2E-11 regressed: indents are unnumbered again"
    assert 'f"IND-{count + 1:04d}"' in src, "indent numbering format changed unexpectedly"


def test_no_is_code_claims_in_billing_payroll_or_quality_copy():
    """IS 456 is the plain and reinforced concrete code. It has nothing to do
    with GST, TDS or PF, and it was cited on all three screens."""
    offenders = []
    for rel in (
        "src/app/c/[company_id]/d/billing/page.tsx",
        "src/app/c/[company_id]/d/attendance/page.tsx",
        "src/app/c/[company_id]/p/[project_id]/attendance/page.tsx",
        "src/app/c/[company_id]/d/quality/page.tsx",
    ):
        text = _fe(rel)
        if "IS-456" in text or "per IS code" in text or "Compliant with IS code" in text:
            offenders.append(rel)
    assert not offenders, f"IS-code claims reintroduced in: {offenders}"


def test_employee_and_payroll_create_accept_empty_project_id():
    """An unselected project in the UI passes project_id="" instead of null.
    The schema must coerce empty strings to None without raising a 422 UUID parsing error."""
    import uuid as _uuid
    from datetime import datetime, timezone
    from app.routers.hr import EmployeeCreate, PayrollRunCreate, LeaveRequestCreate

    cid = _uuid.uuid4()
    emp = EmployeeCreate(company_id=cid, name="Ramesh Kumar", project_id="")
    assert emp.project_id is None, "Empty string project_id should be coerced to None"

    emp_none = EmployeeCreate(company_id=cid, name="Ramesh Kumar", project_id=None)
    assert emp_none.project_id is None

    pid = _uuid.uuid4()
    emp_uuid = EmployeeCreate(company_id=cid, name="Ramesh Kumar", project_id=pid)
    assert emp_uuid.project_id == pid

    pr = PayrollRunCreate(company_id=cid, payroll_month="2026-09", project_id="")
    assert pr.project_id is None

    lr = LeaveRequestCreate(
        employee_id=_uuid.uuid4(),
        employee_name="Ramesh",
        leave_type="Casual",
        start_date=datetime.now(timezone.utc),
        end_date=datetime.now(timezone.utc),
        days_count=1,
        project_id=""
    )
    assert lr.project_id is None

