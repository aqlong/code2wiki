// Local progress dashboard for code2wiki.
// Run via: npm run dashboard
//
// Reads project state from disk (no caching) so a refresh always shows current.
// Reads test results from a cached run; clicking "Run tests" kicks off a fresh run.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, exec } from "node:child_process";
import { promisify } from "node:util";
import { marked } from "marked";

// Dynamically import the audit module from the compiled dist if available.
// If the user hasn't run `npm run build` yet, the dashboard still works;
// the audit panel just shows a hint instead of entries.
let auditModule = null;
try {
  auditModule = await import("../../dist/core/audit.js");
} catch {
  // dist not built yet, degrade gracefully
}

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const PORT = Number.parseInt(process.env.PORT ?? "4321", 10);

// In-memory cache for test results; refreshed on demand.
let testCache = null;

// --- helpers --------------------------------------------------------------

async function readFile(rel) {
  return fs.readFile(path.join(PROJECT_ROOT, rel), "utf-8");
}

async function safeReadFile(rel) {
  try {
    return await readFile(rel);
  } catch {
    return null;
  }
}

async function gitInfo() {
  try {
    const [{ stdout: log }, { stdout: branch }, { stdout: remote }] =
      await Promise.all([
        execAsync('git log --oneline -n 8 --pretty=format:"%h|%s|%cr"', {
          cwd: PROJECT_ROOT,
        }),
        execAsync("git rev-parse --abbrev-ref HEAD", { cwd: PROJECT_ROOT }),
        execAsync("git remote get-url origin", { cwd: PROJECT_ROOT }),
      ]);
    return {
      branch: branch.trim(),
      remote: remote.trim(),
      commits: log
        .trim()
        .split("\n")
        .map((line) => {
          const [hash, msg, when] = line.split("|");
          return { hash, msg, when };
        }),
    };
  } catch (e) {
    return { branch: "unknown", remote: "", commits: [], error: e.message };
  }
}

async function fileTree(root, depth = 3, ignore = new Set(["node_modules", "dist", ".git", "references"])) {
  async function walk(dir, currentDepth) {
    if (currentDepth > depth) return null;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    const result = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignore.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".github" && entry.name !== ".gitignore") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const children = await walk(full, currentDepth + 1);
        result.push({
          name: entry.name,
          type: "dir",
          children: children ?? [],
        });
      } else {
        const stat = await fs.stat(full);
        result.push({
          name: entry.name,
          type: "file",
          size: stat.size,
        });
      }
    }
    return result;
  }
  return walk(root, 0);
}

function renderTree(nodes, prefix = "") {
  if (!nodes || nodes.length === 0) return "";
  let out = "";
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const isLast = i === nodes.length - 1;
    const branch = isLast ? "└── " : "├── ";
    const childPrefix = prefix + (isLast ? "    " : "│   ");
    if (n.type === "dir") {
      out += `${prefix}${branch}<span class="dir">${escape(n.name)}/</span>\n`;
      out += renderTree(n.children, childPrefix);
    } else {
      const sizeStr = n.size != null ? ` <span class="size">${formatSize(n.size)}</span>` : "";
      out += `${prefix}${branch}${escape(n.name)}${sizeStr}\n`;
    }
  }
  return out;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function runTests() {
  return new Promise((resolve) => {
    const child = spawn("npm", ["test"], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, CI: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      // Strip ANSI escape codes so regex matches the visible text.
      const ansi = /\x1b\[[0-9;]*m/g;
      const combined = (stdout + stderr).replace(ansi, "");
      // Vitest summary lines look like:
      //   Tests  26 passed (26)
      //   Tests  1 failed | 25 passed (26)
      const passMatch = combined.match(/Tests\s+(?:\d+\s+failed\s*\|\s*)?(\d+)\s+passed/);
      const failMatch = combined.match(/Tests\s+(\d+)\s+failed/);
      resolve({
        ok: code === 0,
        exitCode: code,
        passed: passMatch ? Number.parseInt(passMatch[1], 10) : 0,
        failed: failMatch ? Number.parseInt(failMatch[1], 10) : 0,
        tail: combined.split("\n").slice(-30).join("\n"),
        ranAt: new Date().toISOString(),
      });
    });
  });
}

async function checkGhScopes() {
  try {
    const { stdout, stderr } = await execAsync("gh auth status 2>&1", {
      cwd: PROJECT_ROOT,
    });
    const out = stdout + stderr;
    const scopesMatch = out.match(/Token scopes:\s*([^\n]+)/);
    const scopes = scopesMatch ? scopesMatch[1] : "(unknown)";
    return {
      authenticated: out.includes("Logged in"),
      scopes,
      hasWorkflow: scopes.includes("workflow"),
    };
  } catch {
    return { authenticated: false, scopes: "(error)", hasWorkflow: false };
  }
}

