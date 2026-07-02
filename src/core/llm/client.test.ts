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

const { deepseekChatCreate, deepseekOpenAICtor } = vi.hoisted(() => ({
  deepseekChatCreate: vi.fn(),
  deepseekOpenAICtor: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation((opts: { apiKey?: string }) => {
    anthropicCtor(opts);
    return {
      messages: { create: messagesCreate, countTokens: messagesCountTokens },
    };
  }),
}));

// Azure OpenAI SDK spies, hoisted so vi.mock can reference them.
const { azureChatCreate, azureOpenAICtor } = vi.hoisted(() => ({
  azureChatCreate: vi.fn(),
  azureOpenAICtor: vi.fn(),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(
    (opts: { apiKey?: string; baseURL?: string }) => {
      deepseekOpenAICtor(opts);
      return { chat: { completions: { create: deepseekChatCreate } } };
    },
  ),
  AzureOpenAI: vi
    .fn()
    .mockImplementation(
      (opts: {
        apiKey?: string;
        endpoint?: string;
        deployment?: string;
        apiVersion?: string;
      }) => {
        azureOpenAICtor(opts);
        return { chat: { completions: { create: azureChatCreate } } };
      },
    ),
}));

import { extractWithLLM, countTokens, resolveBackend } from "./client.js";
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
  llmBackend: "auto",
  maxCandidates: 50,
  publish: {},
};

function textBlocks(...parts: string[]) {
  return { content: parts.map((text) => ({ type: "text" as const, text })) };
}

/** OpenAI-style chat completion response. */
function chatResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

