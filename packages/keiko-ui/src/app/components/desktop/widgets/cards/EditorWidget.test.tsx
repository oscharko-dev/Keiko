import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { useEffect, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EditorAgentAction,
  EditorCompletionWireResponse,
  EditorInlineCompletionWireResponse,
  EditorTestGenerationWireResponse,
  FilesContentResponse,
  LanguageServiceCapabilities,
} from "../../../../../lib/types";
import {
  ApiError,
  fetchEditorLanguageCapabilities,
  fetchEditorAgentAudit,
  fetchFilesContent,
  postEditorAgentActionResult,
  postEditorAgentSessionSnapshot,
  reportEditorInlineCompletionTelemetry,
  requestEditorCompletion,
  requestEditorCodeActions,
  requestEditorDefinition,
  requestEditorDiagnostics,
  requestEditorFormatting,
  requestEditorHover,
  requestEditorInlineCompletion,
  requestEditorReferences,
  requestEditorRenameApply,
  requestEditorRenamePrepare,
  requestEditorSignatureHelp,
  requestEditorSymbols,
  requestEditorTestGeneration,
  saveFilesContent,
} from "../../../../../lib/api";
import {
  EDITOR_HOT_EXIT_SCHEMA_VERSION,
  type EditorHotExitSnapshotV1,
} from "@oscharko-dev/keiko-contracts";
import type { EditorSurfaceProps } from "./EditorSurface";
import type { EditorDiffSurfaceProps } from "./EditorDiffSurface";
import EditorRuntimeWidget from "./EditorRuntimeWidget";
import {
  useWorkspaceReplaceBuffers,
  WorkspaceReplaceBufferProvider,
} from "../../WorkspaceReplaceBufferContext";
import {
  deleteEditorHotExitSnapshot,
  readEditorHotExitSnapshot,
  writeEditorHotExitSnapshot,
} from "./editorHotExitStore";

vi.mock("../../../../../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../../lib/api")>("../../../../../lib/api");
  return {
    ...actual,
    fetchEditorLanguageCapabilities: vi.fn(),
    fetchEditorAgentAudit: vi.fn(),
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

// The hot-exit store reaches IndexedDB, which jsdom does not provide. Mock it so recovery snapshots
// can be injected deterministically; reads default to "no snapshot" to match the unmocked degraded
// behaviour the rest of the suite relies on.
vi.mock("./editorHotExitStore", () => ({
  readEditorHotExitSnapshot: vi.fn(() => Promise.resolve(null)),
  writeEditorHotExitSnapshot: vi.fn(() => Promise.resolve()),
  deleteEditorHotExitSnapshot: vi.fn(() => Promise.resolve()),
}));

// The real surface dynamically imports `monaco-editor`, which cannot run in jsdom. Replace
// `next/dynamic` with a probe that captures the host-driven props and lets the test drive the
// editor's intent callbacks — exercising the host's load/save/conflict/dirty wiring directly.
const surface: { props: EditorSurfaceProps | null; mounts: number; unmounts: number } = {
  props: null,
  mounts: 0,
  unmounts: 0,
};
const diffSurface: { props: EditorDiffSurfaceProps | null; mounts: number; unmounts: number } = {
  props: null,
  mounts: 0,
  unmounts: 0,
};
vi.mock("next/dynamic", () => {
  let dynamicComponentIndex = 0;
  return {
    default: () => {
      const index = dynamicComponentIndex++;
      if (index > 0) {
        function EditorDiffSurfaceProbe(props: EditorDiffSurfaceProps): ReactElement {
          useEffect(() => {
            diffSurface.mounts += 1;
            return (): void => {
              diffSurface.unmounts += 1;
            };
          }, []);
          diffSurface.props = props;
          return <div data-testid="editor-diff-surface" />;
        }
        return EditorDiffSurfaceProbe;
      }
      function EditorSurfaceProbe(props: EditorSurfaceProps): ReactElement {
        useEffect(() => {
          surface.mounts += 1;
          return (): void => {
            surface.unmounts += 1;
          };
        }, []);
        surface.props = props;
        return <div data-testid="editor-surface" />;
      }
      return EditorSurfaceProbe;
    },
  };
});

// The content-free document version the loaded fixture reports; the host captures it and sends it
// back as the version-aware baseVersion token on save (Issue #1197).
const BASE_VERSION = { sizeBytes: 12, modifiedAt: 1, contentHash: "a".repeat(64) };
const LANGUAGE_CAPABILITIES: LanguageServiceCapabilities = {
  schemaVersion: "1",
  providers: [
    {
      id: "typescript",
      languages: ["typescript", "javascript"],
      operations: [
        "diagnostics",
        "completion",
        "hover",
        "symbols",
        "formatting",
        "definition",
        "references",
        "codeActions",
        "signatureHelp",
        "renamePrepare",
        "renameApply",
      ],
      availability: "available",
    },
  ],
};

type AgentEventListener = EventListenerOrEventListenerObject;

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly close = vi.fn();
  readonly removeEventListener = vi.fn((type: string, listener: AgentEventListener): void => {
    this.listeners.get(type)?.delete(listener);
  });
  private readonly listeners = new Map<string, Set<AgentEventListener>>();
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: AgentEventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<AgentEventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  emitAction(action: EditorAgentAction): void {
    // Emit the full editor-agent event envelope the server actually sends, so the widget's
    // contract-guarded SSE listener (isEditorAgentEvent) accepts the frame.
    this.emitRaw(
      JSON.stringify({
        schemaVersion: "1",
        eventId: `evt-${action.actionId}`,
        type: "action",
        action,
      }),
    );
  }

  emitRaw(data: string): void {
    const event = new MessageEvent<string>("editor-agent:action", { data });
    for (const listener of this.listeners.get("editor-agent:action") ?? []) {
      if (typeof listener === "function") {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
  }
}

const ORIGINAL_EVENT_SOURCE = globalThis.EventSource;

function installFakeEventSource(): typeof FakeEventSource {
  FakeEventSource.instances = [];
  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    value: FakeEventSource,
  });
  return FakeEventSource;
}

function restoreEventSource(): void {
  if (ORIGINAL_EVENT_SOURCE === undefined) {
    Reflect.deleteProperty(globalThis, "EventSource");
    return;
  }
  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    value: ORIGINAL_EVENT_SOURCE,
  });
}

let agentActionSequence = 0;

function agentAction(
  sessionId: string,
  type: EditorAgentAction["type"],
  overrides: Partial<EditorAgentAction> = {},
): EditorAgentAction {
  agentActionSequence += 1;
  return {
    schemaVersion: "1",
    actionId: `action-${agentActionSequence}`,
    idempotencyKey: `idempotency-${agentActionSequence}`,
    sessionId,
    type,
    ...overrides,
  };
}

function fileResponse(over?: Partial<FilesContentResponse>): FilesContentResponse {
  return {
    root: "/repo",
    path: "src/app.ts",
    name: "app.ts",
    sizeBytes: 12,
    modifiedAt: 1,
    extension: "ts",
    mime: "text/plain",
    symlink: false,
    content: "const value = 1;\n",
    maxBytes: 1_000_000,
    session: { schemaVersion: "1", version: BASE_VERSION },
    ...over,
  };
}

function recoverySnapshotFixture(over?: Partial<EditorHotExitSnapshotV1>): EditorHotExitSnapshotV1 {
  return {
    schemaVersion: EDITOR_HOT_EXIT_SCHEMA_VERSION,
    workspaceRoot: "/repo",
    relativePath: "src/app.ts",
    content: "recovered edits\n",
    baseVersion: BASE_VERSION,
    contentHash: "b".repeat(64),
    // Matches BASE_VERSION.contentHash by default → the on-disk file is unchanged since the snapshot.
    savedContentHash: "a".repeat(64),
    updatedAt: 1,
    paneId: "pane-1",
    windowId: "editor-test",
    ...over,
  };
}

afterEach(() => {
  surface.props = null;
  surface.mounts = 0;
  surface.unmounts = 0;
  diffSurface.props = null;
  diffSurface.mounts = 0;
  diffSurface.unmounts = 0;
  delete document.documentElement.dataset.theme;
  restoreEventSource();
  agentActionSequence = 0;
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.mocked(fetchEditorLanguageCapabilities).mockResolvedValue(LANGUAGE_CAPABILITIES);
  vi.mocked(fetchEditorAgentAudit).mockResolvedValue({ records: [] });
  vi.mocked(fetchFilesContent).mockResolvedValue(fileResponse());
  vi.mocked(saveFilesContent).mockResolvedValue(fileResponse());
  vi.mocked(requestEditorSymbols).mockResolvedValue({ symbols: [], truncated: false });
  vi.mocked(postEditorAgentSessionSnapshot).mockResolvedValue({ snapshot: null });
  vi.mocked(postEditorAgentActionResult).mockResolvedValue({
    result: { schemaVersion: "1", actionId: "queued", sessionId: "queued", status: "queued" },
  });
});

async function renderLoaded(
  props: Partial<Parameters<typeof EditorRuntimeWidget>[0]> = {},
): Promise<ReturnType<typeof render>> {
  vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
  const view = render(
    <EditorRuntimeWidget windowId="editor-test" root="/repo" file="src/app.ts" {...props} />,
  );
  await screen.findByTestId("editor-surface");
  return view;
}

type ReplaceBufferRegistry = NonNullable<ReturnType<typeof useWorkspaceReplaceBuffers>>;

function CaptureReplaceRegistry({
  onCapture,
}: {
  readonly onCapture: (registry: ReplaceBufferRegistry) => void;
}): ReactElement | null {
  const registry = useWorkspaceReplaceBuffers();
  useEffect(() => {
    if (registry !== null) onCapture(registry);
  }, [onCapture, registry]);
  return null;
}

function loadedIdentity(): EditorSurfaceProps["fileModel"]["identity"] {
  const identity = surface.props?.fileModel.identity;
  if (identity === undefined) {
    throw new Error("editor identity unavailable");
  }
  return identity;
}

function editorStatusField(id: string): Element | null {
  return screen.getByTestId("editor-status-bar").querySelector(`[data-field="${id}"]`);
}

