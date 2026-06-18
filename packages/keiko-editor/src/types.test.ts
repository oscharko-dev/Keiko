import { describe, expect, it } from "vitest";

import "./content-free-guard.js";
import type {
  EditorCompletionRequest,
  EditorCompletionResponse,
  EditorContextEntry,
  EditorContextOmission,
  EditorContextPack,
  EditorContextRequest,
  EditorContextResult,
  EditorDiagnostic,
  EditorGeneratedPatch,
  EditorInlineCompletionRequest,
  EditorInlineCompletionResponse,
  EditorModelProvenance,
  EditorOutputProvenance,
  EditorPatchApplyResult,
  EditorPatchReviewDecision,
  EditorPreviewPatchResult,
  EditorRecentEditContext,
  EditorRecentEditSummary,
  EditorRequestIdentity,
  EditorSaveRequest,
  EditorSaveResult,
  EditorTestGenerationContext,
  EditorTestGenerationRequest,
  EditorTestGenerationResult,
} from "./types.js";

const requestIdentity: EditorRequestIdentity = {
  requestId: "r1",
  streamId: "s1",
  sequence: 4,
};

const documentIdentity = {
  uri: "keiko-doc:src-a-ts",
  language: "typescript",
  version: 12,
} as const;

const modelProvenance: EditorModelProvenance = {
  modelId: "gpt-oss-120b",
  modelVersion: "2026-06",
  gatewayPolicyVersion: "policy-7",
  promptHash: "sha256:abc",
  producedAt: 1_700_000_000_000,
};

const allOutputProvenance: readonly EditorOutputProvenance[] = [
  { origin: "human" },
  { origin: "deterministic-completion" },
  { origin: "ai-inline-completion", model: modelProvenance },
  { origin: "generated-test", model: modelProvenance },
  { origin: "applied-patch", model: modelProvenance },
  { origin: "applied-patch" },
  { origin: "verification" },
];

const previewPatchResult: EditorPreviewPatchResult = {
  patchId: "p1",
  changes: [
    {
      uri: "keiko-doc:src-a-ts",
      edits: [
        { range: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }, newText: "x" },
      ],
      isNewFile: false,
      isDeletion: false,
    },
  ],
  status: "previewed",
  provenance: { origin: "applied-patch", model: modelProvenance },
  verification: { verificationId: "v1", outcome: "passed", evidenceRef: "ev1" },
};

const generatedPatch: EditorGeneratedPatch = previewPatchResult;

const patchApplyDecision: EditorPatchReviewDecision = {
  patchId: "p1",
  decision: "apply",
  decidedAt: 1_700_000_000_001,
};

const patchRejectDecision: EditorPatchReviewDecision = {
  patchId: "p1",
  decision: "reject",
  decidedAt: 1_700_000_000_002,
};

const patchApplyResult: EditorPatchApplyResult = {
  patchId: "p1",
  decision: "apply",
  status: "applied",
  appliedChanges: 1,
};

const patchRejectResult: EditorPatchApplyResult = {
  patchId: "p1",
  decision: "reject",
  status: "rejected",
  appliedChanges: 0,
};

const recentEditSummary: EditorRecentEditSummary = {
  range: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } },
  insertedBytes: 1,
  insertedLineCount: 1,
  insertedHash: "sha256:inserted-a",
  netByteDelta: 0,
  netLineDelta: 0,
};

const recentEditContext: EditorRecentEditContext = {
  edits: [recentEditSummary],
  truncated: false,
};

const completionRequest: EditorCompletionRequest = {
  request: requestIdentity,
  document: documentIdentity,
  position: { line: 1, column: 2 },
  triggerKind: "invoked",
  triggerCharacter: ".",
  contextBudgetBytes: 4096,
  recentEdits: recentEditContext,
};

const completionResponse: EditorCompletionResponse = {
  request: requestIdentity,
  items: [
    {
      label: "map",
      kind: "method",
      insertText: "map()",
      range: { start: { line: 1, column: 2 }, end: { line: 1, column: 2 } },
      sortText: "0",
      detail: "Array.map",
      provenance: { origin: "deterministic-completion" },
    },
  ],
  isIncomplete: false,
};

