import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractWithLLM, countTokens } from "./client.js";
import type { Candidate, Config } from "../types.js";

// LIVE DeepSeek integration test (env-gated; skipped without creds).
//
// What this does when gated on:
//   1. Routes a tiny inline Java fixture through extractWithLLM against
//      the real DeepSeek API (no module mock; per-file vi.mock from
//      client.test.ts does not leak here).
//   2. Asserts the response parses as JSON and carries the load-bearing
//      schema fields (title + at least one populated section).
//   3. Verifies countTokens throws the documented unsupported error.
//
// Skipped by default in CI (no creds). Opt-in for a developer with
// DeepSeek creds before shipping changes to client.ts.
//
// Run:
//   DEEPSEEK_API_KEY=... npm test -- src/core/llm/client.deepseek-live.test.ts

const HAS_DEEPSEEK_CREDS = !!process.env["DEEPSEEK_API_KEY"];

const D = HAS_DEEPSEEK_CREDS ? describe : describe.skip;

const JAVA_SOURCE = `@RestController
@RequestMapping("/api/orders")
public class OrderController {
  @PostMapping
  public ResponseEntity<Order> placeOrder(@RequestBody Order order) {
    Order saved = orderService.save(order);
    notificationService.sendConfirmation(saved.getCustomerEmail());
    return ResponseEntity.ok(saved);
  }
}`;

const CANDIDATE: Candidate = {
  language: "java",
  filePath: "/fake/OrderController.java",
  relativePath: "src/OrderController.java",
  name: "placeOrder",
  kind: "controller-method",
  lineStart: 4,
  lineEnd: 8,
  source: JAVA_SOURCE,
  hints: {
    annotations: ["@PostMapping", "@RestController"],
    httpRoute: { method: "POST", path: "/api/orders" },
    callees: ["save", "sendConfirmation"],
    notes: ["Sends email"],
  },
};

// Force DeepSeek routing even if other API keys are set.
const CONFIG: Config = {
  include: [],
  exclude: [],
  output: "./docs/use-cases",
  model: "deepseek-chat",
  mock: false,
  llmBackend: "deepseek",
  maxCandidates: 50,
  publish: {},
};

D("extractWithLLM: live DeepSeek round-trip", () => {
  beforeEach(() => {
    vi.stubEnv("CODE2WIKI_LLM_BACKEND", "");
    vi.stubEnv("CODE2WIKI_MOCK", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a structurally complete use case from a tiny Java fixture", async () => {
    const result = await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "deepseek-live-smoke",
      config: CONFIG,
    });

    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();

    const r = result as Record<string, unknown>;

    expect(typeof r["title"]).toBe("string");
    expect((r["title"] as string).trim().length).toBeGreaterThan(0);

    const hasSummary =
      typeof r["summary"] === "string" && (r["summary"] as string).length > 0;
    const hasMainFlow =
      Array.isArray(r["main_flow"]) && (r["main_flow"] as unknown[]).length > 0;
    const hasBusinessRules =
      Array.isArray(r["business_rules"]) &&
      (r["business_rules"] as unknown[]).length > 0;

    expect(hasSummary || hasMainFlow || hasBusinessRules).toBe(true);
  }, 120000);

  it("countTokens throws the Anthropic-only diagnostic on the DeepSeek backend", async () => {
    await expect(
      countTokens({
        candidate: CANDIDATE,
        projectName: "deepseek-live-smoke",
        config: CONFIG,
      }),
    ).rejects.toThrow(/estimate-cost.*not supported.*DeepSeek/i);
  });
});
