"""Company dashboard, Financial tab: picking a project must show that project.

The tab had a Project menu that was not wired to anything, so every number
stayed the company total whatever was picked. The financial summary now takes
an optional project_id and prices only that project.
"""
import datetime
import uuid

from app import models


def _project(db, comp, name):
    p = models.Project(id=uuid.uuid4(), company_id=comp.id, name=name, status="Ongoing")
    db.add(p)
    db.commit()
    return p


def _bill(db, comp, project, team, amount, invoice_type):
    db.add(models.Bill(
        id=uuid.uuid4(), company_id=comp.id, project_id=project.id, party_company_user_id=team.id,
        invoice_number=f"INV-{uuid.uuid4().hex[:10]}", invoice_date=datetime.datetime.now(),
        invoice_type=invoice_type, status="Unpaid", subtotal=amount, total_payable=amount,
    ))
    db.commit()


def test_financial_summary_follows_the_picked_project(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name=f"Fin Co {uuid.uuid4().hex[:6]}", user_name="Owner")
    hdr = auth_headers(user, comp)
    tower = _project(db, comp, "Tower")
    villas = _project(db, comp, "Villas")
    _bill(db, comp, tower, team, 1000.0, "purchase")
    _bill(db, comp, villas, team, 7000.0, "purchase")

    whole = client.get(f"/apis/v3/analytics/company/{comp.id}/financial", headers=hdr).json()
    assert whole["to_pay"] == 8000.0
    assert len(whole["project_summaries"]) == 2

    one = client.get(f"/apis/v3/analytics/company/{comp.id}/financial?project_id={tower.id}", headers=hdr)
    assert one.status_code == 200, one.text
    body = one.json()
    assert body["to_pay"] == 1000.0, body
    assert [p["project_name"] for p in body["project_summaries"]] == ["Tower"]


def test_financial_summary_refuses_another_companys_project(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(company_name=f"Fin Co {uuid.uuid4().hex[:6]}", user_name="Owner")
    other, _u, _t = make_tenant(company_name=f"Other {uuid.uuid4().hex[:6]}", user_name="Other")
    theirs = _project(db, other, "Theirs")
    r = client.get(f"/apis/v3/analytics/company/{comp.id}/financial?project_id={theirs.id}", headers=auth_headers(user, comp))
    assert r.status_code == 404, r.text


def test_operational_charts_follow_the_picked_project(client, db, make_tenant, auth_headers):
    """The Operational tab's 7-day attendance chart stayed all-sites when a
    project was picked."""
    comp, user, _team = make_tenant(company_name=f"Ops Co {uuid.uuid4().hex[:6]}", user_name="Owner")
    hdr = auth_headers(user, comp)
    tower = _project(db, comp, "Tower")
    villas = _project(db, comp, "Villas")
    emp = models.StaffEmployee(id=uuid.uuid4(), company_id=comp.id, name="Ravi")
    db.add(emp)
    db.flush()
    now = datetime.datetime.now(datetime.timezone.utc)
    for project in (tower, villas, villas):
        db.add(models.AttendanceLog(id=uuid.uuid4(), employee_id=emp.id, project_id=project.id,
                                    attendance_date=now, status="Present"))
    db.commit()

    def present(query=""):
        r = client.get(f"/apis/v3/analytics/company/{comp.id}/operational{query}", headers=hdr)
        assert r.status_code == 200, r.text
        return sum(d["present"] for d in r.json()["attendance_series"]), len(r.json()["projects"])

    assert present() == (3, 2)
    # The chart narrows; the project list stays whole for the menu.
    assert present(f"?project_id={tower.id}") == (1, 2)
