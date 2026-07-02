import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { getProgram } from "./index.js";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("README CLI reference drift guard", () => {
  it("README.md documents all commands and flags, detects drift", async () => {
    const program = getProgram();
    const readme = await fs.readFile(
      path.join(__dirname, "../../README.md"),
      "utf-8",
    );

    // Extract command names from commander
    const commanderCommands = program.commands
      .map((cmd) => cmd.name())
      .filter((name) => name !== "help") // help is implicit
      .sort();

    // Extract command names from README CLI reference section
    // The section lists commands as "  command-name    Description"
    const commandsMatch = readme.match(
      /Commands:\n([\s\S]*?)(?=\n\n|Options:)/,
    );
    const readmeCommands = (commandsMatch?.[1] || "")
      .split("\n")
      .filter((line) => /^\s+\w+\s+/.test(line))
      .map((line) => line.trim().split(/\s+/)[0])
      .sort();

    expect(readmeCommands).toEqual(
      commanderCommands,
      `Commands listed in README don't match CLI. Missing/extra: ${JSON.stringify({
        onlyInCLI: commanderCommands.filter(
          (c) => !readmeCommands.includes(c),
        ),
        onlyInReadme: readmeCommands.filter(
          (c) => !commanderCommands.includes(c),
        ),
      })}`,
    );

    // For each command that IS documented in the README, verify its flags
    const flagDrifts: string[] = [];

    for (const cmd of program.commands) {
      const cmdName = cmd.name();
      if (cmdName === "help") continue;

      // Check if this command has a flags section in the README
      const flagsSectionPattern = new RegExp(
        `\\*\\*\`${cmdName}\` flags\\*\\*`,
        "i",
      );
      const hasDocumentedFlags = flagsSectionPattern.test(readme);

      // Only verify flags for commands that ARE documented in the README
      if (!hasDocumentedFlags) continue;

      // Extract flags from commander (skip help/version which are auto-added)
      const commanderFlags = cmd.options
        .filter((opt) => !opt.flags.includes("-V") && !opt.flags.includes("-h"))
        .map((opt) => {
          // Extract flag name from formats like "--cwd, -c <dir>" or "--cwd <dir>"
          const match = opt.flags.match(/--([a-z0-9-]+)/);
          return match ? match[1] : null;
        })
        .filter((f): f is string => f !== null)
        .sort();

      // Extract flags from README for this command
      // Look for "**`command` flags**" followed by content until the next section
      const flagsFullSectionPattern = new RegExp(
        `\\*\\*\`${cmdName}\` flags\\*\\*.*?(?=\\n\\*\\*|\\n##|$)`,
        "is", // case-insensitive and dotall (. matches newlines)
      );
      const flagsSection = readme.match(flagsFullSectionPattern)?.[0] || "";

      // Parse flags from the README flags section (within code blocks or inline)
      // Match both `--flag-name` patterns in code and inline
      const readmeFlags = [
        ...flagsSection.matchAll(/--([a-z0-9-]+)/gi),
      ]
        .map((m) => m[1].toLowerCase()) // normalize to lowercase
        .filter((f) => !["help", "version"].includes(f))
        .sort();

      // Deduplicate (in case a flag appears multiple times in the README)
      const uniqueReadmeFlags = [...new Set(readmeFlags)].sort();
      const uniqueCommanderFlags = [...new Set(commanderFlags)].sort();

      if (JSON.stringify(uniqueReadmeFlags) !== JSON.stringify(uniqueCommanderFlags)) {
        flagDrifts.push(
          `${cmdName}: ${JSON.stringify({
            onlyInCLI: uniqueCommanderFlags.filter(
              (f) => !uniqueReadmeFlags.includes(f),
            ),
            onlyInReadme: uniqueReadmeFlags.filter(
              (f) => !uniqueCommanderFlags.includes(f),
            ),
          })}`,
        );
      }
    }

    expect(flagDrifts).toEqual(
      [],
      flagDrifts.length > 0
        ? `Flag drift detected:\n${flagDrifts.join("\n")}`
        : "",
    );
  });
});
