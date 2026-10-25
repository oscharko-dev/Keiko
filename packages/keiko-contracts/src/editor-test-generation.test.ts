import { describe, expect, it } from "vitest";
import {
  EDITOR_TEST_GENERATION_GATE_STATES,
  EDITOR_TEST_GENERATION_MAX_OVERLAYS,
  EDITOR_TEST_GENERATION_MAX_OVERLAY_TEXT_BYTES,
  EDITOR_TEST_GENERATION_SCHEMA_VERSION,
  EDITOR_TEST_GENERATION_STABILITY_RUNS,
  EDITOR_TEST_GENERATION_STATUSES,
  EDITOR_TEST_GENERATION_TARGET_KINDS,
  notRunTestGenerationFunnel,
  parseEditorTestGenerationRequest,
} from "./editor-test-generation.js";
import { EDITOR_AGENT_SESSION_ID_MAX_BYTES } from "./editor-agent.js";

const OVERLAY = { path: "src/a.ts", languageId: "typescript", text: "export const a = 1;\n" };
const RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };

function fileRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: EDITOR_TEST_GENERATION_SCHEMA_VERSION,
    root: "/ws",
    target: { kind: "file", document: OVERLAY },
    contextBudgetBytes: 1_024,
    ...overrides,
  };
}

describe("parseEditorTestGenerationRequest — valid targets", () => {
  it("accepts a file target", () => {
    const parsed = parseEditorTestGenerationRequest(fileRequest());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.target.kind).toBe("file");
      expect(parsed.value.contextBudgetBytes).toBe(1_024);
    }
  });

  it("accepts selection, symbol, changed-file-set, and frontend-component targets", () => {
    const targets = [
      { kind: "selection", document: OVERLAY, range: RANGE },
      { kind: "symbol", document: OVERLAY, symbol: { name: "add", range: RANGE } },
      { kind: "changed-file-set", documents: [OVERLAY] },
      { kind: "frontend-component", document: OVERLAY, componentName: "Button" },
    ];
    for (const target of targets) {
      const parsed = parseEditorTestGenerationRequest(fileRequest({ target }));
      expect(parsed.ok).toBe(true);
    }
  });

  it("keeps valid context selectors and drops an empty selector object", () => {
    const withContext = parseEditorTestGenerationRequest(
      fileRequest({ context: { queryText: "edge cases", capsuleId: "cap-1" } }),
    );
    expect(withContext.ok).toBe(true);
    if (withContext.ok) {
      expect(withContext.value.context).toEqual({ queryText: "edge cases", capsuleId: "cap-1" });
    }
    const emptyContext = parseEditorTestGenerationRequest(fileRequest({ context: {} }));
    expect(emptyContext.ok).toBe(true);
    if (emptyContext.ok) {
      expect(emptyContext.value.context).toBeUndefined();
    }
  });

  it("retains a bounded editor session id when provided", () => {
    const parsed = parseEditorTestGenerationRequest(
      fileRequest({ editorSessionId: "editor-session-1" }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.editorSessionId).toBe("editor-session-1");
    }
  });
});

