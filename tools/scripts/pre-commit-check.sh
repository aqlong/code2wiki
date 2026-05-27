#!/bin/bash
# Run all pre-commit validation checks in sequence.
# Combines typecheck, tests, and em-dash verification for thorough pre-commit validation.
#
# Usage:
#   tools/scripts/pre-commit-check.sh
#
# Runs in order:
#   1. npm run typecheck (type safety)
#   2. npm test (unit tests, integration tests)
#   3. python3 tools/scripts/strip-em-dashes.py --check (code style)
#   4. tools/scripts/verify-hooks.sh (git hook health)
#
# Exits 0 only if ALL checks pass. Stops at first failure and reports the problem.
#
# Note: pre-commit hooks run a subset of these checks automatically, but developers
# should run this before pushing to catch issues early.

set -euo pipefail

if [ "${1:-}" = "--help" ]; then
  echo "Usage: pre-commit-check.sh"
  echo ""
  echo "Run all pre-commit validation checks in sequence:"
  echo "  1. npm run typecheck (type safety)"
  echo "  2. npm test (unit + integration tests)"
  echo "  3. strip-em-dashes --check (code style)"
  echo "  4. verify-hooks (git hook health)"
  echo ""
  echo "Exit codes:"
  echo "  0  All checks passed"
  echo "  1  One or more checks failed"
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

echo "Running pre-commit checks..."
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

# Step 2: Tests
echo "2. Running tests..."
if ! npm test; then
  echo ""
  echo "✗ tests failed"
  exit 1
fi
echo "   ✓ tests passed"
echo ""

# Step 3: Em-dash check
echo "3. Checking for em-dashes..."
if ! python3 tools/scripts/strip-em-dashes.py --check; then
  echo ""
  echo "✗ em-dash check failed"
  exit 1
fi
echo "   ✓ no em-dashes found"
echo ""

# Step 4: Hook health
echo "4. Verifying git hooks..."
if ! tools/scripts/verify-hooks.sh; then
  echo ""
  echo "✗ hook verification failed"
  exit 1
fi
echo "   ✓ hooks are healthy"
echo ""

echo "✓ All pre-commit checks passed!"
exit 0
