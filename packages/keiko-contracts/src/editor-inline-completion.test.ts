import { describe, expect, it } from "vitest";
import {
  EDITOR_INLINE_COMPLETION_SCHEMA_VERSION,
  EDITOR_INLINE_COMPLETION_TELEMETRY_SCHEMA_VERSION,
  EDITOR_INLINE_COMPLETION_WIRE_TRIGGER_KINDS,
  parseEditorInlineCompletionRequest,
  parseEditorInlineCompletionTelemetry,
} from "./editor-inline-completion.js";
import { EDITOR_AGENT_SESSION_ID_MAX_BYTES } from "./editor-agent.js";

function baseRequest(): Record<string, unknown> {
  return {
    root: "/repo",
    document: { path: "src/a.ts", languageId: "typescript", text: "const a = 1;\n" },
    position: { line: 0, character: 6 },
    triggerKind: "automatic",
    contextBudgetBytes: 8192,
  };
}

function baseTelemetry(): Record<string, unknown> {
  return {
    root: "/repo",
    offered: 5,
    shown: 4,
    accepted: 2,
    rejected: 1,
    ignored: 1,
    partiallyAccepted: 1,
    requestCount: 6,
    requestLatencyMsP50: 42,
    requestLatencyMsP95: 120,
  };
}

describe("editor-inline-completion constants", () => {
  it("pins the schema versions", () => {
    expect(EDITOR_INLINE_COMPLETION_SCHEMA_VERSION).toBe("1");
    expect(EDITOR_INLINE_COMPLETION_TELEMETRY_SCHEMA_VERSION).toBe("1");
  });

  it("enumerates inline trigger kinds in a fixed order", () => {
    expect(EDITOR_INLINE_COMPLETION_WIRE_TRIGGER_KINDS).toEqual(["automatic", "explicit"]);
  });
});

