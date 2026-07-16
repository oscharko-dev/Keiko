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

import { EDITOR_AGENT_SCHEMA_VERSION, type WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import type {
  GatewayConfig,
  GatewayStreamChunk,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { applyPatch, inspectPatch } from "@oscharko-dev/keiko-tools";

import { createOpenCodeGatewayReadinessRegistry } from "../../coding-sidecar-gateway.js";
import { buildUiHandlerDeps, type UiHandlerDeps } from "../../deps.js";
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

export interface ScriptState {
  mode: "productive" | "out-of-scope";
  calls: number;
  readonly old: string;
  readonly next: string;
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
  });
  const chat = (): Promise<NormalizedResponse> => Promise.resolve(scriptedResponse(input.script));
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
export function functionalWorkspaceRead(
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
export function functionalEditorAgentClient(
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
  if (step === 0) return tool("keiko_workspace_read", { relativePath: "src/example.ts" });
  if (step === 1) return tool("question", question());
  if (step === 2) return tool("keiko_changeset_edit", edit(script));
  return step === 3 ? tool("keiko_verification", { verifierId: "typecheck" }) : normal();
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
    content: "",
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
  name: "keiko_workspace_read" | "keiko_changeset_edit" | "keiko_verification" | "question",
  args: Record<string, unknown>,
): NormalizedResponse {
  scriptedToolCallSequence += 1;
  return {
    ...normal(),
    finishReason: "tool_calls",
    toolCalls: [{ id: `tool-${name}-${String(scriptedToolCallSequence)}`, name, arguments: args }],
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