const inlineRequest: EditorInlineCompletionRequest = {
  request: requestIdentity,
  document: documentIdentity,
  position: { line: 1, column: 2 },
  triggerKind: "automatic",
  contextBudgetBytes: 2048,
  recentEdits: recentEditContext,
};

const inlineResponse: EditorInlineCompletionResponse = {
  request: requestIdentity,
  items: [
    {
      insertText: "const x = 1;",
      range: { start: { line: 1, column: 2 }, end: { line: 1, column: 2 } },
      provenance: { origin: "ai-inline-completion", model: modelProvenance },
    },
  ],
};

const diagnostic: EditorDiagnostic = {
  range: { start: { line: 3, column: 0 }, end: { line: 3, column: 5 } },
  severity: "error",
  message: "Cannot find name 'foo'.",
  source: "ts",
  code: "2304",
  related: [
    {
      uri: "keiko-doc:src-b-ts",
      range: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } },
      message: "declared here",
    },
  ],
};

const testGenerationRequest: EditorTestGenerationRequest = {
  request: requestIdentity,
  context: { kind: "file", document: documentIdentity },
  contextBudgetBytes: 8192,
};

const testGenerationResult: EditorTestGenerationResult = {
  request: requestIdentity,
  patch: generatedPatch,
  provenance: { origin: "generated-test", model: modelProvenance },
};

const contextRequest: EditorContextRequest = {
  request: requestIdentity,
  document: documentIdentity,
  cursor: { line: 1, column: 2 },
  selection: { start: { line: 1, column: 0 }, end: { line: 1, column: 4 } },
  symbol: {
    name: "foo",
    container: "Bar",
    range: { start: { line: 1, column: 0 }, end: { line: 1, column: 3 } },
  },
  changedFiles: [documentIdentity],
  openFiles: [documentIdentity],
  focusedWindowId: "w1",
  purpose: "completion",
  budgetBytes: 16384,
};

const contextEntry: EditorContextEntry = {
  sourceKind: "repo-search",
  id: "entry-1",
  score: 0.91,
  rank: 0,
  citationRef: "cite-1",
  byteCount: 256,
  truncated: false,
};

const contextOmission: EditorContextOmission = {
  sourceKind: "memory",
  reason: "not-ready",
};

const contextPack: EditorContextPack = {
  request: requestIdentity,
  entries: [contextEntry],
  usedBytes: 256,
  budgetBytes: 16384,
  droppedForBudget: 0,
  omissions: [contextOmission],
};

const contextResults: readonly EditorContextResult[] = [
  { status: "ready", pack: contextPack },
  { status: "degraded", pack: contextPack },
  { status: "unavailable", request: requestIdentity, omissions: [contextOmission] },
];

const saveRequest: EditorSaveRequest = {
  identity: documentIdentity,
  content: { relativePath: "src/a.ts", sizeBytes: 12, text: "const x = 1;", truncated: false },
};

const saveResult: EditorSaveResult = {
  identity: documentIdentity,
  savedAt: 1_700_000_000_000,
  persistedBytes: 12,
};

const crossBoundaryInstances: Readonly<Record<string, unknown>> = {
  completionRequest,
  completionResponse,
  inlineRequest,
  inlineResponse,
  diagnostic,
  testGenerationRequest,
  testGenerationResult,
  generatedPatch,
  previewPatchResult,
  patchApplyDecision,
  patchRejectDecision,
  patchApplyResult,
  patchRejectResult,
  recentEditSummary,
  recentEditContext,
  contextRequest,
  contextReady: contextResults[0],
  contextDegraded: contextResults[1],
  contextUnavailable: contextResults[2],
  saveRequest,
  saveResult,
  modelProvenance,
  ...Object.fromEntries(allOutputProvenance.map((p, i) => [`outputProvenance${String(i)}`, p])),
};

function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, into);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      into.add(key);
      collectKeys(nested, into);
    }
  }
}

