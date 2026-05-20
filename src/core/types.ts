import { z } from "zod";

/**
 * A region of source code that might describe a use case.
 * Language-agnostic: produced by every parser.
 */
export interface Candidate {
  language: "java" | "cfml" | "ruby" | "python" | "unknown";
  /** Absolute path to the source file. */
  filePath: string;
  /** Path relative to the project root (used in citations). */
  relativePath: string;
  /** A stable identifier within this file: usually the function/method name. */
  name: string;
  /** Type of code region; informs prompt template selection. */
  kind:
    | "controller-method" // HTTP handler in a Spring/JAX-RS controller
    | "rails-action" // Rails controller action (REST or custom route)
    | "django-view" // Django FBV or CBV HTTP handler
    | "function" // Plain function or method
    | "cf-tag-function" // <cffunction name=...>
    | "cf-script-function"; // function foo() { ... } in CFML script syntax
  /** 1-indexed inclusive line range. */
  lineStart: number;
  lineEnd: number;
  /** The full source text of this region. */
  source: string;
  /**
   * Coarse structural hints extracted by the parser.
   * Examples: HTTP method/path, parameter list, called functions, decorators.
   */
  hints: CandidateHints;
}

export interface CandidateHints {
  /** Decorators / annotations on the function. */
  annotations?: string[];
  /** Parameter names + types where available. */
  parameters?: Array<{ name: string; type?: string }>;
  /** HTTP route if this is an HTTP handler. */
  httpRoute?: { method: string; path: string };
  /** Names of functions / methods called from inside this region. */
  callees?: string[];
  /** Database tables referenced (best-effort). */
  databaseTables?: string[];
  /** Free-text notes the parser wants to bubble up. */
  notes?: string[];
}

/**
 * The structured form of a use case before it's rendered to Markdown.
 * Matches the schema in docs/usecase-template.md.
 */
export const UseCaseSchema = z.object({
  code2wiki_id: z.string(),
  title: z.string(),
  slug: z.string(),
  actor: z.string(),
  status: z.enum(["active", "deprecated", "candidate"]),
  last_generated: z.string(),
  last_commit: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  source_files: z.array(
    z.object({
      path: z.string(),
      lines: z.string(), // "start-end"
    }),
  ),
  tags: z.array(z.string()),
  summary: z.string(),
  actor_detail: z.string(),
  trigger: z.string(),
  preconditions: z.array(z.string()),
  main_flow: z.array(
    z.object({
      step: z.string(),
      footnote: z.string().optional(),
    }),
  ),
  alternate_flows: z.array(
    z.object({
      label: z.string(),
      description: z.string(),
    }),
  ),
  postconditions: z.array(z.string()),
  business_rules: z.array(
    z.object({
      rule: z.string(),
      footnote: z.string().optional(),
    }),
  ),
  test_scenarios: z.array(
    z.object({
      label: z.string(),
      gwt: z.string(), // "Given X, when Y, then Z."
    }),
  ),
  related: z.array(
    z.object({
      slug: z.string(),
      title: z.string(),
    }),
  ),
  confidence_reason: z.string(),
});

export type UseCase = z.infer<typeof UseCaseSchema>;

/**
 * Configuration loaded from code2wiki.config.json or .code2wiki/config.json.
 */
/**
 * ADR-016: per-target coexistence configuration. Lets a customer pick
 * `greenfield` / `claim` / `parallel` per publish target and pin the
 * banner copy / source-link template.
 */
export const PublishTargetConfigSchema = z.object({
  mode: z
    .enum(["greenfield", "claim", "parallel"])
    .default("greenfield"),
  /** Default "code2wiki/" in parallel mode; ignored otherwise unless the
   *  customer opts in via this field for greenfield/claim. */
  slugPrefix: z.string().optional(),
  /** Opt-in title prefix (e.g. "[code2wiki]"). Default empty. */
  titlePrefix: z.string().optional(),
  /** Confluence: pin a parent page ID. If unset, parallel mode finds or
   *  creates a parent page named after the slug prefix's first segment. */
  parentPageId: z.string().optional(),
  banner: z
    .object({
      repoName: z.string().optional(),
      repoUrl: z.string().url().optional(),
      /** A `{commit}` token in the URL is replaced with the current commit. */
      commitUrlTemplate: z.string().optional(),
    })
    .optional(),
});

