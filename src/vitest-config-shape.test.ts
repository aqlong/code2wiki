import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

// Regression guard for the root vitest config shape.
//
// 2026-05-21 CI went red on every commit for ~half a day because a bot
// iteration (commit 93336ca) added `tools/ocean-bot/**/*.test.ts` to the
// root vitest include. The bot tests import deps (drizzle-orm, react,
// playwright, next/server, next-auth/providers/github) that are installed
// under tools/ocean-bot/{*,dashboard}/node_modules but NOT in the root
// npm tree. The bug only manifests in CI (where deps are NOT hoisted to
// the root) and was invisible locally because the operator's local
// node_modules happens to have those deps hoisted.
//
// This test pins the root vitest config so any future re-introduction of
// the same misconfiguration trips a local + CI failure that names the
// exact root cause. The architecture invariant being defended:
//
//   - apps/dashboard, tools/ocean-bot, tools/ocean-bot/dashboard each
//     have their own package.json + vitest.config.ts + dedicated CI step
//     in .github/workflows/ci.yml.
//   - The root vitest run is for the CLI suite ONLY. Sub-package tests
//     run via their own CI steps with their own deps.
//
// If you genuinely need to add a sub-package test path to the root run,
// you must also add its deps to the root package.json. Otherwise this
// test will fail and the operator will know why.

const FORBIDDEN_INCLUDE_GLOBS = [
  "tools/ocean-bot/**/*.test.ts",
  "tools/ocean-bot/**/*.test.mjs",
  "tools/ocean-bot/**",
  "apps/**/*.test.ts",
  "apps/**/*.test.mjs",
  "apps/**",
];

const REQUIRED_EXCLUDE_PATHS = [
  "apps/**",
  "tools/ocean-bot/**",
];

describe("root vitest config", () => {
  it("does not include sub-package test paths (would 'Failed to load url' in CI)", async () => {
    const configPath = path.join(__dirname, "..", "vitest.config.ts");
    const src = await fs.readFile(configPath, "utf8");

    // Extract the `include:` array body. Simple text-search is sufficient
    // because the config is a hand-authored, single-export defineConfig.
    const includeMatch = src.match(/include:\s*\[([\s\S]*?)\]/);
    expect(includeMatch, "vitest.config.ts must have an `include:` array").toBeTruthy();
    const includeBody = includeMatch![1];

    for (const forbidden of FORBIDDEN_INCLUDE_GLOBS) {
      expect(
        includeBody,
        `root vitest include must NOT contain "${forbidden}". Sub-package tests run via their own CI step.`,
      ).not.toContain(`"${forbidden}"`);
      expect(
        includeBody,
        `root vitest include must NOT contain '${forbidden}'.`,
      ).not.toContain(`'${forbidden}'`);
    }
  });

  it("excludes sub-package directories from the root run (defense in depth)", async () => {
    const configPath = path.join(__dirname, "..", "vitest.config.ts");
    const src = await fs.readFile(configPath, "utf8");

    const excludeMatch = src.match(/exclude:\s*\[([\s\S]*?)\]/);
    expect(excludeMatch, "vitest.config.ts must have an `exclude:` array").toBeTruthy();
    const excludeBody = excludeMatch![1];

    for (const required of REQUIRED_EXCLUDE_PATHS) {
      const present =
        excludeBody.includes(`"${required}"`) || excludeBody.includes(`'${required}'`);
      expect(
        present,
        `root vitest exclude must contain "${required}" so sub-package tests are never crawled from root.`,
      ).toBe(true);
    }
  });
});
