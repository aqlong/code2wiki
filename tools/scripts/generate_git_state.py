#!/usr/bin/env python3
"""Generate git-state.html, a self-contained local dashboard of the repo's git state.

Run manually:  python3 tools/scripts/generate_git_state.py
Or against a sibling repo path:  python3 tools/scripts/generate_git_state.py --root /Users/.../code2wiki

Produces an untracked file at repo root: git-state.html
The HTML auto-refreshes every 15s in the browser so it always shows the latest state.
A LaunchAgent (com.code2wiki.git-state) regenerates it every 60s so worktree changes
and other git-hook-invisible events stay current automatically.
"""
from __future__ import annotations

import argparse
import datetime
import html as html_mod
import subprocess
import sys
from pathlib import Path

# Default ROOT: tools/scripts/<this file> -> repo root via parents[2].
# Overridden by --root for invocation from a worktree pointed at the main repo.
DEFAULT_ROOT = Path(__file__).resolve().parents[2]
TRUNK = "main"  # code2wiki uses main, not master
REFRESH_SECONDS = 15
STALE_SECONDS = 90


def sh(cmd: list[str], cwd: Path, default: str = "", timeout: int = 10) -> str:
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, check=False, timeout=timeout)
        return r.stdout.strip() if r.returncode == 0 else default
    except Exception:
        return default


def esc(s: str) -> str:
    return html_mod.escape(s or "", quote=True)


def _parse_pending_remote_branches(unmerged_raw: str, root: Path) -> list:
    """Parse `git branch -r --no-merged main` output into pending-branch dicts.

    Filters out HEAD pointers and the trunk itself.
    """
    result = []
    for line in (unmerged_raw.split("\n") if unmerged_raw else []):
        ref = line.strip()
        if not ref or "->" in ref:
            continue
        short = ref.removeprefix("origin/")
        if short in (TRUNK, "master", "staging"):
            continue
        ahead_raw = sh(["git", "rev-list", "--count", f"{TRUNK}..{ref}"], cwd=root)
        try:
            ahead_n = int(ahead_raw)
        except (ValueError, TypeError):
            ahead_n = 0
        log_raw = sh(["git", "log", "-1", "--format=%ai\x1f%s", ref], cwd=root)
        parts = log_raw.split("\x1f", 1)
        c_date = parts[0][:16] if parts and parts[0] else ""
        c_msg = parts[1].strip() if len(parts) > 1 else ""
        result.append({
            "name": short, "ref": ref, "ahead": ahead_n,
            "date": c_date, "msg": c_msg, "kind": "remote",
        })
    return result


def _parse_pending_local_branches(worktrees: list, root: Path) -> list:
    """Return worktree branches that are not yet merged into trunk."""
    result = []
    seen: set = set()
    for wt in worktrees:
        b_name = wt.get("branch", "")
        if not b_name or b_name in (TRUNK, "master", "staging") or b_name in seen:
            continue
        seen.add(b_name)
        merged = sh(["git", "branch", "--merged", TRUNK, "--list", b_name], cwd=root)
        if merged.strip():
            continue
        ahead_raw = sh(["git", "rev-list", "--count", f"{TRUNK}..{b_name}"], cwd=root)
        try:
            ahead_n = int(ahead_raw)
        except (ValueError, TypeError):
            ahead_n = 0
        log_raw = sh(["git", "log", "-1", "--format=%ai\x1f%s", b_name], cwd=root)
        parts = log_raw.split("\x1f", 1)
        c_date = parts[0][:16] if parts and parts[0] else ""
        c_msg = parts[1].strip() if len(parts) > 1 else ""
        result.append({
            "name": b_name, "ref": b_name, "ahead": ahead_n,
            "date": c_date, "msg": c_msg, "kind": "worktree",
        })
    return result


