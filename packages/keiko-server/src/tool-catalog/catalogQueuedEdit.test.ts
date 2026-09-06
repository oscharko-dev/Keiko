import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createCodingToolInvocationRegistry } from "../coding-runtime/codingToolInvocationRegistry.js";
import { createCodingRuntimeEditorMutationLeaseCoordinator } from "../coding-runtime/codingRuntimeEditorMutationLeaseCoordinator.js";
import { createCodingToolReadEditPorts } from "../coding-runtime/codingToolReadEditPorts.js";
import type { CodingToolActionRequest, CodingToolResult } from "../coding-runtime/codingToolIpc.js";
import { createBufferedServerLogSink } from "../observability/server-log.js";
import { defaultServerDiagnosticSink } from "../diagnostics-log.js";
import { createCanonicalCatalogFacadeBridge } from "./catalogToolFacadeBridge.js";

const binding = {
  runId: "run-queued-edit",
  envelopeDigest: "a".repeat(64),
  workspaceId: "workspace-1",
  workspaceRootDigest: "b".repeat(64),
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const request: Extract<CodingToolActionRequest, { action: "edit" }> = {
  action: "edit",
  actionId: "edit-1",
  idempotencyKey: "edit-key-1",
  changeset: {
    patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
    files: [{ file: "a.ts", expectedContentHash: "c".repeat(64) }],
  },
};
const leaseRequest = {
  authorityRef: { runId: binding.runId, envelopeDigest: binding.envelopeDigest },
  workspaceRootDigest: binding.workspaceRootDigest,
  actionId: request.actionId,
  idempotencyKey: request.idempotencyKey,
};

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => {
    throw new Error("Deferred was not initialized");
  };
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function fixture(): {
  coordinator: ReturnType<typeof createCodingRuntimeEditorMutationLeaseCoordinator>;
  bridge: ReturnType<typeof createCanonicalCatalogFacadeBridge>;
  ports: ReturnType<typeof createCodingToolReadEditPorts>;
  queued: ReturnType<typeof deferred>;
  log: ReturnType<typeof createBufferedServerLogSink>;
} {
  const invocationRegistry = createCodingToolInvocationRegistry();
  const coordinator = createCodingRuntimeEditorMutationLeaseCoordinator({
    invocationRegistry,
    cancelPendingByAuthorityRun: () => 0,
  });
  const log = createBufferedServerLogSink();
  const bridge = createCanonicalCatalogFacadeBridge({
    authority: {
      admit: () => ({ ok: true, mutationGuard: { check: (): boolean => true, binding } }),
    },
    previewAuthority: () => ({ ok: true }),
    invocationRegistry,
    context: () => ({
      runId: binding.runId,
      correlationId: binding.runId,
      workspaceRoot: "/workspace",
      workspaceIdentity: binding.workspaceId,
      workspaceRevision: binding.workspaceRootDigest,
      authorityExpiresAt: binding.expiresAt,
      now: Date.now(),
    }),
    logPort: { primary: log, diagnostics: defaultServerDiagnosticSink },
    approvalAvailable: false,
  });
  const queued = deferred();
  const ports = createCodingToolReadEditPorts({
    activityLog: log,
    secureWorkspaceTextRead: { readText: vi.fn() },
    editorAgentClient: {
      action: (action) => {
        queued.resolve();
        return Promise.resolve({
          ok: true,
          value: {
            result: {
              schemaVersion: "1",
              actionId: action.actionId,
              sessionId: action.sessionId,
              status: "queued",
            },
          },
        });
      },
    },
    mutationLeaseCoordinator: coordinator,
    resolveEditorActionContext: () => ({
      sessionId: "workbench-session",
      authorityRef: leaseRequest.authorityRef,
      origin: "agent",
      workspaceId: binding.workspaceId,
      workspaceRootDigest: binding.workspaceRootDigest,
      expiresAt: binding.expiresAt,
    }),
  });
  return { coordinator, bridge, ports, queued, log };
}

function dispatch(
  test: ReturnType<typeof fixture>,
  signal?: AbortSignal,
): Promise<CodingToolResult> {
  return test.bridge.execute(
    request,
    {
      body: JSON.stringify(request),
      capability: "test-capability",
      ...(signal === undefined ? {} : { signal }),
    },
    async (invocationSignal, guard): Promise<CodingToolResult> => {
      const result = await test.ports.editorChangeset.execute(request, invocationSignal, guard);
      return result.status === "completed"
        ? { status: "completed", evidence: [] }
        : { status: "failed", evidence: [] };
    },
  );
}

describe("queued editor effects keep their canonical invocation live", () => {
  it.each([true, false])(
    "settles only the real editor verdict (succeeded=%s)",
    async (succeeded) => {
      const test = fixture();
      let settled = false;
      const task = dispatch(test).then((result) => {
        settled = true;
        return result;
      });
      try {
        await test.queued.promise;
        await setImmediate();
        expect(settled).toBe(false);
        expect(
          test.log.events.filter((event) => event.op === "tool-catalog.invocation-settled"),
        ).toHaveLength(0);
        expect(test.coordinator.lease.claim(leaseRequest)).toBe(true);
        expect(test.coordinator.lease.complete(leaseRequest, succeeded)).toBe(true);
        expect((await task).status).toBe(succeeded ? "completed" : "failed");
        expect(test.coordinator.lease.claim(leaseRequest)).toBe(false);
        expect(
          test.log.events.filter((event) => event.op === "coding-runtime.editor-mutation.settled"),
        ).toMatchObject([
          { correlationId: binding.runId, extra: { state: succeeded ? "succeeded" : "failed" } },
        ]);
        expect(
          test.log.events.filter((event) => event.op === "tool-catalog.invocation-settled"),
        ).toMatchObject([
          { correlationId: binding.runId, extra: { status: succeeded ? "completed" : "failed" } },
        ]);
      } finally {
        test.coordinator.dispose();
        await task;
      }
    },
  );
  it("cancels the pending invocation and refuses a late editor claim", async () => {
    const test = fixture();
    const controller = new AbortController();
    const task = dispatch(test, controller.signal);
    try {
      await test.queued.promise;
      controller.abort();
      expect((await task).status).toBe("cancelled");
      expect(test.coordinator.lease.claim(leaseRequest)).toBe(false);
      await setImmediate();
      expect(
        test.log.events.filter((event) => event.op === "tool-catalog.invocation-settled"),
      ).toMatchObject([{ correlationId: binding.runId, extra: { status: "cancelled" } }]);
    } finally {
      test.coordinator.dispose();
      await task;
    }
  });
});
