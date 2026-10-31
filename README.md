# GPS Verify — Tower Site Audit Tool

**What it does:** Field technicians enter a Tower Co ID → the app shows the Site ID and Site Name in large bold text → they tap **"Audited"** or **"Not Audited"** → every action is logged with username and timestamp.

**Live URL:** https://gps-verify.tailfd1512.ts.net

---

## Default Login

| Username (email) | Password | Role |
|---|---|---|
| `makobajude@gmail.com` | `admin123` | admin (primary, protected) |

> ⚠️ Change this password immediately. The primary admin account can never be deleted or suspended by another admin — that protection is enforced server-side.

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
| **Forgot password** | 6-digit one-time code, valid 10 minutes (code is shown in the UI for the admin to relay) |
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
| `tailscale-funnel.service` | Re-applies `tailscale funnel --bg 80` on boot |

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

---

## API Reference

| Method | Route | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/register` | — | Create an account |
| POST | `/api/auth/login` | — | `{ username, password }` → `{ token, user }` |
| GET | `/api/auth/me` | bearer | Current user profile |
| POST | `/api/auth/forgot-password` | — | `{ email }` → 6-digit OTP |
| POST | `/api/auth/reset-password` | — | `{ email, code, newPassword }` |
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