describe("EditorWidget — empty state", () => {
  it("renders an honest empty state and mounts no editor until a file is opened", () => {
    render(<EditorRuntimeWidget />);
    expect(screen.getByRole("note")).toHaveTextContent(/choose a file from the project tree/i);
    expect(screen.queryByTestId("editor-surface")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});

describe("EditorWidget — load", () => {
  it("loads the file and drives the editor surface with a ready buffer", async () => {
    await renderLoaded();
    expect(fetchFilesContent).toHaveBeenCalledWith("/repo", "src/app.ts");
    expect(surface.props?.fileLoadState.status).toBe("ready");
    expect(surface.props?.buffer.content.text).toBe("const value = 1;\n");
    expect(surface.props?.buffer.content.relativePath).toBe("src/app.ts");
    expect(surface.props?.fileModel.identity.language).toBe("typescript");
    expect(surface.props?.fileModel.identity.uri).toMatch(
      /^keiko-editor:\/\/workspace\/editor-test\/[0-9a-f]{8}\/src\/app\.ts$/,
    );
    expect(surface.props?.ariaLabel).toBe("Editor: src/app.ts in /repo");
    expect(surface.props?.modifiedAt).toBe(1);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("aria-disabled", "true");
  });

  it("uses a distinct Monaco model identity for two editor windows on the same file", async () => {
    vi.mocked(fetchFilesContent).mockResolvedValue(fileResponse());
    const loadedUris: string[] = [];
    const { unmount } = render(
      <EditorRuntimeWidget windowId="editor-a" root="/repo" file="src/app.ts" />,
    );
    await waitFor(() => {
      const uri = surface.props?.fileModel.identity.uri;
      expect(uri).toContain("/editor-a/");
      loadedUris[0] = uri ?? "";
    });
    unmount();

    render(<EditorRuntimeWidget windowId="editor-b" root="/repo" file="src/app.ts" />);
    await waitFor(() => {
      const uri = surface.props?.fileModel.identity.uri;
      expect(uri).toContain("/editor-b/");
      loadedUris[1] = uri ?? "";
    });

    expect(loadedUris[0]).toMatch(/^keiko-editor:\/\/workspace\/editor-a\//);
    expect(loadedUris[1]).toMatch(/^keiko-editor:\/\/workspace\/editor-b\//);
    expect(loadedUris[0]).not.toBe(loadedUris[1]);
    expect(fetchFilesContent).toHaveBeenCalledWith("/repo", "src/app.ts");
  });

  it("surfaces a load failure in the card", async () => {
    vi.mocked(fetchFilesContent).mockRejectedValueOnce(
      new ApiError("FILE_TOO_LARGE", "This file is too large to edit here.", 413),
    );
    render(<EditorRuntimeWidget root="/repo" file="big.bin" />);
    expect(await screen.findByText(/this file is too large to edit here/i)).toBeInTheDocument();
    expect(screen.queryByTestId("editor-surface")).toBeNull();
  });

  it.each([
    [new Error("Plain load failure."), /plain load failure/i],
    ["non-error throw", /the file could not be loaded/i],
  ])(
    "normalizes non-API load failures without exposing raw transport details",
    async (failure, message) => {
      vi.mocked(fetchFilesContent).mockRejectedValueOnce(failure);

      render(<EditorRuntimeWidget root="/repo" file="src/app.ts" />);

      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(screen.queryByTestId("editor-surface")).toBeNull();
    },
  );

  it("applies reviewed workspace replacements inside an already-open dirty buffer", async () => {
    let registry: ReplaceBufferRegistry | null = null;
    render(
      <WorkspaceReplaceBufferProvider>
        <EditorRuntimeWidget windowId="replace-open" root="/repo" file="src/app.ts" />
        <CaptureReplaceRegistry onCapture={(next) => (registry = next)} />
      </WorkspaceReplaceBufferProvider>,
    );
    await screen.findByTestId("editor-surface");
    await waitFor(() => expect(registry).not.toBeNull());
    await act(async () => {
      surface.props?.onContentChange(
        { text: "const needle = true;\n// unsaved\n", sizeBytes: 31 },
        "human",
      );
    });

    let result: Awaited<ReturnType<ReplaceBufferRegistry["apply"]>> | undefined;
    await act(async () => {
      result = await registry?.apply("/repo", {
        path: "src/app.ts",
        baseContentHash: "a".repeat(64),
        edits: [
          {
            range: { startLine: 1, startColumn: 7, endLine: 1, endColumn: 13 },
            originalText: "needle",
            newText: "thread",
          },
        ],
      });
    });

    expect(result).toEqual({ status: "applied", path: "src/app.ts" });
    await waitFor(() =>
      expect(surface.props?.buffer.content.text).toBe("const thread = true;\n// unsaved\n"),
    );
    expect(saveFilesContent).not.toHaveBeenCalled();
  });

  it("reports a write conflict when an open buffer no longer matches the replacement preview", async () => {
    let registry: ReplaceBufferRegistry | null = null;
    render(
      <WorkspaceReplaceBufferProvider>
        <EditorRuntimeWidget windowId="replace-conflict" root="/repo" file="src/app.ts" />
        <CaptureReplaceRegistry onCapture={(next) => (registry = next)} />
      </WorkspaceReplaceBufferProvider>,
    );
    await screen.findByTestId("editor-surface");
    await waitFor(() => expect(registry).not.toBeNull());
    await act(async () => {
      surface.props?.onContentChange({ text: "const changed = true;\n", sizeBytes: 22 }, "human");
    });

    let result: Awaited<ReturnType<ReplaceBufferRegistry["apply"]>> | undefined;
    await act(async () => {
      result = await registry?.apply("/repo", {
        path: "src/app.ts",
        baseContentHash: "a".repeat(64),
        edits: [
          {
            range: { startLine: 1, startColumn: 7, endLine: 1, endColumn: 13 },
            originalText: "needle",
            newText: "thread",
          },
        ],
      });
    });

    expect(result).toEqual({
      status: "conflict",
      conflict: {
        path: "src/app.ts",
        reason: "write-conflict",
        detail: "The open editor buffer no longer matches the reviewed replacement preview.",
      },
    });
    expect(surface.props?.buffer.content.text).toBe("const changed = true;\n");
    expect(saveFilesContent).not.toHaveBeenCalled();
  });
});

describe("EditorWidget — test generation (Issue #1202)", () => {
  const NOT_RUN_FUNNEL = {
    executionEnabled: false,
    candidatesGenerated: 0,
    candidatesSurfaced: 0,
    stabilityRunsRequired: 5,
    build: "not-run",
    pass: "not-run",
    stability: "not-run",
    coverage: "not-run",
    mutation: "not-run",
    antiTautology: "not-run",
  } as const;

  const DISABLED_RESPONSE: EditorTestGenerationWireResponse = {
    schemaVersion: "1",
    status: "disabled",
    reason: "Editor-driven test generation is disabled in this build.",
    funnel: NOT_RUN_FUNNEL,
  };

  it("offers a Tests action for a TS file and surfaces the switched-off status", async () => {
    await renderLoaded();
    // Issue #1205: the unified status bar carries the single polite live region; the governed
    // test-generation run status feeds its "run" field, which is absent until a run starts.
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");
    expect(status).not.toHaveTextContent(/disabled in this build/i);
    const button = screen.getByRole("button", { name: "Tests" });
    expect(button).toBeInTheDocument();
    expect(button).not.toHaveAttribute("data-tip");
    expect(button).not.toHaveAttribute("title");
    vi.mocked(requestEditorTestGeneration).mockResolvedValueOnce(DISABLED_RESPONSE);

    await userEvent.click(button);

    expect(requestEditorTestGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/repo",
        target: expect.objectContaining({ kind: "file" }),
      }),
      expect.any(AbortSignal),
    );
    await waitFor(() => {
      expect(status).toHaveTextContent("Tests off");
    });
    // The editor surface stays mounted and usable after the run resolves.
    expect(screen.getByTestId("editor-surface")).toBeInTheDocument();
    expect(status).toHaveTextContent("Tests off");
  });

  it("uses a selection target when the editor reports a reliable non-empty selection", async () => {
    await renderLoaded();
    vi.mocked(requestEditorTestGeneration).mockResolvedValueOnce(DISABLED_RESPONSE);
    act(() => {
      surface.props?.onSelectionChange?.({
        start: { line: 0, column: 6 },
        end: { line: 0, column: 11 },
      });
    });

    await userEvent.click(screen.getByRole("button", { name: "Tests" }));

    expect(requestEditorTestGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          kind: "selection",
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 11 },
          },
        }),
      }),
      expect.any(AbortSignal),
    );
  });

  it("aborts an in-flight test-generation request when cancelled", async () => {
    await renderLoaded();
    let signal: AbortSignal | undefined;
    vi.mocked(requestEditorTestGeneration).mockImplementationOnce((_input, requestSignal) => {
      signal = requestSignal;
      return new Promise<EditorTestGenerationWireResponse>(() => {});
    });

    await userEvent.click(screen.getByRole("button", { name: "Tests" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent(/cancelled/i);
  });

  it("ignores palette and shortcut Generate Tests commands while a run is busy", async () => {
    await renderLoaded();
    let signal: AbortSignal | undefined;
    vi.mocked(requestEditorTestGeneration).mockImplementationOnce((_input, requestSignal) => {
      signal = requestSignal;
      return new Promise<EditorTestGenerationWireResponse>(() => {});
    });

    await userEvent.click(screen.getByRole("button", { name: "Tests" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    act(() => {
      surface.props?.onGenerateTests?.();
    });

    expect(requestEditorTestGeneration).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
  });

  it("renders a generated test patch in the review diff surface with apply disabled", async () => {
    await renderLoaded();
    vi.mocked(requestEditorTestGeneration).mockResolvedValueOnce({
      schemaVersion: "1",
      status: "generated",
      assurance: "unverified",
      funnel: { ...NOT_RUN_FUNNEL, candidatesGenerated: 1, candidatesSurfaced: 1 },
      patch: {
        patchId: "p1",
        files: [
          {
            path: "src/app.test.ts",
            changeKind: "added",
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: "it('renders', () => {});\n",
              },
            ],
          },
        ],
      },
      provenance: { modelId: "m", gatewayPolicyVersion: "v", promptHash: "h", producedAt: 1 },
    });

    await userEvent.click(screen.getByRole("button", { name: "Tests" }));

    expect(await screen.findByTestId("editor-diff-surface")).toBeInTheDocument();
    const tab = screen.getByRole("tab", { name: /app\.ts/ });
    const tabpanel = screen.getByRole("tabpanel");
    expect(tabpanel).toContainElement(screen.getByTestId("editor-diff-surface"));
    expect(tab).toHaveAttribute("aria-controls", tabpanel.id);
    expect(tabpanel).toHaveAttribute("aria-labelledby", tab.id);
    expect(diffSurface.props?.model.files[0]?.uri).toBe("src/app.test.ts");
    expect(diffSurface.props?.actions?.canApply).toBe(false);
    expect(diffSurface.props?.actions?.canRunVerification).toBe(false);

    act(() => {
      diffSurface.props?.onReject?.();
    });
    await waitFor(() => {
      expect(screen.queryByTestId("editor-diff-surface")).toBeNull();
    });
    expect(screen.getByTestId("editor-surface")).toBeInTheDocument();
  });
});

describe("EditorWidget — edit and save", () => {
  it("does not re-emit unchanged dirty state when the callback identity changes", async () => {
    const firstDirtyChange = vi.fn();
    const { rerender } = await renderLoaded({ onDirtyChange: firstDirtyChange });

    await waitFor(() => {
      expect(firstDirtyChange).toHaveBeenCalledWith("src/app.ts", false);
    });
    expect(firstDirtyChange).toHaveBeenCalledTimes(1);

    const nextDirtyChange = vi.fn();
    rerender(
      <EditorRuntimeWidget
        windowId="editor-test"
        root="/repo"
        file="src/app.ts"
        onDirtyChange={nextDirtyChange}
      />,
    );

    await act(async () => {});

    expect(nextDirtyChange).not.toHaveBeenCalled();

    act(() => {
      surface.props?.onContentChange({ text: "const value = 2;\n", sizeBytes: 17 }, "human");
    });

    await waitFor(() => {
      expect(nextDirtyChange).toHaveBeenCalledWith("src/app.ts", true);
    });
    expect(nextDirtyChange).toHaveBeenCalledTimes(1);
  });

  it("marks the buffer dirty on edit and enables Save", async () => {
    await renderLoaded();
    act(() => {
      surface.props?.onContentChange({ text: "const value = 2;\n", sizeBytes: 17 }, "human");
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    });
    expect(surface.props?.buffer.content.text).toBe("const value = 2;\n");
    expect(surface.props?.fileModel.dirty).toBe(true);
    // Issue #1205: the dirty state is communicated by the status bar save field (and the tab dot).
    const statusBar = screen.getByTestId("editor-status-bar");
    expect(statusBar.querySelector('[data-field="save"]')).toHaveTextContent("Unsaved");
  });

  it("contains rejected background hot-exit writes without breaking editing", async () => {
    vi.mocked(writeEditorHotExitSnapshot).mockRejectedValueOnce(new Error("hot-exit unavailable"));
    await renderLoaded();

    act(() => {
      surface.props?.onContentChange({ text: "dirty content\n", sizeBytes: 14 }, "human");
    });

    await waitFor(() => {
      expect(writeEditorHotExitSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceRoot: "/repo",
          relativePath: "src/app.ts",
          content: "dirty content\n",
        }),
      );
    });
    expect(surface.props?.fileModel.dirty).toBe(true);
  });

  it("saves with the version-aware token and clears dirty on success", async () => {
    await renderLoaded();
    vi.mocked(saveFilesContent).mockResolvedValueOnce(
      fileResponse({ modifiedAt: 2, content: "const value = 2;\n" }),
    );
    act(() => {
      surface.props?.onContentChange({ text: "const value = 2;\n", sizeBytes: 17 }, "human");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(saveFilesContent).toHaveBeenCalledWith({
        root: "/repo",
        path: "src/app.ts",
        content: "const value = 2;\n",
        baseVersion: BASE_VERSION,
      });
    });
    await waitFor(() => {
      expect(surface.props?.saveStatus).toBe("saved");
    });
    expect(surface.props?.modifiedAt).toBe(2);
    expect(surface.props?.fileModel.dirty).toBe(false);
  });

  it("adopts the persisted version so the next save sends the fresh baseVersion token", async () => {
    await renderLoaded();
    const nextVersion = { sizeBytes: 17, modifiedAt: 2, contentHash: "c".repeat(64) };
    vi.mocked(saveFilesContent).mockResolvedValueOnce(
      fileResponse({
        modifiedAt: 2,
        content: "const value = 2;\n",
        session: { schemaVersion: "1", version: nextVersion },
      }),
    );
    act(() => {
      surface.props?.onContentChange({ text: "const value = 2;\n", sizeBytes: 17 }, "human");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(surface.props?.saveStatus).toBe("saved");
    });

    vi.mocked(saveFilesContent).mockResolvedValueOnce(fileResponse({ modifiedAt: 3 }));
    act(() => {
      surface.props?.onContentChange({ text: "const value = 3;\n", sizeBytes: 17 }, "human");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(saveFilesContent).toHaveBeenLastCalledWith(
        expect.objectContaining({ baseVersion: nextVersion }),
      );
    });
  });

  it("ignores an editor Cmd/Ctrl+S save request when the buffer is clean", async () => {
    await renderLoaded();
    act(() => {
      surface.props?.onSaveRequested({
        identity: { ...loadedIdentity(), version: 1 },
        expectedSavedVersion: 0,
        content: {
          relativePath: "src/app.ts",
          text: "const value = 1;\n",
          sizeBytes: 16,
          truncated: false,
        },
      });
    });
    expect(saveFilesContent).not.toHaveBeenCalled();
  });

  it("saves the latest text on an editor Cmd/Ctrl+S save request after an edit", async () => {
    await renderLoaded();
    vi.mocked(saveFilesContent).mockResolvedValueOnce(fileResponse({ modifiedAt: 2 }));
    act(() => {
      surface.props?.onContentChange({ text: "const value = 9;\n", sizeBytes: 17 }, "human");
    });
    act(() => {
      surface.props?.onSaveRequested({
        identity: { ...loadedIdentity(), version: 1 },
        expectedSavedVersion: 0,
        content: {
          relativePath: "src/app.ts",
          text: "const value = 9;\n",
          sizeBytes: 17,
          truncated: false,
        },
      });
    });
    await waitFor(() => {
      expect(saveFilesContent).toHaveBeenCalledWith(
        expect.objectContaining({ content: "const value = 9;\n", baseVersion: BASE_VERSION }),
      );
    });
  });
});

describe("EditorWidget — conflict and error", () => {
  it("surfaces a 409 as a recoverable conflict and offers Reload", async () => {
    await renderLoaded();
    vi.mocked(saveFilesContent).mockRejectedValueOnce(
      new ApiError("CONFLICT", "The file changed on disk.", 409),
    );
    act(() => {
      surface.props?.onContentChange({ text: "edited\n", sizeBytes: 7 }, "human");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(surface.props?.saveStatus).toBe("conflict");
    });
    // Conflict keeps the buffer dirty and never silently overwrites.
    expect(surface.props?.fileModel.dirty).toBe(true);
    const reload = await screen.findByRole("button", { name: "Reload" });

    const reloadedVersion = { sizeBytes: 20, modifiedAt: 5, contentHash: "d".repeat(64) };
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(
      fileResponse({ modifiedAt: 5, session: { schemaVersion: "1", version: reloadedVersion } }),
    );
    await userEvent.click(reload);
    // Reloading over the dirty conflict buffer routes through the explicit reload-file discard
    // acknowledgement before the disk content is loaded (Issue #1376 D1).
    await userEvent.click(await screen.findByRole("button", { name: "Discard and reload" }));
    await waitFor(() => {
      expect(fetchFilesContent).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(surface.props?.saveStatus).toBe("idle");
    });
    // Reload must adopt the new concurrency token, or the next save would send a stale
    // baseVersion and immediately re-conflict.
    expect(surface.props?.modifiedAt).toBe(5);

    // The next save must send the RELOADED version as baseVersion — pins the reload→save token chain.
    vi.mocked(saveFilesContent).mockResolvedValueOnce(fileResponse({ modifiedAt: 6 }));
    act(() => {
      surface.props?.onContentChange({ text: "edited-again\n", sizeBytes: 13 }, "human");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(saveFilesContent).toHaveBeenLastCalledWith(
        expect.objectContaining({ baseVersion: reloadedVersion }),
      );
    });
  });

  it("requires explicit confirmation before a dirty conflict reload discards the buffer (Issue #1376)", async () => {
    await renderLoaded();
    vi.mocked(saveFilesContent).mockRejectedValueOnce(
      new ApiError("CONFLICT", "The file changed on disk.", 409),
    );
    act(() => {
      surface.props?.onContentChange({ text: "edited\n", sizeBytes: 7 }, "human");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(surface.props?.saveStatus).toBe("conflict");
    });

    // Clicking Reload over a dirty buffer must not immediately re-fetch from disk; it opens an
    // explicit discard confirmation (the reload-file dirty-close policy) instead.
    await userEvent.click(await screen.findByRole("button", { name: "Reload" }));
    expect(
      await screen.findByRole("dialog", { name: "Discard unsaved changes?" }),
    ).toBeInTheDocument();
    expect(fetchFilesContent).toHaveBeenCalledTimes(1);

    // Cancel leaves the dirty conflict buffer untouched and reloads nothing.
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Discard unsaved changes?" })).toBeNull();
    });
    expect(fetchFilesContent).toHaveBeenCalledTimes(1);
    expect(surface.props?.fileModel.dirty).toBe(true);
    expect(surface.props?.saveStatus).toBe("conflict");
  });

  it("focuses the reload-file confirmation and closes it on Escape without reloading (Issue #1376)", async () => {
    await renderLoaded();
    vi.mocked(saveFilesContent).mockRejectedValueOnce(
      new ApiError("CONFLICT", "The file changed on disk.", 409),
    );
    act(() => {
      surface.props?.onContentChange({ text: "edited\n", sizeBytes: 7 }, "human");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(surface.props?.saveStatus).toBe("conflict");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Reload" }));

    const dialog = await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    await waitFor(() => {
      expect(dialog).toHaveFocus();
    });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Discard unsaved changes?" })).toBeNull();
    });
    expect(fetchFilesContent).toHaveBeenCalledTimes(1);
    expect(surface.props?.fileModel.dirty).toBe(true);
  });

  it("deletes the hot-exit snapshot when a dirty conflict reload is confirmed (Issue #1376)", async () => {
    await renderLoaded();
    vi.mocked(saveFilesContent).mockRejectedValueOnce(
      new ApiError("CONFLICT", "The file changed on disk.", 409),
    );
    act(() => {
      surface.props?.onContentChange({ text: "edited\n", sizeBytes: 7 }, "human");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(surface.props?.saveStatus).toBe("conflict");
    });

    await userEvent.click(await screen.findByRole("button", { name: "Reload" }));
    // Isolate the delete caused by confirming the discard from the clean-buffer delete fired on load.
    vi.mocked(deleteEditorHotExitSnapshot).mockClear();
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse({ modifiedAt: 5 }));
    await userEvent.click(await screen.findByRole("button", { name: "Discard and reload" }));

    // The discarded edits' snapshot is removed so the reload does not immediately re-offer them.
    await waitFor(() => {
      expect(deleteEditorHotExitSnapshot).toHaveBeenCalledWith("/repo", "src/app.ts");
    });
  });

  it("treats a STALE_SESSION 409 as a recoverable conflict (Issue #1197)", async () => {
    await renderLoaded();
    vi.mocked(saveFilesContent).mockRejectedValueOnce(
      new ApiError("STALE_SESSION", "This file changed since it was opened.", 409),
    );
    act(() => {
      surface.props?.onContentChange({ text: "edited\n", sizeBytes: 7 }, "human");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(surface.props?.saveStatus).toBe("conflict");
    });
    expect(surface.props?.fileModel.dirty).toBe(true);
    expect(await screen.findByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("surfaces a non-conflict save failure as an error state", async () => {
    await renderLoaded();
    vi.mocked(saveFilesContent).mockRejectedValueOnce(
      new ApiError("WRITE_FAILED", "Disk full.", 500),
    );
    act(() => {
      surface.props?.onContentChange({ text: "edited\n", sizeBytes: 7 }, "human");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(surface.props?.saveStatus).toBe("error");
    });
    expect(surface.props?.saveError).toBe("Disk full.");
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });

  it("keeps reload failure recoverable after an editor surface has already mounted", async () => {
    await renderLoaded();
    vi.mocked(saveFilesContent).mockRejectedValueOnce(
      new ApiError("CONFLICT", "The file changed on disk.", 409),
    );
    act(() => {
      surface.props?.onContentChange({ text: "edited\n", sizeBytes: 7 }, "human");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    const reload = await screen.findByRole("button", { name: "Reload" });

    vi.mocked(fetchFilesContent).mockRejectedValueOnce(
      new ApiError("READ_FAILED", "The file could not be loaded.", 500),
    );
    await userEvent.click(reload);
    // Acknowledge the reload-file discard confirmation before the (failing) disk load runs.
    await userEvent.click(await screen.findByRole("button", { name: "Discard and reload" }));

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByTestId("editor-surface")).toBeNull();
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse({ modifiedAt: 5 }));
    await userEvent.click(retry);
    await screen.findByTestId("editor-surface");
    expect(surface.props?.modifiedAt).toBe(5);
  });
});

describe("EditorWidget — concurrent save safety", () => {
  function saveRequest(): Parameters<NonNullable<EditorSurfaceProps["onSaveRequested"]>>[0] {
    return {
      identity: { ...loadedIdentity(), version: 1 },
      content: { relativePath: "src/app.ts", text: "v2\n", sizeBytes: 3, truncated: false },
    };
  }

  it("ignores a second save request while one is already in flight", async () => {
    await renderLoaded();
    let resolveSave: (r: FilesContentResponse) => void = () => {};
    vi.mocked(saveFilesContent).mockReturnValueOnce(
      new Promise<FilesContentResponse>((resolve) => {
        resolveSave = resolve;
      }),
    );
    act(() => {
      surface.props?.onContentChange({ text: "v2\n", sizeBytes: 3 }, "human");
    });
    act(() => {
      surface.props?.onSaveRequested(saveRequest());
      surface.props?.onSaveRequested(saveRequest());
    });
    expect(saveFilesContent).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Saving…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "Saving…" })).not.toBeDisabled();
    await act(async () => {
      resolveSave(fileResponse({ content: "v2\n", modifiedAt: 2 }));
    });
  });

  it("keeps mid-flight edits and stays dirty instead of clobbering them on save success", async () => {
    await renderLoaded();
    let resolveSave: (r: FilesContentResponse) => void = () => {};
    vi.mocked(saveFilesContent).mockReturnValueOnce(
      new Promise<FilesContentResponse>((resolve) => {
        resolveSave = resolve;
      }),
    );
    act(() => {
      surface.props?.onContentChange({ text: "saved-text\n", sizeBytes: 11 }, "human");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    // The editor stays editable during a save; the user keeps typing while it is in flight.
    act(() => {
      surface.props?.onContentChange({ text: "newer-text\n", sizeBytes: 11 }, "human");
    });
    await act(async () => {
      resolveSave(fileResponse({ content: "saved-text\n", modifiedAt: 2 }));
    });
    // The server echo must NOT clobber the newer buffer, which stays dirty against the new version.
    expect(surface.props?.buffer.content.text).toBe("newer-text\n");
    expect(surface.props?.fileModel.dirty).toBe(true);
    expect(surface.props?.modifiedAt).toBe(2);
  });
});

