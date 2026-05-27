# Getting started with code2wiki (for customers)

This guide is for **hosted code2wiki customers**, you signed up at the dashboard and want to get from "nothing" to "use-case docs in our wiki" in under 15 minutes. If you're self-hosting the open-source CLI, the [README quickstart](../README.md#quickstart) is the right starting point.

## What you'll have at the end

- Auto-generated use-case Markdown for every push to your repo's default branch
- A browsable preview of each page styled like Confluence and Notion before you publish
- Generated pages auto-pushed into your Confluence space or Notion database, with the parts you edit preserved across regenerations
- An append-only audit log of every generate + publish action, attributable per commit (SOX / HIPAA friendly)

## The four steps

### 1. Install the GitHub App and enable a repo

Go to [`/dashboard/repos`](https://code2wiki-app-production.up.railway.app/dashboard/repos). If you haven't installed the GitHub App yet, the page walks you through it. Pick the repos you want documented; you can install on a single repo or your whole org. The app needs `Contents R/W` (to read source + write generated pages back as a PR) and `Pull-Requests R/W`. No other scopes.

Once installed, every repo in the install shows up on this page with an **Enable** button. Click it on the repos you actually want code2wiki to run on. (A repo with the app installed but `Enabled = off` is dormant; no runs fire.)

### 2. Push to main, or trigger a run manually

**Auto-trigger:** every push to the repo's default branch fires a run. No further action needed.

**Manual trigger:** on [`/dashboard/repos`](https://code2wiki-app-production.up.railway.app/dashboard/repos), each enabled repo shows a **Sync now** button next to its Enable toggle. Click it to queue a run against the current HEAD of the default branch. Useful for:
- Backfilling docs on a repo you just enabled
- Re-running after you change your Confluence / Notion connection
- Testing what code2wiki produces before you commit

Either way, the run appears on [`/dashboard/runs`](https://code2wiki-app-production.up.railway.app/dashboard/runs) within a few seconds.

### 3. Preview each generated page

Open any run from [`/dashboard/runs`](https://code2wiki-app-production.up.railway.app/dashboard/runs) and click into individual pages. Each page has three tabs:
- **Markdown**: the raw source we'd commit to your repo
- **Confluence preview**: a lookalike of what your space would render
- **Notion preview**: a lookalike of what your database would render

Nothing is published from the preview. This is a sanity-check surface, look at a few pages, see if the actor / main flow / business rules read like docs your BAs would actually consume.

Each page also shows a **confidence** rating (high / medium / low) so you can spot pages the LLM was uncertain about and review them first.

### 4. Connect your wiki and let publish happen

Go to [`/dashboard/settings/connections`](https://code2wiki-app-production.up.railway.app/dashboard/settings/connections) and connect either Confluence or Notion (or both). The form asks for:
- **Confluence:** base URL, your Atlassian email, API token, space key
- **Notion:** integration token, database ID

Atlassian and Notion both have first-party guides for creating these tokens. The relevant ones:
- [Atlassian API token guide](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/)
- [Notion integrations guide](https://developers.notion.com/docs/create-a-notion-integration)

(The hosted dashboard stores these encrypted at rest. If you're self-hosting and need the operator-side setup steps, see [`apps/dashboard/SETUP.md`](../apps/dashboard/SETUP.md).)

Once a connection is saved with `Connected = green`, the next run pushes pages into your space / database. Re-running against the same source produces an **update**, not a duplicate; the page's stable identifier and slug are derived from the source code, not the title.

## What gets preserved when you edit a published page

Every published page is wrapped in a managed fence:

```
<!-- code2wiki:managed:start -->
... auto-generated content ...
<!-- code2wiki:managed:end -->
```

**Content inside the fence is regenerated on every run.** Edits to it disappear at the next run, which is correct: they'd disagree with the source code.

**Content outside the fence is preserved.** Add reviewer notes, sign-offs, links to tickets, whatever you want at the top or bottom of the page; they survive forever.

Every page also gets a 📝 attribution banner at the top identifying it as auto-generated, with a link back to the source code at the exact commit it was generated from.

## Knowing the LLM bill before you run

The CLI ships a `--estimate-cost` flag (commit `260dac9`). For self-hosted runs:

```bash
node dist/cli/index.js generate --cwd /path/to/repo --estimate-cost
```

It scans your repo, counts tokens via Anthropic's non-billed `messages.countTokens` endpoint, projects 3000 output tokens per page, applies $3/MTok input and $15/MTok output pricing (with a 50% discount on the cached system prompt), and prints a total in USD. **No LLM call is made; no files are written.** Pass `--limit N` to cap before re-running.

On the hosted dashboard, a per-run cost summary is shown after each run; an explicit pre-flight estimate from the dashboard UI is coming soon.

## Audit log and replay

Every generate and publish action lands as a hash-chained entry in your repo's `.code2wiki/audit.jsonl` (and is mirrored to [`/dashboard/audit`](https://code2wiki-app-production.up.railway.app/dashboard/audit) for browsing). The chain detects tampering: an auditor can run `code2wiki audit verify` to confirm no entry has been edited.

If we update the prompt, you can re-run every prior page through the new version and see the diff with `code2wiki replay --since-version <old-version>`. Read-only; never publishes.

## Where to get help

- **Per-page surfaces:** the cards on [`/dashboard`](https://code2wiki-app-production.up.railway.app/dashboard) link to every substantive surface (runs, audit, feedback, calibration, connections, billing, architecture).
- **Glossary:** the "Key concepts" section at the bottom of [`/dashboard`](https://code2wiki-app-production.up.railway.app/dashboard) explains the managed fence, attribution banner, confidence ratings, and audit chain.
- **Issues:** the [code2wiki GitHub repo](https://github.com/craftandship/code2wiki) is open for bug reports + feature requests.
