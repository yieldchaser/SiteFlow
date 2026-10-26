"""R2-181 - there must be a way to add a person to a company.

The audit proved the entire RBAC subsystem governed a tenant that could only
ever have one member: CompanyTeam rows were born solely from the company
creator, the demo allowlist, login-less subcontractors, and the bootstrap
seed - never an invitation. These tests pin the new invite flow end to end:

  POST /auth/team/invite (settings:manage gated) attaches an email to the
  tenant with a chosen company role and a non-partner priority_type, creating
  a passwordless user and emailing a one-time claim code for brand-new
  accounts, or attaching an existing account directly;

  POST /auth/team/invite/accept proves mailbox control via that code, sets
  the password, verifies the email, and mints the session.
"""
import uuid

from app import models
from app.config import settings

INVITE_URL = "/apis/v3/auth/team/invite"
ACCEPT_URL = "/apis/v3/auth/team/invite/accept"
LOGIN_URL = "/apis/v3/auth/login"

STRONG_PASSWORD = "S0ftware!Forge"


def _setup_owner(db, make_tenant, owner_email):
    company, owner, _team = make_tenant(
        company_name=f"Invite Co {uuid.uuid4().hex[:8]}", user_name="Owner", email=owner_email
    )
    role = models.CompanyRole(
        id=uuid.uuid4(),
        company_id=company.id,
        role_name="Site Engineer",
        permissions={"project:view": True},
    )
    db.add(role)
    db.commit()
    return company, owner, role


