// Library entry, exposes the core engine for programmatic use.
export { scanProject } from "./core/scan.js";
export { parseFile, parseJava, parseCfml } from "./core/parsers/index.js";
export { extractUseCase } from "./core/extractor.js";
export { renderUseCase } from "./core/renderer.js";
export { loadConfig, defaultConfig } from "./core/config.js";
export { mockExtract } from "./core/llm/mock.js";
export type {
  Candidate,
  CandidateHints,
  Config,
  UseCase,
} from "./core/types.js";
export { ConfigSchema, UseCaseSchema } from "./core/types.js";