describe("parseEditorTestGenerationRequest — rejections", () => {
  it("rejects a non-object and a missing root", () => {
    expect(parseEditorTestGenerationRequest(null).ok).toBe(false);
    expect(parseEditorTestGenerationRequest(fileRequest({ root: "" })).ok).toBe(false);
  });

  it("rejects a missing or mismatched schema version", () => {
    expect(parseEditorTestGenerationRequest(fileRequest({ schemaVersion: undefined })).ok).toBe(
      false,
    );
    expect(parseEditorTestGenerationRequest(fileRequest({ schemaVersion: "2" })).ok).toBe(false);
  });

  it("rejects an unknown target kind and a missing document overlay", () => {
    expect(parseEditorTestGenerationRequest(fileRequest({ target: { kind: "nope" } })).ok).toBe(
      false,
    );
    expect(parseEditorTestGenerationRequest(fileRequest({ target: { kind: "file" } })).ok).toBe(
      false,
    );
  });

  it("rejects a selection without a range and a symbol without a name", () => {
    expect(
      parseEditorTestGenerationRequest(
        fileRequest({ target: { kind: "selection", document: OVERLAY } }),
      ).ok,
    ).toBe(false);
    expect(
      parseEditorTestGenerationRequest(
        fileRequest({ target: { kind: "symbol", document: OVERLAY, symbol: { range: RANGE } } }),
      ).ok,
    ).toBe(false);
  });

  it("rejects an empty changed-file-set and a frontend-component without a name", () => {
    expect(
      parseEditorTestGenerationRequest(
        fileRequest({ target: { kind: "changed-file-set", documents: [] } }),
      ).ok,
    ).toBe(false);
    expect(
      parseEditorTestGenerationRequest(
        fileRequest({
          target: { kind: "frontend-component", document: OVERLAY, componentName: "" },
        }),
      ).ok,
    ).toBe(false);
  });

  // KEIKO-0893: isOverlayArray previously accepted a changed-file-set documents array of ANY
  // positive length with no density check and no per-overlay text byte bound.
  it("accepts a changed-file-set documents array at exactly the max overlay count", () => {
    const documents = Array.from({ length: EDITOR_TEST_GENERATION_MAX_OVERLAYS }, (_unused, i) => ({
      path: `src/file-${String(i)}.ts`,
      languageId: "typescript",
      text: `export const v${String(i)} = ${String(i)};\n`,
    }));
    const parsed = parseEditorTestGenerationRequest(
      fileRequest({ target: { kind: "changed-file-set", documents } }),
    );
    expect(parsed.ok).toBe(true);
  });

  it("rejects a changed-file-set documents array longer than the max overlay count", () => {
    const documents = Array.from(
      { length: EDITOR_TEST_GENERATION_MAX_OVERLAYS + 1 },
      (_unused, i) => ({
        path: `src/file-${String(i)}.ts`,
        languageId: "typescript",
        text: `export const v${String(i)} = ${String(i)};\n`,
      }),
    );
    const parsed = parseEditorTestGenerationRequest(
      fileRequest({ target: { kind: "changed-file-set", documents } }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("rejects a sparse changed-file-set documents array", () => {
    // A real hole (not a filled-in overlay) at index 1: Object.keys reports 2 entries while
    // .length reports 3, which is exactly the density mismatch isOverlayArray must reject even
    // though every PRESENT entry and the array's reported length are individually well-formed.
    const documents: unknown[] = [OVERLAY, OVERLAY, OVERLAY];
    Reflect.deleteProperty(documents, 1);
    const parsed = parseEditorTestGenerationRequest(
      fileRequest({ target: { kind: "changed-file-set", documents } }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("accepts a changed-file-set documents entry whose text is exactly at the byte ceiling", () => {
    const documents = [
      {
        path: "src/big.ts",
        languageId: "typescript",
        text: "a".repeat(EDITOR_TEST_GENERATION_MAX_OVERLAY_TEXT_BYTES),
      },
    ];
    const parsed = parseEditorTestGenerationRequest(
      fileRequest({ target: { kind: "changed-file-set", documents } }),
    );
    expect(parsed.ok).toBe(true);
  });

  it("rejects a changed-file-set documents entry whose text exceeds the byte ceiling", () => {
    const documents = [
      {
        path: "src/big.ts",
        languageId: "typescript",
        text: "a".repeat(EDITOR_TEST_GENERATION_MAX_OVERLAY_TEXT_BYTES + 1),
      },
    ];
    const parsed = parseEditorTestGenerationRequest(
      fileRequest({ target: { kind: "changed-file-set", documents } }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("rejects a negative budget, a bad context selector, and ambiguous capsule scope", () => {
    expect(parseEditorTestGenerationRequest(fileRequest({ contextBudgetBytes: -1 })).ok).toBe(
      false,
    );
    expect(parseEditorTestGenerationRequest(fileRequest({ context: { queryText: 7 } })).ok).toBe(
      false,
    );
    expect(
      parseEditorTestGenerationRequest(
        fileRequest({ context: { capsuleId: "a", capsuleSetId: "b" } }),
      ).ok,
    ).toBe(false);
  });

  it("rejects malformed or oversized editor session ids", () => {
    for (const editorSessionId of [
      "",
      "   ",
      null,
      "x".repeat(EDITOR_AGENT_SESSION_ID_MAX_BYTES + 1),
    ]) {
      const parsed = parseEditorTestGenerationRequest(fileRequest({ editorSessionId }));
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.errors).toContain(
        `editorSessionId must be a non-empty string of at most ${EDITOR_AGENT_SESSION_ID_MAX_BYTES.toString()} UTF-8 bytes when provided`,
      );
    }
  });
});

describe("notRunTestGenerationFunnel + constants", () => {
  it("reports no execution and every gate not-run", () => {
    const funnel = notRunTestGenerationFunnel();
    expect(funnel.executionEnabled).toBe(false);
    expect(funnel.candidatesGenerated).toBe(0);
    expect(funnel.candidatesSurfaced).toBe(0);
    expect(funnel.stabilityRunsRequired).toBe(EDITOR_TEST_GENERATION_STABILITY_RUNS);
    for (const gate of [
      funnel.build,
      funnel.pass,
      funnel.stability,
      funnel.coverage,
      funnel.mutation,
      funnel.antiTautology,
    ]) {
      expect(gate).toBe("not-run");
    }
  });

  it("exposes stable enum tables", () => {
    expect(EDITOR_TEST_GENERATION_STABILITY_RUNS).toBeGreaterThanOrEqual(5);
    expect(EDITOR_TEST_GENERATION_STATUSES).toContain("disabled");
    expect(EDITOR_TEST_GENERATION_STATUSES).toContain("deferred");
    expect(EDITOR_TEST_GENERATION_GATE_STATES).toContain("not-run");
    expect(EDITOR_TEST_GENERATION_TARGET_KINDS).toContain("frontend-component");
  });
});

// #3918 original-first public contract controls.
import * as publicOwner from "@oscharko-dev/keiko-contracts/runtime/editor-test-generation";

describe("#3918 actual public owner preservation", () => {
  it("retains the owning result and declared refusal", () => {
    const parsed = publicOwner.parseEditorTestGenerationRequest(fileRequest());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.target.kind).toBe("file");
    if (parsed.value.target.kind === "file") expect(parsed.value.target.document).toBe(OVERLAY);
    expect(publicOwner.notRunTestGenerationFunnel().executionEnabled).toBe(false);
  });
});

// #3918 finite original-first observations.
describe("#3918 captured output root admission", () => {
  it.each([
    ["source", parseEditorTestGenerationRequest],
    ["public", publicOwner.parseEditorTestGenerationRequest],
  ])("%s refuses a malformed second root", (_surface, parse) => {
    const input = fileRequest();
    let reads = 0;
    Object.defineProperty(input, "root", { get: () => (++reads === 1 ? "/repo" : undefined) });
    expect(parse(input)).toEqual({ ok: false, errors: ["root must be a non-empty string"] });
    expect(reads).toBe(2);
  });
  it.each([
    ["source", parseEditorTestGenerationRequest],
    ["public", publicOwner.parseEditorTestGenerationRequest],
  ])("%s keeps a valid changed second root", (_surface, parse) => {
    const input = fileRequest();
    let reads = 0;
    Object.defineProperty(input, "root", { get: () => (++reads === 1 ? "/repo" : "/other") });
    const parsed = parse(input);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.root).toBe("/other");
    expect(reads).toBe(2);
  });
});

describe("#3918 frontend-component optional range shape hypothesis", () => {
  it.each([
    ["source", parseEditorTestGenerationRequest],
    ["public", publicOwner.parseEditorTestGenerationRequest],
  ])("%s refuses malformed optional range", (_surface, parse) => {
    const input = fileRequest({
      target: { kind: "frontend-component", document: OVERLAY, componentName: "Widget", range: {} },
    });
    expect(parse(input)).toEqual({
      ok: false,
      errors: ["target.range must be { start, end } when present for a frontend-component target"],
    });
  });
});

function callerOverlayEvery(): unknown[] {
  const entries: unknown[] = [{}];
  Object.defineProperty(entries, "every", { value: (): boolean => true });
  return entries;
}
describe("#3918 forward overlay physical admission", () => {
  it.each([parseEditorTestGenerationRequest, publicOwner.parseEditorTestGenerationRequest])(
    "healthy overlays and ordinary refusal",
    (parse) => {
      expect(
        parse(fileRequest({ target: { kind: "changed-file-set", documents: [OVERLAY] } })).ok,
      ).toBe(true);
      expect(parse(fileRequest({ target: { kind: "changed-file-set", documents: [{}] } }))).toEqual(
        {
          ok: false,
          errors: ["target.documents must be a non-empty array of { path, languageId, text }"],
        },
      );
    },
  );
  it.each([parseEditorTestGenerationRequest, publicOwner.parseEditorTestGenerationRequest])(
    "finite overlay caller every refusal",
    (parse) => {
      expect(
        parse(
          fileRequest({ target: { kind: "changed-file-set", documents: callerOverlayEvery() } }),
        ),
      ).toEqual({
        ok: false,
        errors: ["target.documents must be a non-empty array of { path, languageId, text }"],
      });
    },
  );
});

describe.each([
  ["source", parseEditorTestGenerationRequest],
  ["public", publicOwner.parseEditorTestGenerationRequest],
] as const)("#3918 captured request identity through %s", (_surface, parse) => {
  it("keeps changing inherited session reads, capture order and nested references", () => {
    const input = fileRequest();
    const body = input.target;
    const reads: string[] = [];
    let sessions = 0;
    Object.defineProperty(input, "root", {
      get(): string {
        reads.push("root");
        return "/repo";
      },
    });
    Object.defineProperty(input, "target", {
      get(): unknown {
        reads.push("target");
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
      expect(parsed.value.target).toBe(body);
      expect(Object.keys(parsed.value).slice(0, 4)).toEqual([
        "schemaVersion",
        "root",
        "editorSessionId",
        "target",
      ]);
    }
    expect(reads).toEqual([
      "root",
      "session:1",
      "target",
      "root",
      "session:2",
      "session:3",
      "target",
    ]);
  });

  it("distinguishes absent, guard-refused and captured own undefined sessions", () => {
    const absent = fileRequest();
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
      const input = fileRequest();
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
    const input = fileRequest();
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
      const input = fileRequest();
      const body = input.target;
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
      Object.defineProperty(input, "target", {
        get(): unknown {
          reads.push("target");
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
          ? ["root:1", "session:1", "target", "root:2"]
          : ["root:1", "session:1", "target", "root:2", "session:2", "session:3"],
      );
    }
  });
});
