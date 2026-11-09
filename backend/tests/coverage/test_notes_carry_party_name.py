"""Debit and credit notes say who they are against.

The billing page named parties from the subcontractor list only, so a
note against a supplier read "Unassigned". The list endpoints now return
party_name.
"""
import uuid

from app import models

_TAG = uuid.uuid4().hex[:8]


def test_note_lists_return_party_name(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name=f"NPN-{_TAG}", user_name=f"Supplier {_TAG}",
                                   mobile="+9177" + str(int(_TAG, 16))[-8:], email=f"npn-{_TAG}@test.com")
    hdr = auth_headers(user, comp)
    p = models.Project(id=uuid.uuid4(), company_id=comp.id, name="P", code=f"NPN-{_TAG}", status="Ongoing")
    db.add(p)
    db.commit()
    db.add(models.DebitNote(id=uuid.uuid4(), company_id=comp.id, project_id=p.id, party_company_user_id=team.id,
                            total_amount=100, work_amount=100, gst_amount=0, approval_flag="pending"))
    db.add(models.CreditNote(id=uuid.uuid4(), company_id=comp.id, project_id=p.id, party_company_user_id=team.id,
                             total_amount=50, approval_flag="pending"))
    db.commit()
    for kind in ("debit-notes", "credit-notes"):
        r = client.get(f"/apis/v3/billing/{kind}?project_id={p.id}", headers=hdr)
        assert r.status_code == 200, r.text
        assert r.json()[0]["party_name"] == f"Supplier {_TAG}", r.json()
