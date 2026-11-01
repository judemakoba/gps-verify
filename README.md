# GPS Verify — Tower Site Audit Tool

**What it does:** Field technicians enter a Tower Co ID → the app shows the Site ID and Site Name in large bold text → they tap **"Audited"** or **"Not Audited"** → every action is logged with username and timestamp.

**Live URL:** https://gps-verify.tailfd1512.ts.net

---

## Default Login

| Username (email) | Password | Role |
|---|---|---|
| `makobajude@gmail.com` | *rotated on deploy — not stored in the repo* | admin (primary, protected) |

> ⚠️ The seeded password was `admin123`, which was public in the git history, so it was rotated the moment the instance went live. The current password is held only by the administrator. The primary admin account can never be deleted or suspended by another admin — that protection is enforced server-side.

---

## Features

| Feature | Description |
|---|---|
| **Email usernames** | Usernames are validated email addresses; min password length 6 |
| **JWT auth** | 30-day tokens; passwords hashed with bcrypt |
| **Site lookup** | Enter Tower Co ID → big bold Site ID + Site Name shown |
| **Audit confirm** | Per-site "Audited ✓" / "Not Audited ✗" buttons |
| **Audit log** | Every user sees their own history; admins see all users |
| **CSV export** | Admins download the full audit log as a `.csv` file |
| **Admin user CRUD** | Add, delete, suspend/reactivate users; reset any user's password |
| **Password resets** | Admin-driven: the administrator resets a user's password from the admin panel; the user signs in with the new one |
| **PWA** | Installable on Android; app shell works offline after first load |

### Offline behaviour

The service worker caches the app shell (HTML, CSS, icons) so the app opens and shows the login screen with no connection. **API calls are never cached** — an audit confirmation must always reach the server to be recorded. Bootstrap CSS and icons are vendored under `frontend/vendor/` rather than loaded from a CDN, so the UI renders correctly at tower sites with weak or no data signal.

---

## Project Structure

```
gps-verify/
├── backend/
│   ├── server.js          # Express API (auth, lookup, audit, export)
│   ├── package.json
│   ├── data/
│   │   ├── sites.json     # 2,965 tower sites (committed to the repo)
│   │   ├── users.json     # User accounts (bcrypt hashes)
│   │   └── audits.json    # Audit log (runtime, git-ignored)
│   └── dist/              # Served frontend (built from frontend/ by tools/build.js)
├── frontend/
│   ├── index.html         # Self-contained PWA UI
│   ├── manifest.json      # PWA manifest
│   ├── sw.js              # Service worker (offline app shell)
│   ├── icon-*.png         # Real PNG app icons (192/512/maskable)
│   └── vendor/            # Bootstrap 5.3.3 + Bootstrap Icons 1.11.3 (local, no CDN)
└── tools/
    ├── build.js           # Syncs frontend/ → backend/dist/
    └── make_icons.py      # Regenerates the PNG app icons (Python + Pillow)
```

---

## Local Development

```bash
# 1. install backend deps
cd backend && npm install

# 2. regenerate icons (only needed if you change the design)
cd .. && python tools/make_icons.py

# 3. sync frontend → backend/dist (the folder Express serves)
node tools/build.js

# 4. run
cd backend && npm start
```

Open **http://localhost:3001**.

> `backend/data/sites.json` (2,965 records) is committed to the repo, so there is no seeding step. `backend/data/audits.json` is created automatically on first run.

---

## Production Deployment — Proxmox LXC 205 + Tailscale Funnel

The live instance runs in **LXC 205** (`gps-verify`) on the Proxmox host, exposed publicly through a **Tailscale Funnel**.

| Component | Value |
|---|---|
| LXC VMID | `205`, hostname `gps-verify` |
| LXC IP | `192.168.1.205/24` (LAN) |
| Tailscale IP | `100.126.59.49` |
| Public URL | `https://gps-verify.tailfd1512.ts.net` |
| App directory | `/opt/gps-verify` |
| Persistent data | `/var/lib/gps-verify/data` (symlinked to `backend/data`) |
| Node port | `3001` |
| Caddy port | `80` (proxies to `127.0.0.1:3001`) |

### systemd units

| Unit | Purpose |
|---|---|
| `gps-verify.service` | Runs the Express API on port 3001 |
| `gps-caddy.service` | Caddy reverse proxy, port 80 → 3001 |
| `tailscaled.service` | Tailscale daemon (userspace networking) |
| `tailscale-funnel.service` | Applies `tailscale funnel --bg 80` on boot (waits for tailscaled to be *Running*) |
| `tailscale-funnel-watchdog.timer` | Every 5 min, re-establishes the Funnel if it dropped |