describe("EditorWidget — load-error recovery", () => {
  it("offers Retry on a load error and recovers when the file becomes readable", async () => {
    vi.mocked(fetchFilesContent).mockRejectedValueOnce(
      new ApiError("UNSUPPORTED_FILE", "This file cannot be edited.", 400),
    );
    render(<EditorRuntimeWidget root="/repo" file="src/app.ts" />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByTestId("editor-surface")).toBeNull();

    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    await userEvent.click(retry);
    await screen.findByTestId("editor-surface");
    expect(surface.props?.fileLoadState.status).toBe("ready");
  });
});

describe("EditorWidget — theme coupling", () => {
  it("drives the editor surface with the live app theme variant", async () => {
    document.documentElement.dataset.theme = "light";
    await renderLoaded();
    await waitFor(() => {
      expect(surface.props?.themeVariant).toBe("light");
    });
  });
});

describe("EditorWidget — language inference", () => {
  it.each([
    ["src/app.js", "javascript"],
    ["notes/readme.md", "markdown"],
    ["stryker.security.conf.json", "json"],
    ["scripts/run.sh", "shell"],
  ])("maps %s to editor language %s", async (file, language) => {
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse({ path: file }));
    render(<EditorRuntimeWidget root="/repo" file={file} />);
    await screen.findByTestId("editor-surface");
    expect(surface.props?.fileModel.identity.language).toBe(language);
    expect(surface.props?.buffer.language).toBe(language);
  });

  it("falls back to plaintext for unknown editor language ids", async () => {
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(
      fileResponse({
        path: "dist/app.unknown-bin",
        name: "app.unknown-bin",
        extension: "unknown-bin",
      }),
    );
    render(<EditorRuntimeWidget root="/repo" file="dist/app.unknown-bin" />);
    await screen.findByTestId("editor-surface");
    expect(surface.props?.fileModel.identity.language).toBe("plaintext");
    expect(surface.props?.buffer.language).toBe("plaintext");
  });
});

describe("EditorWidget — completion wiring (Issue #1199)", () => {
  function wireResponse(): EditorCompletionWireResponse {
    return {
      schemaVersion: "1",
      items: [{ label: "value", kind: "field", insertText: "value", origin: "deterministic" }],
      isIncomplete: false,
      truncated: false,
      provenance: { sources: ["deterministic-language-service"], modelMode: "deterministic" },
    };
  }

  function completionQuery() {
    return {
      request: {
        request: { requestId: "r-1", streamId: "s-1", sequence: 1 },
        document: { uri: "keiko://doc", language: "typescript" as const, version: 1 },
        position: { line: 1, column: 6 },
        triggerKind: "trigger-character" as const,
        triggerCharacter: ".",
        contextBudgetBytes: 4096,
      },
      documentText: "const value = {};\nvalue.\n",
    };
  }

  it("wires a completion resolver for a TS/JS file and posts the overlay to the BFF", async () => {
    vi.mocked(requestEditorCompletion).mockResolvedValueOnce(wireResponse());
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    render(<EditorRuntimeWidget root="/repo" file="src/app.ts" />);
    await screen.findByTestId("editor-surface");

    const resolver = surface.props?.provideCompletions;
    expect(resolver).toBeDefined();
    if (resolver === undefined) return;

    const response = await resolver(completionQuery(), new AbortController().signal);
    expect(requestEditorCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/repo",
        path: "src/app.ts",
        languageId: "typescript",
        text: "const value = {};\nvalue.\n",
        position: { line: 1, character: 6 },
        triggerKind: "trigger-character",
        triggerCharacter: ".",
        context: { queryText: "value." },
      }),
      expect.any(AbortSignal),
    );
    expect(response.items[0]?.label).toBe("value");
    expect(response.items[0]?.provenance).toEqual({ origin: "deterministic-completion" });
    expect(surface.props?.completionTriggerCharacters).toContain(".");
  });

  it("forwards connected Files and Local Knowledge context selectors to completion", async () => {
    vi.mocked(requestEditorCompletion).mockResolvedValueOnce(wireResponse());
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    render(
      <EditorRuntimeWidget
        root="/repo"
        file="src/app.ts"
        linkedRoot="/repo"
        linkedFilePath="src/related.ts"
        linkedCapsuleIds={["cap-1"]}
        linkedCapsuleSetIds={["set-1"]}
      />,
    );
    await screen.findByTestId("editor-surface");

    const resolver = surface.props?.provideCompletions;
    expect(resolver).toBeDefined();
    if (resolver === undefined) return;

    await resolver(completionQuery(), new AbortController().signal);
    expect(requestEditorCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          queryText: "value.",
          changedFiles: ["src/related.ts"],
          capsuleId: "cap-1",
        },
      }),
      expect.any(AbortSignal),
    );
  });

  it("omits optional completion context when there is no query text or connected context", async () => {
    vi.mocked(requestEditorCompletion).mockResolvedValueOnce(wireResponse());
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    render(<EditorRuntimeWidget root="/repo" file="src/app.ts" />);
    await screen.findByTestId("editor-surface");

    const resolver = surface.props?.provideCompletions;
    expect(resolver).toBeDefined();
    if (resolver === undefined) return;

    await resolver(
      {
        request: {
          request: { requestId: "r-blank", streamId: "s-blank", sequence: 1 },
          document: { uri: "keiko://doc", language: "typescript", version: 1 },
          position: { line: 99, column: 0 },
          triggerKind: "invoked",
          contextBudgetBytes: 4096,
        },
        documentText: "\n",
      },
      new AbortController().signal,
    );
    const input = vi.mocked(requestEditorCompletion).mock.calls.at(-1)?.[0];
    expect(input).toEqual(expect.not.objectContaining({ context: expect.anything() }));
  });

  it("does not forward a focused Files path from a different root", async () => {
    vi.mocked(requestEditorCompletion).mockResolvedValueOnce(wireResponse());
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    render(
      <EditorRuntimeWidget
        root="/repo"
        file="src/app.ts"
        linkedRoot="/other"
        linkedFilePath="src/other.ts"
        linkedCapsuleSetIds={["set-1"]}
      />,
    );
    await screen.findByTestId("editor-surface");

    const resolver = surface.props?.provideCompletions;
    expect(resolver).toBeDefined();
    if (resolver === undefined) return;

    await resolver(completionQuery(), new AbortController().signal);
    expect(requestEditorCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          queryText: "value.",
          capsuleSetId: "set-1",
        },
      }),
      expect.any(AbortSignal),
    );
  });

  it("registers no completion resolver for a non-source file", async () => {
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(
      fileResponse({ path: "notes.md", name: "notes.md", extension: "md" }),
    );
    render(<EditorRuntimeWidget root="/repo" file="notes.md" />);
    await screen.findByTestId("editor-surface");
    expect(surface.props?.fileModel.identity.language).toBe("markdown");
    expect(surface.props?.provideCompletions).toBeUndefined();
  });
});

describe("EditorWidget — inline completion wiring (Issue #1200)", () => {
  function inlineWireResponse(): EditorInlineCompletionWireResponse {
    return {
      schemaVersion: "1",
      items: [{ insertText: "a + b;" }],
      provenance: {
        sources: ["model-assisted"],
        modelMode: "as-you-type",
        modelId: "fim-1",
        gatewayPolicyVersion: "editor-inline-completion/1",
        promptHash: "a".repeat(64),
      },
    };
  }

  function inlineQuery() {
    return {
      request: {
        request: { requestId: "r-1", streamId: "s-1:inline", sequence: 1 },
        document: { uri: "keiko://doc", language: "typescript" as const, version: 1 },
        position: { line: 1, column: 9 },
        triggerKind: "automatic" as const,
        contextBudgetBytes: 8192,
      },
      documentText: "function add(a, b) {\n  return \n}\n",
    };
  }

  it("wires an inline resolver for a TS/JS file and posts the overlay to the inline BFF", async () => {
    vi.mocked(requestEditorInlineCompletion).mockResolvedValueOnce(inlineWireResponse());
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    render(<EditorRuntimeWidget root="/repo" file="src/app.ts" />);
    await screen.findByTestId("editor-surface");

    const resolver = surface.props?.provideInlineCompletions;
    expect(resolver).toBeDefined();
    if (resolver === undefined) return;

    const response = await resolver(inlineQuery(), new AbortController().signal);
    expect(requestEditorInlineCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/repo",
        path: "src/app.ts",
        languageId: "typescript",
        text: "function add(a, b) {\n  return \n}\n",
        position: { line: 1, character: 9 },
        triggerKind: "automatic",
      }),
      expect.any(AbortSignal),
    );
    expect(response.items[0]?.insertText).toBe("a + b;");
    expect(response.items[0]?.provenance.origin).toBe("ai-inline-completion");
  });

  it("forwards content-free telemetry snapshots to the telemetry route", async () => {
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    render(<EditorRuntimeWidget root="/repo" file="src/app.ts" />);
    await screen.findByTestId("editor-surface");

    const report = surface.props?.onInlineCompletionTelemetry;
    expect(report).toBeDefined();
    if (report === undefined) return;

    report({
      offered: 2,
      shown: 2,
      accepted: 1,
      rejected: 0,
      ignored: 1,
      partiallyAccepted: 0,
      requestCount: 3,
      requestLatencyMsP50: 45,
      requestLatencyMsP95: 80,
    });
    expect(reportEditorInlineCompletionTelemetry).toHaveBeenCalledWith({
      root: "/repo",
      offered: 2,
      shown: 2,
      accepted: 1,
      rejected: 0,
      ignored: 1,
      partiallyAccepted: 0,
      requestCount: 3,
      requestLatencyMsP50: 45,
      requestLatencyMsP95: 80,
    });
  });

  it("registers no inline resolver for a non-source file", async () => {
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(
      fileResponse({ path: "notes.md", name: "notes.md", extension: "md" }),
    );
    render(<EditorRuntimeWidget root="/repo" file="notes.md" />);
    await screen.findByTestId("editor-surface");
    expect(surface.props?.provideInlineCompletions).toBeUndefined();
    expect(surface.props?.onInlineCompletionTelemetry).toBeUndefined();
  });

  it("remounts the editor surface when switching from non-source to source so providers install", async () => {
    vi.mocked(fetchFilesContent)
      .mockResolvedValueOnce(fileResponse({ path: "notes.md", name: "notes.md", extension: "md" }))
      .mockResolvedValueOnce(fileResponse());
    const { rerender } = render(<EditorRuntimeWidget root="/repo" file="notes.md" />);
    await screen.findByTestId("editor-surface");
    expect(surface.props?.fileModel.identity.language).toBe("markdown");
    expect(surface.props?.provideInlineCompletions).toBeUndefined();
    expect(surface.mounts).toBe(1);

    rerender(<EditorRuntimeWidget root="/repo" file="src/app.ts" />);
    await waitFor(() => {
      expect(surface.props?.fileModel.identity.language).toBe("typescript");
    });
    expect(surface.props?.provideInlineCompletions).toBeDefined();
    expect(surface.mounts).toBe(2);
    expect(surface.unmounts).toBeGreaterThanOrEqual(1);
  });
});

