// Two-mode model provider (ADR-0012 D5). Offline mode (default, no network) replays the fixture's
// scripted transcript through a ScriptedModelPort. Live mode (opt-in, requires config + credentials)
// builds a GatewayModelPort from the standard loadConfigFromFile + Gateway path used by the existing
// CLI commands. The workflow code receives a plain ModelPort seam and is unaware of which mode is
// active. Live-mode config resolution is fail-closed: an invalid/missing config throws ConfigInvalidError
// (a GatewayError subclass) which the CLI surfaces as exit 1 — it never silently falls back to offline.

import { Gateway } from "../gateway/gateway.js";
import { loadConfigFromFile, type EnvSource } from "../gateway/config.js";
import { GatewayModelPort } from "../harness/adapters.js";
import type { ModelPort } from "../harness/ports.js";
import type { NormalizedResponse } from "../gateway/types.js";
import { createScriptedModelPort } from "./scripted-model.js";
import type { EvaluationMode } from "./types.js";

const DEFAULT_CONFIG_PATH = "./keiko.config.json";

export interface EvaluationModelProviderDeps {
  readonly mode: EvaluationMode;
  // Required in live mode; ignored in offline mode.
  readonly env?: EnvSource | undefined;
  // The fixture's scripted transcript; used in offline mode.
  readonly transcript: readonly (NormalizedResponse | Error)[];
  // The model ID the fixture targets.
  readonly modelId: string;
  // Config file path for live mode. Defaults to ./keiko.config.json (matches the CLI commands).
  readonly configPath?: string | undefined;
}

// Builds the ModelPort for the given mode. In live mode this loads the gateway config and constructs
// a GatewayModelPort; loadConfigFromFile throws ConfigInvalidError when no provider/credentials are
// resolvable, which propagates to the caller (the CLI catches it and exits 1).
export function createEvaluationModelProvider(deps: EvaluationModelProviderDeps): ModelPort {
  if (deps.mode === "offline") {
    return createScriptedModelPort(deps.transcript);
  }
  const config = loadConfigFromFile(deps.configPath ?? DEFAULT_CONFIG_PATH, deps.env ?? {});
  return new GatewayModelPort(new Gateway(config));
}