> **Why the funnel unit waits:** systemd's `After=tailscaled.service` only orders the *start* of the tailscaled unit — it does not wait for tailscaled to reach the `Running` backend state. Running `tailscale funnel` too early fails with `unexpected state: NoState`, which takes the public URL offline after a reboot. `deploy/tailscale-funnel-setup.sh` polls `tailscale status --json` until the state is `Running`, then applies and verifies the Funnel. The watchdog timer covers the case where tailscaled restarts on its own.

### Redeploying

```bash
# inside LXC 205
gps-verify-redeploy
```

This pulls `origin/master`, reinstalls backend deps, and restarts the app **without touching live data** — `backend/data` is a symlink to `/var/lib/gps-verify/data`, and the git worktree is protected with `--skip-worktree` so a `git reset` can never overwrite live `users.json` / `audits.json`.

### Checking status

```bash
systemctl status gps-verify gps-caddy tailscaled tailscale-funnel
tailscale funnel status
curl -s https://gps-verify.tailfd1512.ts.net/api/sites/count
```

### Deploy scripts

`deploy/` contains the scripts installed on LXC 205:

| File | Purpose |
|---|---|
| `tailscale-funnel-setup.sh` | Waits for tailscaled, then applies + verifies the Funnel |
| `tailscale-funnel-watchdog.sh` | Re-establishes the Funnel if it is not active |

---

## API Reference

| Method | Route | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/register` | — | Create an account |
| POST | `/api/auth/login` | — | `{ username, password }` → `{ token, user }` |
| GET | `/api/auth/me` | bearer | Current user profile |
| GET | `/api/admin/users` | admin | List users |
| POST | `/api/admin/users` | admin | `{ email, password, role }` — role is `admin` or `user` |
| DELETE | `/api/admin/users/:id` | admin | Delete a user (primary admin protected) |
| POST | `/api/admin/users/:id/suspend` | admin | Suspend a user (primary admin protected) |
| POST | `/api/admin/users/:id/activate` | admin | Reactivate a user |
| POST | `/api/admin/users/:id/reset-password` | admin | Reset any user's password |
| GET | `/api/sites/count` | — | Number of sites in the database |
| GET | `/api/sites/lookup/:towercoId` | bearer | Site ID + Site Name for a Tower Co ID |
| POST | `/api/audits/confirm` | bearer | `{ towercoId, siteId, siteName, audited }` |
| GET | `/api/audits` | bearer | Own audit log (admins see all) |
| GET | `/api/audits/export` | admin | CSV download of the audit log |

> Login uses the field name **`username`** (the email address). The admin user-creation endpoint requires an explicit **`role`** of `admin` or `user`.

---

## User Management

- **Admin** — sees all users' audit logs, can export CSV, manage users
- **User** — sees only their own audit log entries

Users are managed from the admin panel in the app, or via the `/api/admin/users*` endpoints. The primary admin (`makobajude@gmail.com`) cannot be deleted or suspended.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Tower Co ID not found" | Confirm the ID exists in `backend/data/sites.json` (2,965 records) |
| Login keeps failing | Check `backend/data/users.json`; the primary admin is seeded from the repo |
| Public URL returns 404 | `systemctl status tailscale-funnel` and `tailscale funnel status` |
| App serves an old UI | Run `node tools/build.js` locally, commit `backend/dist/`, then redeploy |
| Icons missing in the install prompt | Run `python tools/make_icons.py` then `node tools/build.js` |
| Local `node_modules` errors | `cd backend && rm -rf node_modules && npm install` |

---

## Two-Site Deployment & Cross-Instance Sync

The same repository runs on **two separate Proxmox hosts** (physically different
locations, both LANs using `192.168.1.0/24` — so inter-site traffic must always
use Tailscale `100.x` addresses).

| | Site 1 | Site 2 |
|---|---|---|
| Proxmox host | `192.168.1.68` (no Tailscale on the host) | `192.168.1.200` / `100.74.36.100` |
| LXC | `205` — `gps-verify` | `206` — `gps-verify-2` |
| LAN address | `192.168.1.205` | `192.168.1.206` |
| Tailscale IP | `100.126.59.49` | `100.100.206.69` |
| Public URL | `https://gps-verify.tailfd1512.ts.net` | `https://gps-verify-2.tailfd1512.ts.net` |
| tailscaled mode | kernel TUN | kernel TUN |
| Sync role | drives the peer every 60 s | drives the peer every 60 s |

