import { describe, expect, it } from "vitest";

import {
  validateCodingWorkbenchPermissionRequest,
  validateCodingWorkbenchRuntimeEvent,
} from "./coding-workbench-validation.js";

describe("coding workbench auxiliary event validation", () => {
  it("accepts a content-free skill event and rejects raw result content", () => {
    const event = {
      schemaVersion: "1",
      eventId: "evt-2387",
      runId: "run-2387",
      occurredAt: "2026-07-19T00:00:00.000Z",
      kind: "skill-invoked",
      skillId: "skl_repo-structure-summary@1",
      skillInvocation: "implicit",
      auxiliaryOutcome: "accepted",
    };
    expect(validateCodingWorkbenchRuntimeEvent(event).ok).toBe(true);
    expect(validateCodingWorkbenchRuntimeEvent({ ...event, result: "raw content" }).ok).toBe(false);
  });

  it("rejects impossible calendar dates instead of accepting their rolled-forward instants", () => {
    expect(
      validateCodingWorkbenchPermissionRequest({
        requestId: "perm-2387",
        kind: "workspace-write",
        actionClass: "workspace-write",
        reasonCode: "verification-required",
        expiresAt: "2026-02-31T00:00:00Z",
      }).ok,
    ).toBe(false);
    expect(
      validateCodingWorkbenchRuntimeEvent({
        schemaVersion: "1",
        eventId: "evt-2387",
        runId: "run-2387",
        occurredAt: "2026-04-31T00:00:00.000Z",
        kind: "skill-invoked",
        skillId: "skl_repo-structure-summary@1",
        skillInvocation: "implicit",
        auxiliaryOutcome: "accepted",
      }).ok,
    ).toBe(false);
  });
});

function runtimeHealthEvent(kind: string): Record<string, unknown> {
  return {
    schemaVersion: "1",
    eventId: "event-runtime-health-3918",
    runId: "run-3918",
    occurredAt: "2026-10-24T00:00:00.000Z",
    kind,
    runtimeSource: "keiko-sidecar",
    modelSource: "openai-api-key-through-gateway",
    health: "ready",
    ...(kind === "runtime-stopped" ? { effectiveMode: "governed-assist" } : {}),
  };
}

function changingRuntimeHealthEvent(kind: string, trace: string[]): Record<string, unknown> {
  const event = runtimeHealthEvent(kind);
  const reads = new Map<string, number>();
  const observed = (key: string, value: string, later: unknown): unknown => {
    trace.push(key);
    const count = (reads.get(key) ?? 0) + 1;
    reads.set(key, count);
    return count <= 2 ? value : later;
  };
  Object.defineProperties(event, {
    runtimeSource: { get: () => observed("runtimeSource", "keiko-sidecar", undefined) },
    modelSource: {
      get: () => observed("modelSource", "openai-api-key-through-gateway", "invalid"),
    },
    health: { get: () => observed("health", "ready", "invalid") },
  });
  return event;
}

describe("runtime health field admission preservation", () => {
  it.each(["source", "public"] as const)(
    "preserves admission and eager reads through %s",
    async (seam) => {
      const validate =
        seam === "source"
          ? validateCodingWorkbenchRuntimeEvent
          : (await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation"))
              .validateCodingWorkbenchRuntimeEvent;
      for (const kind of ["runtime-health", "runtime-stopped"]) {
        const event = runtimeHealthEvent(kind);
        const healthy = validate(event);
        expect(healthy.ok).toBe(true);
        if (healthy.ok) expect(healthy.value).toBe(event);
        const trace: string[] = [];
        expect(validate(changingRuntimeHealthEvent(kind, trace))).toEqual({
          ok: false,
          errors: [
            "event.runtimeSource is required",
            "event.modelSource is invalid",
            "event.health is invalid",
          ],
        });
        expect(trace).toEqual([
          "runtimeSource",
          "runtimeSource",
          "modelSource",
          "modelSource",
          "health",
          "health",
          "runtimeSource",
          "modelSource",
          "modelSource",
          "health",
          "health",
        ]);
      }
    },
  );

  it.each(["source", "public"] as const)(
    "retains stopped mode admission through %s",
    async (seam) => {
      const validate =
        seam === "source"
          ? validateCodingWorkbenchRuntimeEvent
          : (await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation"))
              .validateCodingWorkbenchRuntimeEvent;
      const event = {
        ...runtimeHealthEvent("runtime-health"),
        runtimeSource: undefined,
        modelSource: undefined,
        health: undefined,
      };
      const errors = [
        "event.runtimeSource is required",
        "event.modelSource is required",
        "event.health is required",
      ];
      expect(validate(event)).toEqual({ ok: false, errors });
      expect(validate({ ...event, kind: "runtime-stopped" })).toEqual({
        ok: false,
        errors: [...errors, "event.effectiveMode is required"],
      });
    },
  );
});
