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

// ── Middleware ────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

function authenticate(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(h.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ── POST /api/auth/register ───────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username & password required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username ≥ 3 chars' });
  if (password.length < 4) return res.status(400).json({ error: 'Password ≥ 4 chars' });

  const users = readJSON(P.users);
  if (users.find(u => u.username.toLowerCase() === username.toLowerCase()))
    return res.status(409).json({ error: 'Username taken' });

  const hashed = await bcrypt.hash(password, 10);
  const user = { id: uuidv4(), username: username.trim(), password: hashed, role: 'user', createdAt: new Date().toISOString() };
  users.push(user);
  writeJSON(P.users, users);

  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username & password required' });

  const users = readJSON(P.users);
  const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
app.get('/api/auth/me', authenticate, (req, res) => {
  const users = readJSON(P.users);
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ id: user.id, username: user.username, role: user.role });
});

// ── GET /api/sites/lookup/:towercoId ──────────────────────────────────────────
app.get('/api/sites/lookup/:towercoId', authenticate, (req, res) => {
  const id = String(req.params.towercoId).replace(/\.0$/, '').trim();
  const sites = readJSON(P.sites);

  // Fast index lookup
  const matches = sites.filter(s => s.towercoId === id);
  if (!matches.length) return res.status(404).json({ error: `Tower Co ID "${id}" not found in database` });

  // Log lookup
  const audits = readJSON(P.audits);
  audits.push({
    id: uuidv4(), userId: req.user.id, username: req.user.username,
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
    id: uuidv4(), userId: req.user.id, username: req.user.username,
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
  console.log(`GPS Verify API → http://localhost:${PORT}`);
  const sites = readJSON(P.sites);
  console.log(`Sites loaded: ${sites.length}`);
  if (!sites.length) console.warn('⚠ No sites in data/sites.json — run: node seed.js');
});