beforeEach(() => {
  messagesCreate.mockReset();
  messagesCountTokens.mockReset();
  anthropicCtor.mockReset();
  azureChatCreate.mockReset();
  azureOpenAICtor.mockReset();
  deepseekChatCreate.mockReset();
  deepseekOpenAICtor.mockReset();
  // Default to "Anthropic SDK path is reachable"; every test that wants mock
  // mode or Azure/DeepSeek mode overrides exactly what it needs.
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubEnv("CODE2WIKI_MOCK", "");
  vi.stubEnv("CODE2WIKI_LLM_BACKEND", "");
  // Clear Azure env vars so tests that don't set them don't accidentally
  // trigger the Azure path.
  vi.stubEnv("AZURE_OPENAI_API_KEY", "");
  vi.stubEnv("AZURE_OPENAI_ENDPOINT", "");
  vi.stubEnv("AZURE_OPENAI_DEPLOYMENT", "");
  vi.stubEnv("AZURE_OPENAI_API_VERSION", "");
  vi.stubEnv("AZURE_OPENAI_MAX_COMPLETION_TOKENS", "");
  // Clear DeepSeek env vars so tests that don't set them don't accidentally
  // trigger the DeepSeek path.
  vi.stubEnv("DEEPSEEK_API_KEY", "");
  vi.stubEnv("DEEPSEEK_BASE_URL", "");
  vi.stubEnv("DEEPSEEK_MODEL", "");
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

  it("throws on prefixed text + fenced JSON (model adds chatty preamble)", async () => {
    // A regression where someone "improves" parseJsonObject to greedily
    // extract any { ... } block could silently swallow this and pretend
    // it worked. Pin the strict-fence-only contract: the regex strips a
    // leading fence ONLY when it's at the very start (after trim).
    const prefixed =
      "Here is the JSON you asked for:\n```json\n" + `{"k":"v"}` + "\n```";
    messagesCreate.mockResolvedValueOnce(textBlocks(prefixed));
    await expect(
      extractWithLLM({
        candidate: CANDIDATE,
        projectName: "demo",
        config: CONFIG,
      }),
    ).rejects.toThrow(/LLM did not return valid JSON/);
  });

  it("throws a max_tokens diagnostic on empty content (Anthropic path, mirrors Azure length-cap)", async () => {
    // A truncated response (budget exhausted before any visible text) must
    // surface the cause, not the generic "did not return valid JSON" with an
    // empty snippet that parseJsonObject('') would otherwise throw.
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "" }],
      stop_reason: "max_tokens",
    });
    await expect(
      extractWithLLM({
        candidate: CANDIDATE,
        projectName: "demo",
        config: CONFIG,
      }),
    ).rejects.toThrow(/Anthropic returned empty content\. stop_reason=max_tokens/);
  });

  it("throws a refusal diagnostic on empty content with stop_reason=refusal", async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [],
      stop_reason: "refusal",
    });
    await expect(
      extractWithLLM({
        candidate: CANDIDATE,
        projectName: "demo",
        config: CONFIG,
      }),
    ).rejects.toThrow(/Anthropic returned empty content\. stop_reason=refusal/);
  });

  it("falls back to stop_reason=unknown when content is empty and stop_reason is absent", async () => {
    messagesCreate.mockResolvedValueOnce({ content: [] });
    await expect(
      extractWithLLM({
        candidate: CANDIDATE,
        projectName: "demo",
        config: CONFIG,
      }),
    ).rejects.toThrow(/Anthropic returned empty content\. stop_reason=unknown/);
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

// ── resolveBackend ────────────────────────────────────────────────────────────

describe("resolveBackend", () => {
  it("returns 'mock' when config.mock=true, regardless of env vars", () => {
    expect(resolveBackend({ ...CONFIG, mock: true })).toBe("mock");
  });

  it("returns 'mock' when CODE2WIKI_MOCK=1", () => {
    vi.stubEnv("CODE2WIKI_MOCK", "1");
    expect(resolveBackend(CONFIG)).toBe("mock");
  });

  it("returns 'anthropic' when ANTHROPIC_API_KEY is set and no Azure override", () => {
    expect(resolveBackend(CONFIG)).toBe("anthropic");
  });

  it("returns 'mock' when neither Anthropic nor Azure creds are present", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(resolveBackend(CONFIG)).toBe("mock");
  });

  it("returns 'azure-openai' when CODE2WIKI_LLM_BACKEND=azure-openai and Azure creds are set", () => {
    vi.stubEnv("CODE2WIKI_LLM_BACKEND", "azure-openai");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "az-key");
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com");
    expect(resolveBackend(CONFIG)).toBe("azure-openai");
  });

  it("throws when CODE2WIKI_LLM_BACKEND=azure-openai but Azure creds are missing", () => {
    vi.stubEnv("CODE2WIKI_LLM_BACKEND", "azure-openai");
    expect(() => resolveBackend(CONFIG)).toThrow(/AZURE_OPENAI_API_KEY/);
  });

  it("throws when config.llmBackend=azure-openai but Azure creds are missing (error mentions config.json, not just CODE2WIKI_LLM_BACKEND)", () => {
    // validateAzureEnv() is called from two code paths: the CODE2WIKI_LLM_BACKEND
    // env-var path AND the config.llmBackend path. The error advice must be
    // accurate for both. A regression that only mentioned "remove
    // CODE2WIKI_LLM_BACKEND" would be misleading when the user's trigger was
    // the config file instead.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(() =>
      resolveBackend({ ...CONFIG, llmBackend: "azure-openai" }),
    ).toThrow(/code2wiki\.config\.json/);
  });

  it("returns 'azure-openai' when config.llmBackend=azure-openai and Azure creds are set", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "az-key");
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com");
    expect(resolveBackend({ ...CONFIG, llmBackend: "azure-openai" })).toBe("azure-openai");
  });

  it("auto-detects azure-openai when Azure creds present and ANTHROPIC_API_KEY is absent", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "az-key");
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com");
    expect(resolveBackend(CONFIG)).toBe("azure-openai");
  });

  it("prefers anthropic over azure-openai in auto mode when both keys are present", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-xxx");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "az-key");
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com");
    expect(resolveBackend(CONFIG)).toBe("anthropic");
  });

  it("CODE2WIKI_LLM_BACKEND env var overrides config.llmBackend", () => {
    vi.stubEnv("CODE2WIKI_LLM_BACKEND", "anthropic");
    // Even if config says azure-openai, env var wins
    expect(resolveBackend({ ...CONFIG, llmBackend: "azure-openai" })).toBe("anthropic");
  });

  it("throws on a typo'd CODE2WIKI_LLM_BACKEND instead of silently auto-detecting", () => {
    // Operator meant "azure-openai" but dropped "-openai". Without the guard
    // this silently falls through to auto-detect and (with ANTHROPIC_API_KEY
    // also set) routes to Anthropic, the wrong provider on the wrong bill.
    vi.stubEnv("CODE2WIKI_LLM_BACKEND", "azure");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "az-key");
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com");
    expect(() => resolveBackend(CONFIG)).toThrow(/CODE2WIKI_LLM_BACKEND must be one of/);
  });

  it("treats CODE2WIKI_LLM_BACKEND='auto' (and empty) as auto-detect, not a typo", () => {
    // "auto" is an explicit, valid pass-through (the config enum accepts it
    // too); it must NOT throw. Empty string is the unset sentinel.
    vi.stubEnv("CODE2WIKI_LLM_BACKEND", "auto");
    expect(resolveBackend(CONFIG)).toBe("anthropic");
    vi.stubEnv("CODE2WIKI_LLM_BACKEND", "");
    expect(resolveBackend(CONFIG)).toBe("anthropic");
  });

  // ── DeepSeek resolveBackend tests ────────────────────────────────────────────

  it("returns 'deepseek' when CODE2WIKI_LLM_BACKEND=deepseek and DEEPSEEK_API_KEY is set", () => {
    vi.stubEnv("CODE2WIKI_LLM_BACKEND", "deepseek");
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-ds-test-123");
    expect(resolveBackend(CONFIG)).toBe("deepseek");
  });

  it("throws when CODE2WIKI_LLM_BACKEND=deepseek but DEEPSEEK_API_KEY is missing", () => {
    vi.stubEnv("CODE2WIKI_LLM_BACKEND", "deepseek");
    expect(() => resolveBackend(CONFIG)).toThrow(/DEEPSEEK_API_KEY/);
  });

  it("returns 'deepseek' when config.llmBackend=deepseek and DEEPSEEK_API_KEY is set", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-ds-test-456");
    expect(resolveBackend({ ...CONFIG, llmBackend: "deepseek" })).toBe("deepseek");
  });

  it("throws when config.llmBackend=deepseek but DEEPSEEK_API_KEY is missing (error mentions config.json)", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(() =>
      resolveBackend({ ...CONFIG, llmBackend: "deepseek" }),
    ).toThrow(/code2wiki\.config\.json/);
  });

  it("auto-detects deepseek when DEEPSEEK_API_KEY is set (beats anthropic)", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-ds-test-789");
    // ANTHROPIC_API_KEY is also set (default in beforeEach), but DeepSeek wins.
    expect(resolveBackend(CONFIG)).toBe("deepseek");
  });

  it("auto-detects anthropic when only ANTHROPIC_API_KEY is set (no DeepSeek key)", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    expect(resolveBackend(CONFIG)).toBe("anthropic");
  });

  it("CODE2WIKI_LLM_BACKEND=deepseek env var overrides config.llmBackend=anthropic", () => {
    vi.stubEnv("CODE2WIKI_LLM_BACKEND", "deepseek");
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-ds-test-101");
    expect(resolveBackend({ ...CONFIG, llmBackend: "anthropic" })).toBe("deepseek");
  });

  it("typo guard error message mentions deepseek in the valid list", () => {
    vi.stubEnv("CODE2WIKI_LLM_BACKEND", "dipseek"); // typo
    try {
      resolveBackend(CONFIG);
      expect.fail("expected throw");
    } catch (e) {
      expect((e as Error).message).toMatch(/deepseek/);
    }
  });
});

