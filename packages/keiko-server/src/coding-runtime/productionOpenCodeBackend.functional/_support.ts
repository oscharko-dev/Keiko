import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import {
  CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS,
  EDITOR_AGENT_SCHEMA_VERSION,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-contracts";
import type {
  GatewayConfig,
  GatewayStreamChunk,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { applyPatch, inspectPatch } from "@oscharko-dev/keiko-tools";

import { createOpenCodeGatewayReadinessRegistry } from "../../coding-sidecar-gateway.js";
import { createFakeSessionPairingPort } from "../../coding-app-session/_support.js";
import { buildUiHandlerDeps, type UiHandlerDeps } from "../../deps.js";
import type { ServerDiagnosticSink } from "../../diagnostics-log.js";
import type { VerificationRunnerManager } from "../../editor/verificationRunner.js";
import type { WorkspaceLifecycleService } from "../../task-workspace/types.js";
import type { CodingRuntimeEvidenceAggregator } from "../codingRuntimeEvidenceAggregator.js";
import { createAuthenticatedSessionStartConfirmationPlane } from "../codingRuntimeStartConfirmationPlane.js";
import type { ProductionCodingRuntimeResolver } from "../productionCodingRuntimeHost.js";
import { createProductionCodingRuntimeResolver } from "../productionCodingRuntimeResolver.js";
import {
  createProductionOpenCodeBackend,
  type ProductionOpenCodeBackendInput,
  type ResolvedPortableOpenCodeRuntime,
} from "../productionOpenCodeBackend.js";
import type { ProductionCodingRuntimeResolverInput } from "../productionCodingRuntimeResolver.js";
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
  mode: "productive" | "out-of-scope" | "discovery";
  calls: number;
  readonly old: string;
  readonly next: string;
  toolCallId?: string;
}

type FunctionalEditorAgentClient = ProductionCodingRuntimeResolverInput["editorAgentClient"];
type FunctionalEditorAction = Parameters<FunctionalEditorAgentClient["action"]>[0];
type FunctionalEditorActionResult = Awaited<ReturnType<FunctionalEditorAgentClient["action"]>>;

export interface FunctionalRuntimeResolverInput {
  readonly portable: ResolvedPortableOpenCodeRuntime;
  readonly runtimeStateRoot: string;
  readonly gatewayUrl: string;
  readonly workspaceLifecycle: WorkspaceLifecycleService;
  readonly managedTaskWorkspaceRoot: string;
  readonly readWorkspaceHead: (workspaceRoot: string, repositoryRoot: string) => string | undefined;
  readonly verificationRunner: Pick<VerificationRunnerManager, "runToReport">;
  readonly runtimeEvidence: Pick<CodingRuntimeEvidenceAggregator, "observe">;
  readonly createSupervisor: NonNullable<ProductionOpenCodeBackendInput["createSupervisor"]>;
  readonly diagnostics?: ServerDiagnosticSink;
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
    },
    backend: createProductionOpenCodeBackend({
      portable: input.portable,
      runtimeStateRoot: input.runtimeStateRoot,
      gatewayUrl: input.gatewayUrl,
      runtimeEvidence: input.runtimeEvidence,
      gatewayReadiness: readiness,
      createSupervisor: input.createSupervisor,
      ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
    }),
    secureWorkspaceTextRead: functionalWorkspaceRead(activeRoot),
    editorAgentClient: functionalEditorAgentClient(activeRoot),
    verificationRunner: input.verificationRunner,
    confirmationConsumer: createAuthenticatedSessionStartConfirmationPlane(),
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
  readonly workspaceLifecycle: WorkspaceLifecycleService;
  readonly script: ScriptState;
  readonly uiPort: number;
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
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    KEIKO_STATE_DIR: join(input.stateRoot, "state"),
    KEIKO_UI_PORT: String(input.uiPort),
    KEIKO_CODING_RUNTIME_DEV_LANE: "1",
    KEIKO_CODING_DEPLOYMENT_CEILING: "autonomous-delivery",
  };
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(input.stateRoot, "evidence"),
    env,
    uiDbPath: join(input.stateRoot, "ui-db", "keiko-ui.db"),
    workspaceLifecycle: input.workspaceLifecycle,
    codingRuntimeServerPrincipal: () => "functional-operator",
    sessionPairingPort: createFakeSessionPairingPort(),
  });
  return withScriptedModelSeams(deps, input.script);
}

function withScriptedModelSeams(deps: UiHandlerDeps, script: ScriptState): UiHandlerDeps {
  const chat = (): Promise<NormalizedResponse> => Promise.resolve(scriptedResponse(script));
  return {
    ...deps,
    config: functionalGatewayConfig(),
    configPresent: true,
    gatewayConfig: undefined,
    codingSidecarGatewayChatFactory: () => chat,
    codingSidecarGatewayChatStreamFactory: () =>
      async function* (): AsyncIterable<GatewayStreamChunk> {
        yield { type: "done" as const, response: await chat() };
      },
  };
}

/** Bounded, workspace-confined text read for the managed tool facade (functional stand-in). */
function functionalWorkspaceRead(
  resolveRoot: () => string | undefined,
): SecureWorkspaceTextReadPort {
  return {
    readText: ({ relativePath, signal }): ReturnType<SecureWorkspaceTextReadPort["readText"]> => {
      const root = resolveRoot();
      if (signal?.aborted === true || root === undefined) {
        return Promise.resolve({ ok: false as const, reason: "workspace-unavailable" as const });
      }
      return Promise.resolve(readContainedText(root, relativePath, signal));
    },
  };
}

function readContainedText(
  root: string,
  relativePath: string,
  signal: AbortSignal | undefined,
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
  } catch {
    return { ok: false, reason: "not-found" };
  }
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
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

export function scriptedResponse(script: ScriptState): NormalizedResponse {
  const step = script.calls++;
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
    content: `${FUNCTIONAL_ACTIVITY_ASSISTANT_PREFIX}${"x".repeat(
      Math.floor(CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS / 8),
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
  return {
    providers: [
      {
        modelId: "functional-model",
        baseUrl: "https://provider.invalid/v1",
        apiKey: "functional-provider-secret",
        apiKeyHeaderName: "api-key",
        endpointStyle: "azure-openai-deployment",
        apiVersion: "2024-06-01",
        timeoutMs: 5_000,
        maxRetries: 0,
        retryBaseDelayMs: 1,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
    capabilities: [
      {
        id: "functional-model",
        kind: "chat",
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        toolCalling: true,
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
