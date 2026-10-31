#!/bin/bash
# Enable the Tailscale Funnel, waiting for tailscaled to actually be ready.
#
# `After=tailscaled.service` in systemd only orders the *start* of the
# tailscaled unit — it does not wait for tailscaled to reach the "Running"
# backend state. On boot, `tailscale funnel` therefore often failed with
# "unexpected state: NoState" and the public URL went down.
#
# This wrapper polls until the node is genuinely logged in, then applies the
# funnel and verifies it took effect.
export PATH=/usr/local/bin:$PATH

WAIT_SECONDS=${WAIT_SECONDS:-120}
ATTEMPTS=${ATTEMPTS:-5}

log() { echo "[funnel-setup] $*"; }

wait_for_running() {
  local deadline=$(( $(date +%s) + WAIT_SECONDS ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    local state
    state=$(tailscale status --json 2>/dev/null \
      | python3 -c "import json,sys; print(json.load(sys.stdin).get('BackendState',''))" 2>/dev/null)
    if [ "$state" = "Running" ]; then
      log "tailscaled is Running"
      return 0
    fi
    log "waiting for tailscaled (state=${state:-unknown})..."
    sleep 3
  done
  log "timed out waiting for tailscaled to reach Running"
  return 1
}

wait_for_running || exit 1

for attempt in $(seq 1 "$ATTEMPTS"); do
  log "applying funnel (attempt $attempt/$ATTEMPTS)"
  if tailscale funnel --bg 80; then
    # Verify it really took effect
    if tailscale funnel status 2>&1 | grep -q 'Funnel on'; then
      log "funnel active:"
      tailscale funnel status 2>&1 | sed 's/^/[funnel-setup]   /'
      exit 0
    fi
    log "funnel command succeeded but status shows no active funnel"
  else
    log "funnel command failed"
  fi
  sleep 5
done

log "failed to establish funnel"
exit 1
