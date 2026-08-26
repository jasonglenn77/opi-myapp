"""Email sending — provider-agnostic over SMTP, configured entirely via env vars.

Set these on the backend to enable real delivery (any SMTP provider works —
Google Workspace, Microsoft 365, Amazon SES SMTP, etc.):
    SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASSWORD,
    EMAIL_FROM (default = SMTP_USER), EMAIL_FROM_NAME (default "OnPoint Installers"),
    SMTP_STARTTLS ("true"/"false", default true),
    APP_BASE_URL (default https://app.onpointinstallers.com) — used to build links.

When SMTP_HOST is unset (e.g. local dev), emails are NOT sent; instead the full
message + any link is logged to the backend console so flows stay testable.
"""
import os
import smtplib
import logging
from email.message import EmailMessage
from email.utils import formataddr

log = logging.getLogger("mailer")


def app_base_url() -> str:
    return os.getenv("APP_BASE_URL", "https://app.onpointinstallers.com").rstrip("/")


def is_configured() -> bool:
    """True when SMTP is set up and the app will actually send email."""
    return bool(os.getenv("SMTP_HOST", "").strip())


def _cfg():
    user = os.getenv("SMTP_USER", "")
    return {
        "host": os.getenv("SMTP_HOST", "").strip(),
        "port": int(os.getenv("SMTP_PORT", "587")),
        "user": user,
        "password": os.getenv("SMTP_PASSWORD", ""),
        "from_addr": os.getenv("EMAIL_FROM", user) or "no-reply@onpointinstallers.com",
        "from_name": os.getenv("EMAIL_FROM_NAME", "OnPoint Installers"),
        "starttls": os.getenv("SMTP_STARTTLS", "true").lower() != "false",
    }


def send_email(to: str, subject: str, html: str, text: str | None = None) -> bool:
    """Send an email. Returns True if handed to the SMTP server, False if it was
    only logged (unconfigured) or delivery failed. Never raises — callers should
    not fail their request because email is down."""
    cfg = _cfg()
    if not cfg["host"]:
        log.warning("[mailer] SMTP not configured — email logged, not sent (to=%s)", to)
        print(
            "\n===== EMAIL (dev fallback — SMTP not configured, NOT sent) =====\n"
            f"To:      {to}\nSubject: {subject}\n\n{text or html}\n"
            "================================================================\n",
            flush=True,
        )
        return False

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr((cfg["from_name"], cfg["from_addr"]))
    msg["To"] = to
    msg.set_content(text or "Please open this message in an HTML-capable email client.")
    msg.add_alternative(html, subtype="html")

    try:
        with smtplib.SMTP(cfg["host"], cfg["port"], timeout=20) as s:
            if cfg["starttls"]:
                s.starttls()
            if cfg["user"]:
                s.login(cfg["user"], cfg["password"])
            s.send_message(msg)
        log.info("[mailer] sent to %s (%s)", to, subject)
        return True
    except Exception as e:  # noqa: BLE001 — never let email break the request
        log.error("[mailer] failed to send to %s: %s", to, e)
        return False


# --- Templated messages --------------------------------------------------------

def _shell(title: str, body_html: str, cta_text: str, cta_url: str) -> str:
    return f"""\
<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f6f8;padding:28px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e4e8ed;border-radius:14px;overflow:hidden">
    <div style="background:#0b0f14;padding:18px 24px;color:#fff;font-weight:800;font-size:15px">OnPoint Installers <span style="color:#8a94a3;font-weight:500">· Internal Ops Portal</span></div>
    <div style="padding:24px">
      <h1 style="margin:0 0 12px;font-size:19px;color:#1a2230">{title}</h1>
      <div style="font-size:14px;line-height:1.6;color:#5c6775">{body_html}</div>
      <div style="margin:22px 0 8px">
        <a href="{cta_url}" style="display:inline-block;background:#4f7f61;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 20px;border-radius:10px">{cta_text}</a>
      </div>
      <div style="font-size:12px;color:#8a94a3;margin-top:16px">If the button doesn't work, paste this link into your browser:<br><span style="color:#5c6775;word-break:break-all">{cta_url}</span></div>
    </div>
  </div>
</div>"""


def send_invite_email(to: str, link: str, first_name: str | None = None) -> bool:
    hi = f"Hi {first_name}," if first_name else "Hi,"
    body = (f"{hi}<br><br>You've been invited to the OnPoint Installers Internal Ops Portal. "
            "Click below to set your password and sign in. This invite expires in 7 days.")
    text = f"{hi}\n\nYou've been invited to the OnPoint Installers Ops Portal. Set your password here (expires in 7 days):\n{link}\n"
    return send_email(to, "You're invited to the OnPoint Ops Portal", _shell("Set your password", body, "Set my password", link), text)


def send_reset_email(to: str, link: str) -> bool:
    body = ("We received a request to reset your OnPoint Ops Portal password. "
            "Click below to choose a new one. This link expires in 1 hour. "
            "If you didn't request this, you can ignore this email.")
    text = f"Reset your OnPoint Ops Portal password (link expires in 1 hour):\n{link}\n\nIf you didn't request this, ignore this email."
    return send_email(to, "Reset your OnPoint Ops Portal password", _shell("Reset your password", body, "Choose a new password", link), text)
