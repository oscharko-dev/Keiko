import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_DIAGNOSTICS_DEBOUNCE_MS,
  DEFAULT_DIAGNOSTICS_OWNER,
  DIAGNOSTICS_ELIGIBLE_LANGUAGES,
  diagnosticsToMarkers,
  editorDiagnosticToMarker,
  markersToOverviewMarkers,
  registerKeikoDiagnostics,
  severityToMarker,
  summarizeDiagnostics,
  type DiagnosticsScheduler,
  type MonacoDiagnosticsEditor,
  type MonacoDiagnosticsModel,
  type MonacoMarkerData,
  type MonacoMarkerEditorNamespace,
  type MonacoMarkerSeverities,
} from "./diagnostics-bridge.js";
import type { EditorDiagnostic, EditorDiagnosticsResolver } from "../types.js";

const SEVERITIES: MonacoMarkerSeverities = { Error: 8, Warning: 4, Info: 2, Hint: 1 };

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function diagnostic(overrides: Partial<EditorDiagnostic> = {}): EditorDiagnostic {
  return {
    range: { start: { line: 0, column: 0 }, end: { line: 0, column: 5 } },
    severity: "error",
    message: "Type error",
    source: "typescript",
    code: "2322",
    ...overrides,
  };
}

interface FakeMarkers {
  readonly ns: MonacoMarkerEditorNamespace;
  readonly calls: {
    model: MonacoDiagnosticsModel;
    owner: string;
    markers: readonly MonacoMarkerData[];
  }[];
}

function buildMarkers(): FakeMarkers {
  const calls: FakeMarkers["calls"] = [];
  const ns: MonacoMarkerEditorNamespace = {
    MarkerSeverity: SEVERITIES,
    setModelMarkers: (model, owner, markers): void => {
      calls.push({ model, owner, markers });
    },
  };
  return { ns, calls };
}

interface FakeModel {
  readonly model: MonacoDiagnosticsModel;
  edit(newText: string): void;
  bumpVersion(): void;
  contentDisposeCount(): number;
  hasContentListener(): boolean;
}

function buildModel(opts: { language?: string; text?: string; uri?: string } = {}): FakeModel {
  let version = 1;
  let text = opts.text ?? "const x = 1;\n";
  const language = opts.language ?? "typescript";
  let listener: (() => void) | null = null;
  let contentDisposed = 0;
  const model: MonacoDiagnosticsModel = {
    getValue: () => text,
    getVersionId: () => version,
    getLanguageId: () => language,
    onDidChangeContent: (l): { dispose: () => void } => {
      listener = l;
      return {
        dispose: (): void => {
          contentDisposed += 1;
          listener = null;
        },
      };
    },
    uri: { toString: () => opts.uri ?? "inmemory://model/1" },
  };
  return {
    model,
    edit: (newText): void => {
      text = newText;
      version += 1;
      listener?.();
    },
    bumpVersion: (): void => {
      version += 1;
    },
    contentDisposeCount: () => contentDisposed,
    hasContentListener: () => listener !== null,
  };
}

interface FakeEditor {
  readonly editor: MonacoDiagnosticsEditor;
  swap(next: MonacoDiagnosticsModel | null): void;
  modelDisposeCount(): number;
}

function buildEditor(initial: MonacoDiagnosticsModel | null): FakeEditor {
  let current = initial;
  let modelListener: (() => void) | null = null;
  let modelDisposed = 0;
  const editor: MonacoDiagnosticsEditor = {
    getModel: () => current,
    onDidChangeModel: (l): { dispose: () => void } => {
      modelListener = l;
      return {
        dispose: (): void => {
          modelDisposed += 1;
        },
      };
    },
  };
  return {
    editor,
    swap: (next): void => {
      current = next;
      modelListener?.();
    },
    modelDisposeCount: () => modelDisposed,
  };
}

interface ManualScheduler {
  readonly scheduler: DiagnosticsScheduler;
  flush(): void;
  hasPending(): boolean;
  scheduledCount(): number;
  cancelledCount(): number;
}

function buildScheduler(): ManualScheduler {
  let pending: (() => void) | null = null;
  let scheduled = 0;
  let cancelled = 0;
  const scheduler: DiagnosticsScheduler = {
    schedule: (callback): { id: number } => {
      pending = callback;
      scheduled += 1;
      return { id: scheduled };
    },
    cancel: (): void => {
      if (pending !== null) {
        cancelled += 1;
        pending = null;
      }
    },
  };
  return {
    scheduler,
    flush: (): void => {
      const callback = pending;
      pending = null;
      callback?.();
    },
    hasPending: () => pending !== null,
    scheduledCount: () => scheduled,
    cancelledCount: () => cancelled,
  };
}

