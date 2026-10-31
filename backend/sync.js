// ── Cross-instance sync primitives ────────────────────────────────────────────
// Two GPS Verify instances (different sites) keep their own JSON stores and
// reconcile them with last-write-wins merges.
//
// Rules:
//   users  - keyed by email (the natural key). Whole-record LWW on `updatedAt`.
//            Deletions are soft (tombstone) so a delete on one site propagates
//            instead of the record resurrecting on the other.
//   audits - append-only, union keyed by id. No conflicts possible.
//   sites  - whole-document LWW using `sitesMeta.updatedAt`, because
//            POST /api/admin/seed replaces the entire set atomically.
//
// Every merge must be commutative, associative and idempotent so that both
// instances converge to the same state no matter who pushes first or how often
// the loop runs.

const USER_KEY = 'email';

function asTime(v) {
  const t = Date.parse(v || '');
  return Number.isNaN(t) ? 0 : t;
}

// Deterministic tie-break: when two records carry the same `updatedAt` we must
// still pick the same winner on BOTH instances, otherwise they diverge.
export function canonical(rec) {
  const o = {};
  for (const k of Object.keys(rec || {}).sort()) o[k] = rec[k];
  return JSON.stringify(o);
}

export function pickWinner(a, b) {
  const ta = asTime(a && a.updatedAt);
  const tb = asTime(b && b.updatedAt);
  if (ta !== tb) return tb > ta ? b : a;
  const ca = canonical(a);
  const cb = canonical(b);
  return cb > ca ? b : a;
}

// ── Users ─────────────────────────────────────────────────────────────────────
// The result is sorted by email so that two instances holding the same set of
// users produce byte-identical files — otherwise a checksum comparison between
// the sites would never match.
export function mergeUsers(local = [], remote = []) {
  const byKey = new Map();
  for (const u of local) {
    if (u && u[USER_KEY]) byKey.set(String(u[USER_KEY]).toLowerCase(), u);
  }
  for (const u of remote) {
    if (!u || !u[USER_KEY]) continue;
    const key = String(u[USER_KEY]).toLowerCase();
    const cur = byKey.get(key);
    byKey.set(key, cur ? pickWinner(cur, u) : u);
  }
  return [...byKey.values()]
    .sort((a, b) => String(a[USER_KEY]).toLowerCase().localeCompare(String(b[USER_KEY]).toLowerCase()));
}

// ── Audits ────────────────────────────────────────────────────────────────────
// Append-only union keyed by id, sorted by (timestamp, id) for the same
// byte-identical-file reason as users.
export function mergeAudits(local = [], remote = []) {
  const byId = new Map();
  for (const a of local) if (a && a.id) byId.set(a.id, a);
  for (const a of remote) {
    if (!a || !a.id) continue;
    const cur = byId.get(a.id);
    if (!cur) { byId.set(a.id, a); continue; }
    const ta = asTime(a.timestamp);
    const tb = asTime(cur.timestamp);
    if (ta !== tb) { byId.set(a.id, ta > tb ? a : cur); continue; }
    if (canonical(a) > canonical(cur)) byId.set(a.id, a);
  }
  return [...byId.values()].sort((a, b) => {
    const ta = asTime(a.timestamp);
    const tb = asTime(b.timestamp);
    if (ta !== tb) return ta - tb;
    return String(a.id).localeCompare(String(b.id));
  });
}

// ── Sites ─────────────────────────────────────────────────────────────────────
// Returns the winning side *and* which side won, so the caller can never
// accidentally pair the sites array of one side with the meta of the other.
function pickMetaWithSource(a = {}, b = {}) {
  const ta = asTime(a && a.updatedAt);
  const tb = asTime(b && b.updatedAt);
  if (ta !== tb) return tb > ta ? { meta: b, source: 'b' } : { meta: a, source: 'a' };
  return canonical(b) > canonical(a) ? { meta: b, source: 'b' } : { meta: a, source: 'a' };
}

export function pickMeta(a = {}, b = {}) {
  return pickMetaWithSource(a, b).meta;
}

export function mergeSites(local = [], remote = [], localMeta = {}, remoteMeta = {}) {
  const { meta, source } = pickMetaWithSource(localMeta, remoteMeta);
  return { sites: source === 'b' ? remote : local, sitesMeta: meta };
}

// ── Whole-state merge ─────────────────────────────────────────────────────────
export function mergeState(local = {}, remote = {}) {
  const { sites, sitesMeta } = mergeSites(
    local.sites || [],
    remote.sites || [],
    local.sitesMeta || {},
    remote.sitesMeta || {},
  );
  return {
    nodeId: local.nodeId || null,
    ts: Date.now(),
    users: mergeUsers(local.users || [], remote.users || []),
    audits: mergeAudits(local.audits || [], remote.audits || []),
    sites,
    sitesMeta,
  };
}
