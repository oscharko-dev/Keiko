/**
 * A11y tests for EditorRuntimeWidget patch-review buttons (Issue #1394, ADR-0058 D3/A11Y).
 *
 * Covers:
 *   - jest-axe reports no WCAG violations when the Accept/Reject review UI is visible.
 *   - Accept button has an accessible name (aria-label).
 *   - Reject button has an accessible name (aria-label).
 *   - Focus moves to the Accept button when a patch review opens (A11Y-2 in impl).
 *
 * Follows the AgentConflictBanner.test.tsx jest-axe pattern.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { useEffect, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EditorAgentAction,
  FilesContentResponse,
  LanguageServiceCapabilities,
} from "../../../../../lib/types";
import {
  ApiError,
  fetchEditorLanguageCapabilities,
  fetchFilesContent,
  postEditorAgentActionResult,
  postEditorAgentSessionSnapshot,
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

// Mirror the probe setup from EditorWidget.test.tsx so we can drive the surface.
const surface: { props: EditorSurfaceProps | null } = { props: null };
const diffSurface: { props: EditorDiffSurfaceProps | null } = { props: null };

vi.mock("next/dynamic", () => {
  let dynamicComponentIndex = 0;
  return {
    default: () => {
      const index = dynamicComponentIndex++;
      if (index > 0) {
        function EditorDiffSurfaceProbe(props: EditorDiffSurfaceProps): ReactElement {
          diffSurface.props = props;
          return <div data-testid="editor-diff-surface" />;
        }
        return EditorDiffSurfaceProbe;
      }
      function EditorSurfaceProbe(props: EditorSurfaceProps): ReactElement {
        useEffect(() => {}, []);
        surface.props = props;
        return <div data-testid="editor-surface" />;
      }
      return EditorSurfaceProbe;
    },
  };
});

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
    const set = this.listeners.get(type) ?? new Set<AgentEventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  emitAction(action: EditorAgentAction): void {
    // Emit the full editor-agent event envelope the server sends, so the widget's contract-guarded
    // SSE listener (isEditorAgentEvent) accepts the frame.
    const event = new MessageEvent<string>("editor-agent:action", {
      data: JSON.stringify({
        schemaVersion: "1",
        eventId: `evt-${action.actionId}`,
        type: "action",
        action,
      }),
    });
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
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource });
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

let agentActionSeq = 0;

function agentAction(
  sessionId: string,
  type: EditorAgentAction["type"],
  overrides: Partial<EditorAgentAction> = {},
): EditorAgentAction {
  agentActionSeq += 1;
  return {
    schemaVersion: "1",
    actionId: `a11y-action-${agentActionSeq}`,
    idempotencyKey: `a11y-ik-${agentActionSeq}`,
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

beforeEach(() => {
  vi.mocked(fetchEditorLanguageCapabilities).mockResolvedValue(LANGUAGE_CAPABILITIES);
  vi.mocked(postEditorAgentSessionSnapshot).mockResolvedValue({ snapshot: null });
  vi.mocked(postEditorAgentActionResult).mockResolvedValue({
    result: { schemaVersion: "1", actionId: "queued", sessionId: "queued", status: "queued" },
  });
});

afterEach(() => {
  surface.props = null;
  diffSurface.props = null;
  restoreEventSource();
  agentActionSeq = 0;
  vi.clearAllMocks();
});

/**
 * Render EditorRuntimeWidget with a loaded file and an active agent session, then
 * emit an applyPatch action with textEdits so the review UI appears.
 * Returns the rendered container, the FakeEventSource and the sessionId.
 */
async function renderWithPatchReview(): Promise<{
  container: Element;
  source: FakeEventSource;
  sessionId: string;
}> {
  const FakeSource = installFakeEventSource();
  vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
  const { container } = render(
    <EditorRuntimeWidget windowId="a11y-editor" root="/repo" file="src/app.ts" paneId="pane-1" />,
  );
  await screen.findByTestId("editor-surface");
  await waitFor(() => {
    expect(postEditorAgentSessionSnapshot).toHaveBeenCalled();
    expect(FakeSource.instances.length).toBeGreaterThan(0);
  });
  const snapshot = vi.mocked(postEditorAgentSessionSnapshot).mock.calls.at(-1)?.[0];
  const sessionId = String(snapshot?.sessionId);
  const source = FakeSource.instances.at(-1) as FakeEventSource;

  // Emit a queued applyPatch action with textEdits to enter the patch-review state.
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

  // Wait for the Accept button to appear — the review UI is now visible.
  await waitFor(() => {
    expect(screen.getByTestId("agent-patch-accept")).toBeInTheDocument();
  });

  return { container, source, sessionId };
}

