import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'gps-verify-jwt-secret-2024';
const DATA_DIR = path.join(__dirname, 'data');
const ADMIN_EMAIL = 'makobajude@gmail.com';

// ── Ensure data dir ──────────────────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const P = {
  users: path.join(DATA_DIR, 'users.json'),
  audits: path.join(DATA_DIR, 'audits.json'),
  sites: path.join(DATA_DIR, 'sites.json'),
};

['users', 'audits'].forEach(k => {
  if (!fs.existsSync(P[k])) fs.writeFileSync(P[k], '[]', 'utf8');
});
if (!fs.existsSync(P.sites)) fs.writeFileSync(P.sites, '[]', 'utf8');

// ── DB helpers ────────────────────────────────────────────────────────────────
function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}
function writeJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

// ── Email validation ──────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(e) { return EMAIL_RE.test(String(e || '').trim().toLowerCase()); }

// ── OTP store (in-memory, 10-min expiry) ─────────────────────────────────────
// Stored in-memory — resets on server restart. On Railway free tier the
// container is ephemeral so this is fine (admins can also reset passwords).
const otpStore = new Map(); // key: email, value: { code, expiresAt }
function generateOTP(email) {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore.set(email.toLowerCase(), { code, expiresAt: Date.now() + 10 * 60 * 1000 });
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
    // Check if user is suspended
    const users = readJSON(P.users);
    const dbUser = users.find(u => u.id === req.user.id);
    if (dbUser && dbUser.suspended) return res.status(403).json({ error: 'Account suspended. Contact admin.' });
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
  const users = readJSON(P.users);

  if (users.find(u => u.email === email))
    return res.status(409).json({ error: 'Email already registered' });

  const hashed = await bcrypt.hash(password, 10);
  // First user OR admin email becomes admin
  const role = (users.length === 0 || email === ADMIN_EMAIL) ? 'admin' : 'user';
  const user = {
    id: uuidv4(),
    email,
    password: hashed,
    role,
    suspended: false,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeJSON(P.users, users);

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Email and password required' });

  const email = username.trim().toLowerCase();
  const users = readJSON(P.users);
  const user = users.find(u => u.email === email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.suspended) return res.status(403).json({ error: 'Account suspended. Contact admin.' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
app.get('/api/auth/me', authenticate, (req, res) => {
  const users = readJSON(P.users);
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ id: user.id, email: user.email, role: user.role, suspended: user.suspended });
});

// ── POST /api/auth/forgot-password ────────────────────────────────────────────
// Generates a 6-digit OTP and returns it in the response.
// In production you'd send this via email — on Railway we show it in the UI
// so an admin can relay it to the user via WhatsApp/phone/SMS.
app.post('/api/auth/forgot-password', (req, res) => {
  const { email } = req.body;
  if (!email || !isValidEmail(email))
    return res.status(400).json({ error: 'Valid email required' });

  const cleanEmail = email.trim().toLowerCase();
  const users = readJSON(P.users);
  if (!users.find(u => u.email === cleanEmail))
    return res.status(404).json({ error: 'No account found with that email' });

  const code = generateOTP(cleanEmail);
  console.log(`[OTP] ${cleanEmail} -> ${code} (expires in 10 min)`);
  res.json({
    ok: true,
    message: `Your 6-digit reset code is: ${code}\nIt expires in 10 minutes. Contact your admin if you did not receive it.`,
    // In a real app: send email. For this deployment, code is returned here.
    code, // frontend will display this to the user
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

  const users = readJSON(P.users);
  const user = users.find(u => u.email === email.trim().toLowerCase());
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.password = await bcrypt.hash(newPassword, 10);
  writeJSON(P.users, users);
  res.json({ ok: true, message: 'Password updated successfully. You can now log in.' });
});

// ── GET /api/admin/users ───────────────────────────────────────────────────────
app.get('/api/admin/users', authenticate, adminOnly, (req, res) => {
  const users = readJSON(P.users);
  res.json(users.map(u => ({
    id: u.id,
    email: u.email,
    role: u.role,
    suspended: u.suspended,
    createdAt: u.createdAt,
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
  const users = readJSON(P.users);
  if (users.find(u => u.email === cleanEmail))
    return res.status(409).json({ error: 'Email already registered' });

  const hashed = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    email: cleanEmail,
    password: hashed,
    role,
    suspended: false,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeJSON(P.users, users);
  res.json({ id: user.id, email: user.email, role: user.role, suspended: user.suspended, createdAt: user.createdAt });
});

// ── DELETE /api/admin/users/:id ───────────────────────────────────────────────
app.delete('/api/admin/users/:id', authenticate, adminOnly, (req, res) => {
  const users = readJSON(P.users);
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  if (users[idx].email === ADMIN_EMAIL)
    return res.status(403).json({ error: 'Cannot delete the primary admin account' });
  users.splice(idx, 1);
  writeJSON(P.users, users);
  res.json({ ok: true });
});

// ── POST /api/admin/users/:id/suspend ─────────────────────────────────────────
app.post('/api/admin/users/:id/suspend', authenticate, adminOnly, (req, res) => {
  const users = readJSON(P.users);
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.email === ADMIN_EMAIL)
    return res.status(403).json({ error: 'Cannot suspend the primary admin account' });
  user.suspended = true;
  writeJSON(P.users, users);
  res.json({ ok: true, suspended: true });
});

// ── POST /api/admin/users/:id/activate ────────────────────────────────────────
app.post('/api/admin/users/:id/activate', authenticate, adminOnly, (req, res) => {
  const users = readJSON(P.users);
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.suspended = false;
  writeJSON(P.users, users);
  res.json({ ok: true, suspended: false });
});

// ── POST /api/admin/users/:id/reset-password ───────────────────────────────────
app.post('/api/admin/users/:id/reset-password', authenticate, adminOnly, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const users = readJSON(P.users);
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.password = await bcrypt.hash(newPassword, 10);
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

// ── Static frontend (production) ───────────────────────────────────────────────
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`GPS Verify API -> http://localhost:${PORT}`);
  const sites = readJSON(P.sites);
  const users = readJSON(P.users);
  console.log(`Sites: ${sites.length} | Users: ${users.length}`);
});
