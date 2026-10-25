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

async function physicalPermissionListValidator(
  surface: "source" | "public",
): Promise<typeof validateCodingWorkbenchPermissionRequest> {
  return surface === "source"
    ? validateCodingWorkbenchPermissionRequest
    : (await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation"))
        .validateCodingWorkbenchPermissionRequest;
}

function physicalConnectorPermission(connectorScopes: unknown): Record<string, unknown> {
  return {
    requestId: "perm-3918",
    kind: "connector-access",
    actionClass: "connector-access",
    reasonCode: "verification-required",
    expiresAt: "2026-07-19T00:00:00.000Z",
    connectorScopes,
  };
}

async function physicalEvidenceListErrors(
  surface: "source" | "public",
  taskRefs: unknown,
): Promise<readonly string[]> {
  const module =
    surface === "source"
      ? await import("./coding-workbench-validation.js")
      : await import("@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation");
  const result = module.validateCodingWorkbenchAuthorityEnvelope({ taskRefs });
  expect(result.ok).toBe(false);
  return result.ok
    ? []
    : result.errors.filter((error) => error.startsWith("authorityEnvelope.taskRefs"));
}

for (const surface of ["source", "public"] as const) {
  it(`${surface}: accepts a healthy connector list with original permission identity`, async () => {
    const validate = await physicalPermissionListValidator(surface);
    const value = physicalConnectorPermission(["source-control.read"]);
    const result = validate(value);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(value);
  });

  it(`${surface}: retains required empty connector-list diagnostics`, async () => {
    const validate = await physicalPermissionListValidator(surface);
    expect(validate(physicalConnectorPermission([]))).toEqual({
      ok: false,
      errors: ["permissionRequest.connectorScopes must not be empty"],
    });
  });

  it(`${surface}: preserves nonempty-before-enum connector diagnostics and eager order`, async () => {
    const validate = await physicalPermissionListValidator(surface);
    expect(validate(physicalConnectorPermission(["", "not-a-scope", 7]))).toEqual({
      ok: false,
      errors: [
        "permissionRequest.connectorScopes[0] must be a non-empty string",
        "permissionRequest.connectorScopes[1] is invalid",
        "permissionRequest.connectorScopes[2] must be a non-empty string",
      ],
    });
  });

  it(`${surface}: retains separate empty-check and captured-extent connector observations`, async () => {
    const validate = await physicalPermissionListValidator(surface);
    const reads: string[] = [];
    let lengths = 0;
    const members = new Proxy(["source-control.read"], {
      get(target, key, receiver): unknown {
        reads.push(`get:${String(key)}`);
        if (key === "length") return ++lengths === 1 ? 0 : 1;
        return Reflect.get(target, key, receiver);
      },
      has(target, key): boolean {
        reads.push(`has:${String(key)}`);
        return Reflect.has(target, key);
      },
    });
    expect(validate(physicalConnectorPermission(members))).toEqual({
      ok: false,
      errors: ["permissionRequest.connectorScopes must not be empty"],
    });
    expect(reads).toEqual(["get:length", "get:length", "has:0", "get:0"]);
  });

  it(`${surface}: stops connector traversal at a hole after an invalid member`, async () => {
    const validate = await physicalPermissionListValidator(surface);
    const members = new Array<unknown>(3);
    members[0] = "";
    Object.defineProperty(members, "2", {
      get: (): never => {
        throw new TypeError("Connector admission passed a hole");
      },
    });
    expect(validate(physicalConnectorPermission(members))).toEqual({
      ok: false,
      errors: [
        "permissionRequest.connectorScopes[0] must be a non-empty string",
        "permissionRequest.connectorScopes[1] must be a non-empty string",
      ],
    });
  });

  it(`${surface}: rejects non-array evidence without inspecting length`, async () => {
    const members = Object.defineProperty({}, "length", {
      get: (): never => {
        throw new TypeError("Non-array evidence length was inspected");
      },
    });
    expect(await physicalEvidenceListErrors(surface, members)).toEqual([
      "authorityEnvelope.taskRefs must be an array",
    ]);
  });

  it(`${surface}: retains required empty evidence diagnostics`, async () => {
    expect(await physicalEvidenceListErrors(surface, [])).toEqual([
      "authorityEnvelope.taskRefs must not be empty",
    ]);
  });

  it(`${surface}: retains evidence policy and immediate hole termination`, async () => {
    const members = new Array<unknown>(3);
    members[0] = "https://example.test/private";
    Object.defineProperty(members, "2", {
      get: (): never => {
        throw new TypeError("Evidence admission passed a hole");
      },
    });
    expect(await physicalEvidenceListErrors(surface, members)).toEqual([
      "authorityEnvelope.taskRefs[0] must be content-free evidence-safe text",
      "authorityEnvelope.taskRefs[1] must be content-free evidence-safe text",
    ]);
  });

  it(`${surface}: captures evidence extent and accepts inherited members before later growth`, async () => {
    const members = new Array<unknown>(1);
    Object.setPrototypeOf(
      members,
      Object.defineProperty([], "0", {
        get: (): string => {
          members.push(null);
          return "issue-3918";
        },
      }),
    );
    const reads: string[] = [];
    const observed = new Proxy(members, {
      get(target, key, receiver): unknown {
        reads.push(`get:${String(key)}`);
        return Reflect.get(target, key, receiver);
      },
      has(target, key): boolean {
        reads.push(`has:${String(key)}`);
        return Reflect.has(target, key);
      },
    });
    expect(await physicalEvidenceListErrors(surface, observed)).toEqual([]);
    expect(reads).toEqual(["get:length", "get:length", "has:0", "get:0"]);
    expect(members).toHaveLength(2);
  });
}
