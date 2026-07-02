# Changelog

Notable changes to code2wiki. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); during pre-MVP we group by week rather than by released version since there's no public release cadence yet.

## Unreleased, pre-MVP, design-partner phase (2026-06 / 2026-07)

### LLM backends

- **Azure OpenAI backend** (ADR-043): `resolveBackend()` selects Anthropic / Azure OpenAI / mock from env + config. Identical prompts across backends; `--estimate-cost` stays Anthropic-only with an actionable error elsewhere. Originated as public fork PR aqlong/code2wiki#1.
- **DeepSeek backend** (ADR-045): third backend over the same `openai` SDK (custom `baseURL`). `DEEPSEEK_API_KEY` activates it; in auto-detect DeepSeek outranks Anthropic, pin `CODE2WIKI_LLM_BACKEND=anthropic` if both keys are set. Default model `deepseek-v4-flash`.
- **Backend-selection hardening**: typo'd `CODE2WIKI_LLM_BACKEND` values fail fast instead of silently auto-detecting; empty Anthropic responses are diagnosed instead of surfacing as an opaque JSON parse error; Azure env validation covers both trigger paths.

### Preview quality

- **Grouped index**: `code2wiki preview`'s `index.html` buckets pages by `source_files[0]` top-level folder with per-group counts; root-level files land under `(root)`. Groups sort alphabetically, pages by title within each group. Originated as public fork PR aqlong/code2wiki#2.
- **Viewer-local timestamps**: banner `Last synced`, per-page `Generated` meta, index `Generated`, and bare ISO-8601 strings inside rendered bodies all display in the viewer's timezone with the original ISO preserved as a hover tooltip. Script is injected at the END of `<body>` (placement is load-bearing and test-pinned; a head-placed script runs before the DOM exists and silently no-ops). Text inside `code`/`pre` is exempt so example payloads stay literal.
- **Confidence badges** on the index and both per-page lookalikes (high / medium / low), matching the hosted dashboard's per-page rating.
- **Renderer footer fix**: the generated-page footer is plain ISO text again; an inline `<time>` tag briefly shipped on 2026-07-02 rendered as literal escaped markup on published Confluence pages and was reverted the same day with a regression test.

### Tooling

- **Em-dash scrubber fixes**: `strip-em-dashes.py` now matches skip fragments against repo-root-relative paths, so runs from inside a git worktree scan files instead of passing vacuously; `.py`, `.example`, and `.json` files joined the scan set (the scrubber + its test self-skip); two `.env.example` files scrubbed.

## Unreleased, pre-MVP, design-partner phase (2026-05)

### Self-learning + quality loops

