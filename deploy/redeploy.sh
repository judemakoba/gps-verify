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

APP_DIR=${APP_DIR:-/opt/gps-verify}
DATA_DIR=${DATA_DIR:-/var/lib/gps-verify/data}
BRANCH=${BRANCH:-master}
SERVICE=${SERVICE:-gps-verify.service}

cd "$APP_DIR"
mkdir -p "$DATA_DIR"

echo "==> fetching origin"
git fetch origin
git reset --hard "origin/$BRANCH"
git clean -fd -e node_modules

# The tracked data files are the seed for a fresh install. They are only copied
# when the persistent store does not have them yet — a live instance keeps its
# own users/audits.
for f in sites.json users.json audits.json sitesMeta.json; do
  if [ ! -f "$DATA_DIR/$f" ] && [ -f "$APP_DIR/backend/data/$f" ]; then
    echo "==> seeding $f into $DATA_DIR"
    cp "$APP_DIR/backend/data/$f" "$DATA_DIR/$f"
  fi
done

# backend/data must be a symlink into the persistent store. The checkout above
# replaced it with a real directory, so restore the link.
if [ ! -L "$APP_DIR/backend/data" ]; then
  rm -rf "$APP_DIR/backend/data"
  ln -sfn "$DATA_DIR" "$APP_DIR/backend/data"
fi

# Never let a later `git reset --hard` overwrite the live data files.
git update-index --skip-worktree backend/data/sites.json backend/data/users.json \
  || true
[ -e backend/data/sitesMeta.json ] && git update-index --skip-worktree backend/data/sitesMeta.json || true

echo "==> installing backend dependencies"
cd "$APP_DIR/backend"
if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
  npm install --omit=dev --no-audit --no-fund
fi

echo "==> restarting $SERVICE"
systemctl restart "$SERVICE"
sleep 2
systemctl --no-pager --full status "$SERVICE" | head -n 12 || true

echo "==> health check"
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT:-3001}/api/sites/count" >/dev/null 2>&1; then
    echo "OK: $(curl -fsS "http://127.0.0.1:${PORT:-3001}/api/sites/count")"
    exit 0
  fi
  sleep 1
done

echo "FAILED: the API did not come up" >&2
exit 1
