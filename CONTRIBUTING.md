# Contributing to code2wiki

Thanks for thinking about contributing. This file describes the contribution surface for the OSS CLI.

## What's in scope

- **`src/`**, the CLI: parsers, LLM client, publishers (Confluence + Notion), audit log, extractor
- **`examples/`**, gold-standard hand-curated CFML and Java use-case outputs
- Test improvements, bug fixes, doc clarifications
- New parser languages (see `src/core/parsers/` for the existing CFML + Java + Ruby + Django scanners)

## Local dev workflow

```bash
npm install
npm test           # vitest, mocked HTTP + mocked LLM
npm run typecheck  # tsc --noEmit
npm run build      # compile to dist/
```

Tests run without an LLM key (deterministic mock mode). Real LLM integration requires `ANTHROPIC_API_KEY`.

## Commit conventions

- Imperative present ("add", not "added")
- First line ≤ 72 chars, body wrapped at 72 chars
- No em dashes anywhere (project-wide rule); use commas, colons, semicolons, or new sentences
- `Co-Authored-By:` trailers when an LLM session was a substantive collaborator

## Real-repo signal for parser changes

The most reliable way to verify a CFML or Java parser change is to run it against a real legacy codebase. Clone any public CF or Java repo into `references/<name>/` (gitignored), run `code2wiki generate --cwd references/<name> --limit 6 --mock`, eyeball the candidate list. With `ANTHROPIC_API_KEY` set you can drop `--mock` for real-LLM signal.

## License

MIT. Outside contributions are accepted under the same terms.

## Code of conduct

Be kind, be concise, assume good faith.
