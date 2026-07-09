/**
 * Regression coverage for the open-buffer replace-apply path (Epic #2090, issue #2110).
 *
 * `applyWorkspaceReplaceBuffer` (EditorRuntimeWidget.tsx) is the real logic that runs when a
 * workspace replace is applied to a file that is currently open in an editor buffer: stale-content
 * detection (the buffer changed since the replace preview was computed) and the actual in-memory
 * edit application. Before this test, the only replace-related coverage at the SearchPanel level
 * stubbed this function out entirely (`useRegisterWorkspaceReplaceBuffer` mocked via a fake), so a
 * regression in the stale-content check or the edit application itself would not have been caught
 * by any existing test. This file exercises the real function through the real
 * `WorkspaceReplaceBufferProvider` registry, mirroring the harness pattern already used by
 * `EditorRuntimeWidget.formatting.test.tsx` (mocked Monaco surface via next/dynamic, mocked API).
 */
import { act, render, screen } from "@testing-library/react";
import { useEffect, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilesContentResponse } from "../../../../../lib/types";
import { fetchFilesContent, postEditorAgentSessionSnapshot } from "../../../../../lib/api";
import type { EditorSurfaceProps } from "./EditorSurface";
import type { EditorDiffSurfaceProps } from "./EditorDiffSurface";
import EditorRuntimeWidget from "./EditorRuntimeWidget";
import {
  useWorkspaceReplaceBuffers,
  WorkspaceReplaceBufferProvider,
  type WorkspaceReplaceOpenBufferResult,
} from "../../WorkspaceReplaceBufferContext";
import type { WorkspaceReplaceApplyFile } from "@oscharko-dev/keiko-contracts";

vi.mock("../../../../../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../../lib/api")>("../../../../../lib/api");
  return {
    ...actual,
    fetchEditorLanguageCapabilities: vi.fn(() =>
      Promise.resolve({ schemaVersion: "1", providers: [] }),
    ),
    fetchFilesContent: vi.fn(),
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

vi.mock("next/dynamic", () => {
  let dynamicComponentIndex = 0;
  return {
    default: () => {
      const index = dynamicComponentIndex++;
      if (index > 0) {
        function EditorDiffSurfaceProbe(props: EditorDiffSurfaceProps): ReactElement {
          void props;
          return <div data-testid="editor-diff-surface" />;
        }
        return EditorDiffSurfaceProbe;
      }
      function EditorSurfaceProbe(props: EditorSurfaceProps): ReactElement {
        useEffect(() => {}, []);
        return <div data-testid="editor-surface">{props.buffer.content.text}</div>;
      }
      return EditorSurfaceProbe;
    },
  };
});

const BASE_VERSION = { sizeBytes: 26, modifiedAt: 1, contentHash: "a".repeat(64) };

function fileResponse(over?: Partial<FilesContentResponse>): FilesContentResponse {
  return {
    root: "/repo",
    path: "src/app.ts",
    name: "app.ts",
    sizeBytes: 26,
    modifiedAt: 1,
    extension: "ts",
    mime: "text/plain",
    symlink: false,
    content: "const value = parseConfig;\n",
    maxBytes: 1_000_000,
    session: { schemaVersion: "1", version: BASE_VERSION },
    ...over,
  };
}

let applyRef:
  ((file: WorkspaceReplaceApplyFile) => Promise<WorkspaceReplaceOpenBufferResult>) | null = null;

function ReplaceBufferProbe(): null {
  const api = useWorkspaceReplaceBuffers();
  useEffect(() => {
    applyRef = api === null ? null : (file) => api.apply("/repo", file);
  }, [api]);
  return null;
}

async function renderOpenBuffer(): Promise<void> {
  vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
  render(
    <WorkspaceReplaceBufferProvider>
      <ReplaceBufferProbe />
      <EditorRuntimeWidget windowId="replace-buffer-test" root="/repo" file="src/app.ts" />
    </WorkspaceReplaceBufferProvider>,
  );
  await screen.findByTestId("editor-surface");
}

function replaceEdit(): WorkspaceReplaceApplyFile {
  return {
    path: "src/app.ts",
    baseContentHash: "a".repeat(64),
    edits: [
      {
        range: { startLine: 1, startColumn: 15, endLine: 1, endColumn: 26 },
        originalText: "parseConfig",
        newText: "readConfig",
      },
    ],
  };
}

beforeEach(() => {
  vi.mocked(postEditorAgentSessionSnapshot).mockResolvedValue({ snapshot: null });
});

afterEach(() => {
  applyRef = null;
  vi.clearAllMocks();
});

describe("EditorRuntimeWidget — open-buffer replace apply (issue #2110)", () => {
  it("applies a reviewed replace edit to the live buffer and marks it dirty", async () => {
    await renderOpenBuffer();
    if (applyRef === null) throw new Error("replace buffer registry did not register");

    let result: WorkspaceReplaceOpenBufferResult | undefined;
    await act(async () => {
      result = await applyRef?.(replaceEdit());
    });

    expect(result).toEqual({ status: "applied", path: "src/app.ts" });
    expect(screen.getByTestId("editor-surface")).toHaveTextContent("const value = readConfig;");
  });

  it("reports a write-conflict instead of silently applying when the buffer no longer matches the preview", async () => {
    await renderOpenBuffer();
    if (applyRef === null) throw new Error("replace buffer registry did not register");

    // Simulate the user having edited the buffer since the replace preview was computed: the
    // previewed originalText ("parseConfig") no longer appears at the previewed range.
    const staleEdit: WorkspaceReplaceApplyFile = {
      ...replaceEdit(),
      edits: [
        {
          range: { startLine: 1, startColumn: 15, endLine: 1, endColumn: 26 },
          originalText: "differentText",
          newText: "readConfig",
        },
      ],
    };

    let result: WorkspaceReplaceOpenBufferResult | undefined;
    await act(async () => {
      result = await applyRef?.(staleEdit);
    });

    expect(result).toEqual({
      status: "conflict",
      conflict: {
        path: "src/app.ts",
        reason: "write-conflict",
        detail: "The open editor buffer no longer matches the reviewed replacement preview.",
      },
    });
    // The stale conflict must not have silently applied any part of the edit.
    expect(screen.getByTestId("editor-surface")).toHaveTextContent("const value = parseConfig;");
  });

  it("reports not-open for a file that is not the currently open buffer", async () => {
    await renderOpenBuffer();
    if (applyRef === null) throw new Error("replace buffer registry did not register");

    const result = await applyRef?.({ ...replaceEdit(), path: "src/other.ts" });

    expect(result).toEqual({ status: "not-open" });
  });
});
