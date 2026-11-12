"""Phase C statutory wave - behavior coverage for R2-126, R2-127, R2-128,
R2-283, R2-522, R2-523 and R2-524 on backend/app/routers/statutory.py."""
import uuid
from datetime import datetime

from app import models

_SUFFIX = uuid.uuid4().hex[:8]


_TENANT_N = 0


def _hdr(auth_headers, make_tenant, db, tag):
    global _TENANT_N
    _TENANT_N += 1
    comp, user, _team = make_tenant(
        company_name=f"{tag}-{_SUFFIX}",
        user_name=f"U {tag}",
        mobile=f"+9197{_SUFFIX[:8]}{_TENANT_N:03d}",
        email=f"{tag.lower()}-{_SUFFIX}@test.com",
    )
    return comp, user, auth_headers(user, comp)


def _emp(db, comp, name, **kw):
    emp = models.StaffEmployee(
        id=uuid.uuid4(), company_id=comp.id, name=name,
        basic_salary=kw.pop("basic_salary", 20000),
        hra=kw.pop("hra", 5000),
        other_allowances=kw.pop("other_allowances", 2500),
        uan=kw.pop("uan", "100123456789"),
        **kw,
    )
    db.add(emp)
    db.flush()
    return emp


def _seed_payroll(db, comp, month, items, project_id=None, status="finalized"):
    run = models.PayrollRun(
        id=uuid.uuid4(), company_id=comp.id, project_id=project_id,
        payroll_month=month, status=status,
        total_gross=0, total_deductions=0, total_net=0,
    )
    db.add(run)
    db.flush()
    for emp, fields in items:
        db.add(models.PayrollLineItem(
            id=uuid.uuid4(), payroll_run_id=run.id, employee_id=emp.id, **fields
        ))
    return run


# ── R2-283: a statutory record can actually be created and read back ─────────

