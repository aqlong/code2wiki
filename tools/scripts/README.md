# tools/scripts: local verification toolbox

Small, self-contained scripts for running checks against the system locally without touching prod data or external APIs. Every script here MUST:

1. Have a header docstring stating purpose, usage, and safety scope (what it touches, what it does not).
2. Be safe to re-run (idempotent or explicitly destructive with `--force` style gates).
3. Never echo a secret value. Show prefix + length only.
4. Default to read-only / dry-run; require an explicit flag to mutate.
5. Use stable exit codes: 0 success, 1 generic failure, 2 timeout, 64 usage error.

If a verification fits the toolbox shape (single-purpose, no long-lived state), add it here rather than scattering one-off scripts in `/tmp`.

## Scripts

| Script | Purpose | Mutates? |
|---|---|---|
| [`pre-commit-check.sh`](./pre-commit-check.sh) | Run all pre-commit validation checks in sequence: typecheck, tests, em-dash check, hook verification. Stops at first failure and reports the problem. Useful before committing or pushing. | Read-only (reports status only). |
| [`quick-check.sh`](./quick-check.sh) | Run fast pre-commit checks: typecheck + em-dash check (no tests). Completes in ~5 seconds. Useful for rapid feedback during development. Use pre-commit-check.sh before pushing for thorough validation. | Read-only (reports status only). |
| [`local-wiki-preview.ts`](./local-wiki-preview.ts) | Render every generated use-case under `references/<repo>/docs/use-cases/` as Confluence storage-format XHTML + Notion block JSON + a browsable HTML preview. Auto-discovers refs; supports `--refs a,b`, `--out DIR`, `--open`. | Output dir only (default `~/code2wiki-local-wiki-preview/`, outside repo). |
| [`strip-em-dashes.py`](./strip-em-dashes.py) | Scrub all em dashes (U+2014) from authored markdown in the repo. `--check` mode reports + exits non-zero for CI. | Repo files in place (idempotent). |
| [`generate_git_state.py`](./generate_git_state.py) | Generate `git-state.html`, a self-contained dashboard of the repo's git state (branch, ahead/behind, staged/unstaged/untracked, recent commits, pending branches). Auto-refreshes every 15s in the browser; the `com.code2wiki.git-state` LaunchAgent regenerates the file every 60s. | Writes `<root>/git-state.html` (gitignored). |
| [`generate_c2w_state.py`](./generate_c2w_state.py) | Generate `.c2w-workflow.html`, a workflow/build-system dashboard: roadmap pending/done split (operator vs bot), CI status on main, prod healthz for code2wiki-app + ocean-bot-dashboard, worktree dep state, recent ships, environments table, code-to-deploy pipeline. Auto-refreshes every 15s in the browser; the `com.code2wiki.c2w-state` LaunchAgent regenerates the file every 60s. | Writes `<root>/.c2w-workflow.html` (gitignored). |
| [`verify-deploy.sh`](./verify-deploy.sh) | Poll a Railway service's latest deploy until SUCCESS, then hit a healthcheck URL. `verify-deploy.sh PROJECT SERVICE HEALTHCHECK_URL [MAX_SECS]`. | Mutates local `railway link` state. |
| [`verify-stripe-env.sh`](./verify-stripe-env.sh) | Confirm all four `STRIPE_*` env vars are set on a Railway service with the expected prefixes. Prints prefix + length, never the value. | Mutates local `railway link` state. |
| [`verify-railway-env.sh`](./verify-railway-env.sh) | Verify the dashboard's required Railway env vars (DATABASE_URL, AUTH_SECRET, AUTH_URL, AUTH_TRUST_HOST, AUTH_GITHUB_ID, AUTH_GITHUB_SECRET) are set. Exits 1 + prints exact `--set` commands for each missing var. Added 2026-05-26 after a 6-day silent deploy-stall caused by AUTH_TRUST_HOST going missing. Same source-of-truth list as `/api/healthz`'s `missingRequiredEnv` field. | Read-only; uses `railway variables --service`. |
| [`verify-stripe-deliveries.sh`](./verify-stripe-deliveries.sh) | List recent webhook events from Stripe with per-event `pending_webhooks` counts. Useful for post-onboarding sanity + debugging silent webhook failures. | Mutates local `railway link` state. |
| [`verify-hooks.sh`](./verify-hooks.sh) | Verify all git hooks (pre-commit, post-checkout, pre-push, post-merge) are properly configured, executable, and ready to enforce code quality and safety rules. Run anytime to check hook health. | Read-only (reports status only). |
| [`verify-demo-deploy.sh`](./verify-demo-deploy.sh) | Smoke-test the public code2wiki showcase pages (CFML ContentBox + Java/Spring petclinic demos) to confirm they are live, correctly structured, and cross-linked after a CAS deploy. `./verify-demo-deploy.sh [BASE_URL]`; defaults to `https://craftandship.io/code2wiki`. 14 checks: HTTP 200 per page + CTA banner + switcher + cross-link + card grid + use-case spot-check for each demo. | Read-only (HTTP GET only). |
| [`seed-ocean-bot-backlog.sh`](./seed-ocean-bot-backlog.sh) | Run the ocean-bot backlog seed script via the sidecar at `~/.config/ocean-bot/env`, bypassing `railway run` and its CLI-auth flap (gotcha #7). Reads `OCEAN_BOT_DATABASE_URL` from the sidecar, invokes `tools/ocean-bot/scripts/seed-backlog.ts`. Use this as the default seed path; the historical `railway run ... seed-backlog.ts` command stays as a fallback. | Inserts/skips rows in the ocean-bot Postgres backlog table (idempotent). |
| [`build-public-tree.mjs`](./build-public-tree.mjs) | Build a deterministic, leak-scanned public OSS tree at `/tmp/c2w-public-tree` by copying OSS-safe files, excluding proprietary moat files, stripping internal references, running leak-scan, and executing npm ci/build/test. Used for operator-gated public-sync releases. `node build-public-tree.mjs`; no args. Prints summary with verification checklist. | Output dir only (`/tmp/c2w-public-tree`, cleaned before each run). |

## LaunchAgents (macOS, optional)

Two LaunchAgents pair with the generators above to keep the dashboards live without manual reruns:

- [`com.code2wiki.git-state.plist`](./com.code2wiki.git-state.plist), runs `generate_git_state.py` every 60s.
- [`com.code2wiki.c2w-state.plist`](./com.code2wiki.c2w-state.plist), runs `generate_c2w_state.py` every 60s.

Install either (or both) once:

```sh
cp tools/scripts/com.code2wiki.c2w-state.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.code2wiki.c2w-state.plist
```

The HTML files use `<meta http-equiv="refresh" content="15">`, so the browser view reloads every 15s and picks up whatever the LaunchAgent most recently wrote. Open via `file:///Users/<you>/code2wiki/.c2w-workflow.html`.

## Patterns to copy when adding a new script

- **TS scripts** import from `../../src/core/...` (use Node ESM with `import.meta.url` to derive `__dirname` if needed). Run with `npx tsx tools/scripts/<name>.ts`.
- **Shell scripts** use `set -euo pipefail`. Positional args before flags. `--help` returns usage and exits 0.
- **Python scripts** use the stdlib only when possible (we already have python3 available; no new deps).
- **Argument parsing**: minimal hand-rolled is fine for shell/python. For TS, the `parseFlags()` pattern in `local-wiki-preview.ts` is enough; no commander/yargs.
- **Output**: human-readable summary at the end. Mention what was created / where / and the explicit next step (URL, command, etc.).
- **Error reporting**: exit non-zero; print to stderr with the script's name prefix (`verify-stripe-env: ...`).

## Anti-patterns

- DO NOT hardcode customer-specific paths, project names, or service names. Take them as arguments.
- DO NOT write to the repo's working tree unless that's the script's explicit purpose (the em-dash stripper is the exception).
- DO NOT call real Stripe / Confluence / Notion / GitHub APIs without an explicit `--no-dry-run` style flag, even with test keys.
- DO NOT introduce new npm dependencies for verification scripts.
- DO NOT commit a script that requires editing the source to reconfigure it. If it needs config, take CLI args or env vars.

## When to reach for which

- "Need quick feedback while coding?" → `quick-check.sh` (typecheck + em-dash check in ~5s, no tests).
- "Before I commit, did I break anything?" → `pre-commit-check.sh` (runs typecheck + tests + em-dash check + hook verification in sequence).
- "Did I break something on the last commit?" → typecheck + `npm test` (covered by the existing dev loop, not this dir).
- "What's the git state of this worktree?" → `git-state.html` (regenerated by `generate_git_state.py` + its LaunchAgent).
- "Where am I in the roadmap; what's healthy in prod?" → `.c2w-workflow.html` (regenerated by `generate_c2w_state.py` + its LaunchAgent).
- "What do my generated docs look like in a wiki?" → `local-wiki-preview.ts`.
- "Did Railway finish deploying?" → `verify-deploy.sh`.
- "Are all the Stripe creds set after I touched env vars?" → `verify-stripe-env.sh`.
- "My webhook should have fired, did it?" → `verify-stripe-deliveries.sh`.
- "Did I sneak an em dash into the docs?" → `strip-em-dashes.py --check`.
- "Are my git hooks set up correctly?" → `verify-hooks.sh` (see also [`.githooks/README.md`](../../.githooks/README.md)).
- "Is c2w-app's Railway env complete?" → `verify-railway-env.sh` (or `curl /api/healthz | jq .missingRequiredEnv`). The two checks share their required-vars list.
- "Ready to release the public OSS version?" → `build-public-tree.mjs` (operator-gated). Builds a leak-scanned staging tree, runs full test suite, prints verification checklist. Requires: leak-scan exit 0, npm test exit 0, all moat files excluded.
- Anything not covered: write a new script in this dir following the conventions above, list it in this README.
