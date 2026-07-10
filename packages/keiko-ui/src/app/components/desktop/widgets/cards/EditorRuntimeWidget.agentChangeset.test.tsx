import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDocumentDirty } from "@oscharko-dev/keiko-editor";

import {
  fetchEditorAgentAudit,
  fetchEditorLanguageCapabilities,
  fetchFilesContent,
  postEditorAgentActionResult,
  postEditorAgentSessionSnapshot,
  requestEditorSymbols,
} from "../../../../../lib/api";
import type {
  EditorAgentAction,
  EditorAgentActionResult,
  FilesContentResponse,
  LanguageServiceCapabilities,
} from "../../../../../lib/types";
import type { EditorDiffSurfaceProps } from "./EditorDiffSurface";
import EditorRuntimeWidget from "./EditorRuntimeWidget";
import type { EditorSurfaceProps } from "./EditorSurface";
import { _resetEditorAgentBridgeStateForTests } from "./editorAgentBridge";

vi.mock("../../../../../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../../lib/api")>("../../../../../lib/api");
  return {
    ...actual,
    fetchEditorAgentAudit: vi.fn(),
    fetchEditorLanguageCapabilities: vi.fn(),
    fetchFilesContent: vi.fn(),
    postEditorAgentActionResult: vi.fn(),
    postEditorAgentSessionSnapshot: vi.fn(),
    requestEditorSymbols: vi.fn(),
  };
});

vi.mock("./editorHotExitStore", () => ({
  readEditorHotExitSnapshot: vi.fn(() => Promise.resolve(null)),
  writeEditorHotExitSnapshot: vi.fn(() => Promise.resolve()),
  deleteEditorHotExitSnapshot: vi.fn(() => Promise.resolve()),
}));

const surface: { props: EditorSurfaceProps | null } = { props: null };
const diffSurface: { props: EditorDiffSurfaceProps | null } = { props: null };

vi.mock("next/dynamic", () => {
  let componentIndex = 0;
  return {
    default: () => {
      const index = componentIndex++;
      if (index === 0) {
        return function EditorSurfaceProbe(props: EditorSurfaceProps): ReactElement {
          surface.props = props;
          return <div data-testid="editor-surface" />;
        };
      }
      return function EditorDiffSurfaceProbe(props: EditorDiffSurfaceProps): ReactElement {
        diffSurface.props = props;
        const [selected, setSelected] = useState(props.model.files[0]?.uri ?? "");
        return (
          <div aria-label="Changeset diff">
            <ul aria-label="Changed files">
              {props.model.files.map((entry) => (
                <li key={entry.uri}>
                  <button
                    type="button"
                    aria-pressed={selected === entry.uri}
                    onClick={() => setSelected(entry.uri)}
                  >
                    {`Review ${entry.uri}`}
                  </button>
                </li>
              ))}
            </ul>
            <output data-testid="selected-change">{selected}</output>
            <button
              type="button"
              disabled={props.actions?.canApply !== true}
              onClick={props.onApply}
            >
              Apply changeset
            </button>
            <button
              type="button"
              disabled={props.actions?.canReject !== true}
              onClick={props.onReject}
            >
              Reject changeset
            </button>
          </div>
        );
      };
    },
  };
});

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const ORIGINAL_ACTIVE = "const before = 1;\n";
const UPDATED_ACTIVE = "const after = 1;\n";
const DELETED_CONTENT = "export const removed = true;\n";
const CREATED_CONTENT = "export const created = true;\n";

const LANGUAGE_CAPABILITIES: LanguageServiceCapabilities = {
  schemaVersion: "1",
  providers: [
    {
      id: "typescript",
      languages: ["typescript", "javascript"],
      operations: ["diagnostics", "symbols", "formatting"],
      availability: "available",
    },
  ],
};

