import { describe, expect, it } from "vitest";

import {
  deriveEditorStatusBar,
  debugField,
  editorLanguageLabel,
  type EditorStatusBarInput,
  type EditorStatusBarViewModel,
  type EditorStatusField,
} from "./status-bar.js";

function input(overrides: Partial<EditorStatusBarInput> = {}): EditorStatusBarInput {
  return {
    languageId: "typescript",
    cursor: { line: 0, column: 0 },
    saveStatus: "idle",
    dirty: false,
    completionsEnabled: true,
    diagnostics: null,
    ...overrides,
  };
}

function field(view: EditorStatusBarViewModel, id: string): EditorStatusField | undefined {
  return view.fields.find((entry) => entry.id === id);
}

describe("editorLanguageLabel", () => {
  it("maps governed language ids to display labels", () => {
    expect(editorLanguageLabel("typescript")).toBe("TypeScript");
    expect(editorLanguageLabel("javascript")).toBe("JavaScript");
    expect(editorLanguageLabel("json")).toBe("JSON");
    expect(editorLanguageLabel("markdown")).toBe("Markdown");
    expect(editorLanguageLabel("python")).toBe("Python");
    expect(editorLanguageLabel("kotlin")).toBe("Kotlin");
    expect(editorLanguageLabel("csharp")).toBe("C#");
    expect(editorLanguageLabel("shell")).toBe("Shell");
    expect(editorLanguageLabel("plaintext")).toBe("Plain Text");
  });
});

describe("deriveEditorStatusBar cursor field", () => {
  it("renders 1-based line/column from the 0-based contract", () => {
    const view = deriveEditorStatusBar(input({ cursor: { line: 11, column: 4 } }));
    const cursor = field(view, "cursor");
    expect(cursor?.label).toBe("Ln 12, Col 5");
    expect(cursor?.ariaLabel).toBe("Line 12, column 5");
  });

  it("never marks the cursor as a live (announced) field", () => {
    const view = deriveEditorStatusBar(input({ cursor: { line: 3, column: 7 } }));
    expect(field(view, "cursor")?.live).toBe(false);
    expect(view.liveSummary).not.toContain("Line 4");
  });

  it("degrades to placeholders when the cursor is unknown", () => {
    const view = deriveEditorStatusBar(input({ cursor: null }));
    expect(field(view, "cursor")?.label).toBe("Ln —, Col —");
  });
});

describe("deriveEditorStatusBar save field", () => {
  it("shows unsaved changes with an accent tone and announces it", () => {
    const view = deriveEditorStatusBar(input({ dirty: true }));
    const save = field(view, "save");
    expect(save?.label).toBe("Unsaved");
    expect(save?.tone).toBe("accent");
    expect(save?.live).toBe(true);
    expect(view.liveSummary).toContain("Unsaved changes");
  });

  it("shows a saved state when clean", () => {
    expect(field(deriveEditorStatusBar(input()), "save")?.label).toBe("Saved");
  });

  it("surfaces save failure and conflict with strong tones", () => {
    expect(field(deriveEditorStatusBar(input({ saveStatus: "error" })), "save")?.tone).toBe(
      "error",
    );
    expect(field(deriveEditorStatusBar(input({ saveStatus: "conflict" })), "save")?.tone).toBe(
      "warn",
    );
    expect(field(deriveEditorStatusBar(input({ saveStatus: "saving" })), "save")?.label).toBe(
      "Saving…",
    );
  });

  it("announces a failed or conflicting save assertively, not politely", () => {
    const conflict = deriveEditorStatusBar(input({ saveStatus: "conflict" }));
    expect(field(conflict, "save")?.assertive).toBe(true);
    expect(conflict.alertSummary).toContain("Save conflict");
    expect(conflict.liveSummary).not.toContain("Save conflict");

    const failed = deriveEditorStatusBar(input({ saveStatus: "error" }));
    expect(failed.alertSummary).toContain("Save failed");
  });

  it("leaves the assertive summary empty for non-critical save states", () => {
    expect(deriveEditorStatusBar(input({ dirty: true })).alertSummary).toBe("");
    expect(deriveEditorStatusBar(input()).alertSummary).toBe("");
    expect(deriveEditorStatusBar(input({ saveStatus: "saving" })).alertSummary).toBe("");
  });
});

