// Shared, hermetic test support for the Epic #2238 cross-connector adversarial suites (Issue
// #2246). This module holds NO test cases (the `*.integration.test.ts` files own those); it is the
// one place the connector-lane server harness, the runtime-built redaction marker, the transport
// degradation-condition helpers, and the Authority Envelope builder are defined so the seven
// cross-cutting suites share one recipe instead of each re-deriving it.
//
// Hermetic by construction: every server harness runs against a fresh temp SQLite store, an
// in-memory embedding stub, and injected registries reset around every test — no network, no port
// dependence, no wall-clock races (`awaitJobTerminal` condition-awaits, it never sleeps).

import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { vi } from "vitest";
import {
  createAtlassianCredentialCustody,
  type AtlassianCredentialCustody,
  type AtlassianCredentialMetadata,
  type AtlassianHttpBodyPort,
  type AtlassianHttpBodyResult,
  type AtlassianHttpPort,
  type AtlassianHttpResult,
} from "@oscharko-dev/keiko-connectors";
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_SCHEMA_VERSION,
  type AtlassianConnectorProvider,
  type AtlassianSyncJobState,
  type CodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchConnectorScope,
  type CodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts";
import type {
  GatewayConfig,
  OpenAIEmbeddingOutcome,
  OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import { buildRedactor, type UiHandlerDeps } from "../../packages/keiko-server/src/deps.js";
import { createRunRegistry } from "../../packages/keiko-server/src/runs.js";
import { createInMemoryUiStore } from "../../packages/keiko-server/src/store/index.js";
import type { ServerDiagnosticRecord } from "../../packages/keiko-server/src/diagnostics-log.js";
import {
  editorAgentAuthorityRegistry,
  editorAgentWorkspaceRootDigest,
} from "../../packages/keiko-server/src/editor/agentAuthorityRegistry.js";
import { atlassianSyncJobRegistry } from "../../packages/keiko-server/src/atlassian/syncService.js";
import { atlassianActionApprovalRegistry } from "../../packages/keiko-server/src/atlassian/actionApprovals.js";
import type { AtlassianConnectorCredentialDeps } from "../../packages/keiko-server/src/atlassian/credentialRoutes.js";

export const CONNECTOR_BASE_URL = "https://tenant.example";
export const CONNECTOR_WORKSPACE_ROOT = "/repo";

// ─── Runtime-built redaction marker (Issue #2246 Scope 1) ─────────────────────
// Entropy-shaped and assembled at runtime from `randomBytes`, so there is no committed literal for
// a CI secret scanner to flag, and deliberately NOT an Atlassian `ATATT…`/`ghp_…` shape so no
// credential-format detector fires. Long and random enough to be a meaningful unique sentinel: if
// any artifact echoes it, the sweep catches it. Passes `isSafeAtlassianApiToken`
// (printable ASCII, 8..1024 chars) so custody accepts it as a real token.
export interface RedactionMarker {
  readonly token: string;
  readonly email: string;
  readonly jql: string;
}

export function buildRedactionMarker(): RedactionMarker {
  const entropy = randomBytes(24).toString("hex");
  return {
    token: ["kmk", entropy, "sentinel"].join("-"),
    email: [`redaction-${entropy.slice(0, 8)}`, "@", "example", ".", "test"].join(""),
    jql: `text ~ "kmk${entropy.slice(0, 12)}marker"`,
  };
}

// ─── Transport degradation conditions (Issue #2246 Scope 4) ───────────────────
export type DegradationCondition = "401" | "403" | "404" | "429" | "5xx" | "timeout" | "network";

export const DEGRADATION_CONDITIONS: readonly DegradationCondition[] = [
  "401",
  "403",
  "404",
  "429",
  "5xx",
  "timeout",
  "network",
];

export function conditionResult(condition: DegradationCondition): AtlassianHttpBodyResult {
  if (condition === "timeout") return { kind: "timeout" };
  if (condition === "network") return { kind: "network-error" };
  const status = condition === "5xx" ? 503 : Number(condition);
  const bodyText = JSON.stringify({ status });
  return {
    kind: "response",
    status,
    bodyText,
    bodyBytes: new TextEncoder().encode(bodyText).length,
    truncated: false,
  };
}

// A body port that answers EVERY request with the same degradation condition, plus a call log so a
// suite can assert how many outbound requests were attempted.
export function conditionBodyPort(condition: DegradationCondition): AtlassianHttpBodyPort & {
  readonly calls: string[];
} {
  const calls: string[] = [];
  const port = (request: { readonly url: string }): Promise<AtlassianHttpBodyResult> => {
    calls.push(request.url);
    return Promise.resolve(conditionResult(condition));
  };
  return Object.assign(port as AtlassianHttpBodyPort, { calls });
}

// Injected backoff sleep for the retrying transport wrapper: a recorded no-op so 429/5xx backoff
// never spends real wall-clock in a test (determinism; no sleeps).
export function noopSleep(): Promise<void> {
  return Promise.resolve();
}

// ─── In-memory credential custody (suites that do not exercise real crypto) ────
export interface InMemoryCustody {
  readonly custody: AtlassianCredentialCustody;
  readonly credential: AtlassianCredentialMetadata;
  readonly vault: Map<string, string>;
}

export function createInMemoryCustody(
  provider: AtlassianConnectorProvider,
  marker: RedactionMarker,
): InMemoryCustody {
  const vault = new Map<string, string>();
  const metadata = new Map<string, AtlassianCredentialMetadata>();
  const { custody } = createAtlassianCredentialCustody({
    vault: {
      get: (key): string | undefined => vault.get(key),
      set: (key, secret): void => void vault.set(key, secret),
      delete: (key): void => void vault.delete(key),
    },
    metadataStore: {
      insert: (entry): void => void metadata.set(entry.authRef, entry),
      get: (authRef): AtlassianCredentialMetadata | undefined => metadata.get(authRef),
      list: (): readonly AtlassianCredentialMetadata[] => [...metadata.values()],
      delete: (authRef): boolean => metadata.delete(authRef),
    },
  });
  const credential = custody.create({
    provider,
    displayName: provider === "confluence" ? "Team Wiki" : "Team Tracker",
    baseUrl: CONNECTOR_BASE_URL,
    authScheme: "basic-api-token",
    accountEmail: marker.email,
    apiToken: marker.token,
  });
  return { custody, credential, vault };
}

// ─── Server harness ─────────────────────────────────────────────────────────
// The full UiHandlerDeps a connector route needs to run a real sync/write flow: a fresh temp
// SQLite store (knowledge store lives under `dirname(uiDbPath)`), a deterministic embedding stub,
// and a diagnostics sink the redaction sweep scans. Ported from the proven
// `syncRoutes.policy.test.ts` recipe so it is exercised the same way the per-child tests exercise
// the routes.
export interface ConnectorServerHarness {
  readonly deps: UiHandlerDeps;
  readonly diagnostics: ServerDiagnosticRecord[];
  readonly tmp: string;
  readonly cleanup: () => void;
}

function gatewayConfig(): GatewayConfig {
  return {
    providers: [
      {
        modelId: "text-embedding-3-small",
        baseUrl: "https://gateway.example.test/v1",
        apiKey: "redacted",
        timeoutMs: 30_000,
        maxRetries: 1,
        retryBaseDelayMs: 100,
      },
    ],
    circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000, halfOpenProbes: 1 },
  };
}