describe("EditorWidget language intelligence (Issue #1201 / #2104)", () => {
  it("wires governed language resolvers for a TS/JS file", async () => {
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    vi.mocked(requestEditorDiagnostics).mockResolvedValueOnce({
      diagnostics: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          severity: "error",
          message: "boom",
          source: "typescript",
        },
      ],
      truncated: false,
    });
    vi.mocked(requestEditorHover).mockResolvedValueOnce({ contents: "x: number" });
    vi.mocked(requestEditorSymbols).mockResolvedValueOnce({
      symbols: [
        {
          name: "value",
          kind: "constant",
          range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
        },
      ],
      truncated: false,
    });
    vi.mocked(requestEditorFormatting).mockResolvedValueOnce({
      edits: [
        {
          range: { start: { line: 0, character: 5 }, end: { line: 0, character: 8 } },
          newText: " = ",
        },
      ],
      truncated: false,
    });
    vi.mocked(requestEditorDefinition).mockResolvedValueOnce({
      locations: [
        {
          path: "src/def.ts",
          range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
        },
      ],
      truncated: false,
    });
    vi.mocked(requestEditorReferences).mockResolvedValueOnce({
      locations: [
        {
          path: "src/ref.ts",
          range: { start: { line: 3, character: 1 }, end: { line: 3, character: 6 } },
        },
      ],
      includesDeclaration: true,
      truncated: false,
    });
    vi.mocked(requestEditorCodeActions).mockResolvedValueOnce({
      actions: [{ title: "Fix", kind: "quickfix", edits: [] }],
      truncated: false,
      returnedCount: 1,
      totalCount: 1,
    });
    vi.mocked(requestEditorSignatureHelp).mockResolvedValueOnce({
      signatures: [{ label: "fn(value: string)", parameters: [{ label: "value" }] }],
      activeSignature: 0,
      activeParameter: 0,
      truncated: false,
      returnedCount: 1,
      totalCount: 1,
    });
    const openEditorFile = vi.fn(() => ({ ok: true as const, windowId: "editor-existing" }));
    render(<EditorRuntimeWidget root="/repo" file="src/app.ts" openEditorFile={openEditorFile} />);
    await screen.findByTestId("editor-surface");

    const identity = { requestId: "r", streamId: "s", sequence: 1 };
    const document = { ...loadedIdentity(), version: 1 };

    const diagnostics = surface.props?.provideDiagnostics;
    expect(diagnostics).toBeDefined();
    if (diagnostics === undefined) return;
    const diagResponse = await diagnostics(
      { request: { request: identity, document }, documentText: "const value = 1;\n" },
      new AbortController().signal,
    );
    expect(requestEditorDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ root: "/repo", path: "src/app.ts", languageId: "typescript" }),
      expect.any(AbortSignal),
    );
    expect(diagResponse.diagnostics[0]?.message).toBe("boom");

    const hover = surface.props?.provideHover;
    expect(hover).toBeDefined();
    if (hover === undefined) return;
    const hoverResponse = await hover(
      {
        request: { request: identity, document, position: { line: 0, column: 6 } },
        documentText: "const value = 1;\n",
      },
      new AbortController().signal,
    );
    expect(requestEditorHover).toHaveBeenCalledWith(
      expect.objectContaining({ position: { line: 0, character: 6 } }),
      expect.any(AbortSignal),
    );
    expect(hoverResponse.hover.contents).toBe("x: number");

    const symbols = surface.props?.provideSymbols;
    expect(symbols).toBeDefined();
    if (symbols === undefined) return;
    const symbolResponse = await symbols(
      { request: { request: identity, document }, documentText: "const value = 1;\n" },
      new AbortController().signal,
    );
    expect(symbolResponse.symbols[0]?.name).toBe("value");

    const formatting = surface.props?.provideFormatting;
    expect(formatting).toBeDefined();
    if (formatting === undefined) return;
    const formatResponse = await formatting(
      {
        request: {
          request: identity,
          document,
          options: { tabSize: 2, insertSpaces: true },
        },
        documentText: "const value=1;\n",
      },
      new AbortController().signal,
    );
    expect(requestEditorFormatting).toHaveBeenCalledWith(
      expect.objectContaining({ options: { tabSize: 2, insertSpaces: true } }),
      expect.any(AbortSignal),
    );
    expect(formatResponse.edits[0]?.newText).toBe(" = ");

    const definition = surface.props?.provideDefinition;
    expect(definition).toBeDefined();
    if (definition === undefined) return;
    const definitionResponse = await definition(
      {
        request: { request: identity, document, position: { line: 0, column: 6 } },
        documentText: "const value=1;\n",
      },
      new AbortController().signal,
    );
    expect(requestEditorDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ position: { line: 0, character: 6 } }),
      expect.any(AbortSignal),
    );
    expect(definitionResponse.locations[0]?.path).toBe("src/def.ts");
    expect(openEditorFile).toHaveBeenCalledWith({
      root: "/repo",
      path: "src/def.ts",
      lineStart: 3,
      lineEnd: 3,
    });
    const uri = surface.props?.uriForPath?.("src/def.ts", { toString: () => "current" }) as
      | {
          readonly scheme?: string;
          readonly authority?: string;
          readonly fsPath?: string;
          readonly with?: unknown;
          toString(): string;
        }
      | undefined;
    expect(uri?.toString()).toContain("/src/def.ts");
    expect(uri).toEqual(
      expect.objectContaining({
        scheme: "keiko-editor",
        authority: "workspace",
        fsPath: expect.stringContaining("/src/def.ts"),
        with: expect.any(Function),
      }),
    );

    const references = surface.props?.provideReferences;
    expect(references).toBeDefined();
    if (references === undefined) return;
    const referencesResponse = await references(
      {
        request: {
          request: identity,
          document,
          position: { line: 0, column: 6 },
          includeDeclaration: true,
        },
        documentText: "const value=1;\n",
      },
      new AbortController().signal,
    );
    expect(referencesResponse.includesDeclaration).toBe(true);
    expect(referencesResponse.locations[0]?.path).toBe("src/ref.ts");
    expect(openEditorFile).toHaveBeenCalledTimes(1);

    const codeActions = surface.props?.provideCodeActions;
    expect(codeActions).toBeDefined();
    if (codeActions === undefined) return;
    const actionResponse = await codeActions(
      {
        request: {
          request: identity,
          document,
          range: { start: { line: 0, column: 0 }, end: { line: 0, column: 5 } },
          diagnostics: [],
        },
        documentText: "const value=1;\n",
      },
      new AbortController().signal,
    );
    expect(actionResponse.actions[0]?.title).toBe("Fix");

    const signatureHelp = surface.props?.provideSignatureHelp;
    expect(signatureHelp).toBeDefined();
    if (signatureHelp === undefined) return;
    const signatureResponse = await signatureHelp(
      {
        request: { request: identity, document, position: { line: 0, column: 6 } },
        documentText: "fn(",
      },
      new AbortController().signal,
    );
    expect(signatureResponse.signatures[0]?.label).toBe("fn(value: string)");
  });

  it("updates breadcrumbs from the shared document-symbol response and reveals clicked segments", async () => {
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(
      fileResponse({
        content: "class Greeter {\n  run() {\n    return 1;\n  }\n}\n",
      }),
    );
    vi.mocked(requestEditorSymbols).mockResolvedValueOnce({
      symbols: [
        {
          name: "Greeter",
          kind: "class",
          range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } },
        },
        {
          name: "run",
          kind: "method",
          range: { start: { line: 1, character: 2 }, end: { line: 3, character: 3 } },
        },
      ],
      truncated: false,
    });

    render(<EditorRuntimeWidget root="/repo" file="src/app.ts" />);
    await screen.findByTestId("editor-surface");
    act(() => {
      surface.props?.onCursorChange?.({ line: 2, column: 4 });
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Greeter" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "run" })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "Greeter" }));
    await waitFor(() => {
      expect(surface.props?.revealRequest?.range.start).toEqual({ line: 0, column: 0 });
    });
  });

  it("registers no language-intelligence resolvers for a non-source file", async () => {
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(
      fileResponse({ path: "notes.md", name: "notes.md", extension: "md" }),
    );
    render(<EditorRuntimeWidget root="/repo" file="notes.md" />);
    await screen.findByTestId("editor-surface");
    expect(surface.props?.provideDiagnostics).toBeUndefined();
    expect(surface.props?.provideHover).toBeUndefined();
    expect(surface.props?.provideSymbols).toBeUndefined();
    expect(surface.props?.provideFormatting).toBeUndefined();
    expect(surface.props?.provideDefinition).toBeUndefined();
    expect(surface.props?.provideReferences).toBeUndefined();
    expect(surface.props?.provideCodeActions).toBeUndefined();
    expect(surface.props?.provideSignatureHelp).toBeUndefined();
  });

  it("opens a rename changeset for review and applies accepted edits to the buffer", async () => {
    const originalPrompt = window.prompt;
    window.prompt = vi.fn(() => "renamed");
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    vi.mocked(requestEditorRenamePrepare).mockResolvedValueOnce({
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
      placeholder: "value",
    });
    vi.mocked(requestEditorRenameApply).mockResolvedValueOnce({
      schemaVersion: "1",
      files: [
        {
          path: "src/app.ts",
          expectedContentHash: BASE_VERSION.contentHash,
          edits: [
            {
              range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
              newText: "renamed",
            },
          ],
        },
      ],
      truncated: false,
      filesTruncated: false,
      returnedFileCount: 1,
      totalFileCount: 1,
      returnedEditCount: 1,
      totalEditCount: 1,
    });

    try {
      render(<EditorRuntimeWidget root="/repo" file="src/app.ts" />);
      await screen.findByTestId("editor-surface");
      act(() => {
        surface.props?.onCursorChange?.({ line: 0, column: 6 });
      });
      await waitFor(() => {
        expect(surface.props?.onRenameSymbol).toBeDefined();
      });

      await act(async () => {
        surface.props?.onRenameSymbol?.();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(diffSurface.props?.model.files[0]?.modified).toContain("renamed");
      });
      act(() => {
        diffSurface.props?.onApply?.();
      });
      await waitFor(() => {
        expect(surface.props?.buffer.content.text).toBe("const renamed = 1;\n");
      });
      expect(saveFilesContent).not.toHaveBeenCalled();
    } finally {
      window.prompt = originalPrompt;
    }
  });

  it("applies accepted rename edits to a loaded closed-file buffer without saving to disk", async () => {
    const originalPrompt = window.prompt;
    const onDirtyChange = vi.fn();
    window.prompt = vi.fn(() => "renamed");
    vi.mocked(fetchFilesContent)
      .mockResolvedValueOnce(fileResponse())
      .mockResolvedValueOnce(
        fileResponse({
          path: "src/other.ts",
          name: "other.ts",
          content: "const value = 1;\n",
        }),
      );
    vi.mocked(requestEditorRenamePrepare).mockResolvedValueOnce({
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
      placeholder: "value",
    });
    vi.mocked(requestEditorRenameApply).mockResolvedValueOnce({
      schemaVersion: "1",
      files: [
        {
          path: "src/other.ts",
          expectedContentHash: BASE_VERSION.contentHash,
          edits: [
            {
              range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
              newText: "renamed",
            },
          ],
        },
      ],
      truncated: false,
      filesTruncated: false,
      returnedFileCount: 1,
      totalFileCount: 1,
      returnedEditCount: 1,
      totalEditCount: 1,
    });

    try {
      const { rerender } = render(
        <EditorRuntimeWidget
          root="/repo"
          file="src/app.ts"
          openFiles={["src/app.ts", "src/other.ts"]}
          onDirtyChange={onDirtyChange}
        />,
      );
      await screen.findByTestId("editor-surface");
      act(() => {
        surface.props?.onCursorChange?.({ line: 0, column: 6 });
      });
      await act(async () => {
        surface.props?.onRenameSymbol?.();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(diffSurface.props?.model.files[0]?.displayPath).toBe("src/other.ts");
      });

      act(() => {
        diffSurface.props?.onApply?.();
      });
      rerender(
        <EditorRuntimeWidget
          root="/repo"
          file="src/other.ts"
          openFiles={["src/app.ts", "src/other.ts"]}
          onDirtyChange={onDirtyChange}
        />,
      );
      await waitFor(() => {
        expect(surface.props?.buffer.content.relativePath).toBe("src/other.ts");
      });
      expect(surface.props?.buffer.content.text).toBe("const renamed = 1;\n");
      expect(surface.props?.fileModel.dirty).toBe(true);
      expect(onDirtyChange).toHaveBeenCalledWith("src/other.ts", true);
      expect(saveFilesContent).not.toHaveBeenCalled();
    } finally {
      window.prompt = originalPrompt;
    }
  });

  it("applies a wide rename touching more files than the session cache capacity", async () => {
    // Regression for Issue #2105: a rename whose changeset touches more distinct closed files than
    // the bounded session cache (SESSION_CACHE_CAPACITY = 16) used to evict its own freshly-fetched
    // sources before Accept, producing a spurious VERSION_MISMATCH ("not loaded") that aborted the
    // whole apply. The review-time snapshots must let every file apply.
    const originalPrompt = window.prompt;
    const onDirtyChange = vi.fn();
    window.prompt = vi.fn(() => "renamed");
    const closedPaths = Array.from({ length: 20 }, (_, index) => `src/use-${String(index)}.ts`);
    vi.mocked(fetchFilesContent).mockImplementation((_root, path) =>
      Promise.resolve(
        fileResponse({
          path,
          name: path.slice(path.lastIndexOf("/") + 1),
          content: "const value = 1;\n",
        }),
      ),
    );
    vi.mocked(requestEditorRenamePrepare).mockResolvedValueOnce({
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
      placeholder: "value",
    });
    vi.mocked(requestEditorRenameApply).mockResolvedValueOnce({
      schemaVersion: "1",
      files: closedPaths.map((path) => ({
        path,
        expectedContentHash: BASE_VERSION.contentHash,
        edits: [
          {
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
            newText: "renamed",
          },
        ],
      })),
      truncated: false,
      filesTruncated: false,
      returnedFileCount: closedPaths.length,
      totalFileCount: closedPaths.length,
      returnedEditCount: closedPaths.length,
      totalEditCount: closedPaths.length,
    });

    try {
      render(
        <EditorRuntimeWidget
          root="/repo"
          file="src/app.ts"
          openFiles={["src/app.ts"]}
          onDirtyChange={onDirtyChange}
        />,
      );
      await screen.findByTestId("editor-surface");
      act(() => {
        surface.props?.onCursorChange?.({ line: 0, column: 6 });
      });
      await act(async () => {
        surface.props?.onRenameSymbol?.();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(diffSurface.props?.model.files.length).toBe(closedPaths.length);
      });

      act(() => {
        diffSurface.props?.onApply?.();
      });
      // Every changeset file applies — including the earliest-cached ones that the LRU would have
      // evicted — so no file is falsely reported as unloaded and nothing is written to disk.
      await waitFor(() => {
        expect(onDirtyChange).toHaveBeenCalledWith("src/use-0.ts", true);
      });
      for (const path of closedPaths) {
        expect(onDirtyChange).toHaveBeenCalledWith(path, true);
      }
      expect(saveFilesContent).not.toHaveBeenCalled();
    } finally {
      window.prompt = originalPrompt;
    }
  });

  it("reports a rename precondition conflict without applying stale edits", async () => {
    const originalPrompt = window.prompt;
    window.prompt = vi.fn(() => "renamed");
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    vi.mocked(requestEditorRenamePrepare).mockResolvedValueOnce({
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
      placeholder: "value",
    });
    vi.mocked(requestEditorRenameApply).mockResolvedValueOnce({
      schemaVersion: "1",
      files: [
        {
          path: "src/app.ts",
          expectedContentHash: "b".repeat(64),
          edits: [
            {
              range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
              newText: "renamed",
            },
          ],
        },
      ],
      truncated: false,
      filesTruncated: false,
      returnedFileCount: 1,
      totalFileCount: 1,
      returnedEditCount: 1,
      totalEditCount: 1,
    });

    try {
      render(<EditorRuntimeWidget root="/repo" file="src/app.ts" />);
      await screen.findByTestId("editor-surface");
      act(() => {
        surface.props?.onCursorChange?.({ line: 0, column: 6 });
      });
      await act(async () => {
        surface.props?.onRenameSymbol?.();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(diffSurface.props?.model.files[0]?.modified).toContain("renamed");
      });
      act(() => {
        diffSurface.props?.onApply?.();
      });
      await screen.findByText(/changed since the rename was computed/u);
      expect(surface.props?.buffer.content.text).toBe("const value = 1;\n");
    } finally {
      window.prompt = originalPrompt;
    }
  });

  it("keeps unavailable providers non-blocking and content-free in status and agent snapshots", async () => {
    installFakeEventSource();
    vi.mocked(fetchEditorLanguageCapabilities).mockResolvedValueOnce({
      schemaVersion: "1",
      providers: [
        {
          id: "python-lsp",
          languages: ["python"],
          operations: ["diagnostics", "completion", "hover", "symbols"],
          availability: "unavailable",
          unavailableReason: "Required host language tool is blocked by host execution policy.",
        },
      ],
    });
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(
      fileResponse({
        path: "src/tool.py",
        name: "tool.py",
        extension: "py",
        content: "value = 1\n",
      }),
    );

    render(<EditorRuntimeWidget windowId="provider-status" root="/repo" file="src/tool.py" />);
    await screen.findByTestId("editor-surface");

    await waitFor(() => {
      expect(surface.props?.provideCompletions).toBeUndefined();
      expect(surface.props?.provideDiagnostics).toBeUndefined();
      expect(surface.props?.provideHover).toBeUndefined();
      expect(surface.props?.provideSymbols).toBeUndefined();
      expect(surface.props?.provideFormatting).toBeUndefined();
      expect(surface.props?.provideDefinition).toBeUndefined();
      expect(surface.props?.provideReferences).toBeUndefined();
      expect(surface.props?.provideCodeActions).toBeUndefined();
      expect(surface.props?.provideSignatureHelp).toBeUndefined();
      expect(editorStatusField("language-service")).toHaveTextContent("LSP unavailable");
    });
    expect(editorStatusField("language-service")).toHaveAttribute(
      "aria-label",
      "Language provider unavailable: Required host language tool is blocked by host execution policy.",
    );
    expect(fetchEditorLanguageCapabilities).toHaveBeenCalledWith("/repo");

    await waitFor(() => {
      const snapshot = vi.mocked(postEditorAgentSessionSnapshot).mock.calls.at(-1)?.[0];
      expect(snapshot?.languageCapability).toEqual({
        languageId: "python",
        providerId: "python-lsp",
        available: false,
        unavailableReason: "Required host language tool is blocked by host execution policy.",
      });
    });
  });
});

