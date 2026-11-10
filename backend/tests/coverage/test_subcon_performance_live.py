"""Subcontractor performance, worked out live from real records.

The old scorecard measured the wrong things: "on-time %" was the share of the
subcontractor's bills we had paid; "billing accuracy" set one period's bills
against the whole work order (a normal monthly bill scored ~10%); quality
lost 5 points per work order amendment while NCRs raised against them were
ignored; tasks not yet due counted as delayed; and opening the page saved a
new scorecard every time. Labour showed the average of those three numbers
as "Reliability".
"""
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app import models
from tests.coverage.test_domain_formula_fixes import _mk_project

FRONT = Path(__file__).resolve().parents[3] / "frontend" / "src"


def _utc(y, m, d, h=6):
    return datetime(y, m, d, h, tzinfo=timezone.utc)


def _setup(db, make_tenant, auth_headers):
    t = uuid.uuid4().hex[:8]
    comp, user, sub = make_tenant(company_name=f"SP{t}", user_name=f"SP{t}",
                                  mobile="+9174" + str(int(t, 16))[-8:], email=f"sp-{t}@test.com")
    project = _mk_project(db, comp)
    wo = models.WorkOrder(id=uuid.uuid4(), company_id=comp.id, project_id=project.id, subcontractor_id=sub.id,
                          wo_number=f"WO-{t}", wo_date=_utc(2026, 1, 1), status="active", estimated_work_amount=100000)
    db.add(wo)
    db.commit()
    return comp, project, sub, wo, auth_headers(user, comp)


def _task(db, project, wo, name, end, status, baseline_end=None):
    t = models.Task(id=uuid.uuid4(), project_id=project.id, name=name, duration_days=5,
                    start_date=end - timedelta(days=5), end_date=end, status=status,
                    progress=100 if status == "completed" else 40, baseline_end=baseline_end)
    db.add(t)
    db.flush()
    db.add(models.WorkOrderItem(id=uuid.uuid4(), wo_id=wo.id, task_id=t.id, quantity=1, rate=1, amount=1))
    return t


def _get(client, hdr, project, **q):
    qs = "&".join(f"{k}={v}" for k, v in q.items())
    r = client.get(f"/apis/v3/subcon/performance/{project.id}?{qs}", headers=hdr)
    assert r.status_code == 200, r.text
    return r.json()


def test_on_time_means_finished_by_original_plan(client, db, make_tenant, auth_headers):
    _c, project, sub, wo, hdr = _setup(db, make_tenant, auth_headers)
    _task(db, project, wo, "Slab 1", _utc(2026, 3, 10), "completed", baseline_end=_utc(2026, 3, 12))  # early
    _task(db, project, wo, "Slab 2", _utc(2026, 3, 20), "completed", baseline_end=_utc(2026, 3, 15))  # late
    _task(db, project, wo, "Slab 3", _utc(2026, 3, 25), "in_progress")                                # past due
    future = datetime.now(timezone.utc) + timedelta(days=20)
    _task(db, project, wo, "Slab 9", future, "in_progress")                                          # not due yet
    db.commit()
    row = _get(client, hdr, project)[0]
    assert (row["tasks_finished"], row["tasks_judged"], row["finished_on_time"]) == (2, 2, 1)
    assert row["running_late"] == 1


def test_paying_their_bills_does_not_make_them_on_time(client, db, make_tenant, auth_headers):
    comp, project, sub, wo, hdr = _setup(db, make_tenant, auth_headers)
    db.add(models.Bill(id=uuid.uuid4(), company_id=comp.id, project_id=project.id, party_company_user_id=sub.id,
                       wo_id=wo.id, invoice_number="RA-1", invoice_date=_utc(2026, 3, 5), invoice_type="subcon",
                       subtotal=10000, total_payable=11800, paid_amount=11800, status="Paid"))
    db.commit()
    row = _get(client, hdr, project)[0]
    assert row["tasks_judged"] == 0 and row["finished_on_time"] == 0
    assert row["billed_to_date"] == 10000 and row["wo_value"] == 100000


def test_ncrs_against_them_count_and_amendments_are_not_quality(client, db, make_tenant, auth_headers):
    comp, project, sub, wo, hdr = _setup(db, make_tenant, auth_headers)
    db.add_all([
        models.NCR(project_id=project.id, ncr_number="N1", title="Honeycombing", severity="Major", status="open", vendor_id=sub.id),
        models.NCR(project_id=project.id, ncr_number="N2", title="Cover", severity="Minor", status="closed", vendor_id=sub.id),
        models.NCR(project_id=project.id, ncr_number="N3", title="Other firm", severity="Minor", status="open", vendor_id=None),
        models.WorkOrderAmendment(wo_id=wo.id, amendment_number=1, amended_fields={"terms": "x"}, amended_at=datetime.now(timezone.utc)),
    ])
    db.commit()
    row = _get(client, hdr, project)[0]
    assert (row["ncrs_raised"], row["ncrs_open"], row["amendments"]) == (2, 1, 1)


def test_period_filters_by_india_date(client, db, make_tenant, auth_headers):
    comp, project, sub, wo, hdr = _setup(db, make_tenant, auth_headers)
    # 31 Oct 20:00 UTC is 1 Nov in India: belongs to November.
    db.add(models.Bill(id=uuid.uuid4(), company_id=comp.id, project_id=project.id, party_company_user_id=sub.id,
                       wo_id=wo.id, invoice_number="RA-2", invoice_date=datetime(2026, 10, 31, 20, tzinfo=timezone.utc),
                       invoice_type="subcon", subtotal=5000, total_payable=5900, status="Unpaid"))
    db.commit()
    assert _get(client, hdr, project, start="2026-11-01", end="2026-11-30")[0]["billed"] == 5000
    assert _get(client, hdr, project, start="2026-10-01", end="2026-10-31")[0]["billed"] == 0


def test_screens_use_the_live_view_and_nothing_saves_on_open():
    page = (FRONT / "app" / "c" / "[company_id]" / "d" / "subcon" / "scorecards" / "page.tsx").read_text(encoding="utf-8")
    assert "recompute" not in page and "SubconPerformance" in page
    for p in ("d/subcon/page.tsx", "d/labour/page.tsx"):
        s = (FRONT / "app" / "c" / "[company_id]" / p).read_text(encoding="utf-8")
        assert "<SubconPerformance projectId={projectId} />" in s, p
        assert "Reliability" not in s.replace("reliability", ""), p
    comp = (FRONT / "components" / "SubconPerformance.tsx").read_text(encoding="utf-8")
    assert "/apis/v3/subcon/performance/" in comp
