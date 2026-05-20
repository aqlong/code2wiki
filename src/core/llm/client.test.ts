import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Candidate, Config } from "../types.js";

// vi.mock is hoisted. To inspect what extractWithLLM + countTokens pass to
// the Anthropic SDK + what they do with the response, we hoist shared spies
// for messages.create and messages.countTokens plus a constructor spy that
// records the apiKey passed at instantiation. All tests share the same spies;
// resetMocks in beforeEach clears state.
const { messagesCreate, messagesCountTokens, anthropicCtor } = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
  messagesCountTokens: vi.fn(),
  anthropicCtor: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation((opts: { apiKey?: string }) => {
    anthropicCtor(opts);
    return {
      messages: { create: messagesCreate, countTokens: messagesCountTokens },
    };
  }),
}));

import { extractWithLLM, countTokens } from "./client.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompts.js";

const CANDIDATE: Candidate = {
  language: "java",
  filePath: "/nonexistent/path/Hello.java",
  relativePath: "Hello.java",
  name: "hello",
  kind: "controller-method",
  lineStart: 10,
  lineEnd: 20,
  source: `public String hello() { return "world"; }`,
  hints: {
    annotations: ["@GetMapping"],
    httpRoute: { method: "GET", path: "" },
  },
};

const CONFIG: Config = {
  include: [],
  exclude: [],
  output: "./docs/use-cases",
  model: "claude-sonnet-4-6",
  mock: false,
  maxCandidates: 50,
  publish: {},
};

function textBlocks(...parts: string[]) {
  return { content: parts.map((text) => ({ type: "text" as const, text })) };
}

beforeEach(() => {
  messagesCreate.mockReset();
  messagesCountTokens.mockReset();
  anthropicCtor.mockReset();
  // Default to "SDK path is reachable"; every test that wants mock mode
  // overrides exactly one of the three gates.
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubEnv("CODE2WIKI_MOCK", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("extractWithLLM: mock-mode selection", () => {
  it("returns mockExtract output when config.mock=true even with a valid API key set", async () => {
    const result = (await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: { ...CONFIG, mock: true },
    })) as Record<string, unknown>;
    expect(String(result["title"])).toMatch(/DRAFT/);
    expect(result["tags"]).toContain("mock-output");
    // SDK must NEVER instantiate or be invoked on the mock path.
    expect(anthropicCtor).not.toHaveBeenCalled();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("returns mockExtract output when CODE2WIKI_MOCK='1' even with a valid API key set", async () => {
    vi.stubEnv("CODE2WIKI_MOCK", "1");
    const result = (await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    })) as Record<string, unknown>;
    expect(result["tags"]).toContain("mock-output");
    expect(anthropicCtor).not.toHaveBeenCalled();
  });

  it("does NOT trigger mock when CODE2WIKI_MOCK is set to '0' (literal '1' comparison, not truthiness)", async () => {
    // A regression to truthy-check on CODE2WIKI_MOCK would force mock mode
    // whenever the env var is "0", "false", or any non-empty string, which
    // would silently break real-LLM runs whose CI sets CODE2WIKI_MOCK=0 for
    // disambiguation. Pin the literal === "1" semantics.
    vi.stubEnv("CODE2WIKI_MOCK", "0");
    messagesCreate.mockResolvedValueOnce(textBlocks(`{"ok":true}`));
    await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    });
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });

  it("returns mockExtract output when ANTHROPIC_API_KEY is missing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const result = (await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    })) as Record<string, unknown>;
    expect(result["tags"]).toContain("mock-output");
    expect(anthropicCtor).not.toHaveBeenCalled();
  });

  it("invokes the SDK when all three mock gates are false", async () => {
    messagesCreate.mockResolvedValueOnce(textBlocks(`{"ok":true}`));
    const result = await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    });
    expect(result).toEqual({ ok: true });
    expect(anthropicCtor).toHaveBeenCalledTimes(1);
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });
});