async function workflowFilesPending() {
  try {
    const stagingExists = await fs
      .access(path.join(PROJECT_ROOT, ".github-staging"))
      .then(() => true)
      .catch(() => false);
    if (!stagingExists) return [];
    const entries = await fs.readdir(path.join(PROJECT_ROOT, ".github-staging"));
    return entries.filter((e) => e.endsWith(".yml"));
  } catch {
    return [];
  }
}

async function loadRoadmapPhase1() {
  const md = (await safeReadFile("docs/roadmap.md")) ?? "";
  // Pull out the Week 1..8 sections by header.
  const sections = [];
  const lines = md.split("\n");
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^### (.+)$/);
    if (heading) {
      if (current) sections.push(current);
      const title = heading[1];
      const done = title.includes("✅");
      const pending = title.includes("⏳");
      current = {
        title: title.replace(/[✅⏳]/g, "").trim(),
        done,
        pending,
        items: [],
      };
    } else if (current) {
      const checkbox = line.match(/^- \[([ x])\] (.+)$/);
      if (checkbox) {
        current.items.push({
          done: checkbox[1] === "x",
          text: checkbox[2],
        });
      }
    }
  }
  if (current) sections.push(current);
  // Limit to phase-1 weeks.
  return sections.filter((s) => s.title.toLowerCase().startsWith("week"));
}

// --- HTML page -----------------------------------------------------------

