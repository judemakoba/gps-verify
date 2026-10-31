import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { mergeState } from './sync.js';
import { sendOtpEmail, isEmailConfigured, emailConfig } from './email.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'gps-verify-jwt-secret-2024';
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const ADMIN_EMAIL = 'makobajude@gmail.com';

// ── Cross-instance sync configuration ─────────────────────────────────────────
// Sync is optional: with no SYNC_SECRET / SYNC_PEER_URL the app behaves exactly
// like a single-instance deployment (Railway, local dev).
const SYNC_PORT = Number(process.env.SYNC_PORT || 3002);
const SYNC_SECRET = process.env.SYNC_SECRET || '';
const SYNC_PEER_URL = (process.env.SYNC_PEER_URL || '').trim();
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS || 60000);
const SYNC_NODE_ID = process.env.SYNC_NODE_ID || `gps-verify-${os.hostname()}`;
const SYNC_DRIVE = String(process.env.SYNC_DRIVE || 'true').toLowerCase() !== 'false';

// ── Ensure data dir ──────────────────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const P = {
  users: path.join(DATA_DIR, 'users.json'),
  audits: path.join(DATA_DIR, 'audits.json'),
  sites: path.join(DATA_DIR, 'sites.json'),
  sitesMeta: path.join(DATA_DIR, 'sitesMeta.json'),
};

['users', 'audits'].forEach(k => {
  if (!fs.existsSync(P[k])) fs.writeFileSync(P[k], '[]', 'utf8');
});
if (!fs.existsSync(P.sites)) fs.writeFileSync(P.sites, '[]', 'utf8');
if (!fs.existsSync(P.sitesMeta)) {
  fs.writeFileSync(P.sitesMeta, JSON.stringify({ updatedAt: null, count: 0 }, null, 2), 'utf8');
}

// ── DB helpers ────────────────────────────────────────────────────────────────
function readJSON(p, fallback = []) {
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    return v == null ? fallback : v;
  } catch { return fallback; }
}

// Atomic write: a half-written JSON file would take the whole instance down
// (readJSON swallows the error and the app silently starts with no data), and
// a torn write during a sync merge would lose records.
function writeJSON(p, data) {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

// Skip the write when the content is unchanged — the sync loop touches these
// files every minute and the sites file is ~600 KB.
function writeJSONIfChanged(p, data) {
  const next = JSON.stringify(data, null, 2);
  try {
    if (fs.readFileSync(p, 'utf8') === next) return false;
  } catch { /* file missing → write it */ }
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, next, 'utf8');
  fs.renameSync(tmp, p);
  return true;
}

function nowIso() { return new Date().toISOString(); }

// ── User record hygiene ───────────────────────────────────────────────────────
// Records created before multi-instance sync have no `updatedAt`. We derive a
// *deterministic* value from `createdAt` — never "now" — so both instances
// normalise the same record to the same timestamp and cannot diverge.
function normalizeUser(u) {
  if (!u || typeof u !== 'object') return u;
  if (!u.updatedAt) u.updatedAt = u.createdAt || '1970-01-01T00:00:00.000Z';
  if (typeof u.deleted !== 'boolean') u.deleted = false;
  return u;
}

function readUsers() {
  const users = readJSON(P.users, []).map(normalizeUser);
  return users;
}

function findUser(users, email) {
  const key = String(email || '').trim().toLowerCase();
  return users.find(u => u.email === key);
}

// ── Email validation ──────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(e) { return EMAIL_RE.test(String(e || '').trim().toLowerCase()); }

// ── OTP store (in-memory, 10-min expiry) ─────────────────────────────────────
// Stored in-memory — resets on server restart. On Railway free tier the
// container is ephemeral so this is fine (admins can also reset passwords).
const otpStore = new Map(); // key: email, value: { code, expiresAt }
const OTP_RESEND_GRACE_MS = 30 * 1000; // re-requesting within 30 s keeps the same code
function generateOTP(email) {
  const key = email.toLowerCase();
  const existing = otpStore.get(key);
  // Do not invalidate a code the user may have just received by email or SMS.
  if (existing && Date.now() < existing.expiresAt && Date.now() - existing.issuedAt < OTP_RESEND_GRACE_MS) {
    return existing.code;
  }
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore.set(key, { code, issuedAt: Date.now(), expiresAt: Date.now() + 10 * 60 * 1000 });
  return code;
}
function verifyOTP(email, code) {
  const entry = otpStore.get(email.toLowerCase());
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) { otpStore.delete(email.toLowerCase()); return false; }
  if (entry.code !== code) return false;
  otpStore.delete(email.toLowerCase());
  return true;
}