describe("extractWithLLM: Anthropic SDK call shape", () => {
  it("instantiates Anthropic with the apiKey from process.env", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-123");
    messagesCreate.mockResolvedValueOnce(textBlocks(`{}`));
    await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    });
    expect(anthropicCtor).toHaveBeenCalledWith({ apiKey: "sk-ant-test-123" });
  });

  it("passes config.model through to messages.create", async () => {
    messagesCreate.mockResolvedValueOnce(textBlocks(`{}`));
    await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: { ...CONFIG, model: "claude-opus-4-7" },
    });
    expect(messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-4-7" }),
    );
  });

  it("pins max_tokens=4096 (cost guardrail)", async () => {
    // A regression bumping max_tokens to 8192/16384/64000 would 2-16x the
    // worst-case output cost per page silently. Pin the literal.
    messagesCreate.mockResolvedValueOnce(textBlocks(`{}`));
    await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    });
    expect(messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 4096 }),
    );
  });

  it("sends the SYSTEM_PROMPT as a single text block with ephemeral cache_control", async () => {
    // Prompt-cache hit is load-bearing: a 90% discount on cached input
    // tokens. A regression that drops cache_control, switches to a string
    // system prompt, or changes the cache_type would 10x system-prompt
    // cost per call on the second run onward.
    messagesCreate.mockResolvedValueOnce(textBlocks(`{}`));
    await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    });
    const call = messagesCreate.mock.calls[0]?.[0] as {
      system: Array<{ type: string; text: string; cache_control: { type: string } }>;
    };
    expect(call.system).toHaveLength(1);
    expect(call.system[0]).toEqual({
      type: "text",
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    });
  });

  it("sends a single user message with role='user' and the buildUserPrompt body", async () => {
    messagesCreate.mockResolvedValueOnce(textBlocks(`{}`));
    await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    });
    const call = messagesCreate.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0]?.role).toBe("user");
    expect(call.messages[0]?.content).toBe(
      buildUserPrompt(CANDIDATE, "demo"),
    );
  });
});

describe("extractWithLLM, retry hint append", () => {
  it("omits the '---' separator when retryHint is not provided", async () => {
    messagesCreate.mockResolvedValueOnce(textBlocks(`{}`));
    await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    });
    const call = messagesCreate.mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
    };
    expect(call.messages[0]?.content).not.toMatch(/\n---\n/);
  });

  it("appends retryHint after '\\n\\n---\\n\\n' so the base prompt prefix is cache-stable", async () => {
    // Comment in client.ts explicitly calls out the cache-friendliness
    // contract: "the system prompt + main user prompt stay identical, only
    // the trailing hint differs". Pin both halves: (a) base prompt verbatim
    // BEFORE the separator (b) separator + hint suffix AFTER.
    const hint = "VALIDATOR: title is empty";
    messagesCreate.mockResolvedValueOnce(textBlocks(`{}`));
    await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
      retryHint: hint,
    });
    const content = (messagesCreate.mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
    }).messages[0]?.content;
    const base = buildUserPrompt(CANDIDATE, "demo");
    expect(content).toBe(`${base}\n\n---\n\n${hint}`);
    expect(content?.startsWith(base)).toBe(true);
    expect(content?.endsWith(`\n\n---\n\n${hint}`)).toBe(true);
  });

  it("treats empty-string retryHint as no hint (falsy-check pin)", async () => {
    messagesCreate.mockResolvedValueOnce(textBlocks(`{}`));
    await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
      retryHint: "",
    });
    const content = (messagesCreate.mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
    }).messages[0]?.content;
    expect(content).not.toMatch(/\n---\n/);
  });
});