describe("deriveEditorStatusBar diagnostics field", () => {
  it("is absent when diagnostics are not wired", () => {
    expect(field(deriveEditorStatusBar(input({ diagnostics: null })), "problems")).toBeUndefined();
  });

  it("shows 'No problems' when the tally is empty", () => {
    const view = deriveEditorStatusBar(
      input({ diagnostics: { errors: 0, warnings: 0, infos: 0 } }),
    );
    const problems = field(view, "problems");
    expect(problems?.label).toBe("No problems");
    expect(problems?.tone).toBe("default");
  });

  it("uses an error tone and a precise aria label when errors exist", () => {
    const view = deriveEditorStatusBar(
      input({ diagnostics: { errors: 2, warnings: 1, infos: 0 } }),
    );
    const problems = field(view, "problems");
    expect(problems?.tone).toBe("error");
    expect(problems?.ariaLabel).toBe("Problems: 2 errors, 1 warning");
    expect(view.liveSummary).toContain("Problems: 2 errors, 1 warning");
  });

  it("uses a warn tone when only warnings exist", () => {
    const view = deriveEditorStatusBar(
      input({ diagnostics: { errors: 0, warnings: 3, infos: 0 } }),
    );
    expect(field(view, "problems")?.tone).toBe("warn");
  });
});

describe("deriveEditorStatusBar run + language + completions + selection", () => {
  it("omits the run field when the host supplies none", () => {
    expect(field(deriveEditorStatusBar(input()), "run")).toBeUndefined();
  });

  it("renders a busy run field with an accent tone and announces it", () => {
    const view = deriveEditorStatusBar(input({ run: { label: "Generating…", busy: true } }));
    const run = field(view, "run");
    expect(run?.tone).toBe("accent");
    expect(run?.live).toBe(true);
    expect(view.liveSummary).toContain("Generating…");
  });

  it("reflects the language and completion availability", () => {
    const on = deriveEditorStatusBar(input({ languageId: "javascript", completionsEnabled: true }));
    expect(field(on, "language")?.label).toBe("JavaScript");
    expect(field(on, "completions")?.label).toBe("Completions on");
    const off = deriveEditorStatusBar(input({ completionsEnabled: false }));
    expect(field(off, "completions")?.label).toBe("Completions off");
  });

  it("shows degraded large-file status as a live field", () => {
    const view = deriveEditorStatusBar(input({ largeFileMode: "degraded" }));
    const mode = field(view, "large-file");
    expect(mode?.label).toBe("Large file mode");
    expect(mode?.tone).toBe("warn");
    expect(view.liveSummary).toContain("Large file mode: completions and analysis disabled");
  });

  it("shows a read-only field and announces it", () => {
    const view = deriveEditorStatusBar(input({ readOnly: true }));
    expect(field(view, "readonly")?.tone).toBe("warn");
    expect(view.liveSummary).toContain("Read-only document");
  });

  it("shows the selection field only for a multi-line selection", () => {
    expect(
      field(deriveEditorStatusBar(input({ selectedLineCount: 1 })), "selection"),
    ).toBeUndefined();
    expect(field(deriveEditorStatusBar(input({ selectedLineCount: 4 })), "selection")?.label).toBe(
      "4 lines selected",
    );
  });
});