// ── DeepSeek extraction ──────────────────────────────────────────────────────

describe("extractWithLLM: DeepSeek backend", () => {
  const DS_CONFIG: Config = { ...CONFIG, mock: false, llmBackend: "deepseek" };

  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CODE2WIKI_LLM_BACKEND", "deepseek");
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-ds-test-999");
    vi.stubEnv("DEEPSEEK_BASE_URL", "");
    vi.stubEnv("DEEPSEEK_MODEL", "");
  });

  it("routes to DeepSeek when CODE2WIKI_LLM_BACKEND=deepseek", async () => {
    deepseekChatCreate.mockResolvedValueOnce(chatResponse(`{"ok":true}`));
    const result = await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    });
    expect(result).toEqual({ ok: true });
    expect(deepseekOpenAICtor).toHaveBeenCalledTimes(1);
    expect(anthropicCtor).not.toHaveBeenCalled();
    expect(azureOpenAICtor).not.toHaveBeenCalled();
  });

  it("instantiates OpenAI with apiKey and default baseURL from env", async () => {
    deepseekChatCreate.mockResolvedValueOnce(chatResponse(`{}`));
    await extractWithLLM({ candidate: CANDIDATE, projectName: "demo", config: DS_CONFIG });
    expect(deepseekOpenAICtor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "sk-ds-test-999",
        baseURL: "https://api.deepseek.com",
      }),
    );
  });

  it("honors DEEPSEEK_BASE_URL override", async () => {
    vi.stubEnv("DEEPSEEK_BASE_URL", "https://custom.deepseek.com");
    deepseekChatCreate.mockResolvedValueOnce(chatResponse(`{}`));
    await extractWithLLM({ candidate: CANDIDATE, projectName: "demo", config: DS_CONFIG });
    expect(deepseekOpenAICtor).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://custom.deepseek.com" }),
    );
  });

  it("uses DEEPSEEK_MODEL when set, else defaults to deepseek-v4-flash", async () => {
    // Explicit DEEPSEEK_MODEL
    vi.stubEnv("DEEPSEEK_MODEL", "deepseek-reasoner");
    deepseekChatCreate.mockResolvedValueOnce(chatResponse(`{}`));
    await extractWithLLM({ candidate: CANDIDATE, projectName: "demo", config: DS_CONFIG });
    expect(deepseekChatCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "deepseek-reasoner" }),
    );

    // Falls back to default (config.model is NOT consulted; it is an Anthropic model name)
    vi.stubEnv("DEEPSEEK_MODEL", "");
    deepseekChatCreate.mockResolvedValueOnce(chatResponse(`{}`));
    await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: { ...DS_CONFIG, model: "claude-sonnet-4-6" },
    });
    expect(deepseekChatCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "deepseek-v4-flash" }),
    );
  });

  it("sends SYSTEM_PROMPT as role='system' message", async () => {
    deepseekChatCreate.mockResolvedValueOnce(chatResponse(`{}`));
    await extractWithLLM({ candidate: CANDIDATE, projectName: "demo", config: DS_CONFIG });
    const call = deepseekChatCreate.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
  });

  it("sends buildUserPrompt content as role='user' message", async () => {
    deepseekChatCreate.mockResolvedValueOnce(chatResponse(`{}`));
    await extractWithLLM({ candidate: CANDIDATE, projectName: "demo", config: DS_CONFIG });
    const call = deepseekChatCreate.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.messages[1]).toEqual({
      role: "user",
      content: buildUserPrompt(CANDIDATE, "demo"),
    });
  });

  it("appends retryHint after separator on DeepSeek path", async () => {
    const hint = "VALIDATOR: title is empty";
    deepseekChatCreate.mockResolvedValueOnce(chatResponse(`{}`));
    await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: DS_CONFIG,
      retryHint: hint,
    });
    const call = deepseekChatCreate.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const base = buildUserPrompt(CANDIDATE, "demo");
    expect(call.messages[1]?.content).toBe(`${base}

---

${hint}`);
  });

  it("parses JSON from DeepSeek chat completion response (strips code fence)", async () => {
    deepseekChatCreate.mockResolvedValueOnce(chatResponse("```json\n{\"k\":\"v\"}\n```"));
    const result = await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: DS_CONFIG,
    });
    expect(result).toEqual({ k: "v" });
  });

  it("mock mode overrides DeepSeek when CODE2WIKI_MOCK=1", async () => {
    vi.stubEnv("CODE2WIKI_MOCK", "1");
    const result = (await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: DS_CONFIG,
    })) as Record<string, unknown>;
    expect(result["tags"]).toContain("mock-output");
    expect(deepseekOpenAICtor).not.toHaveBeenCalled();
    expect(anthropicCtor).not.toHaveBeenCalled();
  });

  it("pins max_tokens=4096 (cost guardrail, matching Anthropic path)", async () => {
    deepseekChatCreate.mockResolvedValueOnce(chatResponse(`{}`));
    await extractWithLLM({ candidate: CANDIDATE, projectName: "demo", config: DS_CONFIG });
    expect(deepseekChatCreate).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 4096 }),
    );
  });

  it("never invokes Anthropic or Azure SDK when on DeepSeek path", async () => {
    deepseekChatCreate.mockResolvedValueOnce(chatResponse(`{}`));
    await extractWithLLM({ candidate: CANDIDATE, projectName: "demo", config: DS_CONFIG });
    expect(anthropicCtor).not.toHaveBeenCalled();
    expect(azureOpenAICtor).not.toHaveBeenCalled();
  });

  it("throws a length-cap diagnostic when finish_reason='length' and content is empty", async () => {
    deepseekChatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "" }, finish_reason: "length" }],
    });
    await expect(
      extractWithLLM({ candidate: CANDIDATE, projectName: "demo", config: DS_CONFIG }),
    ).rejects.toThrow(/DeepSeek returned empty content.*finish_reason=length/);
  });
});

