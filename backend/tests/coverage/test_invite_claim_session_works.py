"""The session handed out when an invite is claimed actually works.

Found driving the invite on a local stack: claiming stamped tokens_revoked_at
with microseconds, then minted a token whose iat is whole seconds, so the new
token was "issued before the revocation" and the invitee's first request came
back 401. Every invited person was logged out the moment they joined.
"""
import uuid

from app import models
from app.config import settings

_SFX = uuid.uuid4().hex[:6]


def test_claimed_invite_session_is_accepted(client, db, make_tenant, auth_headers, monkeypatch):
    email = f"claim-{_SFX}@example.com"
    monkeypatch.setattr(settings, "EMAIL_OTP_DEMO_ALLOWLIST", email)
    monkeypatch.setattr(settings, "OTP_DEMO_CODE", "654321")
    company, owner, _ = make_tenant(company_name=f"Claim Co {_SFX}", user_name="Owner",
                                    email=f"owner-{_SFX}@example.com")
    role = models.CompanyRole(id=uuid.uuid4(), company_id=company.id, role_name="Site Engineer",
                              permissions={"project:view": True})
    db.add(role)
    db.commit()

    inv = client.post("/apis/v3/auth/team/invite", headers=auth_headers(owner, company),
                      json={"email": email, "name": "Ravi", "role_id": str(role.id)})
    assert inv.status_code == 200, inv.text

    ok = client.post("/apis/v3/auth/team/invite/accept",
                     json={"email": email, "code": inv.json()["mock_code"], "password": "S0ftware!Forge"})
    assert ok.status_code == 200, ok.text

    me = client.get("/apis/v3/auth/me", headers={"Authorization": f"Bearer {ok.json()['access_token']}"})
    assert me.status_code == 200, me.text
