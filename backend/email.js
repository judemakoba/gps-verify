// ── Email delivery for the password-reset OTP ────────────────────────────────
// The reset code used to be shown in the UI for an admin to relay. That still
// works, but it means anyone who can see the screen can reset a password, so
// this module delivers the code by email when a provider is configured.
//
// Providers:
//   resend - plain HTTP API (https://api.resend.com/emails), no extra dependency
//   smtp   - any SMTP server, via nodemailer
//   none   - unconfigured: the OTP stays in the API response so an admin can
//            still relay it by phone/WhatsApp
//
// Environment:
//   EMAIL_PROVIDER   none | resend | smtp        (default: none)
//   EMAIL_API_KEY    Resend API key               (resend)
//   EMAIL_FROM       sender address                (resend + smtp)
//   EMAIL_SMTP_HOST  SMTP host                     (smtp)
//   EMAIL_SMTP_PORT  SMTP port                     (smtp, default 587)
//   EMAIL_SMTP_USER  SMTP username                (smtp)
//   EMAIL_SMTP_PASS  SMTP password / app password (smtp)
//   EMAIL_SMTP_SECURE true for implicit TLS        (smtp, default false)

const RESET_SUBJECT = 'GPS Verify — your password reset code';
const RESET_BODY = (code) => `Your GPS Verify password reset code is ${code}.

It expires in 10 minutes. If you did not request this, you can ignore this
email — no account changes have been made.`;

export function emailConfig(env = process.env) {
  const provider = String(env.EMAIL_PROVIDER || 'none').toLowerCase().trim();
  return {
    provider,
    apiKey: env.EMAIL_API_KEY || '',
    from: env.EMAIL_FROM || '',
    smtpHost: env.EMAIL_SMTP_HOST || '',
    smtpPort: Number(env.EMAIL_SMTP_PORT || 587),
    smtpUser: env.EMAIL_SMTP_USER || '',
    smtpPass: env.EMAIL_SMTP_PASS || '',
    smtpSecure: String(env.EMAIL_SMTP_SECURE || 'false').toLowerCase() === 'true',
  };
}

// A provider is only usable when it has the credentials it needs. Anything
// missing means "keep the code in the response" rather than a broken send.
export function isEmailConfigured(cfg = emailConfig()) {
  switch (cfg.provider) {
    case 'resend':
      return !!(cfg.apiKey && cfg.from);
    case 'smtp':
      return !!(cfg.smtpHost && cfg.from && cfg.smtpUser && cfg.smtpPass);
    default:
      return false;
  }
}

function htmlBody(code) {
  return `<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif">
  <p>Your GPS Verify password reset code is:</p>
  <p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:16px 0">${code}</p>
  <p style="color:#555">It expires in 10 minutes. If you did not request this,
  you can ignore this email — no account changes have been made.</p>
</div>`;
}

// deps is injectable so the tests can exercise both providers without a network.
export async function sendOtpEmail({ to, code }, deps = {}) {
  const cfg = deps.config || emailConfig(deps.env || process.env);
  if (!isEmailConfigured(cfg)) {
    return { delivered: false, provider: cfg.provider, reason: 'not-configured' };
  }

  if (cfg.provider === 'resend') {
    const doFetch = deps.fetch || globalThis.fetch;
    try {
      const res = await doFetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${cfg.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: cfg.from,
          to: [to],
          subject: RESET_SUBJECT,
          text: RESET_BODY(code),
          html: htmlBody(code),
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { delivered: false, provider: 'resend', reason: `http-${res.status}`, detail: body.slice(0, 300) };
      }
      return { delivered: true, provider: 'resend' };
    } catch (e) {
      return { delivered: false, provider: 'resend', reason: 'request-failed', detail: String(e.message || e) };
    }
  }

  if (cfg.provider === 'smtp') {
    try {
      // Imported lazily so a missing optional dependency cannot stop the API
      // from starting — it only degrades to the in-UI code.
      const mod = deps.nodemailer || await import('nodemailer');
      const nodemailer = mod.default || mod;
      const transport = nodemailer.createTransport({
        host: cfg.smtpHost,
        port: cfg.smtpPort,
        secure: cfg.smtpSecure,
        auth: { user: cfg.smtpUser, pass: cfg.smtpPass },
      });
      await transport.sendMail({
        from: cfg.from,
        to,
        subject: RESET_SUBJECT,
        text: RESET_BODY(code),
        html: htmlBody(code),
      });
      return { delivered: true, provider: 'smtp' };
    } catch (e) {
      return { delivered: false, provider: 'smtp', reason: 'send-failed', detail: String(e.message || e) };
    }
  }

  return { delivered: false, provider: cfg.provider, reason: 'unsupported-provider' };
}