describe("EditorWidget — status bar and command surface (Issue #1205)", () => {
  function statusField(id: string): Element | null {
    return screen.getByTestId("editor-status-bar").querySelector(`[data-field="${id}"]`);
  }

  it("renders the unified status bar with accessible tab + tabpanel roles", async () => {
    await renderLoaded();
    // A valid single-document tablist drives an associated tabpanel (the editor host).
    const tab = screen.getByRole("tab", { name: /app\.ts/ });
    const tabpanel = screen.getByRole("tabpanel");
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(tab.id).toBe("ed-editor-test-active-tab");
    expect(tab).toHaveAttribute("aria-controls", tabpanel.id);
    expect(tabpanel).toHaveAttribute("aria-labelledby", tab.id);
    expect(tabpanel).toContainElement(screen.getByTestId("editor-surface"));
    // The unified status bar is the single status surface, so the editor's own footer is suppressed.
    expect(surface.props?.showStatusFooter).toBe(false);
    expect(statusField("language")).toHaveTextContent("TypeScript");
    expect(statusField("completions")).toHaveTextContent("Completions on");
  });

  it("renders multiple open document tabs and emits select/close intents", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn(() => true);
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());

    render(
      <EditorRuntimeWidget
        windowId="editor-tabs"
        root="/repo"
        file="src/app.ts"
        openFiles={["src/app.ts", "package.json"]}
        dirtyFiles={["package.json"]}
        onSelectOpenFile={onSelect}
        onCloseOpenFile={onClose}
      />,
    );
    await screen.findByTestId("editor-surface");

    const active = screen.getByRole("tab", { name: "src/app.ts" });
    const inactive = screen.getByRole("tab", { name: "package.json" });
    expect(active).toHaveAttribute("aria-selected", "true");
    expect(inactive).toHaveAttribute("aria-selected", "false");
    expect(inactive.closest(".ed-tab")).toHaveAttribute("data-dirty", "true");
    expect(active.querySelector(".fi-img")).toHaveAttribute("src", "/assets/icons/typescript.svg");
    expect(inactive.querySelector(".fi-img")).toHaveAttribute("src", "/assets/icons/json.svg");
    expect(inactive.querySelector(".ed-dirty")).not.toHaveAttribute("title");

    await userEvent.click(inactive);
    expect(onSelect).toHaveBeenCalledWith("package.json");

    await userEvent.click(screen.getByRole("button", { name: "Close package.json" }));
    expect(onClose).toHaveBeenCalledWith("package.json");
  });

  it("emits selection when clicking the active tab of an inactive split pane", async () => {
    const onSelect = vi.fn();
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse({ path: "right-a.md" }));

    render(
      <EditorRuntimeWidget
        windowId="editor-inactive-pane-tab"
        root="/repo"
        file="right-a.md"
        openFiles={["right-a.md", "right-b.md"]}
        paneId="pane-2"
        activePaneId="pane-1"
        onSelectOpenFile={onSelect}
      />,
    );
    await screen.findByTestId("editor-surface");

    await userEvent.click(screen.getByRole("tab", { name: "right-a.md" }));
    expect(onSelect).toHaveBeenCalledWith("right-a.md");
  });

  it("deduplicates tab inputs and ignores empty tab entries from the host", async () => {
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    render(
      <EditorRuntimeWidget
        windowId="editor-dedupe-tabs"
        root="/repo"
        file="src/app.ts"
        openFiles={["", "src/app.ts", "src/app.ts"]}
      />,
    );
    await screen.findByTestId("editor-surface");

    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "src/app.ts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("restores an edited tab from the in-memory editor session cache", async () => {
    vi.mocked(fetchFilesContent)
      .mockResolvedValueOnce(
        fileResponse({ path: "src/a.ts", name: "a.ts", content: "const a = 1;\n" }),
      )
      .mockResolvedValueOnce(
        fileResponse({ path: "src/b.ts", name: "b.ts", content: "const b = 1;\n" }),
      );

    const { rerender } = render(
      <EditorRuntimeWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />,
    );
    await screen.findByTestId("editor-surface");
    act(() => {
      surface.props?.onContentChange({ text: "const a = 2;\n", sizeBytes: 13 }, "human");
    });

    rerender(
      <EditorRuntimeWidget root="/repo" file="src/b.ts" openFiles={["src/a.ts", "src/b.ts"]} />,
    );
    await waitFor(() => {
      expect(surface.props?.buffer.content.relativePath).toBe("src/b.ts");
    });

    rerender(
      <EditorRuntimeWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />,
    );
    await waitFor(() => {
      expect(surface.props?.buffer.content.relativePath).toBe("src/a.ts");
    });
    expect(surface.props?.buffer.content.text).toBe("const a = 2;\n");
    expect(surface.props?.fileModel.dirty).toBe(true);
    expect(fetchFilesContent).toHaveBeenCalledTimes(2);
  });

  it("derives unique tab and tabpanel IDs for multiple editor windows", async () => {
    vi.mocked(fetchFilesContent)
      .mockResolvedValueOnce(fileResponse({ path: "src/a.ts", name: "a.ts" }))
      .mockResolvedValueOnce(fileResponse({ path: "src/b.ts", name: "b.ts" }));

    render(
      <>
        <EditorRuntimeWidget windowId="win/a" root="/repo" file="src/a.ts" />
        <EditorRuntimeWidget windowId="win:b" root="/repo" file="src/b.ts" />
      </>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("editor-surface")).toHaveLength(2);
    });
    const tabs = screen.getAllByRole("tab");
    const tabpanels = screen.getAllByRole("tabpanel");
    expect(tabs).toHaveLength(2);
    expect(tabpanels).toHaveLength(2);
    expect(tabs[0]?.id).toBe("ed-win-a-active-tab");
    expect(tabs[1]?.id).toBe("ed-win-b-active-tab");
    expect(tabs[0]?.id).not.toBe(tabs[1]?.id);
    for (const [index, tab] of tabs.entries()) {
      const panel = tabpanels[index];
      expect(panel).toBeDefined();
      expect(tab).toHaveAttribute("aria-controls", panel?.id);
      expect(panel).toHaveAttribute("aria-labelledby", tab.id);
    }
  });

  it("falls back to the editor DOM id segment when the supplied window id is empty", async () => {
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());

    render(<EditorRuntimeWidget windowId="" root="/repo" file="src/app.ts" />);

    await screen.findByTestId("editor-surface");
    expect(screen.getByRole("tab", { name: "src/app.ts" }).id).toBe("ed-editor-active-tab");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "ed-editor-tabpanel");
  });

  it("keeps tabpanel wiring for loading, error, and empty editor states", async () => {
    vi.mocked(fetchFilesContent).mockReturnValueOnce(new Promise<FilesContentResponse>(() => {}));
    const loading = render(
      <EditorRuntimeWidget windowId="editor-loading" root="/repo" file="src/app.ts" />,
    );
    const loadingTab = screen.getByRole("tab", { name: /src\/app\.ts/ });
    const loadingPanel = screen.getByRole("tabpanel");
    expect(loadingPanel).toHaveTextContent(/loading file/i);
    expect(loadingTab).toHaveAttribute("aria-controls", loadingPanel.id);
    expect(loadingPanel).toHaveAttribute("aria-labelledby", loadingTab.id);
    loading.unmount();

    vi.mocked(fetchFilesContent).mockRejectedValueOnce(
      new ApiError("UNSUPPORTED_FILE", "This file cannot be edited.", 400),
    );
    const error = render(
      <EditorRuntimeWidget windowId="editor-error" root="/repo" file="src/app.ts" />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/cannot be edited/i);
    const errorTab = screen.getByRole("tab", { name: /src\/app\.ts/ });
    const errorPanel = screen.getByRole("tabpanel");
    expect(errorTab).toHaveAttribute("aria-controls", errorPanel.id);
    expect(errorPanel).toHaveAttribute("aria-labelledby", errorTab.id);
    error.unmount();

    render(<EditorRuntimeWidget windowId="editor-empty" />);
    const emptyTab = screen.getByRole("tab", { name: "Editor" });
    const emptyPanel = screen.getByRole("tabpanel");
    expect(emptyPanel).toContainElement(screen.getByRole("note"));
    expect(emptyTab).toHaveAttribute("aria-controls", emptyPanel.id);
    expect(emptyPanel).toHaveAttribute("aria-labelledby", emptyTab.id);
  });

  it("preserves long path labels in the tab tooltip and truncation wrapper", async () => {
    const longPath = "src/very/deeply/nested/component/with-a-long-file-name-for-tabs.ts";
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(
      fileResponse({ path: longPath, name: "with-a-long-file-name-for-tabs.ts" }),
    );
    render(<EditorRuntimeWidget windowId="editor-long-path" root="/repo" file={longPath} />);
    await screen.findByTestId("editor-surface");

    const tab = screen.getByRole("tab", { name: longPath });
    expect(tab).toHaveAttribute("data-tip", longPath);
    expect(tab).not.toHaveAttribute("title");
    const label = tab.querySelector(".ed-tab-label");
    expect(label).not.toBeNull();
    expect(label).toHaveTextContent(longPath);
  });

  it("compacts overflowing editor tabs into an accessible hidden-tab chooser", async () => {
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement): DOMRect {
        if (this.classList.contains("ed-tablist")) {
          return {
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 260,
            bottom: 32,
            width: 260,
            height: 32,
            toJSON: () => ({}),
          } as DOMRect;
        }
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          width: 0,
          height: 0,
          toJSON: () => ({}),
        } as DOMRect;
      });
    try {
      vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
      const onSelectOpenFile = vi.fn();
      const draggedPaths: string[] = [];
      render(
        <EditorRuntimeWidget
          windowId="editor-tabs-compact"
          root="/repo"
          file="src/app.ts"
          openFiles={["src/app.ts", "README.md", "src/other.ts"]}
          onSelectOpenFile={onSelectOpenFile}
          renderTabHandle={(path, _active, _dirty, context) => ({
            draggable: true,
            onDragStart: () => {
              context?.onDragModeStart?.();
              draggedPaths.push(path);
            },
          })}
        />,
      );
      await screen.findByTestId("editor-surface");

      await waitFor(() => {
        expect(screen.getAllByRole("tab")).toHaveLength(1);
      });
      const summary = screen.getByLabelText("2 more open documents");
      expect(summary).toHaveTextContent("+2");
      expect(summary).not.toHaveClass("ui-tip");
      expect(summary).not.toHaveAttribute("data-tip");
      expect(summary).not.toHaveAttribute("title");

      await userEvent.click(summary);
      expect(summary.closest("details")).toHaveAttribute("open");
      await userEvent.click(document.body);
      await waitFor(() => {
        expect(summary).toHaveAttribute("aria-expanded", "false");
      });
      expect(summary.closest("details")).not.toHaveAttribute("open");

      await userEvent.click(summary);
      const hiddenTab = screen.getByRole("button", { name: "README.md" });
      expect(hiddenTab).not.toHaveClass("ui-tip");
      expect(hiddenTab).not.toHaveAttribute("data-tip");
      expect(hiddenTab).not.toHaveAttribute("title");
      expect(hiddenTab).toHaveAttribute("draggable", "true");
      expect(hiddenTab.querySelector(".fi-img")).toHaveAttribute(
        "src",
        "/assets/icons/markdown.svg",
      );
      fireEvent.dragStart(hiddenTab, { dataTransfer: { effectAllowed: "", setData: vi.fn() } });
      expect(draggedPaths).toContain("README.md");
      await waitFor(() => {
        expect(summary).toHaveAttribute("aria-expanded", "false");
      });
      expect(summary.closest("details")).not.toHaveAttribute("open");

      await userEvent.click(summary);
      await userEvent.click(screen.getByRole("button", { name: "README.md" }));
      expect(onSelectOpenFile).toHaveBeenCalledWith("README.md");
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("groups only the tab overflow once tiles would shrink below a readable width", async () => {
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement): DOMRect {
        if (this.classList.contains("ed-tablist")) {
          return {
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 760,
            bottom: 32,
            width: 760,
            height: 32,
            toJSON: () => ({}),
          } as DOMRect;
        }
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          width: 0,
          height: 0,
          toJSON: () => ({}),
        } as DOMRect;
      });
    try {
      vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
      render(
        <EditorRuntimeWidget
          windowId="editor-tabs-readable"
          root="/repo"
          file="src/app.ts"
          openFiles={[
            "src/app.ts",
            "README.md",
            "docs/adr/ADR-001.md",
            "docs/adr/ADR-002.md",
            "docs/adr/ADR-003.md",
            "docs/adr/ADR-004.md",
            "docs/adr/ADR-005.md",
            "docs/adr/ADR-006.md",
          ]}
        />,
      );
      await screen.findByTestId("editor-surface");

      await waitFor(() => {
        expect(screen.getAllByRole("tab")).toHaveLength(6);
      });
      expect(screen.getAllByRole("tab")[0]).toHaveTextContent("src/app.ts");
      expect(screen.getByLabelText("2 more open documents")).toHaveTextContent("+2");
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("keeps the visible tab group stable while selecting already-visible tabs", async () => {
    const files = [
      "src/app.ts",
      "README.md",
      "playwright.issue-1296-editor-agent.config.ts",
      "docs/adr/ADR-001.md",
      "docs/adr/ADR-002.md",
      "docs/adr/ADR-003.md",
      "docs/adr/ADR-004.md",
      "docs/adr/ADR-005.md",
    ] as const;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement): DOMRect {
        if (this.classList.contains("ed-tablist")) {
          return {
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 616,
            bottom: 32,
            width: 616,
            height: 32,
            toJSON: () => ({}),
          } as DOMRect;
        }
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          width: 0,
          height: 0,
          toJSON: () => ({}),
        } as DOMRect;
      });
    try {
      vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
      const view = render(
        <EditorRuntimeWidget
          windowId="editor-tabs-stable"
          root="/repo"
          file={files[0]}
          openFiles={files}
        />,
      );
      await screen.findByTestId("editor-surface");

      const visibleTabNames = (): readonly string[] =>
        screen.getAllByRole("tab").map((tab) => tab.textContent ?? "");

      await waitFor(() => {
        expect(visibleTabNames()).toEqual([...files.slice(0, 4)]);
      });

      vi.mocked(fetchFilesContent).mockResolvedValueOnce(
        fileResponse({ path: files[2], name: "playwright.issue-1296-editor-agent.config.ts" }),
      );
      view.rerender(
        <EditorRuntimeWidget
          windowId="editor-tabs-stable"
          root="/repo"
          file={files[2]}
          openFiles={files}
        />,
      );
      await waitFor(() => {
        expect(visibleTabNames()).toEqual([...files.slice(0, 4)]);
      });

      vi.mocked(fetchFilesContent).mockResolvedValueOnce(
        fileResponse({ path: files[6], name: "ADR-004.md", extension: "md" }),
      );
      view.rerender(
        <EditorRuntimeWidget
          windowId="editor-tabs-stable"
          root="/repo"
          file={files[6]}
          openFiles={files}
        />,
      );
      await waitFor(() => {
        expect(visibleTabNames()).toEqual([...files.slice(3, 7)]);
      });
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("keeps the Tests toolbar action visible but disabled for unsupported files", async () => {
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(
      fileResponse({
        path: "README.md",
        name: "README.md",
        extension: "md",
        content: "# README\n",
      }),
    );
    const view = render(
      <EditorRuntimeWidget
        windowId="editor-generate-tests-slot"
        root="/repo"
        file="README.md"
        openFiles={["README.md", "src/app.ts"]}
      />,
    );
    await screen.findByTestId("editor-surface");
    const unsupportedTestsButton = screen.getByRole("button", { name: "Tests" });
    expect(unsupportedTestsButton).toHaveClass("ed-generate-tests");
    expect(unsupportedTestsButton).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(unsupportedTestsButton);
    expect(requestEditorTestGeneration).not.toHaveBeenCalled();

    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse({ path: "src/app.ts" }));
    view.rerender(
      <EditorRuntimeWidget
        windowId="editor-generate-tests-slot"
        root="/repo"
        file="src/app.ts"
        openFiles={["README.md", "src/app.ts"]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Tests" })).toHaveAttribute(
        "aria-disabled",
        "false",
      );
    });
  });

  it("does not re-encode the full buffer on cursor-only status updates", async () => {
    const encodeSpy = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      await renderLoaded();
      const encodeCallsAfterLoad = encodeSpy.mock.calls.length;

      act(() => {
        surface.props?.onCursorChange?.({ line: 9, column: 3 });
      });

      expect(statusField("cursor")).toHaveTextContent("Ln 10, Col 4");
      expect(encodeSpy.mock.calls).toHaveLength(encodeCallsAfterLoad);
    } finally {
      encodeSpy.mockRestore();
    }
  });

  it("passes jest-axe for the loaded editor chrome", async () => {
    const { container } = await renderLoaded({ windowId: "editor-axe" });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("reflects the live cursor position but never announces it", async () => {
    await renderLoaded();
    act(() => {
      surface.props?.onCursorChange?.({ line: 9, column: 3 });
    });
    expect(statusField("cursor")).toHaveTextContent("Ln 10, Col 4");
    // The cursor must not reach the announced live region (it changes per keystroke).
    expect(screen.getByTestId("editor-status-bar-live")).not.toHaveTextContent("Line 10");
  });

  it("surfaces the diagnostics problem count reported by the surface", async () => {
    await renderLoaded();
    expect(surface.props?.onDiagnosticsSummary).toBeTypeOf("function");
    act(() => {
      surface.props?.onDiagnosticsSummary?.({ errors: 1, warnings: 2, infos: 0 });
    });
    expect(statusField("problems")).toHaveAttribute("aria-label", "Problems: 1 error, 2 warnings");
    expect(statusField("problems")).toHaveClass("ed-sb-error");
    expect(screen.getByTestId("editor-status-bar-live")).toHaveTextContent(
      "Problems: 1 error, 2 warnings",
    );
  });

  it("wires the Generate Tests command to the surface for source files", async () => {
    await renderLoaded();
    expect(surface.props?.onGenerateTests).toBeTypeOf("function");
  });

  it("sends a format request to the editor surface from the Format button", async () => {
    await renderLoaded();
    expect(surface.props?.formatRequestNonce).toBe(0);

    const formatButton = screen.getByRole("button", { name: "Format" });
    expect(formatButton).not.toHaveAttribute("data-tip");
    await userEvent.click(formatButton);

    await waitFor(() => {
      expect(surface.props?.formatRequestNonce).toBe(1);
    });
  });

  it("wires no command/diagnostics surface and shows completions-off for non-source files", async () => {
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(
      fileResponse({ path: "notes.md", name: "notes.md", extension: "md" }),
    );
    render(<EditorRuntimeWidget root="/repo" file="notes.md" />);
    await screen.findByTestId("editor-surface");
    expect(surface.props?.onGenerateTests).toBeUndefined();
    expect(surface.props?.onDiagnosticsSummary).toBeUndefined();
    expect(statusField("completions")).toHaveTextContent("Completions off");
    expect(statusField("problems")).toBeNull();
  });

  it("disables editor-intelligence providers and surfaces status in large-file degraded mode", async () => {
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(
      fileResponse({
        content: "x".repeat(500_001),
        sizeBytes: 500_001,
      }),
    );
    render(<EditorRuntimeWidget root="/repo" file="src/app.ts" />);
    await screen.findByTestId("editor-surface");

    expect(surface.props?.buffer.readOnly).toBe(true);
    expect(surface.props?.provideCompletions).toBeUndefined();
    expect(surface.props?.provideInlineCompletions).toBeUndefined();
    expect(surface.props?.onInlineCompletionTelemetry).toBeUndefined();
    expect(surface.props?.provideDiagnostics).toBeUndefined();
    expect(surface.props?.provideHover).toBeUndefined();
    expect(surface.props?.provideSymbols).toBeUndefined();
    expect(surface.props?.provideFormatting).toBeUndefined();
    expect(surface.props?.onDiagnosticsSummary).toBeUndefined();
    expect(surface.props?.onGenerateTests).toBeUndefined();
    expect(statusField("large-file")).toHaveTextContent("Large file mode");
    expect(statusField("completions")).toHaveTextContent("Completions off");
    expect(screen.getByTestId("editor-status-bar-live")).toHaveTextContent(
      "Large file mode: completions and analysis disabled",
    );
    expect(requestEditorCompletion).not.toHaveBeenCalled();
    expect(requestEditorInlineCompletion).not.toHaveBeenCalled();
    expect(requestEditorDiagnostics).not.toHaveBeenCalled();
    expect(requestEditorHover).not.toHaveBeenCalled();
    expect(requestEditorSymbols).not.toHaveBeenCalled();
    expect(requestEditorFormatting).not.toHaveBeenCalled();
    expect(requestEditorTestGeneration).not.toHaveBeenCalled();
  });
});

