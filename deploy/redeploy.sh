#!/usr/bin/env bash
# ── Redeploy GPS Verify inside an LXC ──────────────────────────────────────────
# Keeps the runtime data (users, audits, sites) in a persistent directory so a
# redeploy never wipes it, then restarts the API.
#
#   APP_DIR   application checkout      (default /opt/gps-verify)
#   DATA_DIR  persistent runtime data   (default /var/lib/gps-verify/data)
#   BRANCH    branch to deploy          (default master)
#
# Usage: bash /usr/local/sbin/gps-verify-redeploy
set -euo pipefail

export PATH=/usr/local/node-v20.18.0-linux-x64/bin:$PATH

APP_DIR=${APP_DIR:-/opt/gps-verify}
DATA_DIR=${DATA_DIR:-/var/lib/gps-verify/data}
BRANCH=${BRANCH:-master}
SERVICE=${SERVICE:-gps-verify.service}
PORT=${PORT:-3001}

cd "$APP_DIR"
mkdir -p "$DATA_DIR"

# ── Order matters ─────────────────────────────────────────────────────────────
# The data files are marked --skip-worktree, so git ignores them: a reset will
# NOT restore them and `git clean` treats backend/data/ as an untracked
# directory and deletes it. The sequence below un-skips them first, lets git
# restore the tracked files, seeds the persistent store from them, and only
# then puts the symlink back.
echo "==> un-skip the data files so git can restore them"
for f in sites.json users.json sitesMeta.json; do
  git update-index --no-skip-worktree "backend/data/$f" 2>/dev/null || true
done

echo "==> clearing backend/data (the symlink into the persistent store)"
rm -rf "$APP_DIR/backend/data"

echo "==> fetching origin"
git fetch origin
git reset --hard "origin/$BRANCH"
# Keep the untracked Caddy config that lives in the app dir.
git clean -fd -e node_modules -e Caddyfile -e caddy || true

# The tracked data files are the seed for a fresh install. They are only copied
# when the persistent store does not have them yet — a live instance keeps its
# own users/audits.
for f in sites.json users.json audits.json sitesMeta.json; do
  if [ ! -f "$DATA_DIR/$f" ] && [ -f "$APP_DIR/backend/data/$f" ]; then
    echo "==> seeding $f into $DATA_DIR"
    cp "$APP_DIR/backend/data/$f" "$DATA_DIR/$f"
  fi
done

echo "==> restoring the persistent store symlink"
rm -rf "$APP_DIR/backend/data"
ln -sfn "$DATA_DIR" "$APP_DIR/backend/data"

# Never let a later `git reset --hard` overwrite the live data files.
for f in sites.json users.json sitesMeta.json; do
  git update-index --skip-worktree "backend/data/$f" 2>/dev/null || true
done

echo "==> installing backend dependencies"
cd "$APP_DIR/backend"
if [ ! -d node_modules ]; then
  npm install --omit=dev --no-audit --no-fund
fi

echo "==> restarting $SERVICE"
systemctl restart "$SERVICE"
sleep 2
systemctl --no-pager --full status "$SERVICE" | head -n 12 || true

echo "==> health check"
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/sites/count" >/dev/null 2>&1; then
    echo "OK: $(curl -fsS "http://127.0.0.1:${PORT}/api/sites/count")"
    exit 0
  fi
  sleep 1
done

echo "FAILED: the API did not come up" >&2
exit 1
