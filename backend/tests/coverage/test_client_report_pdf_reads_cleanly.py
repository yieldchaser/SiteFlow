"""The client progress report downloads as a document a client can file:
it names the project, dates itself in IST, and saves under the project and
report name rather than a database id."""
import datetime
import os
import uuid

from app import models
from app.routers.reports import REPORTS_DIR


def test_report_download_names_project_and_file(client, db, make_tenant, auth_headers):
    sfx = uuid.uuid4().hex[:8]
    comp, user, _team = make_tenant(
        company_name=f"RepRead-{sfx}", user_name=f"URepRead-{sfx}",
        mobile="+917" + str(int(sfx, 16))[-8:], email=f"repread-{sfx}@test.com",
    )
    hdr = auth_headers(user, comp)
    code = f"SH-{sfx[:4].upper()}"
    project = models.Project(
        id=uuid.uuid4(), company_id=comp.id, name="Shivalik Heights",
        code=code, status="Ongoing", state="Maharashtra",
    )
    db.add(project)
    report_id = uuid.uuid4()
    path = os.path.join(REPORTS_DIR, f"{report_id}.pdf")
    if os.path.exists(path):
        os.remove(path)
    db.add(models.ClientReport(
        id=report_id, project_id=project.id, report_name="October 2026 Progress",
        report_date=datetime.datetime(2026, 10, 31, 20, 0),  # 1 Nov in IST
        summary_markdown="Slab casting on track.", pdf_url=f"/static/reports/{report_id}.pdf",
        generated_by=user.id, is_approved=False,
    ))
    db.commit()

    res = client.get(f"/apis/v3/reports/{report_id}/download", headers=hdr)
    assert res.status_code == 200, res.text
    disposition = res.headers["content-disposition"]
    assert f"{code}-October 2026 Progress.pdf" in disposition
    assert str(report_id) not in disposition

    body = res.content
    assert f"Project: Shivalik Heights \({code}\)".encode() in body
    assert b"Report Date: 01 Nov 2026" in body
    assert b"IST" in body and b"UTC" not in body
    assert b"Page 1 of 1" in body

    os.remove(path)


def test_payment_reports_say_received_and_paid():
    from app.routers.reports import _payment_direction

    assert _payment_direction("in") == "Received"
    assert _payment_direction("OUT") == "Paid"
    assert _payment_direction(None) == ""