function hasFunctionOrSignal(value: unknown): boolean {
  if (typeof value === "function") {
    return true;
  }
  if (typeof AbortSignal !== "undefined" && value instanceof AbortSignal) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(hasFunctionOrSignal);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(hasFunctionOrSignal);
  }
  return false;
}

describe("cross-boundary contracts are serializable and callback-free", () => {
  for (const [name, instance] of Object.entries(crossBoundaryInstances)) {
    it(`${name} round-trips through JSON deep-equal`, () => {
      expect(JSON.parse(JSON.stringify(instance))).toEqual(instance);
    });

    it(`${name} contains no function or AbortSignal field`, () => {
      expect(hasFunctionOrSignal(instance)).toBe(false);
    });
  }
});

const FORBIDDEN_KEY =
  /^(prompt|rawPrompt|promptText|content|text|newText|insertText|excerpt|query|rawQuery|secret|apiKey|token|credential|authorization)$/i;

describe("content-free types carry no content-bearing key", () => {
  const contentFreeInstances: Readonly<Record<string, unknown>> = {
    modelProvenance,
    contextRequest,
    contextEntry,
    contextPack,
    contextOmission,
    recentEditSummary,
    recentEditContext,
    // The completion/inline/generated-test request contracts must also carry no content-bearing
    // field (Issue #1192 Addendum 1: "no provenance or request/response field can transport a raw
    // prompt or secret-bearing content; tests assert this").
    completionRequest,
    inlineRequest,
    testGenerationRequest,
  };

  for (const [name, instance] of Object.entries(contentFreeInstances)) {
    it(`${name} has no forbidden key`, () => {
      const keys = new Set<string>();
      collectKeys(instance, keys);
      const offenders = [...keys].filter((key) => FORBIDDEN_KEY.test(key));
      expect(offenders).toEqual([]);
    });
  }
});

describe("the recursive forbidden-key scanner descends into nested objects and arrays", () => {
  it("finds a forbidden key nested inside an array element", () => {
    const keys = new Set<string>();
    collectKeys({ entries: [{ token: "leak" }] }, keys);
    expect(keys.has("token")).toBe(true);
  });

  it("finds a forbidden key several levels deep", () => {
    const keys = new Set<string>();
    collectKeys({ a: { b: { c: { secret: "leak" } } } }, keys);
    expect([...keys].filter((key) => FORBIDDEN_KEY.test(key))).toEqual(["secret"]);
  });

  it("finds old recent-edit newText leakage inside a content-free request", () => {
    const keys = new Set<string>();
    collectKeys(
      {
        request: requestIdentity,
        document: documentIdentity,
        position: { line: 1, column: 2 },
        triggerKind: "invoked",
        contextBudgetBytes: 4096,
        recentEdits: {
          edits: [
            {
              range: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } },
              newText: "leak",
            },
          ],
          truncated: false,
        },
      },
      keys,
    );
    expect([...keys].filter((key) => FORBIDDEN_KEY.test(key))).toEqual(["newText"]);
  });
});

describe("every EditorTestGenerationContext variant is serializable", () => {
  const contexts: readonly EditorTestGenerationContext[] = [
    { kind: "file", document: documentIdentity },
    {
      kind: "selection",
      document: documentIdentity,
      range: { start: { line: 1, column: 0 }, end: { line: 1, column: 4 } },
    },
    {
      kind: "symbol",
      document: documentIdentity,
      symbol: {
        name: "foo",
        range: { start: { line: 1, column: 0 }, end: { line: 1, column: 3 } },
      },
    },
    { kind: "changed-file-set", files: [documentIdentity] },
    { kind: "frontend-component", document: documentIdentity, componentName: "Button" },
  ];

  for (const context of contexts) {
    it(`the ${context.kind} context round-trips through JSON deep-equal`, () => {
      const request: EditorTestGenerationRequest = {
        request: requestIdentity,
        context,
        contextBudgetBytes: 8192,
      };
      expect(JSON.parse(JSON.stringify(request))).toEqual(request);
    });
  }
});
