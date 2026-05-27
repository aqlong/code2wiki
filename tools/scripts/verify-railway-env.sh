#!/usr/bin/env bash
# Verify Railway production env vars are set for code2wiki-app.
#
# Surfaced 2026-05-26 after a 6-day silent build-success-deploy-fail
# loop caused by AUTH_TRUST_HOST going missing from Railway env
# (memory/ref_railway_deploy_gotchas.md item 9; Auth.js v5 refuses
# untrusted hosts on non-Vercel platforms).
#
# Alternative to this script: `curl /api/healthz | jq` checks the
# same vars at runtime via the missingRequiredEnv field. This script
# is for ad-hoc operator runs when the dashboard isn't reachable.
#
# Usage:
#   tools/scripts/verify-railway-env.sh                          # c2w-app
#   tools/scripts/verify-railway-env.sh <service-name>           # other
#   RAILWAY_TOKEN=... tools/scripts/verify-railway-env.sh        # CI mode
#
# Exit code: 0 if all required vars are set; 1 if any are missing.

set -euo pipefail

SERVICE="${1:-code2wiki-app}"

# Required env vars for the c2w-app service. Keep in sync with
# REQUIRED_ENV in apps/dashboard/src/app/api/healthz/route.ts.
REQUIRED=(
  DATABASE_URL
  AUTH_SECRET
  AUTH_URL
  AUTH_TRUST_HOST
  AUTH_GITHUB_ID
  AUTH_GITHUB_SECRET
)

if ! command -v railway >/dev/null 2>&1; then
  echo "error: railway CLI not installed. Run: npm install -g @railway/cli" >&2
  exit 2
fi

echo "Verifying required env vars on Railway service '$SERVICE'..."
echo

# `railway variables --service X` works with a project-scoped
# RAILWAY_TOKEN, and also with an interactively-logged-in account.
# Table output is unreliable for values (gotcha #1: ~40-char
# truncation) but RELIABLE for var NAMES, which is all we need.
SET_VARS=$(railway variables --service "$SERVICE" 2>&1 | awk -F'│' '$2 ~ /[A-Z_]+/ {gsub(/[[:space:]]/, "", $2); print $2}' | sort -u)

if [ -z "$SET_VARS" ]; then
  echo "error: railway variables returned no var names (auth issue? CLI version?)" >&2
  exit 2
fi

missing=()
for var in "${REQUIRED[@]}"; do
  if echo "$SET_VARS" | grep -qx "$var"; then
    echo "  [OK]      $var"
  else
    echo "  [MISSING] $var"
    missing+=("$var")
  fi
done

echo
if [ ${#missing[@]} -gt 0 ]; then
  echo "FAIL: ${#missing[@]} required env var(s) missing on $SERVICE: ${missing[*]}"
  echo
  echo "Fix from CLI (one-time):"
  for var in "${missing[@]}"; do
    case "$var" in
      AUTH_TRUST_HOST)
        echo "  railway variables --service $SERVICE --set 'AUTH_TRUST_HOST=true'" ;;
      AUTH_URL)
        echo "  railway variables --service $SERVICE --set 'AUTH_URL=https://<railway-public-domain>'" ;;
      AUTH_SECRET)
        echo "  railway variables --service $SERVICE --set \"AUTH_SECRET=\$(openssl rand -base64 32)\"" ;;
      *)
        echo "  railway variables --service $SERVICE --set '$var=<value>'" ;;
    esac
  done
  echo
  echo "See memory/ref_railway_deploy_gotchas.md item 9 + apps/dashboard/SETUP.md."
  exit 1
fi

echo "PASS: all ${#REQUIRED[@]} required env vars are set on $SERVICE."
