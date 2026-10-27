"""Company Reports: the Report Period arrows and the name search must narrow the export.

Both were drawn in the export dialog but never sent, so every download was the
whole history whatever month was picked.
"""
import datetime
import uuid

from app import models


def _sale(db, comp, team, when, number):
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name=f"Site {number}", status="Ongoing")
    db.add(project)
    db.flush()
    db.add(models.Bill(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, party_company_user_id=team.id,
        invoice_number=number, invoice_date=when, invoice_type="sale", status="Unpaid",
        subtotal=100.0, total_payable=100.0,
    ))
    db.commit()


def test_report_month_keeps_only_that_months_rows(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name=f"Rep Co {uuid.uuid4().hex[:6]}", user_name="Owner")
    hdr = auth_headers(user, comp)
    _sale(db, comp, team, datetime.datetime(2026, 9, 14), "SEP-1")
    _sale(db, comp, team, datetime.datetime(2026, 10, 3), "OCT-1")

    def numbers(extra=""):
        r = client.get(f"/apis/v3/reports/data/company-sales?company_id={comp.id}{extra}", headers=hdr)
        assert r.status_code == 200, r.text
        return sorted(row["Invoice Number"] for row in r.json()["rows"]), r.json().get("period_applied")

    assert numbers() == (["OCT-1", "SEP-1"], None)
    assert numbers("&month=2026-09") == (["SEP-1"], True)
    assert numbers("&month=2026-11") == ([], True)


def test_report_without_a_business_date_says_it_is_all_time(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(company_name=f"Rep Co {uuid.uuid4().hex[:6]}", user_name="Owner")
    db.add(models.StaffEmployee(id=uuid.uuid4(), company_id=comp.id, name="Asha Patil"))
    db.add(models.StaffEmployee(id=uuid.uuid4(), company_id=comp.id, name="Ravi Kumar"))
    db.commit()
    r = client.get(f"/apis/v3/reports/data/staff-salary?company_id={comp.id}&month=2026-09&name=asha",
                   headers=auth_headers(user, comp))
    assert r.status_code == 200, r.text
    body = r.json()
    names = {v for row in body["rows"] for k, v in row.items() if "name" in k.lower()}
    assert "Asha Patil" in names and "Ravi Kumar" not in names, body
    assert body["period_applied"] is not True, body


def test_report_month_must_be_year_dash_month(client, make_tenant, auth_headers):
    comp, user, _team = make_tenant(company_name=f"Rep Co {uuid.uuid4().hex[:6]}", user_name="Owner")
    r = client.get(f"/apis/v3/reports/data/company-sales?company_id={comp.id}&month=Oct%202026",
                   headers=auth_headers(user, comp))
    assert r.status_code == 422, r.text
