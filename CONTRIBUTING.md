# Contributing to code2wiki

Thanks for thinking about contributing. This is a young project; the contribution surface is intentionally small while the design partner cohort is forming. Please read this file before opening any non-trivial PR.

## What's in scope for outside contributors

- **`src/`** (the OSS CLI: parser + LLM + publishers + audit log + extractor), this is the load-bearing OSS surface. Bug reports and PRs welcome.
- **`docs/`**, strategy, ADRs, architecture, getting-started. Doc PRs are particularly welcome.
- **`examples/`**, gold-standard hand-curated CFML and Java use-case outputs. Adding a new example is a high-leverage contribution; see "How to add a new example" in `examples/README.md`.

## What's out of scope (do not PR into these without asking first)

- **`tools/ocean-bot/**`**, the autonomous-development agent that helps drive this project's roadmap forward. Per CLAUDE.md "Ocean-bot rule #11," any diff touching this tree requires dashboard approval, even from interactive Claude Code sessions where the bot's classifier doesn't run. Treat changes here like changes to a publisher: small, reviewed, tested. Outside PRs that touch `tools/ocean-bot/**` will be redirected.
- **`apps/dashboard/**`**, the hosted SaaS. Strategy-aligned PRs may be accepted, but most evolution here is gated on customer feedback during the design-partner phase.
- **`.github/workflows/**`** that touch deployment, billing, or webhooks: these have production blast radius. File an issue first.

## Commit message conventions

Format: `scope: subject` or just `subject:` for cross-cutting changes.

- **Tense:** imperative present ("add", not "added")
- **First line ≤ 72 chars**, body wrapped at 72 chars
- **No em dashes anywhere** (project-wide rule; enforced by `tools/scripts/strip-em-dashes.py --check` in CI). Use commas, colons, semicolons, or new sentences.
- **`Co-Authored-By:` trailers** when an LLM session was a substantive collaborator.

Example:
```
core/parsers/cfml: strip /* */ block comments before script-fn detection

Round 2 of the wheels real-repo run (round 1 = b9c44e9). Same root
cause class: stripCfmlComments only handled <!--- ---> tag comments,
not cfscript /* */ block comments.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## Local dev workflow

1. **Tests must pass before any commit:** `npm test` (vitest, mocked HTTP + mocked LLM) and `npm run typecheck`. These are the only hard requirements for an outside PR.
2. **Em-dash check:** `python3 tools/scripts/strip-em-dashes.py --check`. CI hard-fails on any em dash.
3. **Recommended (not required) for parser changes: real-repo signal.** The most reliable way to verify a CFML or Java parser change is to run it against a real legacy codebase. Clone any public CF or Java repo into `references/<name>/` (gitignored per ADR-010), run `code2wiki generate --cwd references/<name> --limit 6 --mock`, eyeball the candidate list. If you have an `ANTHROPIC_API_KEY` and want to spend tokens, drop the `--mock` for real-LLM signal. Maintainers will re-run this in private if needed; an outside PR doesn't need to.
4. **Publisher changes:** every test must run with mocked HTTP via the injectable `fetch`. Do not introduce `node-fetch` or call `fetch` directly inside business logic.

See `CLAUDE.md` "Default code-change workflow" for the full loop including the deep self-review step (ADR-020) and the honest-completion gap sweep.

## Architectural decisions

This project records every significant architectural choice as an ADR in [`docs/decisions.md`](docs/decisions.md). Before proposing a structural change, read the relevant ADR(s); supersede with a new entry rather than editing past ones (see ADR-001/006/007 for the supersession pattern).

## License

MIT. See [LICENSE](LICENSE). Outside contributions are accepted under the same terms.

## Code of conduct

Be kind, be concise, assume good faith. Decisions are recorded in writing in the relevant ADR or memory file; if something feels wrong, push back in writing.