function renderPage(data) {
  const {
    git,
    tree,
    roadmap,
    testStatus,
    ghStatus,
    pendingWorkflows,
    examples,
    decisions,
    auditPanel,
  } = data;

  const treeHtml = renderTree(tree);

  const roadmapHtml = roadmap
    .map((week) => {
      const itemsHtml = week.items
        .map(
          (i) =>
            `<li class="${i.done ? "item-done" : "item-pending"}">${
              i.done ? "✓" : "○"
            } ${escape(i.text)}</li>`,
        )
        .join("");
      const status = week.done
        ? '<span class="badge badge-done">DONE</span>'
        : week.pending
          ? '<span class="badge badge-pending">PENDING</span>'
          : "";
      return `<div class="week ${week.done ? "week-done" : "week-pending"}">
        <h3>${escape(week.title)} ${status}</h3>
        <ul>${itemsHtml}</ul>
      </div>`;
    })
    .join("");

  const testHtml = testStatus
    ? `<div class="${testStatus.ok ? "test-ok" : "test-fail"}">
        <strong>${testStatus.ok ? "✓ All tests passing" : "✗ Some tests failing"}</strong>
        <span class="test-counts">${testStatus.passed} passed${
          testStatus.failed ? `, ${testStatus.failed} failed` : ""
        }</span>
        <span class="test-when">last run: ${escape(testStatus.ranAt)}</span>
      </div>
      <details class="test-tail"><summary>Last test output</summary><pre>${escape(testStatus.tail)}</pre></details>`
    : `<div class="test-pending">Tests not yet run. <a href="/api/run-tests" id="run-tests">Run tests now</a></div>`;

  const ghHtml = ghStatus.hasWorkflow
    ? `<div class="status-ok">✓ <code>gh</code> has <code>workflow</code> scope, workflow files can be pushed normally</div>`
    : `<div class="status-warn">
        ⚠ <code>gh</code> token is missing the <code>workflow</code> scope.
        Current scopes: <code>${escape(ghStatus.scopes)}</code>
        ${
          pendingWorkflows.length
            ? `<div class="workflow-pending">
                <strong>${pendingWorkflows.length} workflow file(s) waiting in <code>.github-staging/</code>:</strong>
                <ul>${pendingWorkflows.map((f) => `<li>${escape(f)}</li>`).join("")}</ul>
                <p>To push them, run this in your terminal:</p>
                <pre>gh auth refresh -s workflow
mkdir -p ~/code2wiki/.github/workflows
mv ~/code2wiki/.github-staging/*.yml ~/code2wiki/.github/workflows/
rmdir ~/code2wiki/.github-staging
cd ~/code2wiki &amp;&amp; git add .github/workflows/ \\
  &amp;&amp; git commit -m "Add CI + auto-regenerate workflows" \\
  &amp;&amp; git push</pre>
                <p>The first command will print a URL and a code; visit the URL, paste the code, click Authorize. Takes about 30 seconds.</p>
              </div>`
            : "<div>(no workflow files staged)</div>"
        }
      </div>`;

  const examplesHtml = examples
    .map((ex) => {
      const hasActual = !!ex.actualHtml;
      const wikiLinks = `<div class="ex-wiki-links">
          ${hasActual ? `<a href="/wiki/${escape(ex.name)}/actual" target="_blank">🤖 Open real LLM output as wiki page →</a>` : ""}
          <a href="/wiki/${escape(ex.name)}/expected" target="_blank">📐 Open gold-standard as wiki page →</a>
        </div>`;
      const sideBySide = hasActual
        ? `<div class="ex-pair">
            <div class="ex-col">
              <div class="ex-col-label ex-col-expected">📐 Gold-standard (hand-curated)</div>
              <div class="example-body">${ex.expectedHtml}</div>
            </div>
            <div class="ex-col">
              <div class="ex-col-label ex-col-actual">🤖 Real LLM output</div>
              <div class="example-body">${ex.actualHtml}</div>
            </div>
          </div>`
        : `<div class="example-body">${ex.expectedHtml}</div>
           <div class="ex-no-actual">No real LLM run yet, set ANTHROPIC_API_KEY and run <code>npm run generate</code> to populate.</div>`;
      return `
        <details class="example">
          <summary><strong>${escape(ex.name)}</strong>, ${escape(ex.title)} ${hasActual ? '<span class="badge badge-done">LLM RUN</span>' : '<span class="badge badge-pending">GOLD ONLY</span>'}</summary>
          <div class="example-meta">${escape(ex.source)}</div>
          ${wikiLinks}
          ${sideBySide}
        </details>`;
    })
    .join("");

  const commitsHtml = git.commits
    .map(
      (c) =>
        `<li><code>${escape(c.hash)}</code> ${escape(c.msg)} <span class="when">${escape(c.when)}</span></li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>code2wiki, progress dashboard</title>
  <style>
    :root {
      --bg: #0f1117;
      --bg-2: #161922;
      --bg-3: #1d2230;
      --fg: #e6e7eb;
      --fg-2: #a8aab2;
      --fg-3: #6b6d76;
      --accent: #6ea7ff;
      --accent-2: #4cd394;
      --warn: #ffb454;
      --err: #ff6464;
      --border: #2a2f3d;
    }
    * { box-sizing: border-box; }
    html, body { background: var(--bg); color: var(--fg); margin: 0;
      font: 14px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { background: var(--bg-3); padding: 1px 5px; border-radius: 3px;
      font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
    pre { background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px;
      padding: 12px 14px; overflow-x: auto; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: pre; }
    pre code { background: transparent; padding: 0; }
    h1 { font-size: 22px; margin: 0; }
    h2 { font-size: 17px; margin: 0 0 10px; color: var(--fg); }
    h3 { font-size: 14px; margin: 0 0 8px; }
    h4 { font-size: 13px; margin: 14px 0 4px; }
    ul { padding-left: 20px; margin: 6px 0; }
    li { margin: 2px 0; }
    .container { max-width: 1100px; margin: 0 auto; padding: 24px; }
    header { display: flex; justify-content: space-between; align-items: baseline;
      border-bottom: 1px solid var(--border); padding-bottom: 14px; margin-bottom: 22px; gap: 18px; flex-wrap: wrap; }
    header .sub { color: var(--fg-2); font-size: 13px; }
    header .repo a { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
    .grid { display: grid; gap: 22px; grid-template-columns: 1fr; }
    @media (min-width: 880px) { .grid { grid-template-columns: 1fr 1fr; } .grid > .full { grid-column: 1 / -1; } }
    .card { background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 16px 18px; }
    .card.full > * + * { margin-top: 8px; }
    .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px;
      font-weight: 600; vertical-align: middle; margin-left: 6px; }
    .badge-done { background: rgba(76, 211, 148, 0.15); color: var(--accent-2); }
    .badge-pending { background: rgba(255, 180, 84, 0.12); color: var(--warn); }
    .week { padding: 10px 12px; border-radius: 6px; margin-bottom: 8px; background: var(--bg-3); }
    .week-done h3 { color: var(--accent-2); }
    .item-done { color: var(--fg); }
    .item-pending { color: var(--fg-2); }
    .test-ok { color: var(--accent-2); font-weight: 600; }
    .test-fail { color: var(--err); font-weight: 600; }
    .test-counts { color: var(--fg-2); font-weight: 400; margin-left: 8px; }
    .test-when { color: var(--fg-3); font-weight: 400; margin-left: 8px; font-size: 12px; }
    .test-tail summary { cursor: pointer; color: var(--accent); margin-top: 8px; font-size: 13px; }
    .test-pending { color: var(--fg-2); }
    .status-ok { color: var(--accent-2); }
    .status-warn { color: var(--warn); }
    .workflow-pending { margin-top: 10px; color: var(--fg); }
    .workflow-pending pre { font-size: 11.5px; }
    .commits { list-style: none; padding-left: 0; }
    .commits li { padding: 4px 0; border-bottom: 1px solid var(--border); }
    .commits li:last-child { border-bottom: 0; }
    .commits .when { color: var(--fg-3); float: right; font-size: 12px; }
    .tree { background: var(--bg); padding: 10px 12px; border: 1px solid var(--border);
      border-radius: 6px; max-height: 460px; overflow-y: auto; font-size: 12.5px; }
    .tree .dir { color: var(--accent); font-weight: 600; }
    .tree .size { color: var(--fg-3); font-size: 11px; }
    .example { background: var(--bg-3); border-radius: 6px; padding: 8px 12px; margin-bottom: 6px; }
    .example > summary { cursor: pointer; color: var(--fg); }
    .example-meta { color: var(--fg-3); font-size: 12px; padding: 4px 0; }
    .example-body { background: var(--bg); border-radius: 4px; padding: 12px 16px;
      max-height: 600px; overflow-y: auto; }
    .ex-pair { display: grid; gap: 12px; grid-template-columns: 1fr; margin-top: 8px; }
    @media (min-width: 1100px) { .ex-pair { grid-template-columns: 1fr 1fr; } }
    .ex-col-label { padding: 6px 10px; border-radius: 4px 4px 0 0; font-size: 12px; font-weight: 600; }
    .ex-col-expected { background: rgba(110, 167, 255, 0.15); color: var(--accent); }
    .ex-col-actual { background: rgba(76, 211, 148, 0.15); color: var(--accent-2); }
    .ex-col .example-body { border-radius: 0 0 4px 4px; max-height: 500px; }
    .ex-no-actual { padding: 10px 14px; color: var(--fg-3); font-size: 12px;
      background: var(--bg); border-radius: 4px; margin-top: 8px; }
    .ex-wiki-links { display: flex; gap: 16px; flex-wrap: wrap; padding: 8px 0;
      font-size: 13px; }
    .ex-wiki-links a { color: var(--accent-2); }
    .audit-status { display: flex; gap: 12px; align-items: center; margin-bottom: 10px;
      font-size: 13px; }
    .audit-status .ok { color: var(--accent-2); font-weight: 600; }
    .audit-status .bad { color: var(--err); font-weight: 600; }
    .audit-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    .audit-table th, .audit-table td { text-align: left; padding: 4px 8px;
      border-bottom: 1px solid var(--border); }
    .audit-table th { color: var(--fg-3); font-weight: 500; font-size: 11px;
      text-transform: uppercase; letter-spacing: 0.04em; }
    .audit-table .sym { text-align: center; width: 24px; }
    .audit-table .sym-created { color: var(--accent-2); }
    .audit-table .sym-updated { color: var(--accent); }
    .audit-table .sym-error { color: var(--err); }
    .audit-table .commit { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--fg-3); font-size: 11.5px; }
    .audit-table .target { color: var(--fg-3); font-size: 11.5px; }
    .example-body h2 { color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 4px; margin-top: 18px; }
    .example-body h3 { margin-top: 14px; }
    .example-body code { font-size: 12px; }
    .example-body table { border-collapse: collapse; margin: 8px 0; }
    .example-body td, .example-body th { border: 1px solid var(--border); padding: 4px 8px; }
    .footer { margin-top: 30px; padding-top: 18px; border-top: 1px solid var(--border);
      color: var(--fg-3); font-size: 12px; text-align: center; }
    button { background: var(--accent); color: white; border: 0; padding: 6px 12px;
      border-radius: 4px; cursor: pointer; font: inherit; }
    button:hover { filter: brightness(1.1); }
  </style>
</head>
<body>
<div class="container">
  <header>
    <div>
      <h1>code2wiki <span class="sub">, progress dashboard</span></h1>
      <div class="sub">Generate non-technical, use-case-style wiki pages from source code, auto-published on every prod release.</div>
    </div>
    <div class="repo">
      <div>branch <code>${escape(git.branch)}</code></div>
      <div><a href="${escape(git.remote.replace(".git", ""))}" target="_blank" rel="noopener">${escape(
        git.remote.replace(/^.+github\.com[:/]/, "github.com/").replace(/\.git$/, ""),
      )}</a></div>
    </div>
  </header>

  <div class="grid">
    <div class="card">
      <h2>Roadmap status</h2>
      ${roadmapHtml}
    </div>

    <div class="card">
      <h2>Tests</h2>
      ${testHtml}
      <h4>GitHub auth scope</h4>
      ${ghHtml}
    </div>

    <div class="card full">
      <h2>Worked examples (gold-standard outputs)</h2>
      <p class="sub">Hand-curated demos that double as the regression test suite. These are what the LLM should produce.</p>
      ${examplesHtml || "<em>(no examples yet)</em>"}
    </div>

    <div class="card">
      <h2>Recent commits</h2>
      <ul class="commits">${commitsHtml}</ul>
    </div>

    <div class="card">
      <h2>Project structure</h2>
      <pre class="tree">${treeHtml}</pre>
    </div>

    <div class="card full">
      <h2>Audit log</h2>
      ${renderAuditPanelHtml(auditPanel)}
    </div>

    <div class="card full">
      <h2>Architectural decisions</h2>
      <details><summary>Show ADR log</summary><div class="example-body">${decisions}</div></details>
    </div>
  </div>

  <div class="footer">
    code2wiki dashboard · refresh the page to re-read project state · <code>npm run dashboard</code>
  </div>
</div>
<script>
  document.getElementById("run-tests")?.addEventListener("click", async (e) => {
    e.preventDefault();
    e.target.textContent = "Running…";
    await fetch("/api/run-tests", { method: "POST" });
    location.reload();
  });
</script>
</body>
</html>`;
}

// --- wiki rendering (Confluence-like single-page view) ------------------

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: md };
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^['"]|['"]$/g, "");
  }
  return { frontmatter: fm, body: m[2] };
}

function renderWikiPage({ slug, exampleName, frontmatter, bodyHtml, hasActual, hasExpected, isActual, sourceMd }) {
  const fm = frontmatter;
  const githubUrl = "https://github.com/aqlong/code2wiki";
  const repoLinkSrc = sourceMd
    ? sourceMd
        .split("\n")
        .find((l) => l.includes("github.com"))
        ?.match(/\(([^)]+github\.com[^)]+)\)/)?.[1]
    : null;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escape(fm.title || slug)} · code2wiki preview</title>
  <style>
    :root {
      --bg: #ffffff;
      --bg-alt: #f7f8fa;
      --bg-meta: #f4f5f7;
      --fg: #172b4d;
      --fg-2: #5e6c84;
      --fg-3: #97a0af;
      --border: #dfe1e6;
      --link: #0052cc;
      --tag-bg: #deebff;
      --tag-fg: #0747a6;
      --high: #e3fcef;
      --high-fg: #006644;
      --warn: #fff7e6;
      --warn-fg: #974f0c;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; background: var(--bg-alt); color: var(--fg);
      font: 15px/1.6 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif;
      -webkit-font-smoothing: antialiased; }
    a { color: var(--link); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { background: var(--bg-meta); border: 1px solid var(--border); padding: 0 4px;
      border-radius: 3px; font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
    pre { background: var(--bg-meta); padding: 12px 14px; border: 1px solid var(--border);
      border-radius: 4px; overflow-x: auto; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .topbar { background: white; border-bottom: 1px solid var(--border); padding: 10px 24px;
      display: flex; align-items: center; gap: 16px; font-size: 13px; }
    .topbar .crumbs { color: var(--fg-2); }
    .topbar .crumbs a { color: var(--fg-2); }
    .topbar .toggle { margin-left: auto; display: flex; gap: 8px; }
    .topbar .toggle a { padding: 4px 10px; border: 1px solid var(--border);
      border-radius: 4px; background: white; color: var(--fg-2); font-size: 12px; }
    .topbar .toggle a.active { background: var(--link); border-color: var(--link); color: white; }
    .frame { max-width: 1100px; margin: 24px auto; background: white;
      border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 2px 4px rgba(9, 30, 66, .04); }
    .page-header { padding: 28px 36px 14px; border-bottom: 1px solid var(--border); }
    .page-title { font-size: 28px; font-weight: 600; margin: 0 0 6px; line-height: 1.25; color: var(--fg); }
    .page-sub { color: var(--fg-2); font-size: 13px; }
    .meta-strip { display: flex; flex-wrap: wrap; gap: 18px 24px; padding: 14px 36px;
      background: var(--bg-meta); border-bottom: 1px solid var(--border); font-size: 13px; }
    .meta-strip .item { display: flex; flex-direction: column; gap: 2px; }
    .meta-strip .label { color: var(--fg-3); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
    .meta-strip .value { color: var(--fg); }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
    .badge-high { background: var(--high); color: var(--high-fg); }
    .badge-medium { background: var(--warn); color: var(--warn-fg); }
    .badge-low { background: #ffebe6; color: #bf2600; }
    .tags { display: flex; flex-wrap: wrap; gap: 4px; }
    .tag { background: var(--tag-bg); color: var(--tag-fg); padding: 1px 8px;
      border-radius: 3px; font-size: 11px; font-weight: 500; }
    .doc { padding: 28px 36px 36px; max-width: 760px; line-height: 1.65; }
    .doc h2 { font-size: 18px; font-weight: 600; margin: 28px 0 10px;
      padding-bottom: 6px; border-bottom: 1px solid var(--border); color: var(--fg); }
    .doc h2:first-child { margin-top: 0; }
    .doc h3 { font-size: 15px; font-weight: 600; margin: 18px 0 6px; }
    .doc h4 { font-size: 14px; font-weight: 600; margin: 14px 0 4px; }
    .doc p { margin: 8px 0; }
    .doc ol, .doc ul { padding-left: 24px; margin: 6px 0; }
    .doc li { margin: 4px 0; }
    .doc strong { font-weight: 600; }
    .doc details { margin: 12px 0; background: var(--bg-meta); padding: 10px 14px;
      border: 1px solid var(--border); border-radius: 4px; }
    .doc details > summary { cursor: pointer; color: var(--fg-2); font-size: 13px; font-weight: 500; }
    .doc details[open] { padding-bottom: 14px; }
    .doc hr { border: 0; border-top: 1px solid var(--border); margin: 24px 0; }
    .doc sup { font-size: 0.75em; }
    .doc .footnotes { margin-top: 28px; padding-top: 18px; border-top: 1px solid var(--border);
      font-size: 13px; color: var(--fg-2); }
    .footnote-callout { display: inline-block; min-width: 18px; height: 18px;
      background: var(--tag-bg); color: var(--tag-fg); border-radius: 999px;
      font-size: 11px; font-weight: 600; text-align: center; padding: 0 6px; line-height: 18px;
      vertical-align: 1px; text-decoration: none; margin-left: 2px; }
    .source-banner { background: var(--bg-meta); border-top: 1px solid var(--border);
      padding: 14px 36px; color: var(--fg-2); font-size: 12px; }
    .source-banner code { background: white; }
    .lower-bar { padding: 18px 36px; border-top: 1px solid var(--border);
      color: var(--fg-3); font-size: 12px; display: flex; justify-content: space-between; }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="crumbs">
      <a href="/">code2wiki</a> &nbsp;›&nbsp;
      <a href="/wiki">examples</a> &nbsp;›&nbsp;
      ${escape(exampleName)}
    </div>
    ${
      hasActual && hasExpected
        ? `<div class="toggle">
            <a href="/wiki/${escape(exampleName)}/actual" class="${isActual ? "active" : ""}">🤖 Real LLM</a>
            <a href="/wiki/${escape(exampleName)}/expected" class="${!isActual ? "active" : ""}">📐 Gold-standard</a>
          </div>`
        : ""
    }
  </div>
  <div class="frame">
    <div class="page-header">
      <h1 class="page-title">${escape(fm.title || "(untitled)")}</h1>
      <div class="page-sub">
        ${isActual ? "Real LLM-generated wiki page" : "Hand-curated gold-standard"} ·
        Generated from <code>${escape(fm.last_commit || "?")}</code> on ${escape((fm.last_generated || "").slice(0, 19).replace("T", " "))}
      </div>
    </div>
    <div class="meta-strip">
      <div class="item"><span class="label">Actor</span><span class="value">${escape(fm.actor || ", ")}</span></div>
      <div class="item"><span class="label">Status</span><span class="value">${escape(fm.status || ", ")}</span></div>
      <div class="item"><span class="label">Confidence</span><span class="value"><span class="badge badge-${escape(fm.confidence || "low")}">${escape((fm.confidence || ", ").toUpperCase())}</span></span></div>
      <div class="item"><span class="label">Source</span><span class="value"><code>${escape((fm.code2wiki_id || "").slice(0, 60))}…</code></span></div>
    </div>
    <article class="doc">${bodyHtml}</article>
    ${
      repoLinkSrc
        ? `<div class="source-banner">📎 Original source on GitHub: <a href="${escape(repoLinkSrc)}" target="_blank" rel="noopener">${escape(repoLinkSrc.replace(/^https?:\/\//, ""))}</a></div>`
        : ""
    }
    <div class="lower-bar">
      <div>This is what code2wiki publishes to your Confluence/Notion space on every prod release.</div>
      <div><a href="${githubUrl}" target="_blank" rel="noopener">code2wiki on GitHub</a></div>
    </div>
  </div>
</body>
</html>`;
}

function renderWikiIndex(entries) {
  const items = entries
    .map((e) => {
      const targetVariant = e.hasActual ? "actual" : "expected";
      const variantBadge = e.hasActual
        ? '<span class="badge badge-actual">🤖 Real LLM</span>'
        : '<span class="badge badge-expected">📐 Gold only</span>';
      return `<li>
        <a href="/wiki/${escape(e.name)}/${targetVariant}">
          <strong>${escape(e.title)}</strong>
          ${variantBadge}
        </a>
        <div class="meta">${escape(e.source)}</div>
        <div class="links">
          ${e.hasActual ? `<a href="/wiki/${escape(e.name)}/actual">🤖 real LLM</a>` : ""}
          ${e.hasExpected ? `<a href="/wiki/${escape(e.name)}/expected">📐 gold-standard</a>` : ""}
        </div>
      </li>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>code2wiki · example wiki pages</title>
  <style>
    body { margin: 0; background: #f7f8fa; color: #172b4d;
      font: 15px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
    .container { max-width: 720px; margin: 40px auto; padding: 0 24px; }
    h1 { font-size: 22px; }
    .sub { color: #5e6c84; }
    ul { list-style: none; padding: 0; }
    li { background: white; border: 1px solid #dfe1e6; border-radius: 6px;
      padding: 14px 18px; margin: 10px 0; }
    li a { color: #172b4d; text-decoration: none; font-size: 16px; }
    li a:hover { color: #0052cc; }
    .meta { color: #5e6c84; font-size: 13px; margin: 4px 0 6px; }
    .links { display: flex; gap: 12px; font-size: 13px; }
    .links a { color: #0052cc; }
    .badge { display: inline-block; padding: 1px 8px; border-radius: 999px;
      font-size: 11px; font-weight: 600; margin-left: 8px; vertical-align: 2px; }
    .badge-actual { background: #e3fcef; color: #006644; }
    .badge-expected { background: #deebff; color: #0747a6; }
    .crumbs { color: #5e6c84; font-size: 13px; margin-bottom: 18px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="crumbs"><a href="/">← back to dashboard</a></div>
    <h1>Wiki page previews</h1>
    <p class="sub">These are the pages code2wiki produces from real source code. They look the same in Confluence and Notion when published via the upcoming hosted SaaS layer.</p>
    <ul>${items}</ul>
  </div>
</body>
</html>`;
}

async function buildWikiEntries() {
  const examplesDir = path.join(PROJECT_ROOT, "examples");
  const out = [];
  try {
    const dirs = await fs.readdir(examplesDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const expected = await safeReadFile(`examples/${d.name}/expected.md`);
      const actual = await safeReadFile(`examples/${d.name}/actual.md`);
      const source = await safeReadFile(`examples/${d.name}/source.md`);
      if (!expected && !actual) continue;
      const fmSource = actual ?? expected;
      const titleMatch = fmSource.match(/^title:\s*(.+)$/m);
      out.push({
        name: d.name,
        title: titleMatch ? titleMatch[1] : d.name,
        hasExpected: !!expected,
        hasActual: !!actual,
        source: source ? source.split("\n")[0].replace(/^#\s*/, "") : "",
        sourceMd: source ?? "",
      });
    }
  } catch {
    // ignore
  }
  return out;
}