describe("parseEditorInlineCompletionRequest — happy path", () => {
  it("accepts a minimal valid request and pins the schema version", () => {
    const parsed = parseEditorInlineCompletionRequest(baseRequest());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.schemaVersion).toBe("1");
    expect(parsed.value.root).toBe("/repo");
    expect(parsed.value.triggerKind).toBe("automatic");
    expect(parsed.value.contextBudgetBytes).toBe(8192);
    expect(parsed.value.context).toBeUndefined();
    expect(parsed.value.maxCostClass).toBeUndefined();
    expect(parsed.value.maxOutputTokens).toBeUndefined();
  });

  it("retains an explicit trigger, a cost ceiling, and an output-token bound", () => {
    const parsed = parseEditorInlineCompletionRequest({
      ...baseRequest(),
      triggerKind: "explicit",
      maxCostClass: "low",
      maxOutputTokens: 128,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.triggerKind).toBe("explicit");
    expect(parsed.value.maxCostClass).toBe("low");
    expect(parsed.value.maxOutputTokens).toBe(128);
  });

  it("retains a bounded editor session id when provided", () => {
    const parsed = parseEditorInlineCompletionRequest({
      ...baseRequest(),
      editorSessionId: "editor-session-1",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.editorSessionId).toBe("editor-session-1");
  });

  it("retains content selectors when at least one is set", () => {
    const parsed = parseEditorInlineCompletionRequest({
      ...baseRequest(),
      context: { queryText: "fetchUser", changedFiles: ["src/b.ts"], capsuleId: "cap-1" },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.context).toEqual({
      queryText: "fetchUser",
      changedFiles: ["src/b.ts"],
      capsuleId: "cap-1",
    });
  });

  it("drops an empty context object to undefined", () => {
    const parsed = parseEditorInlineCompletionRequest({ ...baseRequest(), context: {} });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.context).toBeUndefined();
  });
});

describe("parseEditorInlineCompletionRequest — rejections", () => {
  it("rejects a non-object payload", () => {
    expect(parseEditorInlineCompletionRequest(null)).toMatchObject({ ok: false });
    expect(parseEditorInlineCompletionRequest("x")).toMatchObject({ ok: false });
    expect(parseEditorInlineCompletionRequest([])).toMatchObject({ ok: false });
  });

  it("rejects a missing root", () => {
    const rest = baseRequest();
    delete rest.root;
    const parsed = parseEditorInlineCompletionRequest(rest);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toContain("root must be a non-empty string");
  });

  it("rejects a malformed document overlay and position", () => {
    const parsed = parseEditorInlineCompletionRequest({
      ...baseRequest(),
      document: { path: "a.ts" },
      position: { line: 0 },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toContain("document must be { path, languageId, text }");
    expect(parsed.errors).toContain("position must be { line, character }");
  });

  it("rejects an unknown trigger kind (the dropdown 'invoked' kind is not an inline kind)", () => {
    const parsed = parseEditorInlineCompletionRequest({ ...baseRequest(), triggerKind: "invoked" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.some((e) => e.startsWith("triggerKind must be one of"))).toBe(true);
  });

  it("rejects a negative or non-integer context budget", () => {
    expect(
      parseEditorInlineCompletionRequest({ ...baseRequest(), contextBudgetBytes: -1 }),
    ).toMatchObject({ ok: false });
    expect(
      parseEditorInlineCompletionRequest({ ...baseRequest(), contextBudgetBytes: 1.5 }),
    ).toMatchObject({ ok: false });
  });

  it("rejects an invalid cost class and a non-positive output-token bound", () => {
    expect(
      parseEditorInlineCompletionRequest({ ...baseRequest(), maxCostClass: "huge" }),
    ).toMatchObject({ ok: false });
    expect(
      parseEditorInlineCompletionRequest({ ...baseRequest(), maxOutputTokens: 0 }),
    ).toMatchObject({ ok: false });
  });

  it("rejects malformed or oversized editor session ids", () => {
    for (const editorSessionId of [
      "",
      "   ",
      false,
      "x".repeat(EDITOR_AGENT_SESSION_ID_MAX_BYTES + 1),
    ]) {
      const parsed = parseEditorInlineCompletionRequest({ ...baseRequest(), editorSessionId });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.errors).toContain(
        `editorSessionId must be a non-empty string of at most ${EDITOR_AGENT_SESSION_ID_MAX_BYTES.toString()} UTF-8 bytes when provided`,
      );
    }
  });

  it("rejects setting both capsuleId and capsuleSetId", () => {
    const parsed = parseEditorInlineCompletionRequest({
      ...baseRequest(),
      context: { capsuleId: "a", capsuleSetId: "b" },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toContain("context must not set both capsuleId and capsuleSetId");
  });
});

describe("parseEditorInlineCompletionTelemetry", () => {
  it("accepts a valid content-free report", () => {
    const parsed = parseEditorInlineCompletionTelemetry(baseTelemetry());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.schemaVersion).toBe("1");
    expect(parsed.value.accepted).toBe(2);
    expect(parsed.value.rejected).toBe(1);
    expect(parsed.value.shown).toBe(4);
    expect(parsed.value.requestCount).toBe(6);
    expect(parsed.value.requestLatencyMsP50).toBe(42);
    expect(parsed.value.requestLatencyMsP95).toBe(120);
  });

  it("defaults omitted latency fields for older rollout snapshots", () => {
    const telemetry = baseTelemetry();
    delete telemetry.requestCount;
    delete telemetry.requestLatencyMsP50;
    delete telemetry.requestLatencyMsP95;
    const parsed = parseEditorInlineCompletionTelemetry(telemetry);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.requestCount).toBe(0);
    expect(parsed.value.requestLatencyMsP50).toBe(0);
    expect(parsed.value.requestLatencyMsP95).toBe(0);
  });

  it("rejects a missing root", () => {
    const rest = baseTelemetry();
    delete rest.root;
    expect(parseEditorInlineCompletionTelemetry(rest)).toMatchObject({ ok: false });
  });

  it("rejects negative or non-integer counts", () => {
    expect(
      parseEditorInlineCompletionTelemetry({ ...baseTelemetry(), accepted: -1 }),
    ).toMatchObject({ ok: false });
    expect(parseEditorInlineCompletionTelemetry({ ...baseTelemetry(), shown: 2.5 })).toMatchObject({
      ok: false,
    });
    expect(
      parseEditorInlineCompletionTelemetry({ ...baseTelemetry(), requestLatencyMsP95: -1 }),
    ).toMatchObject({ ok: false });
  });

  it("rejects inverted latency percentiles", () => {
    expect(
      parseEditorInlineCompletionTelemetry({
        ...baseTelemetry(),
        requestLatencyMsP50: 100,
        requestLatencyMsP95: 80,
      }),
    ).toMatchObject({ ok: false });
  });

  it("rejects a non-object payload", () => {
    expect(parseEditorInlineCompletionTelemetry(undefined)).toMatchObject({ ok: false });
  });
});

// #3918 original-first public contract controls.
import * as publicOwner from "@oscharko-dev/keiko-contracts/runtime/editor-inline-completion";

describe("#3918 actual public owner preservation", () => {
  it("retains the owning result and declared refusal", () => {
    const input = baseRequest();
    const parsed = publicOwner.parseEditorInlineCompletionRequest(input);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.document).toBe(input.document);
    expect(parsed.value.triggerKind).toBe("automatic");
    const telemetry = publicOwner.parseEditorInlineCompletionTelemetry(baseTelemetry());
    expect(telemetry.ok).toBe(true);
    if (telemetry.ok) expect(telemetry.value.requestLatencyMsP95).toBe(120);
  });
});

// #3918 finite original-first observations.
describe("#3918 captured output root admission", () => {
  it.each([
    ["source", parseEditorInlineCompletionRequest],
    ["public", publicOwner.parseEditorInlineCompletionRequest],
  ])("%s refuses a malformed second root", (_surface, parse) => {
    const input = baseRequest();
    let reads = 0;
    Object.defineProperty(input, "root", { get: () => (++reads === 1 ? "/repo" : undefined) });
    expect(parse(input)).toEqual({ ok: false, errors: ["root must be a non-empty string"] });
    expect(reads).toBe(2);
  });
  it.each([
    ["source", parseEditorInlineCompletionRequest],
    ["public", publicOwner.parseEditorInlineCompletionRequest],
  ])("%s keeps a valid changed second root", (_surface, parse) => {
    const input = baseRequest();
    let reads = 0;
    Object.defineProperty(input, "root", { get: () => (++reads === 1 ? "/repo" : "/other") });
    const parsed = parse(input);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.root).toBe("/other");
    expect(reads).toBe(2);
  });
});

describe.each([
  ["source", parseEditorInlineCompletionTelemetry],
  ["public", publicOwner.parseEditorInlineCompletionTelemetry],
] as const)("3918 original-first final telemetry relation %s", (_surface, parse) => {
  it("refuses inversion on the actual final metric observations", () => {
    let p50Reads = 0;
    let p95Reads = 0;
    const input = baseTelemetry();
    Object.defineProperty(input, "requestLatencyMsP50", {
      get(): number {
        p50Reads += 1;
        return p50Reads <= 4 ? 42 : 200;
      },
    });
    Object.defineProperty(input, "requestLatencyMsP95", {
      get(): number {
        p95Reads += 1;
        return p95Reads <= 4 ? 120 : 100;
      },
    });
    expect(parse(input)).toEqual({
      ok: false,
      errors: ["requestLatencyMsP95 must be greater than or equal to requestLatencyMsP50"],
    });
  });
  it("retains valid changing metrics and legacy omitted defaults", () => {
    const input = baseTelemetry();
    let reads = 0;
    Object.defineProperty(input, "requestLatencyMsP50", {
      get(): number {
        reads += 1;
        return reads <= 4 ? 42 : 50;
      },
    });
    expect(parse(input)).toMatchObject({
      ok: true,
      value: { requestLatencyMsP50: 50, requestLatencyMsP95: 120 },
    });
    const legacy = baseTelemetry();
    delete legacy.requestLatencyMsP50;
    delete legacy.requestLatencyMsP95;
    expect(parse(legacy)).toMatchObject({
      ok: true,
      value: { requestLatencyMsP50: 0, requestLatencyMsP95: 0 },
    });
  });
});

describe.each([
  ["source", parseEditorInlineCompletionTelemetry],
  ["public", publicOwner.parseEditorInlineCompletionTelemetry],
] as const)("3918 individual legacy latency omission %s", (_surface, parse) => {
  it("preserves an omitted p95 while p50 remains supplied", () => {
    const value = baseTelemetry();
    delete value.requestLatencyMsP95;
    expect(parse(value)).toMatchObject({
      ok: true,
      value: { requestLatencyMsP50: 42, requestLatencyMsP95: 0 },
    });
  });
});

describe("#3918 trigger membership boundaries", () => {
  it.each([
    ["source", parseEditorInlineCompletionRequest],
    ["public", publicOwner.parseEditorInlineCompletionRequest],
  ] as const)("%s preserves trigger boundaries without coercion", (_surface, parse) => {
    for (const triggerKind of EDITOR_INLINE_COMPLETION_WIRE_TRIGGER_KINDS) {
      const parsed = parse({ ...baseRequest(), triggerKind });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.triggerKind).toBe(triggerKind);
    }

    let coercions = 0;
    const coercible = {
      [Symbol.toPrimitive](): string {
        coercions += 1;
        throw new TypeError("trigger coercion must not occur");
      },
    };
    for (const triggerKind of ["invoked", undefined, null, 7, Symbol("trigger"), coercible]) {
      expect(parse({ ...baseRequest(), triggerKind })).toEqual({
        ok: false,
        errors: ["triggerKind must be one of: automatic, explicit"],
      });
    }
    expect(coercions).toBe(0);
  });
});

