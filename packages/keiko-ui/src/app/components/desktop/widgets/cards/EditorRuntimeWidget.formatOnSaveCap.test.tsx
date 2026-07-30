/**
 * Format-on-save never writes a capped reformat to disk (0.3.0 release audit).
 *
 * The server caps a formatting result (`maxFormattingEdits`, plus the aggregate replacement-byte
 * ceiling) and reports it as `truncated`. Before this pin the save path dropped that flag: it applied
 * whatever edits survived the cap to the buffer and then WROTE the file, so a half-formatted document
 * reached disk while the editor reported a clean, successful save. It is the same defect the rename
 * changeset fix closed by refusing Accept, on a path that persists.
 *
 * The harness mirrors EditorRuntimeWidget.historyRestore.test.tsx: mocked API, mocked hot-exit store,
 * no Monaco in jsdom, and `formatOnSave` enabled through the real settings resolver.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  requestEditorFormatting,
  saveFilesContent,
} from "../../../../../lib/api";
import type { EditorSurfaceProps } from "./EditorSurface";
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
const EDITED_CONTENT = "const   value = 2;\n";
const BASE_VERSION = { sizeBytes: 17, modifiedAt: 1, contentHash: "a".repeat(64) };

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
    etag: '"edm7-1-0-format-on-save-cap"',
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

/** One edit that collapses the extra spaces the user typed — a real, applicable reformat. */
const REFORMAT_EDIT = {
  range: { start: { line: 0, character: 5 }, end: { line: 0, character: 8 } },
  newText: " ",
};

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
  vi.mocked(fetchEditorSettings).mockResolvedValue(editorSettingsSnapshot(true));
  vi.mocked(fetchFilesContent).mockResolvedValue(fileResponse());
  vi.mocked(saveFilesContent).mockResolvedValue(
    fileResponse({
      content: EDITED_CONTENT,
      session: { schemaVersion: "1", version: { ...BASE_VERSION, modifiedAt: 2 } },
    }),
  );
});

afterEach(() => {
  surface.props = null;
  vi.clearAllMocks();
});

async function editAndSave(): Promise<void> {
  render(<EditorRuntimeWidget windowId="format-cap" root="/repo" file="src/app.ts" />);
  await screen.findByTestId("editor-surface");
  act(() => {
    surface.props?.onContentChange(
      { text: EDITED_CONTENT, sizeBytes: EDITED_CONTENT.length },
      "human",
    );
  });
  await userEvent.click(await screen.findByRole("button", { name: "Save" }));
  await waitFor(() => {
    expect(requestEditorFormatting).toHaveBeenCalled();
  });
}

describe("EditorRuntimeWidget format-on-save result cap", () => {
  it("refuses to write a capped reformat and says so", async () => {
    vi.mocked(requestEditorFormatting).mockResolvedValue({
      edits: [REFORMAT_EDIT],
      truncated: true,
    });

    await editAndSave();

    await waitFor(() => {
      expect(surface.props?.saveStatus).toBe("error");
    });
    // The half-formatted text never reaches disk.
    expect(saveFilesContent).not.toHaveBeenCalled();
    // Nor the buffer: the user's own text is what is still open, unformatted and still dirty.
    expect(surface.props?.buffer.content.text).toBe(EDITED_CONTENT);
    expect(surface.props?.fileModel.dirty).toBe(true);
    expect(surface.props?.saveError ?? "").toMatch(/result limit/iu);
  });

  it("refuses when the cap dropped every edit, instead of reporting a clean save", async () => {
    // The aggregate replacement-byte ceiling can drop ALL edits while still reporting the cap. The
    // edit list is then empty, which the pre-fix code read as "already formatted" and saved as if
    // format-on-save had run — the most silent form of the same lie.
    vi.mocked(requestEditorFormatting).mockResolvedValue({ edits: [], truncated: true });

    await editAndSave();

    await waitFor(() => {
      expect(surface.props?.saveStatus).toBe("error");
    });
    expect(saveFilesContent).not.toHaveBeenCalled();
    expect(surface.props?.fileModel.dirty).toBe(true);
  });

  it("writes a complete reformat that reports itself uncapped", async () => {
    vi.mocked(requestEditorFormatting).mockResolvedValue({
      edits: [REFORMAT_EDIT],
      truncated: false,
    });

    await editAndSave();

    await waitFor(() => {
      expect(saveFilesContent).toHaveBeenCalled();
    });
    const [request] = vi.mocked(saveFilesContent).mock.calls[0] ?? [];
    expect(request?.content).toBe("const value = 2;\n");
  });

  it("writes an uncapped empty reformat as an already-formatted document", async () => {
    vi.mocked(requestEditorFormatting).mockResolvedValue({ edits: [], truncated: false });

    await editAndSave();

    await waitFor(() => {
      expect(saveFilesContent).toHaveBeenCalled();
    });
    const [request] = vi.mocked(saveFilesContent).mock.calls[0] ?? [];
    expect(request?.content).toBe(EDITED_CONTENT);
  });
});
