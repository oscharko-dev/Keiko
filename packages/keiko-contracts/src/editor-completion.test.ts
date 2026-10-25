import { describe, expect, it } from "vitest";
import {
  EDITOR_COMPLETION_ITEM_ORIGINS,
  EDITOR_COMPLETION_SCHEMA_VERSION,
  EDITOR_COMPLETION_SOURCES,
  EDITOR_COMPLETION_WIRE_TRIGGER_KINDS,
  parseEditorCompletionRequest,
} from "./editor-completion.js";
import { EDITOR_AGENT_SESSION_ID_MAX_BYTES } from "./editor-agent.js";

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
      "workspace-snippet",
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

  it("retains a bounded editor session id when provided", () => {
    const editorSessionId = "a".repeat(EDITOR_AGENT_SESSION_ID_MAX_BYTES);
    const parsed = parseEditorCompletionRequest({ ...baseRequest(), editorSessionId });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.editorSessionId).toBe(editorSessionId);
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

  it("rejects malformed or oversized editor session ids", () => {
    for (const editorSessionId of [
      "",
      "   ",
      7,
      "\u{1f600}".repeat(Math.floor(EDITOR_AGENT_SESSION_ID_MAX_BYTES / 4) + 1),
    ]) {
      const parsed = parseEditorCompletionRequest({ ...baseRequest(), editorSessionId });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.errors).toContain(
        `editorSessionId must be a non-empty string of at most ${EDITOR_AGENT_SESSION_ID_MAX_BYTES.toString()} UTF-8 bytes when provided`,
      );
    }
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

// #3918 original-first public contract controls.
import * as publicOwner from "@oscharko-dev/keiko-contracts/runtime/editor-completion";

describe("#3918 actual public owner preservation", () => {
  it("retains the owning result and declared refusal", () => {
    const input = baseRequest();
    const parsed = publicOwner.parseEditorCompletionRequest(input);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.document).toBe(input.document);
    expect(parsed.value.position).toBe(input.position);
    expect(parsed.value.triggerKind).toBe("invoked");
    expect(Object.hasOwn(parsed.value, "editorSessionId")).toBe(false);
  });
});

// #3918 finite original-first observations.
describe("#3918 captured output root admission", () => {
  it.each([
    ["source", parseEditorCompletionRequest],
    ["public", publicOwner.parseEditorCompletionRequest],
  ])("%s refuses a malformed second root", (_surface, parse) => {
    const input = baseRequest();
    let reads = 0;
    Object.defineProperty(input, "root", { get: () => (++reads === 1 ? "/repo" : undefined) });
    expect(parse(input)).toEqual({ ok: false, errors: ["root must be a non-empty string"] });
    expect(reads).toBe(2);
  });
  it.each([
    ["source", parseEditorCompletionRequest],
    ["public", publicOwner.parseEditorCompletionRequest],
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

describe("#3918 trigger membership boundaries", () => {
  it.each([
    ["source", parseEditorCompletionRequest],
    ["public", publicOwner.parseEditorCompletionRequest],
  ] as const)("%s preserves trigger boundaries without coercion", (_surface, parse) => {
    for (const triggerKind of EDITOR_COMPLETION_WIRE_TRIGGER_KINDS) {
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
    for (const triggerKind of ["automatic", undefined, null, 7, Symbol("trigger"), coercible]) {
      expect(parse({ ...baseRequest(), triggerKind })).toEqual({
        ok: false,
        errors: ["triggerKind must be one of: invoked, trigger-character, incomplete"],
      });
    }
    expect(coercions).toBe(0);
  });
});

describe.each([
  ["source", parseEditorCompletionRequest],
  ["public", publicOwner.parseEditorCompletionRequest],
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
        "triggerKind must be one of: invoked, trigger-character, incomplete",
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
      "triggerCharacter",
      "contextBudgetBytes",
      "maxCostClass",
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
  ["source", parseEditorCompletionRequest],
  ["public", publicOwner.parseEditorCompletionRequest],
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
