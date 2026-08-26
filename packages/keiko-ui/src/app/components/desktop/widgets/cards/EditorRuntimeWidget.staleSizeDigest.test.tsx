/**
 * Regression coverage for two PR #3289 review findings, both rooted in the same
 * `activeContentDigest` debounce window (CONTENT_HASH_DEBOUNCE_MS, 150ms):
 *
 * 1. [P1] The buffer's `content.sizeBytes` used to read `activeContentDigest?.sizeBytes ?? 0`
 *    directly — the STALE digest for whatever content last settled, not necessarily the CURRENT
 *    `content`. A paste that pushes a small file over the size limit was reported at its old,
 *    small size for the whole debounce window, so the hard size-limit gate (`isMaxSizeExceeded` /
 *    `effectiveReadOnly` in `@oscharko-dev/keiko-editor`'s `save-state.ts`, which reads exactly
 *    `buffer.content.sizeBytes`) would see the buffer as well under budget immediately after the
 *    paste.
 *
 * 2. [P2] `largeFileMode` was derived from raw `content.length` (UTF-16 code units) forever —
 *    never the exact, debounced `readyContentDigest.sizeBytes` — so a buffer whose UTF-16 length
 *    stays under the 500,000-byte degraded threshold while its real UTF-8 byte size is over it
 *    (any heavy multibyte content, e.g. CJK) never enters degraded mode, no matter how long the
 *    debounce has had to settle.
 *
 * Both are fixed by a single value (`currentSizeBytesEstimate`): byte-exact once
 * `freshContentDigest` has resolved for the CURRENT content, a conservative (never-under)
 * `content.length * 4` estimate otherwise — fed to both the buffer's `sizeBytes` (1) and
 * `largeFileMode` (2) instead of a stale digest or a raw, encoding-blind length.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const DISK_CONTENT_BYTES = 17;
const BASE_VERSION = { sizeBytes: DISK_CONTENT_BYTES, modifiedAt: 1, contentHash: "a".repeat(64) };

function editorSettingsSnapshot(): EditorM11SettingsSnapshot {
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    storeState: "ready",
    userRevision: 1,
    workspaceRevision: 0,
    revision: 1_000_000,
    etag: '"edm7-1-0-stale-size-digest"',
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
    sizeBytes: DISK_CONTENT_BYTES,
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
});

afterEach(() => {
  surface.props = null;
  vi.clearAllMocks();
});

// Renders the widget and lets the INITIAL load's own debounced digest settle first, so the
// assertions in each test observe the simulated edit's pending window, not the file-open one.
async function renderAndSettleInitialDigest(over?: Partial<FilesContentResponse>): Promise<void> {
  if (over !== undefined) {
    vi.mocked(fetchFilesContent).mockResolvedValue(fileResponse(over));
  }
  render(<EditorRuntimeWidget windowId="stale-size-digest" root="/repo" file="src/app.ts" />);
  await screen.findByTestId("editor-surface");
  await waitFor(() => {
    expect(surface.props?.buffer.content.sizeBytes).toBe(DISK_CONTENT_BYTES);
  });
}

describe("EditorRuntimeWidget buffer sizeBytes vs. stale digest (PR #3289 review, P1)", () => {
  it("never pairs the current (pasted) text with the previous, smaller settled sizeBytes", async () => {
    const maxBytes = 50;
    await renderAndSettleInitialDigest({ maxBytes });

    // Paste content that genuinely exceeds maxBytes (80 > 50) — the exploit scenario from the
    // review: a small document pasted over with an oversized one.
    const oversizedText = "x".repeat(80);
    act(() => {
      surface.props?.onContentChange(
        { text: oversizedText, sizeBytes: oversizedText.length },
        "human",
      );
    });

    // THE regression assertion: against the pre-fix code, sizeBytes here would still read the
    // stale, settled digest for the OLD (17-byte) disk content — nowhere near maxBytes — so the
    // hard size-limit gate (isMaxSizeExceeded: `content.sizeBytes > maxBytes`) would wrongly see
    // this buffer as well under budget for the whole debounce window.
    expect(surface.props?.buffer.content.text).toBe(oversizedText);
    expect(surface.props?.buffer.content.sizeBytes).toBeGreaterThan(maxBytes);

    // And it stays correctly over budget once the debounce settles with the exact byte count.
    await waitFor(() => {
      expect(surface.props?.buffer.content.sizeBytes).toBe(oversizedText.length);
    });
    expect(surface.props?.buffer.content.sizeBytes).toBeGreaterThan(maxBytes);
  });
});

describe("EditorRuntimeWidget largeFileMode vs. UTF-16 length (PR #3289 review, P2)", () => {
  it("enters degraded mode for heavy multibyte content whose UTF-16 length understates its UTF-8 byte size", async () => {
    await renderAndSettleInitialDigest();

    // 200,000 CJK characters: ~600 KB of UTF-8 (3 bytes each) but a UTF-16 length of 200,000 —
    // under the 500,000-byte LARGE_FILE_DEGRADED_BYTES threshold if length were mistaken for
    // bytes (the review's own example). No newlines, so only the byte threshold is exercised, not
    // the separate line-count one.
    const cjkText = "中".repeat(200_000);
    act(() => {
      surface.props?.onContentChange({ text: cjkText, sizeBytes: cjkText.length }, "human");
    });

    // `buffer.readOnly` is `editorReadOnlyBySettings`, driven purely by largeFileMode under the
    // default "default" largeFileMode setting (see largeFileSettings) — an isolated, directly
    // observable proxy for the mode without reaching into @oscharko-dev/keiko-editor internals.
    // Immediately: the conservative estimate (200,000 * 4 = 800,000) already exceeds 500,000, so
    // the fix degrades right away instead of waiting out the debounce.
    expect(surface.props?.buffer.readOnly).toBe(true);

    // THE regression assertion: pre-fix, largeFileMode is derived from content.length alone
    // (200,000 < 500,000) and NEVER switches to the exact, debounced byte count (600,000) — this
    // would stay false forever, no matter how long the debounce has settled.
    await waitFor(() => {
      expect(surface.props?.buffer.content.sizeBytes).toBe(cjkText.length * 3);
    });
    expect(surface.props?.buffer.readOnly).toBe(true);
  });
});