// ── Azure OpenAI extraction

describe("extractWithLLM: Azure OpenAI backend", () => {
  const AZURE_CONFIG: Config = { ...CONFIG, mock: false, llmBackend: "azure-openai" };

  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CODE2WIKI_LLM_BACKEND", "azure-openai");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "az-test-key");
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://test.openai.azure.com");
    vi.stubEnv("AZURE_OPENAI_DEPLOYMENT", "gpt-5-mini");
    vi.stubEnv("AZURE_OPENAI_API_VERSION", "2025-04-01-preview");
  });

  it("routes to Azure when CODE2WIKI_LLM_BACKEND=azure-openai", async () => {
    azureChatCreate.mockResolvedValueOnce(chatResponse(`{"ok":true}`));
    const result = await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: CONFIG,
    });
    expect(result).toEqual({ ok: true });
    expect(azureOpenAICtor).toHaveBeenCalledTimes(1);
    expect(anthropicCtor).not.toHaveBeenCalled();
  });

  it("uses AZURE_OPENAI_DEPLOYMENT as model in the chat completions call", async () => {
    azureChatCreate.mockResolvedValueOnce(chatResponse(`{}`));
    await extractWithLLM({ candidate: CANDIDATE, projectName: "demo", config: AZURE_CONFIG });
    expect(azureChatCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5-mini" }),
    );
  });

  it("falls back to config.model when AZURE_OPENAI_DEPLOYMENT is not set", async () => {
    vi.stubEnv("AZURE_OPENAI_DEPLOYMENT", "");
    azureChatCreate.mockResolvedValueOnce(chatResponse(`{}`));
    await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: { ...AZURE_CONFIG, model: "gpt-4o" },
    });
    expect(azureChatCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o" }),
    );
  });

  it("instantiates AzureOpenAI with apiKey, endpoint, deployment and apiVersion from env", async () => {
    azureChatCreate.mockResolvedValueOnce(chatResponse(`{}`));
    await extractWithLLM({ candidate: CANDIDATE, projectName: "demo", config: AZURE_CONFIG });
    expect(azureOpenAICtor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "az-test-key",
        endpoint: "https://test.openai.azure.com",
        deployment: "gpt-5-mini",
        apiVersion: "2025-04-01-preview",
      }),
    );
  });

  it("sends SYSTEM_PROMPT as role='system' message (not Anthropic-style system field)", async () => {
    azureChatCreate.mockResolvedValueOnce(chatResponse(`{}`));
    await extractWithLLM({ candidate: CANDIDATE, projectName: "demo", config: AZURE_CONFIG });
    const call = azureChatCreate.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
  });

  it("sends buildUserPrompt content as role='user' message", async () => {
    azureChatCreate.mockResolvedValueOnce(chatResponse(`{}`));
    await extractWithLLM({ candidate: CANDIDATE, projectName: "demo", config: AZURE_CONFIG });
    const call = azureChatCreate.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.messages[1]).toEqual({
      role: "user",
      content: buildUserPrompt(CANDIDATE, "demo"),
    });
  });

  it("appends retryHint after separator on Azure path (same as Anthropic)", async () => {
    const hint = "VALIDATOR: title is empty";
    azureChatCreate.mockResolvedValueOnce(chatResponse(`{}`));
    await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: AZURE_CONFIG,
      retryHint: hint,
    });
    const call = azureChatCreate.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const base = buildUserPrompt(CANDIDATE, "demo");
    expect(call.messages[1]?.content).toBe(`${base}\n\n---\n\n${hint}`);
  });

  it("parses JSON from Azure chat completion response (strips code fence)", async () => {
    azureChatCreate.mockResolvedValueOnce(chatResponse("```json\n{\"k\":\"v\"}\n```"));
    const result = await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: AZURE_CONFIG,
    });
    expect(result).toEqual({ k: "v" });
  });

  it("mock mode overrides Azure when CODE2WIKI_MOCK=1", async () => {
    vi.stubEnv("CODE2WIKI_MOCK", "1");
    const result = (await extractWithLLM({
      candidate: CANDIDATE,
      projectName: "demo",
      config: AZURE_CONFIG,
    })) as Record<string, unknown>;
    expect(result["tags"]).toContain("mock-output");
    expect(azureOpenAICtor).not.toHaveBeenCalled();
    expect(anthropicCtor).not.toHaveBeenCalled();
  });

  it("uses max_completion_tokens=16384 for Azure (reasoning model needs headroom for chain-of-thought)", async () => {
    azureChatCreate.mockResolvedValueOnce(chatResponse(`{}`));
    await extractWithLLM({ candidate: CANDIDATE, projectName: "demo", config: AZURE_CONFIG });
    expect(azureChatCreate).toHaveBeenCalledWith(
      expect.objectContaining({ max_completion_tokens: 16384 }),
    );
    // max_tokens must NOT be passed (breaks o-series reasoning models)
    expect(azureChatCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: expect.anything() }),
    );
  });

  it("never invokes Anthropic SDK when on Azure path", async () => {
    azureChatCreate.mockResolvedValueOnce(chatResponse(`{}`));
    await extractWithLLM({ candidate: CANDIDATE, projectName: "demo", config: AZURE_CONFIG });
    expect(anthropicCtor).not.toHaveBeenCalled();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("defaults apiVersion to 2024-10-21 when AZURE_OPENAI_API_VERSION is unset", async () => {
    vi.stubEnv("AZURE_OPENAI_API_VERSION", "");
    azureChatCreate.mockResolvedValueOnce(chatResponse(`{}`));
    await extractWithLLM({ candidate: CANDIDATE, projectName: "demo", config: AZURE_CONFIG });
    expect(azureOpenAICtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiVersion: "2024-10-21" }),
    );
  });

  it("honors AZURE_OPENAI_MAX_COMPLETION_TOKENS override (cost control for non-reasoning models)", async () => {
    vi.stubEnv("AZURE_OPENAI_MAX_COMPLETION_TOKENS", "4096");
    azureChatCreate.mockResolvedValueOnce(chatResponse(`{}`));
    await extractWithLLM({ candidate: CANDIDATE, projectName: "demo", config: AZURE_CONFIG });
    expect(azureChatCreate).toHaveBeenCalledWith(
      expect.objectContaining({ max_completion_tokens: 4096 }),
    );
  });

  it("rejects a non-numeric AZURE_OPENAI_MAX_COMPLETION_TOKENS with an actionable error (never reaches the API as NaN)", async () => {
    // Without the resolveMaxCompletionTokens guard, "16k" / "16,384" / "4O96"
    // coerce to NaN via Number() and were passed straight to the Azure API,
    // surfacing as an opaque 400. Pin the fail-fast: a typo throws before the
    // client is ever called.
    for (const bad of ["16k", "16,384", "4O96"]) {
      vi.stubEnv("AZURE_OPENAI_MAX_COMPLETION_TOKENS", bad);
      await expect(
        extractWithLLM({ candidate: CANDIDATE, projectName: "demo", config: AZURE_CONFIG }),
      ).rejects.toThrow(/AZURE_OPENAI_MAX_COMPLETION_TOKENS must be a positive integer/);
    }
    expect(azureChatCreate).not.toHaveBeenCalled();
  });

  it("rejects a non-positive or fractional AZURE_OPENAI_MAX_COMPLETION_TOKENS (0, negative, decimal)", async () => {
    for (const bad of ["0", "-100", "4096.5"]) {
      vi.stubEnv("AZURE_OPENAI_MAX_COMPLETION_TOKENS", bad);
      await expect(
        extractWithLLM({ candidate: CANDIDATE, projectName: "demo", config: AZURE_CONFIG }),
      ).rejects.toThrow(/positive integer; got "/);
    }
    expect(azureChatCreate).not.toHaveBeenCalled();
  });

  it("tolerates surrounding whitespace in AZURE_OPENAI_MAX_COMPLETION_TOKENS", async () => {
    // Number() trims, so a stray-space value should be accepted, not rejected.
    vi.stubEnv("AZURE_OPENAI_MAX_COMPLETION_TOKENS", "  8000  ");
    azureChatCreate.mockResolvedValueOnce(chatResponse(`{}`));
    await extractWithLLM({ candidate: CANDIDATE, projectName: "demo", config: AZURE_CONFIG });
    expect(azureChatCreate).toHaveBeenCalledWith(
      expect.objectContaining({ max_completion_tokens: 8000 }),
    );
  });

  it("throws a length-cap diagnostic when finish_reason='length' and content is empty (o-series CoT exhausted budget)", async () => {
    azureChatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "" }, finish_reason: "length" }],
    });
    await expect(
      extractWithLLM({ candidate: CANDIDATE, projectName: "demo", config: AZURE_CONFIG }),
    ).rejects.toThrow(/finish_reason=length.*AZURE_OPENAI_MAX_COMPLETION_TOKENS/);
  });

  it("throws a refusal diagnostic when message.refusal is populated (content filter / safety system)", async () => {
    azureChatCreate.mockResolvedValueOnce({
      choices: [
        {
          message: { content: "", refusal: "I can't help with that request." },
          finish_reason: "content_filter",
        },
      ],
    });
    await expect(
      extractWithLLM({ candidate: CANDIDATE, projectName: "demo", config: AZURE_CONFIG }),
    ).rejects.toThrow(/Model refused: I can't help/);
  });
});