// ── Middleware ────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

function authenticate(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    // Check if user is suspended or deleted
    const users = readUsers();
    const dbUser = users.find(u => u.id === req.user.id);
    if (dbUser && dbUser.suspended) return res.status(403).json({ error: 'Account suspended. Contact admin.' });
    if (dbUser && dbUser.deleted) return res.status(401).json({ error: 'Account deleted. Contact admin.' });
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ── POST /api/auth/register ───────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Email and password required' });
  if (!isValidEmail(username)) return res.status(400).json({ error: 'Must be a valid email address' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const email = username.trim().toLowerCase();
  const users = readUsers();

  const existing = findUser(users, email);
  if (existing && !existing.deleted)
    return res.status(409).json({ error: 'Email already registered' });

  const hashed = await bcrypt.hash(password, 10);
  // First user OR admin email becomes admin
  const role = (users.length === 0 || email === ADMIN_EMAIL) ? 'admin' : 'user';
  const user = {
    id: existing ? existing.id : uuidv4(),
    email,
    password: hashed,
    role,
    suspended: false,
    deleted: false,
    createdAt: existing ? existing.createdAt : nowIso(),
    updatedAt: nowIso(),
  };
  if (existing) {
    existing.deleted = false;
    existing.deletedAt = null;
    Object.assign(existing, user);
    writeJSON(P.users, users);
  } else {
    users.push(user);
    writeJSON(P.users, users);
  }

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Email and password required' });

  const email = username.trim().toLowerCase();
  const users = readUsers();
  const user = findUser(users, email);
  if (!user || user.deleted) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.suspended) return res.status(403).json({ error: 'Account suspended. Contact admin.' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
app.get('/api/auth/me', authenticate, (req, res) => {
  const users = readUsers();
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ id: user.id, email: user.email, role: user.role, suspended: user.suspended });
});

// ── POST /api/auth/forgot-password ────────────────────────────────────────────
// Generates a 6-digit OTP and delivers it by email when an email provider is
// configured. Without a provider the code is returned in the response so an
// admin can relay it via WhatsApp/phone/SMS (the original behaviour).
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email || !isValidEmail(email))
    return res.status(400).json({ error: 'Valid email required' });

  const cleanEmail = email.trim().toLowerCase();
  const users = readUsers();
  const user = findUser(users, cleanEmail);
  if (!user || user.deleted)
    return res.status(404).json({ error: 'No account found with that email' });

  const code = generateOTP(cleanEmail);
  console.log(`[OTP] ${cleanEmail} -> ${code} (expires in 10 min)`);

  const delivery = await sendOtpEmail({ to: cleanEmail, code });
  if (delivery.delivered) {
    console.log(`[OTP] emailed via ${delivery.provider} to ${cleanEmail}`);
    return res.json({
      ok: true,
      delivered: true,
      message: `A 6-digit reset code was sent to ${cleanEmail}. It expires in 10 minutes. Check your inbox (and spam folder).`,
    });
  }

  if (delivery.reason !== 'not-configured') {
    console.error(`[OTP] email delivery failed (${delivery.reason}: ${delivery.detail || ''}) — falling back to the in-UI code`);
  }
  res.json({
    ok: true,
    delivered: false,
    message: `Your 6-digit reset code is: ${code}\nIt expires in 10 minutes. Contact your admin if you did not receive it.`,
    // No email provider configured (or the send failed): the frontend shows
    // this so an admin can relay it to the user.
    code,
  });
});

// ── POST /api/auth/reset-password ─────────────────────────────────────────────
app.post('/api/auth/reset-password', async (req, res) => {
  const { email, code, newPassword } = req.body;
  if (!email || !code || !newPassword)
    return res.status(400).json({ error: 'email, code, and newPassword required' });
  if (!isValidEmail(email))
    return res.status(400).json({ error: 'Valid email required' });
  if (newPassword.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!verifyOTP(email.trim().toLowerCase(), code))
    return res.status(400).json({ error: 'Invalid or expired code' });

  const users = readUsers();
  const user = findUser(users, email.trim().toLowerCase());
  if (!user || user.deleted) return res.status(404).json({ error: 'User not found' });

  user.password = await bcrypt.hash(newPassword, 10);
  user.updatedAt = nowIso();
  writeJSON(P.users, users);
  res.json({ ok: true, message: 'Password updated successfully. You can now log in.' });
});