function embeddingStub(): (request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome> {
  return vi.fn((request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> =>
    Promise.resolve({
      ok: true,
      value: { vector: new Float32Array(1536).fill(1), modelId: request.modelId },
    }),
  );
}

export interface ConnectorServerHarnessOptions {
  readonly mode?: CodingWorkbenchMode | undefined;
  readonly tmpPrefix?: string | undefined;
}

export function createConnectorServerHarness(
  atlassian: AtlassianConnectorCredentialDeps | ((tmp: string) => AtlassianConnectorCredentialDeps),
  options: ConnectorServerHarnessOptions = {},
): ConnectorServerHarness {
  const tmp = mkdtempSync(join(realpathSync(tmpdir()), options.tmpPrefix ?? "keiko-atl-2246-"));
  const resolvedAtlassian = typeof atlassian === "function" ? atlassian(tmp) : atlassian;
  const diagnostics: ServerDiagnosticRecord[] = [];
  const deps = {
    config: gatewayConfig(),
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    diagnostics: {
      record: (record: ServerDiagnosticRecord): void => void diagnostics.push(record),
    },
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    uiDbPath: join(tmp, "keiko-ui.db"),
    localKnowledgeEmbeddingRequest: embeddingStub(),
    autonomousDeliveryDeploymentCeiling: options.mode ?? "autonomous-delivery",
    atlassianConnectorCredentials: resolvedAtlassian,
  } as unknown as UiHandlerDeps;
  return {
    deps,
    diagnostics,
    tmp,
    cleanup: (): void => {
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

// A minimal fixture `AtlassianConnectorCredentialDeps` backed by in-memory custody plus caller
// body/verify ports — the shape suites use when they do not need real crypto.
export function fixtureCredentialDeps(
  custody: AtlassianCredentialCustody,
  httpBodyPort: AtlassianHttpBodyPort,
): AtlassianConnectorCredentialDeps {
  return {
    custody,
    httpPortFactory: (): AtlassianHttpPort => (): Promise<AtlassianHttpResult> =>
      Promise.resolve({ kind: "response", status: 200 }),
    httpBodyPortFactory: () => httpBodyPort,
  };
}

// ─── Authority Envelope ───────────────────────────────────────────────────────
// The mode-independent envelope fields, factored out so the builder stays small.
const ENVELOPE_STATIC: Omit<
  CodingWorkbenchAuthorityEnvelope,
  "requestedMode" | "deploymentCeiling" | "effectiveMode" | "connectorScopes"
> = {
  schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
  runId: "run-2246",
  localUser: "local-operator",
  taskRefs: ["issue-2246"],
  workspace: {
    workspaceId: "workspace-1",
    rootLabel: "workspace",
    rootDigest: editorAgentWorkspaceRootDigest(CONNECTOR_WORKSPACE_ROOT),
  },
  branch: {
    baseRef: "dev",
    headRef: "local-workspace",
    allowDetachedHead: false,
    allowedPrefixes: ["local-"],
  },
  runtimeSource: "keiko-sidecar",
  actionClasses: CODING_WORKBENCH_ACTION_CLASSES,
  modelProfile: {
    profileId: "profile-1",
    source: "keiko-model-gateway",
    supportsStreaming: true,
    supportsToolCalling: true,
  },
  commandPolicy: {
    mode: "governed",
    allow: [],
    deny: [],
    maxCommandTimeoutMs: 60_000,
    requirePerCommandApproval: false,
  },
  networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
  gates: ["human-approval", "branch-allowlist"],
  budget: {
    maxRuntimeMs: 3_600_000,
    maxToolCalls: 50,
    maxPromptTokens: 10_000,
    maxPatchBytes: 65_536,
  },
  expiresAt: "2099-01-01T00:00:00.000Z",
  approvalProofDigest: "a".repeat(64),
};

export function connectorEnvelope(
  mode: CodingWorkbenchMode,
  connectorScopes: readonly CodingWorkbenchConnectorScope[],
  over: Partial<CodingWorkbenchAuthorityEnvelope> = {},
): CodingWorkbenchAuthorityEnvelope {
  return {
    ...ENVELOPE_STATIC,
    requestedMode: mode,
    deploymentCeiling: mode,
    effectiveMode: mode,
    connectorScopes,
    ...over,
  };
}

export interface ConnectorAuthorityContext {
  readonly runId: string;
  readonly envelopeDigest: string;
  readonly workspaceRoot: string;
}

export function registerConnectorEnvelope(
  mode: CodingWorkbenchMode,
  connectorScopes: readonly CodingWorkbenchConnectorScope[],
  over: Partial<CodingWorkbenchAuthorityEnvelope> = {},
  registeredAtIso: string = new Date().toISOString(),
): ConnectorAuthorityContext {
  const registration = editorAgentAuthorityRegistry.register(
    connectorEnvelope(mode, connectorScopes, over),
    mode,
    registeredAtIso,
  );
  if (!registration.ok)
    throw new Error(`test envelope registration failed: ${registration.reason}`);
  return { ...registration.authorityRef, workspaceRoot: CONNECTOR_WORKSPACE_ROOT };
}

// ─── Route request plumbing ───────────────────────────────────────────────────
export function jsonRequest(body: Record<string, unknown>): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage;
  req.method = "POST";
  req.headers = { "content-type": "application/json", "x-keiko-csrf": "1" };
  return req;
}

export interface RouteContextLike {
  readonly req: IncomingMessage;
  readonly res: unknown;
  readonly params: Record<string, string>;
  readonly url: URL;
}

// A RouteContext-shaped object the atlassian handlers accept (they read `req`, `params`, `url`).
export function routeCtx(
  params: Record<string, string>,
  body: Record<string, unknown>,
): RouteContextLike {
  return {
    req: jsonRequest(body),
    res: {},
    params,
    url: new URL("http://127.0.0.1/api/atlassian-connectors"),
  };
}

export function resetConnectorRegistries(): void {
  editorAgentAuthorityRegistry.reset();
  atlassianSyncJobRegistry.reset();
  atlassianActionApprovalRegistry.reset();
}

const TERMINAL_STATUSES: readonly string[] = ["succeeded", "partial", "failed", "cancelled"];

// Condition-await a sync job to its terminal state (never a sleep): the job runs in the background
// (`setImmediate`) and this polls the in-process registry until it settles.
export async function awaitJobTerminal(jobId: string): Promise<AtlassianSyncJobState> {
  await vi.waitFor(
    () => {
      const job = atlassianSyncJobRegistry.get(jobId);
      if (job === undefined || !TERMINAL_STATUSES.includes(job.state.status)) {
        throw new Error(`job ${jobId} not terminal`);
      }
    },
    { timeout: 10_000, interval: 5 },
  );
  const job = atlassianSyncJobRegistry.get(jobId);
  if (job === undefined) throw new Error("job vanished");
  return job.state;
}