// ── countTokens with DeepSeek backend ─────────────────────────────────────────

describe("countTokens: DeepSeek backend throws clearly", () => {
  it("throws with a clear message when DeepSeek backend is selected", async () => {
    vi.stubEnv("CODE2WIKI_LLM_BACKEND", "deepseek");
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-ds-test");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(
      countTokens({ candidate: CANDIDATE, projectName: "demo", config: CONFIG }),
    ).rejects.toThrow(/estimate-cost.*not supported.*DeepSeek/i);
    expect(anthropicCtor).not.toHaveBeenCalled();
    expect(deepseekOpenAICtor).not.toHaveBeenCalled();
  });

  it("throws with actionable guidance about switching to Anthropic", async () => {
    vi.stubEnv("CODE2WIKI_LLM_BACKEND", "deepseek");
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-ds-test");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(
      countTokens({ candidate: CANDIDATE, projectName: "demo", config: CONFIG }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

// ── countTokens with Azure backend

describe("countTokens: Azure backend throws clearly", () => {
  it("throws with a clear message when Azure backend is selected", async () => {
    vi.stubEnv("CODE2WIKI_LLM_BACKEND", "azure-openai");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "az-key");
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://test.openai.azure.com");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(
      countTokens({ candidate: CANDIDATE, projectName: "demo", config: CONFIG }),
    ).rejects.toThrow(/estimate-cost.*not supported.*Azure/i);
    expect(anthropicCtor).not.toHaveBeenCalled();
    expect(azureOpenAICtor).not.toHaveBeenCalled();
  });

  it("throws with actionable guidance about switching to Anthropic", async () => {
    vi.stubEnv("CODE2WIKI_LLM_BACKEND", "azure-openai");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "az-key");
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://test.openai.azure.com");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(
      countTokens({ candidate: CANDIDATE, projectName: "demo", config: CONFIG }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