describe("EditorWidget — agent bridge", () => {
  function agentResults(): readonly Parameters<typeof postEditorAgentActionResult>[0]["result"][] {
    return vi.mocked(postEditorAgentActionResult).mock.calls.map(([body]) => body.result);
  }

  async function renderedAgentSession(): Promise<{
    readonly source: FakeEventSource;
    readonly sessionId: string;
  }> {
    const FakeSource = installFakeEventSource();
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    render(
      <EditorRuntimeWidget
        windowId="agent-window"
        root="/repo"
        file="src/app.ts"
        openFiles={["src/app.ts", "README.md"]}
        dirtyFiles={["README.md"]}
        paneId="pane-1"
        activePaneId="pane-1"
        layoutPanes={[
          { paneId: "pane-1", activeFile: "src/app.ts", openFiles: ["src/app.ts"] },
          { paneId: "pane-2", activeFile: "README.md", openFiles: ["README.md"] },
        ]}
        onSelectOpenFile={vi.fn()}
      />,
    );
    await screen.findByTestId("editor-surface");
    await waitFor(() => {
      expect(postEditorAgentSessionSnapshot).toHaveBeenCalled();
      expect(FakeSource.instances.length).toBeGreaterThan(0);
    });
    const snapshot = vi.mocked(postEditorAgentSessionSnapshot).mock.calls.at(-1)?.[0];
    expect(snapshot).toEqual(
      expect.objectContaining({
        windowId: "agent-window",
        workspaceRoot: "/repo",
        activePaneId: "pane-1",
        activeFile: "src/app.ts",
        dirtyFiles: ["README.md"],
        textMode: "none",
      }),
    );
    expect(snapshot?.panes).toEqual([
      { paneId: "pane-1", activeFile: "src/app.ts", openFiles: ["src/app.ts"] },
      { paneId: "pane-2", activeFile: "README.md", openFiles: ["README.md"] },
    ]);
    const source = FakeSource.instances.at(-1);
    expect(source).toBeDefined();
    // Issue #1392 — the bridge connection carries its session id so the BFF can track liveness.
    expect(source?.url).toBe(
      `/api/editor/agent/events?sessionId=${encodeURIComponent(String(snapshot?.sessionId))}`,
    );
    return { source: source as FakeEventSource, sessionId: String(snapshot?.sessionId) };
  }

  it("registers snapshots and executes queued editor-owned agent actions", async () => {
    const onSelect = vi.fn();
    const FakeSource = installFakeEventSource();
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    const view = render(
      <EditorRuntimeWidget
        windowId="agent-window"
        root="/repo"
        file="src/app.ts"
        openFiles={["src/app.ts", "README.md"]}
        dirtyFiles={["README.md"]}
        onSelectOpenFile={onSelect}
      />,
    );
    await screen.findByTestId("editor-surface");
    await waitFor(() => {
      expect(postEditorAgentSessionSnapshot).toHaveBeenCalled();
      expect(FakeSource.instances.length).toBeGreaterThan(0);
    });
    const sessionId = String(
      vi.mocked(postEditorAgentSessionSnapshot).mock.calls.at(-1)?.[0].sessionId,
    );
    const source = FakeSource.instances.at(-1) as FakeEventSource;
    vi.mocked(saveFilesContent).mockResolvedValueOnce(
      fileResponse({ content: "let value = 1;\n", modifiedAt: 2 }),
    );

    act(() => {
      source.emitAction(
        agentAction("other-session", "focusTab", { target: { file: "ignored.ts" } }),
      );
      source.emitRaw("{bad-json");
      source.emitAction(agentAction(sessionId, "focusTab"));
      source.emitAction(agentAction(sessionId, "openFile", { target: { file: "README.md" } }));
      source.emitAction(agentAction(sessionId, "format"));
      source.emitAction(agentAction(sessionId, "applyTextEdits"));
      source.emitAction(
        agentAction(sessionId, "applyTextEdits", {
          textEdits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
              newText: "let",
            },
          ],
        }),
      );
      source.emitAction(agentAction(sessionId, "moveTab"));
      source.emitAction(agentAction(sessionId, "splitPane"));
      source.emitAction(agentAction(sessionId, "setSelection"));
      source.emitAction(agentAction(sessionId, "applyPatch"));
      source.emitAction(agentAction(sessionId, "save"));
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("README.md");
    await waitFor(() => {
      expect(surface.props?.formatRequestNonce).toBe(1);
      expect(surface.props?.buffer.content.text).toBe("let value = 1;\n");
    });
    await waitFor(() => {
      expect(agentResults().some((result) => result.message === "Save failed.")).toBe(false);
      expect(agentResults().filter((result) => result.status === "succeeded")).toHaveLength(4);
      expect(agentResults().filter((result) => result.status === "failed")).toHaveLength(6);
    });
    expect(agentResults()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "failed", message: "Missing target file." }),
        expect.objectContaining({ status: "failed", message: "Missing text edits." }),
        expect.objectContaining({ status: "failed", message: "Provider unavailable." }),
        expect.objectContaining({ status: "failed", message: "Missing selection target." }),
        expect.objectContaining({ status: "succeeded" }),
      ]),
    );

    view.unmount();
    expect(source.removeEventListener).toHaveBeenCalledWith(
      "editor-agent:action",
      expect.any(Function),
    );
    expect(source.close).toHaveBeenCalled();
  });

  it("keeps the agent event stream stable when action callback props change", async () => {
    const firstSelect = vi.fn();
    const secondSelect = vi.fn();
    const FakeSource = installFakeEventSource();
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    const props = {
      windowId: "agent-window",
      root: "/repo",
      file: "src/app.ts",
      openFiles: ["src/app.ts", "README.md"],
    } as const;
    const view = render(<EditorRuntimeWidget {...props} onSelectOpenFile={firstSelect} />);
    await screen.findByTestId("editor-surface");
    await waitFor(() => {
      expect(postEditorAgentSessionSnapshot).toHaveBeenCalled();
      expect(FakeSource.instances).toHaveLength(1);
    });
    const source = FakeSource.instances[0] as FakeEventSource;
    const sessionId = String(
      vi.mocked(postEditorAgentSessionSnapshot).mock.calls.at(-1)?.[0].sessionId,
    );

    view.rerender(<EditorRuntimeWidget {...props} onSelectOpenFile={secondSelect} />);

    expect(FakeSource.instances).toHaveLength(1);
    expect(source.close).not.toHaveBeenCalled();
    act(() => {
      source.emitAction(agentAction(sessionId, "focusTab", { target: { file: "README.md" } }));
    });
    expect(firstSelect).not.toHaveBeenCalled();
    expect(secondSelect).toHaveBeenCalledWith("README.md");
  });

  it("reports agent format actions as unavailable for unsupported languages", async () => {
    const FakeSource = installFakeEventSource();
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(
      fileResponse({ path: "notes.md", name: "notes.md", extension: "md" }),
    );
    render(<EditorRuntimeWidget windowId="agent-markdown" root="/repo" file="notes.md" />);
    await screen.findByTestId("editor-surface");
    await waitFor(() => {
      expect(postEditorAgentSessionSnapshot).toHaveBeenCalled();
      expect(FakeSource.instances.length).toBeGreaterThan(0);
    });
    const sessionId = String(
      vi.mocked(postEditorAgentSessionSnapshot).mock.calls.at(-1)?.[0].sessionId,
    );

    act(() => {
      (FakeSource.instances.at(-1) as FakeEventSource).emitAction(agentAction(sessionId, "format"));
    });

    await waitFor(() => {
      expect(agentResults()).toContainEqual(
        expect.objectContaining({
          status: "failed",
          message: "Formatting is unavailable for this language.",
        }),
      );
    });
  });

  it("keeps agent bridge registration best-effort when the snapshot route fails", async () => {
    installFakeEventSource();
    vi.mocked(postEditorAgentSessionSnapshot).mockRejectedValueOnce(new Error("offline"));
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());

    render(<EditorRuntimeWidget windowId="agent-offline" root="/repo" file="src/app.ts" />);

    await screen.findByTestId("editor-surface");
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("keeps inactive split panes from opening duplicate agent event streams", async () => {
    const FakeSource = installFakeEventSource();
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());

    render(
      <EditorRuntimeWidget
        windowId="agent-inactive-pane"
        root="/repo"
        file="src/app.ts"
        paneId="pane-2"
        activePaneId="pane-1"
      />,
    );

    await screen.findByTestId("editor-surface");
    await waitFor(() => {
      expect(postEditorAgentSessionSnapshot).toHaveBeenCalled();
    });
    expect(FakeSource.instances).toHaveLength(0);
  });

  it("keeps the active pane event stream stable across handler rerenders", async () => {
    const FakeSource = installFakeEventSource();
    const firstSelect = vi.fn();
    const secondSelect = vi.fn();
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());

    const view = render(
      <EditorRuntimeWidget
        windowId="agent-active-pane"
        root="/repo"
        file="src/app.ts"
        paneId="pane-1"
        activePaneId="pane-1"
        onSelectOpenFile={firstSelect}
      />,
    );

    await screen.findByTestId("editor-surface");
    await waitFor(() => {
      expect(postEditorAgentSessionSnapshot).toHaveBeenCalled();
      expect(FakeSource.instances).toHaveLength(1);
    });
    const sessionId = String(
      vi.mocked(postEditorAgentSessionSnapshot).mock.calls.at(-1)?.[0].sessionId,
    );
    const source = FakeSource.instances[0] as FakeEventSource;

    view.rerender(
      <EditorRuntimeWidget
        windowId="agent-active-pane"
        root="/repo"
        file="src/app.ts"
        paneId="pane-1"
        activePaneId="pane-1"
        onSelectOpenFile={secondSelect}
      />,
    );

    expect(FakeSource.instances).toHaveLength(1);
    expect(source.close).not.toHaveBeenCalled();
    act(() => {
      source.emitAction(agentAction(sessionId, "openFile", { target: { file: "README.md" } }));
    });

    expect(firstSelect).not.toHaveBeenCalled();
    expect(secondSelect).toHaveBeenCalledWith("README.md");

    view.unmount();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("multiplexes multiple active agent sessions over one live event stream", async () => {
    const FakeSource = installFakeEventSource();

    const view = render(
      <>
        <EditorRuntimeWidget windowId="agent-mux-1" root="/repo" file="src/app.ts" />
        <EditorRuntimeWidget windowId="agent-mux-2" root="/repo" file="README.md" />
      </>,
    );

    await screen.findAllByTestId("editor-surface");
    await waitFor(() => {
      expect(postEditorAgentSessionSnapshot).toHaveBeenCalledTimes(2);
    });
    const sessionIds = vi
      .mocked(postEditorAgentSessionSnapshot)
      .mock.calls.map(([snapshot]) => snapshot.sessionId);

    await waitFor(() => {
      const liveSources = FakeSource.instances.filter(
        (source) => source.close.mock.calls.length === 0,
      );
      expect(liveSources).toHaveLength(1);
      const [source] = liveSources;
      for (const sessionId of sessionIds) {
        expect(source?.url).toContain(`sessionId=${encodeURIComponent(sessionId)}`);
      }
    });

    view.unmount();
    expect(FakeSource.instances.every((source) => source.close.mock.calls.length > 0)).toBe(true);
  });

  it("rounds fractional modifiedAt values before posting agent snapshots", async () => {
    installFakeEventSource();
    const loadedVersion = { ...BASE_VERSION, modifiedAt: 12.75 };
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(
      fileResponse({
        session: { schemaVersion: "1", version: loadedVersion },
      }),
    );

    render(<EditorRuntimeWidget windowId="agent-rounding" root="/repo" file="src/app.ts" />);

    await screen.findByTestId("editor-surface");
    await waitFor(() => {
      expect(postEditorAgentSessionSnapshot).toHaveBeenCalled();
    });

    const snapshot = vi.mocked(postEditorAgentSessionSnapshot).mock.calls.at(-1)?.[0];
    expect(loadedVersion.modifiedAt).toBe(12.75);
    expect(snapshot?.documentVersion?.modifiedAt).toBe(13);
    expect(Number.isInteger(snapshot?.documentVersion?.modifiedAt ?? NaN)).toBe(true);
  });

  it("includes cursor, selection, diagnostics, dirty state, and layout panes in agent snapshots", async () => {
    const { sessionId } = await renderedAgentSession();

    act(() => {
      surface.props?.onCursorChange?.({ line: 4, column: 2 });
      surface.props?.onSelectionChange?.({
        start: { line: 2, column: 1 },
        end: { line: 3, column: 5 },
      });
      surface.props?.onDiagnosticsSummary?.({ errors: 1, warnings: 0, infos: 2 });
      surface.props?.onContentChange({ text: "const changed = true;\n", sizeBytes: 22 }, "human");
    });

    await waitFor(() => {
      const latest = vi.mocked(postEditorAgentSessionSnapshot).mock.calls.at(-1)?.[0];
      expect(latest).toEqual(
        expect.objectContaining({
          sessionId,
          cursor: { line: 4, character: 2 },
          selection: {
            start: { line: 2, character: 1 },
            end: { line: 3, character: 5 },
          },
          diagnosticsSummary: { errors: 1, warnings: 0, infos: 2 },
          languageCapability: {
            languageId: "typescript",
            providerId: "typescript",
            available: true,
          },
          dirtyFiles: expect.arrayContaining(["README.md", "src/app.ts"]),
        }),
      );
    });
  });
});