// ── GET /api/admin/users ───────────────────────────────────────────────────────
app.get('/api/admin/users', authenticate, adminOnly, (req, res) => {
  const includeDeleted = String(req.query.includeDeleted || '') === 'true';
  const users = readUsers();
  res.json(users
    .filter(u => includeDeleted || !u.deleted)
    .map(u => ({
      id: u.id,
      email: u.email,
      role: u.role,
      suspended: u.suspended,
      deleted: !!u.deleted,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    })));
});

// ── POST /api/admin/users ─────────────────────────────────────────────────────
app.post('/api/admin/users', authenticate, adminOnly, async (req, res) => {
  const { email, password, role } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email & password required' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Must be a valid email' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 chars' });
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'role must be admin or user' });

  const cleanEmail = email.trim().toLowerCase();
  const users = readUsers();
  const existing = findUser(users, cleanEmail);
  if (existing && !existing.deleted)
    return res.status(409).json({ error: 'Email already registered' });

  const hashed = await bcrypt.hash(password, 10);
  const user = {
    id: existing ? existing.id : uuidv4(),
    email: cleanEmail,
    password: hashed,
    role,
    suspended: false,
    deleted: false,
    createdAt: existing ? existing.createdAt : nowIso(),
    updatedAt: nowIso(),
  };
  if (existing) {
    // Re-creating a previously deleted account revives it instead of creating
    // a duplicate — the tombstone is kept out of the way by overwriting it.
    existing.deletedAt = null;
    Object.assign(existing, user);
  } else {
    users.push(user);
  }
  writeJSON(P.users, users);
  res.json({ id: user.id, email: user.email, role: user.role, suspended: user.suspended, createdAt: user.createdAt });
});

// ── DELETE /api/admin/users/:id ───────────────────────────────────────────────
// Soft delete: the record stays as a tombstone so the deletion can propagate to
// the other instance instead of the user reappearing there on the next sync.
app.delete('/api/admin/users/:id', authenticate, adminOnly, (req, res) => {
  const users = readUsers();
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.email === ADMIN_EMAIL)
    return res.status(403).json({ error: 'Cannot delete the primary admin account' });
  user.deleted = true;
  user.deletedAt = nowIso();
  user.suspended = false;
  user.updatedAt = nowIso();
  writeJSON(P.users, users);
  res.json({ ok: true, deleted: true });
});

// ── POST /api/admin/users/:id/suspend ─────────────────────────────────────────
app.post('/api/admin/users/:id/suspend', authenticate, adminOnly, (req, res) => {
  const users = readUsers();
  const user = users.find(u => u.id === req.params.id);
  if (!user || user.deleted) return res.status(404).json({ error: 'User not found' });
  if (user.email === ADMIN_EMAIL)
    return res.status(403).json({ error: 'Cannot suspend the primary admin account' });
  user.suspended = true;
  user.updatedAt = nowIso();
  writeJSON(P.users, users);
  res.json({ ok: true, suspended: true });
});

// ── POST /api/admin/users/:id/activate ────────────────────────────────────────
app.post('/api/admin/users/:id/activate', authenticate, adminOnly, (req, res) => {
  const users = readUsers();
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.suspended = false;
  user.updatedAt = nowIso();
  writeJSON(P.users, users);
  res.json({ ok: true, suspended: false });
});

// ── POST /api/admin/users/:id/reset-password ───────────────────────────────────
app.post('/api/admin/users/:id/reset-password', authenticate, adminOnly, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const users = readUsers();
  const user = users.find(u => u.id === req.params.id);
  if (!user || user.deleted) return res.status(404).json({ error: 'User not found' });

  user.password = await bcrypt.hash(newPassword, 10);
  user.updatedAt = nowIso();
  writeJSON(P.users, users);
  res.json({ ok: true, message: 'Password updated successfully.' });
});

// ── POST /api/admin/seed ──────────────────────────────────────────────────────
app.post('/api/admin/seed', authenticate, adminOnly, (req, res) => {
  const { sites } = req.body;
  if (!Array.isArray(sites)) return res.status(400).json({ error: 'sites must be an array' });
  const cleaned = sites.map(s => ({
    siteId: String(s.siteId || '').trim(),
    siteName: String(s.siteName || '').trim(),
    towercoId: String(s.towercoId || '').replace(/\.0$/, '').trim(),
  })).filter(s => s.towercoId);
  writeJSON(P.sites, cleaned);
  // The site set is replaced as a whole, so the whole document is the unit of
  // sync — the meta timestamp decides which instance's set wins.
  writeJSON(P.sitesMeta, { updatedAt: nowIso(), count: cleaned.length });
  res.json({ ok: true, count: cleaned.length });
});