interface DeferredResolver {
  readonly resolve: EditorDiagnosticsResolver;
  readonly calls: {
    readonly signal: AbortSignal;
    readonly documentText: string;
    readonly language: string;
    settle(diagnostics: readonly EditorDiagnostic[]): void;
    fail(error: unknown): void;
  }[];
}

function deferredResolver(): DeferredResolver {
  const calls: DeferredResolver["calls"] = [];
  const resolve: EditorDiagnosticsResolver = (query, signal) =>
    new Promise((res, rej) => {
      calls.push({
        signal,
        documentText: query.documentText,
        language: query.request.document.language,
        settle: (diagnostics): void => {
          res({ request: query.request.request, diagnostics });
        },
        fail: (error): void => {
          rej(error instanceof Error ? error : new Error(String(error)));
        },
      });
    });
  return { resolve, calls };
}

interface Harness {
  readonly markers: FakeMarkers;
  readonly resolver: DeferredResolver;
  readonly scheduler: ManualScheduler;
  readonly dispose: () => void;
}

function register(
  editor: FakeEditor,
  overrides: Partial<Parameters<typeof registerKeikoDiagnostics>[0]> = {},
): Harness {
  const markers = buildMarkers();
  const resolver = deferredResolver();
  const scheduler = buildScheduler();
  const disposable = registerKeikoDiagnostics({
    editor: editor.editor,
    markers: markers.ns,
    resolve: resolver.resolve,
    documentLanguages: DIAGNOSTICS_ELIGIBLE_LANGUAGES,
    owner: "test-owner",
    debounceMs: 300,
    streamId: "stream",
    newRequestId: () => "req",
    scheduler: scheduler.scheduler,
    ...overrides,
  });
  return {
    markers,
    resolver,
    scheduler,
    dispose: (): void => {
      disposable.dispose();
    },
  };
}

describe("pure mappers", () => {
  it("maps every severity to the Monaco marker severity", () => {
    expect(severityToMarker("error", SEVERITIES)).toBe(8);
    expect(severityToMarker("warning", SEVERITIES)).toBe(4);
    expect(severityToMarker("info", SEVERITIES)).toBe(2);
    expect(severityToMarker("hint", SEVERITIES)).toBe(1);
  });

  it("maps a diagnostic to a 1-based marker carrying source and code", () => {
    const marker = editorDiagnosticToMarker(diagnostic(), SEVERITIES);
    expect(marker).toEqual({
      severity: 8,
      message: "Type error",
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 6,
      source: "typescript",
      code: "2322",
    });
  });

  it("omits absent optional fields", () => {
    const marker = editorDiagnosticToMarker(
      diagnostic({ source: undefined, code: undefined }),
      SEVERITIES,
    );
    expect("source" in marker).toBe(false);
    expect("code" in marker).toBe(false);
  });

  it("maps a list of diagnostics to markers", () => {
    expect(
      diagnosticsToMarkers([diagnostic(), diagnostic({ severity: "warning" })], SEVERITIES),
    ).toHaveLength(2);
  });

  it("maps Monaco markers into overview markers for the rounded Keiko marker rail", () => {
    expect(markersToOverviewMarkers([editorDiagnosticToMarker(diagnostic(), SEVERITIES)])).toEqual([
      {
        severity: 8,
        message: "Type error",
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 6,
        source: "typescript",
        code: "2322",
      },
    ]);
  });

  it("tallies diagnostics by severity for the status bar, counting hints as info (#1205)", () => {
    expect(summarizeDiagnostics([])).toEqual({ errors: 0, warnings: 0, infos: 0 });
    expect(
      summarizeDiagnostics([
        diagnostic(),
        diagnostic({ severity: "warning" }),
        diagnostic({ severity: "warning" }),
        diagnostic({ severity: "info" }),
        diagnostic({ severity: "hint" }),
      ]),
    ).toEqual({ errors: 1, warnings: 2, infos: 2 });
  });
});