// ─── Issue #1394 — AgentConflictBanner + applyPatch review (ADR-0058 D3/D4) ──────────────────

describe("EditorWidget — Issue #1394 agent conflict and patch review", () => {
  function agentResults(): readonly Parameters<typeof postEditorAgentActionResult>[0]["result"][] {
    return vi.mocked(postEditorAgentActionResult).mock.calls.map(([body]) => body.result);
  }

  async function renderedAgentSession1394(): Promise<{
    readonly source: FakeEventSource;
    readonly sessionId: string;
  }> {
    const FakeSource = installFakeEventSource();
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    render(
      <EditorRuntimeWidget windowId="agent-1394" root="/repo" file="src/app.ts" paneId="pane-1" />,
    );
    await screen.findByTestId("editor-surface");
    await waitFor(() => {
      expect(postEditorAgentSessionSnapshot).toHaveBeenCalled();
      expect(FakeSource.instances.length).toBeGreaterThan(0);
    });
    const snapshot = vi.mocked(postEditorAgentSessionSnapshot).mock.calls.at(-1)?.[0];
    const source = FakeSource.instances.at(-1) as FakeEventSource;
    return { source, sessionId: String(snapshot?.sessionId) };
  }

  // ── AC3: conflict banner visibility (D4) ─────────────────────────────────

  it("renders AgentConflictBanner when a conflict result arrives via SSE", async () => {
    const { source, sessionId } = await renderedAgentSession1394();

    // Before the conflict event the banner must not be present.
    expect(screen.queryByTestId("agent-conflict-banner")).toBeNull();

    // Emit a conflict result from the SSE stream (editor-agent:result event).
    act(() => {
      const conflictEvent = new MessageEvent<string>("editor-agent:result", {
        data: JSON.stringify({
          schemaVersion: "1",
          eventId: "ev-1",
          type: "result",
          result: {
            schemaVersion: "1",
            actionId: "a-1",
            sessionId,
            status: "conflict",
            message: "The target buffer has unsaved changes.",
            conflict: { code: "DIRTY", message: "The target buffer has unsaved changes." },
          },
        }),
      });
      // The component listens on "editor-agent:result"; FakeEventSource only wraps
      // "editor-agent:action" in emitAction, so we dispatch directly to its listeners.
      for (const listener of (
        source as unknown as {
          listeners: Map<string, Set<EventListenerOrEventListenerObject>>;
        }
      ).listeners.get("editor-agent:result") ?? []) {
        if (typeof listener === "function") {
          listener(conflictEvent);
        } else {
          listener.handleEvent(conflictEvent);
        }
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId("agent-conflict-banner")).toBeInTheDocument();
    });

    // The editor surface stays mounted — non-destructive (AC3).
    expect(screen.getByTestId("editor-surface")).toBeInTheDocument();
  });

  it("dismisses the conflict banner when Dismiss is clicked (non-destructive AC3)", async () => {
    const { source, sessionId } = await renderedAgentSession1394();

    act(() => {
      const conflictEvent = new MessageEvent<string>("editor-agent:result", {
        data: JSON.stringify({
          schemaVersion: "1",
          eventId: "ev-dismiss",
          type: "result",
          result: {
            schemaVersion: "1",
            actionId: "a-dismiss",
            sessionId,
            status: "conflict",
            conflict: { code: "INVALID_EDITS", message: "Edit range was inverted." },
          },
        }),
      });
      for (const listener of (
        source as unknown as {
          listeners: Map<string, Set<EventListenerOrEventListenerObject>>;
        }
      ).listeners.get("editor-agent:result") ?? []) {
        if (typeof listener === "function") {
          listener(conflictEvent);
        } else {
          listener.handleEvent(conflictEvent);
        }
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId("agent-conflict-banner")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => {
      expect(screen.queryByTestId("agent-conflict-banner")).toBeNull();
    });

    // Editor surface still mounted.
    expect(screen.getByTestId("editor-surface")).toBeInTheDocument();
  });

  // ── AC2: overlapping edits produce conflict INVALID_EDITS (D3) ──────────

  it("reports conflict INVALID_EDITS when applyTextEdits contains overlapping edits", async () => {
    const { source, sessionId } = await renderedAgentSession1394();

    // applyTextEditsToText throws OverlappingPatchEditError for overlapping ranges.
    // Two edits covering the same characters will trigger this.
    act(() => {
      source.emitAction(
        agentAction(sessionId, "applyTextEdits", {
          textEdits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
              newText: "first",
            },
            {
              range: { start: { line: 0, character: 3 }, end: { line: 0, character: 8 } },
              newText: "second",
            },
          ],
        }),
      );
    });

    await waitFor(() => {
      const results = agentResults();
      expect(
        results.some((r) => r.status === "conflict" && r.conflict?.code === "INVALID_EDITS"),
      ).toBe(true);
    });

    // Buffer must remain unchanged (non-destructive).
    expect(surface.props?.buffer?.content.text).toBe("const value = 1;\n");
  });

  // ── applyPatch review UI: Accept / Reject (D3) ───────────────────────────

  it("shows Accept and Reject buttons after a queued applyPatch action arrives", async () => {
    const { source, sessionId } = await renderedAgentSession1394();

    // The server pre-validates applyPatch and emits the action with textEdits populated
    // (a whole-document-replace). Simulate what the server emits to the browser.
    act(() => {
      source.emitAction(
        agentAction(sessionId, "applyPatch", {
          target: { file: "src/app.ts" },
          textEdits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
              newText: "const value = 42;\n",
            },
          ],
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("agent-patch-accept")).toBeInTheDocument();
      expect(screen.getByTestId("agent-patch-reject")).toBeInTheDocument();
    });
  });

  it("Accept applies the modified content and reports succeeded", async () => {
    const { source, sessionId } = await renderedAgentSession1394();

    act(() => {
      source.emitAction(
        agentAction(sessionId, "applyPatch", {
          target: { file: "src/app.ts" },
          textEdits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
              newText: "const value = 99;\n",
            },
          ],
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("agent-patch-accept")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId("agent-patch-accept"));

    await waitFor(() => {
      expect(screen.queryByTestId("agent-patch-accept")).toBeNull();
    });

    // The normal editor surface is restored.
    expect(screen.getByTestId("editor-surface")).toBeInTheDocument();

    // postAgentResult was called with succeeded.
    await waitFor(() => {
      expect(agentResults().some((r) => r.status === "succeeded")).toBe(true);
    });
  });

  it("Reject keeps the buffer unchanged and reports failed", async () => {
    const { source, sessionId } = await renderedAgentSession1394();

    act(() => {
      source.emitAction(
        agentAction(sessionId, "applyPatch", {
          target: { file: "src/app.ts" },
          textEdits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
              newText: "const value = 77;\n",
            },
          ],
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("agent-patch-reject")).toBeInTheDocument();
    });

    // Capture the buffer content before rejecting.
    const contentBefore = surface.props?.buffer?.content.text;

    await userEvent.click(screen.getByTestId("agent-patch-reject"));

    await waitFor(() => {
      expect(screen.queryByTestId("agent-patch-reject")).toBeNull();
    });

    // The normal editor surface is restored with the original content.
    expect(screen.getByTestId("editor-surface")).toBeInTheDocument();
    expect(surface.props?.buffer?.content.text).toBe(contentBefore);

    // postAgentResult was called with failed.
    await waitFor(() => {
      expect(
        agentResults().some(
          (r) => r.status === "failed" && r.message === "Patch rejected by user.",
        ),
      ).toBe(true);
    });
  });

  it("reports failed (not conflict) when applyPatch arrives with no textEdits", async () => {
    const { source, sessionId } = await renderedAgentSession1394();

    act(() => {
      source.emitAction(
        agentAction(sessionId, "applyPatch", {
          target: { file: "src/app.ts" },
          // No textEdits — server failed to derive them.
        }),
      );
    });

    await waitFor(() => {
      expect(agentResults().some((r) => r.status === "failed")).toBe(true);
    });

    // Review UI must not appear.
    expect(screen.queryByTestId("agent-patch-accept")).toBeNull();
    expect(screen.queryByTestId("agent-patch-reject")).toBeNull();
  });

  it("reports conflict OUT_OF_SCOPE when applyPatch targets a file not open in this pane", async () => {
    const { source, sessionId } = await renderedAgentSession1394();

    act(() => {
      source.emitAction(
        agentAction(sessionId, "applyPatch", {
          target: { file: "other/file.ts" },
          textEdits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
              newText: "x",
            },
          ],
        }),
      );
    });

    await waitFor(() => {
      expect(
        agentResults().some((r) => r.status === "conflict" && r.conflict?.code === "OUT_OF_SCOPE"),
      ).toBe(true);
    });

    // Review UI must not appear.
    expect(screen.queryByTestId("agent-patch-accept")).toBeNull();
  });

  // ── F6: sessionId filter — conflict for a different sessionId does NOT show banner ────────────

  it("does not show AgentConflictBanner when a conflict result arrives for a different sessionId", async () => {
    const { source } = await renderedAgentSession1394();

    act(() => {
      const conflictEvent = new MessageEvent<string>("editor-agent:result", {
        data: JSON.stringify({
          schemaVersion: "1",
          eventId: "ev-other",
          type: "result",
          result: {
            schemaVersion: "1",
            actionId: "a-other",
            // A different sessionId — must be filtered out by onAgentResult (F6).
            sessionId: "completely-different-session",
            status: "conflict",
            conflict: { code: "DIRTY", message: "Dirty in another pane." },
          },
        }),
      });
      for (const listener of (
        source as unknown as {
          listeners: Map<string, Set<EventListenerOrEventListenerObject>>;
        }
      ).listeners.get("editor-agent:result") ?? []) {
        if (typeof listener === "function") {
          listener(conflictEvent);
        } else {
          listener.handleEvent(conflictEvent);
        }
      }
    });

    // Give React a chance to render; the banner must NOT appear.
    await act(async () => {});
    expect(screen.queryByTestId("agent-conflict-banner")).toBeNull();

    // Editor surface must remain mounted.
    expect(screen.getByTestId("editor-surface")).toBeInTheDocument();
  });

  // ── F5: failed persist after DIRTY conflict keeps banner visible ─────────────────────────────

  it("keeps AgentConflictBanner visible when onSave fails to persist (F5)", async () => {
    const { source, sessionId } = await renderedAgentSession1394();

    // Surface the DIRTY conflict banner.
    act(() => {
      const conflictEvent = new MessageEvent<string>("editor-agent:result", {
        data: JSON.stringify({
          schemaVersion: "1",
          eventId: "ev-dirty-save",
          type: "result",
          result: {
            schemaVersion: "1",
            actionId: "a-dirty-save",
            sessionId,
            status: "conflict",
            message: "The target buffer has unsaved changes.",
            conflict: { code: "DIRTY", message: "The target buffer has unsaved changes." },
          },
        }),
      });
      for (const listener of (
        source as unknown as {
          listeners: Map<string, Set<EventListenerOrEventListenerObject>>;
        }
      ).listeners.get("editor-agent:result") ?? []) {
        if (typeof listener === "function") {
          listener(conflictEvent);
        } else {
          listener.handleEvent(conflictEvent);
        }
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId("agent-conflict-banner")).toBeInTheDocument();
    });

    // Make the buffer dirty.
    act(() => {
      surface.props?.onContentChange({ text: "dirty content\n", sizeBytes: 14 }, "human");
    });
    // Confirm dirty state: toolbar Save aria-disabled flips to "false".
    await waitFor(() => {
      const toolbar = document.querySelector(".ed-toolbar-actions");
      expect(toolbar).not.toBeNull();
      const toolbarBtn = within(toolbar as HTMLElement).getByRole("button", { name: /^Save$/u });
      expect(toolbarBtn).toHaveAttribute("aria-disabled", "false");
    });

    // Use a never-resolving save so we can assert the banner stays visible while saving is
    // in progress (the banner is dismissed ONLY when persist resolves ok===true; a pending
    // or rejected save must keep it). Reset first: afterEach uses vi.clearAllMocks(), which does
    // NOT drain a mockResolvedValueOnce queued by an earlier test in the suite — without this
    // reset the save would consume that leaked success value and wrongly dismiss the banner.
    vi.mocked(saveFilesContent).mockReset();
    vi.mocked(saveFilesContent).mockReturnValueOnce(new Promise(() => {}));

    // Click the Save button inside the banner (DIRTY renders a Save button in the banner;
    // the toolbar also has one — target unambiguously with `within`).
    const banner = screen.getByTestId("agent-conflict-banner");
    await userEvent.click(within(banner).getByRole("button", { name: "Save" }));

    // The save is in-flight and has not resolved, so the banner must still be present.
    // React should have set saveStatus to "saving" but agentConflict stays non-null.
    await act(async () => {});
    expect(screen.getByTestId("agent-conflict-banner")).toBeInTheDocument();
  });
});

