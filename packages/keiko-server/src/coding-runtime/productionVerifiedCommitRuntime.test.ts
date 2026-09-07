import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { runMigrations } from "../store/schema.js";
import { createCodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import {
  resolveVerifiedCommitContext,
  type VerifiedCommitRuntimeBinding,
  type VerifiedCommitRuntimeDependencies,
} from "./productionVerifiedCommitRuntime.js";
import type { CodingRuntimeTrustedContext } from "./runtimeAuthorityService.js";
import type { GitDeliveryMutationDeps } from "../gitDelivery/execution.js";

const digest = "a".repeat(64);
const root = "/workspace/run-1";

function trustedContext(runId: string): CodingRuntimeTrustedContext {
  return {
    runId,
    repositoryIdentity: { kind: "github-origin", digest },
    operatorId: "operator-1",
    taskId: "task-1",
    projectId: "repository-1",
    projectDigest: digest,
    workspaceId: "workspace-1",
    workspaceRoot: root,
    branchRef: "codex/task",
    branchHeadDigest: digest,
    branch: {
      baseRef: "dev",
      headRef: "codex/task",
      allowedPrefixes: ["codex/"],
      allowDetachedHead: false,
    },
    deploymentCeiling: "supervised-coding",
    runtimeSource: "keiko-sidecar",
    actionClasses: ["workspace-read", "workspace-write", "verification"],
    connectorScopes: [],
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
      maxCommandTimeoutMs: 120_000,
      requirePerCommandApproval: true,
    },
    networkPolicy: { mode: "deny-all", connectorScopes: [], allowLoopback: false },
    gates: ["human-approval"],
    budget: {
      maxRuntimeMs: 60_000,
      maxToolCalls: 256,
      maxPromptTokens: 20_000,
      maxPatchBytes: 262_144,
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function deps(runId: string): VerifiedCommitRuntimeDependencies {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  const snapshots = createCodingRuntimeSnapshotStore(db);
  snapshots.create({
    schemaVersion: "1",
    runId,
    state: "running",
    revision: 0,
    requestedMode: "governed-assist",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    taskDigest: digest,
    workspaceDigest: digest,
    operatorDigest: digest,
    authorityDigest: digest,
    bindingDigest: digest,
    provenanceDigest: digest,
    toolCallCount: 0,
    patchByteCount: 0,
    modelRequestCount: 0,
  });
  return {
    snapshots,
    resolveWorkspace: (workspaceRoot): WorkspaceInfo =>
      ({ root: workspaceRoot }) as unknown as WorkspaceInfo,
    buffersClean: () => true,
    // Neither field is read by resolveVerifiedCommitContext (only snapshots/resolveWorkspace/
    // buffersClean are); left as inert stand-ins rather than the full production mutation graph.
    mutationDeps: undefined as unknown as GitDeliveryMutationDeps,
    messageAllowed: () => Promise.resolve(true),
  };
}

function binding(runId: string): VerifiedCommitRuntimeBinding {
  return {
    runId,
    envelopeDigest: digest,
    context: trustedContext(runId),
    stillAuthorized: () => true,
    signal: new AbortController().signal,
  };
}

// #3384 batch-1 B3-16: this is the last line of defense before an activity-log write --
// server-log.ts's applyEnvelopeFields never shape-validates the primary `correlationId` field
// (only `parentCorrelationId` is gated by isValidCorrelationId), so a malformed runId reaching this
// call site previously landed in the log verbatim.
describe("resolveVerifiedCommitContext correlation id (#3384 B3-16)", () => {
  it("passes through a well-formed runId as the correlation id", () => {
    // >=8 chars, matching correlation.ts's SAFE_CORRELATION_ID floor.
    const runId = "run-00001";
    const context = resolveVerifiedCommitContext(deps(runId), binding(runId));
    expect(context?.correlationId).toBe(runId);
  });
  it("downgrades a malformed runId to the unknown-correlation-id marker instead of logging it raw", () => {
    // Valid per the snapshot store's own runId shape (SAFE_ID allows ":"), but the colon fails
    // correlation.ts's stricter SAFE_CORRELATION_ID alphabet -- exactly the gap B3-16 closes.
    const hostileRunId = "run:00001";
    const context = resolveVerifiedCommitContext(deps(hostileRunId), binding(hostileRunId));
    expect(context?.correlationId).toBe(UNKNOWN_CORRELATION_ID);
  });
});
