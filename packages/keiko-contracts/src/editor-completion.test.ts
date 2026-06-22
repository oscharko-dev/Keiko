import { describe, expect, it } from "vitest";
import {
  EDITOR_COMPLETION_ITEM_ORIGINS,
  EDITOR_COMPLETION_SCHEMA_VERSION,
  EDITOR_COMPLETION_SOURCES,
  EDITOR_COMPLETION_WIRE_TRIGGER_KINDS,
  parseEditorCompletionRequest,
} from "./editor-completion.js";

function baseRequest(): Record<string, unknown> {
  return {
    root: "/repo",
    document: { path: "src/a.ts", languageId: "typescript", text: "const a = 1;\n" },
    position: { line: 0, character: 6 },
    triggerKind: "invoked",
    contextBudgetBytes: 4096,
  };
}

describe("editor-completion constants", () => {
  it("pins the schema version", () => {
    expect(EDITOR_COMPLETION_SCHEMA_VERSION).toBe("1");
  });

  it("enumerates trigger kinds, item origins, and sources in a fixed order", () => {
    expect(EDITOR_COMPLETION_WIRE_TRIGGER_KINDS).toEqual([
      "invoked",
      "trigger-character",
      "incomplete",
    ]);
    expect(EDITOR_COMPLETION_ITEM_ORIGINS).toEqual(["deterministic", "model-assisted"]);
    expect(EDITOR_COMPLETION_SOURCES).toEqual([
      "deterministic-language-service",
      "model-assisted",
      "repository-context",
      "local-knowledge",
      "memory",
      "connected-context",
    ]);
  });
});

describe("parseEditorCompletionRequest — happy path", () => {
  it("accepts a minimal valid request and pins the schema version", () => {
    const parsed = parseEditorCompletionRequest(baseRequest());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.schemaVersion).toBe("1");
    expect(parsed.value.root).toBe("/repo");
    expect(parsed.value.triggerKind).toBe("invoked");
    expect(parsed.value.contextBudgetBytes).toBe(4096);
    expect(parsed.value.context).toBeUndefined();
    expect(parsed.value.triggerCharacter).toBeUndefined();
    expect(parsed.value.maxCostClass).toBeUndefined();
  });

  it("retains a trigger character and a cost ceiling when provided", () => {
    const parsed = parseEditorCompletionRequest({
      ...baseRequest(),
      triggerKind: "trigger-character",
      triggerCharacter: ".",
      maxCostClass: "medium",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.triggerCharacter).toBe(".");
    expect(parsed.value.maxCostClass).toBe("medium");
  });

  it("keeps only the supplied context selectors and drops an empty context object", () => {
    const parsed = parseEditorCompletionRequest({
      ...baseRequest(),
      context: { queryText: "render", changedFiles: ["src/b.ts"] },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.context).toEqual({ queryText: "render", changedFiles: ["src/b.ts"] });

    const empty = parseEditorCompletionRequest({ ...baseRequest(), context: {} });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.value.context).toBeUndefined();
  });
});

describe("parseEditorCompletionRequest — rejections", () => {
  it("rejects a non-object request", () => {
    const parsed = parseEditorCompletionRequest(null);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toContain("request must be an object");
  });

  it("reports one error per failed invariant", () => {
    const parsed = parseEditorCompletionRequest({
      root: "",
      document: { path: "", languageId: "typescript", text: "x" },
      position: { line: -1, character: 0 },
      triggerKind: "nope",
      contextBudgetBytes: -1,
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual(
      expect.arrayContaining([
        "root must be a non-empty string",
        "document must be { path, languageId, text }",
        "position must be { line, character }",
        expect.stringContaining("triggerKind must be one of"),
        "contextBudgetBytes must be a non-negative integer",
      ]),
    );
  });

  it("rejects a non-integer context budget", () => {
    const parsed = parseEditorCompletionRequest({ ...baseRequest(), contextBudgetBytes: 1.5 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toContain("contextBudgetBytes must be a non-negative integer");
  });

  it("rejects a non-string trigger character", () => {
    const parsed = parseEditorCompletionRequest({ ...baseRequest(), triggerCharacter: 1 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toContain("triggerCharacter must be a string when provided");
  });

  it("rejects an invalid cost ceiling", () => {
    const parsed = parseEditorCompletionRequest({ ...baseRequest(), maxCostClass: "huge" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toContain("maxCostClass must be one of: low, medium, high");
  });

  it("rejects a malformed context object and conflicting capsule selectors", () => {
    const malformed = parseEditorCompletionRequest({ ...baseRequest(), context: 5 });
    expect(malformed.ok).toBe(false);
    if (malformed.ok) return;
    expect(malformed.errors).toContain("context must be an object when provided");

    const conflicting = parseEditorCompletionRequest({
      ...baseRequest(),
      context: { capsuleId: "a", capsuleSetId: "b" },
    });
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.errors).toContain("context must not set both capsuleId and capsuleSetId");

    const badField = parseEditorCompletionRequest({
      ...baseRequest(),
      context: { queryText: 9, changedFiles: "no" },
    });
    expect(badField.ok).toBe(false);
    if (badField.ok) return;
    expect(badField.errors).toEqual(
      expect.arrayContaining([
        "context.queryText must be a string when provided",
        "context.changedFiles must be an array of strings when provided",
      ]),
    );
  });
});