/** Single source of truth for the main_flow upper-bound default.
 *  Used by ConfigSchema (validator.maxMainFlowSteps) and by
 *  validateUseCaseDraft's ValidateOptions fallback so both sites always
 *  agree without a manual sync. */
export const DEFAULT_MAX_MAIN_FLOW_STEPS = 12;

/** Default blocklist for the validator's tag-content warn. Implementation-
 *  detail terms a non-technical BA won't recognize as filter criteria;
 *  tags should be business-readable nouns. Surfaced 2026-05-16 from a
 *  ColdBox run where `build-a-navigation-url-...` shipped with tags
 *  `["url-building","routing","ssl","ses","query-string","modules","navigation"]`,
 *  the network/protocol terms are noise for the audience the doc is
 *  written for. Customers whose docs audience IS technical can override
 *  via `config.validator.tagJargonBlocklist` (e.g. an empty array
 *  suppresses the warn entirely). Lowercase canonical form; the check
 *  is case-insensitive. */
export const DEFAULT_TAG_JARGON_BLOCKLIST = [
  // Transport / wire protocols
  "ssl", "tls", "http", "https", "tcp", "udp", "ftp", "smtp", "pop3", "imap",
  // Encoding / serialization formats
  "json", "jsonb", "xml", "yaml", "csv", "utf-8", "base64", "hex", "url-encoded", "query-string",
  // Hashes / identifiers
  "sha256", "md5", "uuid",
  // AWS / mail service codenames
  "ses",
  // Auth / web-security primitives
  "jwt", "oauth", "csrf", "cors",
  // Data-layer primitives
  "sql", "nosql", "orm", "crud",
];

/** Java parser candidate-surfacing mode. Default 'annotated' preserves
 *  the original behavior (Spring / JAX-RS / Servlet / EJB / CDI gates).
 *  Other modes exist for legacy Java codebases that pre-date framework
 *  annotations and rely on package conventions or Javadoc instead.
 *
 *  Modes:
 *    - 'annotated': require a framework annotation on the class OR an
 *       HTTP-verb annotation on the method. Cheapest signal; default.
 *    - 'all-public-classes': surface methods on any non-abstract,
 *       non-test class that has >= 3 public non-trivial methods AND a
 *       non-empty class-level Javadoc block. Catches business-logic
 *       classes in plain-Java codebases (JSPWiki-style).
 *    - 'package-allowlist': surface methods on any class whose package
 *       contains a segment named `service`, `business`, `manager`,
 *       `dao`, or `api`. Cheapest mode for codebases that follow
 *       layer-by-package conventions. */
export type JavaSurfaceMode =
  | "annotated"
  | "all-public-classes"
  | "package-allowlist";