def test_r2_283_create_list_roundtrip_and_auto_populate_response(client, db, make_tenant, auth_headers):
    comp, user, hdr = _hdr(auth_headers, make_tenant, db, "R2283")
    emp = _emp(db, comp, "Smoke Emp")
    _seed_payroll(db, comp, "2026-07", [(emp, dict(basic=10000))])
    db.commit()

    # Auto-populate builds the response from a plain dict - the exact path that
    # raised "3 validation errors for StatutoryReportResponse" on Sentry.
    r = client.get(
        f"/apis/v3/statutory/{comp.id}/auto-populate?report_type=pf&return_period=2026-07",
        headers=hdr,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["filed_at"] is None and body["filed_by"] is None, body
    assert body["acknowledgment_number"] is None, body

    # The audit's prescribed smoke test: create one report and list it.
    r = client.post(
        "/apis/v3/statutory",
        json={"company_id": str(comp.id), "report_type": "pf", "return_period": "2026-07"},
        headers=hdr,
    )
    assert r.status_code == 201, r.text
    created = r.json()
    assert created["due_date"] == "2026-08-15T00:00:00"

    r = client.get(f"/apis/v3/statutory/{comp.id}", headers=hdr)
    assert r.status_code == 200, r.text
    rows = [row for row in r.json() if row["id"] == created["id"]]
    assert len(rows) == 1, r.json()


# ── R2-127: ESI is charged per employee, not company-wide ────────────────────

def test_r2_127_esi_charged_only_for_applicable_employees(client, db, make_tenant, auth_headers):
    comp, user, hdr = _hdr(auth_headers, make_tenant, db, "R2127")
    e_app = _emp(db, comp, "Esi Applicable", is_esi_applicable=True)
    e_na = _emp(db, comp, "Esi Exempt", is_esi_applicable=False, basic_salary=40000)
    # Payslips carry the per-employee settlement payroll already made; the
    # statutory layer must carry them verbatim, never re-gate them company-wide.
    _seed_payroll(db, comp, "2026-07", [
        (e_app, dict(days_present=26, days_in_month=26, basic=20000, hra=5000,
                     other_allowances=2500, esi_employee=206.25, esi_employer=893.75)),
        (e_na, dict(days_present=26, days_in_month=26, basic=40000, hra=5000,
                    other_allowances=2500, esi_employee=0.0, esi_employer=0.0)),
    ])
    db.commit()

    r = client.get(
        f"/apis/v3/statutory/{comp.id}/auto-populate?report_type=esi&return_period=2026-07",
        headers=hdr,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # The higher-paid exempt colleague contributes zero ESI in both halves.
    assert body["esi_employee_contribution"] == 206.25, body
    assert body["esi_employer_contribution"] == 893.75, body


# ── R2-126: returns are built from the period's finalized payroll ────────────

def test_r2_126_auto_populate_builds_from_period_payslips(client, db, make_tenant, auth_headers):
    comp, user, hdr = _hdr(auth_headers, make_tenant, db, "R2126")
    joined_after = _emp(db, comp, "Stayer", basic_salary=30000, hra=8000, other_allowances=2000)
    leaver = _emp(db, comp, "Leaver", status="inactive", basic_salary=99999)
    _seed_payroll(db, comp, "2026-07", [
        (joined_after, dict(days_present=13, days_in_month=26, basic=15000, hra=4000,
                            other_allowances=1000, pf_employee=1800, pf_employer=1800, tds=200)),
        (leaver, dict(days_present=22, days_in_month=26, basic=12000, hra=3000,
                      other_allowances=500, pf_employee=1440, pf_employer=1440, tds=0)),
    ])
    db.commit()

    r = client.get(
        f"/apis/v3/statutory/{comp.id}/auto-populate?report_type=pf&return_period=2026-07",
        headers=hdr,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # Period snapshot: the leaver's July wages count even though he has since
    # left, and the stayer's post-period raise does not touch July.
    assert body["total_employees"] == 2, body
    assert body["total_wages"] == 35500.0, body
    assert body["pf_employee_contribution"] == 3240.0, body
    assert body["pf_employer_contribution"] == 3240.0, body
    assert body["tds_deducted"] == 200.0, body


def test_r2_126_refuses_without_finalized_run(client, db, make_tenant, auth_headers):
    comp, user, hdr = _hdr(auth_headers, make_tenant, db, "R2126B")
    _emp(db, comp, "Anyone")
    db.commit()

    # No run at all.
    r = client.get(
        f"/apis/v3/statutory/{comp.id}/auto-populate?report_type=pf&return_period=2026-07",
        headers=hdr,
    )
    assert r.status_code == 409, r.text
    assert "2026-07" in r.json()["detail"], r.text

    # A draft run is not a finalized run.
    emp = db.query(models.StaffEmployee).filter(models.StaffEmployee.company_id == comp.id).first()
    _seed_payroll(db, comp, "2026-08", [(emp, dict(basic=10000))], status="draft")
    db.commit()
    r = client.get(
        f"/apis/v3/statutory/{comp.id}/auto-populate?report_type=pf&return_period=2026-08",
        headers=hdr,
    )
    assert r.status_code == 409, r.text


# ── R2-128: BOCW cess is levied on construction cost, not wages ──────────────

def _bill(db, comp, team_id, project_id, number, inv_type, day, subtotal, status="Unpaid", gst=0, month=7):
    b = models.Bill(
        id=uuid.uuid4(), company_id=comp.id, project_id=project_id,
        party_company_user_id=team_id, invoice_number=f"{number}-{_SUFFIX}",
        invoice_date=datetime(2026, month, day), invoice_type=inv_type,
        status=status, subtotal=subtotal, gst_amount=gst, total_payable=subtotal + gst,
    )
    db.add(b)
    return b


def test_r2_128_bocw_cess_uses_cost_of_construction(client, db, make_tenant, auth_headers):
    comp, user, hdr = _hdr(auth_headers, make_tenant, db, "R2128")
    team = db.query(models.CompanyTeam).filter(models.CompanyTeam.company_id == comp.id).first()
    project = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name="P128",
        code=f"PRJ-128-{_SUFFIX}", status="Ongoing",
    )
    db.add(project)
    db.flush()
    emp = _emp(db, comp, "Site Eng")
    _seed_payroll(db, comp, "2026-07", [(emp, dict(basic=100000))], project_id=project.id)
    _bill(db, comp, team.id, project.id, "PUR-1", "purchase", 5, 3000000)
    _bill(db, comp, team.id, project.id, "SUB-1", "subcon", 20, 2000000, status="Partially Paid")
    _bill(db, comp, team.id, project.id, "SALE-1", "sale", 21, 5000000)                              # revenue, not cost
    _bill(db, comp, team.id, project.id, "PUR-X", "purchase", 22, 9999999, status="Cancelled")       # dead money
    _bill(db, comp, team.id, project.id, "PUR-AUG", "purchase", 3, 7777777, month=8)                 # next period
    db.commit()

    r = client.get(
        f"/apis/v3/statutory/{comp.id}/auto-populate?report_type=bocw&return_period=2026-07&project_id={project.id}",
        headers=hdr,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # Cost base = live purchase+subcon subtotals booked inside the period
    # (30,00,000 + 20,00,000), NOT the 1,00,000 wage bill; revenue, cancelled
    # and out-of-period money stay out.
    assert body["bocw_cess"] == 50000.0, body
    assert body["total_wages"] == 100000.0, body


# ── R2-522: GSTR-1 is built from the outward-supply (sales) ledger ───────────

def test_r2_522_gstr1_built_from_sales_ledger(client, db, make_tenant, auth_headers):
    comp, user, hdr = _hdr(auth_headers, make_tenant, db, "R2522")
    team = db.query(models.CompanyTeam).filter(models.CompanyTeam.company_id == comp.id).first()
    project = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name="P522",
        code=f"PRJ-522-{_SUFFIX}", status="Ongoing",
    )
    db.add(project)
    lp = models.LibraryParty(
        id=uuid.uuid4(), company_id=comp.id, name="Acme Traders",
        tax_no="27AAAAA1234A1Z5", pan_number="AAAAA1234A",
    )
    db.add(lp)
    db.flush()
    team.library_party_id = lp.id
    # A second party with no tax identity on file.
    team2 = models.CompanyTeam(id=uuid.uuid4(), company_id=comp.id)
    db.add(team2)
    db.flush()

    sale_a = models.Bill(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        party_company_user_id=team.id, invoice_number=f"GSTR1-A-{_SUFFIX}",
        invoice_date=datetime(2026, 7, 5), invoice_type="sale",
        status="Unpaid", subtotal=100000, gst_amount=18000, total_payable=118000,
    )
    sale_b = models.Bill(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        party_company_user_id=team2.id, invoice_number=f"GSTR1-B-{_SUFFIX}",
        invoice_date=datetime(2026, 7, 15), invoice_type="material_sale",
        status="Paid", subtotal=10000, gst_amount=500, total_payable=10500,
    )
    noise_purchase = models.Bill(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        party_company_user_id=team.id, invoice_number=f"GSTR1-P-{_SUFFIX}",
        invoice_date=datetime(2026, 7, 20), invoice_type="purchase",
        status="Unpaid", subtotal=888888, gst_amount=0, total_payable=888888,
    )
    cancelled_sale = models.Bill(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        party_company_user_id=team.id, invoice_number=f"GSTR1-C-{_SUFFIX}",
        invoice_date=datetime(2026, 7, 25), invoice_type="sale",
        status="Cancelled", subtotal=777777, gst_amount=70000, total_payable=847777,
    )
    august_sale = models.Bill(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
        party_company_user_id=team.id, invoice_number=f"GSTR1-D-{_SUFFIX}",
        invoice_date=datetime(2026, 8, 3), invoice_type="sale",
        status="Unpaid", subtotal=555555, gst_amount=50000, total_payable=605555,
    )
    db.add_all([sale_a, sale_b, noise_purchase, cancelled_sale, august_sale])
    db.commit()

    r = client.get(f"/apis/v3/statutory/{comp.id}/gstr1?month=7&year=2026", headers=hdr)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "generated", body
    assert body["due_date"] == "2026-08-11", body
    assert body["total_invoices"] == 2, body
    assert body["total_taxable_value"] == 110000.0, body
    assert body["total_gst"] == 18500.0, body
    rec_a, rec_b = body["records"]
    assert rec_a["invoice_number"] == f"GSTR1-A-{_SUFFIX}", body
    assert rec_a["taxable_value"] == 100000.0 and rec_a["gst_amount"] == 18000.0, rec_a
    assert rec_a["cgst"] == 9000.0 and rec_a["sgst"] == 9000.0 and rec_a["igst"] == 0.0, rec_a
    assert rec_a["party_gstin"] == "27AAAAA1234A1Z5", rec_a
    assert rec_b["party_gstin"] is None, rec_b

    # A month without outward supplies reports not_generated instead of wages.
    r = client.get(f"/apis/v3/statutory/{comp.id}/gstr1?month=9&year=2026", headers=hdr)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "not_generated", r.json()
    assert r.json()["records"] == [], r.json()


# ── R2-523: the PF ECR comes from the period's payslips with an EPS split ────

def test_r2_523_pf_ecr_from_period_payslips_with_eps_split(client, db, make_tenant, auth_headers):
    comp, user, hdr = _hdr(auth_headers, make_tenant, db, "R2523")
    e_full = _emp(db, comp, "Full Month", basic_salary=30000)
    e_part = _emp(db, comp, "Part Month", basic_salary=20000)
    _emp(db, comp, "Not Paid In July")   # active in master, no July payslip
    run_jul = _seed_payroll(db, comp, "2026-07", [
        (e_full, dict(days_present=26, days_in_month=26, basic=15000, pf_employee=1800, pf_employer=1800)),
        (e_part, dict(days_present=10, days_in_month=26, basic=6000, pf_employee=720, pf_employer=720)),
    ])
    # August pays only one of them at a different wage - the ECR must differ.
    _seed_payroll(db, comp, "2026-08", [(e_part, dict(days_present=20, days_in_month=26, basic=8000, pf_employee=960, pf_employer=960))])
    db.commit()
    assert run_jul.status == "finalized"

    r = client.get(f"/apis/v3/statutory/{comp.id}/pf-ecr?month=7&year=2026", headers=hdr)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total_employees"] == 2, body
    lines = {row["name"]: row for row in body["ecr_lines"]}
    full = lines["Full Month"]
    assert full["pf_wages"] == 15000.0, full          # cap binds at the ceiling
    assert full["ee_pf_contribution"] == 1800.0, full
    assert full["er_pf_contribution"] == 1800.0, full
    # 8.33% pension split, in whole rupees as the ECR takes them.
    assert full["eps_contribution"] == 1250.0, full
    assert full["epf_contribution"] == 550.0, full    # remainder to EPF
    part = lines["Part Month"]
    assert part["pf_wages"] == 6000.0, part           # earned wages, not master salary
    assert part["eps_contribution"] == 500.0 and part["epf_contribution"] == 220.0, part
    # July PF is paid by 15 August, not 15 July.
    assert body["due_date"] == "2026-08-15", body
    # R2-756: StaffEmployee stores real UAN, and ECR reflects it.
    assert full["uan"] == "100123456789", full
    assert body["total_pf_liability"] == 5040.0, body

    # Months no longer return identical figures.
    r = client.get(f"/apis/v3/statutory/{comp.id}/pf-ecr?month=8&year=2026", headers=hdr)
    assert r.status_code == 200, r.text
    aug = r.json()
    assert aug["total_employees"] == 1, aug
    assert aug["total_ee_pf"] == 960.0, aug

    # No run for the month -> refuse instead of inventing a return.
    r = client.get(f"/apis/v3/statutory/{comp.id}/pf-ecr?month=9&year=2026", headers=hdr)
    assert r.status_code == 409, r.text


# ── R2-524: Form 26Q reports the non-salary TDS actually withheld ────────────

def test_r2_524_26q_from_transaction_deduction_ledger(client, db, make_tenant, auth_headers):
    comp, user, hdr = _hdr(auth_headers, make_tenant, db, "R2524")
    team = db.query(models.CompanyTeam).filter(models.CompanyTeam.company_id == comp.id).first()
    project = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name="P524",
        code=f"PRJ-524-{_SUFFIX}", status="Ongoing",
    )
    db.add(project)
    lp = models.LibraryParty(
        id=uuid.uuid4(), company_id=comp.id, name="Subcon India Pvt Ltd",
        pan_number="ABCDE1234F",
    )
    db.add(lp)
    db.flush()
    team.library_party_id = lp.id
    team2 = models.CompanyTeam(id=uuid.uuid4(), company_id=comp.id)  # no PAN on file
    db.add(team2)
    db.flush()

    def _tds_bill(number, party_id, day, month, subtotal, amount, pct, notes, inv_type="subcon"):
        bill = models.Bill(
            id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
            party_company_user_id=party_id, invoice_number=f"{number}-{_SUFFIX}",
            invoice_date=datetime(2026, month, day), invoice_type=inv_type,
            status="Unpaid", subtotal=subtotal, gst_amount=0, total_payable=subtotal,
        )
        ded = models.TransactionDeduction(
            id=uuid.uuid4(), bill_id=bill.id, deduction_type="TDS",
            amount=amount, percentage=pct, notes=notes,
        )
        db.add_all([bill, ded])

    # The audited scenario: ₹1,900 at 2% under 194C on a subcon RA bill.
    _tds_bill("RA-1", team.id, 10, 7, 95000, 1900, 2.0, "2% TDS (Sec 194C)")
    _tds_bill("PRO-1", team2.id, 5, 9, 50000, 5000, 10.0, "TDS u/s 194J on professional fees")
    _tds_bill("JUN-1", team.id, 20, 6, 100000, 999, 1.0, "TDS Sec 194C")   # Q1, not Q2
    db.commit()

    r = client.get(f"/apis/v3/statutory/{comp.id}/tds-26q?quarter=Q2&year=2026", headers=hdr)
    assert r.status_code == 200, r.text
    body = r.json()
    # The one deduction the old salary-population build could never see is now
    # the headline row: correct section, resolved PAN, real gross and TDS.
    row_c = next(row for row in body["deductee_rows"] if row["tds_section"] == "194C")
    assert row_c["pan"] == "ABCDE1234F", body
    assert row_c["gross_payment"] == 95000.0, row_c
    assert row_c["tds_deducted"] == 1900.0, row_c
    row_j = next(row for row in body["deductee_rows"] if row["tds_section"] == "194J")
    assert row_j["tds_deducted"] == 5000.0, row_j
    assert row_j["pan"] == "NOPANAVAIL", row_j          # flagged, not invented
    assert len(body["deductee_rows"]) == 2, body        # June's 194C stays in Q1
    assert body["total_tds_liability"] == 6900.0, body
    assert body["due_date"] == "2026-10-31", body

    r = client.get(f"/apis/v3/statutory/{comp.id}/tds-26q?quarter=Q1&year=2026", headers=hdr)
    assert r.status_code == 200, r.text
    q1 = r.json()
    assert q1["total_deductees"] == 1, q1
    assert q1["deductee_rows"][0]["tds_section"] == "194C", q1
    assert q1["total_tds_liability"] == 999.0, q1

    # An empty quarter stays a clean zero return; invalid quarter still 422s.
    r = client.get(f"/apis/v3/statutory/{comp.id}/tds-26q?quarter=Q4&year=2026", headers=hdr)
    assert r.status_code == 200, r.text
    assert r.json()["total_deductees"] == 0 and r.json()["total_tds_liability"] == 0.0, r.text
    r = client.get(f"/apis/v3/statutory/{comp.id}/tds-26q?quarter=QX&year=2026", headers=hdr)
    assert r.status_code == 422, r.text



def test_pf_ecr_files_the_pf_the_payslip_deducted(client, db, make_tenant, auth_headers):
    """A company that runs PF on wages above Rs 15,000 deducts 12% of the
    higher wage on the payslip. The return used to refile it on a fixed
    Rs 15,000 ceiling, so it disagreed with the money actually deducted."""
    comp, user, hdr = _hdr(auth_headers, make_tenant, db, "ECRPAY")
    # The company's own PF wage ceiling, set in Settings, is above Rs 15,000.
    comp.pf_wage_ceiling = 25000
    db.commit()
    emp = _emp(db, comp, "Rig Supervisor", basic_salary=20000)
    _seed_payroll(db, comp, "2026-07", [
        (emp, dict(days_present=26, days_in_month=26, basic=20000, pf_employee=2400, pf_employer=2400)),
    ])
    db.commit()
    r = client.get(f"/apis/v3/statutory/{comp.id}/pf-ecr?month=7&year=2026", headers=hdr)
    assert r.status_code == 200, r.text
    line = r.json()["ecr_lines"][0]
    assert line["pf_wages"] == 20000.0
    assert line["ee_pf_contribution"] == 2400.0
    assert line["er_pf_contribution"] == 2400.0
    # Pension stays on the statutory Rs 15,000: 8.33% = 1,249.50, filed as 1,250.
    assert line["eps_contribution"] == 1250.0
    assert line["epf_contribution"] == 1150.0


def test_26q_takes_pan_from_gstin_and_section_from_bill_type(client, db, make_tenant, auth_headers):
    """Every live 26Q row read NOPANAVAIL although each vendor had a GSTIN,
    which carries the PAN, and cement bought at 0.1% and a crane hired at 2%
    were both filed under 194C. Buying goods is 194Q and hiring machinery is
    194I(a); contract work stays 194C."""
    comp, user, hdr = _hdr(auth_headers, make_tenant, db, "26QPAN")
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="P26Q",
                             code=f"PRJ-26Q-{_SUFFIX}", status="Ongoing")
    db.add(project)
    teams = {}
    for key, gstin in (("cement", "27AACCU1234F1ZQ"), ("crane", "27ABCPS5678K1Z2"), ("labour", "27AAFFG9012M1ZK")):
        lp = models.LibraryParty(id=uuid.uuid4(), company_id=comp.id, name=f"{key} {_SUFFIX}", tax_no=gstin)
        db.add(lp)
        db.flush()
        t = models.CompanyTeam(id=uuid.uuid4(), company_id=comp.id, library_party_id=lp.id)
        db.add(t)
        teams[key] = t
    db.flush()
    for key, inv_type, pct in (("cement", "purchase", 0.1), ("crane", "equipment", 2.0), ("labour", "subcon", 2.0)):
        bill = models.Bill(
            id=uuid.uuid4(), company_id=comp.id, project_id=project.id,
            party_company_user_id=teams[key].id, invoice_number=f"{key}-{_SUFFIX}",
            invoice_date=datetime(2026, 8, 10), invoice_type=inv_type,
            status="Unpaid", subtotal=100000, gst_amount=0, total_payable=100000)
        db.add_all([bill, models.TransactionDeduction(
            id=uuid.uuid4(), bill_id=bill.id, deduction_type="TDS",
            amount=100000 * pct / 100, percentage=pct, notes=None)])
    db.commit()

    r = client.get(f"/apis/v3/statutory/{comp.id}/tds-26q?quarter=Q2&year=2026", headers=hdr)
    assert r.status_code == 200, r.text
    rows = {row["invoice_number"].split("-")[0]: row for row in r.json()["deductee_rows"]}
    assert rows["cement"]["pan"] == "AACCU1234F", rows
    assert rows["crane"]["pan"] == "ABCPS5678K", rows
    assert rows["cement"]["tds_section"] == "194Q", rows
    assert rows["crane"]["tds_section"] == "194I(a)", rows
    assert rows["labour"]["tds_section"] == "194C", rows