describe("registerKeikoDiagnostics — marker lifecycle", () => {
  it("runs an initial pass on bind and writes the resolved markers", async () => {
    const model = buildModel();
    const editor = buildEditor(model.model);
    const { markers, resolver } = register(editor);
    expect(resolver.calls).toHaveLength(1);
    // AC1: the resolver is handed the live buffer text and the governed language id.
    expect(resolver.calls[0]?.documentText).toBe("const x = 1;\n");
    expect(resolver.calls[0]?.language).toBe("typescript");
    resolver.calls[0]?.settle([diagnostic()]);
    await tick();
    expect(markers.calls).toHaveLength(1);
    expect(markers.calls[0]?.owner).toBe("test-owner");
    expect(markers.calls[0]?.markers).toHaveLength(1);
  });

  it("reports a content-free diagnostics summary to onSummary after writing markers (#1205)", async () => {
    const model = buildModel();
    const editor = buildEditor(model.model);
    const onSummary = vi.fn();
    const { resolver } = register(editor, { onSummary });
    resolver.calls[0]?.settle([
      diagnostic(),
      diagnostic({ severity: "warning" }),
      diagnostic({ severity: "info" }),
    ]);
    await tick();
    expect(onSummary).toHaveBeenCalledWith({ errors: 1, warnings: 1, infos: 1 });
  });

  it("reports overview markers for the rounded Keiko marker rail", async () => {
    const model = buildModel();
    const editor = buildEditor(model.model);
    const onOverviewMarkers = vi.fn();
    const { resolver } = register(editor, { onOverviewMarkers });
    resolver.calls[0]?.settle([
      diagnostic(),
      diagnostic({
        severity: "warning",
        range: { start: { line: 2, column: 0 }, end: { line: 4, column: 1 } },
      }),
    ]);
    await tick();
    expect(onOverviewMarkers).toHaveBeenCalledWith([
      {
        severity: 8,
        message: "Type error",
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 6,
        source: "typescript",
        code: "2322",
      },
      {
        severity: 4,
        message: "Type error",
        startLineNumber: 3,
        startColumn: 1,
        endLineNumber: 5,
        endColumn: 2,
        source: "typescript",
        code: "2322",
      },
    ]);
  });

  it("does not report a summary for a stale (superseded) response (#1205)", async () => {
    const model = buildModel();
    const editor = buildEditor(model.model);
    const onSummary = vi.fn();
    const { resolver } = register(editor, { onSummary });
    // The buffer version moves on while the initial request is in flight, so its response is stale.
    model.bumpVersion();
    resolver.calls[0]?.settle([diagnostic()]);
    await tick();
    expect(onSummary).not.toHaveBeenCalled();
  });

  it("rewrites markers to empty when diagnostics clear (a fixed error removes its squiggle)", async () => {
    const model = buildModel();
    const editor = buildEditor(model.model);
    const onOverviewMarkers = vi.fn();
    const { markers, resolver, scheduler } = register(editor, { onOverviewMarkers });
    resolver.calls[0]?.settle([diagnostic()]);
    await tick();
    model.edit("const x: number = 1;\n");
    scheduler.flush();
    resolver.calls[1]?.settle([]);
    await tick();
    expect(markers.calls[1]?.markers).toEqual([]);
    expect(onOverviewMarkers).toHaveBeenLastCalledWith([]);
  });

  it("debounces rapid content changes into a single re-analysis", () => {
    const model = buildModel();
    const editor = buildEditor(model.model);
    const { resolver, scheduler } = register(editor);
    // Initial pass already ran (call 0). Two rapid edits collapse to one scheduled run.
    model.edit("a");
    model.edit("ab");
    expect(scheduler.cancelledCount()).toBeGreaterThanOrEqual(1);
    scheduler.flush();
    expect(resolver.calls).toHaveLength(2);
  });
});

describe("registerKeikoDiagnostics — stale-diagnostics safety", () => {
  it("discards a response whose buffer changed while the request was in flight", async () => {
    const model = buildModel();
    const editor = buildEditor(model.model);
    const { markers, resolver } = register(editor);
    // The buffer version moves on while the initial request is in flight.
    model.bumpVersion();
    resolver.calls[0]?.settle([diagnostic()]);
    await tick();
    expect(markers.calls).toHaveLength(0);
  });

  it("discards a superseded response and applies the newer one", async () => {
    const model = buildModel();
    const editor = buildEditor(model.model);
    const { markers, resolver, scheduler } = register(editor);
    // A newer run supersedes the initial one.
    model.edit("changed");
    scheduler.flush();
    expect(resolver.calls).toHaveLength(2);
    // The older (superseded) response is dropped.
    resolver.calls[0]?.settle([diagnostic({ message: "stale" })]);
    await tick();
    expect(markers.calls).toHaveLength(0);
    // The newer response is applied.
    resolver.calls[1]?.settle([diagnostic({ message: "fresh" })]);
    await tick();
    expect(markers.calls).toHaveLength(1);
    expect(markers.calls[0]?.markers[0]?.message).toBe("fresh");
  });

  it("aborts the in-flight request when a newer run starts", () => {
    const model = buildModel();
    const editor = buildEditor(model.model);
    const { resolver, scheduler } = register(editor);
    expect(resolver.calls[0]?.signal.aborted).toBe(false);
    model.edit("changed");
    scheduler.flush();
    expect(resolver.calls[0]?.signal.aborted).toBe(true);
  });

  it("leaves existing markers untouched when a re-analysis fails", async () => {
    const model = buildModel();
    const editor = buildEditor(model.model);
    const { markers, resolver, scheduler } = register(editor);
    resolver.calls[0]?.settle([diagnostic()]);
    await tick();
    expect(markers.calls).toHaveLength(1);
    model.edit("boom");
    scheduler.flush();
    resolver.calls[1]?.fail(new Error("network"));
    await tick();
    // No additional marker write — the previous diagnostics remain on screen.
    expect(markers.calls).toHaveLength(1);
  });
});

