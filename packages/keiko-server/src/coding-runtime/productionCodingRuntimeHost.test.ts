import { describe, expect, it, vi } from "vitest";

import {
  createProductionCodingRuntimeHost,
  type QualifiedProductionCodingRuntime,
} from "./productionCodingRuntimeHost.js";

function qualifiedRuntime(): QualifiedProductionCodingRuntime {
  return {
    createManager: () => ({
      start: () => ({ ok: false, failureCode: "runtime-unqualified", retryable: false }),
      issueApproval: () => ({
        ok: false,
        failureCode: "runtime-stopped",
        retryable: false,
      }),
      pause: () => ({ ok: false, failureCode: "runtime-run-mismatch", retryable: false }),
      resume: () => ({ ok: false, failureCode: "runtime-run-mismatch", retryable: false }),
      stop: () => Promise.resolve({ ok: true, status: "stopped" }),
      takeover: () => Promise.resolve({ ok: true, status: "stopped" }),
      reconcile: () => Promise.resolve({ ok: true, status: "stopped" }),
      health: () => ({ status: "stopped" }),
      pendingApprovalReview: () => undefined,
    }),
    mintLaunch: {
      resolve: () => ({
        taskRef: "task-1",
        treeBindingId: "tree-1",
        adapterKind: "codex-cli",
        runtimeSource: "codex-cli-adapter",
        modelSource: "chatgpt-codex-subscription-profile",
        effectiveMode: "governed-assist",
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
      issue: () => ({ ok: false, failureCode: "runtime-stopped", retryable: false }),
    },
    taskDispatcher: {
      dispatch: () => Promise.resolve({ ok: true, completion: Promise.resolve("succeeded") }),
      abort: () => Promise.resolve(true),
    },
    cancellationRegistry: { signalFor: () => undefined },
  };
}

describe("production coding runtime host", () => {
  it("stays unavailable unless an explicit resolver returns a qualified runtime", () => {
    expect(createProductionCodingRuntimeHost()).toBeUndefined();
    expect(createProductionCodingRuntimeHost({ resolve: () => undefined })).toBeUndefined();
    expect(
      createProductionCodingRuntimeHost({
        resolve: () => {
          throw new Error("qualified backend unavailable");
        },
      }),
    ).toBeUndefined();
  });

  it("exposes only qualified server-owned lifecycle and turn ports", async () => {
    const runtime = qualifiedRuntime();
    const resolve = vi.fn(() => runtime);
    const host = createProductionCodingRuntimeHost({ resolve });

    expect(host).toBeDefined();
    expect(resolve).toHaveBeenCalledOnce();
    await expect(
      host?.taskDispatcher.dispatch({
        runId: "run-1",
        requestId: "request-1",
        expectedRevision: 1,
        taskIntent: "transient task",
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(Object.keys(host ?? {}).sort()).toEqual(
      [
        "approvalAuthority",
        "cancellationRegistry",
        "createManager",
        "launchResolver",
        "taskDispatcher",
      ].sort(),
    );
  });
});
