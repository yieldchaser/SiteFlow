"""Cost codes and rate cards, as an estimator uses them.

- Deleting a parent cost code silently deleted every sub code under it.
- A cost code in use (BOQ items, payments, payroll details, rate cards) could
  be deleted or renamed, leaving those records on a code that no longer
  exists; every later edit of them was then refused as an unknown code.
- A duplicate code came back as a raw database error.
- A parent could be another company's code, or the code itself.
- A rate card's sale price was taken as sent, so changing the cost left the
  old sale price standing.
- Deleting any library item happened on one click.
"""
import uuid
from decimal import Decimal
from pathlib import Path

from app import models

PAGE = Path(__file__).resolve().parents[3] / "frontend" / "src" / "app" / "c" / "[company_id]" / "d" / "library" / "page.tsx"


def _tenant(make_tenant, auth_headers, tag):
    t = uuid.uuid4().hex[:8]
    comp, user, _team = make_tenant(company_name=f"CC{tag}{t}", user_name=f"CC{t}",
                                    mobile="+9176" + str(int(t, 16))[-8:], email=f"cc-{t}@test.com")
    return comp, auth_headers(user, comp)


def _code(client, hdr, comp, code, name="Civil", parent_id=None):
    body = {"company_id": str(comp.id), "code": code, "name": name}
    if parent_id:
        body["parent_id"] = parent_id
    return client.post("/apis/v3/library/cost-codes", headers=hdr, json=body)


def test_parent_with_sub_codes_is_not_deleted_silently(client, db, make_tenant, auth_headers):
    comp, hdr = _tenant(make_tenant, auth_headers, "A")
    parent = _code(client, hdr, comp, "100").json()["id"]
    _code(client, hdr, comp, "100.1", "Excavation", parent)
    r = client.delete(f"/apis/v3/library/cost-codes/{parent}", headers=hdr)
    assert r.status_code == 409 and "sub code" in r.json()["detail"]
    assert db.query(models.LibraryCostCode).filter_by(company_id=comp.id).count() == 2


def test_code_in_use_cannot_be_deleted_and_rename_carries_records(client, db, make_tenant, auth_headers):
    comp, hdr = _tenant(make_tenant, auth_headers, "B")
    cid = _code(client, hdr, comp, "200").json()["id"]
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Tower", status="Ongoing")
    db.add(project)
    db.flush()
    boq = models.BOQItem(id=uuid.uuid4(), project_id=project.id, item_name="PCC", unit="Cu.M",
                         quantity=Decimal("10"), rate=Decimal("100"), cost_code="200")
    db.add(boq)
    db.commit()
    r = client.delete(f"/apis/v3/library/cost-codes/{cid}", headers=hdr)
    assert r.status_code == 409 and "1 BOQ item" in r.json()["detail"], r.text
    r = client.put(f"/apis/v3/library/cost-codes/{cid}", headers=hdr, json={"code": "210"})
    assert r.status_code == 200, r.text
    db.refresh(boq)
    assert boq.cost_code == "210"


def test_duplicate_and_bad_parent_get_plain_answers(client, db, make_tenant, auth_headers):
    comp, hdr = _tenant(make_tenant, auth_headers, "C")
    other, ohdr = _tenant(make_tenant, auth_headers, "D")
    first = _code(client, hdr, comp, "300").json()["id"]
    dup = _code(client, hdr, comp, "300", "Again")
    assert dup.status_code == 409 and "already exists" in dup.json()["detail"]
    theirs = _code(client, ohdr, other, "900").json()["id"]
    assert _code(client, hdr, comp, "301", parent_id=theirs).status_code == 422
    child = _code(client, hdr, comp, "300.1", parent_id=first).json()["id"]
    loop = client.put(f"/apis/v3/library/cost-codes/{first}", headers=hdr, json={"parent_id": child})
    assert loop.status_code == 422
    assert _code(client, hdr, comp, "   ").status_code == 422


