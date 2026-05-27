#!/usr/bin/env bash
# Report whether the four Stripe env vars are set on a Railway service,
# with prefix + length only. Never echoes the secret values.
#
# Usage:
#   tools/scripts/verify-stripe-env.sh PROJECT SERVICE
#
# Example:
#   tools/scripts/verify-stripe-env.sh code2wiki-dashboard code2wiki-app
#
# Exits 0 if all four are present and have the expected prefixes; non-zero
# if any are missing or malformed. Useful before sending a paying-customer
# checkout link.

set -euo pipefail

if [ "${1:-}" = "--help" ]; then
  echo "Usage: verify-stripe-env.sh PROJECT SERVICE"
  echo ""
  echo "Verify that all required Stripe environment variables are set on a Railway"
  echo "service with the expected prefixes. Reports prefix + length only; never"
  echo "echoes the actual secret values. Useful before sending a paying-customer"
  echo "checkout link or after modifying env vars."
  echo ""
  echo "Arguments:"
  echo "  PROJECT  Railway project name (e.g., code2wiki-dashboard)"
  echo "  SERVICE  Railway service name (e.g., code2wiki-app)"
  echo ""
  echo "Checks for:"
  echo "  STRIPE_SECRET_KEY      (prefix: sk_live_)"
  echo "  STRIPE_WEBHOOK_SECRET  (prefix: whsec_)"
  echo "  STRIPE_PRICE_ID_STARTER (prefix: price_)"
  echo ""
  echo "Exit codes:"
  echo "  0  All required vars present with correct prefixes"
  echo "  1  One or more vars missing or have wrong prefix"
  exit 0
fi

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 PROJECT SERVICE" >&2
  exit 64
fi
PROJECT="$1"
SERVICE="$2"

cd /tmp && railway link --project "$PROJECT" >/dev/null

# pull whole env-var dump once
KV=$(railway variables --service "$SERVICE" --kv 2>/dev/null)

# macOS ships bash 3.2; use parallel arrays instead of `declare -A`.
# Required for code2wiki's hosted-Checkout flow. STRIPE_PUBLISHABLE_KEY is
# only needed when the frontend embeds Stripe.js inline; we use redirect-to-
# checkout so it's optional. Add it to KEYS if/when that changes.
KEYS=(STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PRICE_ID_STARTER)
PREFIXES=(sk_live_ whsec_ price_)

problems=0
for i in "${!KEYS[@]}"; do
  key="${KEYS[$i]}"
  expected_prefix="${PREFIXES[$i]}"
  val=$(echo "$KV" | grep "^${key}=" | head -1 | cut -d= -f2- || true)
  if [[ -z "$val" ]]; then
    printf "  %-26s  MISSING\n" "$key"
    problems=$((problems + 1))
    continue
  fi
  prefix="${val:0:${#expected_prefix}}"
  if [[ "$prefix" != "$expected_prefix" ]]; then
    printf "  %-26s  WRONG_PREFIX (got '%s...', expected '%s')\n" "$key" "$prefix" "$expected_prefix"
    problems=$((problems + 1))
    continue
  fi
  # Show prefix + len, mask the rest.
  printf "  %-26s  ok  prefix=%s... len=%d\n" "$key" "$prefix" "${#val}"
done

if (( problems > 0 )); then
  echo "verify-stripe-env: $problems problem(s) on $PROJECT/$SERVICE" >&2
  exit 1
fi
echo "verify-stripe-env: all ${#KEYS[@]} required Stripe vars present and well-formed on $PROJECT/$SERVICE"
