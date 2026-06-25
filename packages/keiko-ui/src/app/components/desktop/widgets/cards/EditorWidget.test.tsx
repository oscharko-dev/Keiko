import { act, render, screen, waitFor } from "@testing-library/react";
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
  fetchFilesContent,
  postEditorAgentActionResult,
  postEditorAgentSessionSnapshot,
  reportEditorInlineCompletionTelemetry,
  requestEditorCompletion,
  requestEditorDiagnostics,
  requestEditorFormatting,
  requestEditorHover,
  requestEditorInlineCompletion,
  requestEditorSymbols,
  requestEditorTestGeneration,
  saveFilesContent,
} from "../../../../../lib/api";
import type { EditorSurfaceProps } from "./EditorSurface";
import type { EditorDiffSurfaceProps } from "./EditorDiffSurface";
import EditorRuntimeWidget from "./EditorRuntimeWidget";

vi.mock("../../../../../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../../lib/api")>("../../../../../lib/api");
  return {
    ...actual,
    fetchEditorLanguageCapabilities: vi.fn(),
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
    requestEditorTestGeneration: vi.fn(),
  };
});

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
      operations: ["diagnostics", "completion", "hover", "symbols", "formatting"],
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
    this.emitRaw(JSON.stringify({ action }));
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

function loadedIdentity(): EditorSurfaceProps["fileModel"]["identity"] {
  const identity = surface.props?.fileModel.identity;
  if (identity === undefined) {
    throw new Error("editor identity unavailable");
  }
  return identity;
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
      /^keiko-editor:\/\/workspace\/[0-9a-f]{8}\/src\/app\.ts$/,
    );
    expect(surface.props?.ariaLabel).toBe("Editor: src/app.ts in /repo");
    expect(surface.props?.modifiedAt).toBe(1);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("aria-disabled", "true");
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

  it("offers a Generate Tests action for a TS file and surfaces the switched-off status", async () => {
    await renderLoaded();
    // Issue #1205: the unified status bar carries the single polite live region; the governed
    // test-generation run status feeds its "run" field, which is absent until a run starts.
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");
    expect(status).not.toHaveTextContent(/disabled in this build/i);
    const button = screen.getByRole("button", { name: "Generate Tests" });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute("data-tip", "Generate unit tests for this file");
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

    await userEvent.click(screen.getByRole("button", { name: "Generate Tests" }));

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

    await userEvent.click(screen.getByRole("button", { name: "Generate Tests" }));
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

    await userEvent.click(screen.getByRole("button", { name: "Generate Tests" }));
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

    await userEvent.click(screen.getByRole("button", { name: "Generate Tests" }));

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

describe("EditorWidget language intelligence (Issue #1201)", () => {
  it("wires diagnostics, hover, symbols, and formatting resolvers for a TS/JS file", async () => {
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
    render(<EditorRuntimeWidget root="/repo" file="src/app.ts" />);
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
      render(
        <EditorRuntimeWidget
          windowId="editor-tabs-compact"
          root="/repo"
          file="src/app.ts"
          openFiles={["src/app.ts", "README.md", "src/other.ts"]}
          onSelectOpenFile={onSelectOpenFile}
        />,
      );
      await screen.findByTestId("editor-surface");

      await waitFor(() => {
        expect(screen.getAllByRole("tab")).toHaveLength(1);
      });
      const summary = screen.getByLabelText("2 more open documents");
      expect(summary).toHaveTextContent("+2");
      expect(summary).toHaveAttribute("data-tip", "README.md, src/other.ts");
      expect(summary).not.toHaveAttribute("title");

      await userEvent.click(summary);
      const hiddenTab = screen.getByRole("button", { name: "README.md" });
      expect(hiddenTab).toHaveAttribute("data-tip", "README.md");
      await userEvent.click(hiddenTab);
      expect(onSelectOpenFile).toHaveBeenCalledWith("README.md");
    } finally {
      rectSpy.mockRestore();
    }
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

    await userEvent.click(screen.getByRole("button", { name: "Format" }));

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
    expect(source?.url).toBe("/api/editor/agent/events");
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
        expect.objectContaining({
          status: "failed",
          message: "Action must be executed by the editor layout controller.",
        }),
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
          dirtyFiles: expect.arrayContaining(["README.md", "src/app.ts"]),
        }),
      );
    });
  });
});
