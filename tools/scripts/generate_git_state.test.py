#!/usr/bin/env python3
"""Unit tests for tools/scripts/generate_git_state.py pure helpers.

Run: python3 tools/scripts/generate_git_state.test.py

Stdlib-only. Loads the sibling script via importlib (the hyphenated /
sibling filename rules out a plain `import`). Mirrors the pattern in
tools/scripts/generate_c2w_state.test.py + strip-em-dashes.test.py.

Scope: pin every pure render_* helper in generate_git_state.py plus the
top-level `render_html` page composer. The script regenerates
`git-state.html` every 60s via the com.code2wiki.git-state LaunchAgent;
the helpers feed the operator's at-a-glance triage dashboard for local
git state (priorities card, commits, top stats, branches, remotes,
worktrees, pending / unpushed / recent). The `render_html` smoke pins
defend against helper-drop / helper-swap / esc-removal / refresh-constant
drift via targeted-marker assertions (a full-page chunk pin would be
brittle against incidental copy edits and the per-regenerate datetime
fields).

Representative routing the helpers exercise (defended in this suite):

  - render_priorities: ahead-on-TRUNK info vs off-TRUNK warn, stash
    boundary at exactly 5, behind boundary at exactly 1, the
    untracked-only carve-out from both the dirty-warn and clean-ok arms.
  - render_top_stats: stash-pluralization boundary, ahead/behind colour
    routing, untracked-class -> warn vs neutral.
  - render_branches / render_remotes_tree / render_worktrees /
    render_pending_branches / render_unpushed / render_recent: tag
    accumulation, kind-tag routing, ahead/behind boundaries, working-tree
    card composition, and every independent esc() site (branch names,
    commit subjects, remote URLs, paths) -- each esc is a separate
    regression target since a drop-esc refactor would inject markup into
    the always-visible dashboard.
  - render_html: composition (every helper wired in), header / footer
    interpolation + esc, meta-refresh constant, load-bearing section
    order, and the empty-state conditional-helper omissions.

The full generator still depends on git subprocess side effects (the
`sh` helper); those are out of scope here. This file pins only the pure
render layer.
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


def _load_script():
    here = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location(
        "generate_git_state", here / "generate_git_state.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_script = _load_script()
esc = _script.esc
render_priorities = _script.render_priorities
render_commit_row = _script.render_commit_row
render_top_stats = _script.render_top_stats
render_untracked = _script.render_untracked
render_changes = _script.render_changes
render_branches = _script.render_branches
render_remotes_tree = _script.render_remotes_tree
render_worktrees = _script.render_worktrees
render_pending_branches = _script.render_pending_branches
render_unpushed = _script.render_unpushed
render_recent = _script.render_recent
render_html = _script.render_html
REFRESH_SECONDS = _script.REFRESH_SECONDS
TRUNK = _script.TRUNK


def _state(**overrides) -> dict:
    """Build a default-clean state dict; tests override specific fields."""
    base = {
        "branch": TRUNK,
        "head_short": "abc1234",
        "head_subject": "init",
        "ahead": 0,
        "behind": 0,
        "upstream": f"origin/{TRUNK}",
        "staged": [],
        "unstaged": [],
        "untracked": [],
        "stashes": [],
        "branches": [],
        "worktree_branches": set(),
        "worktrees": [],
        "remotes": {},
        "unpushed": [],
        "recent": [],
    }
    base.update(overrides)
    return base


class EscTests(unittest.TestCase):
    """Pin `esc()` (generate_git_state.py:37), the load-bearing HTML-escape
    primitive every render_* helper funnels through. Render-helper tests
    exercise esc indirectly via XSS-payload assertions; these pins target
    the helper's contract directly so a refactor of the one-liner (drop
    quote=True, drop the `or ""` null-coalesce, swap to a custom shim)
    surfaces here at the source instead of cascading through every
    render_* suite. The contract:

      1. None / empty -> empty string (caller patterns like
         `esc(wt["branch"] or "(detached)")` pre-fallback, but the inner
         `or ""` is defense-in-depth; without it `esc(None)` would
         TypeError and crash a dashboard regenerate).
      2. quote=True is non-negotiable: both `"` and `'` are escaped, so
         the helper is safe in attribute context as well as text
         context.  A regression dropping quote=True would silently
         re-open the attribute-injection path on branch names + commit
         subjects + remote URLs.
      3. Standard html.escape semantics for the three structural chars:
         `<`, `>`, `&`. A custom escape that handles only some breaks
         the chain.
      4. Already-escaped input is escaped AGAIN (no idempotency hack).
         A "smart" refactor that tries to detect existing entities would
         silently fail to re-escape an attacker-controlled string that
         happens to contain `&amp;`.
    """

    def test_none_returns_empty_string(self):
        # Pins the `or ""` null-coalesce in `html_mod.escape(s or "", ...)`.
        # Drop it and esc(None) becomes a TypeError from html.escape,
        # crashing every dashboard regenerate the moment any optional
        # field (upstream, branch on a detached HEAD, etc.) is None.
        self.assertEqual(esc(None), "")

    def test_empty_string_returns_empty_string(self):
        # Boundary partner to the None case. A refactor returning a
        # sentinel like "(empty)" would change the dashboard's empty-
        # cell rendering across every helper.
        self.assertEqual(esc(""), "")

    def test_double_quote_escaped_via_quote_true(self):
        # Pins quote=True on the double-quote character. Without this,
        # an attacker-controlled string with `"` injected into an HTML
        # attribute context (the dashboard interpolates esc() output
        # into `title="..."` and `class="..."` attributes in several
        # spots) breaks out of the attribute and injects arbitrary
        # markup.
        self.assertEqual(esc('"'), "&quot;")

    def test_single_quote_escaped_via_quote_true(self):
        # Pins quote=True on the single-quote character. html.escape
        # escapes `'` as `&#x27;` (not `&apos;`) when quote=True; without
        # quote=True, `'` passes through verbatim. The same attribute-
        # injection rationale applies; some attribute interpolation
        # sites use single quotes.
        self.assertEqual(esc("'"), "&#x27;")

    def test_less_than_escaped(self):
        # Foundational: `<` must become `&lt;` to prevent tag injection.
        # The render_* XSS-payload tests assert combined sequences; this
        # pin isolates the single-char contract so a regression on `<`
        # alone (e.g., a refactor that escapes only `<script>` literal)
        # surfaces here.
        self.assertEqual(esc("<"), "&lt;")

    def test_greater_than_escaped(self):
        # Partner pin to `<`. Both required for tag escaping; a refactor
        # escaping only one (rare but observed in custom shims) would
        # produce malformed HTML and visible markup.
        self.assertEqual(esc(">"), "&gt;")

    def test_ampersand_escaped(self):
        # `&` must become `&amp;` first so that subsequent escaping
        # passes don't double-substitute. A refactor that escapes `<`
        # and `>` but skips `&` produces XSS surface on attacker-
        # controlled strings containing `&lt;script&gt;` (interpreted
        # by the browser as `<script>`).
        self.assertEqual(esc("&"), "&amp;")

    def test_xss_payload_full_escape(self):
        # Real-world regression target. A drop-esc refactor on any of
        # render_branches / render_commit_row / render_pending_branches
        # would let this payload through verbatim from a malicious
        # branch name or commit subject. Pinning the combined output
        # gives a single-assertion canary for the most likely attack
        # shape.
        self.assertEqual(
            esc("<script>alert(1)</script>"),
            "&lt;script&gt;alert(1)&lt;/script&gt;",
        )

    def test_plain_ascii_passes_through_unchanged(self):
        # No accidental trim, no accidental case-normalisation, no
        # accidental whitespace collapse. Pins that esc is a pure
        # escape, not a sanitiser.
        self.assertEqual(esc("  hello world  "), "  hello world  ")

    def test_unicode_passes_through_unchanged(self):
        # html.escape does not munge non-ASCII; pinning so a refactor
        # to a "safer" sanitiser that strips non-ASCII (and would silently
        # mangle the operator's branch names / commit subjects with
        # accents, emoji, CJK) fails here.
        self.assertEqual(esc("café"), "café")

    def test_already_escaped_input_is_escaped_again(self):
        # No idempotency hack: `&amp;` becomes `&amp;amp;`. A "smart"
        # refactor that detects existing entities and skips them would
        # silently fail to re-escape attacker-controlled input that
        # happens to contain `&amp;` literally, opening a bypass.
        self.assertEqual(esc("&amp;"), "&amp;amp;")


class RenderPrioritiesCleanTests(unittest.TestCase):
    def test_clean_state_emits_only_clean_ok_entry(self):
        # Defends against a "simplify" refactor adding an unconditional
        # entry that bypasses the guards (e.g. always-on "Welcome" card).
        out = render_priorities(_state())
        self.assertIn("priority ok", out)
        self.assertIn("Working tree clean", out)
        # Exactly one priority row total.
        self.assertEqual(out.count('class="priority '), 1)
        # No other classes leak in.
        self.assertNotIn("priority warn", out)
        self.assertNotIn("priority crit", out)
        self.assertNotIn("priority info", out)


class RenderPrioritiesAheadRoutingTests(unittest.TestCase):
    def test_ahead_on_trunk_emits_info_nudge(self):
        # The TRUNK branch under code2wiki's direct-push norm gets a
        # friendly info nudge, NOT a warn. A "consolidate the two ahead
        # branches" refactor would silently downgrade the operator UX
        # from a green-light nudge to a yellow caution sign.
        out = render_priorities(_state(ahead=3))
        self.assertIn("priority info", out)
        self.assertIn("3 unpushed commit(s) on main", out)
        self.assertIn("direct-pushes to", out)
        # MUST NOT emit the non-trunk warn entry.
        self.assertNotIn("Not on", out)

    def test_ahead_on_non_trunk_emits_warn(self):
        # The non-TRUNK branch path is the cautious one: operator may
        # have forgotten they're on a feature branch. Defends against
        # swapping the branch == TRUNK predicate to != TRUNK.
        out = render_priorities(_state(branch="feature/x", ahead=2))
        self.assertIn("priority warn", out)
        self.assertIn("2 unpushed commit(s) on feature/x", out)
        self.assertIn("Not on", out)
        # MUST NOT emit the trunk-info entry.
        self.assertNotIn("direct-pushes to", out)

    def test_no_ahead_emits_no_ahead_entry(self):
        # Defends against a guard regression turning `> 0` into `>= 0`
        # (which would always emit an ahead entry, polluting the
        # priorities card on every clean repo regenerate).
        out = render_priorities(_state(ahead=0))
        self.assertNotIn("unpushed commit", out)
        self.assertNotIn("direct-pushes to", out)
        self.assertNotIn("Not on", out)


class RenderPrioritiesStashBoundaryTests(unittest.TestCase):
    def test_stash_exactly_five_trips_warn(self):
        # Boundary pin: the contract is `>= 5`. A "tighten" refactor to
        # `> 5` would silently drop the warning at exactly 5 stashes
        # (the most common operator-stale state on a long-running repo).
        # Use placeholder strings - render_priorities only reads `len()`.
        out = render_priorities(_state(stashes=["s"] * 5))
        self.assertIn("priority warn", out)
        self.assertIn("5 stashes", out)
        self.assertIn("git stash list", out)

    def test_stash_exactly_four_does_not_trip(self):
        # The other half of the boundary pin: 4 stashes is below the
        # threshold and MUST NOT emit a stash entry. Defends against a
        # "loosen" refactor flipping `>= 5` to `>= 4` (or `> 3`).
        out = render_priorities(_state(stashes=["s"] * 4))
        self.assertNotIn("stashes", out)
        self.assertNotIn("git stash list", out)


class RenderPrioritiesBehindTests(unittest.TestCase):
    def test_behind_emits_crit(self):
        # The ONLY crit-class entry the priorities card emits today.
        # Defends against dropping the upstream label (operator wouldn't
        # know which remote they're behind) or downgrading crit -> warn.
        out = render_priorities(_state(behind=2, upstream="origin/main"))
        self.assertIn("priority crit", out)
        self.assertIn("behind origin/main", out)
        self.assertIn("by 2", out)
        self.assertIn("git pull --ff-only", out)

    def test_no_behind_emits_no_behind_entry(self):
        out = render_priorities(_state(behind=0))
        self.assertNotIn("priority crit", out)
        self.assertNotIn("behind", out)


class RenderPrioritiesDirtyTreeTests(unittest.TestCase):
    def test_staged_emits_dirty_warn_and_suppresses_clean(self):
        # Staged-only state: emits the two-cooks dirty-tree warning AND
        # MUST NOT emit the clean entry (mutually exclusive in spec).
        out = render_priorities(_state(staged=[{"code": "M", "path": "a"}]))
        self.assertIn("priority warn", out)
        self.assertIn("1 uncommitted change(s)", out)
        self.assertIn("Two-cooks reminder", out)
        self.assertNotIn("Working tree clean", out)

    def test_untracked_only_emits_neither_dirty_nor_clean(self):
        # Surprising edge case the spec relies on: untracked-only files
        # produce NEITHER the dirty-warn entry (the guard is
        # `staged OR unstaged`, NOT including untracked) NOR the clean
        # entry (the guard is `not (staged | unstaged | untracked)`).
        # A "simplify" refactor that adds untracked to the dirty guard
        # OR drops untracked from the clean guard would silently flip
        # this edge case and either (a) spam dirty warns on every fresh
        # build artifact OR (b) tell the operator the tree is clean
        # while it has untracked WIP. Defends both regressions.
        out = render_priorities(_state(untracked=["build/x"]))
        self.assertNotIn("uncommitted change", out)
        self.assertNotIn("Working tree clean", out)
        # Card scaffolding still emitted; just no priority rows.
        self.assertIn('class="card"', out)
        self.assertEqual(out.count('class="priority '), 0)


class RenderCommitRowTests(unittest.TestCase):
    # render_commit_row is used by both render_unpushed and render_recent;
    # regressions there silently corrupt the two most-read cards.

    def test_date_truncated_to_16_chars(self):
        # git log outputs ISO datetimes like "2026-05-17 19:00:00 -0500"
        # (25 chars). Only the first 16 chars are shown so the card stays
        # narrow. A "show full date" refactor would break column alignment.
        row = render_commit_row({
            "sha": "abc1234",
            "msg": "fix: something",
            "date": "2026-05-17 19:00:00 -0500",
        })
        self.assertIn("2026-05-17 19:00", row)
        self.assertNotIn("00 -0500", row)

    def test_xss_chars_in_sha_and_msg_are_escaped(self):
        # The card renders operator-visible git history; a crafted commit
        # subject like `<script>alert(1)</script>` must not execute in the
        # browser. esc() wraps html.escape(quote=True) for this exact case.
        row = render_commit_row({
            "sha": "<bad>",
            "msg": '<img src=x onerror="alert(1)">',
            "date": "2026-05-17 12:00",
        })
        self.assertNotIn("<bad>", row)
        self.assertNotIn("<img", row)
        self.assertIn("&lt;bad&gt;", row)
        self.assertIn("&lt;img", row)

    def test_empty_date_renders_without_crash(self):
        # git log can return "" for the date on a HEAD-less or corrupted
        # ref. The guard `if c["date"] else ""` must prevent an IndexError
        # on `""[:16]` (which is fine) AND on None (which esc handles via
        # `s or ""`). Pinning both falsy variants.
        for falsy_date in ("", None):
            with self.subTest(date=falsy_date):
                row = render_commit_row({
                    "sha": "deadbeef",
                    "msg": "chore: stub",
                    "date": falsy_date,
                })
                self.assertIn("deadbeef", row)
                self.assertIn("chore: stub", row)
                # The <span class="when"> must be present but empty.
                self.assertIn('<span class="when"></span>', row)


class RenderTopStatsTreeLabelTests(unittest.TestCase):
    # render_top_stats feeds the four top-of-page stat cards
    # (Current Branch / Unpushed Commits / Untracked Files / Stashes).
    # The Current Branch card's "clean/dirty (label)" subtext is the
    # operator's first read on every regenerate; a routing flip there
    # silently tells them the wrong story about the tree.

    def test_clean_state_emits_clean_word_and_nothing_to_commit(self):
        # Defends against dropping the empty-list fallback for
        # `tree_label` (would render an empty parenthetical) and against
        # a regression flipping the tree_word default from "clean" to
        # "dirty".
        out = render_top_stats(_state())
        self.assertIn("clean (nothing to commit)", out)
        self.assertNotIn("dirty (", out)

    def test_staged_only_emits_dirty_word_and_one_staged_label(self):
        # Pins the single-bucket label format AND that staged-only
        # correctly marks the tree dirty (a regression that ANDed
        # the three lists together instead of ORing would silently
        # fall through to clean).
        out = render_top_stats(_state(staged=[{"code": "M", "path": "a"}]))
        self.assertIn("dirty (1 staged)", out)
        self.assertNotIn("clean (", out)

    def test_all_three_buckets_emit_comma_joined_labels_in_canonical_order(self):
        # Pins the canonical order of the three append branches
        # (staged, then unstaged, then untracked). A "reorder these
        # for readability" refactor would silently break the contract
        # the operator visually relies on.
        out = render_top_stats(_state(
            staged=[{"code": "M", "path": "a"}],
            unstaged=[{"code": "M", "path": "b"}],
            untracked=["c"],
        ))
        self.assertIn("dirty (1 staged, 1 unstaged, 1 untracked)", out)

    def test_untracked_only_marks_tree_dirty(self):
        # Surprising parallel to render_priorities: render_top_stats
        # INCLUDES untracked in the dirty check (the OR at line 410),
        # whereas render_priorities EXCLUDES untracked from its dirty
        # priority. The asymmetry is intentional and the two helpers
        # MUST stay independent on this point. A "consolidate the dirty
        # checks" refactor would silently break one or the other.
        out = render_top_stats(_state(untracked=["build/x"]))
        self.assertIn("dirty (1 untracked)", out)
        self.assertNotIn("clean (", out)


class RenderTopStatsAheadTests(unittest.TestCase):
    def test_ahead_zero_emits_ok_class_on_unpushed_card(self):
        # Boundary pin: ahead_class flips at strict `> 0`. A regression
        # to `>= 0` would always emit the info class, polluting the
        # card on every clean repo.
        out = render_top_stats(_state(ahead=0))
        self.assertIn('class="card stat ok">\n    <h2>Unpushed Commits', out)
        self.assertNotIn('class="card stat info">\n    <h2>Unpushed Commits', out)

    def test_ahead_one_emits_info_class_on_unpushed_card(self):
        # Other half of the boundary pin: exactly 1 ahead emits info,
        # not ok. Defends against `> 1` or `>= 2` tightening regressions.
        out = render_top_stats(_state(ahead=1))
        self.assertIn('class="card stat info">\n    <h2>Unpushed Commits', out)

    def test_no_upstream_emits_no_upstream_label(self):
        # The else-branch of `if s["upstream"]`. Defends against a
        # truthiness flip (e.g. checking `is None` instead) that would
        # silently render `ahead of ` (with empty target) on an empty
        # string upstream.
        out = render_top_stats(_state(upstream=""))
        self.assertIn("no upstream", out)
        self.assertNotIn("ahead of", out)

    def test_upstream_set_behind_zero_omits_behind_suffix(self):
        # Boundary pin: the behind suffix is gated by `if s["behind"]`
        # (truthy check, i.e. > 0). A `>= 0` regression would always
        # append `&middot; behind 0` to the ahead label.
        out = render_top_stats(_state(behind=0))
        self.assertIn("ahead of origin/main", out)
        self.assertNotIn("behind 0", out)
        self.assertNotIn("&middot; behind", out)

    def test_upstream_set_behind_two_appends_behind_suffix(self):
        # Other half of the boundary: behind=2 MUST append
        # `&middot; behind 2` and MUST NOT drop the upstream prefix.
        out = render_top_stats(_state(behind=2))
        self.assertIn("ahead of origin/main &middot; behind 2", out)


class RenderTopStatsStashTests(unittest.TestCase):
    # Three-way tiered class: crit (>= 10), warn (> 0), ok (0).
    # Two boundaries (0 and 10), three pins each.

    def test_stash_exactly_ten_trips_crit(self):
        # Boundary pin: contract is `>= 10`. A `> 10` regression would
        # silently downgrade the exactly-10 case to warn.
        out = render_top_stats(_state(stashes=["s"] * 10))
        self.assertIn('class="card stat crit">\n    <h2>Stashes', out)
        self.assertNotIn('class="card stat warn">\n    <h2>Stashes', out)

    def test_stash_exactly_nine_trips_warn_not_crit(self):
        # Other half of the upper boundary: 9 is below the crit
        # threshold and MUST emit warn.
        out = render_top_stats(_state(stashes=["s"] * 9))
        self.assertIn('class="card stat warn">\n    <h2>Stashes', out)
        self.assertNotIn('class="card stat crit">\n    <h2>Stashes', out)

    def test_stash_empty_emits_ok(self):
        # Lower boundary: empty list is the ok branch (truthy check on
        # the list, not `> 0` on the length). A `len(stashes) > 0`
        # refactor would behave identically here but any "default to
        # warn" regression would trip.
        out = render_top_stats(_state(stashes=[]))
        self.assertIn('class="card stat ok">\n    <h2>Stashes', out)


class RenderTopStatsUntrackedClassTests(unittest.TestCase):
    def test_untracked_nonempty_marks_untracked_card_warn(self):
        # Pins the Untracked Files card's class binding to `'warn' if
        # s['untracked']`. Defends against dropping this guard (would
        # mark the card warn on every regenerate even on a clean tree).
        out = render_top_stats(_state(untracked=["build/x"]))
        self.assertIn('class="card stat warn">\n    <h2>Untracked Files', out)

    def test_untracked_empty_marks_untracked_card_ok(self):
        out = render_top_stats(_state(untracked=[]))
        self.assertIn('class="card stat ok">\n    <h2>Untracked Files', out)


class RenderTopStatsEscapeTests(unittest.TestCase):
    def test_branch_head_and_upstream_are_html_escaped(self):
        # All three fields flow through esc(). A regression dropping
        # esc() on any of them would let a malicious branch name
        # (a crafted feature branch from a contributor) inject HTML
        # into the operator's local dashboard.
        out = render_top_stats(_state(
            branch="<bad>",
            head_short="<sha>",
            upstream="<up>",
        ))
        self.assertNotIn("<bad>", out)
        self.assertNotIn("<sha>", out)
        self.assertNotIn("<up>", out)
        self.assertIn("&lt;bad&gt;", out)
        self.assertIn("&lt;sha&gt;", out)
        self.assertIn("&lt;up&gt;", out)


class RenderUntrackedTests(unittest.TestCase):
    # render_untracked groups files by top-level directory segment and sorts
    # groups alphabetically. The "(root)" key for top-level files is
    # non-obvious and easy to break with a "simplify" path-split refactor.

    def test_empty_untracked_returns_zero_card(self):
        # Returns a static card with "(0)" header and empty-state message,
        # NOT an empty string. Callers rely on always getting valid HTML.
        out = render_untracked(_state(untracked=[]))
        self.assertIn("Untracked Files (0)", out)
        self.assertIn("no untracked files", out)
        self.assertNotIn("file-list", out)

    def test_root_level_file_goes_into_root_group(self):
        # Files without a "/" are grouped under the literal key "(root)".
        # The parens are intentional -- they sort before alpha keys so the
        # root group floats to the top. A "use filename as key" refactor
        # would scatter root files across per-name single-item groups.
        out = render_untracked(_state(untracked=["CLAUDE.md", "TODO.txt"]))
        self.assertIn("(root)", out)
        # Both files listed under it.
        self.assertIn("CLAUDE.md", out)
        self.assertIn("TODO.txt", out)
        # Total count in the card header.
        self.assertIn("Untracked Files (2)", out)

    def test_nested_files_grouped_by_top_level_directory(self):
        # src/foo.ts and src/bar.ts both group under "src"; the per-group
        # count "(2)" appears in the group header. A split(os.sep) instead
        # of split("/", 1)[0] would still work on Unix but break on Windows.
        out = render_untracked(_state(untracked=["src/foo.ts", "src/bar.ts"]))
        self.assertIn("src (2)", out)
        self.assertIn("src/foo.ts", out)
        self.assertIn("src/bar.ts", out)

    def test_groups_are_sorted_alphabetically(self):
        # Groups appear in sorted() order regardless of the input order.
        # This pins the display contract so the operator can predict where
        # "apps/" vs "src/" vs "(root)" will appear on screen.
        out = render_untracked(_state(untracked=[
            "src/x.ts",
            "apps/y.tsx",
            "CLAUDE.md",  # root
        ]))
        pos_root = out.index("(root)")
        pos_apps = out.index("apps")
        pos_src = out.index("src")
        # "(root)" < "apps" < "src" in sorted() order (parens sort before
        # lowercase letters in ASCII).
        self.assertLess(pos_root, pos_apps)
        self.assertLess(pos_apps, pos_src)


class RenderChangesTests(unittest.TestCase):
    # render_changes is the only render_ function in this script that
    # returns "" (empty string, no HTML) when both lists are empty.
    # Every other render_ returns at least an empty-state card. That
    # asymmetry is load-bearing: callers must not wrap the result in
    # an unconditional card container or they get a phantom empty card
    # on clean trees. A "normalize empty states" refactor that returns
    # an empty card instead would silently add an extra card to the
    # dashboard on every clean-repo regeneration.

    def test_both_empty_returns_empty_string_not_a_card(self):
        out = render_changes(_state(staged=[], unstaged=[]))
        self.assertEqual(out, "")

    def test_staged_item_uses_info_pill(self):
        # "staged" changes get the blue info pill, not the amber warn pill.
        # A pill-swap regression would silently miscolour the card on every
        # dirty tree, with no functional failure to surface it.
        out = render_changes(_state(staged=[{"code": "M", "path": "src/foo.ts"}]))
        self.assertIn('pill info', out)
        self.assertIn('staged M', out)
        self.assertIn('src/foo.ts', out)
        self.assertNotIn('pill warn', out)

    def test_unstaged_item_uses_warn_pill(self):
        out = render_changes(_state(unstaged=[{"code": "D", "path": "lib/bar.ts"}]))
        self.assertIn('pill warn', out)
        self.assertIn('unstaged D', out)
        self.assertIn('lib/bar.ts', out)
        self.assertNotIn('pill info', out)

    def test_path_with_xss_chars_is_escaped(self):
        # Filenames containing < or > (rare but valid on some filesystems)
        # must be HTML-escaped to prevent dashboard injection.
        out = render_changes(_state(staged=[{"code": "A", "path": "<evil>.ts"}]))
        self.assertNotIn("<evil>", out)
        self.assertIn("&lt;evil&gt;", out)


class RenderBranchesTests(unittest.TestCase):
    # render_branches at generate_git_state.py:540 enumerates local branches
    # in the "Local Branches & Worktrees" card on every 60s LaunchAgent
    # regenerate. Three independent tag-accumulation surfaces:
    #
    #   (1) "current" iff b["name"] == s["branch"]
    #   (2) "worktree" iff b["name"] in s["worktree_branches"] AND
    #       b["name"] != s["branch"]  -- the second clause prevents the
    #       current branch from double-tagging current+worktree (the
    #       currently-checked-out branch is always in worktree_branches).
    #   (3) tracking suffix routes a non-empty track string through one
    #       of "ahead" | "behind" classes. Both-ahead-and-behind routes
    #       to "ahead" (first branch wins), NOT "behind".
    #
    # A "consolidate the worktree check" refactor that drops the
    # name != s["branch"] clause would silently double-tag the current
    # branch (current AND worktree pills both render). A "simplify the
    # track routing" refactor reordering the branches so behind is
    # checked first would silently miscategorise every both-ahead-and-
    # behind branch as behind-only -- the dashboard then tells the
    # operator their feature branch is purely behind upstream when it
    # actually has unpushed work that would conflict on a rebase.

    def test_empty_branches_emits_card_shell_with_no_branch_rows(self):
        out = render_branches(_state(branches=[]))
        self.assertIn("Local Branches", out)
        self.assertIn('class="card"', out)
        # No <div class="branch"> rows because there are no branches.
        self.assertNotIn('class="branch"', out)

    def test_current_branch_renders_current_tag_and_not_worktree(self):
        # The current branch is ALWAYS in worktree_branches (git worktree
        # list includes the active worktree). The second clause in the
        # worktree-tag guard exists specifically to prevent the current
        # branch from also being tagged "worktree". A regression that
        # drops `and b["name"] != s["branch"]` from that guard would
        # silently double-tag the current branch.
        out = render_branches(_state(
            branch=TRUNK,
            worktree_branches={TRUNK},
            branches=[{"name": TRUNK, "date": "", "msg": "tip", "track": ""}],
        ))
        self.assertIn('tag current">current', out)
        self.assertNotIn('tag wt">worktree', out)

    def test_non_current_branch_in_worktree_branches_renders_worktree_tag(self):
        # An off-trunk branch that happens to have an active worktree
        # (the bot's pattern when working on a backlog item) gets the
        # "worktree" tag but NOT "current".
        out = render_branches(_state(
            branch=TRUNK,
            worktree_branches={TRUNK, "claude/some-task"},
            branches=[
                {"name": "claude/some-task", "date": "", "msg": "wip", "track": ""},
            ],
        ))
        self.assertIn('tag wt">worktree', out)
        self.assertNotIn('tag current">current', out)

    def test_non_current_branch_not_in_worktree_branches_has_neither_tag(self):
        # Plain dormant local branches (not current, not checked out
        # in any worktree) get neither the current NOR the worktree tag.
        out = render_branches(_state(
            branch=TRUNK,
            worktree_branches={TRUNK},
            branches=[
                {"name": "old-feature", "date": "", "msg": "tip", "track": ""},
            ],
        ))
        self.assertNotIn('tag current', out)
        self.assertNotIn('tag wt', out)

    def test_track_both_ahead_and_behind_routes_to_ahead_class(self):
        # Pins the explicit precedence in the if/elif chain: both routes
        # to "ahead", NOT "behind". A reorder (check behind first) would
        # silently flip this for every branch with bidirectional drift.
        out = render_branches(_state(
            branches=[{
                "name": "feat", "date": "", "msg": "x",
                "track": "[ahead 2, behind 1]",
            }],
        ))
        self.assertIn('tag ahead">[ahead 2, behind 1]', out)
        self.assertNotIn('tag behind">', out)

    def test_track_ahead_only_routes_to_ahead_class(self):
        out = render_branches(_state(
            branches=[{
                "name": "feat", "date": "", "msg": "x",
                "track": "[ahead 3]",
            }],
        ))
        self.assertIn('tag ahead">[ahead 3]', out)
        self.assertNotIn('tag behind">', out)

    def test_track_behind_only_routes_to_behind_class(self):
        out = render_branches(_state(
            branches=[{
                "name": "feat", "date": "", "msg": "x",
                "track": "[behind 5]",
            }],
        ))
        self.assertIn('tag behind">[behind 5]', out)
        self.assertNotIn('tag ahead">', out)

    def test_empty_track_string_emits_no_track_tag(self):
        # Defends `if tr:` guard. A "simplify" refactor that always falls
        # through to one of the routing branches would emit an empty
        # `<span class="tag ahead"></span>` pill on every up-to-date
        # branch -- visible as a colour smudge with no label.
        out = render_branches(_state(
            branches=[{"name": "feat", "date": "", "msg": "x", "track": ""}],
        ))
        self.assertNotIn('tag ahead', out)
        self.assertNotIn('tag behind', out)

    def test_whitespace_only_track_treated_as_empty(self):
        # tr = (b.get("track") or "").strip() -- pins that pure-whitespace
        # is normalised away, NOT routed to a routing branch.
        out = render_branches(_state(
            branches=[{"name": "feat", "date": "", "msg": "x", "track": "   "}],
        ))
        self.assertNotIn('tag ahead', out)
        self.assertNotIn('tag behind', out)

    def test_branch_name_and_track_are_html_escaped(self):
        # Branch names can contain arbitrary characters (git allows most
        # bytes in refnames); rendering them unescaped in the dashboard
        # is an XSS surface against the operator if a remote ref is
        # fetched from a less-trusted remote. Track string is routed
        # into the "ahead" branch via the "ahead" substring so the
        # escape on `tr` is exercised through the same path the live
        # script takes.
        out = render_branches(_state(
            branches=[{
                "name": "feat/<evil>",
                "date": "",
                "msg": "<script>x</script>",
                "track": "[ahead 1 <bad>]",
            }],
        ))
        self.assertNotIn("<evil>", out)
        self.assertIn("&lt;evil&gt;", out)
        self.assertNotIn("<script>", out)
        self.assertIn("&lt;script&gt;", out)
        self.assertNotIn("<bad>", out)
        self.assertIn("&lt;bad&gt;", out)


class RenderRemotesTreeRemotesCardTests(unittest.TestCase):
    def test_empty_remotes_emits_fallback_div(self):
        # `or '<div class="empty">No remotes.</div>'` -- defends the
        # falsy-fallback `or` expression. A "simplify" refactor dropping
        # the `or` clause (e.g. switching to an `if remote_rows` block
        # without an else) would render an empty Remotes card with no
        # message at all, which is misleading: the operator would see
        # the heading but no row and assume the data hadn't loaded yet.
        out = render_remotes_tree(_state())
        self.assertIn("<h2>Remotes</h2>", out)
        self.assertIn('<div class="empty">No remotes.</div>', out)
        # The fallback must NOT also render a phantom info pill for a
        # blank remote name -- catches a "iterate over .items() OR
        # render a placeholder" regression.
        self.assertNotIn('class="pill info"', out)

    def test_single_remote_renders_name_and_url_with_info_pill(self):
        out = render_remotes_tree(_state(
            remotes={"origin": "git@github.com:owner/repo.git"},
        ))
        # Pin both halves of the pill+msg row layout.
        self.assertIn('class="pill info">origin</span>', out)
        self.assertIn("git@github.com:owner/repo.git", out)
        # MUST NOT fall back to the empty-state div when at least one
        # remote is present.
        self.assertNotIn("No remotes.", out)

    def test_multiple_remotes_preserve_insertion_order(self):
        # Python 3.7+ dicts preserve insertion order; the existing code
        # iterates `s["remotes"].items()` without sorting. A "tidy up by
        # sorting alphabetically" refactor would silently re-order the
        # operator's view away from the canonical `origin` first / fork
        # second convention many operators rely on.
        out = render_remotes_tree(_state(
            remotes={
                "origin": "git@github.com:owner/repo.git",
                "upstream": "git@github.com:fork/repo.git",
            },
        ))
        origin_idx = out.index(">origin<")
        upstream_idx = out.index(">upstream<")
        self.assertLess(origin_idx, upstream_idx)

    def test_remote_name_and_url_are_html_escaped(self):
        # Remote names + URLs are user-controlled via `git remote add`;
        # a contributor pasting a crafted name or a server returning a
        # crafted URL must not break out of the row markup. Defends
        # against dropping the esc() on either side of the row.
        out = render_remotes_tree(_state(
            remotes={"<evil>": "https://example.com/<script>x</script>"},
        ))
        self.assertNotIn("<evil>", out)
        self.assertIn("&lt;evil&gt;", out)
        self.assertNotIn("<script>x</script>", out)
        self.assertIn("&lt;script&gt;x&lt;/script&gt;", out)


class RenderRemotesTreeWorkingTreeCardTests(unittest.TestCase):
    def test_all_clean_buckets_emit_four_ok_pills(self):
        # The Working Tree card always renders all four rows; on a clean
        # tree every row gets the `pill ok` class. Defends against a
        # "consolidate clean fallbacks" refactor that would silently drop
        # one of the four else branches and leave the operator without
        # the "no X" reassurance on whichever bucket was consolidated.
        out = render_remotes_tree(_state())
        self.assertIn("<h2>Working Tree</h2>", out)
        self.assertEqual(out.count('class="pill ok">clean</span>'), 4)
        self.assertIn("no staged changes", out)
        self.assertIn("no unstaged changes", out)
        self.assertIn("no untracked files", out)
        self.assertIn("no stashes", out)

    def test_staged_bucket_uses_info_pill_not_warn(self):
        # Staged changes are deliberately info-class (the operator has
        # already intentionally `git add`ed them) while unstaged stays
        # warn. A "consolidate to warn for any dirty state" refactor
        # would flatten the staged/unstaged signal the operator uses to
        # distinguish "I'm about to commit" from "I have WIP edits".
        out = render_remotes_tree(_state(staged=[{"code": "M", "path": "a"}]))
        self.assertIn('class="pill info">staged</span>', out)
        self.assertIn("1 file(s)", out)
        # MUST NOT also emit the clean-staged fallback.
        self.assertNotIn("no staged changes", out)

    def test_unstaged_bucket_uses_warn_pill(self):
        # Defends the warn class on unstaged + that the message includes
        # a file count (not a path) -- a "render the first path instead
        # of the count" regression would silently leak filenames into
        # the always-visible summary.
        out = render_remotes_tree(_state(
            unstaged=[{"code": "M", "path": "a"}, {"code": "M", "path": "b"}],
        ))
        self.assertIn('class="pill warn">unstaged</span>', out)
        self.assertIn("2 file(s)", out)
        self.assertNotIn("no unstaged changes", out)

    def test_untracked_bucket_uses_warn_pill_and_path_unit(self):
        # untracked uses "path(s)" not "file(s)" (untracked entries may
        # be directories, not just files). Defends against a "DRY up the
        # bucket message" refactor that would homogenise the unit and
        # silently mislabel directories as files.
        out = render_remotes_tree(_state(untracked=["build/", "scratch.md"]))
        self.assertIn('class="pill warn">untracked</span>', out)
        self.assertIn("2 path(s)", out)
        self.assertNotIn("file(s)", out)
        self.assertNotIn("no untracked files", out)

    def test_stash_exactly_ten_trips_crit(self):
        # `>= 10` boundary -- mirrors the render_top_stats invariant
        # pinned at 21:18. The two helpers MUST agree on the threshold:
        # a regression that drifted one to `> 10` would silently
        # disagree between the top-row card and the Working Tree card.
        out = render_remotes_tree(_state(stashes=list(range(10))))
        self.assertIn('class="pill crit">stashes</span>', out)
        self.assertIn(">10</span>", out)
        # MUST NOT also emit the warn pill.
        self.assertNotIn('class="pill warn">stashes</span>', out)

    def test_stash_nine_routes_to_warn(self):
        # The just-below-boundary case. Distinguishes the strict `>= 10`
        # from a "loosen to `>= 9`" or "tighten to `>= 11`" mutation.
        out = render_remotes_tree(_state(stashes=list(range(9))))
        self.assertIn('class="pill warn">stashes</span>', out)
        self.assertNotIn('class="pill crit">stashes</span>', out)

    def test_stash_one_routes_to_warn_not_crit(self):
        # Defends against an `<= 10` / `< 10` flip on the crit branch.
        out = render_remotes_tree(_state(stashes=[{}]))
        self.assertIn('class="pill warn">stashes</span>', out)
        self.assertIn(">1</span>", out)
        self.assertNotIn('class="pill crit">stashes</span>', out)


class RenderWorktreesTests(unittest.TestCase):
    """Pin `render_worktrees` (the Active Worktrees card).

    The function runs on every 60s LaunchAgent regenerate. Its `<= 1`
    guard is the highest-leverage surface: a "drop the guard" /
    "render the card always" simplification clutters the dashboard on
    every regenerate for the operator's main single-worktree repo,
    surfacing a noisy card the operator must visually skip past.
    """

    def test_empty_worktrees_returns_empty_string(self):
        # Defends against an `< 1` / `len > 0` regression that would
        # IndexError or render an empty card with no rows.
        out = render_worktrees(_state(worktrees=[]))
        self.assertEqual(out, "")

    def test_single_worktree_returns_empty_string(self):
        # The boundary case the `<= 1` guard exists for. A `< 1` flip
        # would render a one-row Active Worktrees card on every
        # regenerate for the main repo (the operator never has zero
        # worktrees but ALWAYS has at least one). The dashboard would
        # gain a permanent noise card.
        out = render_worktrees(_state(worktrees=[
            {"branch": TRUNK, "path": "/Users/op/code2wiki"},
        ]))
        self.assertEqual(out, "")

    def test_two_worktrees_emit_card_with_both_rows(self):
        # The first case where the helper produces visible HTML. Two
        # rows in insertion order; defends against a "render at most N"
        # silent cap.
        out = render_worktrees(_state(worktrees=[
            {"branch": TRUNK, "path": "/Users/op/code2wiki"},
            {"branch": "claude/foo", "path": "/Users/op/worktrees/foo"},
        ]))
        self.assertIn("Active Worktrees", out)
        self.assertIn("/Users/op/code2wiki", out)
        self.assertIn("/Users/op/worktrees/foo", out)
        self.assertIn("claude/foo", out)
        # Two rows total (one per worktree).
        self.assertEqual(out.count('<div class="row">'), 2)

    def test_empty_branch_falls_back_to_detached_label(self):
        # `git worktree list --porcelain` emits an empty branch for a
        # detached-HEAD worktree. The fallback label is operator-
        # facing; a "drop the `or` fallback" simplification would emit
        # an empty <span> next to the path, hiding the worktree's
        # state without warning. The literal "(detached)" matches the
        # source verbatim (NOT "detached" without parens) so a
        # punctuation drift would trip this test too.
        out = render_worktrees(_state(worktrees=[
            {"branch": TRUNK, "path": "/Users/op/code2wiki"},
            {"branch": "", "path": "/Users/op/worktrees/detached"},
        ]))
        self.assertIn("(detached)", out)
        self.assertIn("/Users/op/worktrees/detached", out)

    def test_set_branch_takes_precedence_over_detached_fallback(self):
        # Defends against a swap to `or wt["branch"]` (always-detached)
        # or to an unconditional "(detached)" assignment that ignores
        # the truthy branch.
        out = render_worktrees(_state(worktrees=[
            {"branch": TRUNK, "path": "/Users/op/code2wiki"},
            {"branch": "feature/x", "path": "/Users/op/worktrees/x"},
        ]))
        self.assertIn("feature/x", out)
        self.assertNotIn("(detached)", out)

    def test_branch_name_is_html_escaped(self):
        # XSS surface: a crafted feature branch name from a contributor
        # (or from the operator pasting an oddly-quoted name) flows
        # into the always-visible dashboard. Defends against a drop-
        # esc() refactor on the branch label.
        out = render_worktrees(_state(worktrees=[
            {"branch": TRUNK, "path": "/Users/op/code2wiki"},
            {"branch": "<script>alert(1)</script>", "path": "/p"},
        ]))
        self.assertNotIn("<script>alert(1)</script>", out)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", out)

    def test_worktree_path_is_html_escaped(self):
        # XSS surface: an operator could land a worktree at a path
        # containing markup-significant characters (uncommon but
        # legal). Defends against a drop-esc() refactor on the path
        # span (separate code site from the branch esc()).
        out = render_worktrees(_state(worktrees=[
            {"branch": TRUNK, "path": "/Users/op/code2wiki"},
            {"branch": "feature/x", "path": "/tmp/<img src=x>"},
        ]))
        self.assertNotIn("/tmp/<img src=x>", out)
        self.assertIn("&lt;img src=x&gt;", out)


class RenderPendingBranchesTests(unittest.TestCase):
    """Pin `render_pending_branches` (the Pending Branches review card).

    The function renders the "Needs Review or Approval" card on every
    60s LaunchAgent regenerate. Two state lists feed it:
    `pending_local_branches` (in-progress local worktree branches) and
    `pending_remote_branches` (remote `claude/*` branches awaiting
    founder review). The card's whole purpose is to make the founder /
    operator distinction visible BEFORE the operator decides whether
    to merge, which means the kind-tag routing
    (b["kind"] == "worktree" -> "worktree" pill vs anything-else ->
    "remote" pill) is load-bearing. A regression that flips the
    routing silently tells the operator a local in-progress branch is
    a remote Claude output (or vice versa), changing the meaning of
    the "Leave alone until reviewed" footer.
    """

    def _row(self, **overrides) -> dict:
        base = {
            "name": "claude/some-task",
            "kind": "remote",
            "msg": "wip",
            "date": "2026-05-18",
            "ahead": 0,
        }
        base.update(overrides)
        return base

    def test_empty_both_lists_returns_empty_string(self):
        # Defends against a drop-the-guard refactor that would render
        # an empty card on every clean regenerate (the common case).
        out = render_pending_branches(_state())
        self.assertEqual(out, "")

    def test_single_local_worktree_emits_worktree_pill(self):
        # Pins b["kind"] == "worktree" -> worktree pill. A regression
        # flipping the predicate to != "worktree" or to a different
        # field name silently swaps every local row's pill to "remote",
        # telling the operator the in-progress local branch is a
        # remote Claude output awaiting review.
        out = render_pending_branches(_state(
            pending_local_branches=[self._row(kind="worktree", name="feature/x")],
        ))
        self.assertIn(">worktree</span>", out)
        self.assertNotIn(">remote</span>", out)
        self.assertIn("feature/x", out)

    def test_single_remote_emits_remote_pill(self):
        # The else branch -- any non-"worktree" kind value routes to
        # the remote pill. Defends against a refactor that hardcodes
        # both kinds to the same tag (collapsing the operator-facing
        # distinction).
        out = render_pending_branches(_state(
            pending_remote_branches=[self._row(kind="remote")],
        ))
        self.assertIn(">remote</span>", out)
        self.assertNotIn(">worktree</span>", out)

    def test_ahead_positive_emits_ahead_pill(self):
        # Pins the `+N` ahead pill rendering when b["ahead"] > 0. The
        # pill is the only signal of "how much un-merged work" on a
        # pending branch; a regression dropping it silently makes the
        # card look benign even when a branch carries many unmerged
        # commits.
        out = render_pending_branches(_state(
            pending_remote_branches=[self._row(kind="remote", ahead=7)],
        ))
        self.assertIn(">+7</span>", out)
        self.assertIn('class="tag ahead"', out)

    def test_ahead_zero_omits_ahead_pill(self):
        # Strict `> 0` boundary. A `>= 0` flip would attach a "+0" pill
        # to every pending row (visual noise, misleading). A `> 1` flip
        # would silently drop the pill for branches one commit ahead
        # (under-warning). Both regressions trip this pair-of-pins
        # alongside test_ahead_positive_emits_ahead_pill.
        out = render_pending_branches(_state(
            pending_remote_branches=[self._row(kind="remote", ahead=0)],
        ))
        self.assertNotIn('class="tag ahead"', out)
        self.assertNotIn(">+0</span>", out)

    def test_locals_render_before_remotes(self):
        # The source orders rows via `local_items + remote_items` --
        # locals first. Defends against a "sort by name" or
        # "remote_items + local_items" reorder that would silently
        # invert the operator's expected scan order (locals are
        # your-own-work-in-progress; remotes are pending review).
        out = render_pending_branches(_state(
            pending_local_branches=[
                self._row(kind="worktree", name="zzz-local-marker"),
            ],
            pending_remote_branches=[
                self._row(kind="remote", name="aaa-remote-marker"),
            ],
        ))
        local_pos = out.find("zzz-local-marker")
        remote_pos = out.find("aaa-remote-marker")
        self.assertNotEqual(local_pos, -1)
        self.assertNotEqual(remote_pos, -1)
        self.assertLess(local_pos, remote_pos)

    def test_count_in_header_reflects_total_rows(self):
        # The header shows `({count})` where count = len(all_items).
        # Defends against a `len(local) + len(remote)` typo that drops
        # one side, or a `len(remote)` shortcut that omits locals.
        out = render_pending_branches(_state(
            pending_local_branches=[
                self._row(kind="worktree", name="l1"),
                self._row(kind="worktree", name="l2"),
            ],
            pending_remote_branches=[
                self._row(kind="remote", name="r1"),
            ],
        ))
        self.assertIn("(3)", out)
        # Three rows in DOM order.
        self.assertEqual(out.count('<div class="branch">'), 3)

    def test_leave_alone_footer_text_present(self):
        # The footer is load-bearing operator instruction. Defends
        # against a "trim verbose copy" refactor that silently removes
        # the operator-facing guardrail.
        out = render_pending_branches(_state(
            pending_remote_branches=[self._row(kind="remote")],
        ))
        self.assertIn("Leave alone until reviewed.", out)

    def test_name_msg_date_are_html_escaped(self):
        # XSS surface across three independent code sites in the row
        # template (name, msg, date). A drop-esc() on any one of them
        # would let a crafted branch name / commit message / date
        # string from a contributor inject markup into the
        # always-visible dashboard.
        out = render_pending_branches(_state(
            pending_remote_branches=[self._row(
                name="<script>alert(1)</script>",
                msg="<img src=x>",
                date="<b>now</b>",
            )],
        ))
        self.assertNotIn("<script>alert(1)</script>", out)
        self.assertNotIn("<img src=x>", out)
        self.assertNotIn("<b>now</b>", out)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", out)
        self.assertIn("&lt;img src=x&gt;", out)
        self.assertIn("&lt;b&gt;now&lt;/b&gt;", out)


class RenderUnpushedTests(unittest.TestCase):
    # render_unpushed renders the "Unpushed Commits" card on every 60s
    # LaunchAgent regenerate. Wraps render_commit_row (separately pinned)
    # but adds three independent surfaces of its own: an empty-state
    # fallback, a title that interpolates branch + upstream, and an
    # `s["upstream"] or "upstream"` fallback when no upstream is tracked
    # (common on freshly-created local branches before `git push -u`).

    def _commit(self, **overrides) -> dict:
        base = {
            "sha": "abc1234",
            "msg": "fix: thing",
            "date": "2026-05-18 09:00",
        }
        base.update(overrides)
        return base

    def test_empty_unpushed_emits_in_sync_fallback(self):
        # Defends against a drop-the-empty-guard refactor that would
        # silently emit a card with no body on every clean regenerate.
        out = render_unpushed(_state())
        self.assertIn("No unpushed commits. In sync with upstream.", out)
        self.assertIn('class="empty"', out)
        # No commit rows rendered.
        self.assertNotIn('class="sha"', out)

    def test_non_empty_unpushed_renders_rows_in_insertion_order(self):
        # Defends against a tidy-sort refactor (e.g. sort by date) that
        # would re-order the operator's chronological history view.
        out = render_unpushed(_state(unpushed=[
            self._commit(sha="aaa1111", msg="first"),
            self._commit(sha="bbb2222", msg="second"),
            self._commit(sha="ccc3333", msg="third"),
        ]))
        self.assertNotIn("No unpushed commits", out)
        # Insertion order: first appears before second appears before third.
        self.assertLess(out.index("aaa1111"), out.index("bbb2222"))
        self.assertLess(out.index("bbb2222"), out.index("ccc3333"))

    def test_title_interpolates_branch_and_upstream(self):
        out = render_unpushed(_state(
            branch="feature/x",
            upstream="origin/feature/x",
        ))
        self.assertIn("feature/x vs origin/feature/x", out)

    def test_missing_upstream_falls_back_to_literal_upstream(self):
        # Defends against a drop-the-or-fallback refactor that would
        # render the literal "None" or "" in the card title when a
        # freshly-created local branch has no upstream tracked yet.
        out = render_unpushed(_state(branch="feature/x", upstream=None))
        self.assertIn("feature/x vs upstream", out)
        self.assertNotIn("None", out)

    def test_branch_and_upstream_html_escaped(self):
        # XSS surface against the operator via a crafted branch name
        # (git allows most characters in branch names) or upstream
        # remote (configured from a less-trusted contributor's
        # .git/config). Both esc'd at independent code sites in the
        # title f-string.
        out = render_unpushed(_state(
            branch="<script>alert(1)</script>",
            upstream="<img src=x onerror=1>",
        ))
        self.assertNotIn("<script>alert(1)</script>", out)
        self.assertNotIn("<img src=x", out)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", out)
        self.assertIn("&lt;img src=x onerror=1&gt;", out)


class RenderRecentTests(unittest.TestCase):
    # render_recent renders the "Recent Commits on <branch>" card on
    # every 60s LaunchAgent regenerate. Intentionally has NO empty-state
    # fallback (recent commits are always present on a working repo).
    # Pinning the absence defends against a well-meaning "add empty
    # message" refactor that would clutter every regenerate.

    def _commit(self, **overrides) -> dict:
        base = {
            "sha": "abc1234",
            "msg": "fix: thing",
            "date": "2026-05-18 09:00",
        }
        base.update(overrides)
        return base

    def test_empty_recent_emits_card_with_no_rows(self):
        # No fallback message; only the card chrome + h2. Defends
        # against silently adding an "empty" guard that would change
        # the operator's read of the dashboard's signal density.
        out = render_recent(_state(recent=[]))
        self.assertIn('<h2>Recent Commits on main</h2>', out)
        self.assertNotIn('class="empty"', out)
        self.assertNotIn('class="sha"', out)

    def test_non_empty_recent_renders_rows_in_insertion_order(self):
        # Defends against a tidy-sort refactor that would re-order
        # the chronological history view the operator scans first.
        out = render_recent(_state(recent=[
            self._commit(sha="aaa1111", msg="first"),
            self._commit(sha="bbb2222", msg="second"),
            self._commit(sha="ccc3333", msg="third"),
        ]))
        self.assertLess(out.index("aaa1111"), out.index("bbb2222"))
        self.assertLess(out.index("bbb2222"), out.index("ccc3333"))

    def test_title_interpolates_branch(self):
        out = render_recent(_state(branch="feature/x"))
        self.assertIn("Recent Commits on feature/x", out)

    def test_branch_html_escaped(self):
        # XSS surface via a crafted branch name in the card title.
        # Single esc() site, but a drop-esc refactor would inject
        # markup straight into the always-visible dashboard.
        out = render_recent(_state(branch="<script>alert(1)</script>"))
        self.assertNotIn("<script>alert(1)</script>", out)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", out)


class RenderHtmlSmokeTests(unittest.TestCase):
    # render_html composes every render_* helper into the full page on
    # every 60s LaunchAgent regenerate. Targeted-marker assertions defend
    # against helper-drop / helper-swap / esc-removal / refresh-constant
    # drift regressions WITHOUT pinning the full HTML chunk (which would
    # be brittle against any incidental copy edit). Datetime fields
    # (data-iso, generated-at, timezone) intentionally NOT pinned --
    # render_html calls datetime.now() and those vary per regenerate.

    def _populated_state(self) -> dict:
        # Forces every conditional helper to emit non-empty output so a
        # dropped placeholder is detectable. render_changes needs staged
        # OR unstaged; render_worktrees needs >= 2 worktrees; render_
        # pending_branches needs pending_local_branches or pending_remote.
        return _state(
            staged=[{"code": "M", "path": "src/x.ts"}],
            worktrees=[
                {"branch": "main", "path": "/repo/main"},
                {"branch": "feature", "path": "/repo/feature"},
            ],
            pending_local_branches=[{
                "name": "feature",
                "kind": "worktree",
                "ahead": 1,
                "msg": "wip",
                "date": "2026-05-18",
            }],
            branches=[{"name": "main", "msg": "init", "track": ""}],
            remotes={"origin": "git@github.com:craftandship/code2wiki.git"},
            recent=[{"sha": "abc1234", "msg": "init", "date": "2026-05-18 09:00"}],
        )

    def test_returns_complete_html5_document(self):
        # Defends against a render_html that errors out early or returns
        # a truncated fragment (e.g. a refactor extracting the doctype +
        # html shell into a wrapper that's not called from main()).
        out = render_html(_state())
        self.assertTrue(out.startswith("<!doctype html>"))
        self.assertIn("</html>", out)

    def test_composes_every_render_helper_into_page(self):
        # One targeted marker per helper. A dropped {top} / {priorities}
        # / etc. in the f-string template (or a helper rename without
        # call-site update) trips the matching pin and tells the
        # operator WHICH helper went missing. The state fixture is
        # populated so the three conditional helpers (changes, worktrees,
        # pending_branches) emit non-empty.
        out = render_html(self._populated_state())
        self.assertIn('class="grid grid-top"', out)                  # render_top_stats
        self.assertIn("Priorities &amp; Things You Should Know", out)  # render_priorities
        self.assertIn("Pending Branches", out)                       # render_pending_branches
        self.assertIn("Unpushed Commits (", out)                     # render_unpushed
        self.assertIn("Changed Files", out)                          # render_changes
        self.assertIn("Recent Commits on", out)                      # render_recent
        self.assertIn("Local Branches &amp; Worktrees", out)         # render_branches
        self.assertIn("Untracked Files (", out)                      # render_untracked
        self.assertIn("Active Worktrees", out)                       # render_worktrees
        self.assertIn("<h2>Remotes</h2>", out)                       # render_remotes_tree
        self.assertIn("<h2>Working Tree</h2>", out)                  # render_remotes_tree (2nd card)

    def test_empty_state_omits_optional_helpers(self):
        # render_changes + render_worktrees + render_pending_branches
        # all return "" on a clean state. Defends against a refactor
        # that adds an always-on placeholder ("No changes yet" / "Single
        # worktree" / "No pending branches") to any of the three --
        # would clutter every regenerate on a quiet repo.
        out = render_html(_state())
        self.assertNotIn("Changed Files", out)
        self.assertNotIn("Active Worktrees", out)
        self.assertNotIn("Pending Branches", out)

    def test_footer_interpolates_head_short_and_head_subject(self):
        out = render_html(_state(head_short="deadbee", head_subject="fix: thing"))
        self.assertIn("deadbee", out)
        self.assertIn("fix: thing", out)

    def test_head_short_html_escaped_in_footer(self):
        # head_short comes from `git log -1 --format=%h`; crafted refs
        # can't easily inject markup there, but the esc() site exists
        # and a drop-esc refactor on the footer would silently surface
        # any future regression of upstream input sanitization.
        out = render_html(_state(head_short="<x>"))
        self.assertNotIn("<x>", out)
        self.assertIn("&lt;x&gt;", out)

    def test_head_subject_html_escaped_in_footer(self):
        # head_subject comes from `git log -1 --format=%s` -- the FULL
        # commit message subject line. A contributor can put any UTF-8
        # in a commit subject, including HTML. esc() is the only line
        # of defense rendering this into the always-on dashboard.
        out = render_html(_state(head_subject="<script>alert(1)</script>"))
        self.assertNotIn("<script>alert(1)</script>", out)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", out)

    def test_header_remote_url_renders_first_remote_value(self):
        # remote_url = next(iter(s["remotes"].values()), ""). Python's
        # insertion-ordered dict guarantees "origin" wins when seeded
        # first. Defends against a refactor selecting by key name
        # ("origin" lookup) that would silently render "" for repos
        # whose first remote is named something other than origin.
        out = render_html(_state(remotes={
            "origin": "git@github.com:craftandship/code2wiki.git",
            "upstream": "git@github.com:other/code2wiki.git",
        }))
        self.assertIn("github.com:craftandship/code2wiki.git", out)

    def test_remote_url_html_escaped_in_header(self):
        # Remote URL comes from `git remote -v` (operator-controlled
        # locally, but a `.git/config` from a less-trusted clone could
        # carry a crafted URL). esc() is the only defense at the header
        # site -- a separate esc() call from the footer's head_subject
        # site, so this pin defends an independent code path.
        out = render_html(_state(remotes={"origin": "<script>alert(1)</script>"}))
        self.assertNotIn("<script>alert(1)</script>", out)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", out)

    def test_meta_refresh_uses_refresh_seconds_constant(self):
        # Hard-pins the auto-refresh wiring -- a refactor that drops the
        # meta tag or hard-codes a different cadence (operator burnout:
        # "refresh every second to feel snappy") silently changes the
        # browser-side regenerate behavior. REFRESH_SECONDS loaded from
        # the module so the test follows any deliberate cadence change.
        out = render_html(_state())
        self.assertIn(
            f'<meta http-equiv="refresh" content="{REFRESH_SECONDS}">',
            out,
        )

    def test_load_bearing_section_order(self):
        # The operator scans top-down: top_stats (status bar) -> priorities
        # (what to do next) -> pending_branches (review queue) -> body
        # (unpushed/changes/recent on left, untracked/worktrees/remotes
        # on right) -> footer. A refactor reordering these silently
        # changes the read order and breaks the dashboard's "highest-
        # priority signal first" contract.
        out = render_html(self._populated_state())
        i_top = out.index('class="grid grid-top"')
        i_priorities = out.index("Priorities &amp; Things You Should Know")
        i_pending = out.index("Pending Branches")
        i_unpushed = out.index("Unpushed Commits (")
        i_footer = out.index("code2wiki git-state &middot; HEAD")
        self.assertLess(i_top, i_priorities)
        self.assertLess(i_priorities, i_pending)
        self.assertLess(i_pending, i_unpushed)
        self.assertLess(i_unpushed, i_footer)


if __name__ == "__main__":
    unittest.main()
