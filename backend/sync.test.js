// ── Sync merge semantics ──────────────────────────────────────────────────────
// The two GPS Verify instances must converge regardless of who pushes first, how
// often the loop runs, or which side was temporarily offline. These tests pin
// down the properties that guarantee that: commutativity, idempotency and
// monotonicity (no record ever "un-deletes" itself).
//
// Run with:  npm test        (from the repo root or backend/)

import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeUsers, mergeAudits, mergeSites, pickMeta, mergeState } from './sync.js';

const u = (email, updatedAt, extra = {}) => ({ email, updatedAt, ...extra });

// ── Users ─────────────────────────────────────────────────────────────────────
test('mergeUsers keeps the newer record for the same email', () => {
  const local = [u('a@x.com', '2026-01-01T00:00:00.000Z', { role: 'user' })];
  const remote = [u('a@x.com', '2026-02-01T00:00:00.000Z', { role: 'admin' })];
  const merged = mergeUsers(local, remote);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].role, 'admin');
});

test('mergeUsers is commutative', () => {
  const local = [u('a@x.com', '2026-01-01T00:00:00.000Z', { role: 'user' })];
  const remote = [u('a@x.com', '2026-02-01T00:00:00.000Z', { role: 'admin' })];
  assert.deepEqual(
    mergeUsers(local, remote).map(x => x.role),
    mergeUsers(remote, local).map(x => x.role),
  );
});

test('mergeUsers is idempotent', () => {
  const local = [u('a@x.com', '2026-01-01T00:00:00.000Z')];
  const remote = [u('a@x.com', '2026-02-01T00:00:00.000Z')];
  const once = mergeUsers(local, remote);
  const twice = mergeUsers(once, remote);
  assert.deepEqual(once, twice);
});

test('mergeUsers is case-insensitive on the email key', () => {
  const local = [u('a@x.com', '2026-01-01T00:00:00.000Z', { role: 'user' })];
  const remote = [u('A@X.com', '2026-02-01T00:00:00.000Z', { role: 'admin' })];
  const merged = mergeUsers(local, remote);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].role, 'admin');
});

test('a soft delete (tombstone) beats an older live record and is not resurrected', () => {
  const live = u('a@x.com', '2026-01-01T00:00:00.000Z', { deleted: false });
  const tomb = u('a@x.com', '2026-03-01T00:00:00.000Z', { deleted: true, deletedAt: '2026-03-01T00:00:00.000Z' });
  const merged = mergeUsers([live], [tomb]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].deleted, true);
  // Re-syncing the stale live record must not bring the user back.
  const again = mergeUsers(merged, [live]);
  assert.equal(again[0].deleted, true);
});

test('mergeUsers breaks updatedAt ties deterministically', () => {
  const ts = '2026-01-01T00:00:00.000Z';
  const a = u('a@x.com', ts, { role: 'admin' });
  const b = u('a@x.com', ts, { role: 'user' });
  const ab = mergeUsers([a], [b]);
  const ba = mergeUsers([b], [a]);
  assert.deepEqual(ab, ba);
});

// ── Audits ────────────────────────────────────────────────────────────────────
test('mergeAudits unions by id', () => {
  const local = [{ id: '1', action: 'LOOKUP', timestamp: '2026-01-01T00:00:00.000Z' }];
  const remote = [{ id: '2', action: 'AUDIT_CONFIRM', timestamp: '2026-01-02T00:00:00.000Z' }];
  const merged = mergeAudits(local, remote);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map(a => a.id).sort(), ['1', '2']);
});

test('mergeAudits is idempotent and commutative', () => {
  const local = [{ id: '1', action: 'LOOKUP', timestamp: '2026-01-01T00:00:00.000Z' }];
  const remote = [{ id: '2', action: 'LOOKUP', timestamp: '2026-01-02T00:00:00.000Z' }];
  assert.deepEqual(mergeAudits(mergeAudits(local, remote), remote), mergeAudits(local, remote));
  assert.deepEqual(
    mergeAudits(local, remote).map(a => a.id),
    mergeAudits(remote, local).map(a => a.id),
  );
});

