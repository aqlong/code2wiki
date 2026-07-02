#!/usr/bin/env python3
"""Unit tests for tools/scripts/strip-em-dashes.py transform().

Run: python3 tools/scripts/strip-em-dashes.test.py

Stdlib-only. Loads the sibling script via importlib (the script's
hyphenated filename rules out a plain `import`).

Test files mirror source files per CLAUDE.md Code style; this is the
.py analogue of the foo.ts <-> foo.test.ts convention.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import sys
import tempfile
import unittest
from pathlib import Path


def _load_script():
    here = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location(
        "strip_em_dashes", here / "strip-em-dashes.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_script = _load_script()
transform = _script.transform
EM = _script.EM
should_skip = _script.should_skip
SKIP_PATH_FRAGMENTS = _script.SKIP_PATH_FRAGMENTS


class TransformTests(unittest.TestCase):
    def test_prose_em_dash_with_spaces_becomes_comma(self):
        out, n = transform("foo — bar")
        self.assertEqual(out, "foo, bar")
        self.assertEqual(n, 1)

    def test_header_em_dash_with_spaces_becomes_colon(self):
        out, n = transform("## title — subtitle")
        self.assertEqual(out, "## title: subtitle")
        self.assertEqual(n, 1)

    def test_em_dash_inside_inline_code_span_is_preserved(self):
        # The canonical regression: the CLAUDE.md style rule itself uses
        # `—` as a literal char inside backticks. The pre-fix transform()
        # mangled it because it ran replace() over the whole line.
        line = "No em dashes (`—`, U+2014) anywhere."
        out, n = transform(line)
        self.assertEqual(out, line)
        self.assertEqual(n, 0)

    def test_mixed_code_span_and_prose_em_dash_only_touches_prose(self):
        out, n = transform("use `—` not — here")
        self.assertEqual(out, "use `—` not, here")
        self.assertEqual(n, 1)

    def test_multiple_code_spans_all_preserved(self):
        out, n = transform("a `—` b `x` c — d")
        self.assertEqual(out, "a `—` b `x` c, d")
        self.assertEqual(n, 1)

    def test_header_with_em_dash_only_inside_code_span_unchanged(self):
        line = "## see `—` for details"
        out, n = transform(line)
        self.assertEqual(out, line)
        self.assertEqual(n, 0)

    def test_no_space_em_dash_in_prose_falls_back_to_comma_space(self):
        out, n = transform("foo—bar")
        self.assertEqual(out, "foo, bar")
        self.assertEqual(n, 1)

    def test_prose_em_dash_with_trailing_space_only_avoids_double_space(self):
        # Pins the second prose substitution rule (`— ` -> `, `) as
        # observationally distinct from the fallback (`—` -> `, `). A
        # regression that drops this rule would leave the trailing space
        # intact AND prepend ", " from the fallback, producing "foo,  bar"
        # (two spaces). This is the asymmetric-spacing case the rule
        # exists for; without a direct test, the fallback would silently
        # absorb it and leak ugly double-spacing into every cleanup pass.
        out, n = transform("foo— bar")
        self.assertEqual(out, "foo, bar")
        self.assertEqual(n, 1)

    def test_prose_em_dash_with_leading_space_only_avoids_extra_comma_space(self):
        # Pins the third prose substitution rule (` —` -> `,`) as
        # observationally distinct from the fallback. A regression that
        # drops this rule would keep the leading space AND apply the
        # fallback, producing "foo , bar" (space-comma-space-bar). The
        # rule deliberately collapses the trailing token onto the comma
        # so prose like "case A —subcase" becomes "case A,subcase" which
        # the next idempotent pass leaves alone.
        out, n = transform("foo —bar")
        self.assertEqual(out, "foo,bar")
        self.assertEqual(n, 1)

    def test_header_em_dash_with_leading_space_only_avoids_extra_colon_space(self):
        # Header analogue of the leading-space prose rule: ` —` -> `:` in
        # headers, distinct from the fallback `—` -> `:`. Without this
        # rule, "## foo —bar" would become "## foo : bar"
        # (space-colon-space) under the fallback, breaking idempotence on
        # already-tightened headers. (The mirror trailing-space header
        # case is NOT distinguishable from the fallback because the
        # header fallback is `:` with no trailing space, so `— ` and `—`
        # converge on the same output for headers, only the leading-space
        # form genuinely needs its own rule.)
        out, n = transform("## foo —bar")
        self.assertEqual(out, "## foo:bar")
        self.assertEqual(n, 1)

    def test_no_space_em_dash_inside_code_span_is_preserved(self):
        line = "see `foo—bar` here"
        out, n = transform(line)
        self.assertEqual(out, line)
        self.assertEqual(n, 0)

    def test_unmatched_backtick_still_substitutes_prose(self):
        # Graceful degradation: the split regex requires a balanced
        # `...`, so an unmatched backtick leaves the line as a single
        # prose segment. Em dashes after the lone backtick still get
        # the prose substitution (the alternative — silently skipping
        # the rest of the line on a typo — would be worse).
        out, n = transform("foo `bar — baz")
        self.assertEqual(out, "foo `bar, baz")
        self.assertEqual(n, 1)

    def test_idempotent_on_clean_text(self):
        clean = "foo, bar: baz\n## title: subtitle"
        out, n = transform(clean)
        self.assertEqual(out, clean)
        self.assertEqual(n, 0)

    def test_count_returned_equals_em_dashes_removed(self):
        out, n = transform("a — b — c — d")
        self.assertEqual(out, "a, b, c, d")
        self.assertEqual(n, 3)

    def test_em_constant_is_u2014(self):
        # Pins the constant the rest of the project depends on; a swap
        # to en dash (U+2013) or hyphen would silently disarm the rule.
        self.assertEqual(EM, "—")


class TransformNonMarkdownTests(unittest.TestCase):
    """Cover the is_markdown=False branch.

    The motivating regression: apps/dashboard/src/lib/stripe/checkout.ts
    shipped a TS template literal `... returned no URL — Stripe API
    contract violation` that the linter SILENTLY ACCEPTED because its
    backtick-segmenting (correct for markdown inline code spans) wrongly
    treated the template literal as off-limits prose. Caught by manual
    grep on 2026-05-17 (edd1089) after 5 consecutive CI-greens lulled
    the project into thinking it was clean.

    Symmetric coverage to TransformTests so any future regression that
    re-introduces the gap (e.g., a refactor that drops the is_markdown
    branch entirely) trips a specific assertion here.
    """

    def test_template_literal_em_dash_is_scrubbed(self):
        # The motivating regression. Without is_markdown=False, the
        # whole `...` segment was preserved verbatim.
        line = 'console.log(`API reachable — model responded`);'
        out, n = transform(line, is_markdown=False)
        self.assertEqual(
            out, 'console.log(`API reachable, model responded`);'
        )
        self.assertEqual(n, 1)

    def test_template_literal_em_dash_preserved_when_is_markdown_true(self):
        # Pins the converse: with is_markdown=True (the default), the
        # same line is INTENTIONALLY untouched because the linter is
        # respecting markdown inline-code-span semantics. A regression
        # collapsing the two branches into one would flip exactly one
        # of these two tests.
        line = 'console.log(`API reachable — model responded`);'
        out, n = transform(line, is_markdown=True)
        self.assertEqual(out, line)
        self.assertEqual(n, 0)

    def test_default_arg_is_markdown_true(self):
        # The existing TransformTests class relies on transform(text)
        # (no kwarg) behaving as markdown. A regression flipping the
        # default to False would silently start scrubbing inside
        # backticks across the existing test corpus.
        line = "see `—` here"
        out, n = transform(line)
        self.assertEqual(out, line)
        self.assertEqual(n, 0)

    def test_non_markdown_no_header_detection_on_shebang(self):
        # In non-markdown mode, `#!/usr/bin/env node ...` would lstrip()
        # to start with `#`. The markdown header rule must NOT fire
        # there, otherwise a hypothetical em dash on a shebang line
        # would be substituted with `:` (the header rule) instead of
        # `,` (the prose rule). Pins is_header gated on is_markdown.
        line = "#!/usr/bin/env node — entry point"
        out, n = transform(line, is_markdown=False)
        self.assertEqual(out, "#!/usr/bin/env node, entry point")
        self.assertEqual(n, 1)

    def test_non_markdown_multi_line_scrubs_inside_each_template(self):
        # Pins per-line iteration: a regression that early-returns on
        # the first non-em-dash line would miss subsequent violators.
        text = (
            "const a = `clean`;\n"
            "const b = `dirty — line`;\n"
            "const c = `also — dirty`;\n"
        )
        out, n = transform(text, is_markdown=False)
        self.assertEqual(
            out,
            (
                "const a = `clean`;\n"
                "const b = `dirty, line`;\n"
                "const c = `also, dirty`;\n"
            ),
        )
        self.assertEqual(n, 2)


class ShouldSkipTests(unittest.TestCase):
    """Cover should_skip + SKIP_PATH_FRAGMENTS.

    The skip list is load-bearing: a regression dropping `/examples/`
    would silently mangle the gold-standard regression fixtures at
    `examples/*/expected.md` and `examples/*/notes.md`, breaking the
    examples-based regression suite without any visible signal at
    cleanup time. Same risk for `/references/` (gitignored CF/Java
    clones) and `/.code2wiki/` (per-customer runtime state).
    """

    def test_skips_examples_dir(self):
        # The high-stakes case from the module docstring: gold-standard
        # regression fixtures must never be rewritten by the script.
        self.assertTrue(should_skip(Path("/repo/examples/foo/expected.md")))
        self.assertTrue(should_skip(Path("/repo/examples/bar/notes.md")))
        self.assertTrue(should_skip(Path("/repo/examples/baz/actual.md")))

    def test_skips_references_dir(self):
        # Gitignored reference clones (CFML / Java) per ADR-010.
        self.assertTrue(should_skip(Path("/repo/references/masacms/foo.cfc")))

    def test_skips_node_modules(self):
        self.assertTrue(should_skip(Path("/repo/node_modules/marked/README.md")))
        self.assertTrue(
            should_skip(Path("/repo/apps/dashboard/node_modules/foo/index.ts"))
        )

    def test_skips_code2wiki_runtime_state(self):
        # Per-customer runtime state under .code2wiki/ is gitignored
        # and may contain operator-content; never touch.
        self.assertTrue(should_skip(Path("/repo/.code2wiki/preview/foo.html")))

    def test_skips_claude_worktrees(self):
        # Worktrees may have their own in-flight em dashes; the cleanup
        # script must only touch the main checkout.
        self.assertTrue(
            should_skip(Path("/repo/.claude/worktrees/foo-bar/CLAUDE.md"))
        )

    def test_skips_ocean_bot_subproject(self):
        # tools/ocean-bot/** is governed by the bot-self-modification
        # rule (CLAUDE.md, Ocean-bot rule #11): any diff there requires
        # dashboard approval. The project linter delegates em-dash
        # enforcement inside the bot to the bot's own CI-red-scrub
        # flow. A regression removing the bot skip would let any
        # operator running this script with -e (no --check) bypass the
        # bot-self-mod rule with a sweeping 1-char "policy compliance"
        # commit across the bot tree.
        self.assertTrue(
            should_skip(Path("/repo/tools/ocean-bot/src/index.ts"))
        )
        self.assertTrue(
            should_skip(Path("/repo/tools/ocean-bot/dashboard/app/page.tsx"))
        )
        self.assertTrue(
            should_skip(Path("/repo/tools/ocean-bot/README.md"))
        )

    def test_does_not_skip_normal_source_paths(self):
        # Source / docs / tools paths are the target of the cleanup.
        self.assertFalse(should_skip(Path("/repo/CLAUDE.md")))
        self.assertFalse(should_skip(Path("/repo/docs/decisions.md")))
        self.assertFalse(should_skip(Path("/repo/src/cli/index.ts")))
        self.assertFalse(should_skip(Path("/repo/apps/dashboard/src/app/page.tsx")))
        self.assertFalse(should_skip(Path("/repo/tools/scripts/README.md")))

    def test_does_not_skip_dir_named_like_a_fragment_without_slashes(self):
        # The fragments are bracketed by slashes on purpose so a file
        # literally named "examples.md" at the repo root (or any
        # similar near-miss) is NOT skipped. A regression dropping the
        # leading slash from a fragment would over-skip.
        self.assertFalse(should_skip(Path("/repo/examples.md")))
        self.assertFalse(should_skip(Path("/repo/my-examples-doc.md")))

    def test_windows_style_backslash_paths_normalised(self):
        # should_skip() does `str(p).replace("\\", "/")` so paths from
        # a Windows checkout (or any literal-backslash path) still hit
        # the skip list. Without the normalisation, a Windows operator
        # running the script would silently rewrite their examples/.
        self.assertTrue(should_skip(Path("C:\\repo\\examples\\foo\\expected.md")))
        self.assertTrue(
            should_skip(Path("C:\\repo\\node_modules\\marked\\README.md"))
        )

    def test_skip_fragments_tuple_pinned_byte_for_byte(self):
        # Lockstep canary: changing this tuple (drop an entry, add an
        # entry, rename a path) is a deliberate decision. Bumping this
        # test in lockstep is the friction.
        self.assertEqual(
            SKIP_PATH_FRAGMENTS,
            (
                "/node_modules/",
                "/.code2wiki/",
                "/references/",
                "/examples/",
                "/.claude/worktrees/",
                "/tools/ocean-bot/",
                "/tools/scripts/strip-em-dashes.py",
                "/tools/scripts/strip-em-dashes.test.py",
            ),
        )

    def test_scrubber_and_its_test_skip_themselves(self):
        # *.py is scanned since 2026-07-02, so the scrubber + this test
        # file (both contain em-dash literals by design: the EM constant
        # and fixture strings) MUST self-skip or every CI run corrupts
        # the linter itself.
        root = _script.REPO_ROOT
        self.assertTrue(should_skip(root / "tools/scripts/strip-em-dashes.py"))
        self.assertTrue(
            should_skip(root / "tools/scripts/strip-em-dashes.test.py")
        )

    def test_repo_root_inside_worktree_does_not_skip_everything(self):
        # should_skip matches the path RELATIVE to REPO_ROOT. When the
        # repo root itself lives under a skip fragment (a git worktree at
        # ~/code2wiki/.claude/worktrees/<name>/ is the live case), the
        # old absolute-path match skipped EVERY file and the check passed
        # vacuously ("0 em dashes found across 0 files"). Live-buggy in
        # every worktree session until 2026-07-02.
        with tempfile.TemporaryDirectory() as td:
            wt_root = Path(td) / ".claude" / "worktrees" / "some-worktree"
            (wt_root / "src").mkdir(parents=True)
            f = wt_root / "src" / "normal.ts"
            f.write_text("const x = 1;\n")
            with _isolated_repo_root(wt_root):
                self.assertFalse(should_skip(f))
                # Skip fragments still work relative to the worktree root.
                nm = wt_root / "node_modules" / "pkg" / "index.ts"
                self.assertTrue(should_skip(nm))

    def test_every_skip_fragment_has_positive_path_coverage(self):
        # Defends against a future contributor adding a fragment to
        # SKIP_PATH_FRAGMENTS without a matching positive test by
        # asserting every entry actually causes should_skip to return
        # True on a plausible path containing it.
        for frag in SKIP_PATH_FRAGMENTS:
            self.assertTrue(
                should_skip(Path(f"/repo{frag}some/file.md")),
                f"fragment {frag!r} did not trigger skip",
            )


@contextlib.contextmanager
def _isolated_repo_root(root: Path):
    """Swap _script.REPO_ROOT for the duration of a test, restore on exit.

    main() walks REPO_ROOT for files, so a clean tmpdir lets us pin the
    walk + argparse + rewrite contract without touching the real repo.
    """
    original = _script.REPO_ROOT
    _script.REPO_ROOT = root
    try:
        yield
    finally:
        _script.REPO_ROOT = original


@contextlib.contextmanager
def _patched_argv(argv: list[str]):
    """Swap sys.argv for the duration of a main() invocation."""
    original = sys.argv
    sys.argv = argv
    try:
        yield
    finally:
        sys.argv = original


def _run_main(repo_root: Path, *args: str) -> tuple[int, str]:
    """Invoke main() with REPO_ROOT swapped + sys.argv set; return (rc, stdout)."""
    buf = io.StringIO()
    with _isolated_repo_root(repo_root), _patched_argv(
        ["strip-em-dashes.py", *args]
    ), contextlib.redirect_stdout(buf):
        rc = _script.main()
    return rc, buf.getvalue()


class MainTests(unittest.TestCase):
    """Pin the argparse + file-walk + write-or-check contract of main().

    Currently zero direct coverage; transform() is the only unit-tested
    surface. Regressions in any of the eight branches below would
    silently bypass the project's em-dash discipline: misroute the
    is_markdown dispatch (template literals would mask em dashes),
    swallow more than UnicodeDecodeError/OSError, walk fewer file
    extensions, or flip --check exit-code semantics.
    """

    def test_returns_zero_on_clean_tree(self):
        with tempfile.TemporaryDirectory() as td:
            (Path(td) / "clean.md").write_text("plain prose, no em dash\n")
            rc, out = _run_main(Path(td))
            self.assertEqual(rc, 0)
            self.assertIn("0 em dashes replaced", out)

    def test_returns_zero_on_clean_tree_in_check_mode(self):
        with tempfile.TemporaryDirectory() as td:
            (Path(td) / "clean.md").write_text("plain prose, no em dash\n")
            rc, out = _run_main(Path(td), "--check")
            self.assertEqual(rc, 0)
            self.assertIn("0 em dashes found", out)

    def test_check_mode_returns_one_when_em_dashes_present(self):
        with tempfile.TemporaryDirectory() as td:
            (Path(td) / "dirty.md").write_text(f"foo {EM} bar\n")
            rc, _ = _run_main(Path(td), "--check")
            self.assertEqual(rc, 1)

    def test_check_mode_does_not_rewrite_file(self):
        # --check must be read-only. A regression letting --check write
        # would silently mutate the operator's tree on what they thought
        # was a dry-run pass.
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "dirty.md"
            original = f"foo {EM} bar\n"
            p.write_text(original)
            _run_main(Path(td), "--check")
            self.assertEqual(p.read_text(), original)

    def test_write_mode_returns_zero_even_when_em_dashes_found(self):
        # main() returns 1 ONLY in --check mode; without --check the
        # script rewrites and exits 0 (it did the work).
        with tempfile.TemporaryDirectory() as td:
            (Path(td) / "dirty.md").write_text(f"foo {EM} bar\n")
            rc, _ = _run_main(Path(td))
            self.assertEqual(rc, 0)

    def test_write_mode_actually_rewrites_file(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "dirty.md"
            p.write_text(f"foo {EM} bar\n")
            _run_main(Path(td))
            self.assertEqual(p.read_text(), "foo, bar\n")
            self.assertNotIn(EM, p.read_text())

    def test_skipped_paths_are_not_rewritten(self):
        # node_modules is in SKIP_PATH_FRAGMENTS; main() must not
        # rewrite files under it even though the extension matches.
        with tempfile.TemporaryDirectory() as td:
            nm = Path(td) / "node_modules" / "pkg"
            nm.mkdir(parents=True)
            skipped = nm / "vendor.md"
            original = f"foo {EM} bar\n"
            skipped.write_text(original)
            _run_main(Path(td))
            self.assertEqual(skipped.read_text(), original)

    def test_dispatch_routes_md_files_as_markdown(self):
        # .md files treat backtick-delimited spans as inline code:
        # em dashes inside backticks must be preserved (the
        # is_markdown=True branch).
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "doc.md"
            p.write_text(f"prose {EM} more `code {EM} span` tail\n")
            _run_main(Path(td))
            txt = p.read_text()
            # Prose em dash was rewritten:
            self.assertIn("prose, more", txt)
            # Inline code span preserved its em dash:
            self.assertIn(f"`code {EM} span`", txt)

    def test_dispatch_routes_ts_files_as_non_markdown(self):
        # The 2026-05-17 regression: an em dash inside a template
        # literal in a .ts file was silently preserved because the
        # whole backtick span was treated as code. main() must dispatch
        # .ts to transform(is_markdown=False) so template-literal
        # prose gets scrubbed.
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "checkout.ts"
            p.write_text(f"console.log(`API down {EM} check Stripe`);\n")
            _run_main(Path(td))
            txt = p.read_text()
            self.assertNotIn(EM, txt)
            self.assertIn("API down, check Stripe", txt)

    def test_walks_all_eleven_supported_extensions(self):
        # Pins the file-extension allowlist. A regression dropping any
        # one of these means files of that extension silently keep
        # their em dashes (no error, just unscrubbed).
        #
        # .yml + .yaml were added 2026-05-21 after five GHA workflow
        # files under .github/workflows/ shipped em dashes that the
        # earlier seven-extension allowlist silently bypassed (the
        # weekly calibration-recompute cron was the surfacing case).
        #
        # .toml + .sh were added 2026-05-21 after a real miss surfaced
        # in railway.toml line 7 (a prose comment in the deploy config)
        # and in apps/dashboard/scripts/bootstrap-local.sh (7 prose em
        # dashes inside the heredoc that becomes the operator's
        # generated .env.local). The earlier nine-extension allowlist
        # silently bypassed both file types.
        with tempfile.TemporaryDirectory() as td:
            exts = (
                "md", "ts", "tsx", "mjs", "cjs", "mts", "cts",
                "yml", "yaml", "toml", "sh",
            )
            for ext in exts:
                (Path(td) / f"x.{ext}").write_text(f"foo {EM} bar\n")
            _run_main(Path(td))
            for ext in exts:
                txt = (Path(td) / f"x.{ext}").read_text()
                self.assertNotIn(
                    EM, txt, msg=f".{ext} file was not rewritten"
                )

    def test_dispatch_routes_yaml_files_as_non_markdown(self):
        # YAML em dashes overwhelmingly appear in `name:` titles or
        # `# comment` lines. Both should route through the prose
        # substitution (`, ` for ` — `, NOT `: `), since YAML files
        # are not markdown (the `: ` header rule is markdown-specific
        # and would produce invalid YAML if applied to a `name:` line).
        #
        # Defends against a regression that treats YAML as markdown
        # (e.g., the operator copies the .md special-casing across to
        # the new extensions). Such a refactor would render
        # `name: foo — bar` as `name: foo: bar`, which is parseable
        # YAML but silently changes the workflow's display name.
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "workflow.yml"
            p.write_text(
                f"name: code2wiki {EM} regenerate use-case docs\n"
                f"# comment {EM} prose tail\n"
            )
            _run_main(Path(td))
            txt = p.read_text()
            self.assertNotIn(EM, txt)
            # Comma substitution, NOT colon:
            self.assertIn("name: code2wiki, regenerate use-case docs", txt)
            self.assertIn("# comment, prose tail", txt)

    def test_dispatch_routes_toml_files_as_non_markdown(self):
        # TOML em dashes overwhelmingly appear in `# comment` lines or
        # `key = "value with — prose"` strings. Both must route through
        # the prose substitution (`, ` for ` — `, NOT `: `), since TOML
        # files are not markdown (the `: ` header rule is markdown-only
        # and would corrupt TOML syntax: `key — value` becoming
        # `key: value` would silently rewrite the key/value separator,
        # though `# foo — bar` becoming `# foo: bar` would be parseable).
        #
        # Defends against a regression that treats TOML as markdown
        # (e.g., the operator copies the .md special-casing across to
        # the new extensions). The surfacing real-miss case was the
        # railway.toml line 7 comment "# dashboard but not the CLI —
        # the subprocess call failed with"; the prose route correctly
        # produces "# dashboard but not the CLI, the subprocess...".
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "railway.toml"
            p.write_text(
                f"# dashboard but not the CLI {EM} the subprocess failed\n"
                f'name = "code2wiki {EM} build"\n'
            )
            _run_main(Path(td))
            txt = p.read_text()
            self.assertNotIn(EM, txt)
            # Comma substitution, NOT colon:
            self.assertIn("# dashboard but not the CLI, the subprocess failed", txt)
            self.assertIn('name = "code2wiki, build"', txt)

    def test_dispatch_routes_sh_files_as_non_markdown(self):
        # Shell em dashes overwhelmingly appear in `# comment` prose or
        # echo strings (often inside heredocs that become file content
        # the operator reads). Both must route through prose substitution
        # (`, ` for ` — `, NOT `: `).
        #
        # The shebang line `#!/usr/bin/env bash` starts with `#` and
        # would falsely match the markdown header rule if .sh were
        # routed as markdown; for non-markdown the header rule never
        # fires (is_header = is_markdown and ...), so the shebang line
        # passes through untouched even when it contains an em dash.
        #
        # The surfacing real-miss case was apps/dashboard/scripts/
        # bootstrap-local.sh with 7 prose em dashes across comments and
        # echo strings; the prose route correctly produces the comma
        # form throughout, including inside the heredoc content that
        # becomes the operator's generated .env.local file.
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "bootstrap.sh"
            p.write_text(
                f"#!/usr/bin/env bash\n"
                f"# commented out {EM} those\n"
                f'echo "Aborting {EM} existing $ENV_FILE preserved."\n'
            )
            _run_main(Path(td))
            txt = p.read_text()
            self.assertNotIn(EM, txt)
            # Comma substitution, NOT colon:
            self.assertIn("# commented out, those", txt)
            self.assertIn('echo "Aborting, existing $ENV_FILE preserved."', txt)
            # Shebang line is preserved byte-identical:
            self.assertIn("#!/usr/bin/env bash", txt)

    def test_ignores_unsupported_extensions(self):
        # A file with a non-allowlisted extension must NOT be touched
        # even if it contains an em dash. (.py used to be the fixture
        # here; since 2026-07-02 .py IS scanned and the scrubber + its
        # test self-skip via SKIP_PATH_FRAGMENTS instead.)
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "notes.txt"
            original = f"# foo {EM} bar\n"
            p.write_text(original)
            _run_main(Path(td))
            self.assertEqual(p.read_text(), original)

    def test_swallows_unicode_decode_error_on_binary_file(self):
        # A binary file under a matching extension must not crash the
        # walk. The try/except in main() returns silently and processes
        # the rest of the tree.
        with tempfile.TemporaryDirectory() as td:
            (Path(td) / "binary.md").write_bytes(b"\xff\xfe\xff\xfe not utf-8")
            (Path(td) / "good.md").write_text(f"foo {EM} bar\n")
            rc, _ = _run_main(Path(td))
            self.assertEqual(rc, 0)
            # The valid file was still rewritten:
            self.assertNotIn(EM, (Path(td) / "good.md").read_text())

    def test_files_without_em_dash_are_left_byte_identical(self):
        # main()'s `if EM not in text: continue` early-exit means a
        # clean file is never even opened-for-write. Pin via mtime: a
        # rewrite would update mtime; the early-exit leaves it alone.
        import os
        import time
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "clean.md"
            p.write_text("no em dashes here\n")
            old_mtime = p.stat().st_mtime
            time.sleep(0.05)  # ensure new mtime would differ
            _run_main(Path(td))
            self.assertEqual(p.stat().st_mtime, old_mtime)
            # Also a content sanity check
            self.assertEqual(p.read_text(), "no em dashes here\n")

    def test_print_summary_includes_file_count_and_total(self):
        # Operators eyeball the script's stdout to know what changed.
        # A regression silencing the per-file or total summary would
        # leave them flying blind on CI logs.
        with tempfile.TemporaryDirectory() as td:
            (Path(td) / "a.md").write_text(f"foo {EM} bar\n")
            (Path(td) / "b.md").write_text(f"baz {EM} qux\n")
            _, out = _run_main(Path(td))
            self.assertIn("2 em dashes replaced", out)
            self.assertIn("across 2 files", out)


if __name__ == "__main__":
    # unittest.main() exits with a non-zero code on failure, which is
    # what CI needs. Verbose so failing assertions are easy to read.
    unittest.main(verbosity=2)
