"""Forgot password, end to end: request a code, set a new password, log in.

Driven in the app on 2026-11-03 before the VCPL rollout. Nothing pinned the
chain in the suite, so this covers each link: the code works once, the old
password and the sessions opened before the reset stop working, and an
unknown email gets the same answer as a known one.
"""
import uuid
from datetime import datetime, timedelta, timezone

from jose import jwt

from app import models, security
from app.config import settings

_SFX = uuid.uuid4().hex[:6]
FORGOT = "/apis/v3/auth/password/forgot"
RESET = "/apis/v3/auth/password/reset"
LOGIN = "/apis/v3/auth/login"
ME = "/apis/v3/auth/me"


def _old_session(user):
    # A session opened two minutes before the reset.
    issued = datetime.now(timezone.utc) - timedelta(minutes=2)
    token = jwt.encode(
        {"sub": str(user.id), "iat": int(issued.timestamp()), "jti": str(uuid.uuid4()),
         "exp": issued + timedelta(hours=1)},
        settings.SECRET_KEY, algorithm=settings.ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


def test_forgot_reset_login_chain(client, db, make_tenant, monkeypatch):
    email = f"reset-{_SFX}@example.com"
    monkeypatch.setattr(settings, "EMAIL_OTP_DEMO_ALLOWLIST", email)
    monkeypatch.setattr(settings, "OTP_DEMO_CODE", "135790")
    _, user, _ = make_tenant(company_name=f"Reset Co {_SFX}", user_name="Asha", email=email)
    user.password_hash = security.hash_password("Old!Passw0rd")
    db.commit()
    old = _old_session(user)
    assert client.get(ME, headers=old).status_code == 200

    unknown = client.post(FORGOT, json={"email": f"nobody-{_SFX}@example.com"})
    sent = client.post(FORGOT, json={"email": email.upper()})
    assert sent.status_code == unknown.status_code == 200
    assert sent.json() == unknown.json()

    wrong = client.post(RESET, json={"email": email, "code": "000000", "new_password": "New!Passw0rd"})
    assert wrong.status_code >= 400

    ok = client.post(RESET, json={"email": email, "code": "135790", "new_password": "New!Passw0rd"})
    assert ok.status_code == 200, ok.text

    again = client.post(RESET, json={"email": email, "code": "135790", "new_password": "Other!Passw0rd"})
    assert again.status_code >= 400, "a reset code must work only once"

    assert client.get(ME, headers=old).status_code == 401, "sessions from before the reset must end"
    assert client.post(LOGIN, json={"email": email, "password": "Old!Passw0rd"}).status_code == 401
    new = client.post(LOGIN, json={"email": email, "password": "New!Passw0rd"})
    assert new.status_code == 200, new.text
    assert client.get(ME, headers={"Authorization": f"Bearer {new.json()['access_token']}"}).status_code == 200

    db.refresh(user)
    assert user.email_verified is True
    assert db.query(models.User).filter(models.User.email == email).count() == 1
