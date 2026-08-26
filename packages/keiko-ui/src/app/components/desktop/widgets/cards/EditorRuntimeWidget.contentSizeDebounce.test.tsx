/**
 * Per-keystroke UTF-8 encode cost of the content-size/hash bookkeeping (KEIKO-0819).
 *
 * `contentBytes` used to be a `useMemo(() => UTF8_ENCODER.encode(content), [content])`, which reruns
 * a full UTF-8 encode of the entire buffer on every keystroke since `content` changes every
 * keystroke. That memo fed both `largeFileMode` and the debounced content-hash effect
 * (CONTENT_HASH_DEBOUNCE_MS, 150ms) that computes `activeContentDigest` for hot-exit persistence and
 * save bookkeeping — so the full-buffer encode ran once per keystroke even though the hash consumer
 * only needed it once per debounce window. The fix moves the exact-byte encode inside the debounced
 * effect (computed once per window, alongside the hash it already feeds) and derives the immediate,
 * per-keystroke large-file signal from the cheap `content.length` upper... i.e. lower-bound proxy
 * instead (UTF-8 byte length is always >= UTF-16 code-unit length for the same string).
 *
 * This test spies on the global `TextEncoder.prototype.encode` (call-through, not faked — the real
 * bytes still have to reach `crypto.subtle.digest`) and simulates several rapid content edits, all
 * well inside one CONTENT_HASH_DEBOUNCE_MS window. Against the pre-fix code, each edit synchronously
 * re-runs the memo, so the encode count already reaches N immediately after typing, before any timer
 * fires. After the fix, no encode runs synchronously from typing at all — only the debounced effect's
 * timer produces exactly one encode call per settled window, real timers required (matches the
 * harness pattern in EditorRuntimeWidget.hotExitFlush.test.tsx).
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
import type { FilesContentResponse } from "../../../../../lib/types";
import {
  fetchEditorSettings,
  fetchFilesContent,
  fetchGitStatus,
  postEditorAgentSessionSnapshot,
} from "../../../../../lib/api";
import type { EditorSurfaceProps } from "./EditorSurface";
import EditorRuntimeWidget from "./EditorRuntimeWidget";

vi.mock("../../../../../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../../lib/api")>("../../../../../lib/api");
  return {
    ...actual,
    fetchEditorLanguageCapabilities: vi.fn(() =>
      Promise.resolve({ schemaVersion: "1", providers: [] }),
    ),
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
const BASE_VERSION = { sizeBytes: 17, modifiedAt: 1, contentHash: "a".repeat(64) };

function editorSettingsSnapshot(): EditorM11SettingsSnapshot {
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    storeState: "ready",
    userRevision: 1,
    workspaceRevision: 0,
    revision: 1_000_000,
    etag: '"edm7-1-0-content-size-debounce"',
    root: "/repo",
    definitions: EDITOR_M7_SETTING_REGISTRY,
    settings: resolveEditorM11Settings({
      user: { scope: "user", values: { formatOnSave: false } },
    }),
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

let encodeSpy: MockInstance<typeof TextEncoder.prototype.encode> | null = null;

beforeEach(() => {
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
  vi.mocked(fetchEditorSettings).mockResolvedValue(editorSettingsSnapshot());
  vi.mocked(fetchFilesContent).mockResolvedValue(fileResponse());
  // Call-through: the real encoded bytes still have to reach crypto.subtle.digest, this only counts.
  encodeSpy = vi.spyOn(TextEncoder.prototype, "encode");
});

afterEach(() => {
  surface.props = null;
  encodeSpy?.mockRestore();
  encodeSpy = null;
  vi.clearAllMocks();
});

describe("EditorRuntimeWidget content-size encode debouncing (KEIKO-0819)", () => {
  it("does not re-run the full UTF-8 encode synchronously on every keystroke, only once per settled debounce window", async () => {
    render(<EditorRuntimeWidget windowId="content-size-debounce" root="/repo" file="src/app.ts" />);
    await screen.findByTestId("editor-surface");

    // Let the initial-load content settle its own debounced hash/size encode first, so it cannot be
    // mistaken for one produced by the simulated keystrokes below.
    await waitFor(() => {
      expect(encodeSpy?.mock.calls.length ?? 0).toBeGreaterThanOrEqual(1);
    });
    encodeSpy?.mockClear();

    // Five rapid "keystrokes", each strictly faster than CONTENT_HASH_DEBOUNCE_MS (150ms) apart —
    // synchronous act() calls in a tight loop take microseconds, nowhere near 150ms of real time.
    const base = DISK_CONTENT;
    for (let index = 1; index <= 5; index += 1) {
      const next = `${base}// edit ${"x".repeat(index)}\n`;
      act(() => {
        surface.props?.onContentChange({ text: next, sizeBytes: next.length }, "human");
      });
    }

    // The regression: against the pre-fix code, the `contentBytes` useMemo re-runs synchronously on
    // every one of the 5 content changes above (no timer involved), so the encode count would already
    // be 5 here. The fix defers the full-buffer encode entirely into the debounced effect's timer.
    expect(encodeSpy?.mock.calls.length ?? -1).toBe(0);

    // After the debounce window elapses (real timer), exactly one encode call lands — for the final
    // settled content, not one per edit.
    await waitFor(() => {
      expect(encodeSpy?.mock.calls.length ?? 0).toBe(1);
    });

    // Give any (incorrect) extra per-edit timers a chance to fire too, then confirm the count holds at
    // exactly one rather than climbing to 5.
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
    expect(encodeSpy?.mock.calls.length ?? -1).toBe(1);
  });
});
