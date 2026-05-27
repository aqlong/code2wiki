#!/bin/bash
# Quick pre-commit checks: typecheck + em-dash verification (no tests).
# Runs in ~5 seconds. Use this for fast feedback during development.
# Use pre-commit-check.sh for thorough validation before pushing.
#
# Usage:
#   tools/scripts/quick-check.sh

set -euo pipefail

if [ "${1:-}" = "--help" ]; then
  echo "Usage: quick-check.sh"
  echo ""
  echo "Run fast pre-commit checks without full test suite:"
  echo "  1. npm run typecheck (type safety)"
  echo "  2. strip-em-dashes --check (code style)"
  echo ""
  echo "Completes in ~5 seconds. Useful for quick feedback during development."
  echo "Use pre-commit-check.sh for thorough validation before pushing."
  echo ""
  echo "Exit codes:"
  echo "  0  All checks passed"
  echo "  1  One or more checks failed"
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

echo "Running quick checks..."
echo ""

# Step 1: Type safety
echo "1. Type checking..."
if ! npm run typecheck; then
  echo ""
  echo "✗ typecheck failed"
  exit 1
fi
echo "   ✓ typecheck passed"
echo ""

# Step 2: Em-dash check
echo "2. Checking for em-dashes..."
if ! python3 tools/scripts/strip-em-dashes.py --check; then
  echo ""
  echo "✗ em-dash check failed"
  exit 1
fi
echo "   ✓ no em-dashes found"
echo ""

echo "✓ Quick checks passed!"
exit 0
