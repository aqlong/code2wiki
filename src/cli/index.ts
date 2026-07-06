#!/usr/bin/env node
import { Command } from "commander";
import { loadProjectEnv } from "../core/util/env.js";
import { runInit } from "./commands/init.js";
import { runList } from "./commands/list.js";
import { runGenerate } from "./commands/generate.js";
import { runValidate } from "./commands/validate.js";
import { runPublish } from "./commands/publish.js";
import { runClaim } from "./commands/claim.js";
import { runAudit } from "./commands/audit.js";
import { runReplay } from "./commands/replay.js";
import { runPreview } from "./commands/preview.js";

// Load .env from the current working directory (tolerant of shell-style
// formats like `export FOO=bar` that Node's --env-file rejects).
loadProjectEnv(process.cwd());

export function getProgram(): Command {
  const program = new Command();

  program
    .name("code2wiki")
    .description(
      "Generate non-technical, use-case-style wiki pages from source code",
    )
    .version("0.1.0");

  program
    .command("init")
  .description("Create a default code2wiki.config.json")
  .option("--cwd <dir>", "Project root", process.cwd())
  .action(async (opts: { cwd: string }) => {
    await runInit(opts);
  });

program
  .command("list")
  .description("List candidate use cases the parser would extract")
  .option("--cwd <dir>", "Project root", process.cwd())
  .action(async (opts: { cwd: string }) => {
    await runList(opts);
  });

program
  .command("generate")
  .description("Generate Markdown use cases under the configured output dir")
  .option("--cwd <dir>", "Project root", process.cwd())
  .option("--mock", "Skip LLM calls and produce deterministic mock output", false)
  .option(
    "--limit <n>",
    "Cap on number of candidates to process",
    (v) => Number.parseInt(v, 10),
  )
  .option("--only <substring>", "Only include candidates whose path matches")
  .option("--name <name>", "Only include the candidate with this exact function/method name (suffix match, e.g. 'publish' or 'OwnerController.processCreationForm')")
  .option("--since <ref>", "Only regenerate candidates whose source files changed since this git ref (e.g. 'HEAD~1', 'main', 'origin/main', or 'uncommitted')")
  .option("--estimate-cost", "Project token + USD cost estimate via Anthropic messages.countTokens (non-billed) and exit without LLM calls. Requires ANTHROPIC_API_KEY. Not available on DeepSeek or Azure OpenAI backends.", false)
  .option(
    "--min-confidence <level>",
    "Skip writing pages whose LLM-rated confidence is below this level. One of: high, medium, low (default: low = write everything).",
  )
  .action(async (opts: { cwd: string; mock: boolean; limit?: number; only?: string; name?: string; since?: string; estimateCost?: boolean; minConfidence?: string }) => {
    const { minConfidence, ...rest } = opts;
    await runGenerate({
      ...rest,
      minConfidence: minConfidence as "high" | "medium" | "low" | undefined,
    });
  });

program
  .command("validate")
  .description("Validate config and the contents of the output directory")
  .option("--cwd <dir>", "Project root", process.cwd())
  .action(async (opts: { cwd: string }) => {
    await runValidate(opts);
  });

program
  .command("publish <target>")
  .description("Push generated docs to a wiki, target is 'confluence' or 'notion'")
  .option("--cwd <dir>", "Project root", process.cwd())
  .option("--dry-run", "Show what would be published without calling the API", false)
  .option(
    "--mode <mode>",
    "Coexistence mode: 'greenfield' (default), 'claim', or 'parallel'. Overrides config.",
  )
  .option(
    "--ignore-collisions",
    "In claim mode, proceed past unresolved collisions (warning only)",
    false,
  )
  .action(
    async (
      target: string,
      opts: {
        cwd: string;
        dryRun: boolean;
        mode?: string;
        ignoreCollisions: boolean;
      },
    ) => {
      await runPublish({
        cwd: opts.cwd,
        target,
        dryRun: opts.dryRun,
        mode: opts.mode as "greenfield" | "claim" | "parallel" | undefined,
        ignoreCollisions: opts.ignoreCollisions,
      });
    },
  );

program
  .command("claim <pageRef>")
  .description(
    "Adopt an existing wiki page as the source for a generated use case (ADR-016).",
  )
  .requiredOption("--target <target>", "'confluence' or 'notion'")
  .requiredOption(
    "--map-to <code2wiki_id>",
    "code2wiki_id of the generated page this wiki page should be paired with",
  )
  .option(
    "--placement <where>",
    "'below' (default) places original content under the managed region; 'above' puts it on top",
    "below",
  )
  .option("--cwd <dir>", "Project root", process.cwd())
  .action(
    async (
      pageRef: string,
      opts: {
        cwd: string;
        target: string;
        mapTo: string;
        placement?: string;
      },
    ) => {
      await runClaim({
        cwd: opts.cwd,
        pageRef,
        target: opts.target as "confluence" | "notion",
        mapTo: opts.mapTo,
        placement: opts.placement as "above" | "below" | undefined,
      });
    },
  );

program
  .command("preview")
  .description(
    "Render a browsable local preview of what generated pages would look like once published to Confluence or Notion. No network calls.",
  )
  .option("--cwd <dir>", "Project root", process.cwd())
  .option(
    "--out <dir>",
    "Output directory for the preview (default: <cwd>/.code2wiki/preview)",
  )
  .option("--open", "Open the generated index in your default browser", false)
  .action(async (opts: { cwd: string; out?: string; open: boolean }) => {
    await runPreview(opts);
  });

program
  .command("audit [action]")
  .description(
    "Inspect the hash-chained audit log. action: 'show' (default) | 'verify' | 'keygen'",
  )
  .option("--cwd <dir>", "Project root", process.cwd())
  .option("--limit <n>", "Number of recent entries to show", (v) => Number.parseInt(v, 10))
  .option(
    "--require-signed",
    "Fail if any entry in the log is unsigned (verify only)",
    false,
  )
  .option(
    "--key-path <path>",
    "Output path for the generated private key PEM (keygen only; default: .code2wiki/audit-key.pem)",
  )
  .action(
    async (
      action: string | undefined,
      opts: {
        cwd: string;
        limit?: number;
        requireSigned: boolean;
        keyPath?: string;
      },
    ) => {
      await runAudit({
        cwd: opts.cwd,
        action: action ?? "show",
        limit: opts.limit,
        requireSigned: opts.requireSigned,
        keyPath: opts.keyPath,
      });
    },
  );

program
  .command("replay")
  .description(
    "Re-run every successful generate audit entry through the CURRENT prompt and report aggregate diffs. Read-only; never publishes.",
  )
  .option("--cwd <dir>", "Project root", process.cwd())
  .option(
    "--since <commit>",
    "Only replay audit entries from this commit forward (chronological order in the log)",
  )
  .option(
    "--since-version <version>",
    "Only replay entries produced under this prompt version or older (e.g. 'v1' to replay everything generated before a v2 bump). Audit entries missing details.promptVersion are treated as older and included.",
  )
  .option(
    "--limit <n>",
    "Cap on distinct slugs to replay (after dedupe)",
    (v) => Number.parseInt(v, 10),
  )
  .option(
    "--mock",
    "Use deterministic mock LLM output (no API call). Recommended for fast structural-drift checks.",
    false,
  )
  .action(
    async (opts: {
      cwd: string;
      since?: string;
      sinceVersion?: string;
      limit?: number;
      mock: boolean;
    }) => {
      await runReplay({
        cwd: opts.cwd,
        since: opts.since,
        sinceVersion: opts.sinceVersion,
        limit: opts.limit,
        mock: opts.mock,
      });
    },
  );

  return program;
}

// Only parse arguments if this is the main entry point (not being imported by
// tests). Normalize path separators first: on Windows, process.argv[1] is an
// absolute path with backslashes (e.g. C:\...\dist\cli\index.js), so a raw
// endsWith("cli/index.js") check never matches and the CLI silently no-ops.
const entryPath = process.argv[1]?.replace(/\\/g, "/");
if (entryPath?.endsWith("cli/index.js") || entryPath?.endsWith("cli/index.ts")) {
  const program = getProgram();
  await program.parseAsync(process.argv);
}