// ── Sites ─────────────────────────────────────────────────────────────────────
test('mergeSites picks the whole document with the newer sitesMeta', () => {
  const local = [{ towercoId: '1' }];
  const remote = [{ towercoId: '2' }];
  const r = mergeSites(local, remote, { updatedAt: '2026-01-01T00:00:00.000Z' }, { updatedAt: '2026-02-01T00:00:00.000Z' });
  assert.deepEqual(r.sites, remote);
  assert.equal(r.sitesMeta.updatedAt, '2026-02-01T00:00:00.000Z');
});

test('mergeSites keeps the local document when the local meta is newer', () => {
  const local = [{ towercoId: '1' }];
  const remote = [{ towercoId: '2' }];
  const r = mergeSites(local, remote, { updatedAt: '2026-03-01T00:00:00.000Z' }, { updatedAt: '2026-02-01T00:00:00.000Z' });
  assert.deepEqual(r.sites, local);
});

test('pickMeta prefers the newer timestamp', () => {
  const a = { updatedAt: '2026-01-01T00:00:00.000Z' };
  const b = { updatedAt: '2026-02-01T00:00:00.000Z' };
  assert.equal(pickMeta(a, b).updatedAt, b.updatedAt);
  assert.equal(pickMeta(b, a).updatedAt, b.updatedAt);
});

// ── Whole state ───────────────────────────────────────────────────────────────
test('mergeState is commutative across users, audits and sites', () => {
  const local = {
    nodeId: 'local',
    users: [u('a@x.com', '2026-01-01T00:00:00.000Z', { role: 'user' })],
    audits: [{ id: '1', timestamp: '2026-01-01T00:00:00.000Z' }],
    sites: [{ towercoId: '1' }],
    sitesMeta: { updatedAt: '2026-01-01T00:00:00.000Z' },
  };
  const remote = {
    nodeId: 'remote',
    users: [u('b@x.com', '2026-01-02T00:00:00.000Z', { role: 'user' })],
    audits: [{ id: '2', timestamp: '2026-01-02T00:00:00.000Z' }],
    sites: [{ towercoId: '2' }],
    sitesMeta: { updatedAt: '2026-01-02T00:00:00.000Z' },
  };

  const lr = mergeState(local, remote);
  const rl = mergeState(remote, local);

  assert.equal(lr.users.length, 2);
  assert.equal(lr.audits.length, 2);
  assert.deepEqual(lr.sites, remote.sites);
  assert.deepEqual(lr.users.map(x => x.email).sort(), rl.users.map(x => x.email).sort());
  assert.deepEqual(lr.sites, rl.sites);
});

test('mergeState converges: merging twice does not grow the state', () => {
  const local = {
    nodeId: 'local',
    users: [u('a@x.com', '2026-01-01T00:00:00.000Z')],
    audits: [{ id: '1', timestamp: '2026-01-01T00:00:00.000Z' }],
    sites: [{ towercoId: '1' }],
    sitesMeta: { updatedAt: '2026-01-01T00:00:00.000Z' },
  };
  const remote = {
    nodeId: 'remote',
    users: [u('b@x.com', '2026-01-02T00:00:00.000Z')],
    audits: [{ id: '2', timestamp: '2026-01-02T00:00:00.000Z' }],
    sites: [{ towercoId: '2' }],
    sitesMeta: { updatedAt: '2026-01-02T00:00:00.000Z' },
  };

  const once = mergeState(local, remote);
  const twice = mergeState(once, remote);
  assert.equal(twice.users.length, once.users.length);
  assert.equal(twice.audits.length, once.audits.length);
  assert.deepEqual(twice.sites, once.sites);
});

test('a deletion on one side survives a full round trip through the other side', () => {
  const live = {
    nodeId: 'local',
    users: [u('gone@x.com', '2026-01-01T00:00:00.000Z', { deleted: false })],
    audits: [],
    sites: [],
    sitesMeta: { updatedAt: null },
  };
  const tomb = {
    nodeId: 'remote',
    users: [u('gone@x.com', '2026-06-01T00:00:00.000Z', { deleted: true, deletedAt: '2026-06-01T00:00:00.000Z' })],
    audits: [],
    sites: [],
    sitesMeta: { updatedAt: null },
  };
  const merged = mergeState(live, tomb);
  assert.equal(merged.users.length, 1);
  assert.equal(merged.users[0].deleted, true);
  assert.equal(mergeState(merged, live).users[0].deleted, true);
});
