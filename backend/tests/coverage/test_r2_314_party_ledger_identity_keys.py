"""R2-314 - the party ledger aggregates by identity, not display name.

_build_party_ledger used the resolved display-name string as its aggregation
key, so (a) every unresolvable counterparty collapsed into one of four
fallback buckets ("Walk-in Party"/"Vendor/Client"/"Staff Member"/"Party")
sharing a single merged balance, and (b) two genuinely distinct parties whose
User.name matched were summed into one party. The ledger now keys by the
stable row id available at every branch (CompanyTeam.id for payments/bills/
debit/credit notes, StaffEmployee.id for salaries); the fallback labels remain
only as display text for rows with no counterparty id at all.
"""
import datetime
import uuid

from app import models


def _mk_project(db, comp, tag):
    p = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name=f"P{tag}",
        code=f"PRJ-{uuid.uuid4().hex[:8]}-{tag}", status="Ongoing",
    )
    db.add(p)
    db.commit()
    return p


def _mk_named_team(db, comp, name):
    """A CompanyTeam whose User carries an arbitrary (possibly duplicated) name."""
    user = models.User(id=uuid.uuid4(), name=name, mobile=f"+919{uuid.uuid4().int % 10**10:010d}")
    db.add(user)
    db.flush()
    team = models.CompanyTeam(id=uuid.uuid4(), company_id=comp.id, user_id=user.id)
    db.add(team)
    db.commit()
    return team


def _mk_bill(db, comp, project, team, invoice_number, amount, invoice_type="sale"):
    bill = models.Bill(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        party_company_user_id=team.id, invoice_number=invoice_number,
        invoice_date=datetime.datetime(2026, 8, 1), invoice_type=invoice_type,
        subtotal=amount, gst_amount=0, total_payable=amount, paid_amount=0,
    )
    db.add(bill)
    db.commit()
    return bill


def _balances(client, hdr, comp):
    r = client.get(
        f"/apis/v3/reports/data/all-party-balances?company_id={comp.id}", headers=hdr,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert not body.get("errors"), body
    return body["rows"]


def test_same_named_parties_keep_separate_balances(client, db, make_tenant, auth_headers):
    """Two distinct counterparties sharing one User.name must never merge."""
    comp, user, _ = make_tenant(company_name="R2314A", user_name="U314A")
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp, "314")

    amit1 = _mk_named_team(db, comp, "Amit Kumar")
    amit2 = _mk_named_team(db, comp, "Amit Kumar")
    _mk_bill(db, comp, project, amit1, "INV-314-A", 500.0, "sale")
    _mk_bill(db, comp, project, amit2, "INV-314-B", 300.0, "purchase")

    rows = [r for r in _balances(client, hdr, comp) if r["Party Name"] == "Amit Kumar"]
    assert len(rows) == 2, rows
    balances = sorted(r["Balance Amount"] for r in rows)
    assert balances == [-300.0, 500.0], rows
    types = sorted(r["Balance Type"] for r in rows)
    assert types == ["Payable", "Receivable"], rows


def test_unidentified_payment_still_lands_in_one_walkin_bucket(client, db, make_tenant, auth_headers):
    """Rows with no counterparty id at all share the honest fallback bucket."""
    comp, user, _ = make_tenant(company_name="R2314B", user_name="U314B")
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp, "314b")

    db.add(models.Payment(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        payment_type="in", amount=120.0, unsettled_amount=0.0,
        payment_method="Cash", payment_date=datetime.datetime(2026, 8, 2),
    ))
    db.commit()

    rows = [r for r in _balances(client, hdr, comp) if r["Party Name"] == "Walk-in Party"]
    assert len(rows) == 1, rows
    # Money received with no invoice is an advance we hold: we owe it.
    assert rows[0]["Balance Amount"] == -120.0, rows
    assert rows[0]["Balance Type"] == "Payable", rows


def test_party_ledger_rows_still_carry_display_names(client, db, make_tenant, auth_headers):
    """The row feed keeps resolving real names; only the keying changed."""
    comp, user, _ = make_tenant(company_name="R2314C", user_name="U314C")
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp, "314c")

    vendor = _mk_named_team(db, comp, "R2-314 Vendor")
    _mk_bill(db, comp, project, vendor, "INV-314-C", 700.0, "purchase")

    r = client.get(
        f"/apis/v3/reports/data/party-ledger?company_id={comp.id}", headers=hdr,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert not body.get("errors"), body
    names = [row["Party Name"] for row in body["rows"]]
    assert names == ["R2-314 Vendor"], names


def test_receipts_and_notes_post_against_the_bill(client, db, make_tenant, auth_headers):
    """A client billed 1,000 who paid 600 owes 400. Receipts posted on the
    same side as the invoice, so the ledger said 1,600; a supplier credit
    note and cancelled bills moved balances too."""
    comp, user, _ = make_tenant(company_name="R2314L", user_name="U314L")
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp, "314l")
    client_t = _mk_named_team(db, comp, "Client Co")
    vendor_t = _mk_named_team(db, comp, "Vendor Co")

    _mk_bill(db, comp, project, client_t, "INV-L1", 1000.0, "sale")
    cancelled = _mk_bill(db, comp, project, client_t, "INV-L2", 5000.0, "sale")
    cancelled.status = "Cancelled"
    _mk_bill(db, comp, project, vendor_t, "PB-L1", 800.0, "purchase")
    db.add(models.Payment(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, party_company_user_id=client_t.id,
        payment_type="in", amount=600.0, unsettled_amount=0.0,
        payment_method="Bank Transfer", payment_date=datetime.datetime(2026, 8, 3),
    ))
    db.add(models.Payment(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, party_company_user_id=vendor_t.id,
        payment_type="out", amount=300.0, unsettled_amount=0.0,
        payment_method="Bank Transfer", payment_date=datetime.datetime(2026, 8, 3),
    ))
    # Supplier debit note for 100 (we owe 100 less).
    db.add(models.DebitNote(id=uuid.uuid4(), project_id=project.id, company_id=comp.id,
                            party_company_user_id=vendor_t.id, total_amount=100.0))
    db.commit()

    rows = {r["Party Name"]: r for r in _balances(client, hdr, comp)}
    assert rows["Client Co"]["Balance Amount"] == 400.0, rows
    assert rows["Client Co"]["Balance Type"] == "Receivable"
    assert rows["Vendor Co"]["Balance Amount"] == -400.0, rows
    assert rows["Vendor Co"]["Balance Type"] == "Payable"
