/**
 * Honest local-history restore failures (Issue #2617, Wave-2 audit of epic #2285, finding 5).
 *
 * `persist` adopts the text into the open buffer before the write so the save can reconcile against
 * it. That is right for a save of the user's own edits, but a restore feeds it content the buffer
 * never held: before this regression pin, every failing write left the checkpoint content sitting
 * in the buffer, marked dirty, while the history panel reported "The version was not restored." The
 * user was told nothing happened after their buffer had already changed.
 *
 * The harness mirrors EditorRuntimeWidget.formatting.test.tsx (mocked API, mocked hot-exit store,
 * no Monaco in jsdom); unlike the other suites it renders the REAL EditorFileHistoryPanel behind the
 * `next/dynamic` boundary so the restore runs through the actual confirm flow.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EDITOR_LOCAL_HISTORY_ENCRYPTION,
  EDITOR_LOCAL_HISTORY_SCHEMA_VERSION,
  isWorkspaceContentDigest,
  isWorkspaceHistoryEntryRef,
  isWorkspaceIsoInstant,
  isWorkspacePathDigest,
  isWorkspaceRootIdentityDigest,
  isWorkspaceRootRef,
  isWorkspaceVaultEntryRef,
  type EditorLocalHistoryEntry,
} from "@oscharko-dev/keiko-contracts";
import type { FilesContentResponse, LanguageServiceCapabilities } from "../../../../../lib/types";
import {
  ApiError,
  fetchEditorLanguageCapabilities,
  fetchEditorLocalHistory,
  fetchEditorLocalHistoryEntry,
  fetchFilesContent,
  fetchGitStatus,
  postEditorAgentSessionSnapshot,
  saveFilesContent,
} from "../../../../../lib/api";
import type { EditorSurfaceProps } from "./EditorSurface";
import { EditorFileHistoryPanel, type EditorFileHistoryPanelProps } from "./EditorFileHistoryPanel";
import EditorRuntimeWidget from "./EditorRuntimeWidget";

vi.mock("../../../../../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../../lib/api")>("../../../../../lib/api");
  return {
    ...actual,
    fetchEditorLanguageCapabilities: vi.fn(),
    fetchEditorLocalHistory: vi.fn(),
    fetchEditorLocalHistoryEntry: vi.fn(),
    fetchFilesContent: vi.fn(),
    fetchGitStatus: vi.fn(),
    postEditorAgentActionResult: vi.fn(),
    postEditorAgentSessionSnapshot: vi.fn(),
    saveFilesContent: vi.fn(),
    setEditorLocalHistoryPinned: vi.fn(),
    deleteEditorLocalHistory: vi.fn(),
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

// Dispatch on the prop shape rather than on call order: the widget's three dynamic imports and the
// history panel's own one are evaluated lazily, so an index-based probe would bind to whichever
// module happened to load first.
vi.mock("next/dynamic", () => ({
  default: () =>
    function DynamicProbe(props: Record<string, unknown>): ReactElement | null {
      if ("buffer" in props) {
        surface.props = props as unknown as EditorSurfaceProps;
        return <div data-testid="editor-surface" />;
      }
      if ("onRestore" in props) {
        return <EditorFileHistoryPanel {...(props as unknown as EditorFileHistoryPanelProps)} />;
      }
      return null;
    },
}));

const DISK_CONTENT = "const value = 1;\n";
const CHECKPOINT_CONTENT = "const value = 0;\n";
const BASE_VERSION = { sizeBytes: 17, modifiedAt: 1, contentHash: "a".repeat(64) };

const LANGUAGE_CAPABILITIES: LanguageServiceCapabilities = {
  schemaVersion: "1",
  providers: [],
};

function checked<Value>(value: string, guard: (input: unknown) => input is Value): Value {
  if (!guard(value)) throw new Error(`Invalid test fixture: ${value}`);
  return value;
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

function checkpoint(): EditorLocalHistoryEntry {
  const recordedAt = checked("2026-07-19T12:05:00.000Z", isWorkspaceIsoInstant);
  return {
    kind: "local-history-entry",
    schemaVersion: EDITOR_LOCAL_HISTORY_SCHEMA_VERSION,
    entryRef: checked("hist_0000000000000005", isWorkspaceHistoryEntryRef),
    workspaceId: "workspace-test",
    rootRef: checked("root_aaaaaaaaaaaaaaaa", isWorkspaceRootRef),
    rootIdentityDigest: checked("a".repeat(64), isWorkspaceRootIdentityDigest),
    relativePath: "src/app.ts",
    relativePathDigest: checked("b".repeat(64), isWorkspacePathDigest),
    predecessor: { outcome: "absent" },
    sequence: 5,
    origin: "user-save",
    recordedAt,
    lastAccessedAt: recordedAt,
    plaintextContentDigest: checked("c".repeat(64), isWorkspaceContentDigest),
    plaintextByteLength: 17,
    payloadBindingDigest: checked("d".repeat(64), isWorkspaceContentDigest),
    encryptedContent: {
      kind: "vault-reference",
      vaultEntryRef: checked("vault_0000000000000005", isWorkspaceVaultEntryRef),
      encryption: EDITOR_LOCAL_HISTORY_ENCRYPTION,
    },
    pinned: false,
    pinnedAt: { outcome: "absent" },
  };
}

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
  vi.mocked(fetchFilesContent).mockResolvedValue(fileResponse());
  vi.mocked(fetchEditorLocalHistory).mockResolvedValue({
    session: "active",
    entries: [checkpoint()],
  });
  vi.mocked(fetchEditorLocalHistoryEntry).mockResolvedValue({
    entry: checkpoint(),
    content: CHECKPOINT_CONTENT,
  });
});

afterEach(() => {
  surface.props = null;
  vi.clearAllMocks();
});

async function confirmRestore(): Promise<void> {
  render(<EditorRuntimeWidget windowId="history-restore" root="/repo" file="src/app.ts" />);
  await screen.findByTestId("editor-surface");
  expect(surface.props?.buffer.content.text).toBe(DISK_CONTENT);

  fireEvent.click(screen.getByRole("button", { name: "Open file history" }));
  fireEvent.click(await screen.findByRole("button", { name: /^restore$/iu }));
  fireEvent.click(await screen.findByRole("button", { name: /restore version/iu }));
}

describe("EditorRuntimeWidget local-history restore", () => {
  it("leaves the buffer untouched when the restore write fails", async () => {
    vi.mocked(saveFilesContent).mockRejectedValue(new Error("write denied"));
    await confirmRestore();

    expect((await screen.findAllByText(/version was not restored/iu)).length).toBeGreaterThan(0);
    expect(surface.props?.buffer.content.text).toBe(DISK_CONTENT);
    expect(surface.props?.fileModel.dirty).toBe(false);
  });

  it("leaves the buffer untouched when the restore write conflicts", async () => {
    vi.mocked(saveFilesContent).mockRejectedValue(new ApiError("CONFLICT", "stale", 409));
    await confirmRestore();

    expect((await screen.findAllByText(/version was not restored/iu)).length).toBeGreaterThan(0);
    expect(surface.props?.buffer.content.text).toBe(DISK_CONTENT);
    expect(surface.props?.fileModel.dirty).toBe(false);
  });

  it("adopts the checkpoint into a clean buffer when the restore write lands", async () => {
    vi.mocked(saveFilesContent).mockResolvedValue(
      fileResponse({
        content: CHECKPOINT_CONTENT,
        session: { schemaVersion: "1", version: { ...BASE_VERSION, modifiedAt: 2 } },
      }),
    );
    await confirmRestore();

    await waitFor(() => expect(surface.props?.buffer.content.text).toBe(CHECKPOINT_CONTENT));
    expect(surface.props?.fileModel.dirty).toBe(false);
    expect(screen.queryByText(/version was not restored/iu)).toBeNull();
  });
});
