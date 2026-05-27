#!/usr/bin/env bash
# Pull recent webhook events from Stripe and summarise per type + delivery
# state. No PII echoed. Useful for post-onboarding sanity checks and
# debugging "why didn't my webhook fire."
#
# Usage:
#   tools/scripts/verify-stripe-deliveries.sh KEY_PROJECT KEY_SERVICE [MINUTES]
#
# Example:
#   tools/scripts/verify-stripe-deliveries.sh craftandship-recovery craftandship-web 30
#
# KEY_PROJECT / KEY_SERVICE: where to pull the live STRIPE_SECRET_KEY from
# (typically a Railway service that already has it set; for code2wiki today
# this is the CAS recovery deployment since we share the Stripe account).
# MINUTES defaults to 30.
#
# The script lists each event with its type, id, and pending_webhooks count.
# pending_webhooks=0 means every registered endpoint has acked the event.

set -euo pipefail

if [ "${1:-}" = "--help" ]; then
  echo "Usage: verify-stripe-deliveries.sh KEY_PROJECT KEY_SERVICE [MINUTES]"
  echo ""
  echo "Pull recent webhook events from Stripe and summarize per type and delivery"
  echo "state. No PII echoed. Useful for post-onboarding sanity checks and debugging"
  echo "'why didn't my webhook fire?' issues."
  echo ""
  echo "Arguments:"
  echo "  KEY_PROJECT  Railway project where STRIPE_SECRET_KEY is set"
  echo "  KEY_SERVICE  Railway service where STRIPE_SECRET_KEY is set"
  echo "  MINUTES      How many minutes back to check (default: 30)"
  echo ""
  echo "Output:"
  echo "  Lists each event with: type, pending_webhooks count, and event id"
  echo "  pending_webhooks=0 means every registered endpoint acked the event with 2xx"
  echo ""
  echo "Example:"
  echo "  verify-stripe-deliveries.sh code2wiki-dashboard code2wiki-app 30"
  exit 0
fi

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 KEY_PROJECT KEY_SERVICE [MINUTES]" >&2
  exit 64
fi
KEY_PROJECT="$1"
KEY_SERVICE="$2"
MINUTES="${3:-30}"

cd /tmp && railway link --project "$KEY_PROJECT" >/dev/null
SK=$(railway variables --service "$KEY_SERVICE" --kv 2>/dev/null \
  | grep '^STRIPE_SECRET_KEY=' | cut -d= -f2-)
if [[ ! "$SK" =~ ^sk_(live|test)_ ]]; then
  echo "verify-stripe-deliveries: STRIPE_SECRET_KEY not found or malformed on $KEY_PROJECT/$KEY_SERVICE" >&2
  exit 1
fi

SINCE=$(date -u -v-"${MINUTES}M" +%s 2>/dev/null \
  || date -u -d "${MINUTES} minutes ago" +%s)

echo "Recent webhook events on Stripe (last ${MINUTES} min):"
curl -fsS --globoff "https://api.stripe.com/v1/events?created[gte]=$SINCE&limit=50" \
  -u "$SK:" \
  | jq -r '.data | sort_by(.created) | reverse | .[] |
    "  " + (.type) + "  pending_webhooks=" + (.pending_webhooks|tostring) +
    "  id=" + .id'

echo
echo "(pending_webhooks=0 means every subscribed endpoint acked the event with 2xx.)"