describe("extractWithLLM, response parsing", () => {
  it("joins multiple text blocks in order before parsing JSON", async () => {
    messagesCreate.mockResolvedValueOnce(textBlocks(`{"a":1,`, `"b":2}`));
    const result = await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("filters non-text blocks (e.g. tool_use), emits empty string for them and parses the rest", async () => {
    // The block-filter is `block.type === "text" ? block.text : ""`. A
    // regression to `(block as { text: string }).text` would crash on a
    // tool_use block (no .text). Pin via a mixed-block response.
    messagesCreate.mockResolvedValueOnce({
      content: [
        { type: "text", text: `{"ok"` },
        { type: "tool_use", id: "tu_1", name: "x", input: {} },
        { type: "text", text: `:true}` },
      ],
    });
    const result = await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    });
    expect(result).toEqual({ ok: true });
  });

  it("parses plain JSON with no code fence", async () => {
    messagesCreate.mockResolvedValueOnce(textBlocks(`{"k":"v"}`));
    const result = await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    });
    expect(result).toEqual({ k: "v" });
  });

  it("strips a ```json prefix and trailing ```", async () => {
    messagesCreate.mockResolvedValueOnce(
      textBlocks("```json\n" + `{"k":"v"}` + "\n```"),
    );
    const result = await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    });
    expect(result).toEqual({ k: "v" });
  });

  it("strips a bare ``` prefix (no language)", async () => {
    messagesCreate.mockResolvedValueOnce(
      textBlocks("```\n" + `{"k":"v"}` + "\n```"),
    );
    const result = await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    });
    expect(result).toEqual({ k: "v" });
  });

  it("strips case-insensitively (```JSON, ```Json)", async () => {
    // The regex literal `/^```(?:json)?\s*/i` documents the case-insensitive
    // intent; pin it so a regression dropping the `i` flag silently breaks
    // Claude outputs that happen to capitalize the fence language.
    messagesCreate.mockResolvedValueOnce(
      textBlocks("```JSON\n" + `{"a":1}` + "\n```"),
    );
    const a = await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    });
    expect(a).toEqual({ a: 1 });

    messagesCreate.mockResolvedValueOnce(
      textBlocks("```Json\n" + `{"b":2}` + "\n```"),
    );
    const b = await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    });
    expect(b).toEqual({ b: 2 });
  });

  it("trims surrounding whitespace before fence stripping", async () => {
    messagesCreate.mockResolvedValueOnce(
      textBlocks("\n\n   ```json\n" + `{"k":"v"}` + "\n```   \n\n"),
    );
    const result = await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    });
    expect(result).toEqual({ k: "v" });
  });

  it("throws with the first-200-chars prefix on invalid JSON", async () => {
    const bad = "this is not JSON " + "x".repeat(500);
    messagesCreate.mockResolvedValueOnce(textBlocks(bad));
    await expect(
      extractWithLLM({
        candidate: CANDIDATE,
        projectName: "demo",
        config: CONFIG,
      }),
    ).rejects.toThrow(/LLM did not return valid JSON/);
    // Re-run to inspect the prefix slice; the 200-char window is load-bearing
    // for log/triage UX so we pin both ends.
    messagesCreate.mockResolvedValueOnce(textBlocks(bad));
    try {
      await extractWithLLM({
        candidate: CANDIDATE,
        projectName: "demo",
        config: CONFIG,
      });
      expect.fail("expected throw");
    } catch (e) {
      const msg = (e as Error).message;
      // Cleaned body starts after trim/fence-strip; here neither trim nor
      // strip changes the input. Assert: contains the leading text AND does
      // NOT include character 200+ (the x at index ~217 should be cut off).
      expect(msg).toContain("this is not JSON");
      // First 200 chars of cleaned input = "this is not JSON " (17) + "x" * 183.
      // Char at index 200 of `bad` (0-indexed) is "x"; we want the message
      // to be exactly cleaned.slice(0, 200) long after the fixed prefix.
      const sliced = bad.slice(0, 200);
      expect(msg).toContain(sliced);
      expect(msg).not.toContain(bad.slice(0, 201));
    }
  });
});

