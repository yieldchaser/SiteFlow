"""Inviting a brand-new email writes the user row before the membership row.

Found live on 2026-11-03: the first invite to a new address emailed the code,
then failed with "company_team violates foreign key constraint
company_team_user_id_fkey". CompanyTeam has no ORM relationship to User, so
the flush was free to insert the membership first. Postgres refuses that;
SQLite tests never enforced it, so this records the INSERT order instead.
"""
import uuid

from sqlalchemy import event

from app import models
from app.config import settings

_SFX = uuid.uuid4().hex[:6]


def test_new_invitee_user_inserted_before_membership(client, db, make_tenant, auth_headers, monkeypatch):
    email = f"neworder-{_SFX}@example.com"
    monkeypatch.setattr(settings, "EMAIL_OTP_DEMO_ALLOWLIST", email)
    monkeypatch.setattr(settings, "OTP_DEMO_CODE", "654321")
    company, owner, _ = make_tenant(company_name=f"Order Co {_SFX}", user_name="Owner",
                                    email=f"owner-{_SFX}@example.com")
    role = models.CompanyRole(id=uuid.uuid4(), company_id=company.id, role_name="Viewer",
                              permissions={"project:view": True})
    db.add(role)
    db.commit()

    order = []

    def _record(mapper, connection, target):
        order.append(mapper.class_.__name__)

    event.listen(models.User, "after_insert", _record)
    event.listen(models.CompanyTeam, "after_insert", _record)
    try:
        inv = client.post("/apis/v3/auth/team/invite", headers=auth_headers(owner, company),
                          json={"email": email, "name": "New Person", "role_id": str(role.id)})
    finally:
        event.remove(models.User, "after_insert", _record)
        event.remove(models.CompanyTeam, "after_insert", _record)

    assert inv.status_code == 200, inv.text
    assert order == ["User", "CompanyTeam"], order
