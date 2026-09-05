/* eslint-disable @typescript-eslint/explicit-function-return-type -- Local test fixture callbacks are contextually typed. */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { runMigrations } from "../store/schema.js";
import {
  createCodingRuntimeControlPlane,
  type CodingRuntimeHost,
} from "./codingRuntimeControlPlane.js";
import { createCodingRuntimeEvidenceAggregator } from "./codingRuntimeEvidenceAggregator.js";
import { createCodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import { EditorAgentAuthorityRegistry } from "../editor/agentAuthorityRegistry.js";
import { CodingRuntimeAuthorityService } from "./runtimeAuthorityService.js";
import type { GitDeliveryDescriptionAuthorityScope } from "../gitDelivery/runBoundAuthority.js";

describe("coding runtime control plane", () => {
  it("constructs one fail-closed aggregate when no runtime host is qualified", async () => {
    const snapshots = {
      create: vi.fn(),
      recordVerifiedCommit: vi.fn(),
      recordDraftDelivery: vi.fn(),
      adoptDraftDeliveryFromPredecessor: vi.fn(),
      transition: vi.fn(),
      get: vi.fn(),
      listRecentActive: vi.fn(() => []),
      listAll: vi.fn(() => []),
      markNonterminalRecoveryRequired: vi.fn(() => []),
      acknowledgeRecovery: vi.fn(),
      releaseRecoveryForRetry: vi.fn(),
      delete: vi.fn(),
      listPrunableSettled: vi.fn(() => []),
      deletePruned: vi.fn(),
    };
    const control = createCodingRuntimeControlPlane({
      snapshots: snapshots,
      evidence: { observe: vi.fn(), settle: vi.fn(), deletePruned: vi.fn() },
      workspaceLifecycle: {
        getActive: () => ({
          instance: { workspaceId: "workspace-1" },
          binding: { activeRoot: "/managed/workspace" },
        }),
      } as never,
      serverPrincipal: () => "local-operator",
    });

    expect(control.orchestrator.status().state).toBe("idle");
    expect(control.runtimeHostQualified).toBe(false);
    await expect(
      control.orchestrator.start({
        requestId: "request-1",
        taskIntent: "bounded intent",
        requestedMode: "supervised-coding",
      }),
    ).resolves.toEqual({ ok: false, failureCode: "authority-resolution-failed" });
    expect(snapshots.create).not.toHaveBeenCalled();
  });

  it("marks the control plane qualified only when a runtime host is explicitly supplied", () => {
    const runtimeHost: CodingRuntimeHost = {
      createManager: () => ({
        start: () => ({ ok: false, failureCode: "runtime-unqualified", retryable: false }),
        issueApproval: () => ({
          ok: false,
          failureCode: "runtime-stopped",
          retryable: false,
        }),
        pause: () => ({ ok: false, failureCode: "runtime-run-mismatch", retryable: false }),
        resume: () => ({ ok: false, failureCode: "runtime-run-mismatch", retryable: false }),
        stop: () =>
          Promise.resolve({
            ok: false,
            failureCode: "runtime-run-mismatch",
            retryable: false,
          }),
        takeover: () =>
          Promise.resolve({
            ok: false,
            failureCode: "runtime-run-mismatch",
            retryable: false,
          }),
        reconcile: () =>
          Promise.resolve({
            ok: false,
            failureCode: "runtime-run-mismatch",
            retryable: false,
          }),
        health: () => ({ status: "stopped" }),
        pendingApprovalReview: () => undefined,
        result: () => undefined,
      }),
      launchResolver: {
        resolve: () => ({
          taskRef: "task-1",
          treeBindingId: "tree-1",
          adapterKind: "codex-cli",
          runtimeSource: "codex-cli-adapter",
          modelSource: "keiko-model-gateway",
          effectiveMode: "supervised-coding",
          executablePath: "/managed/runtime",
          managedRoot: "/managed",
          gatewayUrl: "http://127.0.0.1:4317",
          modelProfileId: "qualified-profile",
          args: [],
          inheritedEnvAllowlist: [],
          shutdownTimeoutMs: 1_000,
          startTimeoutMs: 1_000,
        }),
      },
      approvalAuthority: {
        issue: () => ({
          ok: false,
          failureCode: "runtime-stopped",
          retryable: false,
        }),
      },
      cancellationRegistry: { signalFor: () => undefined },
    };
    const control = createCodingRuntimeControlPlane({
      snapshots: {
        create: vi.fn(),
        recordVerifiedCommit: vi.fn(),
        recordDraftDelivery: vi.fn(),
        adoptDraftDeliveryFromPredecessor: vi.fn(),
        transition: vi.fn(),
        get: vi.fn(),
        listRecentActive: vi.fn(() => []),
        listAll: vi.fn(() => []),
        markNonterminalRecoveryRequired: vi.fn(() => []),
        acknowledgeRecovery: vi.fn(),
        releaseRecoveryForRetry: vi.fn(),
        delete: vi.fn(),
        listPrunableSettled: vi.fn(() => []),
        deletePruned: vi.fn(),
      },
      evidence: { observe: vi.fn(), settle: vi.fn(), deletePruned: vi.fn() },
      workspaceLifecycle: { getActive: () => undefined } as never,
      serverPrincipal: () => "local-operator",
      runtimeHost,
    });

    expect(control.runtimeHostQualified).toBe(true);
  });

  it("reconciles a durable active row to one content-free recovery manifest at bootstrap", () => {
    const db = new DatabaseSync(":memory:");
    runMigrations(db);
    const snapshots = createCodingRuntimeSnapshotStore(db);
    const digest = "a".repeat(64);
    snapshots.create({
      schemaVersion: "1",
      runId: "run-restart",
      state: "running",
      revision: 3,
      requestedMode: "supervised-coding",
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:01:00.000Z",
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
    const common = {
      snapshots,
      workspaceLifecycle: { getActive: () => undefined } as never,
      serverPrincipal: () => "local-operator",
    };
    const failingEvidence = createCodingRuntimeEvidenceAggregator({
      put: () => {
        throw new Error("evidence store unavailable");
      },
      get: () => undefined,
      list: () => [],
      delete: () => undefined,
    });
    expect(() => createCodingRuntimeControlPlane({ ...common, evidence: failingEvidence })).toThrow(
      "evidence store unavailable",
    );
    expect(snapshots.get("run-restart")?.state).toBe("recovery-required");

    const manifests = new Map<string, string>();
    const evidence = createCodingRuntimeEvidenceAggregator({
      put: (id, body) => {
        manifests.set(id, body);
        return id;
      },
      get: (id) => manifests.get(id),
      list: () => [],
      delete: (id) => {
        manifests.delete(id);
      },
    });

    const control = createCodingRuntimeControlPlane({ ...common, evidence });

    expect(control.orchestrator.status()).toMatchObject({
      runId: "run-restart",
      state: "recovery-required",
      failureCode: "recovery-required",
    });
    expect(manifests.size).toBe(1);
    const serialized = manifests.get("run-restart") ?? "";
    expect(serialized).toContain('"state":"recovery-required"');
    expect(serialized).not.toContain("prompt");
    db.close();
  });

  // #3399 (epic #3384 correction 4): a production composition test. Before this change,
  // `CodingRuntimeHost`/`CodingRuntimeControlPlane` had no `gitDeliveryDescriptionAuthority` field
  // at all, so a real minted description authority had no way to reach the control plane's exposed
  // surface — this failed to type-check, let alone pass. It now threads exactly like
  // `gitDeliveryAuthority` already does.
  it("threads a real minted description authority from the runtime host onto the exposed control plane surface", () => {
    const authority = new CodingRuntimeAuthorityService(new EditorAgentAuthorityRegistry());
    const scope: GitDeliveryDescriptionAuthorityScope = {
      remoteDigest: "a".repeat(64),
      pr: { ownerAndRepo: "owner/repo", prNumber: 7 },
      snapshotDigest: "b".repeat(64),
    };
    authority.mintGitDeliveryDescriptionAuthority({
      scope,
      requestedMode: "supervised-coding",
      deploymentCeiling: "autonomous-delivery",
      nowIso: "2026-01-01T00:00:00.000Z",
    });
    const runtimeHost: CodingRuntimeHost = {
      createManager: () => unqualifiedManager(),
      launchResolver: { resolve: () => qualifiedLaunch() },
      approvalAuthority: {
        issue: () => ({ ok: false, failureCode: "runtime-stopped", retryable: false }),
      },
      cancellationRegistry: { signalFor: () => undefined },
      gitDeliveryDescriptionAuthority: authority.gitDeliveryDescriptionAuthorityPort(),
    };
    const control = createCodingRuntimeControlPlane({
      snapshots: {
        create: vi.fn(),
        recordVerifiedCommit: vi.fn(),
        recordDraftDelivery: vi.fn(),
        adoptDraftDeliveryFromPredecessor: vi.fn(),
        transition: vi.fn(),
        get: vi.fn(),
        listRecentActive: vi.fn(() => []),
        listAll: vi.fn(() => []),
        markNonterminalRecoveryRequired: vi.fn(() => []),
        acknowledgeRecovery: vi.fn(),
        releaseRecoveryForRetry: vi.fn(),
        delete: vi.fn(),
        listPrunableSettled: vi.fn(() => []),
        deletePruned: vi.fn(),
      },
      evidence: { observe: vi.fn(), settle: vi.fn(), deletePruned: vi.fn() },
      workspaceLifecycle: { getActive: () => undefined } as never,
      serverPrincipal: () => "local-operator",
      runtimeHost,
    });

    expect(
      control.gitDeliveryDescriptionAuthority?.current(scope, "2026-01-01T00:05:00.000Z"),
    ).toMatchObject({ effectiveMode: "supervised-coding" });
    // Re-checking a scope that was never minted stays fail-closed — the port never widens.
    expect(
      control.gitDeliveryDescriptionAuthority?.current(
        { ...scope, snapshotDigest: "c".repeat(64) },
        "2026-01-01T00:05:00.000Z",
      ),
    ).toBeUndefined();
  });
});

function unqualifiedManager(): ReturnType<CodingRuntimeHost["createManager"]> {
  return {
    start: () => ({ ok: false, failureCode: "runtime-unqualified", retryable: false }),
    issueApproval: () => ({ ok: false, failureCode: "runtime-stopped", retryable: false }),
    pause: () => ({ ok: false, failureCode: "runtime-run-mismatch", retryable: false }),
    resume: () => ({ ok: false, failureCode: "runtime-run-mismatch", retryable: false }),
    stop: () =>
      Promise.resolve({ ok: false, failureCode: "runtime-run-mismatch", retryable: false }),
    takeover: () =>
      Promise.resolve({ ok: false, failureCode: "runtime-run-mismatch", retryable: false }),
    reconcile: () =>
      Promise.resolve({ ok: false, failureCode: "runtime-run-mismatch", retryable: false }),
    health: () => ({ status: "stopped" }),
    pendingApprovalReview: () => undefined,
    result: () => undefined,
  };
}

function qualifiedLaunch(): ReturnType<CodingRuntimeHost["launchResolver"]["resolve"]> {
  return {
    taskRef: "task-1",
    treeBindingId: "tree-1",
    adapterKind: "codex-cli",
    runtimeSource: "codex-cli-adapter",
    modelSource: "keiko-model-gateway",
    effectiveMode: "supervised-coding",
    executablePath: "/managed/runtime",
    managedRoot: "/managed",
    gatewayUrl: "http://127.0.0.1:4317",
    modelProfileId: "qualified-profile",
    args: [],
    inheritedEnvAllowlist: [],
    shutdownTimeoutMs: 1_000,
    startTimeoutMs: 1_000,
  };
}
