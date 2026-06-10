// Wave 2 BFF handler dependencies (ADR-0011 D5/D8/D9). The Wave 1 skeleton's `UiServerDeps` carried
// only the static-serving + CSP + port fields; the JSON/SSE handlers additionally need the resolved
// gateway config (for the config inspector and for building a ModelPort), an evidence store, a live
// redactor, the process env, and the in-memory run registry. Every field here is OPTIONAL so the
// 3-arg `createUiServer({ staticRoot, csp, port })` form still compiles and the Wave 1 server tests
// pass unchanged; the handlers degrade gracefully (no config → 400 NO_MODEL on a run, null config on
// the inspector; no store → an empty evidence list).

import {
  createDefaultChatCapability,
  loadConfigFromFile,
  parseGatewayConfig,
  type EnvSource,
  type GatewayConfig,
} from "@oscharko-dev/keiko-model-gateway";
import { GatewayError, Gateway } from "@oscharko-dev/keiko-model-gateway";
import { GatewayModelPort } from "@oscharko-dev/keiko-harness";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { createAuditRedactor } from "@oscharko-dev/keiko-evidence";
import { resolveCostClass } from "@oscharko-dev/keiko-model-gateway";
import { writeSideFile } from "@oscharko-dev/keiko-evidence";
import { deepRedactStrings } from "@oscharko-dev/keiko-evidence";
import { keikoApiKeySecretValues } from "@oscharko-dev/keiko-security";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { createNodeEvidenceStore, resolveEvidenceDir } from "@oscharko-dev/keiko-evidence";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { dirname, join } from "node:path";
import type { RunRegistry } from "./runs.js";
import { createRunRegistry } from "./runs.js";
import {
  buildUiStoreOverDatabase,
  openNodeUiDatabase,
  resolveUiDbPath,
  type UiStore,
} from "./store/index.js";
import { createTerminalExecutionManager, type TerminalExecutionManager } from "./terminal.js";
import { createBrowserSessionManager, type BrowserSessionManager } from "@oscharko-dev/keiko-tools";
import { type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import { createBffMemoryVault } from "./memory-handlers.js";
import { createMemoryAuditHandler } from "./memory-audit-handler.js";
import {
  createConsolidationJobRegistry,
  type ConsolidationJobRegistry,
} from "./memory-consolidation-registry.js";
import type {
  OpenAIEmbeddingOutcome,
  OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import {
  createRelationshipStorePort,
  type RelationshipHandlerDeps,
} from "./relationship-handlers.js";
import {
  resolveGroundingLimits,
  type GroundingLimits,
} from "@oscharko-dev/keiko-contracts/bff-wire";

// A redactor applied to every LIVE (non-manifest) payload before it reaches the browser (D9). It is
// `deepRedactStrings` composed with the audit redactor; reused, never a new regex.
export type Redactor = (value: unknown) => unknown;

// Builds a ModelPort for a run. The default builds a `GatewayModelPort` from the resolved config
// (mirroring the CLI); tests inject a deterministic fake so runs are offline. Throws/returns when no
// model can be built so the run route maps it to a 400 NO_MODEL — the BFF never calls a model
// directly, only through the harness/workflow entry points the port feeds.
export type ModelPortFactory = (modelId: string) => ModelPort | undefined;
type GatewayEgressConfig = NonNullable<GatewayConfig["egress"]>;

export interface RuntimeGatewayConfig {
  readonly storagePath: string;
  current(): GatewayConfig | undefined;
  present(): boolean;
  set(config: GatewayConfig | undefined, present: boolean): void;
}

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
  // Exact secret literals used by evidence persistence in addition to gateway redaction patterns.
  readonly redactionSecrets?: readonly string[] | undefined;
  // UI-local persistence (ADR-0013). Holds projects, chats, and chat messages. Tests inject the
  // in-memory store via createInMemoryUiStore; production wiring resolves a node:sqlite file path.
  readonly store: UiStore;
  // Resolved UI database file path when known. Project onboarding uses this to prevent the UI DB
  // and selected repositories from overlapping on disk.
  readonly uiDbPath?: string | undefined;
  // ADR-0018 — bounded permitted-command execution manager. Optional for legacy tests; production
  // wiring creates one per BFF and injects the UI store for the projectId → workspaceRoot lookup.
  readonly terminal?: TerminalExecutionManager | undefined;
  // ADR-0017 — browser tool session manager (BYO Chrome over CDP). Optional so existing tests
  // that do not exercise /api/browser/* keep their fixtures unchanged.
  readonly browser?: BrowserSessionManager | undefined;
  // Issue #211 — Memory Center vault. Optional so legacy tests that do not exercise /api/memory/*
  // keep their fixtures unchanged. Production wiring creates one at buildUiHandlerDeps time.
  readonly memoryVault?: MemoryVaultStore | undefined;
  // Issue #208 — explicit, bounded in-memory consolidation job registry for Memory Center polling.
  readonly consolidationJobs?: ConsolidationJobRegistry | undefined;
  // Runtime gateway config supports first-run UI onboarding. It starts from the CLI/env/local config
  // and can be updated after a successful credential test without restarting the loopback server.
  readonly gatewayConfig?: RuntimeGatewayConfig | undefined;
  // Test seam for first-run setup. Production uses the real OpenAI-compatible gateway call.
  readonly gatewaySetupTester?:
    | ((config: GatewayConfig, candidateModelIds: readonly string[]) => Promise<readonly string[]>)
    | undefined;
  // Test seam for model discovery. Production calls the OpenAI-compatible /models endpoint.
  readonly gatewayModelDiscovery?:
    | ((
        baseUrl: string,
        apiKey: string,
        apiKeyHeaderName?: string,
        egress?: GatewayEgressConfig,
      ) => Promise<readonly string[]>)
    | undefined;
  // Issue #198 audit seam: lets local-knowledge route tests stub embedding requests without
  // touching global fetch. Production leaves this undefined and uses requestOpenAIEmbedding.
  readonly localKnowledgeEmbeddingRequest?:
    | ((request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome>)
    | undefined;
  // Issue #539 (Epic #532) — relationship engine handler deps. Optional so legacy tests
  // that do not exercise /api/relationships/* keep their fixtures unchanged. Production
  // wiring composes a sqlite-backed RelationshipStore inside buildUiHandlerDeps.
  readonly relationship?: RelationshipHandlerDeps | undefined;
  // Resolved evidence directory path (same precedence as the CLI: explicit → KEIKO_EVIDENCE_DIR →
  // default). Consumed by QI read routes that pass evidenceDir to listQualityIntelligenceRuns /
  // loadQualityIntelligenceRun (which require either options.store or options.evidenceDir).
  readonly evidenceDir?: string | undefined;
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
  // UI-local SQLite DB path (`keiko ui --ui-db`); resolved via UI-store precedence (explicit →
  // KEIKO_UI_DATA_DIR → homedir/.keiko/keiko-ui.db). Mirrors evidenceDir's shape.
  readonly uiDbPath?: string | undefined;
  // Optional injected UiStore (tests); a node store opened at the resolved path is built otherwise.
  readonly store?: UiStore | undefined;
  // Optional setup tester (tests); production performs a real gateway call.
  readonly gatewaySetupTester?:
    | ((config: GatewayConfig, candidateModelIds: readonly string[]) => Promise<readonly string[]>)
    | undefined;
  // Optional setup discovery seam (tests); production calls the model-list endpoint.
  readonly gatewayModelDiscovery?:
    | ((
        baseUrl: string,
        apiKey: string,
        apiKeyHeaderName?: string,
        egress?: GatewayEgressConfig,
      ) => Promise<readonly string[]>)
    | undefined;
}

function envModelToken(modelId: string): string {
  return modelId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

function envModelIdFromApiKeyName(name: string): string | undefined {
  const prefix = "KEIKO_MODEL_";
  const suffix = "_API_KEY";
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) {
    return undefined;
  }
  const token = name.slice(prefix.length, -suffix.length);
  return token.length === 0 ? undefined : token.toLowerCase().replace(/_/g, "-");
}

function hasEnvProvider(modelId: string, env: EnvSource): boolean {
  const token = envModelToken(modelId);
  const baseUrl = env[`KEIKO_MODEL_${token}_BASE_URL`];
  const apiKey = env[`KEIKO_MODEL_${token}_API_KEY`];
  return baseUrl !== undefined && baseUrl.length > 0 && apiKey !== undefined && apiKey.length > 0;
}

function envModelIds(env: EnvSource): readonly string[] {
  const modelIds: string[] = [];
  for (const key of Object.keys(env)) {
    const modelId = envModelIdFromApiKeyName(key);
    if (modelId !== undefined && hasEnvProvider(modelId, env)) {
      modelIds.push(modelId);
    }
  }
  return Array.from(new Set(modelIds));
}

function resolveEnvOnlyConfig(env: EnvSource): GatewayConfig | undefined {
  const providers = envModelIds(env).map((modelId) => ({
    modelId,
    baseUrl: "",
    apiKey: "",
    capability: createDefaultChatCapability(modelId),
  }));
  if (providers.length === 0) {
    return undefined;
  }
  try {
    return parseGatewayConfig({ providers }, env);
  } catch (error) {
    if (error instanceof GatewayError) {
      return undefined;
    }
    throw error;
  }
}

function localGatewayConfigPath(uiDbPath: string): string {
  return join(dirname(uiDbPath), "keiko.config.json");
}

// Loads the config without leaking the path or any secret on failure: a missing/invalid config file
// falls back to KEIKO_MODEL_* env wiring when present, otherwise it is a normal "no config" state.
function resolveConfig(
  configPath: string | undefined,
  env: EnvSource,
  localConfigPath: string,
): { config: GatewayConfig | undefined; configPresent: boolean } {
  if (configPath === undefined) {
    let config: GatewayConfig | undefined;
    try {
      config = loadConfigFromFile(localConfigPath, env);
    } catch (error) {
      if (error instanceof GatewayError) {
        config = resolveEnvOnlyConfig(env);
      } else {
        throw error;
      }
    }
    return { config, configPresent: config !== undefined };
  }
  try {
    return { config: loadConfigFromFile(configPath, env), configPresent: true };
  } catch (error) {
    if (error instanceof GatewayError) {
      const config = resolveEnvOnlyConfig(env);
      return { config, configPresent: config !== undefined };
    }
    throw error;
  }
}

function createRuntimeGatewayConfig(
  initial: GatewayConfig | undefined,
  initialPresent: boolean,
  storagePath: string,
): RuntimeGatewayConfig {
  let config = initial;
  let present = initialPresent;
  return {
    storagePath,
    current: (): GatewayConfig | undefined => config,
    present: (): boolean => present,
    set(next: GatewayConfig | undefined, nextPresent: boolean): void {
      config = next;
      present = nextPresent;
    },
  };
}

export function currentGatewayConfig(deps: UiHandlerDeps): GatewayConfig | undefined {
  return deps.gatewayConfig?.current() ?? deps.config;
}

export function currentGatewayConfigPresent(deps: UiHandlerDeps): boolean {
  return deps.gatewayConfig?.present() ?? deps.configPresent;
}

function parseEnvOnlyEgressConfig(env: EnvSource): GatewayEgressConfig | undefined {
  try {
    return parseGatewayConfig(
      {
        providers: [
          {
            modelId: "keiko-egress-probe",
            baseUrl: "http://127.0.0.1",
            apiKey: "keiko-egress-probe-key",
          },
        ],
      },
      env,
    ).egress;
  } catch (error) {
    if (error instanceof GatewayError) {
      return undefined;
    }
    throw error;
  }
}

export function currentGatewayEgressConfig(
  deps: Pick<UiHandlerDeps, "config" | "gatewayConfig" | "env">,
): GatewayEgressConfig | undefined {
  return (
    deps.gatewayConfig?.current()?.egress ??
    deps.config?.egress ??
    parseEnvOnlyEgressConfig(deps.env)
  );
}

// Module-level: read KEIKO_GROUNDING_* env overrides ONCE at load (mirrors KEIKO_MODEL_* env
// reads). Each value is parsed as a positive integer; unparseable values are silently ignored so
// misconfigured env does not prevent the server from starting.
function parseEnvPositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

const ENV_GROUNDING_OVERRIDES: Partial<GroundingLimits> = ((): Partial<GroundingLimits> => {
  const env = process.env;
  const partial: { -readonly [K in keyof GroundingLimits]?: GroundingLimits[K] } = {};
  const maxConnectedSources = parseEnvPositiveInt(env.KEIKO_GROUNDING_MAX_CONNECTED_SOURCES);
  if (maxConnectedSources !== undefined) partial.maxConnectedSources = maxConnectedSources;
  const maxLocalKnowledgeSources = parseEnvPositiveInt(
    env.KEIKO_GROUNDING_MAX_LOCAL_KNOWLEDGE_SOURCES,
  );
  if (maxLocalKnowledgeSources !== undefined)
    partial.maxLocalKnowledgeSources = maxLocalKnowledgeSources;
  const maxPromptReferences = parseEnvPositiveInt(env.KEIKO_GROUNDING_MAX_PROMPT_REFERENCES);
  if (maxPromptReferences !== undefined) partial.maxPromptReferences = maxPromptReferences;
  const maxExcerptChars = parseEnvPositiveInt(env.KEIKO_GROUNDING_MAX_EXCERPT_CHARS);
  if (maxExcerptChars !== undefined) partial.maxExcerptChars = maxExcerptChars;
  const referenceBudget = parseEnvPositiveInt(env.KEIKO_GROUNDING_REFERENCE_BUDGET);
  if (referenceBudget !== undefined) partial.referenceBudget = referenceBudget;
  const hybridMaxCandidates = parseEnvPositiveInt(env.KEIKO_GROUNDING_HYBRID_MAX_CANDIDATES);
  if (hybridMaxCandidates !== undefined) partial.hybridMaxCandidates = hybridMaxCandidates;
  const hybridMaxExcerptBytes = parseEnvPositiveInt(env.KEIKO_GROUNDING_HYBRID_MAX_EXCERPT_BYTES);
  if (hybridMaxExcerptBytes !== undefined) partial.hybridMaxExcerptBytes = hybridMaxExcerptBytes;
  return partial;
})();

// Resolves the effective grounding limits at call time: file config → env overrides → ceilings.
// Env overrides win over file config. Re-reads currentGatewayConfig each call so runtime config
// updates (e.g. first-run UI onboarding) are honored immediately. Never stored as a frozen field.
export function currentGroundingLimits(deps: UiHandlerDeps): GroundingLimits {
  const fileGrounding = currentGatewayConfig(deps)?.grounding;
  return resolveGroundingLimits({ ...fileGrounding, ...ENV_GROUNDING_OVERRIDES });
}

// Re-export GroundingLimits so callers (read-handlers, store-handlers) only need one import.
export type { GroundingLimits };

function configSecretValues(config: GatewayConfig | undefined): readonly string[] {
  // Epic #177 audit: include both `apiKey` and `baseUrl` so error-message and evidence
  // redaction can scrub the provider URL the user (or the provider's response) might echo
  // back. `baseUrl` is not a credential per se, but pairing it with the apiKey reveals the
  // backend topology and gives an attacker a place to direct probes; the matrix's security
  // section claims both shapes are scrubbed at the BFF boundary.
  if (config === undefined) return [];
  const out: string[] = [];
  const addEgressTopology = (egress: GatewayConfig["egress"]): void => {
    if (egress === undefined) return;
    if (egress.httpProxy !== undefined) out.push(egress.httpProxy);
    if (egress.httpsProxy !== undefined) out.push(egress.httpsProxy);
    if (egress.caBundlePath !== undefined) out.push(egress.caBundlePath);
  };
  addEgressTopology(config.egress);
  for (const provider of config.providers) {
    out.push(provider.apiKey, provider.baseUrl);
    addEgressTopology(provider.egress);
  }
  return out;
}

function egressSecretValues(egress: GatewayConfig["egress"]): readonly string[] {
  if (egress === undefined) return [];
  return [egress.httpProxy, egress.httpsProxy, egress.caBundlePath].filter(
    (value): value is string => value !== undefined,
  );
}

function redactionSecrets(
  env: EnvSource,
  config: GatewayConfig | undefined,
  egress: GatewayConfig["egress"] = config?.egress,
): readonly string[] {
  return Array.from(
    new Set([
      ...keikoApiKeySecretValues(env),
      ...configSecretValues(config),
      ...egressSecretValues(egress),
    ]),
  );
}

function runtimeRedactionSecrets(
  env: EnvSource,
  runtimeConfig: RuntimeGatewayConfig,
): readonly string[] {
  const config = runtimeConfig.current();
  return redactionSecrets(env, config, config?.egress ?? parseEnvOnlyEgressConfig(env));
}

function runtimeRedactString(
  env: EnvSource,
  runtimeConfig: RuntimeGatewayConfig,
): (value: string) => string {
  return (value: string): string =>
    createAuditRedactor(
      { additionalSecrets: runtimeRedactionSecrets(env, runtimeConfig) },
      env,
    )(value);
}

// Builds the live-payload redactor from the configured redaction settings + env. No new regex: this
// reuses `createAuditRedactor` (escaped literals + audited gateway patterns) wrapped by
// `deepRedactStrings` so every string leaf of a serialized payload is scrubbed.
export function buildRedactor(env: EnvSource, config?: GatewayConfig): Redactor {
  const redactString = createAuditRedactor(
    {
      additionalSecrets: redactionSecrets(
        env,
        config,
        config?.egress ?? parseEnvOnlyEgressConfig(env),
      ),
    },
    env,
  );
  return (value: unknown): unknown => deepRedactStrings(value, redactString);
}

export function currentRedactionSecrets(deps: UiHandlerDeps): readonly string[] {
  return redactionSecrets(deps.env, currentGatewayConfig(deps), currentGatewayEgressConfig(deps));
}

// The production ModelPort factory: a GatewayModelPort over a Gateway built from the resolved
// config (mirrors the CLI's `new GatewayModelPort(new Gateway(config))`). Returns undefined when no
// config was resolved so the run route answers 400 NO_MODEL rather than constructing a broken port.
function defaultModelPortFactory(runtimeConfig: RuntimeGatewayConfig): ModelPortFactory {
  return (): ModelPort | undefined => {
    const config = runtimeConfig.current();
    if (config === undefined) {
      return undefined;
    }
    return new GatewayModelPort(new Gateway(config));
  };
}

function buildTerminalManager(options: {
  readonly store: UiStore;
  readonly evidenceStore: EvidenceStore;
  readonly env: EnvSource;
  readonly liveRedactor: Redactor;
}): TerminalExecutionManager {
  return createTerminalExecutionManager({
    store: options.store,
    evidenceStore: options.evidenceStore,
    processEnv: options.env,
    redactor: (value: string): string => {
      const redacted = options.liveRedactor(value);
      return typeof redacted === "string" ? redacted : value;
    },
  });
}

// ADR-0019 direction rule 3c: the tools package cannot import src/audit. The BFF injects the
// cost-class resolver and a side-file writer that closes over the resolved evidenceDir + the
// nodeWorkspaceFs realpath-containment port, so the browser session manager stays self-contained
// against contracts + security + workspace only.
function buildBrowserManager(options: {
  readonly evidenceDir: string;
  readonly evidenceStore: EvidenceStore;
  readonly redactor: Redactor;
}): BrowserSessionManager {
  return createBrowserSessionManager({
    evidenceDir: options.evidenceDir,
    evidenceStore: options.evidenceStore,
    redactor: options.redactor,
    costClassResolver: resolveCostClass,
    sideFileWriter: (basename, bytes, runId) =>
      writeSideFile(options.evidenceDir, runId, basename, bytes, { fs: nodeWorkspaceFs }),
  });
}

function buildMemoryVault(
  redactString: (value: string) => string,
  evidenceStore: EvidenceStore,
  env: EnvSource,
): MemoryVaultStore {
  return createBffMemoryVault(
    redactString,
    // #214 — wire every successful vault mutation into the audit ledger. The handler
    // shares the same redactString closure as the live-payload redactor so audit
    // summaries inherit the same secret-shape scrubbing as wire traffic.
    createMemoryAuditHandler({ evidenceStore, redactString }),
    env,
  );
}

// Issue #539: the relationship engine runs server-authoritative scope checks on every route.
// In the loopback `keiko ui` BFF there is exactly one workspace per process; the resolver
// returns that workspace identifier from `KEIKO_WORKSPACE_ID` (set), or a stable default
// otherwise. The constant matches the empty-but-non-zero-length contract of `scope()` so
// every route resolves a workspaceId instead of returning 403.
const DEFAULT_LOOPBACK_WORKSPACE_ID = "local";

function resolveLoopbackWorkspaceId(env: EnvSource): string {
  const explicit = env.KEIKO_WORKSPACE_ID;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  return DEFAULT_LOOPBACK_WORKSPACE_ID;
}

// When no UiStore is injected, open one DatabaseSync against the resolved UI-DB and share it
// with the relationship-engine store so V5 sibling tables share the UI-store transaction model
// (issue #539, storage.md §3.1). When tests inject a UiStore we leave `relationship` undefined;
// relationship-engine tests inject their own deps.
function composePersistence(
  injected: UiStore | undefined,
  resolvedUiDbPath: string,
  redactString: (value: string) => string,
  env: EnvSource,
): { readonly store: UiStore; readonly relationship: RelationshipHandlerDeps | undefined } {
  if (injected !== undefined) return { store: injected, relationship: undefined };
  const db = openNodeUiDatabase(resolvedUiDbPath);
  const store = buildUiStoreOverDatabase(db, { redactString });
  const relationship: RelationshipHandlerDeps = {
    scopeResolver: (): { readonly workspaceId: string } => ({
      workspaceId: resolveLoopbackWorkspaceId(env),
    }),
    store: createRelationshipStorePort({ db, redactString }),
  };
  return { store, relationship };
}

interface PeripheralManagers {
  readonly terminal: TerminalExecutionManager;
  readonly browser: BrowserSessionManager;
  readonly memoryVault: MemoryVaultStore;
}

function buildPeripherals(
  options: BuildHandlerDepsOptions,
  uiStore: UiStore,
  evidenceStore: EvidenceStore,
  redactString: (value: string) => string,
  liveRedactor: Redactor,
): PeripheralManagers {
  return {
    terminal: buildTerminalManager({
      store: uiStore,
      evidenceStore,
      env: options.env,
      liveRedactor,
    }),
    browser: buildBrowserManager({
      evidenceDir: resolveEvidenceDir(options.evidenceDir, options.env),
      evidenceStore,
      redactor: liveRedactor,
    }),
    memoryVault: buildMemoryVault(redactString, evidenceStore, options.env),
  };
}

// Assembles the handler deps for the real `keiko ui` process, mirroring the CLI config/evidence
// wiring (loadConfigFromFile / resolveEvidenceDir / createNodeEvidenceStore). The UI store is
// created at the resolved UI-DB path (explicit → KEIKO_UI_DATA_DIR → ~/.keiko/keiko-ui.db) unless
// an injected store is supplied (tests).
export function buildUiHandlerDeps(options: BuildHandlerDepsOptions): UiHandlerDeps {
  const resolvedUiDbPath = resolveUiDbPath(options.uiDbPath, options.env);
  const runtimeConfigPath = localGatewayConfigPath(resolvedUiDbPath);
  const { config, configPresent } = resolveConfig(
    options.configPath,
    options.env,
    runtimeConfigPath,
  );
  const runtimeConfig = createRuntimeGatewayConfig(config, configPresent, runtimeConfigPath);
  const evidenceStore = createNodeEvidenceStore(
    resolveEvidenceDir(options.evidenceDir, options.env),
  );
  const redactString = runtimeRedactString(options.env, runtimeConfig);
  const liveRedactor = (value: unknown): unknown => deepRedactStrings(value, redactString);
  const { store: uiStore, relationship } = composePersistence(
    options.store,
    resolvedUiDbPath,
    redactString,
    options.env,
  );
  const peripherals = buildPeripherals(options, uiStore, evidenceStore, redactString, liveRedactor);
  return {
    config,
    configPresent,
    evidenceStore,
    evidenceDir: resolveEvidenceDir(options.evidenceDir, options.env),
    env: options.env,
    redactor: liveRedactor,
    registry: options.registry ?? createRunRegistry(),
    modelPortFactory: options.modelPortFactory ?? defaultModelPortFactory(runtimeConfig),
    redactionSecrets: runtimeRedactionSecrets(options.env, runtimeConfig),
    store: uiStore,
    uiDbPath: resolvedUiDbPath,
    gatewayConfig: runtimeConfig,
    gatewaySetupTester: options.gatewaySetupTester,
    gatewayModelDiscovery: options.gatewayModelDiscovery,
    ...peripherals,
    consolidationJobs: createConsolidationJobRegistry(),
    ...(relationship === undefined ? {} : { relationship }),
  };
}
