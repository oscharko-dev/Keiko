// Wave 2 BFF handler dependencies (ADR-0011 D5/D8/D9). The Wave 1 skeleton's `UiServerDeps` carried
// only the static-serving + CSP + port fields; the JSON/SSE handlers additionally need the resolved
// gateway config (for the config inspector and for building a ModelPort), an evidence store, a live
// redactor, the process env, and the in-memory run registry. Every field here is OPTIONAL so the
// 3-arg `createUiServer({ staticRoot, csp, port })` form still compiles and the Wave 1 server tests
// pass unchanged; the handlers degrade gracefully (no config → 400 NO_MODEL on a run, null config on
// the inspector; no store → an empty evidence list).

import { loadConfigFromFile, type EnvSource, type GatewayConfig } from "../gateway/index.js";
import { GatewayError, Gateway } from "../gateway/index.js";
import { GatewayModelPort } from "../harness/index.js";
import type { ModelPort } from "../harness/index.js";
import { createAuditRedactor } from "../audit/index.js";
import { deepRedactStrings } from "../audit/redaction.js";
import { createNodeEvidenceStore, resolveEvidenceDir } from "../audit/store.js";
import type { EvidenceStore } from "../audit/index.js";
import type { RunRegistry } from "./runs.js";
import { createRunRegistry } from "./runs.js";

// A redactor applied to every LIVE (non-manifest) payload before it reaches the browser (D9). It is
// `deepRedactStrings` composed with the audit redactor; reused, never a new regex.
export type Redactor = (value: unknown) => unknown;

// Builds a ModelPort for a run. The default builds a `GatewayModelPort` from the resolved config
// (mirroring the CLI); tests inject a deterministic fake so runs are offline. Throws/returns when no
// model can be built so the run route maps it to a 400 NO_MODEL — the BFF never calls a model
// directly, only through the harness/workflow entry points the port feeds.
export type ModelPortFactory = (modelId: string) => ModelPort | undefined;

export interface UiHandlerDeps {
  // The resolved gateway config, or undefined when no config file was provided / it failed to load.
  readonly config: GatewayConfig | undefined;
  // True when a config file path was supplied AND parsed successfully.
  readonly configPresent: boolean;
  // The evidence store the evidence routes read from.
  readonly evidenceStore: EvidenceStore;
  // Process environment for redaction (env-value scrubbing) and config resolution.
  readonly env: EnvSource;
  // Live-payload redactor (D9). Applied to run reports, projections, and SSE event data.
  readonly redactor: Redactor;
  // The in-memory, bounded run registry. Injectable so tests never share global state.
  readonly registry: RunRegistry;
  // Builds the ModelPort a run uses. Default = GatewayModelPort from config; tests inject a fake.
  readonly modelPortFactory: ModelPortFactory;
}

export interface BuildHandlerDepsOptions {
  // Path to a gateway config file (`keiko ui --config`); undefined → no config inspector data.
  readonly configPath: string | undefined;
  // Evidence directory (`keiko ui --evidence-dir`); resolved via the audit precedence rules.
  readonly evidenceDir: string | undefined;
  readonly env: EnvSource;
  // Optional injected registry (tests); a fresh bounded registry is created otherwise.
  readonly registry?: RunRegistry | undefined;
  // Optional injected ModelPort factory (tests); the GatewayModelPort builder is used otherwise.
  readonly modelPortFactory?: ModelPortFactory | undefined;
}

// Loads the config without leaking the path or any secret on failure: a missing/invalid config file
// is a normal "no config" state, not an error surfaced to the browser.
function resolveConfig(
  configPath: string | undefined,
  env: EnvSource,
): { config: GatewayConfig | undefined; configPresent: boolean } {
  if (configPath === undefined) {
    return { config: undefined, configPresent: false };
  }
  try {
    return { config: loadConfigFromFile(configPath, env), configPresent: true };
  } catch (error) {
    if (error instanceof GatewayError) {
      return { config: undefined, configPresent: false };
    }
    throw error;
  }
}

// Builds the live-payload redactor from the configured redaction settings + env. No new regex: this
// reuses `createAuditRedactor` (escaped literals + audited gateway patterns) wrapped by
// `deepRedactStrings` so every string leaf of a serialized payload is scrubbed.
export function buildRedactor(env: EnvSource): Redactor {
  const redactString = createAuditRedactor({}, env);
  return (value: unknown): unknown => deepRedactStrings(value, redactString);
}

// The production ModelPort factory: a GatewayModelPort over a Gateway built from the resolved
// config (mirrors the CLI's `new GatewayModelPort(new Gateway(config))`). Returns undefined when no
// config was resolved so the run route answers 400 NO_MODEL rather than constructing a broken port.
function defaultModelPortFactory(config: GatewayConfig | undefined): ModelPortFactory {
  return (): ModelPort | undefined => {
    if (config === undefined) {
      return undefined;
    }
    return new GatewayModelPort(new Gateway(config));
  };
}

// Assembles the handler deps for the real `keiko ui` process, mirroring the CLI config/evidence
// wiring (loadConfigFromFile / resolveEvidenceDir / createNodeEvidenceStore).
export function buildUiHandlerDeps(options: BuildHandlerDepsOptions): UiHandlerDeps {
  const { config, configPresent } = resolveConfig(options.configPath, options.env);
  const store = createNodeEvidenceStore(resolveEvidenceDir(options.evidenceDir, options.env));
  return {
    config,
    configPresent,
    evidenceStore: store,
    env: options.env,
    redactor: buildRedactor(options.env),
    registry: options.registry ?? createRunRegistry(),
    modelPortFactory: options.modelPortFactory ?? defaultModelPortFactory(config),
  };
}