function renderAuditPanelHtml(panel) {
  if (!panel) {
    return `<div class="sub">Audit module not built yet, run <code>npm run build</code> to enable.</div>`;
  }
  if (panel.error) {
    return `<div class="status-warn">⚠ ${escape(panel.error)}</div>`;
  }
  const { entries, verify } = panel;
  if (!entries || entries.length === 0) {
    return `<div class="sub">No audit entries yet. Run <code>npm run generate</code> or <code>code2wiki publish</code> to populate.</div>`;
  }
  const symbolFor = (o) =>
    o === "created" ? "+" : o === "updated" ? "~" : o === "unchanged" ? "·" : o === "error" ? "✗" : "○";
  const status = verify.ok
    ? `<span class="ok">✓ Chain intact</span> <span style="color:var(--fg-3)">${verify.validEntries}/${verify.totalEntries} entries verified</span>`
    : `<span class="bad">✗ Chain broken</span> <span style="color:var(--fg-3)">${verify.errors.length} issue(s)</span>`;
  const rows = entries
    .slice()
    .reverse() // newest first in the dashboard view
    .map(
      (e) => `<tr>
        <td class="sym sym-${escape(e.outcome)}">${symbolFor(e.outcome)}</td>
        <td>${escape(e.timestamp.replace("T", " ").slice(0, 19))}</td>
        <td class="commit">${escape((e.commit || "").slice(0, 7))}</td>
        <td>${escape(e.operation)}</td>
        <td>${escape(e.page)}</td>
        <td class="target">${escape(
          (e.details && (e.details.target || e.details.source)) || "",
        )}</td>
      </tr>`,
    )
    .join("");
  return `<div class="audit-status">${status} <span style="margin-left:auto;color:var(--fg-3);font-size:12px">latest 12 entries</span></div>
    <table class="audit-table">
      <thead><tr><th></th><th>When</th><th>Commit</th><th>Operation</th><th>Page</th><th>Target / Source</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// --- request handler -----------------------------------------------------

async function handle(req, res) {
  if (req.method === "POST" && req.url === "/api/run-tests") {
    testCache = await runTests();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(testCache));
    return;
  }

  // Wiki index: /wiki
  if (req.url === "/wiki" || req.url === "/wiki/") {
    const entries = await buildWikiEntries();
    const html = renderWikiIndex(entries);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // Wiki page: /wiki/<example-name>/<actual|expected>
  // Or       : /wiki/<example-name>  (defaults to actual if available)
  const wikiMatch = req.url.match(/^\/wiki\/([a-z0-9-]+)(?:\/(actual|expected))?\/?$/i);
  if (wikiMatch) {
    const exampleName = wikiMatch[1];
    let variant = wikiMatch[2];
    const expected = await safeReadFile(`examples/${exampleName}/expected.md`);
    const actual = await safeReadFile(`examples/${exampleName}/actual.md`);
    const source = await safeReadFile(`examples/${exampleName}/source.md`);
    if (!expected && !actual) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`No example named ${exampleName}`);
      return;
    }
    if (!variant) variant = actual ? "actual" : "expected";
    const md = variant === "actual" ? actual ?? expected : expected ?? actual;
    const { frontmatter, body } = parseFrontmatter(md);
    const html = renderWikiPage({
      slug: exampleName,
      exampleName,
      frontmatter,
      bodyHtml: marked.parse(body),
      hasActual: !!actual,
      hasExpected: !!expected,
      isActual: variant === "actual",
      sourceMd: source ?? "",
    });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.url === "/" || req.url === "/index.html") {
    const [git, tree, roadmap, ghStatus, pendingWorkflows] = await Promise.all([
      gitInfo(),
      fileTree(PROJECT_ROOT),
      loadRoadmapPhase1(),
      checkGhScopes(),
      workflowFilesPending(),
    ]);

    // Build examples entries, gold-standard expected.md and (when present)
    // a real LLM-generated actual.md, side-by-side.
    const examplesDir = path.join(PROJECT_ROOT, "examples");
    let exEntries = [];
    try {
      const dirs = await fs.readdir(examplesDir, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const expected = await safeReadFile(`examples/${d.name}/expected.md`);
        const actual = await safeReadFile(`examples/${d.name}/actual.md`);
        const source = await safeReadFile(`examples/${d.name}/source.md`);
        if (!expected) continue;
        const titleMatch = expected.match(/^title:\s*(.+)$/m);
        exEntries.push({
          name: d.name,
          title: titleMatch ? titleMatch[1] : d.name,
          source: source ? source.split("\n")[0].replace(/^#\s*/, "") : "",
          expectedHtml: marked.parse(expected.replace(/^---[\s\S]*?---\n/, "")),
          actualHtml: actual
            ? marked.parse(actual.replace(/^---[\s\S]*?---\n/, ""))
            : null,
        });
      }
    } catch {
      // ignore
    }

    const decisionsMd = (await safeReadFile("docs/decisions.md")) ?? "(no decisions log)";
    const decisionsHtml = marked.parse(decisionsMd);

    // Audit log (last 12 entries + chain integrity check)
    let auditPanel = null;
    if (auditModule) {
      try {
        const entries = await auditModule.tailAuditEntries(PROJECT_ROOT, 12);
        const verify = await auditModule.verifyAuditChain(PROJECT_ROOT);
        auditPanel = { entries, verify };
      } catch {
        auditPanel = { error: "could not read audit log" };
      }
    }

    const html = renderPage({
      git,
      tree,
      roadmap,
      testStatus: testCache,
      ghStatus,
      pendingWorkflows,
      examples: exEntries,
      decisions: decisionsHtml,
      auditPanel,
    });

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    res.writeHead(500);
    res.end("error: " + (e.message ?? String(e)));
  });
});

server.listen(PORT, () => {
  console.log(`code2wiki dashboard running at http://localhost:${PORT}`);
  console.log(`Press Ctrl-C to stop.`);
});

// Pre-warm the test cache on startup so the first page load shows results.
runTests().then((r) => {
  testCache = r;
  console.log(
    `[startup] Tests: ${r.ok ? "✓ pass" : "✗ fail"} (${r.passed} passed${
      r.failed ? ", " + r.failed + " failed" : ""
    })`,
  );
});
