import { defineConfig } from "vitest/config";

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
    exclude: ["node_modules", "dist", "references"],
    testTimeout: 10000,
  },
});
