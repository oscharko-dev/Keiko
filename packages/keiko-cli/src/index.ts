// Public barrel for the keiko-cli package (ADR-0019 §"Target Package Topology"
// row keiko-cli). The CLI command surface — runCli dispatcher, the per-command
// handlers, and the small set of CLI-layer types each handler exposes — is
// re-exported here so the root product package's bin shim
// (`src/cli/index.ts` → `dist/cli/index.js`) and the surface-parity evaluator
// (`src/evaluations/surface-parity.ts`) consume the public surface only.
// Explicit-named re-exports (no `export *`) keep the surface auditable.

export { runCli, type CliIo } from "./runner.js";
export { runAgentCli } from "./run.js";
export { runGenTestsCli } from "./gen-tests.js";
export { runInvestigateCli } from "./investigate.js";
export { runVerifyCli } from "./verify.js";
export { runEvaluateCli, type EvaluateDeps } from "./evaluate.js";
export { runEvidenceCli } from "./evidence.js";
export { runContextCli } from "./context.js";
export { runModelsCli } from "./models.js";
export { runInitCli, KEIKO_START_SCRIPT, KEIKO_STOP_SCRIPT, type InitCliDeps } from "./init.js";
export { runLifecycleCli, type LifecycleCliDeps } from "./lifecycle.js";
export { runUiCli, parseUiArgs, waitForShutdown, type UiCliDeps } from "./ui.js";
// gateway-config.ts is a helper module (resolveConfigPathFromArgs) used internally by
// models.ts; it does not expose a CLI command, so nothing is re-exported here.
