#!/bin/bash
# Watchdog: re-establish the Tailscale Funnel if it is not active.
#
# The funnel config lives in tailscaled's in-memory state and can be lost if
# tailscaled restarts or crashes without the oneshot unit running in time.
# This runs periodically and repairs it.
export PATH=/usr/local/bin:$PATH

if tailscale funnel status 2>&1 | grep -q 'Funnel on'; then
  exit 0
fi

echo "[funnel-watchdog] funnel not active, re-establishing..."
tailscale funnel --bg 80
sleep 3
if tailscale funnel status 2>&1 | grep -q 'Funnel on'; then
  echo "[funnel-watchdog] funnel restored"
  exit 0
fi
echo "[funnel-watchdog] failed to restore funnel"
exit 1
