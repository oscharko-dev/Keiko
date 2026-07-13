/* eslint-disable @typescript-eslint/explicit-function-return-type -- Local test fixture callbacks are contextually typed. */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { runMigrations } from "../store/schema.js";
import { createCodingRuntimeControlPlane } from "./codingRuntimeControlPlane.js";
import { createCodingRuntimeEvidenceAggregator } from "./codingRuntimeEvidenceAggregator.js";
import { createCodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";

describe("coding runtime control plane", () => {
  it("constructs one fail-closed aggregate when no runtime host is qualified", async () => {
    const snapshots = {
      create: vi.fn(),
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
    await expect(
      control.orchestrator.start({
        requestId: "request-1",
        taskIntent: "bounded intent",
        requestedMode: "supervised-coding",
      }),
    ).resolves.toEqual({ ok: false, failureCode: "authority-resolution-failed" });
    expect(snapshots.create).not.toHaveBeenCalled();
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
});