describe("deriveEditorStatusBar debug field", () => {
  it("is absent until the host injects a debug projection", () => {
    expect(debugField(undefined)).toBeNull();
    expect(field(deriveEditorStatusBar(input()), "debug")).toBeUndefined();
  });

  it("uses the existing assertive status region for a paused session", () => {
    const view = deriveEditorStatusBar(input({ debug: { state: "paused" } }));
    expect(field(view, "debug")).toMatchObject({
      id: "debug",
      tone: "accent",
      live: true,
      assertive: true,
    });
    expect(view.alertSummary).toContain("Debug session paused");
  });

  it("distinguishes an exception pause from an ordinary breakpoint pause in the assertive summary", () => {
    // Without this distinction a screen-reader user hears the identical "Debug session paused" for
    // an uncaught exception and for a routine breakpoint hit — the one moment sighted users can tell
    // apart via DebugPanel's visible "Exception: ..." text becomes indistinguishable by ear.
    const exceptionView = deriveEditorStatusBar(
      input({ debug: { state: "paused", isExceptionPause: true } }),
    );
    expect(field(exceptionView, "debug")).toMatchObject({ tone: "error", assertive: true });
    expect(field(exceptionView, "debug")?.ariaLabel).toContain("exception");
    expect(exceptionView.alertSummary).toContain("exception");

    const ordinaryView = deriveEditorStatusBar(input({ debug: { state: "paused" } }));
    expect(field(ordinaryView, "debug")?.ariaLabel).not.toContain("exception");
    expect(ordinaryView.alertSummary).not.toContain("exception");

    const explicitlyNotException = deriveEditorStatusBar(
      input({ debug: { state: "paused", isExceptionPause: false } }),
    );
    expect(field(explicitlyNotException, "debug")?.ariaLabel).not.toContain("exception");
  });

  it("announces running and stopped state politely without a second live surface", () => {
    const running = deriveEditorStatusBar(input({ debug: { state: "running" } }));
    const stopped = deriveEditorStatusBar(input({ debug: { state: "stopped" } }));
    expect(running.liveSummary).toContain("Debug running");
    expect(stopped.liveSummary).toContain("Debug session stopped");
    expect(running.alertSummary).toBe("");
  });

  it("labels an in-flight stop distinctly from a session that is still starting", () => {
    const view = deriveEditorStatusBar(input({ debug: { state: "stopping" } }));
    expect(field(view, "debug")).toMatchObject({ id: "debug", tone: "accent", live: true });
    expect(field(view, "debug")?.label).toBe("Debug stopping");
    expect(view.liveSummary).toContain("Debug session stopping");
    expect(view.liveSummary).not.toContain("Debug starting");
    expect(view.alertSummary).toBe("");
  });
});

describe("deriveEditorStatusBar formatting field (ADR-0068 D4)", () => {
  it("is absent when the host wires no formatting state", () => {
    expect(field(deriveEditorStatusBar(input()), "formatting")).toBeUndefined();
  });

  it("shows 'Format ready' with a default tone when formatting is available", () => {
    const view = deriveEditorStatusBar(
      input({ formatting: { available: true, source: "monaco-builtin" } }),
    );
    const formatting = field(view, "formatting");
    expect(formatting?.label).toBe("Format ready");
    expect(formatting?.ariaLabel).toBe("Document formatting available");
    expect(formatting?.tone).toBe("default");
  });

  it("shows 'Format unavailable' with a warn tone when formatting is unavailable", () => {
    const view = deriveEditorStatusBar(input({ formatting: { available: false, source: "none" } }));
    const formatting = field(view, "formatting");
    expect(formatting?.label).toBe("Format unavailable");
    expect(formatting?.ariaLabel).toBe("Document formatting is unavailable for this language");
    expect(formatting?.tone).toBe("warn");
  });

  it("never announces the formatting field (non-live, non-assertive)", () => {
    const available = deriveEditorStatusBar(
      input({ formatting: { available: true, source: "keiko-language-service" } }),
    );
    expect(field(available, "formatting")?.live).toBe(false);
    expect(field(available, "formatting")?.assertive).toBe(false);
    expect(available.liveSummary).not.toContain("Document formatting");
    expect(available.alertSummary).not.toContain("Document formatting");

    const unavailable = deriveEditorStatusBar(
      input({ formatting: { available: false, source: "none" } }),
    );
    expect(unavailable.liveSummary).not.toContain("Document formatting");
    expect(unavailable.alertSummary).not.toContain("Document formatting");
  });

  it("places the formatting field directly after the language-service field", () => {
    const view = deriveEditorStatusBar(
      input({
        languageService: { providerId: null, available: true },
        formatting: { available: true, source: "monaco-builtin" },
      }),
    );
    const ids = view.fields.map((entry) => entry.id);
    const languageServiceIndex = ids.indexOf("language-service");
    const formattingIndex = ids.indexOf("formatting");
    expect(languageServiceIndex).toBeGreaterThanOrEqual(0);
    expect(formattingIndex).toBe(languageServiceIndex + 1);
  });
});
