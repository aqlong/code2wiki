#!/bin/bash
# Verify git hooks are properly configured and executable.
# Useful for checking hook health without waiting for a commit.
# Run: ./tools/scripts/verify-hooks.sh

set -euo pipefail

if [ "${1:-}" = "--help" ]; then
  echo "Usage: verify-hooks.sh"
  echo ""
  echo "Verifies all git hooks (pre-commit, post-checkout, pre-push, post-merge)"
  echo "are properly configured, executable, and ready to enforce code quality and"
  echo "safety rules. Run anytime to check hook health without waiting for a commit."
  echo ""
  echo "Exit codes:"
  echo "  0  All hooks are properly configured"
  echo "  1  One or more issues found (see output for details)"
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_DIR="$REPO_ROOT/.githooks"
HOOKS=("pre-commit" "post-checkout" "pre-push" "post-merge")
ISSUES=0

# Hook descriptions (simple case/esac lookup)
get_hook_desc() {
  case "$1" in
    pre-commit) echo "enforces em-dash rule and verifies hook executability" ;;
    post-checkout) echo "auto-configures core.hooksPath on clone/checkout" ;;
    pre-push) echo "warns about uncommitted changes before push" ;;
    post-merge) echo "verifies hooks remain executable after merge" ;;
    *) echo "" ;;
  esac
}

echo "Checking git hooks..."
echo ""

# Check if core.hooksPath is configured
HOOKS_PATH=$(git config core.hooksPath 2>/dev/null || echo "")
if [ -z "$HOOKS_PATH" ]; then
  echo "⚠️  core.hooksPath not configured."
  echo "   Fix: git config core.hooksPath .githooks"
  ISSUES=$((ISSUES + 1))
elif [ "$HOOKS_PATH" != ".githooks" ]; then
  echo "⚠️  core.hooksPath configured but not to .githooks: $HOOKS_PATH"
  ISSUES=$((ISSUES + 1))
else
  echo "✓ core.hooksPath configured correctly"
fi

echo ""

# Check if all hook files exist and are executable
for hook in "${HOOKS[@]}"; do
  hook_path="$HOOKS_DIR/$hook"
  desc=$(get_hook_desc "$hook")
  if [ ! -f "$hook_path" ]; then
    echo "✗ $hook: NOT FOUND at $hook_path"
    ISSUES=$((ISSUES + 1))
  elif [ ! -x "$hook_path" ]; then
    echo "✗ $hook: NOT EXECUTABLE (fix: chmod +x $hook)"
    ISSUES=$((ISSUES + 1))
  else
    echo "✓ $hook: OK ($desc)"
  fi
done

echo ""
echo "Helper:"
if [ -f "$HOOKS_DIR/pre-commit.sh" ]; then
  if [ ! -x "$HOOKS_DIR/pre-commit.sh" ]; then
    echo "✗ pre-commit.sh: NOT EXECUTABLE (fix: chmod +x .githooks/pre-commit.sh)"
    ISSUES=$((ISSUES + 1))
  else
    echo "✓ pre-commit.sh: OK"
  fi
else
  echo "✗ pre-commit.sh: NOT FOUND"
  ISSUES=$((ISSUES + 1))
fi

echo ""
if [ $ISSUES -eq 0 ]; then
  echo "✓ All git hooks are properly configured and executable."
  exit 0
else
  echo "✗ Found $ISSUES issue(s). Fix them before committing."
  exit 1
fi