- **Self-learning v2 calibration primitives**: dep-free logistic regression, deterministic k-fold split, cross-validation composition, evaluation primitives, fit-quality verdict baseline, and serialise/deserialise pair. Saturated at the "no real data yet" gate; ready for the day signal #1 reaches ~100 published-page observations.
- **Signed audit log v1 schema** with `alg` and `signing_key_id` fields reserved. Smallest reversible slice; signing + verification deferred until Phase 3 buyer demand.
- **Validator coverage replay** to retroactively count how often the shipped chain-of-correction validator would have fired against historical audit entries.
- **Per-page confidence observation** writer wired into the orchestrator; one row per persisted page joining LLM self-rated confidence with chain-of-correction `retried` op outcomes.
- **Edit-back tracking worker** (signal #1) shipped with `feedback_observation` table, Confluence + Notion revision-history fetchers, section-aware string diff, pure HTTP no-LLM design. Daily cron at `.github/workflows/feedback-poll.yml`.
- **Real-repo signal methodology** documented in `memory/feedback_real_repo_signal.md` and exercised across 12 reference repos (wheels, petclinic-rest, ColdBox, TestBox, Roller, ContentBox, masa-cms, spring-petclinic, jspwiki, spring-data-jpa, fw1, dropwizard). 64 candidates run end-to-end; 51 high / 4 medium / 3 low confidence; 0 chain-of-correction retries fired. JSPWiki produced 0 candidates pre-fix (legacy non-annotated Java); resolved via `javaSurfaceMode` config below.

### Parser fixes from real-repo signal

- **CFML placeholder filter** (`b9c44e9`): `parseCfmPage` strips cfscript `//` line comments + `/* */` block comments + boilerplate-only tags before counting executable lines; rejects pages with < 3 executable lines.
- **CFML JSDoc block-comment strip** (`3b85b8c`): `stripCfmlComments` extended to strip `/* ... */` so script-style function detection no longer matches function declarations inside top-of-file `/** */` example blocks.
- **Java tree-sitter buffer-overflow fix**: switched to the callback-overload `parser.parse((index) => source.slice(index, index+4096))` so legacy enterprise Java files larger than 32 KB no longer fail with "Invalid argument."
- **Java annotation-free legacy mode**: new `javaSurfaceMode: "annotated" | "all-public-classes" | "package-allowlist"` config option so pre-2010 enterprise Java (JSPWiki-style, no Spring annotations) is no longer silently invisible.
- **Pure-delegation + constant-return filters**: methods whose only executable line is `return other.method(...)` or `return <literal>;` are dropped by default; opt-in via config.
- **Test-fixture default excludes** extended with `test-harness/`, `spec/`, `specs/`, `__tests__/`, `__mocks__/`, and wildcard `*benchmark*/` to catch JMH benchmark stubs.

### Dashboard + multi-tenant

- **Multi-tenant query filtering**: every dashboard query takes a `TenantScope` (`{ userId } | "all"`) first parameter; filter threaded through inner joins to `installations.owner_user_id`. `/dashboard/*` calls `requireUserScope()` (in `lib/dashboard/scope.ts`).
- **GitHub App `setup_url` callback** at `/api/github/setup` resolves the installer's `session.user.id` and writes `owner_user_id` on the `github_installation` row.
- **Per-customer Confluence/Notion credentials** schema (multi-tenant publisher creds).
- **Live `/architecture` page** with server-rendered SVG diagram + 5 live Postgres counters, auto-refreshes every 30s. Public route, no auth.
- **Per-run `ConfidenceCard`** on `/dashboard/runs/[id]` showing high/medium/low totals + chain-of-correction outcomes + low-confidence drill-down list.
- **`/dashboard/feedback` + per-page drill-down at `/dashboard/feedback/[pageId]`**: reads `feedback_observation` rows; shows top sections BAs delete / add, most-edited pages.
- **Webhook robustness**: provider-agnostic `webhook_delivery` table (composite PK on `delivery_id, source`) for dedupe; per-row optimistic lock on `runs` via `UPDATE … WHERE status IN ('queued','failed')`.

### CLI

- **`code2wiki preview [--open]`** renders every generated use-case as a browsable Confluence + Notion preview at `.code2wiki/preview/`. No network calls. Same renderers as `/dashboard/runs/[id]/[slug]?as=confluence|notion`.
- **`code2wiki replay --since-version <v>`** filters audit entries by their `promptVersion` stamp; body-only diff via `computeMarkdownSnapshot`.
- **`code2wiki generate --estimate-cost`** flag for pre-flight LLM cost projection.
- **`code2wiki generate --min-confidence <level>`** skips writing pages below threshold.
- **`code2wiki generate --limit N`** now uses even-spread sampling across the sorted candidate list (instead of `slice(0, N)`) so a small `--limit` produces a representative slice of the codebase rather than biasing toward whichever directory sorts first.

### Stripe billing

- **Subscribe + Billing Portal**: `/dashboard/billing` Start-subscription + Manage-subscription buttons go through Stripe-hosted Checkout / Billing Portal sessions. Pure-HMAC webhook verification (no SDK on the webhook path; ~250kB saved). Handlers for `customer.subscription.{created,updated,deleted}` + `checkout.session.completed`. Live keys are wired in Railway env; the real-card end-to-end smoke is item #4 in the public-launch checklist and still operator-PENDING (test card → real webhook → real subscription row, then flip the gate).

### Wiki publishing

- **ADR-016 coexistence v1** shipped: three modes (greenfield/claim/parallel), preflight + `.code2wiki/preflight.json`, visible 📝 attribution banner OUTSIDE the managed fence, manual `code2wiki claim` command, audit-log `claim` + `claim_aborted` op types.
- **Confluence renderer XSS hardening**: escape raw HTML in prose.
- **Publisher 429-retry wrapper** + edge-cases doc + scale-test scaffold.
- **Pandoc-style footnote transform** applied before both Confluence and Notion renderers so prose-step → source-line links carry through.

### Infrastructure + ops

- **CI auto-deploy** on push: `.github/workflows/deploy-dashboard.yml` + `.github/workflows/deploy-ocean-bot-dashboard.yml`. Path-filtered triggers, concurrency groups, fail-loud on missing `RAILWAY_TOKEN`.
- **Autonomous task-master loop** wired (durable scheduled task; fires hourly when REPL idle; commits locally only). Spec: `docs/autonomous-loop.md`. Operational journal: `memory/autonomous_loop_log.md`.
- **Ocean-bot LIVE in prod 2026-05-12**: autonomous-development agent running as macOS launchd service; dashboard at https://ocean-bot-dashboard-production.up.railway.app/. 26 code2wiki backlog items shipped through it across the 2026-05 sprint; 1 remains open (operator-only, the feedback-poll GitHub-Settings config which has since been completed too).

## Repo provenance

For the full hash-chained provenance of every shipped change, see `.code2wiki/audit.jsonl` (canonical, per-repo) or `/dashboard/audit` (mirrored from the dashboard's Postgres `audit_entries`).
