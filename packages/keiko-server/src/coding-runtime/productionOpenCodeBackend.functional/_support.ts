import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import type {
  CodingWorkbenchSidecarGatewayRunMetadata,
  WorkspaceInfo,
} from "@oscharko-dev/keiko-contracts";
import { CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES } from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";
import { EDITOR_AGENT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import {
  resolveCodingSafeSidecarGatewayProfile,
  toolCallingConfigurationFingerprint,
  type GatewayConfig,
  type GatewayRequest,
  type GatewayStreamChunk,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { applyPatch, inspectPatch } from "@oscharko-dev/keiko-tools";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

import { createOpenCodeGatewayReadinessRegistry } from "../../coding-sidecar-gateway.js";
import {
  RESEARCH_UNTRUSTED_BEGIN_FENCE,
  RESEARCH_UNTRUSTED_END_FENCE,
} from "../researchContentQuarantine.js";
import { createFakeSessionPairingPort } from "../../coding-app-session/_support.js";
import { SESSION_PAIRING_LAUNCHER_SECRET_ENV } from "../../coding-app-session/launcherSessionPairingPort.js";
import { buildUiHandlerDeps, type UiHandlerDeps } from "../../deps.js";
import {
  contentFreeErrorClass,
  emitServerDiagnostic,
  type ServerDiagnosticSink,
} from "../../diagnostics-log.js";
import type { VerificationRunnerManager } from "../../editor/verificationRunner.js";
import { editorAgentWorkspaceRootDigest } from "../../editor/agentAuthorityRegistry.js";
import type { WorkspaceLifecycleService } from "../../task-workspace/types.js";
import type { CodingRuntimeEvidenceAggregator } from "../codingRuntimeEvidenceAggregator.js";
import type {
  CodingRuntimeEditorMutationLeaseBroker,
  CodingRuntimeEditorMutationLeaseRequest,
} from "../codingRuntimeEditorMutationLeaseCoordinator.js";
import { createAuthenticatedSessionStartConfirmationPlane } from "../codingRuntimeStartConfirmationPlane.js";
import type { ProductionCodingRuntimeResolver } from "../productionCodingRuntimeHost.js";
import { createProductionCodingRuntimeResolver } from "../productionCodingRuntimeResolver.js";
import {
  createProductionOpenCodeBackend,
  type ProductionOpenCodeBackendInput,
  type ResolvedPortableOpenCodeRuntime,
} from "../productionOpenCodeBackend.js";
import type {
  ProductionCodingRuntimeResolverInput,
  ProductionRuntimeBackendInput,
} from "../productionCodingRuntimeResolver.js";
import type { SecureWorkspaceTextReadPort } from "../secureWorkspaceTextRead.js";
import {
  H1_PROOF_SEARCH_CALL_ID,
  repositorySearchReadHandoff,
  type RepositorySearchConsumptionProof,
} from "./repositorySearchProof.js";
import {
  FUNCTIONAL_REPOSITORY_SKILL_NAME,
  SKILL_DISCOVERY_PROOF_CALL_ID,
  skillInvocationHandoff,
  type SkillDiscoveryConsumptionProof,
} from "./skillDiscoveryProof.js";

const MAX_READ_BYTES = 65_536;
export const FUNCTIONAL_ACTIVITY_ASSISTANT_PREFIX = "VISIBLE_ASSISTANT_TEXT_2479:";
export const FUNCTIONAL_ACTIVITY_TRUNCATED_TAIL = "TRUNCATED_TAIL_2479";
export const FUNCTIONAL_PLAN_STEP_READ = "PLAN_STEP_READ_2480";
export const FUNCTIONAL_PLAN_STEP_VERIFY = "PLAN_STEP_VERIFY_2480";
/** The fixture file the native journeys read and edit with the runtime's own tools (#3897). */
const NATIVE_TARGET_PATH = "src/example.ts";

export interface ScriptState {
  mode:
    | "productive"
    | "productive-search"
    | "out-of-scope"
    | "discovery"
    | "research"
    | "lifecycle"
    | "lifecycle-continue"
    | "probe"
    | "index"
    | "sync"
    | "branch"
    | "websearch";
  calls: number;
  readonly old: string;
  readonly next: string;
  toolCallId?: string;
  /**
   * #2637: the visible directive the granted research page carries. Supplied by the e2e server
   * entry, which owns the fixture page, so this harness holds no injection payload of its own.
   */
  readonly injectionDirective?: string;
  /** Invoked with every scripted tool name so a journey can assert what the model REQUESTED. */
  readonly observeToolCall?: (name: string) => void;
  readonly observeRepositorySearch?: (proof: RepositorySearchConsumptionProof) => void;
  /** #3417: after its search-derived read, invoke the repository skill the runtime's own listing names. */
  readonly proveSkillDiscovery?: boolean;
  readonly observeSkillDiscovery?: (proof: SkillDiscoveryConsumptionProof) => void;
  /** Keeps a completed verification turn cancellable for browser journeys that prove Stop. */
  readonly holdAfterVerification?: boolean;
  /** The one shell command a `probe` turn runs through the runtime's own shell tool. */
  probeCommand?: string;
  verificationIssued?: boolean;
}

type FunctionalEditorAgentClient = ProductionCodingRuntimeResolverInput["editorAgentClient"];
type FunctionalEditorAction = Parameters<FunctionalEditorAgentClient["action"]>[0];
type FunctionalEditorActionResult = Awaited<ReturnType<FunctionalEditorAgentClient["action"]>>;

interface FunctionalRuntimeResolverBaseInput {
  /** Uses the same real Git/approval/snapshot bundle as production composition. */
  readonly verifiedCommit?: ProductionCodingRuntimeResolverInput["verifiedCommit"];
  readonly draftDelivery?: ProductionCodingRuntimeResolverInput["draftDelivery"];
  /** A composed fixture can invoke the admitted facade without inventing a model tool catalog. */
  readonly observeBackendRun?: (input: ProductionRuntimeBackendInput) => void;
  readonly portable: ResolvedPortableOpenCodeRuntime;
  readonly runtimeStateRoot: string;
  readonly gatewayUrl: string;
  readonly workspaceLifecycle: WorkspaceLifecycleService;
  readonly managedTaskWorkspaceRoot: string;
  readonly readWorkspaceHead: (workspaceRoot: string, repositoryRoot: string) => string | undefined;
  readonly verificationRunner: Pick<VerificationRunnerManager, "runToReport">;
  readonly runtimeEvidence: Pick<CodingRuntimeEvidenceAggregator, "observe">;
  /** Shares the resolver's per-run coordinators with the BFF editor commit boundary. */
  readonly runtimeMutationLeaseBroker?: CodingRuntimeEditorMutationLeaseBroker;
  readonly createSupervisor: NonNullable<ProductionOpenCodeBackendInput["createSupervisor"]>;
  readonly diagnostics?: ServerDiagnosticSink;
  /** Uses the same configured-profile qualification as the mounted gateway when supplied. */
  readonly resolveManagedModelProfile?: ProductionCodingRuntimeResolverInput["workspaceAuthority"]["resolveManagedModelProfile"];
  /** #2387: opens the network-egress class so the research approval loop is reachable. */
  readonly researchEgressEnabled?: boolean | undefined;
  /** #2387 hermetic research transport; tests never touch the real network. */
  readonly researchFetchImpl?: ProductionCodingRuntimeResolverInput["researchFetchImpl"];
  /**
   * #2387: the gateway's configured outbound transport. Research is offered only while one
   * resolves, as in production, so a journey that proves the research loop supplies it.
   */
  readonly gatewayEgress?: ProductionCodingRuntimeResolverInput["gatewayEgress"];
}

type FunctionalChildModelInput =
  | {
      readonly childModelPortFactory?: undefined;
      readonly childModelId?: undefined;
    }
  | {
      /** #2387 hermetic child model; production resolves the same model through the gateway. */
      readonly childModelPortFactory: NonNullable<
        ProductionCodingRuntimeResolverInput["childModelPortFactory"]
      >;
      /** Provider model id served by `childModelPortFactory`; both are required to mount the child. */
      readonly childModelId: string;
    };

export type FunctionalRuntimeResolverInput = FunctionalRuntimeResolverBaseInput &
  FunctionalChildModelInput;

export interface FunctionalChildModelCandidate {
  readonly childModelPortFactory?: unknown;
  readonly childModelId?: unknown;
}

type ResolvedFunctionalChildModelInput = Partial<
  Pick<ProductionCodingRuntimeResolverInput, "childModelPortFactory" | "childModelId">
>;

/** Enforces the child-model factory/id pair even for untyped JavaScript harness callers. */
export function resolveFunctionalChildModelInput(
  input: FunctionalChildModelCandidate,
): ResolvedFunctionalChildModelInput {
  const { childModelPortFactory, childModelId } = input;
  if (childModelPortFactory === undefined && childModelId === undefined) return {};
  if (!isChildModelPortFactory(childModelPortFactory) || !isChildModelId(childModelId)) {
    throw new Error("functional-child-model-configuration-incomplete");
  }
  return {
    childModelPortFactory,
    childModelId: (): string => childModelId,
  };
}

function isChildModelPortFactory(
  value: unknown,
): value is NonNullable<ProductionCodingRuntimeResolverInput["childModelPortFactory"]> {
  return typeof value === "function";
}

function isChildModelId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

/**
 * Composes the production OpenCode backend + resolver for the functional harness and attaches the
 * single gateway-readiness registry both to the backend (challenge wait side) and to the resolved
 * runtime (BFF claim side), so the readiness handshake is observed on one shared instance.
 */
export function createFunctionalRuntimeResolver(
  input: FunctionalRuntimeResolverInput,
): ProductionCodingRuntimeResolver {
  const readiness = createOpenCodeGatewayReadinessRegistry();
  const activeRoot = (): string | undefined =>
    input.workspaceLifecycle.getActive()?.binding.activeRoot;
  const resolver = createProductionCodingRuntimeResolver({
    workspaceAuthority: {
      workspaceLifecycle: input.workspaceLifecycle,
      managedTaskWorkspaceRoot: input.managedTaskWorkspaceRoot,
      deploymentCeiling: "autonomous-delivery",
      readWorkspaceHead: input.readWorkspaceHead,
      verifiedCommitResult: (runId) =>
        input.verifiedCommit?.snapshots.getLastSuccessfulVerifiedCommit?.(runId),
      resolveManagedModelProfile: input.resolveManagedModelProfile ?? functionalManagedModelProfile,
      researchEgressEnabled: input.researchEgressEnabled,
    },
    ...(input.researchFetchImpl ? { researchFetchImpl: input.researchFetchImpl } : {}),
    ...(input.gatewayEgress ? { gatewayEgress: input.gatewayEgress } : {}),
    ...resolveFunctionalChildModelInput(input),
    ...(input.verifiedCommit === undefined ? {} : { verifiedCommit: input.verifiedCommit }),
    ...(input.draftDelivery === undefined ? {} : { draftDelivery: input.draftDelivery }),
    backend: functionalBackend(input, readiness),
    ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
    secureWorkspaceTextRead: functionalWorkspaceRead(activeRoot, input.diagnostics),
    editorAgentClient: functionalEditorAgentClient(activeRoot, input.runtimeMutationLeaseBroker),
    verificationRunner: input.verificationRunner,
    resolveWorkspaceRootAccess: (requestedRoot) =>
      requestedRoot === activeRoot()
        ? {
            kind: "managed-task",
            canonicalRoot: requestedRoot,
            fs: nodeWorkspaceFs,
            repositoryRoot: requestedRoot,
          }
        : undefined,
    confirmationConsumer: createAuthenticatedSessionStartConfirmationPlane(),
    ...(input.runtimeMutationLeaseBroker === undefined
      ? {}
      : { runtimeMutationLeaseBroker: input.runtimeMutationLeaseBroker }),
  });
  return {
    resolve: (): ReturnType<ProductionCodingRuntimeResolver["resolve"]> => {
      const qualified = resolver.resolve();
      return qualified === undefined
        ? undefined
        : { ...qualified, openCodeGatewayReadinessRegistry: readiness };
    },
  };
}

function functionalManagedModelProfile(modelId: string | undefined): {
  readonly profileId: string;
} {
  const resolved = resolveCodingSafeSidecarGatewayProfile(functionalGatewayConfig(), {
    ...(modelId === undefined ? {} : { modelId }),
  });
  if (resolved.status !== "available") throw new Error("functional model is unavailable");
  return { profileId: resolved.modelAlias };
}

function functionalBackend(
  input: FunctionalRuntimeResolverInput,
  readiness: ReturnType<typeof createOpenCodeGatewayReadinessRegistry>,
): ReturnType<typeof createProductionOpenCodeBackend> {
  const backend = createProductionOpenCodeBackend({
    portable: input.portable,
    runtimeStateRoot: input.runtimeStateRoot,
    gatewayUrl: input.gatewayUrl,
    resolveGatewayRunMetadata: (modelId): CodingWorkbenchSidecarGatewayRunMetadata | undefined => {
      const result = resolveCodingSafeSidecarGatewayProfile(functionalGatewayConfig(), { modelId });
      return result.status === "available" ? result.runMetadata : undefined;
    },
    // ADR-0043 D11-D14 (#3390): the SAME single attested loopback origin as `gatewayUrl` above,
    // never a second listener's own port -- derived from it exactly the way
    // productionOpenCodeActivation.ts derives both from ONE `loopback` origin.
    toolFacadeUrl: `${new URL(input.gatewayUrl).origin}/api/coding-sidecar/tool`,
    runtimeEvidence: input.runtimeEvidence,
    gatewayReadiness: readiness,
    createSupervisor: input.createSupervisor,
    ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
  });
  return {
    ...backend,
    createRun: (run): ReturnType<typeof backend.createRun> => {
      const created = backend.createRun(run);
      input.observeBackendRun?.(run);
      return created;
    },
  };
}

export interface FunctionalBffDepsInput {
  readonly stateRoot: string;
  readonly workspaceLifecycle: WorkspaceLifecycleService;
  readonly codingRuntimeResolver: ProductionCodingRuntimeResolver;
  readonly script: ScriptState;
}

/**
 * Hermetic state for one composed server: its directories and the fixture provider profile as the
 * server's own gateway configuration file, which `buildUiHandlerDeps` loads like any other.
 */
function prepareFunctionalState(stateRoot: string): void {
  for (const dir of ["state", "ui-db", "evidence"]) {
    mkdirSync(join(stateRoot, dir), { recursive: true, mode: 0o700 });
  }
  writeFileSync(
    join(stateRoot, "ui-db", "keiko.config.json"),
    `${JSON.stringify(functionalGatewayConfig(), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

/**
 * Boots the real BFF dependency composition (`buildUiHandlerDeps`) against hermetic tmp state and
 * replaces exactly two seams: the provider transport of the readiness probes and the
 * OpenAI-compatible chat factories (scripted model). Everything else — gateway configuration,
 * routes, control plane, orchestrator, evidence, stores — is the production wiring.
 */
export function functionalBffDeps(input: FunctionalBffDepsInput): UiHandlerDeps {
  prepareFunctionalState(input.stateRoot);
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(input.stateRoot, "evidence"),
    env: {
      PATH: process.env.PATH ?? "",
      KEIKO_STATE_DIR: join(input.stateRoot, "state"),
    },
    uiDbPath: join(input.stateRoot, "ui-db", "keiko-ui.db"),
    gatewayReadinessFetch: functionalReadinessFetch,
    workspaceLifecycle: input.workspaceLifecycle,
    codingRuntimeResolver: input.codingRuntimeResolver,
    codingRuntimeDeploymentCeiling: "autonomous-delivery",
    codingRuntimeServerPrincipal: () => "functional-operator",
    sessionPairingPort: createFakeSessionPairingPort(),
  });
  return withScriptedModelSeams(deps, input.script);
}

export interface DiscoveryBffDepsInput {
  readonly stateRoot: string;
  readonly store?: Parameters<typeof buildUiHandlerDeps>[0]["store"];
  // Required companion whenever `store` is injected: without it the assembly cannot build the
  // coding-runtime control plane and the discovery journey refuses as unqualified.
  readonly codingRuntimeSnapshotStore?: Parameters<
    typeof buildUiHandlerDeps
  >[0]["codingRuntimeSnapshotStore"];
  readonly workspaceScriptTrust?: Parameters<typeof buildUiHandlerDeps>[0]["workspaceScriptTrust"];
  readonly workspaceLifecycle: WorkspaceLifecycleService;
  readonly workspaceProvisioning?:
    NonNullable<Parameters<typeof buildUiHandlerDeps>[0]["workspaceProvisioning"]> | undefined;
  readonly workspaceReconciliation?:
    NonNullable<Parameters<typeof buildUiHandlerDeps>[0]["workspaceReconciliation"]> | undefined;
  readonly script: ScriptState;
  readonly uiPort: number;
  readonly launcherSessionSecret?: string | undefined;
  /** The launcher environment an operator adds, e.g. an explicit OpenSSL configuration. */
  readonly operatorEnv?: Readonly<Record<string, string>> | undefined;
  readonly observeGatewayRequest?: ((request: GatewayRequest) => void) | undefined;
}

/**
 * Boots the real BFF composition with NO runtime injection seam: no `codingRuntimeResolver`, no
 * `codingRuntimeProductionPorts`, no `createSupervisor`, and no `KEIKO_OPENCODE_REAL_*` staging
 * seam. Coding-runtime activation must resolve through production discovery — the dev lane's
 * staged payload of this repository checkout — exactly as `npm run dev:start` composes it. Only
 * the model seam (scripted gateway responses) and the task-workspace fixture are replaced.
 */
export function productionDiscoveryBffDeps(input: DiscoveryBffDepsInput): UiHandlerDeps {
  prepareFunctionalState(input.stateRoot);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    KEIKO_STATE_DIR: join(input.stateRoot, "state"),
    KEIKO_UI_PORT: String(input.uiPort),
    KEIKO_CODING_RUNTIME_DEV_LANE: "1",
    KEIKO_CODING_DEPLOYMENT_CEILING: "autonomous-delivery",
    ...(input.launcherSessionSecret === undefined
      ? {}
      : { [SESSION_PAIRING_LAUNCHER_SECRET_ENV]: input.launcherSessionSecret }),
    ...input.operatorEnv,
  };
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(input.stateRoot, "evidence"),
    env,
    uiDbPath: join(input.stateRoot, "ui-db", "keiko-ui.db"),
    gatewayReadinessFetch: functionalReadinessFetch,
    ...(input.store === undefined ? {} : { store: input.store }),
    ...(input.codingRuntimeSnapshotStore === undefined
      ? {}
      : { codingRuntimeSnapshotStore: input.codingRuntimeSnapshotStore }),
    ...(input.workspaceScriptTrust === undefined
      ? {}
      : { workspaceScriptTrust: input.workspaceScriptTrust }),
    ...(input.workspaceProvisioning === undefined
      ? {}
      : { workspaceProvisioning: input.workspaceProvisioning }),
    workspaceLifecycle: input.workspaceLifecycle,
    ...(input.workspaceReconciliation === undefined
      ? {}
      : { workspaceReconciliation: input.workspaceReconciliation }),
    codingRuntimeServerPrincipal: () => "functional-operator",
    ...(input.launcherSessionSecret === undefined
      ? { sessionPairingPort: createFakeSessionPairingPort() }
      : {}),
  });
  return withScriptedModelSeams(deps, input.script, input.observeGatewayRequest);
}

function withScriptedModelSeams(
  deps: UiHandlerDeps,
  script: ScriptState,
  observeGatewayRequest?: (request: GatewayRequest) => void,
): UiHandlerDeps {
  const chat = (request: GatewayRequest): Promise<NormalizedResponse> => {
    observeGatewayRequest?.(request);
    return Promise.resolve(scriptedResponse(script, scriptedTranscript(request)));
  };
  // The configuration stays the composed server's own: it loaded the same file, and its runtime
  // holder carries the readiness probe's fresh evidence that admits a new run (ADR-0171). Replacing
  // either with a copy leaves that evidence unreadable, and the Workbench would wait forever.
  return {
    ...deps,
    codingSidecarGatewayChatFactory: () => chat,
    codingSidecarGatewayChatStreamFactory: () =>
      async function* (request: GatewayRequest): AsyncIterable<GatewayStreamChunk> {
        // A real model streams its assistant content as deltas before the terminal chunk; the
        // gateway's SSE synthesis needs them to forward the content to OpenCode. Emitting only a
        // done chunk left the real binary with no assistant text to persist.
        const response = await chat(request);
        if (response.content.length > 0) yield { type: "delta" as const, token: response.content };
        yield { type: "done" as const, response };
      },
  };
}

/** Bounded, workspace-confined text read for the managed tool facade (functional stand-in). */
export function functionalWorkspaceRead(
  resolveRoot: () => string | undefined,
  diagnostics: ServerDiagnosticSink | undefined,
): SecureWorkspaceTextReadPort {
  return {
    readText: ({ relativePath, signal }): ReturnType<SecureWorkspaceTextReadPort["readText"]> => {
      const root = resolveRoot();
      if (signal?.aborted === true || root === undefined) {
        return Promise.resolve({ ok: false as const, reason: "workspace-unavailable" as const });
      }
      return Promise.resolve(readContainedText(root, relativePath, signal, diagnostics));
    },
  };
}

function readContainedText(
  root: string,
  relativePath: string,
  signal: AbortSignal | undefined,
  diagnostics: ServerDiagnosticSink | undefined,
): Awaited<ReturnType<SecureWorkspaceTextReadPort["readText"]>> {
  try {
    const path = containedRegularFile(root, relativePath);
    if (path === undefined) return { ok: false, reason: "denied" };
    const before = statSync(path, { bigint: true });
    if (before.size > BigInt(MAX_READ_BYTES)) return { ok: false, reason: "too-large" };
    const bytes = readFileSync(path);
    const after = statSync(path, { bigint: true });
    if (!sameFile(before, after) || signal?.aborted === true) {
      bytes.fill(0);
      return { ok: false, reason: "unstable" };
    }
    const text = bytes.toString("utf8");
    bytes.fill(0);
    return { ok: true, text };
  } catch (error) {
    return functionalReadFailure(error, diagnostics);
  }
}

// ENOENT is the ordinary case — no such file, exactly what a plain miss looks like — and is
// reported as "not-found". Previously every OTHER failure (EACCES, EPERM — a genuine permission
// denial) collapsed to the SAME "not-found" reason, actively mislabeling a containment/permission
// failure as mere absence. Distinguish the two and log a content-free diagnostic (error CLASS
// only, never the path or the raw OS message) noting which one fired, mirroring the
// isEnoent/emitShardUnreadable split `secret-vault.ts` already uses for the same OS-error class.
function functionalReadFailure(
  error: unknown,
  diagnostics: ServerDiagnosticSink | undefined,
): { readonly ok: false; readonly reason: "denied" | "not-found" } {
  const permissionDenied = !isEnoent(error);
  emitServerDiagnostic(diagnostics, {
    correlationId: randomUUID(),
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.functional-workspace-read",
    source: "productionOpenCodeBackend.functional._support.read-contained-text",
    errorClass: contentFreeErrorClass(error),
    message: permissionDenied
      ? "functional-workspace-read-permission-denied"
      : "functional-workspace-read-not-found",
  });
  return { ok: false, reason: permissionDenied ? "denied" : "not-found" };
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * In-process governed changeset applier satisfying the `editorAgentClient` seam. It ports the
 * archived harness behaviour: exact patch/changeset correspondence, per-file source hash proof,
 * and containment-enforced application through the shared patch engine.
 */
function functionalEditorAgentClient(
  resolveRoot: () => string | undefined,
  runtimeMutationLeaseBroker: CodingRuntimeEditorMutationLeaseBroker | undefined,
): FunctionalEditorAgentClient {
  return {
    action: (action, signal): Promise<FunctionalEditorActionResult> => {
      const root = resolveRoot();
      return Promise.resolve(
        functionalEditorAction(action, signal, root, runtimeMutationLeaseBroker),
      );
    },
  };
}

function functionalEditorAction(
  action: FunctionalEditorAction,
  signal: AbortSignal,
  root: string | undefined,
  broker: CodingRuntimeEditorMutationLeaseBroker | undefined,
): FunctionalEditorActionResult {
  if (root === undefined || action.type !== "applyChangeset") {
    return editorDenied("RUNTIME_EDIT_UNSUPPORTED");
  }
  if (!changesetMatchesPatch(root, action)) {
    return editorDenied("RUNTIME_EDIT_CHANGESET_INVALID");
  }
  const request = functionalMutationLeaseRequest(action, root);
  if (broker !== undefined && (request === undefined || !broker.claim(request))) {
    return editorDenied("RUNTIME_EDIT_AUTHORITY_INVALID");
  }
  return applyFunctionalChangeset(action, signal, root, request, broker);
}

function applyFunctionalChangeset(
  action: FunctionalEditorAction,
  signal: AbortSignal,
  root: string,
  request: CodingRuntimeEditorMutationLeaseRequest | undefined,
  broker: CodingRuntimeEditorMutationLeaseBroker | undefined,
): FunctionalEditorActionResult {
  let succeeded = false;
  try {
    applyPatch(workspace(root), action.changeset?.patch ?? "", { applyEnabled: true, signal });
    succeeded = true;
    return editorSucceeded(action);
  } catch {
    return editorDenied("RUNTIME_EDIT_APPLY_FAILED");
  } finally {
    if (request !== undefined) broker?.complete(request, succeeded);
  }
}

function editorSucceeded(action: FunctionalEditorAction): FunctionalEditorActionResult {
  return {
    ok: true,
    value: {
      result: {
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        actionId: action.actionId,
        sessionId: action.sessionId,
        status: "succeeded",
      },
    },
  };
}

function functionalMutationLeaseRequest(
  action: FunctionalEditorAction,
  workspaceRoot: string,
): CodingRuntimeEditorMutationLeaseRequest | undefined {
  const authorityRef = action.authorityRef;
  if (authorityRef === undefined) return undefined;
  return {
    authorityRef,
    runId: authorityRef.runId,
    envelopeDigest: authorityRef.envelopeDigest,
    workspaceRootDigest: editorAgentWorkspaceRootDigest(workspaceRoot),
    actionId: action.actionId,
    idempotencyKey: action.idempotencyKey,
  };
}

function editorDenied(code: string): FunctionalEditorActionResult {
  return {
    ok: false,
    error: { kind: "route", code, message: "Functional editor client denied the action." },
  };
}

function changesetMatchesPatch(root: string, action: FunctionalEditorAction): boolean {
  const changeset = action.changeset;
  if (changeset === undefined) return false;
  const inspection = inspectPatch(workspace(root), changeset.patch);
  if (!inspection.validation.ok || inspection.files === null) return false;
  const expected = new Map(changeset.files.map((file) => [file.file, file.expectedContentHash]));
  const actual = inspection.files.map((file) => file.change.path);
  if (expected.size !== actual.length || actual.some((path) => !expected.has(path))) return false;
  if (changeset.selectedFiles && !samePaths(changeset.selectedFiles, actual)) return false;
  return inspection.files.every(
    (file) => expected.get(file.change.path) === file.sourceContentHash,
  );
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  const sortedRight = [...right].sort();
  return (
    left.length === right.length &&
    [...left].sort().every((path, index) => path === sortedRight[index])
  );
}

function containedRegularFile(root: string, relativePath: string): string | undefined {
  if (relativePath.length === 0 || resolve(relativePath) === relativePath) return undefined;
  const rootReal = realpathSync(root);
  const candidate = realpathSync(resolve(rootReal, relativePath));
  const rel = relative(rootReal, candidate);
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    lstatSync(candidate).isSymbolicLink()
  )
    return undefined;
  return statSync(candidate).isFile() ? candidate : undefined;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function workspace(root: string): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

/** The exact URL the #2387 research journey asks for; the request line binds the minted grant. */
export const RESEARCH_JOURNEY_URL = "https://docs.example.org/guide/streams?topic=backpressure";

/**
 * A model that obeys instructions only where they carry authority. It complies with the page's
 * directive exactly when ANY occurrence of that directive reaches it OUTSIDE a quarantine fence;
 * only when every occurrence is fenced does it proceed with the ordinary journey. The three
 * branches are distinguishable from the browser: the compliant branch requests a changeset edit,
 * the correct branch produces the skill invocation the journey already asserts, and never observing
 * the page produces neither — so the acceptance test cannot pass vacuously on a transcript that
 * lost the tool result.
 */
function researchPostFetchResponse(transcript: string, script: ScriptState): NormalizedResponse {
  const directive = script.injectionDirective ?? "";
  if (directive === "") return normal();
  let at = transcript.indexOf(directive);
  if (at < 0) return normal();
  while (at >= 0) {
    // One unfenced copy is enough: a fenced copy sitting beside an unfenced one is exactly the
    // failure this has to catch, so every occurrence is checked, not just the first.
    if (!directiveIsFenced(transcript, at)) {
      return tool("keiko_changeset_edit", edit(script));
    }
    at = transcript.indexOf(directive, at + directive.length);
  }
  return tool("keiko_skill", { skillId: "skl_repo-structure-summary@1" });
}

// True when the directive at `at` sits between a quarantine BEGIN fence and the END fence that
// closes it. Mere presence of a fence somewhere in the transcript is not enough.
function directiveIsFenced(transcript: string, at: number): boolean {
  const begin = transcript.lastIndexOf(RESEARCH_UNTRUSTED_BEGIN_FENCE, at);
  if (begin < 0) return false;
  const end = transcript.indexOf(RESEARCH_UNTRUSTED_END_FENCE, begin);
  return end > at;
}

/** Flattens the conversation the runtime sends the model into one searchable transcript. */
export function scriptedTranscript(request: GatewayRequest | undefined): string {
  return request === undefined ? "" : JSON.stringify(request.messages);
}

// #2387 journey turns. The blocking `question` steps are the halt points that keep every governed
// fetch inside a RUNNING run (a paused run's sticky ingest guard would drop the content-free
// research events): step 0 asks for the URL (no grant → permission request, fetch fails closed),
// step 1 blocks on a question until the operator has approved, step 2 performs the governed fetch,
// step 3 is the #2637 injection decision (it invokes the approved skill only when the page's
// directive arrived fenced), step 4 runs the bounded child, and step 5 ends turn 1; step 6 (turn 2,
// after revoke) blocks again and step 7 retries the fetch under a fresh approval request.
function researchScriptedResponse(
  step: number,
  transcript: string,
  script: ScriptState,
): NormalizedResponse {
  if (step === 0 || step === 2 || step === 6) {
    return tool("keiko_research_fetch", { target: RESEARCH_JOURNEY_URL });
  }
  // The causal-terminal contract settles the run on the first `stop` completion, so every phase
  // boundary the journey still needs (revoke, follow-up, deny) is held open by a blocking
  // question instead of a bare text turn: step 5 keeps the run alive for the revoke phase, and
  // step 7 keeps it awaiting the operator's deny after the revoked re-ask.
  if (step === 1 || step === 5 || step === 7) return tool("question", question());
  // #2637: step 3 is the decision the granted page tried to steer. Only a fenced directive lets the
  // journey continue to its skill invocation.
  if (step === 3) return researchPostFetchResponse(transcript, script);
  if (step === 4) {
    return tool("keiko_child_agent", {
      objective: "Inspect the repository structure without mutation",
      maxToolCalls: 2,
    });
  }
  return normal();
}

export function scriptedResponse(script: ScriptState, transcript = ""): NormalizedResponse {
  const response = scriptedResponseFor(script, transcript);
  // Report what the model REQUESTED, whatever the runtime later does with it. A journey asserting
  // "no mutation was attempted" needs the request, not the applied diff: a downstream denial leaves
  // the workspace clean either way.
  for (const call of response.toolCalls) script.observeToolCall?.(call.name);
  return response;
}

function scriptedResponseFor(script: ScriptState, transcript: string): NormalizedResponse {
  const step = script.calls++;
  if (script.mode === "productive-search")
    return productiveSearchResponse(step, script, transcript);
  if (script.mode === "research") return researchScriptedResponse(step, transcript, script);
  const driven = processResponse(script, transcript);
  if (driven !== undefined) return driven;
  if (script.mode === "out-of-scope") {
    return step === 0
      ? tool("keiko_changeset_edit", {
          changeset: {
            edits: [
              {
                file: "../outside.txt",
                oldString: "OUTSIDE_SECRET_2258",
                newString: "owned",
                replaceAll: false,
              },
            ],
            deletions: [],
            renames: [],
            files: [{ file: "../outside.txt", expectedContentHash: "0".repeat(64) }],
            selectedFiles: ["../outside.txt"],
          },
        })
      : normal();
  }
  // The discovery journey (#2475) proves activation and the live runtime with the runtime's own
  // `read` (the mapped `keiko_workspace_read` does not exist in a native run, #3897) and the
  // runtime question. The edit and verification legs need a live browser bridge and a
  // product-registered project respectively; the staged-seam control and the W1.10 UI journey own
  // them.
  if (script.mode === "discovery") {
    if (step === 0) return tool("read", { path: NATIVE_TARGET_PATH });
    return step === 1 ? tool("question", question()) : normal();
  }
  return productiveResponse(step, script);
}

/** The background child a lifecycle turn starts through the runtime's own shell tool. */
export const FUNCTIONAL_LIFECYCLE_BACKGROUND_COMMAND = "sleep 3899.2";
/** A process the command itself detaches (`&`): launchd adopts it at once (#3901 AC3). */
export const FUNCTIONAL_LIFECYCLE_DETACHED_COMMAND = "sleep 3899.3";
/** The foreground child that keeps a lifecycle turn busy until it is cancelled or killed. */
export const FUNCTIONAL_LIFECYCLE_FOREGROUND_COMMAND = "sleep 3899.1";
const TITLE_GENERATION_PREFIX = "Generate a title for this conversation:";

// #3899 AC2, #3901 AC3: a background job, a process the command detaches itself and a foreground
// child of the original service, so cancellation, a crash and shutdown each have a live process
// tree to reap. A continued task answers plainly.
// The runtime's own title request carries no tools and never advances the turn.
function lifecycleResponse(script: ScriptState, transcript: string): NormalizedResponse {
  if (script.mode === "lifecycle-continue" || transcript.includes(TITLE_GENERATION_PREFIX))
    return normal();
  const replies = toolReplyCount(transcript);
  if (replies === 0)
    return tool("shell", { command: FUNCTIONAL_LIFECYCLE_BACKGROUND_COMMAND, background: true });
  if (replies === 1)
    return tool("shell", {
      command: `${FUNCTIONAL_LIFECYCLE_DETACHED_COMMAND} > /dev/null 2>&1 &`,
    });
  return replies === 2
    ? tool("shell", { command: FUNCTIONAL_LIFECYCLE_FOREGROUND_COMMAND, timeout: 0 })
    : normal();
}

/** The modes that drive the runtime's own processes (#3899 AC2, #3901 AC3/AC4, #3902 AC2). */
function processResponse(script: ScriptState, transcript: string): NormalizedResponse | undefined {
  if (script.mode === "lifecycle" || script.mode === "lifecycle-continue")
    return lifecycleResponse(script, transcript);
  if (script.mode === "index") return indexResponse(transcript);
  if (script.mode === "sync") return syncResponse(transcript);
  if (script.mode === "branch") return branchResponse(transcript);
  if (script.mode === "websearch") return webSearchResponse(transcript);
  return script.mode === "probe" ? probeResponse(script, transcript) : undefined;
}

/** The query a web search journey asks the original `websearch` tool. */
export const FUNCTIONAL_WEBSEARCH_QUERY = "keiko governed search fixture";

// #3903 AC3: the original runtime searches once with its own `websearch` tool and answers.
function webSearchResponse(transcript: string): NormalizedResponse {
  if (transcript.includes(TITLE_GENERATION_PREFIX)) return normal();
  return toolReplyCount(transcript) === 0
    ? tool("websearch", { query: FUNCTIONAL_WEBSEARCH_QUERY })
    : normal();
}

/** Printed by the agent's shell once it has fetched and fast-forwarded through Keiko. */
export const FUNCTIONAL_SYNC_HEAD_MARKER = "sync.head=";

// #3902 AC2: the original runtime tries its shell's own fetch first (refused in every mode), then
// fetches and fast-forwards through `keiko_git_sync`, and reads the commit it now stands on with its
// own Git. Each step answers the previous tool result, as a model does.
function syncResponse(transcript: string): NormalizedResponse {
  if (transcript.includes(TITLE_GENERATION_PREFIX)) return normal();
  const steps: readonly (() => NormalizedResponse)[] = [
    (): NormalizedResponse => tool("shell", { command: "git fetch origin" }),
    (): NormalizedResponse => tool("keiko_git_sync", { pull: false }),
    (): NormalizedResponse => tool("keiko_git_sync", { pull: true }),
    (): NormalizedResponse =>
      tool("shell", {
        command: `printf '${FUNCTIONAL_SYNC_HEAD_MARKER}%s\\n' "$(git log -1 --format=%s)"`,
      }),
  ];
  return steps[toolReplyCount(transcript)]?.() ?? normal();
}

/** Printed by the agent's shell once it has the branch Keiko created for it checked out. */
export const FUNCTIONAL_BRANCH_HEAD_MARKER = "branch.head=";
/** The task branch the journey asks Keiko for. */
export const FUNCTIONAL_BRANCH_NAME = "feature/x";

// #3907: a model on a Local checkout of `main` tries its shell's own `git checkout -b` first (refused
// in every mode, with the pointer to the governed tool), edits the working tree, asks Keiko for a task
// branch through `keiko_git_branch`, reads Git's state through Keiko's own `keiko_git_status` (which
// only answers once the run's authority stands on the new branch) and prints the branch it is on with
// its own Git. Each step answers the previous tool result, as a model does.
function branchResponse(transcript: string): NormalizedResponse {
  if (transcript.includes(TITLE_GENERATION_PREFIX)) return normal();
  const steps: readonly (() => NormalizedResponse)[] = [
    (): NormalizedResponse =>
      tool("shell", { command: `git checkout -b ${FUNCTIONAL_BRANCH_NAME}` }),
    (): NormalizedResponse =>
      tool("shell", { command: `printf 'edited by the agent\\n' >> ${FUNCTIONAL_INDEX_PATH}` }),
    (): NormalizedResponse => tool("keiko_git_branch", { name: FUNCTIONAL_BRANCH_NAME }),
    (): NormalizedResponse => tool("keiko_git_status", {}),
    (): NormalizedResponse =>
      tool("shell", {
        command: `printf '${FUNCTIONAL_BRANCH_HEAD_MARKER}%s\\n' "$(git rev-parse --abbrev-ref HEAD)"`,
      }),
  ];
  return steps[toolReplyCount(transcript)]?.() ?? normal();
}

/** The file an index journey changes, stages and gives back to the worktree. */
export const FUNCTIONAL_INDEX_PATH = "src/example.ts";
/** Printed by the agent's shell while the change is staged and once it is not. */
export const FUNCTIONAL_INDEX_STAGED_MARKER = "index.staged=";
export const FUNCTIONAL_INDEX_AFTER_MARKER = "index.after=";

// The last proposal id of `prefix` the runtime returned to the model (`stage-<n>`, `unstage-<n>`),
// read from a `proposalId` field only: a tool-call id such as `tool-keiko_git_stage-2` is not one.
function lastProposalId(transcript: string, prefix: "stage" | "unstage"): string | undefined {
  const ids = [...transcript.matchAll(/proposalId\\*":\\*"((?:un)?stage-\d{1,39})/gu)]
    .map((match) => match[1])
    .filter((id) => id?.startsWith(`${prefix}-`) === true);
  return ids.at(-1);
}

// #3902 AC2: the original runtime changes a file with its own shell, stages it through Keiko's
// proposal and redemption, reads the index with its own Git, gives the staged change back to the
// worktree through `keiko_git_stage` with `unstage: true` and reads the index again. Each step answers the previous
// tool result, as a model does.
function indexResponse(transcript: string): NormalizedResponse {
  if (transcript.includes(TITLE_GENERATION_PREFIX)) return normal();
  const readIndex = (marker: string): NormalizedResponse =>
    tool("shell", {
      command: `printf '${marker}%s\\n' "$(git diff --cached --name-only | tr '\\n' ',')"`,
    });
  const steps: readonly (() => NormalizedResponse)[] = [
    (): NormalizedResponse =>
      tool("shell", { command: `printf 'staged by the agent\\n' >> ${FUNCTIONAL_INDEX_PATH}` }),
    (): NormalizedResponse =>
      tool("keiko_git_stage", { paths: [FUNCTIONAL_INDEX_PATH], unstage: false }),
    (): NormalizedResponse =>
      tool("keiko_git_execute", {
        kind: "stage",
        proposalId: lastProposalId(transcript, "stage") ?? "stage-0",
      }),
    (): NormalizedResponse => readIndex(FUNCTIONAL_INDEX_STAGED_MARKER),
    (): NormalizedResponse =>
      tool("keiko_git_stage", { paths: [FUNCTIONAL_INDEX_PATH], unstage: true }),
    (): NormalizedResponse =>
      tool("keiko_git_execute", {
        kind: "unstage",
        proposalId: lastProposalId(transcript, "unstage") ?? "unstage-0",
      }),
    (): NormalizedResponse => readIndex(FUNCTIONAL_INDEX_AFTER_MARKER),
  ];
  return steps[toolReplyCount(transcript)]?.() ?? normal();
}

// #3901 AC4: one shell command observes the boundary from inside the run; its output returns to
// the model, where the test reads it.
function probeResponse(script: ScriptState, transcript: string): NormalizedResponse {
  if (transcript.includes(TITLE_GENERATION_PREFIX) || script.probeCommand === undefined)
    return normal();
  return toolReplyCount(transcript) === 0
    ? tool("shell", { command: script.probeCommand, timeout: 60_000 })
    : normal();
}

function toolReplyCount(transcript: string): number {
  const messages: unknown = transcript === "" ? [] : JSON.parse(transcript);
  if (!Array.isArray(messages)) return 0;
  return messages.filter(
    (message: unknown) =>
      typeof message === "object" &&
      message !== null &&
      (message as { readonly role?: unknown }).role === "tool",
  ).length;
}

function productiveResponse(step: number, script: ScriptState): NormalizedResponse {
  if (step === 0)
    return {
      ...tool("keiko_workspace_read", { relativePath: "src/example.ts" }, script.toolCallId),
      content: FUNCTIONAL_PLAN_STEP_READ,
    };
  if (step === 1) return tool("question", question());
  if (step === 2)
    return { ...tool("keiko_changeset_edit", edit(script)), content: FUNCTIONAL_PLAN_STEP_VERIFY };
  if (step === 3) {
    script.verificationIssued = true;
    return tool("keiko_verification", { verifierId: "typecheck" });
  }
  // A held run reports the closing progress a settling run would, then blocks on a question: the
  // causal-terminal contract settles a run on its first `stop`, so only a blocked turn keeps it live.
  if (script.holdAfterVerification === true && script.verificationIssued === true) {
    return { ...tool("question", question()), content: normal().content };
  }
  return normal();
}

/**
 * The project check the native journey runs through the runtime's own `shell` (#3901, parity T10):
 * the fixture's `typecheck` script, which the native policy classifies as verification evidence.
 */
export const NATIVE_VERIFICATION_COMMAND = "npm run typecheck";

// The native journey (#3897): the original runtime's own tools, as the pinned 2.1.4 child offers
// them to the model on macOS. Search, read and the repository skill are its `grep`, `read` and
// `skill`; the contained edit is its `edit`; the verification is the project's own check through
// its `shell`, which the native policy reads as the run's verification evidence. Keiko's governed
// verifier runs in a container, and on a host without a container backend it correctly fails
// closed, so the native check is what carries a native run's verification. The mapped `keiko_*`
// read, search, changeset and skill tools do not exist in a native run, and calling one is answered
// "No tool named ...".
function nativeSearchSteps(
  script: ScriptState,
  transcript: string,
): readonly (() => NormalizedResponse)[] {
  const search = (): NormalizedResponse => ({
    ...tool(
      "grep",
      { pattern: script.old.trim(), literal: true, caseSensitive: true, include: "*.ts" },
      H1_PROOF_SEARCH_CALL_ID,
    ),
    content: FUNCTIONAL_PLAN_STEP_READ,
  });
  const read = (): NormalizedResponse =>
    tool(
      "read",
      repositorySearchReadHandoff(transcript, script.old.trim(), script.observeRepositorySearch),
    );
  const skill = (): NormalizedResponse =>
    tool(
      "skill",
      skillInvocationHandoff(
        transcript,
        FUNCTIONAL_REPOSITORY_SKILL_NAME,
        script.observeSkillDiscovery,
      ),
      SKILL_DISCOVERY_PROOF_CALL_ID,
    );
  const edit = (): NormalizedResponse => ({
    ...tool("edit", { path: NATIVE_TARGET_PATH, oldString: script.old, newString: script.next }),
    content: FUNCTIONAL_PLAN_STEP_VERIFY,
  });
  const verify = (): NormalizedResponse => {
    script.verificationIssued = true;
    return tool("shell", { command: NATIVE_VERIFICATION_COMMAND, timeout: 60_000 });
  };
  return [
    search,
    read,
    ...(script.proveSkillDiscovery === true ? [skill] : []),
    (): NormalizedResponse => tool("question", question()),
    edit,
    verify,
  ];
}

function productiveSearchResponse(
  step: number,
  script: ScriptState,
  transcript: string,
): NormalizedResponse {
  const response = nativeSearchSteps(script, transcript)[step]?.();
  if (response !== undefined) return response;
  return script.holdAfterVerification === true && script.verificationIssued === true
    ? tool("question", question())
    : normal();
}

function question(): Record<string, unknown> {
  return {
    questions: [
      {
        question: "Approve?",
        header: "Approval",
        options: [{ label: "Approve", description: "Continue" }],
      },
    ],
  };
}

// The model-visible edit form (#3873): one exact replacement, bound to the file's read digest. The
// catalog requires every changeset member, so the empty `deletions` and `renames` are spelled out.
function edit(script: ScriptState): Record<string, unknown> {
  return {
    changeset: {
      edits: [
        {
          file: "src/example.ts",
          oldString: script.old,
          newString: script.next,
          replaceAll: false,
        },
      ],
      deletions: [],
      renames: [],
      files: [{ file: "src/example.ts", expectedContentHash: digest(script.old) }],
      selectedFiles: ["src/example.ts"],
    },
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normal(): NormalizedResponse {
  return {
    modelId: "functional-model",
    // Exceed the owning message-byte bound with actual model output. Both the scripted child
    // and V2 must truncate the same tail without artificially expanding ordinary progress.
    content: `${FUNCTIONAL_ACTIVITY_ASSISTANT_PREFIX}${"x".repeat(
      CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES + 512,
    )}${FUNCTIONAL_ACTIVITY_TRUNCATED_TAIL}`,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "functional",
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
      costClass: "low",
    },
  };
}

let scriptedToolCallSequence = 0;

function tool(
  name:
    | "grep"
    | "read"
    | "skill"
    | "edit"
    | "keiko_workspace_read"
    | "keiko_changeset_edit"
    | "keiko_verification"
    | "keiko_research_fetch"
    | "keiko_skill"
    | "keiko_child_agent"
    | "keiko_git_stage"
    | "keiko_git_execute"
    | "keiko_git_sync"
    | "keiko_git_branch"
    | "keiko_git_status"
    | "question"
    | "shell"
    | "websearch",
  args: Record<string, unknown>,
  callId?: string,
): NormalizedResponse {
  scriptedToolCallSequence += 1;
  return {
    ...normal(),
    content: "",
    finishReason: "tool_calls",
    toolCalls: [
      { id: callId ?? `tool-${name}-${String(scriptedToolCallSequence)}`, name, arguments: args },
    ],
  };
}

const FUNCTIONAL_PROVIDER_ORIGIN = "https://provider.invalid";

/**
 * The provider transport of the gateway's readiness probes. A new run is admitted only after a
 * fresh basic-chat success (ADR-0171), and that probe calls the provider directly, past the
 * scripted chat seam; the fixture provider answers it the way a working endpoint would. Any other
 * destination fails like an unreachable host, so the probe can never pass for a different provider.
 */
export function functionalReadinessFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== FUNCTIONAL_PROVIDER_ORIGIN)
    return Promise.reject(new TypeError("functional-readiness-destination-unknown"));
  return Promise.resolve(
    Response.json({
      id: "chatcmpl-functional-readiness",
      object: "chat.completion",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
}

export function functionalGatewayConfig(): GatewayConfig {
  const provider = {
    modelId: "functional-model",
    baseUrl: `${FUNCTIONAL_PROVIDER_ORIGIN}/v1`,
    apiKey: "functional-provider-secret",
    apiKeyHeaderName: "api-key",
    endpointStyle: "azure-openai-deployment" as const,
    apiVersion: "2024-06-01",
    timeoutMs: 5_000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
  };
  return {
    providers: [provider],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
    capabilities: [
      {
        id: "functional-model",
        kind: "chat",
        contextWindow: 128_000,
        // Admit the deliberately oversized display sample through the gateway, then prove
        // the independent safe-activity message bound clips it for the paired client.
        maxOutputTokens: 8_192,
        toolCalling: true,
        toolCallingVerification: {
          status: "verified",
          checkedAt: new Date().toISOString(),
          probe: "gateway-tool-calling-v1",
          configurationFingerprint: toolCallingConfigurationFingerprint(provider),
        },
        structuredOutput: true,
        streaming: true,
        supportsImageInput: false,
        supportsDocumentInput: false,
        workflowEligible: true,
        costClass: "low",
        latencyClass: "standard",
        throughputHint: "functional",
        preferredUseCases: ["Coding"],
        knownLimitations: [],
      },
    ],
  };
}
