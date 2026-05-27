#!/usr/bin/env bash
# Wait for a Railway service's latest deploy to reach SUCCESS, then hit a
# healthcheck endpoint and report. No mutations; pure observation.
#
# Usage:
#   tools/scripts/verify-deploy.sh PROJECT SERVICE HEALTHCHECK_URL [MAX_SECS]
#
# Example:
#   tools/scripts/verify-deploy.sh code2wiki-dashboard code2wiki-app \
#     https://code2wiki-app-production.up.railway.app/api/healthz 480
#
# Exits 0 if SUCCESS and healthcheck returns 200; non-zero on FAILED, CRASHED,
# or timeout.
#
# Caveats:
#   - `railway link` is mutating local CLI state; we link to PROJECT before
#     polling. Safe to re-run.
#   - Polls every 12s. Cap defaults to 480s (8min).

set -euo pipefail

if [ "${1:-}" = "--help" ]; then
  echo "Usage: verify-deploy.sh PROJECT SERVICE HEALTHCHECK_URL [MAX_SECS]"
  echo ""
  echo "Wait for a Railway service's latest deploy to reach SUCCESS, then hit a"
  echo "healthcheck endpoint and report status. Safe to re-run (idempotent)."
  echo ""
  echo "Arguments:"
  echo "  PROJECT        Railway project name (e.g., code2wiki-dashboard)"
  echo "  SERVICE        Railway service name (e.g., code2wiki-app)"
  echo "  HEALTHCHECK_URL  Full URL to healthcheck endpoint (e.g., https://...api/healthz)"
  echo "  MAX_SECS       Max seconds to wait (default: 480)"
  echo ""
  echo "Exit codes:"
  echo "  0  Deploy succeeded and healthcheck returned 200"
  echo "  1  Deploy failed or crashed"
  echo "  2  Timeout waiting for deploy (exceeded MAX_SECS)"
  exit 0
fi

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 PROJECT SERVICE HEALTHCHECK_URL [MAX_SECS]" >&2
  exit 64
fi

PROJECT="$1"
SERVICE="$2"
HEALTHZ="$3"
MAX_SECS="${4:-480}"

cd /tmp && railway link --project "$PROJECT" >/dev/null

start=$(date +%s)
while true; do
  now=$(date +%s)
  if (( now - start > MAX_SECS )); then
    echo "verify-deploy: TIMEOUT after ${MAX_SECS}s waiting for $SERVICE" >&2
    exit 2
  fi
  state=$(railway status --json 2>/dev/null \
    | python3 -c "
import json, sys
d = json.load(sys.stdin)
for env in d['environments']['edges']:
    for svc in env['node']['serviceInstances']['edges']:
        if svc['node']['serviceName'] == '$SERVICE':
            dep = svc['node'].get('latestDeployment') or {}
            print(dep.get('status', 'UNKNOWN'))
            sys.exit(0)
print('NOT_FOUND')
")
  case "$state" in
    SUCCESS)
      echo "verify-deploy: SUCCESS for $SERVICE"
      break
      ;;
    FAILED|CRASHED|REMOVED)
      echo "verify-deploy: $state for $SERVICE" >&2
      exit 3
      ;;
    NOT_FOUND)
      echo "verify-deploy: service '$SERVICE' not found in project '$PROJECT'" >&2
      exit 4
      ;;
    *)
      echo "  still $state... ($((now - start))s)"
      sleep 12
      ;;
  esac
done

# Healthcheck
http=$(curl -s -o /tmp/verify-deploy-body -w "%{http_code}" "$HEALTHZ")
echo "verify-deploy: $HEALTHZ -> $http"
if [[ "$http" =~ ^2 ]]; then
  head -c 400 /tmp/verify-deploy-body
  echo
  exit 0
fi
echo "verify-deploy: healthcheck non-2xx" >&2
head -c 400 /tmp/verify-deploy-body >&2
exit 5
