"""R2-597 regression pins: an inactive subcontractor must not score a perfect 100%
on every metric, and Billing Accuracy % must be computed from real quoted-vs-billed
data instead of being a hardcoded constant."""
import datetime
import uuid

from app import models


def _project(db, company):
    p = models.Project(
        id=uuid.uuid4(), company_id=company.id, name="R2597Proj",
        code=uuid.uuid4().hex[:6], status="Ongoing",
    )
    db.add(p)
    db.commit()
    return p


def _subcontractor(db, company):
    user = models.User(id=uuid.uuid4(), name="Subby", mobile="+9191" + uuid.uuid4().hex[:10])
    db.add(user)
    db.flush()
    team = models.CompanyTeam(
        id=uuid.uuid4(), company_id=company.id, user_id=user.id,
        priority_type="subcontractor",
    )
    db.add(team)
    db.commit()
    return team


def _recompute(client, hdr, proj):
    period_start = "2026-07-01T00:00:00"
    period_end = "2026-07-31T23:59:59"
    return client.post(
        f"/apis/v3/subcon/scorecards/recompute?project_id={proj.id}"
        f"&period_start={period_start}&period_end={period_end}",
        headers=hdr,
    )


def test_no_activity_scores_zero_not_perfect(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="A", user_name="UA", mobile="+919888770101")
    proj = _project(db, comp)
    sub = _subcontractor(db, comp)
    hdr = auth_headers(user, comp)

    # A bare work order is enough for recompute to pick the subcon up - no items,
    # no bills, no amendments: zero activity in the period.
    db.add(models.WorkOrder(
        id=uuid.uuid4(), company_id=comp.id, project_id=proj.id,
        subcontractor_id=sub.id, wo_number="WO-EMPTY",
        wo_date=datetime.datetime(2026, 7, 5),
    ))
    db.commit()

    r = _recompute(client, hdr, proj)
    assert r.status_code == 200, r.text
    card = next(c for c in r.json()["scorecards"] if c["subcontractor_id"] == str(sub.id))
    assert float(card["on_time_pct"]) == 0.0
    assert float(card["billing_accuracy_pct"]) == 0.0
    assert float(card["quality_score"]) == 0.0

    listing = client.get(f"/apis/v3/subcon/scorecards/{proj.id}", headers=hdr)
    assert listing.status_code == 200, listing.text
    row = next(c for c in listing.json() if c["subcontractor_id"] == str(sub.id))
    assert float(row["on_time_pct"]) == 0.0
    assert float(row["billing_accuracy_pct"]) == 0.0
    assert float(row["quality_score"]) == 0.0


def test_billing_accuracy_computed_from_quoted_vs_billed(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="B", user_name="UB", mobile="+919888770102")
    proj = _project(db, comp)
    sub = _subcontractor(db, comp)
    hdr = auth_headers(user, comp)

    db.add(models.WorkOrder(
        id=uuid.uuid4(), company_id=comp.id, project_id=proj.id,
        subcontractor_id=sub.id, wo_number="WO-Q",
        wo_date=datetime.datetime(2026, 7, 1),
        estimated_work_amount=1000.0,
    ))
    db.add(models.Bill(
        id=uuid.uuid4(), company_id=comp.id, project_id=proj.id,
        party_company_user_id=sub.id, invoice_number="SUB-R2597",
        invoice_date=datetime.datetime(2026, 7, 10),
        invoice_type="subcon", subtotal=1000.0, total_payable=1180.0,
        paid_amount=1180.0, status="Paid",
    ))
    db.commit()

    r = _recompute(client, hdr, proj)
    assert r.status_code == 200, r.text
    card = next(c for c in r.json()["scorecards"] if c["subcontractor_id"] == str(sub.id))

    # Quoted 1000 vs billed 1000 of work: GST is not a billing deviation.
    assert float(card["total_billed"]) == 1000.0
    assert float(card["billing_accuracy_pct"]) == 100.0
    # The single bill is Paid -> settlement rate is genuinely 100% here.
    assert float(card["on_time_pct"]) == 100.0