def gather_state(root: Path) -> dict:
    branch = sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=root) or "DETACHED"
    head_short = sh(["git", "rev-parse", "--short", "HEAD"], cwd=root)
    head_full = sh(["git", "rev-parse", "HEAD"], cwd=root)
    head_subject = sh(["git", "log", "-1", "--format=%s"], cwd=root)
    head_date = sh(["git", "log", "-1", "--format=%ai"], cwd=root)

    upstream = sh(["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd=root)
    ahead = behind = 0
    if upstream:
        ab = sh(["git", "rev-list", "--left-right", "--count", "@{u}...HEAD"], cwd=root)
        if ab:
            parts = ab.split()
            if len(parts) == 2:
                try:
                    behind, ahead = int(parts[0]), int(parts[1])
                except ValueError:
                    pass

    status_raw = sh(["git", "status", "--porcelain=v1"], cwd=root)
    status_lines = [l for l in status_raw.split("\n") if l]
    staged, unstaged, untracked = [], [], []
    for line in status_lines:
        if line.startswith("??"):
            untracked.append(line[3:])
        else:
            x, y = line[0], line[1]
            path = line[3:]
            if x != " " and x != "?":
                staged.append({"code": x, "path": path})
            if y != " " and y != "?":
                unstaged.append({"code": y, "path": path})

    stash_raw = sh(["git", "stash", "list"], cwd=root)
    stashes = [l for l in stash_raw.split("\n") if l] if stash_raw else []

    unpushed = []
    if ahead > 0 and upstream:
        raw = sh(["git", "log", "@{u}..HEAD", "--format=%h\x1f%ai\x1f%s"], cwd=root)
        for line in raw.split("\n") if raw else []:
            parts = line.split("\x1f", 2)
            if len(parts) == 3:
                unpushed.append({"sha": parts[0], "date": parts[1], "msg": parts[2]})

    recent_raw = sh(["git", "log", "-15", "--format=%h\x1f%ai\x1f%s"], cwd=root)
    recent = []
    for line in recent_raw.split("\n") if recent_raw else []:
        parts = line.split("\x1f", 2)
        if len(parts) == 3:
            recent.append({"sha": parts[0], "date": parts[1], "msg": parts[2]})

    br_raw = sh([
        "git", "for-each-ref", "--sort=-committerdate",
        "--format=%(refname:short)\x1f%(committerdate:iso)\x1f%(subject)\x1f%(upstream:trackshort)",
        "refs/heads/",
    ], cwd=root)
    branches = []
    for line in br_raw.split("\n") if br_raw else []:
        parts = line.split("\x1f", 3)
        if len(parts) >= 3:
            branches.append({
                "name": parts[0],
                "date": parts[1],
                "msg": parts[2],
                "track": parts[3] if len(parts) > 3 else "",
            })

    wt_raw = sh(["git", "worktree", "list", "--porcelain"], cwd=root)
    worktree_branches = set()
    current_wt = None
    worktrees = []
    for line in wt_raw.split("\n") if wt_raw else []:
        if line.startswith("worktree "):
            current_wt = {"path": line[9:], "branch": ""}
            worktrees.append(current_wt)
        elif line.startswith("branch refs/heads/") and current_wt is not None:
            b = line.replace("branch refs/heads/", "")
            current_wt["branch"] = b
            worktree_branches.add(b)

    remotes_raw = sh(["git", "remote", "-v"], cwd=root)
    remotes = {}
    for line in remotes_raw.split("\n") if remotes_raw else []:
        if "(fetch)" in line:
            parts = line.split()
            if len(parts) >= 2:
                remotes[parts[0]] = parts[1]

    unmerged_remote_raw = sh(["git", "branch", "-r", "--no-merged", TRUNK], cwd=root)
    pending_remote_branches = _parse_pending_remote_branches(unmerged_remote_raw, root)
    pending_local_branches = _parse_pending_local_branches(worktrees, root)

    return {
        "branch": branch,
        "head_short": head_short,
        "head_full": head_full,
        "head_subject": head_subject,
        "head_date": head_date,
        "upstream": upstream,
        "ahead": ahead,
        "behind": behind,
        "staged": staged,
        "unstaged": unstaged,
        "untracked": untracked,
        "stashes": stashes,
        "unpushed": unpushed,
        "recent": recent,
        "branches": branches,
        "worktrees": worktrees,
        "worktree_branches": worktree_branches,
        "remotes": remotes,
        "pending_remote_branches": pending_remote_branches,
        "pending_local_branches": pending_local_branches,
    }


# HTML rendering

CSS = """
:root {
  --bg: #0b1020; --bg-2: #111733; --card: #151c3a; --card-2: #1b2348;
  --border: #2a3463; --text: #e8ecff; --muted: #95a0cf;
  --accent: #7aa2ff; --ok: #4ade80; --warn: #facc15; --crit: #f87171;
  --info: #60a5fa; --purple: #c084fc;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; min-width: 0; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  overflow-x: hidden; max-width: 100vw; }
body { min-height: 100vh;
  background:
    radial-gradient(1200px 600px at 10% -10%, #1a2355 0%, transparent 60%),
    radial-gradient(900px 500px at 100% 0%, #2a1d55 0%, transparent 55%),
    var(--bg); }
.wrap { max-width: 1400px; margin: 0 auto; padding: 28px clamp(14px, 2.5vw, 32px) 60px; }
header { display: flex; align-items: flex-end; justify-content: space-between;
  flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
header > div:first-child { min-width: 0; flex: 1 1 auto; }
h1 { font-size: clamp(20px, 2.6vw, 28px); margin: 0 0 6px; letter-spacing: -0.02em; }
.sub { color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stamp { font-family: var(--mono); font-size: 11px; color: var(--muted); text-align: right;
  flex: 0 0 auto; line-height: 1.6; }
.stamp b { color: var(--text); }
.live { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  background: var(--ok); box-shadow: 0 0 0 0 rgba(74,222,128,0.6);
  animation: pulse 2s infinite; margin-right: 6px; vertical-align: middle; }
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(74,222,128,0.6); }
  70% { box-shadow: 0 0 0 8px rgba(74,222,128,0); }
  100% { box-shadow: 0 0 0 0 rgba(74,222,128,0); }
}
.grid { display: grid; gap: 16px; }
.grid-top { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 20px; }
.grid-main { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
@media (max-width: 1100px) {
  .grid-main { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 820px) {
  .grid-top { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  header { flex-direction: column; align-items: flex-start; }
  .stamp { text-align: left; }
}
@media (max-width: 480px) {
  .grid-top { grid-template-columns: minmax(0, 1fr); }
  .wrap { padding: 18px 12px 40px; }
}
.card { background: linear-gradient(180deg, var(--card) 0%, var(--card-2) 100%);
  border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.25);
  min-width: 0; overflow: hidden; }
.card h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--muted); margin: 0 0 14px; font-weight: 600; }
.stat .num { font-size: clamp(24px, 3.2vw, 32px); font-weight: 700; font-family: var(--mono);
  letter-spacing: -0.02em; overflow: hidden; text-overflow: ellipsis; }
.stat .label { font-size: 11px; color: var(--muted); margin-top: 4px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stat.ok .num { color: var(--ok); }
.stat.warn .num { color: var(--warn); }
.stat.crit .num { color: var(--crit); }
.stat.info .num { color: var(--info); }
.row { display: flex; align-items: center; gap: 10px; padding: 9px 0;
  border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 13px; }
.row:last-child { border-bottom: none; }
.sha { font-family: var(--mono); font-size: 12px; color: var(--accent);
  flex: 0 0 auto; min-width: 62px; }
.msg { flex: 1 1 auto; min-width: 0; color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.when { font-family: var(--mono); font-size: 11px; color: var(--muted);
  flex: 0 0 auto; min-width: 90px; text-align: right; }
@media (max-width: 600px) {
  .when { display: none; }
}
.branch { display: flex; align-items: center; gap: 10px; padding: 10px 0;
  border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 13px; }
.branch:last-child { border-bottom: none; }
.branch .name { font-family: var(--mono); color: var(--text);
  flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.branch .name .tag { display: inline-block; margin-left: 6px; padding: 2px 7px;
  border-radius: 999px; font-size: 10px; font-weight: 600; }
.tag.current { background: rgba(122,162,255,0.15); color: var(--accent); border: 1px solid rgba(122,162,255,0.3); }
.tag.wt { background: rgba(192,132,252,0.12); color: var(--purple); border: 1px solid rgba(192,132,252,0.3); }
.tag.ahead { background: rgba(74,222,128,0.12); color: var(--ok); border: 1px solid rgba(74,222,128,0.3); }
.tag.behind { background: rgba(248,113,113,0.12); color: var(--crit); border: 1px solid rgba(248,113,113,0.3); }
.branch .subj { font-size: 11px; color: var(--muted); font-family: var(--mono);
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
.pill { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: 10px;
  font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; flex: 0 0 auto; }
.pill.ok { background: rgba(74,222,128,0.12); color: var(--ok); border: 1px solid rgba(74,222,128,0.3); }
.pill.warn { background: rgba(250,204,21,0.12); color: var(--warn); border: 1px solid rgba(250,204,21,0.3); }
.pill.crit { background: rgba(248,113,113,0.12); color: var(--crit); border: 1px solid rgba(248,113,113,0.3); }
.pill.info { background: rgba(96,165,250,0.12); color: var(--info); border: 1px solid rgba(96,165,250,0.3); }
.file-list { font-family: var(--mono); font-size: 11px; color: var(--muted);
  max-height: 360px; overflow-y: auto; min-width: 0; }
.file-list div { padding: 2px 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; min-width: 0; }
.file-list .group { color: var(--accent); font-weight: 600; padding: 8px 0 4px;
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
  border-top: 1px solid rgba(255,255,255,0.04); margin-top: 4px; }
.file-list .group:first-child { border-top: none; margin-top: 0; }
.priority { display: flex; gap: 10px; padding: 12px; background: rgba(248,113,113,0.06);
  border: 1px solid rgba(248,113,113,0.2); border-radius: 10px; margin-bottom: 10px;
  min-width: 0; }
.priority.warn { background: rgba(250,204,21,0.06); border-color: rgba(250,204,21,0.2); }
.priority.ok { background: rgba(74,222,128,0.06); border-color: rgba(74,222,128,0.2); }
.priority.info { background: rgba(96,165,250,0.06); border-color: rgba(96,165,250,0.2); }
.priority .icon { font-size: 18px; flex: 0 0 auto; }
.priority .body { flex: 1 1 auto; min-width: 0; font-size: 12px; overflow-wrap: break-word; word-break: break-word; }
.priority .body b { color: var(--text); display: block; margin-bottom: 2px; }
.priority .body span { color: var(--muted); }
.callout { padding: 12px 14px; border-radius: 10px; background: rgba(122,162,255,0.06);
  border: 1px solid rgba(122,162,255,0.2); font-size: 12px; color: var(--muted); margin-top: 16px;
  overflow-wrap: break-word; word-break: break-word; }
.callout b { color: var(--text); }
footer { margin-top: 28px; text-align: center; color: var(--muted); font-size: 11px;
  font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 0 12px; }
.stale-banner { display: none; align-items: center; gap: 10px; padding: 10px 16px;
  background: rgba(250,204,21,0.08); border: 1px solid rgba(250,204,21,0.3);
  border-radius: 10px; margin-bottom: 16px; font-size: 12px; color: var(--warn); }
.stale-banner .stale-icon { flex: 0 0 auto; font-size: 16px; }
.stale-banner .stale-msg { flex: 1 1 auto; }
.stale-banner .stale-dismiss { flex: 0 0 auto; cursor: pointer; opacity: 0.6;
  font-size: 16px; line-height: 1; padding: 0 4px; }
.stale-banner .stale-dismiss:hover { opacity: 1; }
a { color: var(--accent); text-decoration: none; }
code { font-family: var(--mono); background: rgba(255,255,255,0.05); padding: 1px 5px;
  border-radius: 4px; font-size: 0.92em; word-break: break-word; }
.empty { color: var(--muted); font-size: 12px; font-style: italic; padding: 8px 0; }
"""

JS = """
(function(){
  var stamp = new Date();
  var pad = function(n){ return n < 10 ? '0' + n : '' + n; };
  var human = stamp.getFullYear() + '-' + pad(stamp.getMonth()+1) + '-' + pad(stamp.getDate()) +
              ' ' + pad(stamp.getHours()) + ':' + pad(stamp.getMinutes()) + ':' + pad(stamp.getSeconds());
  var el = document.getElementById('viewed');
  if (el) el.textContent = human;

  var genAt = new Date(document.getElementById('gen-at').getAttribute('data-iso'));
  var diffMs = stamp - genAt;
  var diffSec = Math.round(diffMs / 1000);
  var rel;
  if (diffSec < 2) rel = 'just now';
  else if (diffSec < 60) rel = diffSec + ' sec ago';
  else if (diffSec < 3600) rel = Math.round(diffSec/60) + ' min ago';
  else if (diffSec < 86400) rel = Math.round(diffSec/3600) + ' hr ago';
  else rel = Math.round(diffSec/86400) + ' days ago';
  var rx = document.getElementById('gen-rel');
  if (rx) rx.textContent = rel;

  var STALE = __STALE__;
  var DISMISS_TTL = 300;
  function checkStale() {
    var age = Math.round((Date.now() - genAt.getTime()) / 1000);
    var banner = document.getElementById('stale-banner');
    if (!banner) return;
    if (age <= STALE) {
      sessionStorage.removeItem('stale_dismissed');
      banner.style.display = 'none';
      return;
    }
    var dismissed = parseInt(sessionStorage.getItem('stale_dismissed') || '0', 10);
    var sinceDissmiss = Math.round(Date.now() / 1000) - dismissed;
    if (dismissed && sinceDissmiss < DISMISS_TTL) {
      banner.style.display = 'none';
      return;
    }
    var mins = Math.round(age / 60);
    document.getElementById('stale-age').textContent = mins === 1 ? '1 min' : mins + ' min';
    banner.style.display = 'flex';
  }
  document.getElementById('stale-banner').querySelector('.stale-dismiss').addEventListener('click', function() {
    sessionStorage.setItem('stale_dismissed', String(Math.round(Date.now() / 1000)));
    document.getElementById('stale-banner').style.display = 'none';
  });
  checkStale();

  var sec = __REFRESH__;
  var cd = document.getElementById('countdown');
  setInterval(function(){
    sec -= 1;
    if (sec <= 0) sec = __REFRESH__;
    if (cd) cd.textContent = sec + 's';
    checkStale();
  }, 1000);
})();
""".replace("__REFRESH__", str(REFRESH_SECONDS)).replace("__STALE__", str(STALE_SECONDS))


def render_top_stats(s: dict) -> str:
    dirty = bool(s["staged"] or s["unstaged"] or s["untracked"])
    tree_word = "dirty" if dirty else "clean"
    dirty_parts = []
    if s["staged"]:
        dirty_parts.append(f"{len(s['staged'])} staged")
    if s["unstaged"]:
        dirty_parts.append(f"{len(s['unstaged'])} unstaged")
    if s["untracked"]:
        dirty_parts.append(f"{len(s['untracked'])} untracked")
    tree_label = ", ".join(dirty_parts) if dirty_parts else "nothing to commit"

    # For code2wiki, unpushed > 0 is the common case under the direct-push norm.
    # Highlight only when there are uncommitted local changes or upstream divergence.
    ahead_class = "info" if s["ahead"] > 0 else "ok"
    if s["upstream"]:
        ahead_label = f"ahead of {esc(s['upstream'])}"
        if s["behind"]:
            ahead_label += f" &middot; behind {s['behind']}"
    else:
        ahead_label = "no upstream"

    stash_class = "crit" if len(s["stashes"]) >= 10 else ("warn" if s["stashes"] else "ok")

    return f"""
<div class="grid grid-top">
  <div class="card stat info">
    <h2>Current Branch</h2>
    <div class="num">{esc(s['branch'])}</div>
    <div class="label">HEAD {esc(s['head_short'])} &middot; {esc(tree_word)} ({esc(tree_label)})</div>
  </div>
  <div class="card stat {ahead_class}">
    <h2>Unpushed Commits</h2>
    <div class="num">{s['ahead']}</div>
    <div class="label">{ahead_label}</div>
  </div>
  <div class="card stat {'warn' if s['untracked'] else 'ok'}">
    <h2>Untracked Files</h2>
    <div class="num">{len(s['untracked'])}</div>
    <div class="label">in working tree</div>
  </div>
  <div class="card stat {stash_class}">
    <h2>Stashes</h2>
    <div class="num">{len(s['stashes'])}</div>
    <div class="label">git stash list</div>
  </div>
</div>
"""


def render_priorities(s: dict) -> str:
    items = []

    # code2wiki: direct-push to main is the norm after green tests. Surface unpushed
    # commits as a nudge to push, NOT as a "do not push" warning.
    if s["ahead"] > 0 and s["branch"] == TRUNK:
        items.append((
            "info", "&#8593;",
            f"{s['ahead']} unpushed commit(s) on {esc(TRUNK)}",
            "code2wiki direct-pushes to <code>main</code> after green tests. "
            "Run <code>npm test &amp;&amp; npm run typecheck</code>, then "
            f"<code>git push origin {esc(TRUNK)}</code> when ready."
        ))
    elif s["ahead"] > 0:
        items.append((
            "warn", "&#9888;",
            f"{s['ahead']} unpushed commit(s) on {esc(s['branch'])}",
            f"Not on <code>{esc(TRUNK)}</code>. Confirm intent before pushing this branch."
        ))

    if len(s["stashes"]) >= 5:
        items.append((
            "warn", "&#128193;",
            f"{len(s['stashes'])} stashes",
            "Review <code>git stash list</code> and prune stale entries."
        ))

    if s["behind"] > 0:
        items.append((
            "crit", "&#9888;",
            f"Current branch is behind {esc(s['upstream'] or 'upstream')} by {s['behind']}",
            "Consider <code>git pull --ff-only</code> before new commits."
        ))

    if s["staged"] or s["unstaged"]:
        # Two-cooks gotcha from CLAUDE.md: dirty trees block ocean-bot ticks.
        dirty_n = len(s["staged"]) + len(s["unstaged"])
        items.append((
            "warn", "&#128075;",
            f"{dirty_n} uncommitted change(s) in working tree",
            "Two-cooks reminder: ocean-bot's per-tick <code>isClean()</code> gate refuses "
            "dirty trees and the launch wrapper's <code>git pull --ff-only</code> also "
            "skips on dirty trees. Commit or stash before walking away."
        ))

    if not (s["staged"] or s["unstaged"] or s["untracked"]):
        items.append((
            "ok", "&#10004;",
            "Working tree clean",
            "No staged, unstaged, or untracked changes."
        ))

    rows = []
    for cls, icon, title, body in items:
        rows.append(f"""
    <div class="priority {cls}">
      <div class="icon">{icon}</div>
      <div class="body"><b>{title}</b><span>{body}</span></div>
    </div>""")
    return '<div class="card" style="margin-bottom: 20px;"><h2>&#9888; Priorities &amp; Things You Should Know</h2>' + "".join(rows) + "</div>"


def render_commit_row(c: dict) -> str:
    d = c["date"][:16] if c["date"] else ""
    return f'<div class="row"><span class="sha">{esc(c["sha"])}</span><span class="msg">{esc(c["msg"])}</span><span class="when">{esc(d)}</span></div>'


def render_unpushed(s: dict) -> str:
    if not s["unpushed"]:
        body = '<div class="empty">No unpushed commits. In sync with upstream.</div>'
    else:
        body = "".join(render_commit_row(c) for c in s["unpushed"])
    title = f"&#8593; Unpushed Commits ({esc(s['branch'])} vs {esc(s['upstream'] or 'upstream')})"
    return f'<div class="card" style="margin-bottom: 16px;"><h2>{title}</h2>{body}</div>'


def render_recent(s: dict) -> str:
    rows = "".join(render_commit_row(c) for c in s["recent"])
    return f'<div class="card" style="margin-bottom: 16px;"><h2>Recent Commits on {esc(s["branch"])}</h2>{rows}</div>'


def render_branches(s: dict) -> str:
    rows = []
    for b in s["branches"]:
        tags = []
        if b["name"] == s["branch"]:
            tags.append('<span class="tag current">current</span>')
        if b["name"] in s["worktree_branches"] and b["name"] != s["branch"]:
            tags.append('<span class="tag wt">worktree</span>')
        tr = (b.get("track") or "").strip()
        if tr:
            if "ahead" in tr and "behind" in tr:
                tags.append(f'<span class="tag ahead">{esc(tr)}</span>')
            elif "ahead" in tr:
                tags.append(f'<span class="tag ahead">{esc(tr)}</span>')
            elif "behind" in tr:
                tags.append(f'<span class="tag behind">{esc(tr)}</span>')
        tag_html = " ".join(tags)
        rows.append(f'''
        <div class="branch">
          <span class="name">{esc(b["name"])} {tag_html}</span>
          <span class="subj">{esc(b["msg"])}</span>
        </div>''')
    return f'<div class="card"><h2>Local Branches &amp; Worktrees</h2>{"".join(rows)}</div>'


def render_untracked(s: dict) -> str:
    if not s["untracked"]:
        return '<div class="card" style="margin-bottom: 16px;"><h2>Untracked Files (0)</h2><div class="empty">Working tree has no untracked files.</div></div>'

    groups: dict[str, list[str]] = {}
    for f in s["untracked"]:
        key = f.split("/", 1)[0] if "/" in f else "(root)"
        groups.setdefault(key, []).append(f)

    parts = []
    for key in sorted(groups.keys()):
        files = groups[key]
        parts.append(f'<div class="group">{esc(key)} ({len(files)})</div>')
        for f in files:
            parts.append(f'<div>{esc(f)}</div>')

    return f'<div class="card" style="margin-bottom: 16px;"><h2>Untracked Files ({len(s["untracked"])})</h2><div class="file-list">{"".join(parts)}</div></div>'


def render_changes(s: dict) -> str:
    if not (s["staged"] or s["unstaged"]):
        return ""
    rows = []
    for item in s["staged"]:
        rows.append(f'<div class="row"><span class="pill info">staged {esc(item["code"])}</span><span class="msg" style="font-family: var(--mono); font-size: 11px;">{esc(item["path"])}</span></div>')
    for item in s["unstaged"]:
        rows.append(f'<div class="row"><span class="pill warn">unstaged {esc(item["code"])}</span><span class="msg" style="font-family: var(--mono); font-size: 11px;">{esc(item["path"])}</span></div>')
    return f'<div class="card" style="margin-bottom: 16px;"><h2>Changed Files</h2>{"".join(rows)}</div>'


def render_remotes_tree(s: dict) -> str:
    remote_rows = []
    for name, url in s["remotes"].items():
        remote_rows.append(f'<div class="row"><span class="pill info">{esc(name)}</span><span class="msg" style="font-family: var(--mono); font-size: 11px;">{esc(url)}</span></div>')

    tree_rows = []
    if s["staged"]:
        tree_rows.append(f'<div class="row"><span class="pill info">staged</span><span class="msg">{len(s["staged"])} file(s)</span></div>')
    else:
        tree_rows.append('<div class="row"><span class="pill ok">clean</span><span class="msg">no staged changes</span></div>')
    if s["unstaged"]:
        tree_rows.append(f'<div class="row"><span class="pill warn">unstaged</span><span class="msg">{len(s["unstaged"])} file(s)</span></div>')
    else:
        tree_rows.append('<div class="row"><span class="pill ok">clean</span><span class="msg">no unstaged changes</span></div>')
    if s["untracked"]:
        tree_rows.append(f'<div class="row"><span class="pill warn">untracked</span><span class="msg">{len(s["untracked"])} path(s)</span></div>')
    else:
        tree_rows.append('<div class="row"><span class="pill ok">clean</span><span class="msg">no untracked files</span></div>')
    if s["stashes"]:
        stash_pill = "crit" if len(s["stashes"]) >= 10 else "warn"
        tree_rows.append(f'<div class="row"><span class="pill {stash_pill}">stashes</span><span class="msg">{len(s["stashes"])}</span></div>')
    else:
        tree_rows.append('<div class="row"><span class="pill ok">clean</span><span class="msg">no stashes</span></div>')

    return f'''
<div class="card" style="margin-bottom: 16px;">
  <h2>Remotes</h2>
  {"".join(remote_rows) or '<div class="empty">No remotes.</div>'}
</div>
<div class="card">
  <h2>Working Tree</h2>
  {"".join(tree_rows)}
</div>
'''


def render_worktrees(s: dict) -> str:
    if len(s["worktrees"]) <= 1:
        return ""
    rows = []
    for wt in s["worktrees"]:
        label = wt["branch"] or "(detached)"
        rows.append(f'<div class="row"><span class="sha">{esc(label)}</span><span class="msg" style="font-family: var(--mono); font-size: 11px;">{esc(wt["path"])}</span></div>')
    return f'<div class="card" style="margin-bottom: 16px;"><h2>Active Worktrees</h2>{"".join(rows)}</div>'


def render_pending_branches(s: dict) -> str:
    remote_items = s.get("pending_remote_branches", [])
    local_items = s.get("pending_local_branches", [])
    all_items = local_items + remote_items
    if not all_items:
        return ""

    rows = []
    for b in all_items:
        if b["kind"] == "worktree":
            kind_tag = '<span class="tag wt" title="Active worktree, in-progress local branch">worktree</span>'
        else:
            kind_tag = f'<span class="tag current" title="Remote branch not yet merged into {esc(TRUNK)}">remote</span>'
        ahead_html = (
            f'<span class="tag ahead">+{b["ahead"]}</span>'
            if b["ahead"] > 0 else ""
        )
        rows.append(f"""
    <div class="branch">
      <span class="name" style="flex: 0 0 auto; max-width: 260px;">
        {esc(b["name"])} {kind_tag} {ahead_html}
      </span>
      <span class="subj">{esc(b["msg"])}</span>
      <span class="when">{esc(b["date"])}</span>
    </div>""")

    count = len(all_items)
    note = (
        '<div style="margin-top: 14px; padding: 10px 12px; border-radius: 8px; '
        'background: rgba(122,162,255,0.05); border: 1px solid rgba(122,162,255,0.15); '
        'font-size: 11px; color: var(--muted);">'
        '<b style="color: var(--text);">Leave alone until reviewed.</b> '
        'Remote <code>claude/*</code> branches are Claude Code worktree outputs awaiting founder review. '
        'Local worktree branches are in-progress work. Do not auto-merge.'
        '</div>'
    )
    return (
        f'<div class="card" style="margin-bottom: 20px;">'
        f'<h2>&#128269; Pending Branches &middot; Needs Review or Approval ({count})</h2>'
        f'{"".join(rows)}{note}</div>'
    )


def render_html(s: dict) -> str:
    now = datetime.datetime.now().astimezone()
    now_iso = now.isoformat()
    now_human = now.strftime("%Y-%m-%d %H:%M:%S")
    tz = now.strftime("%Z") or ""

    remote_url = next(iter(s["remotes"].values()), "")

    top = render_top_stats(s)
    priorities = render_priorities(s)
    pending_branches = render_pending_branches(s)
    unpushed = render_unpushed(s)
    changes = render_changes(s)
    recent = render_recent(s)
    branches = render_branches(s)
    untracked = render_untracked(s)
    worktrees = render_worktrees(s)
    remotes_tree = render_remotes_tree(s)

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>code2wiki &middot; Git State Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="{REFRESH_SECONDS}">
<style>{CSS}</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>Git State Dashboard</h1>
      <div class="sub">code2wiki &middot; <a href="{esc(remote_url)}" target="_blank">{esc(remote_url)}</a></div>
    </div>
    <div class="stamp">
      <span class="live"></span>auto-refresh every {REFRESH_SECONDS}s &middot; next in <b id="countdown">{REFRESH_SECONDS}s</b><br>
      generated <b id="gen-at" data-iso="{esc(now_iso)}">{esc(now_human)} {esc(tz)}</b> &middot; <span id="gen-rel">just now</span><br>
      viewed <b id="viewed">&hellip;</b>
    </div>
  </header>

  {top}

  <div id="stale-banner" class="stale-banner">
    <span class="stale-icon">&#9888;</span>
    <span class="stale-msg">Data may be stale &middot; last generated <b id="stale-age">?</b> ago. The 60s LaunchAgent may not be running. Refresh: <code>python3 tools/scripts/generate_git_state.py</code></span>
    <span class="stale-dismiss" title="Dismiss for 5 minutes">&#x2715;</span>
  </div>

  {priorities}

  {pending_branches}

  <div class="grid grid-main">
    <div>
      {unpushed}
      {changes}
      {recent}
      {branches}
    </div>
    <div>
      {untracked}
      {worktrees}
      {remotes_tree}
    </div>
  </div>

  <div class="callout">
    <b>How this works:</b> <code>tools/scripts/generate_git_state.py</code> regenerates this file
    every 60s via the <code>com.code2wiki.git-state</code> LaunchAgent
    (covers worktree add/remove and other hook-invisible events). The browser auto-reloads
    every {REFRESH_SECONDS}s via <code>&lt;meta http-equiv="refresh"&gt;</code> so new state
    shows up without a manual refresh. Run manually anytime with
    <code>python3 tools/scripts/generate_git_state.py</code>.
  </div>

  <footer>
    code2wiki git-state &middot; HEAD {esc(s['head_short'])} &middot; {esc(s['head_subject'])}
  </footer>
</div>
<script>{JS}</script>
</body>
</html>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT,
                        help="Repo root to inspect (default: inferred from this script's location)")
    parser.add_argument("--out", type=Path, default=None,
                        help="Output HTML path (default: <root>/git-state.html)")
    args = parser.parse_args()

    root = args.root.resolve()
    out = args.out.resolve() if args.out else (root / "git-state.html")

    if not (root / ".git").exists():
        print(f"error: {root} is not a git repo (no .git found)", file=sys.stderr)
        return 1

    s = gather_state(root)
    html_out = render_html(s)
    out.write_text(html_out, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