// ─── Issue #1393 — layout-controller bridge actions (ADR-0061) ────────────────
//
// These tests render EditorRuntimeWidget with onSplitPane / onMoveTab injected
// (exactly as EditorWidget.renderPane does) and exercise the AC1 path where
// agent actions reach and invoke the layout controllers.

describe("EditorWidget — agent layout-controller bridge actions", () => {
  function agentResultsLayoutCtrl(): readonly Parameters<
    typeof postEditorAgentActionResult
  >[0]["result"][] {
    return vi.mocked(postEditorAgentActionResult).mock.calls.map(([body]) => body.result);
  }

  async function renderedLayoutSession(
    onSplitPane: ((paneId: string, direction: "row" | "column") => void) | undefined,
    onMoveTab: ((fromPaneId: string, file: string, toPaneId: string) => void) | undefined,
  ): Promise<{ source: FakeEventSource; sessionId: string }> {
    const FakeSource = installFakeEventSource();
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    render(
      <EditorRuntimeWidget
        windowId="layout-ctrl-agent"
        root="/repo"
        file="src/app.ts"
        paneId="pane-1"
        openFiles={["src/app.ts"]}
        onSelectOpenFile={vi.fn()}
        onSplitPane={onSplitPane}
        onMoveTab={onMoveTab}
      />,
    );
    await screen.findByTestId("editor-surface");
    await waitFor(() => {
      expect(postEditorAgentSessionSnapshot).toHaveBeenCalled();
      expect(FakeSource.instances.length).toBeGreaterThan(0);
    });
    const sessionId = String(
      vi.mocked(postEditorAgentSessionSnapshot).mock.calls.at(-1)?.[0].sessionId,
    );
    const source = FakeSource.instances.at(-1) as FakeEventSource;
    return { source, sessionId };
  }

  // (a) splitPane — layout controller invoked, result succeeded ───────────────

  it("splitPane with onSplitPane injected calls the layout controller and reports succeeded", async () => {
    const onSplitPane = vi.fn();
    const { source, sessionId } = await renderedLayoutSession(onSplitPane, vi.fn());

    act(() => {
      source.emitAction(agentAction(sessionId, "splitPane", { target: { splitDirection: "row" } }));
    });

    await waitFor(() => {
      expect(agentResultsLayoutCtrl().some((r) => r.status === "succeeded")).toBe(true);
    });
    expect(onSplitPane).toHaveBeenCalledWith("pane-1", "row");
  });

  it("splitPane with column direction calls onSplitPane with 'column'", async () => {
    const onSplitPane = vi.fn();
    const { source, sessionId } = await renderedLayoutSession(onSplitPane, vi.fn());

    act(() => {
      source.emitAction(
        agentAction(sessionId, "splitPane", { target: { splitDirection: "column" } }),
      );
    });

    await waitFor(() => {
      expect(agentResultsLayoutCtrl().some((r) => r.status === "succeeded")).toBe(true);
    });
    expect(onSplitPane).toHaveBeenCalledWith("pane-1", "column");
  });

  // (b) moveTab — containment check blocks escaping paths ────────────────────

  it("moveTab with an escaping path returns conflict OUT_OF_SCOPE", async () => {
    const onMoveTab = vi.fn();
    const { source, sessionId } = await renderedLayoutSession(vi.fn(), onMoveTab);

    act(() => {
      source.emitAction(
        agentAction(sessionId, "moveTab", {
          target: { file: "../escape", toPaneId: "pane-x" },
        }),
      );
    });

    await waitFor(() => {
      expect(
        agentResultsLayoutCtrl().some(
          (r) => r.status === "conflict" && r.conflict?.code === "OUT_OF_SCOPE",
        ),
      ).toBe(true);
    });
    expect(onMoveTab).not.toHaveBeenCalled();
  });

  it("moveTab with a valid file and pane calls onMoveTab and reports succeeded", async () => {
    const onMoveTab = vi.fn();
    const { source, sessionId } = await renderedLayoutSession(vi.fn(), onMoveTab);

    act(() => {
      source.emitAction(
        agentAction(sessionId, "moveTab", {
          target: { file: "src/app.ts", toPaneId: "pane-2" },
        }),
      );
    });

    await waitFor(() => {
      expect(agentResultsLayoutCtrl().some((r) => r.status === "succeeded")).toBe(true);
    });
    expect(onMoveTab).toHaveBeenCalledWith("pane-1", "src/app.ts", "pane-2");
  });

  // (c) setSelection — revealRequest transiently set on editor surface ─────────
  // The hook sets agentSelectionRequest → surfaceRevealRequest for one render, then
  // consumeSelectionRequest() clears it in the same act() flush. We capture the
  // peak value via a spy on the probe write so we can assert on it after act returns.

  it("setSelection passes a revealRequest with correct id and column mapping to the editor surface", async () => {
    const { source, sessionId } = await renderedLayoutSession(vi.fn(), vi.fn());
    const selection = {
      start: { line: 1, character: 2 },
      end: { line: 1, character: 5 },
    };
    const action = agentAction(sessionId, "setSelection", { target: { selection } });

    // Capture all non-null revealRequests seen during any render of the surface probe.
    const seenRevealRequests: NonNullable<EditorSurfaceProps["revealRequest"]>[] = [];
    const origProps = Object.getOwnPropertyDescriptor(surface, "props");
    Object.defineProperty(surface, "props", {
      configurable: true,
      set(value: EditorSurfaceProps | null) {
        if (value?.revealRequest != null) seenRevealRequests.push(value.revealRequest);
        // Store via direct property so reads work normally.
        Object.defineProperty(surface, "props", {
          configurable: true,
          writable: true,
          value,
        });
      },
    });

    act(() => {
      source.emitAction(action);
    });

    // Restore surface.props descriptor so afterEach cleanup works normally.
    if (origProps !== undefined) {
      Object.defineProperty(surface, "props", origProps);
    } else {
      Object.defineProperty(surface, "props", { configurable: true, writable: true, value: null });
    }

    // Primary AC1 proof: the action was dispatched and reported as succeeded.
    await waitFor(() => {
      expect(agentResultsLayoutCtrl().some((r) => r.status === "succeeded")).toBe(true);
    });

    // Secondary proof: a revealRequest was seen during the transient render.
    // It carries the actionId and maps character → column (character === column).
    expect(seenRevealRequests.length).toBeGreaterThan(0);
    const revealRequest = seenRevealRequests[0];
    expect(revealRequest?.id).toContain(action.actionId);
    expect(revealRequest?.range.start.column).toBe(2);
    expect(revealRequest?.range.end.column).toBe(5);
  });

  // Smoke: setSelection does not change document.activeElement (AC: no focus theft)
  it("setSelection does not steal keyboard focus from the current element", async () => {
    const { source, sessionId } = await renderedLayoutSession(vi.fn(), vi.fn());
    // Capture the active element before the agent action.
    const elementBefore = document.activeElement;

    act(() => {
      source.emitAction(
        agentAction(sessionId, "setSelection", {
          target: {
            selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
          },
        }),
      );
    });

    await waitFor(() => {
      expect(agentResultsLayoutCtrl().some((r) => r.status === "succeeded")).toBe(true);
    });
    // Focus must not have moved to the editor surface or any other element.
    expect(document.activeElement).toBe(elementBefore);
    expect(document.activeElement).not.toBe(screen.getByTestId("editor-surface"));
  });
});

describe("EditorWidget — hot-exit recovery", () => {
  it("offers recovery when a hot-exit snapshot differs from disk and restores it on demand (AC3)", async () => {
    vi.mocked(readEditorHotExitSnapshot).mockResolvedValueOnce(
      recoverySnapshotFixture({ content: "recovered edits\n" }),
    );
    await renderLoaded();

    expect(
      await screen.findByText("Recovered unsaved editor changes are available."),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Restore unsaved changes" }));

    await waitFor(() => {
      expect(surface.props?.fileModel.dirty).toBe(true);
    });
    expect(screen.queryByText("Recovered unsaved editor changes are available.")).toBeNull();
  });

  it("offers recovery even when the snapshot hash equals the disk version hash (AC3 false-negative guard)", async () => {
    // The buffer content differs from disk, yet the snapshot's recorded contentHash coincides with
    // the server-issued version hash (divergent hash normalizations). The removed content-AND-hash
    // gate suppressed this legitimate recovery offer; gating on content alone must still offer it.
    // This case fails under the previous condition and is the regression guard for the AC3 fix.
    vi.mocked(readEditorHotExitSnapshot).mockResolvedValueOnce(
      recoverySnapshotFixture({ content: "recovered edits\n", contentHash: "a".repeat(64) }),
    );
    await renderLoaded();

    expect(
      await screen.findByText("Recovered unsaved editor changes are available."),
    ).toBeInTheDocument();
  });

  it("does not offer recovery when the snapshot matches the on-disk content (AC3)", async () => {
    vi.mocked(readEditorHotExitSnapshot).mockResolvedValueOnce(
      recoverySnapshotFixture({ content: "const value = 1;\n" }),
    );
    await renderLoaded();

    expect(surface.props?.fileModel.dirty).toBe(false);
    expect(screen.queryByText(/Recovered/)).toBeNull();
  });

  it("offers compare, keep-local, use-disk, and cancel when the disk changed under a recovery (AC4)", async () => {
    vi.mocked(readEditorHotExitSnapshot).mockResolvedValueOnce(
      recoverySnapshotFixture({ content: "recovered edits\n", savedContentHash: "f".repeat(64) }),
    );
    await renderLoaded();

    expect(
      await screen.findByText("Recovered editor changes are available, and the disk file changed."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compare" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep local" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use disk" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    // Compare opens a true side-by-side diff: on-disk content (original) vs the recovered buffer.
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    await waitFor(() => {
      expect(diffSurface.props).not.toBeNull();
    });
    expect(diffSurface.props?.model.files[0]?.original).toBe("const value = 1;\n");
    expect(diffSurface.props?.model.files[0]?.modified).toBe("recovered edits\n");
  });

  it("deletes the hot-exit snapshot when the disk version is chosen over a recovery (AC4/AC5)", async () => {
    vi.mocked(readEditorHotExitSnapshot).mockResolvedValueOnce(
      recoverySnapshotFixture({ content: "recovered edits\n", savedContentHash: "f".repeat(64) }),
    );
    await renderLoaded();
    await screen.findByText("Recovered editor changes are available, and the disk file changed.");

    // Ignore the clean-buffer delete fired during load; assert the deletion caused by "Use disk".
    vi.mocked(deleteEditorHotExitSnapshot).mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Use disk" }));

    await waitFor(() => {
      expect(deleteEditorHotExitSnapshot).toHaveBeenCalledWith("/repo", "src/app.ts");
    });
    expect(screen.queryByText(/Recovered editor changes/)).toBeNull();
  });

  it("compares against the disk baseline even after the buffer is edited before Compare (AC4)", async () => {
    vi.mocked(readEditorHotExitSnapshot).mockResolvedValueOnce(
      recoverySnapshotFixture({ content: "recovered edits\n", savedContentHash: "f".repeat(64) }),
    );
    await renderLoaded();
    await screen.findByText("Recovered editor changes are available, and the disk file changed.");

    // Edit the freshly-loaded buffer before opening Compare; the diff's "on disk" side must remain
    // the captured disk baseline, not the now-edited live buffer.
    act(() => {
      surface.props?.onContentChange({ text: "typed over disk\n", sizeBytes: 16 }, "human");
    });
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    await waitFor(() => {
      expect(diffSurface.props).not.toBeNull();
    });
    expect(diffSurface.props?.model.files[0]?.original).toBe("const value = 1;\n");
    expect(diffSurface.props?.model.files[0]?.modified).toBe("recovered edits\n");
  });

  it("has no axe violations in the recovery banner or the compare panel (a11y)", async () => {
    vi.mocked(readEditorHotExitSnapshot).mockResolvedValueOnce(
      recoverySnapshotFixture({ content: "recovered edits\n", savedContentHash: "f".repeat(64) }),
    );
    const view = await renderLoaded();
    await screen.findByText("Recovered editor changes are available, and the disk file changed.");
    expect(await axe(view.container)).toHaveNoViolations();

    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    await waitFor(() => {
      expect(diffSurface.props).not.toBeNull();
    });
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("has no axe violations in the reload-file confirmation modal (a11y)", async () => {
    const view = await renderLoaded();
    vi.mocked(saveFilesContent).mockRejectedValueOnce(
      new ApiError("CONFLICT", "The file changed on disk.", 409),
    );
    act(() => {
      surface.props?.onContentChange({ text: "edited\n", sizeBytes: 7 }, "human");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(surface.props?.saveStatus).toBe("conflict");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Reload" }));
    await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});

describe("EditorWidget — stale-load discard on rapid file switch (GEN-TEST-MISSING-006)", () => {
  it("discards a stale load landing after a file switch", async () => {
    // File A's fetch is held open and never resolves until we release it *after* the user has
    // already switched to file B. File B resolves normally. The host's file-content load effect
    // marks the superseded load's signal cancelled on cleanup, so A's late landing must be
    // discarded and must not clobber B's buffer, identity, or load state.
    let resolveA: (response: FilesContentResponse) => void = () => {};
    vi.mocked(fetchFilesContent)
      .mockReturnValueOnce(
        new Promise<FilesContentResponse>((resolve) => {
          resolveA = resolve;
        }),
      )
      .mockResolvedValueOnce(
        fileResponse({ path: "src/b.ts", name: "b.ts", content: "const b = 1;\n" }),
      );

    const { rerender } = render(
      <EditorRuntimeWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />,
    );
    // A is still loading (its fetch never resolved): no editor surface yet.
    expect(await screen.findByText(/loading file/i)).toBeInTheDocument();
    expect(screen.queryByTestId("editor-surface")).toBeNull();

    // The user switches to file B before A ever lands; B settles into the editor.
    rerender(
      <EditorRuntimeWidget root="/repo" file="src/b.ts" openFiles={["src/a.ts", "src/b.ts"]} />,
    );
    await screen.findByTestId("editor-surface");
    await waitFor(() => {
      expect(surface.props?.buffer.content.text).toBe("const b = 1;\n");
    });
    expect(surface.props?.buffer.content.relativePath).toBe("src/b.ts");
    expect(surface.props?.fileModel.identity.uri).toMatch(/\/src\/b\.ts$/);

    // Now A's slow fetch finally lands, out of order. The superseded signal is cancelled, so this
    // late landing is discarded — it must NOT overwrite B's buffer/identity or reopen a load state.
    await act(async () => {
      resolveA(fileResponse({ path: "src/a.ts", name: "a.ts", content: "const a = 1;\n" }));
    });

    // B's content survives; A's stale content never reached the surface.
    expect(surface.props?.buffer.content.text).toBe("const b = 1;\n");
    expect(surface.props?.buffer.content.relativePath).toBe("src/b.ts");
    expect(surface.props?.fileModel.identity.uri).toMatch(/\/src\/b\.ts$/);
    expect(surface.props?.buffer.content.text).not.toBe("const a = 1;\n");
    // The editor stayed ready throughout — the discarded landing did not error or re-enter loading.
    expect(surface.props?.fileLoadState.status).toBe("ready");
    expect(screen.getByTestId("editor-surface")).toBeInTheDocument();
    // The always-present status-bar live region carries no error text; the stale landing was a
    // silent no-op rather than a surfaced load failure.
    expect(screen.getByTestId("editor-status-bar-alert")).toHaveTextContent("");
  });
});
