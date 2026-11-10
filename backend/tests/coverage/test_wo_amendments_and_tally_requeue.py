"""Work order amendments and the Tally re-queue box, as people use them.

Amendments: the screen read the work order id from a route segment that does
not exist, so it never showed one, and it asked for the change as typed JSON
whose example fields ("rate", "quantity") the server refuses. The server
also let a cancelled work order be amended, let the value drop below what is
already billed, took no reason, and kept only the new value.

Tally: undoing a wrong "imported" mark needed the record's internal ID typed
in. The screen now lists what was marked, with a button per record.
"""
import uuid
from pathlib import Path

from app import models
from tests.coverage.test_domain_formula_fixes import _mk_project, _utc

FRONT = Path(__file__).resolve().parents[3] / "frontend" / "src" / "app" / "c" / "[company_id]"


def _tag():
    t = uuid.uuid4().hex[:8]
    return t, "+9176" + str(int(t, 16))[-8:], f"a-{t}@test.com"


def _wo(client, db, make_tenant, auth_headers, billed=0.0):
    t, mob, mail = _tag()
    comp, user, team = make_tenant(company_name=f"WA{t}", user_name=f"WA{t}", mobile=mob, email=mail)
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)
    wo = models.WorkOrder(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, subcontractor_id=team.id,
        wo_number=f"WO-{t}", wo_date=_utc(2026, 9, 1), status="active",
        estimated_work_amount=1000000.0, terms="Old terms")
    db.add(wo)
    if billed:
        db.add(models.Bill(
            id=uuid.uuid4(), company_id=comp.id, project_id=project.id, party_company_user_id=team.id,
            wo_id=wo.id, invoice_number=f"SB-{t}", invoice_date=_utc(2026, 10, 1),
            invoice_type="subcon", subtotal=billed, total_payable=billed, status="Unpaid"))
    db.commit()
    return comp, hdr, wo, team


def _amend(client, hdr, wo, fields, reason="Extra slab area"):
    return client.post(f"/apis/v3/subcon/work-orders/{wo.id}/amendments", headers=hdr,
                       json={"amended_fields": fields, "reason": reason})


def test_amendment_keeps_before_and_after_and_changes_the_work_order(client, db, make_tenant, auth_headers):
    _comp, hdr, wo, _ = _wo(client, db, make_tenant, auth_headers)
    r = _amend(client, hdr, wo, {"estimated_work_amount": 1250000, "terms": "New terms"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["amended_fields"] == {"estimated_work_amount": 1250000.0, "terms": "New terms"}
    assert body["previous_values"] == {"estimated_work_amount": 1000000.0, "terms": "Old terms"}
    assert body["reason"] == "Extra slab area"
    db.refresh(wo)
    assert float(wo.estimated_work_amount) == 1250000.0 and wo.terms == "New terms"
    hist = client.get(f"/apis/v3/subcon/work-orders/{wo.id}/amendments", headers=hdr).json()
    assert [h["amendment_number"] for h in hist] == [1]


def test_amendment_needs_a_reason_and_a_real_change(client, db, make_tenant, auth_headers):
    _comp, hdr, wo, _ = _wo(client, db, make_tenant, auth_headers)
    assert _amend(client, hdr, wo, {"estimated_work_amount": 1100000}, reason="  ").status_code == 422
    assert _amend(client, hdr, wo, {"estimated_work_amount": 1000000}).status_code == 422
    r = _amend(client, hdr, wo, {"rate": 1200.0, "quantity": 500.0})
    assert r.status_code == 422 and "rate" not in r.json()["detail"]


def test_amendment_cannot_drop_value_below_what_is_billed(client, db, make_tenant, auth_headers):
    _comp, hdr, wo, _ = _wo(client, db, make_tenant, auth_headers, billed=600000.0)
    r = _amend(client, hdr, wo, {"estimated_work_amount": 500000})
    assert r.status_code == 422, r.text
    assert "already billed" in r.json()["detail"]
    assert _amend(client, hdr, wo, {"estimated_work_amount": 600000}).status_code == 201


def test_cancelled_work_order_cannot_be_amended(client, db, make_tenant, auth_headers):
    _comp, hdr, wo, _ = _wo(client, db, make_tenant, auth_headers)
    wo.status = "cancelled"
    db.commit()
    assert _amend(client, hdr, wo, {"estimated_work_amount": 1100000}).status_code == 409


def test_amendments_screen_takes_the_work_order_from_the_link_and_has_no_json_box():
    src = (FRONT / "d" / "subcon" / "work-orders" / "amendments" / "page.tsx").read_text(encoding="utf-8")
    assert 'search.get("wo")' in src
    assert "params.wo_id" not in src
    assert "JSON.parse" not in src and "(JSON)" not in src
    for p in ("d/subcon/page.tsx", "p/[project_id]/subcon/page.tsx"):
        s = (FRONT / p).read_text(encoding="utf-8")
        assert "/d/subcon/work-orders/amendments?project=${projectId}&wo=${wo.id}" in s, p


def test_tally_lists_imported_records_to_put_back(client, db, make_tenant, auth_headers):
    comp, hdr, wo, team = _wo(client, db, make_tenant, auth_headers, billed=1000.0)
    bill = db.query(models.Bill).filter(models.Bill.wo_id == wo.id).first()
    bill.tally_synced = True
    db.commit()
    r = client.get(f"/apis/v3/tally/synced?company_id={comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    rows = r.json()
    assert [(x["kind"], x["id"], x["number"]) for x in rows] == [("bill", str(bill.id), bill.invoice_number)]
    src = (FRONT / "d" / "integrations" / "tally" / "page.tsx").read_text(encoding="utf-8")
    assert "UUID" not in src
    assert "/apis/v3/tally/synced?company_id=" in src


def test_empty_tally_queue_does_not_claim_all_synced_when_tally_is_not_set_up():
    src = (FRONT / "d" / "integrations" / "tally" / "page.tsx").read_text(encoding="utf-8")
    assert "All vouchers are up-to-date and synced with Tally." not in src
    assert "tallyConnected === false" in src and "Tally is not set up for this company yet" in src
