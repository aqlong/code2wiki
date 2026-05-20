import { describe, it, expect } from "vitest";
import { extractUseCase } from "./extractor.js";
import { renderUseCase } from "./renderer.js";
import { defaultConfig } from "./config.js";
import type { Candidate } from "./types.js";

const CANDIDATE: Candidate = {
  language: "java",
  filePath: "/repo/src/Foo.java",
  relativePath: "src/Foo.java",
  name: "Foo.bar",
  kind: "controller-method",
  lineStart: 10,
  lineEnd: 25,
  source: "@GetMapping(\"/x\") public String bar() { return \"x\"; }",
  hints: {
    annotations: ["Controller", "GetMapping"],
    httpRoute: { method: "GET", path: "/x" },
    parameters: [],
    callees: [],
  },
};

describe("extract + render pipeline (mock mode)", () => {
  it("produces a valid Markdown document end-to-end", async () => {
    const config = defaultConfig();
    config.mock = true;

    const { useCase } = await extractUseCase(
      CANDIDATE,
      "test-project",
      config,
      {
        commit: "abc1234",
        generatedAt: "2026-05-07T00:00:00Z",
      },
    );

    expect(useCase.code2wiki_id).toBe("java-src-foo-foo-bar-v1");
    expect(useCase.last_commit).toBe("abc1234");
    expect(useCase.confidence).toBe("low"); // mock always low

    const md = renderUseCase(useCase);

    // Frontmatter present
    expect(md).toMatch(/^---\n/);
    expect(md).toContain("code2wiki_id: java-src-foo-foo-bar-v1");
    expect(md).toContain("title:");
    expect(md).toContain("slug:");

    // Required body sections
    expect(md).toContain("## Summary");
    expect(md).toContain("## Actor and triggers");
    expect(md).toContain("## Source links");

    // Managed fence is present at the bottom
    expect(md).toContain("<!-- code2wiki:managed:start ");
    expect(md).toContain("<!-- code2wiki:managed:end -->");

    // Source line citation present
    expect(md).toContain("src/Foo.java");
    expect(md).toContain("10-25");
  });
});