describe("EditorRuntimeWidget patch-review buttons — accessibility (jest-axe)", () => {
  it("has no axe violations when the patch-review Accept/Reject UI is visible", async () => {
    const { container } = await renderWithPatchReview();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

describe("EditorRuntimeWidget patch-review buttons — accessible names", () => {
  it("Accept button has an accessible aria-label", async () => {
    await renderWithPatchReview();
    const acceptBtn = screen.getByTestId("agent-patch-accept");
    expect(acceptBtn).toHaveAttribute("aria-label");
    // The aria-label must be non-empty (screen-reader meaningful).
    expect(acceptBtn.getAttribute("aria-label")?.trim().length).toBeGreaterThan(0);
  });

  it("Reject button has an accessible aria-label", async () => {
    await renderWithPatchReview();
    const rejectBtn = screen.getByTestId("agent-patch-reject");
    expect(rejectBtn).toHaveAttribute("aria-label");
    expect(rejectBtn.getAttribute("aria-label")?.trim().length).toBeGreaterThan(0);
  });

  it("Accept button can be found by its accessible name (screen-reader navigation)", async () => {
    await renderWithPatchReview();
    // The button must be discoverable by getByRole with its accessible name.
    expect(screen.getByRole("button", { name: /accept agent patch/i })).toBeInTheDocument();
  });

  it("Reject button can be found by its accessible name (screen-reader navigation)", async () => {
    await renderWithPatchReview();
    expect(screen.getByRole("button", { name: /reject agent patch/i })).toBeInTheDocument();
  });
});

describe("EditorRuntimeWidget patch-review buttons — focus management (A11Y-2)", () => {
  it("moves focus to the Accept button when the patch review opens", async () => {
    // The impl uses a useEffect + ref.focus() (patchAcceptButtonRef) triggered when
    // agentPatchPending transitions from null => non-null. jsdom supports focus so we can assert.
    await renderWithPatchReview();
    const acceptBtn = screen.getByTestId("agent-patch-accept");
    // Focus must have landed on the Accept button.
    expect(document.activeElement).toBe(acceptBtn);
  });
});

describe("EditorRuntimeWidget agent actions — focus management (A11Y)", () => {
  it("a setSelection agent action does not steal focus", async () => {
    // Arrange: mount the widget (no patch review — this test stays in normal editing mode).
    const FakeSource = installFakeEventSource();
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    render(
      <EditorRuntimeWidget windowId="a11y-focus" root="/repo" file="src/app.ts" paneId="pane-1" />,
    );
    await screen.findByTestId("editor-surface");
    await waitFor(() => {
      expect(postEditorAgentSessionSnapshot).toHaveBeenCalled();
      expect(FakeSource.instances.length).toBeGreaterThan(0);
    });
    const sessionId = String(
      vi.mocked(postEditorAgentSessionSnapshot).mock.calls.at(-1)?.[0]?.sessionId,
    );
    const source = FakeSource.instances.at(-1) as FakeEventSource;

    // Capture whatever element currently owns focus before the agent action.
    const before = document.activeElement;

    // Act: emit a setSelection action — this drives a one-shot revealRequest (scroll/select)
    // and MUST NOT call .focus(), so the document's active element must not change.
    act(() => {
      source.emitAction(
        agentAction(sessionId, "setSelection", {
          target: {
            selection: {
              start: { line: 1, character: 2 },
              end: { line: 1, character: 5 },
            },
          },
        }),
      );
    });

    // Assert: focus did not move to a focusable agent-driven element.
    expect(document.activeElement).toBe(before);
    // The editor-surface probe is still mounted (widget did not unmount).
    expect(surface.props).not.toBeNull();
  });
});

// ─── Reload-confirm dialog focus restoration (GEN-UI-FOCUS-006) ───────────────

describe("EditorRuntimeWidget reload-confirm dialog — focus restoration (GEN-UI-FOCUS-006)", () => {
  it("returns focus to the Reload trigger when the reload-confirm dialog closes", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    render(
      <EditorRuntimeWidget windowId="a11y-reload" root="/repo" file="src/app.ts" paneId="pane-1" />,
    );
    await screen.findByTestId("editor-surface");

    // Make the buffer dirty, then fail the save with a 409 so the recoverable conflict + Reload appear.
    act(() => {
      surface.props?.onContentChange({ text: "edited value\n", sizeBytes: 13 }, "human");
    });
    vi.mocked(saveFilesContent).mockRejectedValueOnce(
      new ApiError("CONFLICT", "The file changed on disk.", 409),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    const reload = await screen.findByRole("button", { name: "Reload" });
    // Clicking Reload focuses the button (userEvent) and opens the reload-confirm dialog (dirty buffer).
    await user.click(reload);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();

    // Cancel the dialog — focus must return to the Reload trigger, not be lost to <body>.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(reload);
  });
});

// ─── Toolbar aria-disabled no-op announcement (GEN-UI-INTERACTION-003) ────────

describe("EditorRuntimeWidget toolbar — no-op announcement (GEN-UI-INTERACTION-003)", () => {
  it("announces a reason in the polite live region when Save is activated with nothing to save", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    render(
      <EditorRuntimeWidget windowId="a11y-notice" root="/repo" file="src/app.ts" paneId="pane-1" />,
    );
    await screen.findByTestId("editor-surface");

    // The buffer is clean (nothing edited), so Save is aria-disabled and a click is a guarded no-op.
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    const notice = screen.getByTestId("editor-toolbar-notice");
    expect(notice).toHaveTextContent("");

    await user.click(save);
    await waitFor(() => expect(notice).toHaveTextContent(/Nothing to save/i));
    // The live region is polite so screen readers announce it without interrupting.
    expect(notice).toHaveAttribute("aria-live", "polite");
  });
});