type AgentEventListener = EventListenerOrEventListenerObject;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly close = vi.fn();
  readonly url: string;
  private readonly listeners = new Map<string, Set<AgentEventListener>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: AgentEventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<AgentEventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: AgentEventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emitAction(action: EditorAgentAction): void {
    const event = new MessageEvent<string>("editor-agent:action", {
      data: JSON.stringify({
        schemaVersion: "1",
        eventId: `event-${action.actionId}`,
        type: "action",
        action,
      }),
    });
    for (const listener of this.listeners.get("editor-agent:action") ?? []) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  }

  emitResult(result: EditorAgentActionResult): void {
    const event = new MessageEvent<string>("editor-agent:result", {
      data: JSON.stringify({
        schemaVersion: "1",
        eventId: `result-${result.actionId}`,
        type: "result",
        result,
      }),
    });
    for (const listener of this.listeners.get("editor-agent:result") ?? []) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  }
}

const ORIGINAL_EVENT_SOURCE = globalThis.EventSource;

function installFakeEventSource(): void {
  FakeEventSource.instances = [];
  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    value: FakeEventSource,
  });
}

function restoreEventSource(): void {
  if (ORIGINAL_EVENT_SOURCE === undefined) Reflect.deleteProperty(globalThis, "EventSource");
  else {
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      value: ORIGINAL_EVENT_SOURCE,
    });
  }
}

function fileResponse(
  path: string,
  content: string,
  contentHash: string,
  modifiedAt = 1,
  maxBytes = 1_000_000,
): FilesContentResponse {
  return {
    root: "/repo",
    path,
    name: path.split("/").at(-1) ?? path,
    sizeBytes: new TextEncoder().encode(content).length,
    modifiedAt,
    extension: path.split(".").at(-1) ?? "",
    mime: "text/plain",
    symlink: false,
    content,
    maxBytes,
    session: {
      schemaVersion: "1",
      version: { sizeBytes: content.length, modifiedAt, contentHash },
    },
  };
}

function changesetAction(sessionId: string, actionId = "changeset-1"): EditorAgentAction {
  return {
    schemaVersion: "1",
    actionId,
    idempotencyKey: `key-${actionId}`,
    sessionId,
    type: "applyChangeset",
    changeset: {
      patch: "diff --git a/src/active.ts b/src/active.ts\n",
      files: [
        { file: "src/created.ts", expectedContentHash: HASH_A },
        { file: "src/active.ts", expectedContentHash: HASH_A },
        { file: "src/deleted.ts", expectedContentHash: HASH_B },
      ],
      prepared: {
        files: [
          {
            file: "src/created.ts",
            kind: "create",
            textEdits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: CREATED_CONTENT,
              },
            ],
          },
          {
            file: "src/active.ts",
            kind: "modify",
            textEdits: [
              {
                range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
                newText: "after",
              },
            ],
          },
          {
            file: "src/deleted.ts",
            kind: "delete",
            textEdits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
                newText: "",
              },
            ],
          },
        ],
      },
    },
  };
}

function terminalResult(
  action: EditorAgentAction,
  status: "succeeded" | "failed",
): EditorAgentActionResult {
  return {
    schemaVersion: "1",
    actionId: action.actionId,
    sessionId: action.sessionId,
    status,
    files: action.changeset?.files.map((entry) => ({ file: entry.file, status })) ?? [],
  };
}

function submittedResults(): readonly EditorAgentActionResult[] {
  return vi.mocked(postEditorAgentActionResult).mock.calls.map(([body]) => body.result);
}

type CloseFileMock = ReturnType<typeof vi.fn<(file: string) => boolean>>;

async function renderAgentEditor(
  onCloseOpenFile: CloseFileMock = vi.fn<(file: string) => boolean>(() => true),
  onAgentChangesetCommitted?: (
    entries: readonly { readonly file: string; readonly kind: "create" | "modify" | "delete" }[],
  ) => void,
): Promise<{
  readonly source: FakeEventSource;
  readonly sessionId: string;
  readonly view: ReturnType<typeof render>;
  readonly onCloseOpenFile: CloseFileMock;
}> {
  installFakeEventSource();
  const view = render(
    <EditorRuntimeWidget
      windowId="changeset-test"
      root="/repo"
      file="src/active.ts"
      openFiles={["src/active.ts", "src/deleted.ts"]}
      onCloseOpenFile={onCloseOpenFile}
      onAgentChangesetCommitted={onAgentChangesetCommitted}
    />,
  );
  await screen.findByTestId("editor-surface");
  await waitFor(() => {
    expect(postEditorAgentSessionSnapshot).toHaveBeenCalled();
    expect(FakeEventSource.instances.length).toBeGreaterThan(0);
  });
  const sessionId = String(
    vi.mocked(postEditorAgentSessionSnapshot).mock.calls.at(-1)?.[0].sessionId,
  );
  return {
    source: FakeEventSource.instances.at(-1) as FakeEventSource,
    sessionId,
    view,
    onCloseOpenFile,
  };
}

