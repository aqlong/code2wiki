import { defineConfig } from "vitest/config";

// Root vitest runs the CLI test suite ONLY. Sub-packages with their own
// dependencies (apps/dashboard, tools/ocean-bot, tools/ocean-bot/dashboard)
// have their own vitest.config.ts + their own CI step that installs their
// deps. Including their test files here causes "Failed to load url <pkg>"
// errors at root because the sub-package node_modules are not in the root
// npm tree. See .github/workflows/ci.yml for the per-package steps.
//
// History: 2026-05-21 CI went red on every commit because
// `tools/ocean-bot/**/*.test.ts` was incorrectly listed in the include
// pattern, pulling in 14 test files whose imports (drizzle-orm, react,
// playwright, next/server, next-auth/providers/github) only resolve under
// the bot's own node_modules. Fix: drop the include + add sub-package dirs
// to exclude as defense-in-depth against future include-glob widening.

export default defineConfig({
  test: {
    globals: false,
    include: [
      "src/**/*.test.ts",
      "tools/scripts/**/*.test.ts",
      "tools/**/*.test.mjs",
      // Operator-run smoke / scale tests (gated internally on env vars
      // like CODE2WIKI_PUBLISHER_SMOKE_URL; skipped cleanly otherwise).
      "tests/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "dist",
      "references",
      // Sub-packages run their own tests via dedicated CI steps; do not
      // crawl them from the root run.
      "apps/**",
      "tools/ocean-bot/**",
    ],
    testTimeout: 60000,
    // Match hookTimeout to testTimeout. 30 s was too tight under full-suite
    // parallel load (52 workers): git.test.ts beforeAll hooks each commit
    // 2-3x via git subprocesses (~39 s observed), and preview/publish test
    // bodies hit 33-55 s. A timed-out test skips its afterEach env-var
    // cleanup, contaminating the next test (the publish.test.ts
    // "spy called 2 times" cascade shape). 60 s gives comfortable headroom.
    hookTimeout: 60000,
  },
});