describe("countTokens, two-call subtract-for-system math", () => {
  it("throws and never instantiates Anthropic when ANTHROPIC_API_KEY is missing", async () => {
    // Pin the early-bail: pre-flight cost estimation must NOT silently
    // construct the SDK with an undefined apiKey (which would surface as a
    // confusing 401 instead of the actionable "set ANTHROPIC_API_KEY" message).
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(
      countTokens({ candidate: CANDIDATE, projectName: "demo", config: CONFIG }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(anthropicCtor).not.toHaveBeenCalled();
    expect(messagesCountTokens).not.toHaveBeenCalled();
  });

  it("instantiates Anthropic with the apiKey from process.env", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-456");
    messagesCountTokens
      .mockResolvedValueOnce({ input_tokens: 100 })
      .mockResolvedValueOnce({ input_tokens: 40 });
    await countTokens({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    });
    expect(anthropicCtor).toHaveBeenCalledWith({ apiKey: "sk-ant-test-456" });
  });

  it("isolates systemTokens by subtracting the user-only count from the total", async () => {
    // The math is `systemTokens = total - user`. A regression swapping the
    // operands (`user - total`) would produce a negative systemTokens and
    // downstream cost would underflow. A regression returning total directly
    // (skipping subtraction) would double-count the user contribution and
    // inflate cached-input cost. Pin both directions with one orthogonal pair.
    messagesCountTokens
      .mockResolvedValueOnce({ input_tokens: 1000 }) // total: system + user
      .mockResolvedValueOnce({ input_tokens: 300 }); // user-only
    const result = await countTokens({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    });
    expect(result).toEqual({ systemTokens: 700, userTokens: 300 });
  });

  it("passes config.model through to both countTokens calls", async () => {
    messagesCountTokens
      .mockResolvedValueOnce({ input_tokens: 500 })
      .mockResolvedValueOnce({ input_tokens: 200 });
    await countTokens({
      candidate: CANDIDATE,
      projectName: "demo",
      config: { ...CONFIG, model: "claude-opus-4-7" },
    });
    expect(messagesCountTokens).toHaveBeenCalledTimes(2);
    expect(messagesCountTokens.mock.calls[0]?.[0]).toMatchObject({
      model: "claude-opus-4-7",
    });
    expect(messagesCountTokens.mock.calls[1]?.[0]).toMatchObject({
      model: "claude-opus-4-7",
    });
  });

  it("includes SYSTEM_PROMPT in the total call and OMITS it from the user-only call", async () => {
    // The two-call subtract-for-system math is only correct when the second
    // call is genuinely user-only. A regression sending the system on BOTH
    // calls would produce systemTokens=0 (always); a regression sending it on
    // NEITHER would produce systemTokens=0 for a different reason and silently
    // strip the cache discount from --estimate-cost output. Pin both halves.
    messagesCountTokens
      .mockResolvedValueOnce({ input_tokens: 800 })
      .mockResolvedValueOnce({ input_tokens: 250 });
    await countTokens({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    });
    const totalCall = messagesCountTokens.mock.calls[0]?.[0] as {
      system?: Array<{ type: string; text: string }>;
      messages: Array<{ role: string; content: string }>;
    };
    const userCall = messagesCountTokens.mock.calls[1]?.[0] as {
      system?: Array<{ type: string; text: string }>;
      messages: Array<{ role: string; content: string }>;
    };
    expect(totalCall.system).toEqual([{ type: "text", text: SYSTEM_PROMPT }]);
    expect(userCall.system).toBeUndefined();
    // User payload must be identical on both calls so the subtraction is
    // valid (subtracting two different user prompts would conflate
    // system-token isolation with prompt drift).
    expect(totalCall.messages).toEqual(userCall.messages);
    expect(userCall.messages).toEqual([
      { role: "user", content: buildUserPrompt(CANDIDATE, "demo") },
    ]);
  });

  it("never invokes messages.create (pre-flight cost guardrail, non-billed only)", async () => {
    // The whole point of countTokens is to project cost WITHOUT a billed
    // extraction. A regression that accidentally chained messages.create
    // after countTokens would silently start billing on every --estimate-cost
    // run. Pin the no-create invariant.
    messagesCountTokens
      .mockResolvedValueOnce({ input_tokens: 500 })
      .mockResolvedValueOnce({ input_tokens: 200 });
    await countTokens({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    });
    expect(messagesCreate).not.toHaveBeenCalled();
  });
});