beforeEach(() => {
  surface.props = null;
  diffSurface.props = null;
  vi.mocked(fetchEditorAgentAudit).mockResolvedValue({ records: [] });
  vi.mocked(fetchEditorLanguageCapabilities).mockResolvedValue(LANGUAGE_CAPABILITIES);
  vi.mocked(requestEditorSymbols).mockResolvedValue({ symbols: [], truncated: false });
  vi.mocked(postEditorAgentSessionSnapshot).mockReset();
  vi.mocked(postEditorAgentSessionSnapshot).mockImplementation(
    async (_snapshot, currentCapability) => ({
      snapshot: null,
      ...(currentCapability === undefined ? { bridgeDecisionCapability: "B".repeat(43) } : {}),
    }),
  );
  vi.mocked(postEditorAgentActionResult).mockResolvedValue({
    result: { schemaVersion: "1", actionId: "queued", sessionId: "queued", status: "queued" },
  });
});

afterEach(() => {
  restoreEventSource();
  _resetEditorAgentBridgeStateForTests();
  vi.clearAllMocks();
});

describe("EditorRuntimeWidget applyChangeset review", () => {
  it("refreshes a clean active model from a host reconciliation request", async () => {
    installFakeEventSource();
    const onComplete = vi.fn();
    vi.mocked(fetchFilesContent)
      .mockResolvedValueOnce(fileResponse("src/active.ts", ORIGINAL_ACTIVE, HASH_A))
      .mockResolvedValueOnce(fileResponse("src/active.ts", UPDATED_ACTIVE, HASH_C, 2));
    const baseProps = {
      windowId: "changeset-target",
      root: "/repo",
      file: "src/active.ts",
      openFiles: ["src/active.ts"],
      paneId: "pane-2",
      activePaneId: "pane-1",
      onAgentReconciliationComplete: onComplete,
    } as const;
    const view = render(<EditorRuntimeWidget {...baseProps} />);
    await screen.findByTestId("editor-surface");
    expect(surface.props?.buffer.content.text).toBe(ORIGINAL_ACTIVE);

    view.rerender(
      <EditorRuntimeWidget
        {...baseProps}
        agentReconciliationRequest={{
          requestId: 7,
          entries: [{ file: "src/active.ts", kind: "modify" }],
        }}
      />,
    );

    await waitFor(() => expect(surface.props?.buffer.content.text).toBe(UPDATED_ACTIVE));
    expect(isDocumentDirty(surface.props!.fileModel)).toBe(false);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(7, "pane-2");
  });

  it("applies an explicitly allowed changeset without staging review", async () => {
    const disk = new Map<string, FilesContentResponse>([
      ["src/active.ts", fileResponse("src/active.ts", ORIGINAL_ACTIVE, HASH_A)],
      ["src/deleted.ts", fileResponse("src/deleted.ts", DELETED_CONTENT, HASH_B)],
    ]);
    vi.mocked(fetchFilesContent).mockImplementation(async (_root, path) => {
      const response = disk.get(path);
      if (response === undefined) throw new Error("missing fixture");
      return response;
    });
    const onCommitted = vi.fn();
    const rendered = await renderAgentEditor(undefined, onCommitted);
    const action: EditorAgentAction = {
      ...changesetAction(rendered.sessionId, "automatic-changeset"),
      requiresReview: false,
    };
    vi.mocked(postEditorAgentActionResult).mockImplementation(async (body) => {
      disk.set("src/active.ts", fileResponse("src/active.ts", UPDATED_ACTIVE, HASH_C, 2));
      disk.set("src/created.ts", fileResponse("src/created.ts", CREATED_CONTENT, HASH_D, 2));
      disk.delete("src/deleted.ts");
      return {
        result: terminalResult(action, body.result.status === "succeeded" ? "succeeded" : "failed"),
      };
    });

    act(() => rendered.source.emitAction(action));

    await waitFor(() => {
      expect(surface.props?.buffer.content.text).toBe(UPDATED_ACTIVE);
      expect(submittedResults()).toContainEqual(
        expect.objectContaining({ actionId: action.actionId, status: "succeeded" }),
      );
    });
    expect(screen.queryByRole("group", { name: "Agent changeset review" })).toBeNull();
    expect(isDocumentDirty(surface.props!.fileModel)).toBe(false);
    expect(rendered.onCloseOpenFile).toHaveBeenCalledWith("src/deleted.ts");
    expect(onCommitted).toHaveBeenCalledWith([
      { file: "src/created.ts", kind: "create" },
      { file: "src/active.ts", kind: "modify" },
      { file: "src/deleted.ts", kind: "delete" },
    ]);
  });

  it("reviews three files, submits Accept once, and reconciles authoritative disk state", async () => {
    const disk = new Map<string, FilesContentResponse>([
      ["src/active.ts", fileResponse("src/active.ts", ORIGINAL_ACTIVE, HASH_A)],
      ["src/deleted.ts", fileResponse("src/deleted.ts", DELETED_CONTENT, HASH_B)],
    ]);
    vi.mocked(fetchFilesContent).mockImplementation(async (_root, path) => {
      const response = disk.get(path);
      if (response === undefined) throw new Error("missing fixture");
      return response;
    });
    const rendered = await renderAgentEditor();
    const action = changesetAction(rendered.sessionId);
    vi.mocked(postEditorAgentActionResult).mockImplementation(async (body) => {
      if (body.result.actionId === action.actionId && body.result.status === "succeeded") {
        disk.set("src/active.ts", fileResponse("src/active.ts", UPDATED_ACTIVE, HASH_C, 2));
        disk.set("src/created.ts", fileResponse("src/created.ts", CREATED_CONTENT, HASH_D, 2));
        disk.delete("src/deleted.ts");
        return { result: terminalResult(action, "succeeded") };
      }
      return { result: body.result };
    });

    act(() => rendered.source.emitAction(action));
    const review = await screen.findByRole("group", { name: "Agent changeset review" });
    expect(review.parentElement).toHaveStyle({
      display: "flex",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      minWidth: 0,
      minHeight: 0,
    });
    expect(review).toHaveStyle({
      flex: "1 1 auto",
      width: "100%",
      minWidth: 0,
      minHeight: 0,
    });
    expect(diffSurface.props?.model.files.map((entry) => entry.status)).toEqual([
      "created",
      "modified",
      "deleted",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Review src/active.ts" }));
    expect(screen.getByTestId("selected-change")).toHaveTextContent("src/active.ts");
    expect(await axe(review)).toHaveNoViolations();

    const accept = diffSurface.props?.onApply;
    expect(accept).toBeDefined();
    act(() => {
      accept?.();
      accept?.();
    });

    await waitFor(() => {
      expect(
        submittedResults().filter(
          (result) => result.actionId === action.actionId && result.status === "succeeded",
        ),
      ).toHaveLength(1);
      expect(screen.queryByRole("group", { name: "Agent changeset review" })).toBeNull();
    });
    expect(surface.props?.buffer.content.text).toBe(UPDATED_ACTIVE);
    expect(surface.props?.fileModel === undefined).toBe(false);
    expect(isDocumentDirty(surface.props!.fileModel)).toBe(false);
    expect(rendered.onCloseOpenFile).toHaveBeenCalledOnce();
    expect(rendered.onCloseOpenFile).toHaveBeenCalledWith("src/deleted.ts");

    const fetchCount = vi.mocked(fetchFilesContent).mock.calls.length;
    rendered.view.rerender(
      <EditorRuntimeWidget
        windowId="changeset-test"
        root="/repo"
        file="src/created.ts"
        openFiles={["src/active.ts", "src/created.ts"]}
        onCloseOpenFile={rendered.onCloseOpenFile}
      />,
    );
    await waitFor(() => expect(surface.props?.buffer.content.text).toBe(CREATED_CONTENT));
    expect(vi.mocked(fetchFilesContent)).toHaveBeenCalledTimes(fetchCount);
    expect(isDocumentDirty(surface.props!.fileModel)).toBe(false);
  });

  it("reconciles once when SSE confirms a changeset before the HTTP response", async () => {
    const disk = new Map<string, FilesContentResponse>([
      ["src/active.ts", fileResponse("src/active.ts", ORIGINAL_ACTIVE, HASH_A)],
      ["src/deleted.ts", fileResponse("src/deleted.ts", DELETED_CONTENT, HASH_B)],
    ]);
    vi.mocked(fetchFilesContent).mockImplementation(async (_root, path) => {
      const response = disk.get(path);
      if (response === undefined) throw new Error("missing fixture");
      return response;
    });
    const rendered = await renderAgentEditor();
    const action = changesetAction(rendered.sessionId, "sse-before-http");
    let resolveDecision:
      ((value: Awaited<ReturnType<typeof postEditorAgentActionResult>>) => void) | undefined;
    vi.mocked(postEditorAgentActionResult).mockReturnValue(
      new Promise((resolve) => {
        resolveDecision = resolve;
      }),
    );

    act(() => rendered.source.emitAction(action));
    const review = await screen.findByRole("group", { name: "Agent changeset review" });
    act(() => diffSurface.props?.onApply?.());
    expect(review).toHaveAttribute("aria-busy", "true");
    expect(surface.props?.buffer.content.text).toBe(ORIGINAL_ACTIVE);

    disk.set("src/active.ts", fileResponse("src/active.ts", UPDATED_ACTIVE, HASH_C, 2));
    disk.set("src/created.ts", fileResponse("src/created.ts", CREATED_CONTENT, HASH_D, 2));
    disk.delete("src/deleted.ts");
    act(() => rendered.source.emitResult(terminalResult(action, "succeeded")));

    await waitFor(() => {
      expect(screen.queryByRole("group", { name: "Agent changeset review" })).toBeNull();
      expect(surface.props?.buffer.content.text).toBe(UPDATED_ACTIVE);
    });
    expect(rendered.onCloseOpenFile).toHaveBeenCalledOnce();
    const fetchCount = vi.mocked(fetchFilesContent).mock.calls.length;

    act(() => {
      resolveDecision?.({ result: terminalResult(action, "succeeded") });
      rendered.source.emitResult(terminalResult(action, "succeeded"));
    });
    await act(async () => {});
    expect(vi.mocked(fetchFilesContent)).toHaveBeenCalledTimes(fetchCount);
    expect(rendered.onCloseOpenFile).toHaveBeenCalledOnce();
  });

  it("routes chat-origin Reject through the existing changeset review exactly once", async () => {
    const disk = new Map<string, FilesContentResponse>([
      ["src/active.ts", fileResponse("src/active.ts", ORIGINAL_ACTIVE, HASH_A)],
      ["src/deleted.ts", fileResponse("src/deleted.ts", DELETED_CONTENT, HASH_B)],
    ]);
    vi.mocked(fetchFilesContent).mockImplementation(async (_root, path) => {
      const response = disk.get(path);
      if (response === undefined) throw new Error("missing fixture");
      return response;
    });
    const rendered = await renderAgentEditor();
    const action: EditorAgentAction = {
      ...changesetAction(rendered.sessionId),
      origin: "chat",
    };
    vi.mocked(postEditorAgentActionResult).mockImplementation(async (body) => ({
      result: terminalResult(action, body.result.status === "failed" ? "failed" : "succeeded"),
    }));

    act(() => {
      rendered.source.emitAction(action);
      rendered.source.emitAction(action);
    });
    await screen.findByRole("group", { name: "Agent changeset review" });
    expect(diffSurface.props?.model).toMatchObject({
      patchId: `agent-changeset:${action.actionId}`,
      provenance: { origin: "applied-patch" },
      fileCount: 3,
    });
    expect(diffSurface.props?.actions).toEqual({
      canApply: true,
      canReject: true,
      canRunVerification: false,
    });
    expect(diffSurface.props?.onApply).toBeTypeOf("function");
    expect(diffSurface.props?.onReject).toBeTypeOf("function");
    // applyTextEdits would mutate and report immediately instead of staging EditorDiffSurface.
    expect(surface.props?.buffer.content.text).toBe(ORIGINAL_ACTIVE);
    expect(submittedResults().filter((result) => result.actionId === action.actionId)).toHaveLength(
      0,
    );
    const reject = diffSurface.props?.onReject;
    act(() => {
      reject?.();
      reject?.();
    });

    await waitFor(() => {
      const results = submittedResults().filter((result) => result.actionId === action.actionId);
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("failed");
      expect(screen.queryByRole("group", { name: "Agent changeset review" })).toBeNull();
    });
    expect(surface.props?.buffer.content.text).toBe(ORIGINAL_ACTIVE);
    expect(disk.has("src/deleted.ts")).toBe(true);
    expect(disk.has("src/created.ts")).toBe(false);
    expect(rendered.onCloseOpenFile).not.toHaveBeenCalled();
  });

  it("fails closed for missing, inconsistent, and overlapping review actions", async () => {
    vi.mocked(fetchFilesContent).mockImplementation(async (_root, path) =>
      path === "src/active.ts"
        ? fileResponse("src/active.ts", ORIGINAL_ACTIVE, HASH_A)
        : fileResponse("src/deleted.ts", DELETED_CONTENT, HASH_B),
    );
    const rendered = await renderAgentEditor();
    const missingBase = changesetAction(rendered.sessionId, "missing-prepared");
    const inconsistentBase = changesetAction(rendered.sessionId, "inconsistent-prepared");
    const first = changesetAction(rendered.sessionId, "first-review");
    const overlap = changesetAction(rendered.sessionId, "overlap-review");
    const missing: EditorAgentAction = {
      ...missingBase,
      changeset: { ...missingBase.changeset!, prepared: undefined },
    };
    const inconsistent: EditorAgentAction = {
      ...inconsistentBase,
      changeset: {
        ...inconsistentBase.changeset!,
        prepared: {
          files: [
            {
              ...inconsistentBase.changeset!.prepared!.files[0]!,
              file: "src/not-declared.ts",
            },
          ],
        },
      },
    };

    act(() => {
      rendered.source.emitAction(missing);
      rendered.source.emitAction(inconsistent);
      rendered.source.emitAction(first);
    });
    await screen.findByRole("group", { name: "Agent changeset review" });
    act(() => rendered.source.emitAction(overlap));
    await waitFor(() => {
      const failures = submittedResults().filter((result) => result.status === "failed");
      expect(failures.map((result) => result.actionId)).toEqual(
        expect.arrayContaining(["missing-prepared", "inconsistent-prepared", "overlap-review"]),
      );
    });
    expect(surface.props?.buffer.content.text).toBe(ORIGINAL_ACTIVE);
  });

  it("keeps editor state unchanged and surfaces a terminal server conflict", async () => {
    vi.mocked(fetchFilesContent).mockImplementation(async (_root, path) =>
      path === "src/active.ts"
        ? fileResponse("src/active.ts", ORIGINAL_ACTIVE, HASH_A)
        : fileResponse("src/deleted.ts", DELETED_CONTENT, HASH_B),
    );
    const rendered = await renderAgentEditor();
    const action = changesetAction(rendered.sessionId, "server-conflict");
    vi.mocked(postEditorAgentActionResult).mockResolvedValue({
      result: {
        schemaVersion: "1",
        actionId: action.actionId,
        sessionId: action.sessionId,
        status: "conflict",
        message: "A target changed on disk.",
        conflict: { code: "CONTENT_HASH_MISMATCH", message: "A target changed on disk." },
      },
    });

    act(() => rendered.source.emitAction(action));
    await screen.findByRole("group", { name: "Agent changeset review" });
    const fetchCount = vi.mocked(fetchFilesContent).mock.calls.length;
    act(() => diffSurface.props?.onApply?.());

    await screen.findByTestId("agent-conflict-banner");
    expect(screen.getByTestId("agent-conflict-banner")).toHaveTextContent(
      "The editor review conflicts with the current target.",
    );
    expect(surface.props?.buffer.content.text).toBe(ORIGINAL_ACTIVE);
    expect(vi.mocked(fetchFilesContent)).toHaveBeenCalledTimes(fetchCount);
    expect(rendered.onCloseOpenFile).not.toHaveBeenCalled();
  });
});
