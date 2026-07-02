import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractWithLLM, countTokens } from "./client.js";
import type { Candidate, Config } from "../types.js";

// LIVE Azure OpenAI integration test (env-gated; skipped without creds).
//
// What this does when gated on:
//   1. Routes a tiny inline Java fixture through extractWithLLM against
//      the real Azure OpenAI SDK (no module mock; per-file vi.mock from
//      client.test.ts does not leak here).
//   2. Asserts the response parses as JSON and carries the load-bearing
//      schema fields (title + at least one populated section).
//   3. Verifies countTokens throws the documented Azure-unsupported
//      error so a regression that quietly tried to count against Azure
//      would trip here.
//
// Why this is split out from client.test.ts:
//   - client.test.ts mocks `openai` via vi.mock at the module top; the
//     real Azure SDK is never imported. This file does NOT mock anything,
//     so the real SDK + a real round-trip exercise the wiring.
//   - Real network call (typically 1-10 s) and real Azure token cost
//     (~$0.001-$0.05 per run at the tiny fixture size, depending on
//     deployment and whether the model is o-series reasoning).
//   - Skipped by default in CI (no creds in CI env), opt-in for a
//     developer with Azure creds before shipping changes to client.ts.
//
// Gating:
//   AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT must both be set.
//   AZURE_OPENAI_DEPLOYMENT is strongly recommended; without it the code
//   falls back to config.model (a claude-* name) which Azure will 404.
//
// Run:
//   AZURE_OPENAI_API_KEY=... AZURE_OPENAI_ENDPOINT=... \
//     AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini \
//     npm test -- src/core/llm/client.azure-live.test.ts

const HAS_AZURE_CREDS =
  !!process.env["AZURE_OPENAI_API_KEY"] &&
  !!process.env["AZURE_OPENAI_ENDPOINT"];

const D = HAS_AZURE_CREDS ? describe : describe.skip;

// Tiny Java controller method: one HTTP handler, one downstream call,
// one side effect (email). Small enough to bound token cost; semantic
// enough that the LLM produces a non-trivial use case with at least a
// title and one section.
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

// Force Azure routing even if the operator also has ANTHROPIC_API_KEY
// set. llmBackend: "azure-openai" makes resolveBackend call
// validateAzureEnv(), which requires the Azure env vars to be set
// (already gated above).
const CONFIG: Config = {
  include: [],
  exclude: [],
  output: "./docs/use-cases",
  model: "claude-sonnet-4-6", // ignored on Azure path; AZURE_OPENAI_DEPLOYMENT wins
  mock: false,
  llmBackend: "azure-openai",
  maxCandidates: 50,
  publish: {},
};

D("extractWithLLM: live Azure OpenAI round-trip", () => {
  beforeEach(() => {
    // Defend against operator env overrides that would re-route away
    // from Azure: CODE2WIKI_LLM_BACKEND env wins over config.llmBackend,
    // and CODE2WIKI_MOCK=1 short-circuits before any backend check.
    // Clearing both means resolveBackend honors config.llmBackend.
    vi.stubEnv("CODE2WIKI_LLM_BACKEND", "");
    vi.stubEnv("CODE2WIKI_MOCK", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a structurally complete use case from a tiny Java fixture", async () => {
    const result = await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "azure-live-smoke",
      config: CONFIG,
    });

    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();

    const r = result as Record<string, unknown>;

    // Load-bearing: title must be a non-empty string. Pinned because
    // every renderer + publisher derives the page title from this field;
    // an empty title silently breaks every downstream consumer.
    expect(typeof r["title"]).toBe("string");
    expect((r["title"] as string).trim().length).toBeGreaterThan(0);

    // At least one substantive section populated (summary OR main_flow
    // OR business_rules). LLM output is non-deterministic, so don't pin
    // the exact field, only the contract that the model produced more
    // than just a title. A regression where the model returns
    // `{"title":"X"}` and nothing else would fail here.
    const hasSummary =
      typeof r["summary"] === "string" && (r["summary"] as string).length > 0;
    const hasMainFlow =
      Array.isArray(r["main_flow"]) && (r["main_flow"] as unknown[]).length > 0;
    const hasBusinessRules =
      Array.isArray(r["business_rules"]) &&
      (r["business_rules"] as unknown[]).length > 0;

    expect(hasSummary || hasMainFlow || hasBusinessRules).toBe(true);
  }, 120000);

  it("countTokens throws the Anthropic-only diagnostic on the Azure backend", async () => {
    await expect(
      countTokens({
        candidate: CANDIDATE,
        projectName: "azure-live-smoke",
        config: CONFIG,
      }),
    ).rejects.toThrow(/estimate-cost.*not supported.*Azure/i);
  });
});
