"""R2-288 — statutory payroll rates are bounded by law and require confirmation.

Gate: PUT /settings/payroll/{cid} must refuse the audit probes (999% PF,
negative employer contribution, 500% ESI employee, negative TDS) and any
value above each statutory ceiling, must reject rate edits without an
explicit confirm_changes=true, and must seed statutory defaults on first read.
"""
import uuid


def _hdr(make_tenant, auth_headers):
    comp, user, _team = make_tenant(company_name="R288", user_name="U288")
    return comp, auth_headers(user, comp)


def test_audit_probes_rejected(client, make_tenant, auth_headers):
    comp, hdr = _hdr(make_tenant, auth_headers)
    for probe in (
        {"pf_employee_pct": 999},
        {"pf_employer_pct": -50},
        {"esi_employee_pct": 500},
        {"tds_monthly": -1000},
        {"confirm_changes": True, "pf_employee_pct": 999},
        {"confirm_changes": True, "pf_employer_pct": -50},
        {"confirm_changes": True, "esi_employee_pct": 500},
        {"confirm_changes": True, "tds_monthly": -1000},
    ):
        r = client.put(f"/apis/v3/settings/payroll/{comp.id}", headers=hdr, json=probe)
        assert r.status_code == 422, f"{probe}: {r.text}"


def test_statutory_ceilings_enforced(client, make_tenant, auth_headers):
    comp, hdr = _hdr(make_tenant, auth_headers)
    for probe in (
        # 12% is the legal minimum, not a cap: voluntary PF goes higher.
        {"pf_employee_pct": 100.01},
        {"pf_employer_pct": 100.01},
        {"esi_employee_pct": 1.01},
        {"esi_employer_pct": 5.01},
    ):
        r = client.put(f"/apis/v3/settings/payroll/{comp.id}", headers=hdr, json={**probe, "confirm_changes": True})
        assert r.status_code == 422, f"{probe}: {r.text}"


def test_rate_change_requires_explicit_confirmation(client, make_tenant, auth_headers):
    comp, hdr = _hdr(make_tenant, auth_headers)
    r = client.put(f"/apis/v3/settings/payroll/{comp.id}", headers=hdr, json={"pf_employee_pct": 12})
    assert r.status_code == 400, r.text
    body = client.get(f"/apis/v3/settings/payroll/{comp.id}", headers=hdr).json()
    assert float(body["pf_employee_pct"]) == 12.0


def test_confirmed_statutory_values_accepted_and_stored(client, db, make_tenant, auth_headers):
    from app import models as _m  # noqa: F401  (models imported so SQLite schema is materialised)

    comp, hdr = _hdr(make_tenant, auth_headers)
    r = client.put(f"/apis/v3/settings/payroll/{comp.id}", headers=hdr, json={
        "pf_employee_pct": 12,
        "pf_employer_pct": 12,
        "esi_employee_pct": 0.75,
        "esi_employer_pct": 3.25,
        "tds_monthly": 1500,
        "is_esi_applicable": False,
        "confirm_changes": True,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert float(body["pf_employee_pct"]) == 12.0
    assert float(body["esi_employee_pct"]) == 0.75
    assert float(body["tds_monthly"]) == 1500.0
    assert body["is_esi_applicable"] is False
    row = (
        db.query(_m.CompanyPayrollSettings)
        .filter(_m.CompanyPayrollSettings.company_id == comp.id)
        .first()
    )
    assert row is not None and float(row.pf_employer_pct) == 12.0


def test_first_read_seeds_statutory_defaults(client, make_tenant, auth_headers):
    comp, hdr = _hdr(make_tenant, auth_headers)
    body = client.get(f"/apis/v3/settings/payroll/{comp.id}", headers=hdr).json()
    assert float(body["pf_employee_pct"]) == 12.0
    assert float(body["pf_employer_pct"]) == 12.0
    assert float(body["esi_employee_pct"]) == 0.75
    assert float(body["esi_employer_pct"]) == 3.25
    assert float(body["tds_monthly"]) == 0.0
