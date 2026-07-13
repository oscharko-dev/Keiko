import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { relative, resolve, sep } from "node:path";

import {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  EDITOR_AGENT_SCHEMA_VERSION,
  type CodingWorkbenchRuntimeAuthorityFacts,
  type CodingWorkbenchRuntimeEvent,
  type EditorAgentAction,
  type EditorAgentGovernedAuthorityReference,
  type VerificationKind,
  type VerificationReport,
  type WorkspaceInfo,
  validateCodingWorkbenchRuntimeEvent,
} from "@oscharko-dev/keiko-contracts";
import { applyPatch, inspectPatch } from "@oscharko-dev/keiko-tools";

import { createRuntimeCodingToolFacade } from "./codingToolAuthorityPort.js";
import type { CodingToolFacade } from "./codingToolFacadePorts.js";
import type { CodingToolGovernedPorts } from "./codingToolGovernedDelegate.js";
import type { CodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";
import {
  createCodingToolReadEditPorts,
  type CodingToolReadEditPorts,
} from "./codingToolReadEditPorts.js";
import type { CodingRuntimeEditorMutationLeaseCoordinator } from "./codingRuntimeEditorMutationLeaseCoordinator.js";
import type { CodingRuntimeAuthorityService } from "./runtimeAuthorityService.js";
import type { SecureWorkspaceTextReadPort } from "./secureWorkspaceTextRead.js";
import type { VerificationRunnerManager } from "../editor/verificationRunner.js";

const MAX_READ_BYTES = 65_536;

export interface ProductionManagedWorktreeToolInput {
  readonly authority: CodingRuntimeAuthorityService;
  readonly authorityRef: EditorAgentGovernedAuthorityReference;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly authorityExpiresAt: string;
  readonly deploymentCeiling: "governed-assist" | "supervised-coding" | "autonomous-delivery";
  readonly liveFacts: () => CodingWorkbenchRuntimeAuthorityFacts;
  readonly assertLiveWorkspace: () => boolean;
  readonly invocationRegistry: CodingToolInvocationRegistry;
  readonly leases: CodingRuntimeEditorMutationLeaseCoordinator;
  readonly verificationRunner: Pick<VerificationRunnerManager, "runToReport">;
  readonly onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void;
}

export function createProductionManagedWorktreeToolFacade(
  input: ProductionManagedWorktreeToolInput,
): CodingToolFacade {
  const readEdit = createReadEditPorts(input);
  return createRuntimeCodingToolFacade(
    input.authority,
    () => ({
      adapterKind: "model-gateway-sidecar",
      liveFacts: input.liveFacts(),
      workspaceRoot: input.workspaceRoot,
      deploymentCeiling: input.deploymentCeiling,
      nowIso: new Date().toISOString(),
      runId: input.authorityRef.runId,
      envelopeDigest: input.authorityRef.envelopeDigest,
      authorityExpiresAt: input.authorityExpiresAt,
    }),
    governedPorts(input, readEdit),
    { invocationRegistry: input.invocationRegistry, reserveEditDelegation: true },
  );
}

function createReadEditPorts(input: ProductionManagedWorktreeToolInput): CodingToolReadEditPorts {
  const sessionId = `runtime-${input.authorityRef.runId}`;
  return createCodingToolReadEditPorts({
    secureWorkspaceTextRead: stableManagedRead(input),
    editorAgentClient: managedEditorClient(input),
    resolveEditorActionContext: () => ({
      sessionId,
      authorityRef: input.authorityRef,
      origin: "agent",
      workspaceId: input.workspaceId,
      workspaceRootDigest: input.liveFacts().binding.workspaceRootDigest,
      expiresAt: input.authorityExpiresAt,
    }),
    resolveRepositoryReadContext: () => ({
      runId: input.authorityRef.runId,
      envelopeDigest: input.authorityRef.envelopeDigest,
      workspaceId: input.workspaceId,
      workspaceRootDigest: input.liveFacts().binding.workspaceRootDigest,
      expiresAt: input.authorityExpiresAt,
    }),
    mutationLeaseCoordinator: input.leases,
  });
}

function stableManagedRead(input: ProductionManagedWorktreeToolInput): SecureWorkspaceTextReadPort {
  return {
    readText: ({ relativePath, signal }): ReturnType<SecureWorkspaceTextReadPort["readText"]> => {
      if (aborted(signal) || !input.assertLiveWorkspace())
        return Promise.resolve({ ok: false as const, reason: "workspace-unavailable" as const });
      try {
        const path = containedRegularFile(input.workspaceRoot, relativePath);
        if (path === undefined)
          return Promise.resolve({ ok: false as const, reason: "denied" as const });
        const before = statSync(path, { bigint: true });
        if (before.size > BigInt(MAX_READ_BYTES))
          return Promise.resolve({ ok: false as const, reason: "too-large" as const });
        const bytes = readFileSync(path);
        const after = statSync(path, { bigint: true });
        if (!sameFile(before, after) || aborted(signal) || !input.assertLiveWorkspace()) {
          bytes.fill(0);
          return Promise.resolve({ ok: false as const, reason: "unstable" as const });
        }
        const text = bytes.toString("utf8");
        bytes.fill(0);
        return Promise.resolve({ ok: true as const, text });
      } catch {
        return Promise.resolve({ ok: false as const, reason: "not-found" as const });
      }
    },
  };
}

interface ManagedEditorActionResult {
  readonly ok: true;
  readonly value: {
    readonly result: {
      readonly schemaVersion: typeof EDITOR_AGENT_SCHEMA_VERSION;
      readonly actionId: string;
      readonly sessionId: string;
      readonly status: "succeeded";
    };
  };
}

interface ManagedEditorClient {
  readonly action: (
    action: EditorAgentAction,
    signal: AbortSignal,
  ) => Promise<ManagedEditorActionResult>;
}

function managedEditorClient(input: ProductionManagedWorktreeToolInput): ManagedEditorClient {
  return {
    action: (action, signal): Promise<ManagedEditorActionResult> => {
      if (
        !claimEdit(input, action) ||
        action.type !== "applyChangeset" ||
        !input.assertLiveWorkspace()
      )
        throw new Error("runtime-edit-authority-invalid");
      if (!changesetMatchesPatch(input.workspaceRoot, action)) {
        throw new Error("runtime-edit-changeset-invalid");
      }
      applyPatch(workspace(input.workspaceRoot), action.changeset?.patch ?? "", {
        applyEnabled: true,
        signal,
      });
      if (!input.assertLiveWorkspace()) throw new Error("runtime-edit-workspace-drift");
      return Promise.resolve({
        ok: true,
        value: {
          result: {
            schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
            actionId: action.actionId,
            sessionId: action.sessionId,
            status: "succeeded",
          },
        },
      });
    },
  };
}

function claimEdit(input: ProductionManagedWorktreeToolInput, action: EditorAgentAction): boolean {
  const authorityRef = action.authorityRef;
  if (authorityRef === undefined) return false;
  return input.leases.lease.claim({
    authorityRef,
    runId: input.authorityRef.runId,
    envelopeDigest: input.authorityRef.envelopeDigest,
    workspaceId: input.workspaceId,
    workspaceRootDigest: input.liveFacts().binding.workspaceRootDigest,
    actionId: action.actionId,
    idempotencyKey: action.idempotencyKey,
  });
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

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
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

function governedPorts(
  input: ProductionManagedWorktreeToolInput,
  readEdit: CodingToolReadEditPorts,
): CodingToolGovernedPorts {
  let verificationEventSequence = 0;
  const failed = (): Promise<{ readonly status: "failed" }> =>
    Promise.resolve({ status: "failed" });
  return {
    ...readEdit,
    commandRunner: { execute: failed },
    verificationRunner: {
      execute: async (
        request,
        signal,
        mutationGuard,
      ): Promise<{ readonly status: "completed" | "failed" }> => {
        if (!mutationGuard.check() || !input.assertLiveWorkspace()) return { status: "failed" };
        const kind = verificationKind(request.verifierId);
        if (kind === undefined) return { status: "failed" };
        const report = await input.verificationRunner.runToReport(
          { projectId: input.workspaceRoot, kinds: [kind], requestId: request.actionId },
          signal ?? new AbortController().signal,
        );
        verificationEventSequence += 1;
        publishVerificationResult(input, verificationEventSequence, report);
        return {
          status:
            report.overallStatus === "passed" && input.assertLiveWorkspace()
              ? "completed"
              : "failed",
        };
      },
    },
    gitAuthority: { execute: failed },
    deliveryAuthority: { execute: failed },
    connectorAuthority: { execute: failed },
    egressAuthority: { execute: failed },
  };
}

function publishVerificationResult(
  input: ProductionManagedWorktreeToolInput,
  sequence: number,
  report: VerificationReport,
): void {
  const event: CodingWorkbenchRuntimeEvent = {
    schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
    eventId: `event-verification-${String(sequence)}`,
    runId: input.authorityRef.runId,
    occurredAt: new Date().toISOString(),
    kind: "verification-summarized",
    verificationKind: "verification-command",
    verificationStatus: verificationEventStatus(report),
    passedCount: report.counts.passed,
    failedCount: failedVerificationCount(report),
    skippedCount: report.counts.skipped,
  };
  if (!validateCodingWorkbenchRuntimeEvent(event).ok) {
    throw new Error("runtime-verification-event-invalid");
  }
  input.onRuntimeEvent(event);
}

function verificationEventStatus(report: VerificationReport): "passed" | "failed" | "partial" {
  if (report.overallStatus === "passed") return "passed";
  return report.overallStatus === "skipped" ? "partial" : "failed";
}

function failedVerificationCount(report: VerificationReport): number {
  return (
    report.counts.failed +
    report.counts.denied +
    report.counts["timed-out"] +
    report.counts.cancelled +
    report.counts["resource-exceeded"]
  );
}

function verificationKind(value: string): VerificationKind | undefined {
  switch (value) {
    case "test":
    case "targeted-test":
    case "typecheck":
    case "lint":
    case "build":
      return value;
    default:
      return undefined;
  }
}

function changesetMatchesPatch(root: string, action: EditorAgentAction): boolean {
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
  return (
    left.length === right.length &&
    [...left].sort().every((path, index) => path === [...right].sort()[index])
  );
}

export function productionWorkspaceDigest(root: string): string {
  return createHash("sha256").update(root, "utf8").digest("hex");
}