// ── GET /api/sites/count ──────────────────────────────────────────────────────
app.get('/api/sites/count', (req, res) => {
  const sites = readJSON(P.sites);
  res.json({ count: sites.length });
});

// ── GET /api/sites/lookup/:towercoId ──────────────────────────────────────────
app.get('/api/sites/lookup/:towercoId', authenticate, (req, res) => {
  const id = String(req.params.towercoId).replace(/\.0$/, '').trim();
  const sites = readJSON(P.sites);
  const matches = sites.filter(s => s.towercoId === id);
  if (!matches.length) return res.status(404).json({ error: `Tower Co ID "${id}" not found in database` });

  const audits = readJSON(P.audits);
  audits.push({
    id: uuidv4(), userId: req.user.id, username: req.user.email,
    action: 'LOOKUP', towercoId: id, result: matches.length,
    timestamp: new Date().toISOString(),
  });
  writeJSON(P.audits, audits);
  res.json({ towercoId: id, results: matches });
});

// ── POST /api/audits/confirm ───────────────────────────────────────────────────
app.post('/api/audits/confirm', authenticate, (req, res) => {
  const { towercoId, siteId, siteName, audited } = req.body;
  if (typeof audited !== 'boolean') return res.status(400).json({ error: 'audited must be true/false' });
  if (!towercoId) return res.status(400).json({ error: 'towercoId required' });

  const audits = readJSON(P.audits);
  const record = {
    id: uuidv4(), userId: req.user.id, username: req.user.email,
    action: 'AUDIT_CONFIRM', towercoId: String(towercoId).trim(),
    siteId: siteId || '', siteName: siteName || '', audited,
    timestamp: new Date().toISOString(),
  };
  audits.push(record);
  writeJSON(P.audits, audits);
  res.json({ ok: true, record });
});

// ── GET /api/audits ────────────────────────────────────────────────────────────
app.get('/api/audits', authenticate, (req, res) => {
  const audits = readJSON(P.audits);
  if (req.user.role === 'admin') return res.json(audits);
  res.json(audits.filter(a => a.userId === req.user.id));
});

// ── GET /api/audits/export ─────────────────────────────────────────────────────
app.get('/api/audits/export', authenticate, adminOnly, (req, res) => {
  const audits = readJSON(P.audits);
  const header = 'ID,Username,Action,TowerCo_ID,Site_ID,Site_Name,Audited,Timestamp\n';
  const rows = audits.map(a =>
    [a.id, a.username, a.action, a.towercoId || '', a.siteId || '', a.siteName || '',
      a.audited ? 'YES' : 'NO', a.timestamp].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
  ).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(header + rows);
});

// ═════════════════════════════════════════════════════════════════════════════
// Cross-instance sync
// ═════════════════════════════════════════════════════════════════════════════
// The sync surface lives on its own port (default 3002) and is NOT proxied by
// Caddy / Tailscale Funnel — it carries password hashes, so it must only ever
// be reachable over the tailnet or LAN.

function buildState() {
  return {
    nodeId: SYNC_NODE_ID,
    ts: Date.now(),
    users: readUsers(),
    audits: readJSON(P.audits, []),
    sites: readJSON(P.sites, []),
    sitesMeta: readJSON(P.sitesMeta, { updatedAt: null, count: 0 }),
  };
}

function persistState(state) {
  const users = (state.users || []).map(normalizeUser);
  return {
    users: writeJSONIfChanged(P.users, users),
    audits: writeJSONIfChanged(P.audits, state.audits || []),
    sites: writeJSONIfChanged(P.sites, state.sites || []),
    sitesMeta: writeJSONIfChanged(P.sitesMeta, state.sitesMeta || { updatedAt: null, count: 0 }),
  };
}

