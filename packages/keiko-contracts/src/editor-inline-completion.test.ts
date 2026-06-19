import { describe, expect, it } from "vitest";
import {
  EDITOR_INLINE_COMPLETION_SCHEMA_VERSION,
  EDITOR_INLINE_COMPLETION_TELEMETRY_SCHEMA_VERSION,
  EDITOR_INLINE_COMPLETION_WIRE_TRIGGER_KINDS,
  parseEditorInlineCompletionRequest,
  parseEditorInlineCompletionTelemetry,
} from "./editor-inline-completion.js";

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
  });

  it("rejects a non-object payload", () => {
    expect(parseEditorInlineCompletionTelemetry(undefined)).toMatchObject({ ok: false });
  });
});
