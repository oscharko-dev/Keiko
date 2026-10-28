import { describe, expect, it } from "vitest";
import {
  EDITOR_INLINE_COMPLETION_SCHEMA_VERSION,
  EDITOR_INLINE_COMPLETION_TELEMETRY_SCHEMA_VERSION,
  EDITOR_INLINE_COMPLETION_WIRE_TRIGGER_KINDS,
  parseEditorInlineCompletionRequest,
  parseEditorInlineCompletionTelemetry,
} from "./editor-inline-completion.js";
import { EDITOR_AGENT_SESSION_ID_MAX_BYTES } from "./editor-agent.js";
import {
  registerCapturedRequestIdentity,
  registerCapturedRootAdmission,
  registerDocumentRequestPrefix,
  registerRequestContextProjection,
  registerTriggerMembership,
} from "../../../tests/support/editor-request-parser-contract.js";

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
describe("#3918 captured output root admission", (): void => {
  registerCapturedRootAdmission(
    [
      ["source", parseEditorInlineCompletionRequest],
      ["public", publicOwner.parseEditorInlineCompletionRequest],
    ],
    baseRequest,
  );
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

describe("#3918 trigger membership boundaries", (): void => {
  registerTriggerMembership(
    [
      ["source", parseEditorInlineCompletionRequest],
      ["public", publicOwner.parseEditorInlineCompletionRequest],
    ],
    baseRequest,
    EDITOR_INLINE_COMPLETION_WIRE_TRIGGER_KINDS,
    "invoked",
    "triggerKind must be one of: automatic, explicit",
  );
});

describe.each([
  ["source", parseEditorInlineCompletionRequest],
  ["public", publicOwner.parseEditorInlineCompletionRequest],
] as const)("#3918 eager document-request prefix through %s", (_surface, parse) => {
  registerDocumentRequestPrefix(
    parse,
    baseRequest,
    "triggerKind must be one of: automatic, explicit",
    [
      "root",
      "editorSessionId",
      "document",
      "position",
      "triggerKind",
      "contextBudgetBytes",
      "maxCostClass",
      "maxOutputTokens",
      "context",
    ],
  );
});

describe.each([
  ["source", parseEditorInlineCompletionRequest],
  ["public", publicOwner.parseEditorInlineCompletionRequest],
] as const)("#3918 captured request identity through %s", (_surface, parse) => {
  registerCapturedRequestIdentity(parse, baseRequest, "document");
});

describe.each([
  ["source", parseEditorInlineCompletionRequest],
  ["public", publicOwner.parseEditorInlineCompletionRequest],
] as const)("%s parser admission and context projection", (_surface, parse): void => {
  registerRequestContextProjection(parse, baseRequest, "document");
});