describe.each([
  ["source", parseEditorInlineCompletionRequest],
  ["public", publicOwner.parseEditorInlineCompletionRequest],
] as const)("#3918 eager document-request prefix through %s", (_surface, parse) => {
  it("preserves ordered prefix diagnostics before local request diagnostics", () => {
    expect(
      parse({
        ...baseRequest(),
        root: "",
        editorSessionId: "",
        document: null,
        position: null,
        triggerKind: "foreign",
        contextBudgetBytes: -1,
        maxCostClass: "unknown",
        context: 7,
      }),
    ).toEqual({
      ok: false,
      errors: [
        "root must be a non-empty string",
        `editorSessionId must be a non-empty string of at most ${EDITOR_AGENT_SESSION_ID_MAX_BYTES.toString()} UTF-8 bytes when provided`,
        "document must be { path, languageId, text }",
        "position must be { line, character }",
        "triggerKind must be one of: automatic, explicit",
        "contextBudgetBytes must be a non-negative integer",
        "maxCostClass must be one of: low, medium, high",
        "context must be an object when provided",
      ],
    });
  });

  it("continues eager prefix observations after root refusal and retains healthy references", () => {
    const reads: string[] = [];
    const input = new Proxy(
      { ...baseRequest(), root: "", editorSessionId: "session" },
      {
        get(target, key, receiver): unknown {
          if (typeof key === "string") reads.push(key);
          const member: unknown = Reflect.get(target, key, receiver);
          return member;
        },
      },
    );
    expect(parse(input)).toEqual({ ok: false, errors: ["root must be a non-empty string"] });
    expect(reads).toEqual([
      "root",
      "editorSessionId",
      "document",
      "position",
      "triggerKind",
      "contextBudgetBytes",
      "maxCostClass",
      "maxOutputTokens",
      "context",
    ]);
    const healthy = baseRequest();
    const parsed = parse(healthy);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.document).toBe(healthy.document);
      expect(parsed.value.position).toBe(healthy.position);
    }
  });

  it("propagates the same inherited document getter failure before position and local fields", () => {
    const failure = new TypeError("opaque document-prefix inspection");
    const reads: string[] = [];
    const values: Record<string, unknown> = {
      ...baseRequest(),
      root: "",
      editorSessionId: "session",
    };
    delete values.document;
    Object.setPrototypeOf(values, {
      get document(): never {
        throw failure;
      },
    });
    const input = new Proxy(values, {
      get(target, key, receiver): unknown {
        if (typeof key === "string") reads.push(key);
        const member: unknown = Reflect.get(target, key, receiver);
        return member;
      },
    });
    let observed: unknown;
    try {
      parse(input);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(failure);
    expect(reads).toEqual(["root", "editorSessionId", "document"]);
  });
});

