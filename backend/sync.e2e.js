// ── End-to-end two-instance sync test ─────────────────────────────────────────
// Boots two real GPS Verify instances on localhost with separate data dirs and
// lets them sync over the sync API, then checks that a user created on one side
// shows up on the other, that suspension propagates, and that a deletion
// propagates as a tombstone (and is not resurrected).
//
// Run with:  node backend/sync.e2e.js

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET = 'e2e-shared-secret';
const A_PORT = 3101, A_SYNC = 3201;
const B_PORT = 3102, B_SYNC = 3202;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gps-sync-e2e-'));
const dirA = path.join(tmp, 'a');
const dirB = path.join(tmp, 'b');
fs.mkdirSync(dirA, { recursive: true });
fs.mkdirSync(dirB, { recursive: true });

const sites = [{ siteId: 'S1', siteName: 'Site One', towercoId: '701403' }];
const users = [{
  id: 'u-admin', email: 'admin@example.com', password: '$2a$10$fake', role: 'admin',
  suspended: false, deleted: false, createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}];
for (const d of [dirA, dirB]) {
  fs.writeFileSync(path.join(d, 'sites.json'), JSON.stringify(sites, null, 2));
  fs.writeFileSync(path.join(d, 'users.json'), JSON.stringify(users, null, 2));
  fs.writeFileSync(path.join(d, 'audits.json'), '[]');
  fs.writeFileSync(path.join(d, 'sitesMeta.json'), JSON.stringify({ updatedAt: '2026-01-01T00:00:00.000Z', count: 1 }));
}

function startInstance(name, port, syncPort, peerSync) {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      SYNC_PORT: String(syncPort),
      SYNC_SECRET: SECRET,
      SYNC_PEER_URL: `http://127.0.0.1:${peerSync}`,
      SYNC_INTERVAL_MS: '1500',
      SYNC_NODE_ID: name,
      DATA_DIR: name === 'A' ? dirA : dirB,
      JWT_SECRET: 'shared-jwt-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[${name}!] ${d}`));
  return child;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, label, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await fn()) return true; } catch { /* retry */ }
    await sleep(400);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

async function api(port, p, opts = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, opts);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

const a = startInstance('A', A_PORT, A_SYNC, B_SYNC);
const b = startInstance('B', B_PORT, B_SYNC, A_SYNC);

try {
  await waitFor(async () => (await api(A_SYNC, '/api/sync/health', { headers: { 'x-sync-secret': SECRET } })).status === 200, 'A sync up');
  await waitFor(async () => (await api(B_SYNC, '/api/sync/health', { headers: { 'x-sync-secret': SECRET } })).status === 200, 'B sync up');
  console.log('\nBoth sync endpoints are up.');

  // The sync API must reject a wrong secret.
  const bad = await api(A_SYNC, '/api/sync/state', { headers: { 'x-sync-secret': 'wrong' } });
  check('sync endpoint rejects a wrong secret', bad.status === 401, `got ${bad.status}`);

  // Admin auth on instance A.
  const tok = await api(A_PORT, '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin@example.com', password: 'x' }),
  });
  check('login route is reachable', tok.status === 401 || tok.status === 200, `got ${tok.status}`);

  // Create a user directly through the store (bcrypt hashing in-process is
  // covered by the unit tests), then let the sync loop carry it.
  const usersA = JSON.parse(fs.readFileSync(path.join(dirA, 'users.json'), 'utf8'));
  usersA.push({
    id: 'u-new', email: 'field@example.com', password: '$2a$10$hash', role: 'user',
    suspended: false, deleted: false, createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
  });
  fs.writeFileSync(path.join(dirA, 'users.json'), JSON.stringify(usersA, null, 2));

  await waitFor(() => {
    const usersB = JSON.parse(fs.readFileSync(path.join(dirB, 'users.json'), 'utf8'));
    return usersB.some(u => u.email === 'field@example.com');
  }, 'new user to reach B');
  check('new user propagated A -> B', true);

  // Suspension on B must reach A.
  const usersB = JSON.parse(fs.readFileSync(path.join(dirB, 'users.json'), 'utf8'));
  const target = usersB.find(u => u.email === 'field@example.com');
  target.suspended = true;
  target.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dirB, 'users.json'), JSON.stringify(usersB, null, 2));

  await waitFor(() => {
    const u = JSON.parse(fs.readFileSync(path.join(dirA, 'users.json'), 'utf8')).find(x => x.email === 'field@example.com');
    return u && u.suspended === true;
  }, 'suspension to reach A');
  check('suspension propagated B -> A', true);

  // Deletion on A must reach B as a tombstone and stay deleted.
  const usersA2 = JSON.parse(fs.readFileSync(path.join(dirA, 'users.json'), 'utf8'));
  const t2 = usersA2.find(u => u.email === 'field@example.com');
  t2.deleted = true;
  t2.deletedAt = new Date().toISOString();
  t2.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dirA, 'users.json'), JSON.stringify(usersA2, null, 2));

  await waitFor(() => {
    const u = JSON.parse(fs.readFileSync(path.join(dirB, 'users.json'), 'utf8')).find(x => x.email === 'field@example.com');
    return u && u.deleted === true;
  }, 'deletion to reach B');
  check('deletion propagated A -> B as tombstone', true);

  await sleep(4000);
  const uA = JSON.parse(fs.readFileSync(path.join(dirA, 'users.json'), 'utf8')).find(x => x.email === 'field@example.com');
  const uB = JSON.parse(fs.readFileSync(path.join(dirB, 'users.json'), 'utf8')).find(x => x.email === 'field@example.com');
  check('tombstone is not resurrected by later syncs', uA.deleted === true && uB.deleted === true);
  check('both sides agree on the tombstone timestamp', uA.updatedAt === uB.updatedAt, `${uA.updatedAt} vs ${uB.updatedAt}`);

  // Audits must union across both instances.
  fs.writeFileSync(path.join(dirA, 'audits.json'), JSON.stringify([
    { id: 'a1', username: 'admin@example.com', action: 'LOOKUP', towercoId: '701403', timestamp: '2026-03-01T00:00:00.000Z' },
  ], null, 2));
  fs.writeFileSync(path.join(dirB, 'audits.json'), JSON.stringify([
    { id: 'b1', username: 'admin@example.com', action: 'AUDIT_CONFIRM', towercoId: '701403', audited: true, timestamp: '2026-03-02T00:00:00.000Z' },
  ], null, 2));

  await waitFor(() => {
    const a1 = JSON.parse(fs.readFileSync(path.join(dirA, 'audits.json'), 'utf8'));
    const b1 = JSON.parse(fs.readFileSync(path.join(dirB, 'audits.json'), 'utf8'));
    return a1.length === 2 && b1.length === 2;
  }, 'audit union on both sides');
  check('audits union across instances', true);

  await sleep(2500);
  const finalA = fs.readFileSync(path.join(dirA, 'users.json'), 'utf8');
  const finalB = fs.readFileSync(path.join(dirB, 'users.json'), 'utf8');
  check('user stores are byte-identical after convergence', finalA === finalB);
  const finalAuditsA = fs.readFileSync(path.join(dirA, 'audits.json'), 'utf8');
  const finalAuditsB = fs.readFileSync(path.join(dirB, 'audits.json'), 'utf8');
  check('audit stores are byte-identical after convergence', finalAuditsA === finalAuditsB);
} catch (e) {
  fail++;
  console.error(`  ERROR ${e.message}`);
} finally {
  a.kill(); b.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