export const ConfigSchema = z.object({
  /** Glob patterns of files to include. */
  include: z.array(z.string()).default([
    "**/*.java",
    "**/*.cfc",
    "**/*.cfm",
    "**/*_controller.rb",
    "**/views.py",
    "**/*_views.py",
    "**/views/**/*.py",
  ]),
  /** Glob patterns to exclude. */
  exclude: z
    .array(z.string())
    .default([
      "**/node_modules/**",
      "**/target/**",
      "**/build/**",
      "**/dist/**",
      "**/.git/**",
      // Conventional test paths across CFML, Java, and JS/TS. Extended
      // 2026-05-16 from the multi-repo signal exercise (8 real legacy
      // codebases): ColdBox `test-harness/`, ContentBox + TestBox
      // `specs/`, JS-conventional `__tests__/` + `__mocks__/`. Without
      // these, test-fixture handlers (e.g. ColdBox's `test-harness/
      // handlers/main.cfc#routeRunner`, a 3-line `runRoute(...)`
      // setup) leaked into the candidate set + burned LLM tokens
      // documenting test infrastructure as if it were business logic.
      "**/test/**",
      "**/tests/**",
      "**/test-harness/**",
      "**/spec/**",
      "**/specs/**",
      "**/__tests__/**",
      "**/__mocks__/**",
      // JMH / micro-benchmarks. Wildcard pattern catches `benchmark/`,
      // `benchmarks/`, AND module-suffix variants like Dropwizard's
      // `dropwizard-benchmarks/` (second multi-repo run, 2026-05-16:
      // its DropwizardResourceConfigBenchmark.java produced 3 low-
      // confidence pages, the LLM correctly hedged because the
      // nested JAX-RS resources are JMH stubs whose method bodies
      // are `return "id"` / `return "asset_by_id"` constants).
      "**/*benchmark*/**",
      "**/*benchmarks*/**",
      "**/references/**",
    ]),
  /** Output directory for generated Markdown. */
  output: z.string().default("./docs/use-cases"),
  /** LLM model name. */
  model: z.string().default("claude-sonnet-4-6"),
  /** Use mock mode (no API calls). */
  mock: z.boolean().default(false),
  /** Maximum number of candidates to process per run (cost guardrail). */
  maxCandidates: z.number().int().positive().default(50),
  /** Include methods whose entire body is `return <literal>;` in the
   *  candidate set. Default false: framework lifecycle stubs (e.g.
   *  Application.cfc#onRequestStart returning true) and empty defaults
   *  produce useless docs. Flip to true if doc-coverage completeness
   *  matters more than per-page signal. See parsers/triviality.ts. */
  includeConstantReturns: z.boolean().default(false),
  /** How the Java parser decides which classes to surface candidates
   *  from. See JavaSurfaceMode for per-mode semantics. Default
   *  'annotated' preserves pre-2026-05-16 behavior; explicitly set to
   *  'all-public-classes' or 'package-allowlist' for plain-Java legacy
   *  codebases (JSPWiki-style) where framework annotations are absent. */
  javaSurfaceMode: z
    .enum(["annotated", "all-public-classes", "package-allowlist"])
    .default("annotated"),
  /** When true, JMH benchmark classes (@BenchmarkMode / @State / @Benchmark)
   *  are surfaced instead of skipped. Default false. In 'annotated' mode the
   *  framework-annotation gate is bypassed for JMH classes so public
   *  non-trivial methods surface directly; even mixed classes (JMH + @Path
   *  etc.) are opted in fully and expose all methods, not just route-mapped
   *  ones. Flip only when the customer explicitly wants benchmark-harness
   *  pages published (rare). */
  includeJmhBenchmarks: z.boolean().default(false),
  /** Structural-validator tunables. Defaults reflect what works for
   *  BA-audience readability; bump via config when a customer's docs
   *  audience tolerates denser flows. */
  validator: z
    .object({
      /** Warn (severity=warn, does NOT trigger retry) when main_flow has
       *  more than this many steps. DEFAULT_MAX_MAIN_FLOW_STEPS is the
       *  working-memory ceiling for a sequential read; past it the BA
       *  needs to take notes. Surfaced by the 2026-05-16 Roller +
       *  petclinic-rest runs. */
      maxMainFlowSteps: z
        .number()
        .int()
        .positive()
        .default(DEFAULT_MAX_MAIN_FLOW_STEPS),
      /** Warn (severity=warn, does NOT trigger retry) when any tag
       *  appears in this lowercase, case-insensitive blocklist of
       *  implementation-detail terms. Default list at
       *  DEFAULT_TAG_JARGON_BLOCKLIST. Pass an empty array to disable
       *  the warn (e.g. for a security/networking app whose audience is
       *  technical). Pass a longer array to add domain-specific noise
       *  terms. */
      tagJargonBlocklist: z
        .array(z.string())
        .default(DEFAULT_TAG_JARGON_BLOCKLIST),
    })
    .default({
      maxMainFlowSteps: DEFAULT_MAX_MAIN_FLOW_STEPS,
      tagJargonBlocklist: DEFAULT_TAG_JARGON_BLOCKLIST,
    }),
  /** ADR-016 per-target publish configuration. */
  publish: z
    .object({
      confluence: PublishTargetConfigSchema.optional(),
      notion: PublishTargetConfigSchema.optional(),
    })
    .default({}),
  /** ADR-035 audit signing configuration. */
  audit: z
    .object({
      signing: z
        .object({
          /** When true, each entry is signed with an Ed25519 key on append. */
          enabled: z.boolean().default(false),
          /** Path (relative to project root or absolute) to the private key PEM.
           *  Generate with `code2wiki audit keygen`. */
          keyPath: z.string().default(".code2wiki/audit-key.pem"),
        })
        .default({}),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type PublishTargetConfig = z.infer<typeof PublishTargetConfigSchema>;