function secretOk(provided) {
  if (!SYNC_SECRET) return false;
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(SYNC_SECRET, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const syncApp = express();
syncApp.use(express.json({ limit: '64mb' }));
syncApp.use((req, res, next) => {
  if (!SYNC_SECRET) return res.status(503).json({ error: 'Sync disabled (SYNC_SECRET not set)' });
  if (!secretOk(req.headers['x-sync-secret']))
    return res.status(401).json({ error: 'Unauthorized' });
  next();
});

syncApp.get('/api/sync/state', (req, res) => {
  res.json(buildState());
});

syncApp.post('/api/sync/merge', (req, res) => {
  const peer = req.body || {};
  const merged = mergeState(buildState(), peer);
  persistState(merged);
  res.json(merged);
});

syncApp.get('/api/sync/health', (req, res) => {
  const s = buildState();
  res.json({
    ok: true,
    nodeId: s.nodeId,
    users: s.users.length,
    audits: s.audits.length,
    sites: s.sites.length,
    peer: SYNC_PEER_URL || null,
    drive: SYNC_DRIVE,
  });
});

// ── Sync driver ───────────────────────────────────────────────────────────────
// One side drives the loop (the instance that can actually reach the peer over
// the tailnet). It pulls the peer state, merges locally, pushes the merged
// state back, and merges the peer's reply again — so both sides converge even
// if one of them is temporarily offline.
let syncTimer = null;
let syncBusy = false;
let syncLast = { ok: null, at: null, error: null };

async function runSyncOnce() {
  if (!SYNC_SECRET || !SYNC_PEER_URL) return null;
  if (syncBusy) return null;
  syncBusy = true;
  const base = SYNC_PEER_URL.replace(/\/+$/, '');
  const headers = { 'x-sync-secret': SYNC_SECRET, 'content-type': 'application/json' };
  try {
    const r1 = await fetch(`${base}/api/sync/state`, { headers, signal: AbortSignal.timeout(30000) });
    if (!r1.ok) throw new Error(`peer state ${r1.status}`);
    const peerState = await r1.json();

    const merged = mergeState(buildState(), peerState);
    persistState(merged);

    const r2 = await fetch(`${base}/api/sync/merge`, {
      method: 'POST', headers, signal: AbortSignal.timeout(60000),
      body: JSON.stringify(merged),
    });
    if (!r2.ok) throw new Error(`peer merge ${r2.status}`);
    const back = await r2.json();

    const merged2 = mergeState(buildState(), back);
    persistState(merged2);

    syncLast = { ok: true, at: new Date().toISOString(), error: null };
    console.log(`[sync] merged with peer ${peerState.nodeId || 'unknown'} - users:${merged2.users.length} audits:${merged2.audits.length} sites:${merged2.sites.length}`);
    return merged2;
  } catch (e) {
    syncLast = { ok: false, at: new Date().toISOString(), error: String(e.message || e) };
    console.error(`[sync] failed: ${syncLast.error}`);
    return null;
  } finally {
    syncBusy = false;
  }
}

function startSync() {
  if (!SYNC_SECRET) {
    console.log('[sync] disabled (no SYNC_SECRET)');
    return;
  }
  if (!SYNC_PEER_URL) {
    console.log('[sync] serving only (no SYNC_PEER_URL) - peer must drive');
  } else if (!SYNC_DRIVE) {
    console.log('[sync] SYNC_DRIVE=false - serving only, peer drives');
  } else {
    console.log(`[sync] driving peer ${SYNC_PEER_URL} every ${SYNC_INTERVAL_MS}ms`);
    setTimeout(() => {
      runSyncOnce();
      syncTimer = setInterval(runSyncOnce, SYNC_INTERVAL_MS);
      if (syncTimer && typeof syncTimer.unref === 'function') syncTimer.unref();
    }, 10000);
  }
}

// ── Static frontend (production) ─────────────────────────────────────────────
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath, {
    setHeaders(res, filePath) {
      // The service worker must never be cached, or clients would keep
      // running an outdated shell and never pick up app updates.
      if (filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));
  app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
}

app.listen(PORT, () => {
  const sites = readJSON(P.sites);
  const users = readUsers();
  console.log(`GPS Verify API -> http://localhost:${PORT}`);
  console.log(`Sites: ${sites.length} | Users: ${users.length}`);
  console.log(`Node: ${SYNC_NODE_ID}`);
  // Normalise legacy user records once so both instances derive the same
  // `updatedAt` for the same record (deterministic - never "now").
  writeJSONIfChanged(P.users, users);
  startSync();
});

if (SYNC_SECRET) {
  syncApp.listen(SYNC_PORT, () => {
    console.log(`GPS Verify sync API -> http://localhost:${SYNC_PORT} (secret protected)`);
  });
}