describe("registerKeikoDiagnostics — degradation and lifecycle", () => {
  it("never analyses an unsupported language and clears any markers", () => {
    const model = buildModel({ language: "plaintext" });
    const editor = buildEditor(model.model);
    const { markers, resolver } = register(editor);
    expect(resolver.calls).toHaveLength(0);
    expect(model.hasContentListener()).toBe(false);
    expect(markers.calls).toEqual([{ model: model.model, owner: "test-owner", markers: [] }]);
  });

  it("does nothing when the editor has no model", () => {
    const editor = buildEditor(null);
    const { markers, resolver } = register(editor);
    expect(resolver.calls).toHaveLength(0);
    expect(markers.calls).toHaveLength(0);
  });

  it("clears the old model's markers and binds the new model on a model swap", async () => {
    const first = buildModel({ uri: "inmemory://model/first" });
    const second = buildModel({ uri: "inmemory://model/second" });
    const editor = buildEditor(first.model);
    const { markers, resolver } = register(editor);
    resolver.calls[0]?.settle([diagnostic()]);
    await tick();
    expect(markers.calls).toHaveLength(1);
    editor.swap(second.model);
    // The old model's markers are cleared on unbind.
    expect(
      markers.calls.some((call) => call.model === first.model && call.markers.length === 0),
    ).toBe(true);
    // The new model is analysed.
    expect(resolver.calls).toHaveLength(2);
    resolver.calls[1]?.settle([diagnostic()]);
    await tick();
    expect(
      markers.calls.some((call) => call.model === second.model && call.markers.length === 1),
    ).toBe(true);
  });

  it("clears markers, the content subscription, the timer, and the model subscription on dispose", () => {
    const model = buildModel();
    const editor = buildEditor(model.model);
    const harness = register(editor);
    model.edit("pending");
    expect(harness.scheduler.hasPending()).toBe(true);
    harness.dispose();
    expect(harness.scheduler.hasPending()).toBe(false);
    expect(model.contentDisposeCount()).toBe(1);
    expect(editor.modelDisposeCount()).toBe(1);
    // The last write clears the owner's markers.
    const last = harness.markers.calls.at(-1);
    expect(last?.markers).toEqual([]);
  });
});

describe("defaults", () => {
  it("exposes the governed eligible languages and stable defaults", () => {
    expect(DIAGNOSTICS_ELIGIBLE_LANGUAGES).toEqual(["typescript", "javascript"]);
    expect(DEFAULT_DIAGNOSTICS_DEBOUNCE_MS).toBe(400);
    expect(DEFAULT_DIAGNOSTICS_OWNER).toBe("keiko-language-service");
  });

  it("uses the default scheduler when none is injected (real timer path)", () => {
    vi.useFakeTimers();
    try {
      const model = buildModel();
      const editor = buildEditor(model.model);
      const markers = buildMarkers();
      const resolver = deferredResolver();
      const disposable = registerKeikoDiagnostics({
        editor: editor.editor,
        markers: markers.ns,
        resolve: resolver.resolve,
        documentLanguages: DIAGNOSTICS_ELIGIBLE_LANGUAGES,
        owner: "o",
        debounceMs: 10,
        streamId: "s",
        newRequestId: () => "r",
      });
      model.edit("x");
      expect(() => vi.advanceTimersByTime(10)).not.toThrow();
      // Two runs: the initial bind pass and the debounced edit.
      expect(resolver.calls.length).toBeGreaterThanOrEqual(2);
      disposable.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
