import { describe, expect, it, vi } from "vitest";

import type { CodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts";

import type { CodingRuntimeStopResult } from "./codingRuntimeManager.js";
import { createProductionRuntimeEventRelay } from "./productionOpenCodeRuntimeResolver.js";

describe("production OpenCode runtime resolver", () => {
  it("cleans the resolver run slot before forwarding a stopped event", async () => {
    const stopped = runtimeStoppedEvent();
    const cleanup = deferred<CodingRuntimeStopResult>();
    const reconcile = vi.fn(() => cleanup.promise);
    const receiver = vi.fn<(event: CodingWorkbenchRuntimeEvent) => void>();
    const relay = createProductionRuntimeEventRelay({ reconcile }, () => receiver);

    relay(stopped);

    expect(reconcile).toHaveBeenCalledWith(stopped.runId);
    expect(receiver).not.toHaveBeenCalled();
    cleanup.resolve({ ok: true, status: "stopped" });
    await vi.waitFor(() => {
      expect(receiver).toHaveBeenCalledWith(stopped);
    });
  });

  it("projects cleanup failure without exposing a stopped terminal", async () => {
    const stopped = runtimeStoppedEvent();
    const reconcile = vi.fn<(runId: string) => Promise<CodingRuntimeStopResult>>(() =>
      Promise.resolve({
        ok: false as const,
        failureCode: "runtime-reap-unproven" as const,
        retryable: false as const,
      }),
    );
    const receiver = vi.fn<(event: CodingWorkbenchRuntimeEvent) => void>();
    const relay = createProductionRuntimeEventRelay({ reconcile }, () => receiver);

    relay(stopped);

    await vi.waitFor(() => {
      expect(receiver).toHaveBeenCalledOnce();
    });
    expect(receiver.mock.calls[0]?.[0]).toMatchObject({
      runId: stopped.runId,
      kind: "failure-redacted",
      failureCode: "failure-redacted",
      failureSummary: "runtime-failed",
      retryable: false,
    });
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function runtimeStoppedEvent(): CodingWorkbenchRuntimeEvent {
  return {
    schemaVersion: "1",
    eventId: "coding-runtime-run-2258-3",
    runId: "run-2258",
    occurredAt: "2026-07-13T12:00:00.000Z",
    kind: "runtime-stopped",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    effectiveMode: "supervised-coding",
    health: "stopped",
  };
}
