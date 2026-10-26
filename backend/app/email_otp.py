"""Email OTP delivery, on top of the shared app.mailer transport.

Mirrors app/sms.py for the email channel. The OTP code itself is generated,
hashed, TTL-capped and single-use in app/routers/auth.py (the SAME machinery as
SMS); this module only builds the OTP subject/body and hands delivery off to
app.mailer. It never logs the code value.

Delivery transport (Brevo HTTPS API preferred, raw SMTP fallback) lives in
app.mailer: many hosts (including Render's free/starter tiers) block or
silently drop outbound SMTP ports (25/465/587), which raw SMTP hits as an
opaque connection timeout, so the HTTPS API is tried first when configured.

When neither transport is configured, is_configured() returns False and the
auth router restricts email OTP to the demo allowlist (returning 503 for
everyone else) instead of a silent bypass.

Founder note: set BREVO_API_KEY + SMTP_FROM (Brevo API path, recommended), or
SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD/SMTP_FROM (SMTP path) as env vars.
"""
from app.config import settings
from app import mailer


def is_configured() -> bool:
    """True when a delivery transport (Brevo API or SMTP) is wired up."""
    return mailer.is_configured()


def _subject_and_body(code: str) -> tuple[str, str]:
    ttl_min = max(1, settings.OTP_TTL_SECONDS // 60)
    body = (
        f"Your SiteFlow verification code is {code}.\n\n"
        f"It expires in {ttl_min} minute(s). If you did not request this, ignore this email."
    )
    return "Your SiteFlow login code", body


def invite_subject_and_body(code: str, company_name: str, inviter: str, role_name: str, claim_url: str) -> tuple[str, str]:
    """The team-invite email: says who added them, as what, and exactly how to get in."""
    where = (
        f"Open {claim_url} and enter this email address, the code, and a password of your choice."
        if claim_url
        else "Open the SiteFlow sign-in page, choose \"Have an invite code?\", and enter this email address, the code, and a password of your choice."
    )
    body = (
        f"{inviter} has added you to {company_name} on SiteFlow as {role_name}.\n\n"
        f"Your invite code is {code}. It works for 7 days.\n\n"
        f"{where}\n\n"
        "If you were not expecting this, you can ignore this email."
    )
    return f"You have been added to {company_name} on SiteFlow", body


def send_otp_email(email: str, code: str, content: tuple[str, str] | None = None) -> None:
    """Deliver the given code to the email address.

    Delegates transport selection to app.mailer (Brevo API preferred, SMTP
    fallback). Raises RuntimeError on any delivery failure so the caller can
    surface a clean error without leaking transport internals or the code.
    """
    to_addr = (email or "").strip()
    if not to_addr:
        raise RuntimeError("Missing email address")

    subject, body = content or _subject_and_body(code)
    mailer.send_email(to_addr, subject, body)