def test_sale_price_follows_cost_and_markup(client, db, make_tenant, auth_headers):
    comp, hdr = _tenant(make_tenant, auth_headers, "E")
    r = client.post("/apis/v3/library/rates", headers=hdr, json={
        "company_id": str(comp.id), "name": "Plaster", "unit": "Sq.M", "unit_cost": 200,
        "markup_value": 10, "markup_type": "percent", "unit_sale_price": 999,
    })
    assert r.status_code == 200, r.text
    assert float(r.json()["unit_sale_price"]) == 220.0
    rid = r.json()["id"]
    r = client.put(f"/apis/v3/library/rates/{rid}", headers=hdr, json={"unit_cost": 300})
    assert float(r.json()["unit_sale_price"]) == 330.0
    r = client.put(f"/apis/v3/library/rates/{rid}", headers=hdr, json={"markup_type": "flat", "markup_value": 50})
    assert float(r.json()["unit_sale_price"]) == 350.0


def test_library_delete_asks_first():
    assert 'if (!confirm("Delete this item from the library?")) return;' in PAGE.read_text(encoding="utf-8")


def test_party_with_open_money_is_not_deleted(client, db, make_tenant, auth_headers):
    comp, hdr = _tenant(make_tenant, auth_headers, "F")
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Tower", status="Ongoing")
    party = models.LibraryParty(id=uuid.uuid4(), company_id=comp.id, name="Shree Steel", party_type="Supplier")
    spare = models.LibraryParty(id=uuid.uuid4(), company_id=comp.id, name="Unused", party_type="Supplier")
    db.add_all([project, party, spare])
    db.flush()
    db.add(models.ProjectParty(project_id=project.id, party_id=party.id, to_pay=Decimal("45000"), advance_paid=Decimal("0")))
    db.commit()
    r = client.delete(f"/apis/v3/library/parties/{party.id}", headers=hdr)
    assert r.status_code == 409 and "Shree Steel" in r.json()["detail"], r.text
    assert client.delete(f"/apis/v3/library/parties/{spare.id}", headers=hdr).status_code == 200


def test_repeating_todo_ticked_twice_makes_one_next(client, db, make_tenant, auth_headers):
    comp, hdr = _tenant(make_tenant, auth_headers, "G")
    r = client.post("/apis/v3/todos/", headers=hdr, json={
        "company_id": str(comp.id), "title": "Check curing", "repeat_type": "daily"})
    assert r.status_code in (200, 201), r.text
    tid = r.json()["id"]
    for status in ("done", "pending", "done"):
        assert client.put(f"/apis/v3/todos/{tid}", headers=hdr, json={"status": status}).status_code == 200
    assert db.query(models.Todo).filter_by(company_id=comp.id, title="Check curing").count() == 2


def test_only_the_owner_can_erase_the_delete_log_and_dates_are_india_days(client, db, make_tenant, auth_headers):
    from datetime import datetime, timezone
    from tests.coverage.test_r2_140_468_470_chat_membership_gate import _mk_colleague
    comp, hdr = _tenant(make_tenant, auth_headers, "H")
    # 10 Nov 20:00 in India is 14:30 UTC on 10 Nov.
    log = models.DeleteLog(company_id=comp.id, entity_type="bill", entity_id="x", entity_summary="Bill 7",
                           deleted_by="Ravi", deleted_at=datetime(2026, 11, 10, 14, 30, tzinfo=timezone.utc))
    db.add(log)
    db.commit()
    rows = client.get(f"/apis/v3/delete-logs/{comp.id}?from_date=2026-11-10&to_date=2026-11-10", headers=hdr).json()
    assert [r["entity_summary"] for r in rows] == ["Bill 7"]
    site = _mk_colleague(db, comp, f"Site{uuid.uuid4().hex[:6]}")
    r = client.delete(f"/apis/v3/delete-logs/{comp.id}/{log.id}", headers=auth_headers(site, comp))
    assert r.status_code == 403
    assert client.delete(f"/apis/v3/delete-logs/{comp.id}/{log.id}", headers=hdr).status_code == 200