Both instances drive the sync loop, so either site keeps the other up to date
even if one of them goes offline. The merges are idempotent, so two drivers
never fight each other.

> **Why kernel TUN matters.** In `tailscaled --tun=userspace-networking` mode a
> node has no `tailscale0` interface and **cannot originate** L3 tailnet
> traffic — plain sockets to `100.x` fail with "No route to host". Both
> containers now run in kernel mode (privileged CT + `/dev/net/tun`), so each
> can reach the other directly. Converting a container means: drop
> `--tun=userspace-networking` from the `tailscaled` unit, restart it, then
> re-apply the funnel with `/usr/local/sbin/tailscale-funnel-setup` (it waits
> for `BackendState == "Running"` first). The public URL is down for about a
> minute during that switch.

### How sync works

Both instances keep their own JSON stores and reconcile them with
last-write-wins merges (`backend/sync.js`):

| Data | Rule |
|---|---|
| users | keyed by email, whole-record LWW on `updatedAt`. A delete is a **soft delete** (tombstone) so it propagates and the account is not resurrected. |
| audits | append-only union keyed by `id` — no conflicts possible. |
| sites | whole-document LWW on `sitesMeta.updatedAt` (the seed replaces the whole set atomically). |

Every merge is commutative, associative and idempotent, so the two sites
converge no matter who pushes first or how often the loop runs. Both sides
normalise legacy records to the *same* deterministic `updatedAt` (derived from
`createdAt`, never "now"), so they cannot disagree.

The sync API listens on its **own port (3002)** and is **not** proxied by Caddy
or Tailscale Funnel — it carries password hashes, so it must only ever be
reachable over the tailnet or the LAN. Every request must carry the
`x-sync-secret` header (compared in constant time).

### Sync API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/sync/state` | `x-sync-secret` | Full local state (users, audits, sites, sitesMeta) |
| POST | `/api/sync/merge` | `x-sync-secret` | Merge a peer state into the local store, returns the merged state |
| GET | `/api/sync/health` | `x-sync-secret` | Node id, record counts, peer URL, drive flag |

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3001` | Public API port (behind Caddy / Funnel) |
| `JWT_SECRET` | dev fallback | **Set the same value on both instances** so a session works on either site |
| `SYNC_PORT` | `3002` | Sync API port (never exposed publicly) |
| `SYNC_SECRET` | *(unset)* | Shared secret. When unset, sync is disabled entirely — single-instance deployments are unaffected |
| `SYNC_PEER_URL` | *(unset)* | Base URL of the peer, e.g. `http://100.126.59.49:3002` |
| `SYNC_INTERVAL_MS` | `60000` | Sync loop interval |
| `SYNC_NODE_ID` | `gps-verify-<hostname>` | Human-readable node id |
| `SYNC_DRIVE` | `true` | Whether this instance drives the loop |

Only one instance needs to drive the loop: it pulls the peer state, merges
locally, pushes the merged state back and merges the reply again, so both sides
converge even if one is temporarily offline.

```bash
# Site 2 drives (it can reach the site-1 tailnet IP)
SYNC_SECRET=...  SYNC_PEER_URL=http://100.126.59.49:3002  SYNC_NODE_ID=gps-verify-2
# Site 1 only serves
SYNC_SECRET=...  SYNC_PEER_URL=                        SYNC_NODE_ID=gps-verify
```

### Tests

```bash
npm test           # merge semantics (commutativity, idempotency, tombstones)
node sync.e2e.js   # boots two real instances and checks convergence
```

---

## Password Reset

There is no self-service password reset. A user who forgets their password
contacts the administrator, who resets it from the admin panel:

1. Admin panel → **Users** → **Reset Pass** next to the account.
2. The admin types the new password (min 6 characters); it is hashed with
   bcrypt and saved immediately.
3. The user signs in with the new password.

The change syncs to the other site on the next sync cycle (≤ 60 s).

The login screen tells users to ask their administrator, and no reset code is
ever issued or emailed.

### Redeploying

```bash
bash deploy/redeploy.sh     # or the installed /usr/local/sbin/gps-verify-redeploy
```

The runtime data lives in `/var/lib/gps-verify/data` and `backend/data` is a
symlink into it, so a redeploy never wipes users or audit history.