describe.each([
  ["source", parseEditorInlineCompletionRequest],
  ["public", publicOwner.parseEditorInlineCompletionRequest],
] as const)("#3918 captured request identity through %s", (_surface, parse) => {
  it("keeps changing inherited session reads, capture order and nested references", () => {
    const input = baseRequest();
    const body = input.document;
    const reads: string[] = [];
    let sessions = 0;
    Object.defineProperty(input, "root", {
      get(): string {
        reads.push("root");
        return "/repo";
      },
    });
    Object.defineProperty(input, "document", {
      get(): unknown {
        reads.push("document");
        return body;
      },
    });
    const inherited = {};
    Object.defineProperty(inherited, "editorSessionId", {
      get(this: object): string {
        expect(this).toBe(input);
        sessions += 1;
        reads.push(`session:${sessions.toString()}`);
        return sessions === 3 ? "captured-session" : "checked-session";
      },
    });
    Object.setPrototypeOf(input, inherited);
    const parsed = parse(input);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.root).toBe("/repo");
      expect(parsed.value.editorSessionId).toBe("captured-session");
      expect(parsed.value.document).toBe(body);
      expect(Object.keys(parsed.value).slice(0, 4)).toEqual([
        "schemaVersion",
        "root",
        "editorSessionId",
        "document",
      ]);
    }
    expect(reads).toEqual([
      "root",
      "session:1",
      "document",
      "root",
      "session:2",
      "session:3",
      "document",
    ]);
  });

  it("distinguishes absent, guard-refused and captured own undefined sessions", () => {
    const absent = baseRequest();
    let absentReads = 0;
    Object.defineProperty(absent, "editorSessionId", {
      get(): undefined {
        absentReads += 1;
        return undefined;
      },
    });
    const omitted = parse(absent);
    expect(omitted.ok).toBe(true);
    if (omitted.ok) expect(Object.hasOwn(omitted.value, "editorSessionId")).toBe(false);
    expect(absentReads).toBe(2);
    for (const mode of ["guard-refused", "captured-undefined"] as const) {
      const input = baseRequest();
      let reads = 0;
      Object.defineProperty(input, "editorSessionId", {
        get(): unknown {
          reads += 1;
          if (reads === 1) return "initial-session";
          if (reads === 2) return mode === "guard-refused" ? "" : "checked-session";
          return undefined;
        },
      });
      const parsed = parse(input);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(Object.hasOwn(parsed.value, "editorSessionId")).toBe(mode === "captured-undefined");
        expect(parsed.value.editorSessionId).toBeUndefined();
      }
      expect(reads).toBe(mode === "guard-refused" ? 2 : 3);
    }
  });

  it("refuses a malformed third session observation through the existing final predicate", () => {
    const input = baseRequest();
    let reads = 0;
    Object.defineProperty(input, "editorSessionId", {
      get(): unknown {
        reads += 1;
        return reads === 3 ? 17 : "checked-session";
      },
    });
    expect(parse(input)).toEqual({
      ok: false,
      errors: [
        `editorSessionId must be a non-empty string of at most ${EDITOR_AGENT_SESSION_ID_MAX_BYTES.toString()} UTF-8 bytes when provided`,
      ],
    });
    expect(reads).toBe(3);
  });

  it("preserves opaque capture faults and continues capture after an invalid second root", () => {
    for (const fault of ["root-second", "session-third"] as const) {
      const input = baseRequest();
      const body = input.document;
      const failure = new TypeError("opaque identity capture");
      const reads: string[] = [];
      let roots = 0;
      let sessions = 0;
      Object.defineProperty(input, "root", {
        get(): unknown {
          roots += 1;
          reads.push(`root:${roots.toString()}`);
          if (roots === 1) return "/repo";
          if (fault === "root-second") throw failure;
          return undefined;
        },
      });
      Object.defineProperty(input, "editorSessionId", {
        get(): string {
          sessions += 1;
          reads.push(`session:${sessions.toString()}`);
          if (sessions === 3) throw failure;
          return "checked-session";
        },
      });
      Object.defineProperty(input, "document", {
        get(): unknown {
          reads.push("document");
          return body;
        },
      });
      let observed: unknown;
      try {
        parse(input);
      } catch (error) {
        observed = error;
      }
      expect(observed).toBe(failure);
      expect(reads).toEqual(
        fault === "root-second"
          ? ["root:1", "session:1", "document", "root:2"]
          : ["root:1", "session:1", "document", "root:2", "session:2", "session:3"],
      );
    }
  });
});
