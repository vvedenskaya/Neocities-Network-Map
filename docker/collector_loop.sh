#!/bin/sh
set -eu

INTERVAL_SECONDS="${COLLECT_INTERVAL_SECONDS:-300}"

echo "[collector] interval: ${INTERVAL_SECONDS}s"
mkdir -p /app/history

while true; do
  echo "[collector] run at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if ! python /app/network_collector.py; then
    echo "[collector] collector failed; will retry after sleep"
  fi
  sleep "${INTERVAL_SECONDS}"
done
