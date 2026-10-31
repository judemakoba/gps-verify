// ── Email delivery for the reset OTP ──────────────────────────────────────────
// The OTP must reach the user by email when a provider is configured, and must
// fall back to the in-UI code (admin relays it) when it cannot.
//
// Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { emailConfig, isEmailConfigured, sendOtpEmail } from './email.js';

const baseEnv = { ...process.env, EMAIL_PROVIDER: 'none' };

test('no provider configured means "keep the code in the response"', () => {
  const cfg = emailConfig(baseEnv);
  assert.equal(cfg.provider, 'none');
  assert.equal(isEmailConfigured(cfg), false);
});

test('resend needs both an api key and a from address', () => {
  assert.equal(isEmailConfigured(emailConfig({ EMAIL_PROVIDER: 'resend' })), false);
  assert.equal(isEmailConfigured(emailConfig({ EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'k' })), false);
  assert.equal(isEmailConfigured(emailConfig({ EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'a@b.c' })), false);
  assert.equal(isEmailConfigured(emailConfig({ EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'k', EMAIL_FROM: 'a@b.c' })), true);
});

test('smtp needs host, from, user and password', () => {
  assert.equal(isEmailConfigured(emailConfig({ EMAIL_PROVIDER: 'smtp' })), false);
  assert.equal(isEmailConfigured(emailConfig({
    EMAIL_PROVIDER: 'smtp', EMAIL_SMTP_HOST: 'smtp.example.com',
    EMAIL_FROM: 'a@b.c', EMAIL_SMTP_USER: 'u', EMAIL_SMTP_PASS: 'p',
  })), true);
});

test('with no provider the code is NOT emailed', async () => {
  const r = await sendOtpEmail({ to: 'x@y.z', code: '123456' }, { env: baseEnv });
  assert.equal(r.delivered, false);
  assert.equal(r.reason, 'not-configured');
});

test('resend sends the code and reports success', async () => {
  let captured = null;
  const fakeFetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, text: async () => '{"id":"abc"}' };
  };
  const r = await sendOtpEmail({ to: 'x@y.z', code: '123456' }, {
    env: { EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'secret-key', EMAIL_FROM: 'no-reply@example.com' },
    fetch: fakeFetch,
  });
  assert.equal(r.delivered, true);
  assert.equal(r.provider, 'resend');
  assert.equal(captured.url, 'https://api.resend.com/emails');
  assert.equal(captured.opts.headers.authorization, 'Bearer secret-key');
  const body = JSON.parse(captured.opts.body);
  assert.deepEqual(body.to, ['x@y.z']);
  assert.equal(body.from, 'no-reply@example.com');
  assert.ok(body.text.includes('123456'), 'the code must be in the email body');
  assert.ok(body.html.includes('123456'), 'the code must be in the html body');
});

test('a resend HTTP error is reported, not thrown', async () => {
  const fakeFetch = async () => ({ ok: false, status: 422, text: async () => 'bad api key' });
  const r = await sendOtpEmail({ to: 'x@y.z', code: '123456' }, {
    env: { EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'bad', EMAIL_FROM: 'a@b.c' },
    fetch: fakeFetch,
  });
  assert.equal(r.delivered, false);
  assert.equal(r.reason, 'http-422');
});

test('a network failure is reported, not thrown', async () => {
  const fakeFetch = async () => { throw new Error('ECONNREFUSED'); };
  const r = await sendOtpEmail({ to: 'x@y.z', code: '123456' }, {
    env: { EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'k', EMAIL_FROM: 'a@b.c' },
    fetch: fakeFetch,
  });
  assert.equal(r.delivered, false);
  assert.equal(r.reason, 'request-failed');
});

test('smtp sends through the injected transport', async () => {
  let sent = null;
  const fakeNodemailer = {
    createTransport: (opts) => ({
      sendMail: async (msg) => { sent = { opts, msg }; },
    }),
  };
  const r = await sendOtpEmail({ to: 'x@y.z', code: '654321' }, {
    env: {
      EMAIL_PROVIDER: 'smtp', EMAIL_SMTP_HOST: 'smtp.example.com', EMAIL_SMTP_PORT: '587',
      EMAIL_SMTP_USER: 'u', EMAIL_SMTP_PASS: 'p', EMAIL_FROM: 'a@b.c',
    },
    nodemailer: fakeNodemailer,
  });
  assert.equal(r.delivered, true);
  assert.equal(r.provider, 'smtp');
  assert.equal(sent.opts.host, 'smtp.example.com');
  assert.equal(sent.opts.port, 587);
  assert.equal(sent.msg.to, 'x@y.z');
  assert.ok(sent.msg.text.includes('654321'));
});

test('an smtp failure degrades instead of throwing', async () => {
  const fakeNodemailer = {
    createTransport: () => ({ sendMail: async () => { throw new Error('auth failed'); } }),
  };
  const r = await sendOtpEmail({ to: 'x@y.z', code: '111111' }, {
    env: {
      EMAIL_PROVIDER: 'smtp', EMAIL_SMTP_HOST: 'h', EMAIL_SMTP_USER: 'u',
      EMAIL_SMTP_PASS: 'p', EMAIL_FROM: 'a@b.c',
    },
    nodemailer: fakeNodemailer,
  });
  assert.equal(r.delivered, false);
  assert.equal(r.reason, 'send-failed');
});