def test_invite_creates_passwordless_member_with_role(client, db, make_tenant, auth_headers, monkeypatch):
    invitee_email = "new.engineer@example.com"
    monkeypatch.setattr(settings, "EMAIL_OTP_DEMO_ALLOWLIST", invitee_email)
    monkeypatch.setattr(settings, "OTP_DEMO_CODE", "654321")
    company, owner, role = _setup_owner(db, make_tenant, f"owner-{uuid.uuid4().hex[:8]}@example.com")

    r = client.post(
        INVITE_URL,
        headers=auth_headers(owner, company),
        json={"email": invitee_email, "name": "New Engineer", "role_id": str(role.id)},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "invited"
    assert body["mock_code"], body

    invitee = db.query(models.User).filter(models.User.email == invitee_email).first()
    assert invitee is not None
    assert not (invitee.password_hash or "").strip()
    assert invitee.email_verified is False

    membership = (
        db.query(models.CompanyTeam)
        .filter(models.CompanyTeam.company_id == company.id, models.CompanyTeam.user_id == invitee.id)
        .first()
    )
    assert membership is not None
    assert membership.role_id == role.id
    # The whole point of the finding: the second member must NOT be a partner.
    assert membership.priority_type != "partner"
    assert membership.priority_type == "employee"


def test_accept_claims_account_and_logs_into_the_company(client, db, make_tenant, auth_headers, monkeypatch):
    invitee_email = "claim.me@example.com"
    monkeypatch.setattr(settings, "EMAIL_OTP_DEMO_ALLOWLIST", invitee_email)
    monkeypatch.setattr(settings, "OTP_DEMO_CODE", "654321")
    company, owner, role = _setup_owner(db, make_tenant, f"owner-{uuid.uuid4().hex[:8]}@example.com")

    inv = client.post(
        INVITE_URL,
        headers=auth_headers(owner, company),
        json={"email": invitee_email, "name": "Claim Me", "role_id": str(role.id)},
    )
    assert inv.status_code == 200, inv.text
    code = inv.json()["mock_code"]

    wrong = client.post(
        ACCEPT_URL,
        json={"email": invitee_email, "code": "000000", "password": STRONG_PASSWORD},
    )
    assert wrong.status_code == 400, wrong.text

    weak = client.post(
        ACCEPT_URL,
        json={"email": invitee_email, "code": code, "password": "12345678"},
    )
    assert weak.status_code == 400, weak.text

    ok = client.post(
        ACCEPT_URL,
        json={"email": invitee_email, "code": code, "password": STRONG_PASSWORD},
    )
    assert ok.status_code == 200, ok.text
    session = ok.json()
    assert session["access_token"]
    assert session["company"]["id"] == str(company.id)
    assert session["company"]["priority_type"] == "employee"

    invitee = db.query(models.User).filter(models.User.email == invitee_email).first()
    assert (invitee.password_hash or "").strip()
    assert invitee.email_verified is True

    # And the claimed account can log in with its password.
    login = client.post(LOGIN_URL, json={"email": invitee_email, "password": STRONG_PASSWORD})
    assert login.status_code == 200, login.text


def test_duplicate_invite_is_rejected(client, db, make_tenant, auth_headers, monkeypatch):
    """Inviting someone who already signed in is a 409. Inviting someone who
    never claimed their invite sends a fresh code instead (their first one may
    have lapsed), and still adds no second membership."""
    invitee_email = "twice@example.com"
    monkeypatch.setattr(settings, "EMAIL_OTP_DEMO_ALLOWLIST", invitee_email)
    monkeypatch.setattr(settings, "OTP_DEMO_CODE", "654321")
    company, owner, role = _setup_owner(db, make_tenant, f"owner-{uuid.uuid4().hex[:8]}@example.com")
    payload = {"email": invitee_email, "name": "Twice", "role_id": str(role.id)}
    headers = auth_headers(owner, company)

    first = client.post(INVITE_URL, headers=headers, json=payload)
    assert first.status_code == 200, first.text
    second = client.post(INVITE_URL, headers=headers, json=payload)
    assert second.status_code == 200, second.text
    assert second.json()["status"] == "resent"
    assert second.json()["member_id"] == first.json()["member_id"]

    claim = client.post(ACCEPT_URL, json={"email": invitee_email, "code": "654321", "password": STRONG_PASSWORD})
    assert claim.status_code == 200, claim.text
    third = client.post(INVITE_URL, headers=headers, json=payload)
    assert third.status_code == 409, third.text


def test_existing_account_is_attached_without_claim_code(client, db, make_tenant, auth_headers):
    company, owner, role = _setup_owner(db, make_tenant, f"owner-{uuid.uuid4().hex[:8]}@example.com")
    existing_email = f"veteran-{uuid.uuid4().hex[:8]}@elsewhere.com"
    existing = models.User(
        id=uuid.uuid4(),
        name="Already Here",
        email=existing_email,
        password_hash="x",
        email_verified=True,
    )
    db.add(existing)
    db.commit()

    r = client.post(
        INVITE_URL,
        headers=auth_headers(owner, company),
        json={"email": existing_email, "name": "Already Here", "role_id": str(role.id)},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "attached"
    assert "mock_code" not in body

    membership = (
        db.query(models.CompanyTeam)
        .filter(
            models.CompanyTeam.company_id == company.id,
            models.CompanyTeam.user_id == existing.id,
        )
        .first()
    )
    assert membership is not None and membership.role_id == role.id


def test_role_of_another_company_is_rejected(client, db, make_tenant, auth_headers):
    _o_company, _o_owner, foreign_role = _setup_owner(
        db, make_tenant, f"foreign-owner-{uuid.uuid4().hex[:8]}@example.com"
    )
    company, owner, _role = _setup_owner(db, make_tenant, f"owner-{uuid.uuid4().hex[:8]}@example.com")
    r = client.post(
        INVITE_URL,
        headers=auth_headers(owner, company),
        json={
            "email": f"someone-{uuid.uuid4().hex[:8]}@example.com",
            "name": "Someone",
            "role_id": str(foreign_role.id),
        },
    )
    assert r.status_code == 400, r.text


def test_unauthenticated_invite_is_rejected(client, db, make_tenant):
    company, _owner, role = _setup_owner(db, make_tenant, f"owner-{uuid.uuid4().hex[:8]}@example.com")
    r = client.post(
        INVITE_URL,
        json={"email": "anon@example.com", "name": "Anon", "role_id": str(role.id)},
    )
    assert r.status_code in (401, 403), r.text
