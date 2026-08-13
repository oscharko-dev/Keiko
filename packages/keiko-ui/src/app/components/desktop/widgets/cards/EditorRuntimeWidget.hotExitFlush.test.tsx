/**
 * Hot-exit flush on tab close/refresh (KEIKO-0337).
 *
 * The hot-exit persistence effect debounces its IndexedDB write by HOT_EXIT_WRITE_DEBOUNCE_MS
 * (400ms) so rapid typing does not thrash the store. Nothing flushed that pending write when the
 * tab actually closed or navigated away: a graceful close fires `pagehide`, and the debounce timer
 * never gets the remaining time it needed to fire — the last edit was silently lost. The fix clears
 * the pending timer and writes the latest in-buffer content synchronously (fire-and-forget —
 * `writeEditorHotExitSnapshot` is IndexedDB + async-hash based and a pagehide handler cannot await)
 * from a `pagehide` listener registered alongside the debounce effect and torn down with it.
 *
 * The harness mirrors EditorRuntimeWidget.formatOnSaveCap.test.tsx: mocked API, mocked hot-exit
 * store, no Monaco in jsdom. `window.setTimeout` is spied (call-through, not faked) so the test can
 * detect — with real timers — the exact moment the 400ms hot-exit timer is armed. The hot-exit
 * debounce only starts once the SEPARATELY debounced, async-hashed content digest resolves
 * (CONTENT_HASH_DEBOUNCE_MS, 150ms), so a fixed sleep would either fire too early (nothing armed
 * yet, the pagehide listener for THIS content never registered) or risk racing the real 400ms
 * window on slow CI.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  EDITOR_M7_SCHEMA_VERSION,
  EDITOR_M7_SETTING_REGISTRY,
  resolveEditorM11Settings,
  type EditorM11SettingsSnapshot,
} from "@oscharko-dev/keiko-contracts";
import type { FilesContentResponse, LanguageServiceCapabilities } from "../../../../../lib/types";
import {
  fetchEditorLanguageCapabilities,
  fetchEditorSettings,
  fetchFilesContent,
  fetchGitStatus,
  postEditorAgentSessionSnapshot,
} from "../../../../../lib/api";
import type { EditorSurfaceProps } from "./EditorSurface";
import { writeEditorHotExitSnapshot } from "./editorHotExitStore";
import EditorRuntimeWidget from "./EditorRuntimeWidget";

vi.mock("../../../../../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../../lib/api")>("../../../../../lib/api");
  return {
    ...actual,
    fetchEditorLanguageCapabilities: vi.fn(),
    fetchEditorSettings: vi.fn(),
    fetchFilesContent: vi.fn(),
    fetchGitStatus: vi.fn(),
    postEditorAgentActionResult: vi.fn(),
    postEditorAgentSessionSnapshot: vi.fn(),
    saveFilesContent: vi.fn(),
    requestEditorCompletion: vi.fn(),
    requestEditorInlineCompletion: vi.fn(),
    reportEditorInlineCompletionTelemetry: vi.fn(() => Promise.resolve()),
    requestEditorDiagnostics: vi.fn(),
    requestEditorHover: vi.fn(),
    requestEditorSymbols: vi.fn(),
    requestEditorFormatting: vi.fn(),
    requestEditorDefinition: vi.fn(),
    requestEditorReferences: vi.fn(),
    requestEditorRenamePrepare: vi.fn(),
    requestEditorRenameApply: vi.fn(),
    requestEditorCodeActions: vi.fn(),
    requestEditorSignatureHelp: vi.fn(),
    requestEditorTestGeneration: vi.fn(),
  };
});

vi.mock("./editorHotExitStore", () => ({
  readEditorHotExitSnapshot: vi.fn(() => Promise.resolve(null)),
  writeEditorHotExitSnapshot: vi.fn(() => Promise.resolve()),
  deleteEditorHotExitSnapshot: vi.fn(() => Promise.resolve()),
}));

const surface: { props: EditorSurfaceProps | null } = { props: null };

vi.mock("next/dynamic", () => ({
  default: () =>
    function DynamicProbe(props: Record<string, unknown>): ReactElement | null {
      if ("buffer" in props) {
        surface.props = props as unknown as EditorSurfaceProps;
        return <div data-testid="editor-surface" />;
      }
      return null;
    },
}));

const DISK_CONTENT = "const value = 1;\n";
const EDITED_CONTENT = "const value = 2; // edited just before tab close\n";
const BASE_VERSION = { sizeBytes: 17, modifiedAt: 1, contentHash: "a".repeat(64) };

// Mirrors HOT_EXIT_WRITE_DEBOUNCE_MS in EditorRuntimeWidget.tsx, which is deliberately not
// exported. The pin below spies on the concrete `window.setTimeout` call rather than importing the
// constant, so it fails honestly if the production delay argument ever drifts from this value.
const HOT_EXIT_WRITE_DEBOUNCE_MS = 400;

const LANGUAGE_CAPABILITIES: LanguageServiceCapabilities = {
  schemaVersion: "1",
  providers: [
    {
      id: "typescript",
      languages: ["typescript", "javascript"],
      operations: ["diagnostics", "completion", "hover", "symbols", "formatting"],
      availability: "available",
    },
  ],
};

function editorSettingsSnapshot(formatOnSave: boolean): EditorM11SettingsSnapshot {
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    storeState: "ready",
    userRevision: 1,
    workspaceRevision: 0,
    revision: 1_000_000,
    etag: '"edm7-1-0-hot-exit-flush"',
    root: "/repo",
    definitions: EDITOR_M7_SETTING_REGISTRY,
    settings: resolveEditorM11Settings({ user: { scope: "user", values: { formatOnSave } } }),
    eventSequence: 1,
  };
}

function fileResponse(over?: Partial<FilesContentResponse>): FilesContentResponse {
  return {
    root: "/repo",
    path: "src/app.ts",
    name: "app.ts",
    sizeBytes: 17,
    modifiedAt: 1,
    extension: "ts",
    mime: "text/plain",
    symlink: false,
    content: DISK_CONTENT,
    maxBytes: 1_000_000,
    session: { schemaVersion: "1", version: BASE_VERSION },
    ...over,
  };
}

let setTimeoutSpy: MockInstance<typeof window.setTimeout> | null = null;

beforeEach(() => {
  vi.mocked(fetchEditorLanguageCapabilities).mockResolvedValue(LANGUAGE_CAPABILITIES);
  vi.mocked(fetchGitStatus).mockResolvedValue({
    schemaVersion: "1",
    root: "/repo",
    state: "available",
    available: true,
    detached: false,
    clean: true,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    changes: [],
    truncated: false,
    maxChanges: 500,
  });
  vi.mocked(postEditorAgentSessionSnapshot).mockResolvedValue({ snapshot: null });
  vi.mocked(fetchEditorSettings).mockResolvedValue(editorSettingsSnapshot(false));
  vi.mocked(fetchFilesContent).mockResolvedValue(fileResponse());
});

afterEach(() => {
  surface.props = null;
  setTimeoutSpy?.mockRestore();
  setTimeoutSpy = null;
  vi.clearAllMocks();
});

describe("EditorRuntimeWidget hot-exit pagehide flush (KEIKO-0337)", () => {
  it("starts the pending write when the document becomes hidden before page teardown", async () => {
    setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const visibilityState = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");

    render(<EditorRuntimeWidget windowId="hot-exit-hidden" root="/repo" file="src/app.ts" />);
    await screen.findByTestId("editor-surface");

    act(() => {
      surface.props?.onContentChange(
        { text: EDITED_CONTENT, sizeBytes: EDITED_CONTENT.length },
        "human",
      );
    });
    await waitFor(() => {
      const armed = setTimeoutSpy?.mock.calls.some(
        ([, delay]) => delay === HOT_EXIT_WRITE_DEBOUNCE_MS,
      );
      expect(armed).toBe(true);
    });
    expect(writeEditorHotExitSnapshot).not.toHaveBeenCalled();

    visibilityState.mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(writeEditorHotExitSnapshot).toHaveBeenCalledOnce();
    expect(writeEditorHotExitSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ content: EDITED_CONTENT }),
    );
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(writeEditorHotExitSnapshot).toHaveBeenCalledOnce();
    visibilityState.mockRestore();
  });

  it("flushes the pending hot-exit write on pagehide before the debounce timer fires", async () => {
    const realSetTimeout = globalThis.setTimeout;
    setTimeoutSpy = vi.spyOn(window, "setTimeout");

    render(<EditorRuntimeWidget windowId="hot-exit-flush" root="/repo" file="src/app.ts" />);
    await screen.findByTestId("editor-surface");

    act(() => {
      surface.props?.onContentChange(
        { text: EDITED_CONTENT, sizeBytes: EDITED_CONTENT.length },
        "human",
      );
    });

    // The hot-exit debounce only arms once the separately debounced, async-hashed content digest
    // resolves — wait for the real `window.setTimeout(_, 400)` call instead of guessing a sleep.
    await waitFor(() => {
      const armed = setTimeoutSpy?.mock.calls.some(
        ([, delay]) => delay === HOT_EXIT_WRITE_DEBOUNCE_MS,
      );
      expect(armed).toBe(true);
    });
    expect(writeEditorHotExitSnapshot).not.toHaveBeenCalled();

    // Simulate a graceful tab close/refresh well inside the 400ms window — the debounce timer
    // itself never gets the chance to fire on its own.
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(writeEditorHotExitSnapshot).toHaveBeenCalledTimes(1);
    expect(writeEditorHotExitSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: "/repo",
        relativePath: "src/app.ts",
        content: EDITED_CONTENT,
      }),
    );

    // The pending timer must have been cleared, not merely raced: waiting past its original 400ms
    // schedule must not produce a second, redundant write.
    await new Promise<void>((resolve) => {
      realSetTimeout(resolve, HOT_EXIT_WRITE_DEBOUNCE_MS + 150);
    });
    expect(writeEditorHotExitSnapshot).toHaveBeenCalledTimes(1);
  });
});
