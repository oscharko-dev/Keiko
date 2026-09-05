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

import type { WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import { CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS } from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";
import { EDITOR_AGENT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import {
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
import type { WorkspaceLifecycleService } from "../../task-workspace/types.js";
import type { CodingRuntimeEvidenceAggregator } from "../codingRuntimeEvidenceAggregator.js";
import type { CodingRuntimeEditorMutationLeaseBroker } from "../codingRuntimeEditorMutationLeaseCoordinator.js";
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

const MAX_READ_BYTES = 65_536;
export const FUNCTIONAL_ACTIVITY_ASSISTANT_PREFIX = "VISIBLE_ASSISTANT_TEXT_2479:";
export const FUNCTIONAL_ACTIVITY_TRUNCATED_TAIL = "TRUNCATED_TAIL_2479";
export const FUNCTIONAL_PLAN_STEP_READ = "PLAN_STEP_READ_2480";
export const FUNCTIONAL_PLAN_STEP_EDIT = "PLAN_STEP_EDIT_2480";
export const FUNCTIONAL_PLAN_STEP_VERIFY = "PLAN_STEP_VERIFY_2480";
/** Rides an unprojected todo field; it must never appear in any sink, including the feed. */
export const FUNCTIONAL_PLAN_DROPPED_CANARY = "PLAN_DROPPED_CANARY_2480";

export interface ScriptState {
  mode: "productive" | "out-of-scope" | "discovery" | "research";
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
  readonly runtimeMutationLeaseBroker?: Pick<CodingRuntimeEditorMutationLeaseBroker, "attach">;
  readonly createSupervisor: NonNullable<ProductionOpenCodeBackendInput["createSupervisor"]>;
  readonly diagnostics?: ServerDiagnosticSink;
  /** Uses the same configured-profile qualification as the mounted gateway when supplied. */
  readonly resolveManagedModelProfile?: ProductionCodingRuntimeResolverInput["workspaceAuthority"]["resolveManagedModelProfile"];
  /** #2387: opens the network-egress class so the research approval loop is reachable. */
  readonly researchEgressEnabled?: boolean | undefined;
  /** #2387 hermetic research transport; tests never touch the real network. */
  readonly researchFetchImpl?: ProductionCodingRuntimeResolverInput["researchFetchImpl"];
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
      resolveManagedModelProfile: input.resolveManagedModelProfile,
      researchEgressEnabled: input.researchEgressEnabled,
    },
    ...(input.researchFetchImpl ? { researchFetchImpl: input.researchFetchImpl } : {}),
    ...resolveFunctionalChildModelInput(input),
    ...(input.verifiedCommit === undefined ? {} : { verifiedCommit: input.verifiedCommit }),
    ...(input.draftDelivery === undefined ? {} : { draftDelivery: input.draftDelivery }),
    backend: functionalBackend(input, readiness),
    secureWorkspaceTextRead: functionalWorkspaceRead(activeRoot, input.diagnostics),
    editorAgentClient: functionalEditorAgentClient(activeRoot),
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

function functionalBackend(
  input: FunctionalRuntimeResolverInput,
  readiness: ReturnType<typeof createOpenCodeGatewayReadinessRegistry>,
): ReturnType<typeof createProductionOpenCodeBackend> {
  const backend = createProductionOpenCodeBackend({
    portable: input.portable,
    runtimeStateRoot: input.runtimeStateRoot,
    gatewayUrl: input.gatewayUrl,
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
 * Boots the real BFF dependency composition (`buildUiHandlerDeps`) against hermetic tmp state and
 * replaces exactly two seams: the gateway config (fixture profile) and the OpenAI-compatible chat
 * factories (scripted model). Everything else — routes, control plane, orchestrator, evidence,
 * stores — is the production wiring.
 */
export function functionalBffDeps(input: FunctionalBffDepsInput): UiHandlerDeps {
  for (const dir of ["state", "ui-db", "evidence"]) {
    mkdirSync(join(input.stateRoot, dir), { recursive: true, mode: 0o700 });
  }
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(input.stateRoot, "evidence"),
    env: {
      PATH: process.env.PATH ?? "",
      KEIKO_STATE_DIR: join(input.stateRoot, "state"),
    },
    uiDbPath: join(input.stateRoot, "ui-db", "keiko-ui.db"),
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
  for (const dir of ["state", "ui-db", "evidence"]) {
    mkdirSync(join(input.stateRoot, dir), { recursive: true, mode: 0o700 });
  }
  writeFileSync(
    join(input.stateRoot, "ui-db", "keiko.config.json"),
    `${JSON.stringify(functionalGatewayConfig(), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    KEIKO_STATE_DIR: join(input.stateRoot, "state"),
    KEIKO_UI_PORT: String(input.uiPort),
    KEIKO_CODING_RUNTIME_DEV_LANE: "1",
    KEIKO_CODING_DEPLOYMENT_CEILING: "autonomous-delivery",
    ...(input.launcherSessionSecret === undefined
      ? {}
      : { [SESSION_PAIRING_LAUNCHER_SECRET_ENV]: input.launcherSessionSecret }),
  };
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(input.stateRoot, "evidence"),
    env,
    uiDbPath: join(input.stateRoot, "ui-db", "keiko-ui.db"),
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
  return {
    ...deps,
    config: functionalGatewayConfig(),
    configPresent: true,
    gatewayConfig: undefined,
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
): FunctionalEditorAgentClient {
  return {
    action: (action, signal): Promise<FunctionalEditorActionResult> => {
      const root = resolveRoot();
      if (root === undefined || action.type !== "applyChangeset") {
        return Promise.resolve(editorDenied("RUNTIME_EDIT_UNSUPPORTED"));
      }
      if (!changesetMatchesPatch(root, action)) {
        return Promise.resolve(editorDenied("RUNTIME_EDIT_CHANGESET_INVALID"));
      }
      try {
        applyPatch(workspace(root), action.changeset?.patch ?? "", {
          applyEnabled: true,
          signal,
        });
      } catch {
        return Promise.resolve(editorDenied("RUNTIME_EDIT_APPLY_FAILED"));
      }
      return Promise.resolve({
        ok: true as const,
        value: {
          result: {
            schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
            actionId: action.actionId,
            sessionId: action.sessionId,
            status: "succeeded" as const,
          },
        },
      });
    },
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
  if (script.mode === "research") return researchScriptedResponse(step, transcript, script);
  if (script.mode === "out-of-scope") {
    return step === 0
      ? tool("keiko_changeset_edit", {
          changeset: {
            patch:
              "--- a/../outside.txt\n+++ b/../outside.txt\n@@ -1 +1 @@\n-OUTSIDE_SECRET_2258\n+owned\n",
            files: [{ file: "../outside.txt", expectedContentHash: "0".repeat(64) }],
          },
        })
      : normal();
  }
  // The discovery journey (#2475) proves activation and the live runtime with the real secure
  // read and the runtime question. The edit and verification legs need a live browser bridge and
  // a product-registered project respectively; the staged-seam control and the W1.10 UI journey
  // own them.
  if (script.mode === "discovery") {
    if (step === 0) return tool("keiko_workspace_read", { relativePath: "src/example.ts" });
    return step === 1 ? tool("question", question()) : normal();
  }
  return productiveResponse(step, script);
}

function productiveResponse(step: number, script: ScriptState): NormalizedResponse {
  if (step === 0) return tool("todowrite", planUpdate(1));
  if (step === 1)
    return tool("keiko_workspace_read", { relativePath: "src/example.ts" }, script.toolCallId);
  if (step === 2) return tool("question", question());
  if (step === 3) return tool("keiko_changeset_edit", edit(script));
  if (step === 4) return tool("todowrite", planUpdate(2));
  return step === 5 ? tool("keiko_verification", { verifierId: "typecheck" }) : normal();
}

/** Revision 1 opens two steps; revision 2 flips their states and appends the verify step. */
function planUpdate(revision: 1 | 2): Record<string, unknown> {
  const opened = [
    {
      content: FUNCTIONAL_PLAN_STEP_READ,
      status: revision === 1 ? "in_progress" : "completed",
      priority: "high",
    },
    {
      content: FUNCTIONAL_PLAN_STEP_EDIT,
      status: revision === 1 ? "pending" : "in_progress",
      priority: "medium",
    },
  ];
  if (revision === 1) return { todos: opened };
  return {
    todos: [
      ...opened,
      {
        content: FUNCTIONAL_PLAN_STEP_VERIFY,
        status: "pending",
        priority: "low",
        notes: FUNCTIONAL_PLAN_DROPPED_CANARY,
      },
    ],
  };
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

function edit(script: ScriptState): Record<string, unknown> {
  return {
    changeset: {
      patch: `--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-${script.old}+${script.next}`,
      files: [{ file: "src/example.ts", expectedContentHash: digest(script.old) }],
    },
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normal(): NormalizedResponse {
  return {
    modelId: "functional-model",
    // Intrinsically over the projection's segment bound so the assistant text truncates identically
    // for the scripted child and the real binary (which streams the raw content, without the
    // child's artificial display expansion). Exercises the long-text admission fix end to end.
    content: `${FUNCTIONAL_ACTIVITY_ASSISTANT_PREFIX}${"x".repeat(
      CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS + 512,
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
    | "keiko_workspace_read"
    | "keiko_changeset_edit"
    | "keiko_verification"
    | "keiko_research_fetch"
    | "keiko_skill"
    | "keiko_child_agent"
    | "question"
    | "todowrite",
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

export function functionalGatewayConfig(): GatewayConfig {
  const provider = {
    modelId: "functional-model",
    baseUrl: "https://provider.invalid/v1",
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
        maxOutputTokens: 4_096,
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
