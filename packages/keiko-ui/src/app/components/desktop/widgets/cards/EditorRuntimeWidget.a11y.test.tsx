/** Accessibility regressions for manual editor recovery, toolbar and document tabs. */
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { useEffect, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchEditorLanguageCapabilities,
  fetchFilesContent,
  fetchGitStatus,
  saveFilesContent,
} from "../../../../../lib/api";
import { I18N_STORAGE_KEY, I18nProvider } from "../../../../../lib/i18n";
import type { FilesContentResponse, LanguageServiceCapabilities } from "../../../../../lib/types";
import type { EditorDiffSurfaceProps } from "./EditorDiffSurface";
import EditorRuntimeWidget from "./EditorRuntimeWidget";
import type { EditorSurfaceProps } from "./EditorSurface";

vi.mock("../../../../../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../../lib/api")>("../../../../../lib/api");
  return {
    ...actual,
    fetchEditorLanguageCapabilities: vi.fn(),
    fetchFilesContent: vi.fn(),
    fetchGitStatus: vi.fn(),
    postEditorBufferSafetyRequest: vi.fn((request) =>
      Promise.resolve(
        request.kind === "buffer-snapshot"
          ? {
              snapshot: request.snapshot,
              ...(request.bufferSnapshotCapability === undefined
                ? { bufferSnapshotCapability: "A".repeat(43) }
                : {}),
            }
          : { snapshot: null },
      ),
    ),
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
});

afterEach(() => {
  resetClientDiagnosticWriter();
  surface.props = null;
  diffSurface.props = null;
  vi.clearAllMocks();
  vi.useRealTimers();
  window.localStorage.removeItem(I18N_STORAGE_KEY);
});

describe("EditorRuntimeWidget load failure", () => {
  it("localizes generic server failures and keeps retry and report actions available", async () => {
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    vi.mocked(fetchFilesContent).mockRejectedValueOnce(
      Object.assign(new ApiError("INTERNAL", "An unexpected error occurred.", 500), {
        correlationId: "load-failure-correlation",
      }),
    );
    render(
      <I18nProvider>
        <EditorRuntimeWidget root="/repo" file="src/app.ts" />
      </I18nProvider>,
    );
    expect(await screen.findByText("Datei konnte nicht geöffnet werden.")).toBeVisible();
    expect(screen.queryByText("An unexpected error occurred.")).toBeNull();
    expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Fehlerbericht erstellen" })).toBeEnabled();
  });

  it("reports a timed-out file read without its path or error text and keeps Retry available", async () => {
    const diagnostic = vi.fn();
    setClientDiagnosticWriter(diagnostic);
    vi.mocked(fetchFilesContent).mockRejectedValueOnce(
      new DOMException("private failure detail", "TimeoutError"),
    );
    render(
      <I18nProvider>
        <EditorRuntimeWidget root="/private/repo" file="secret-name.ts" />
      </I18nProvider>,
    );
    expect(await screen.findByRole("button", { name: "Retry" })).toBeEnabled();
    expect(diagnostic).toHaveBeenCalledWith(
      "[keiko] editor file load failed: TimeoutError",
      expect.objectContaining({ errorKind: "timeout" }),
    );
  });
});

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
    expect(dialog.parentElement?.parentElement).toBe(document.body);

    // Cancel the dialog — focus must return to the Reload trigger, not be lost to <body>.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(reload));
  });

  it("releases the modal interaction lock when the editor session becomes inactive", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    const view = render(
      <EditorRuntimeWidget
        windowId="a11y-reload-inactive"
        root="/repo"
        file="src/app.ts"
        paneId="pane-1"
        sessionActive
      />,
    );
    await screen.findByTestId("editor-surface");
    act(() => {
      surface.props?.onContentChange({ text: "edited value\n", sizeBytes: 13 }, "human");
    });
    vi.mocked(saveFilesContent).mockRejectedValueOnce(
      new ApiError("CONFLICT", "The file changed on disk.", 409),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(await screen.findByRole("button", { name: "Reload" }));
    await waitFor(() => expect(document.documentElement.dataset.keikoModalOpen).toBe("true"));

    view.rerender(
      <EditorRuntimeWidget
        windowId="a11y-reload-inactive"
        root="/repo"
        file="src/app.ts"
        paneId="pane-1"
        sessionActive={false}
      />,
    );

    await waitFor(() => expect(document.documentElement.dataset.keikoModalOpen).toBeUndefined());
  });

  // GEN-UI-FOCUS-002 — "Discard unsaved changes?" is aria-modal="true", which tells assistive
  // technology that everything behind it is unavailable. Without containment a keyboard or
  // screen-reader user could Tab out of the destructive confirm into the editor toolbar and window
  // chrome their AT was told they could not reach (WCAG 2.1.2).
  it("keeps Tab and Shift+Tab inside the reload-confirm dialog", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    render(
      <EditorRuntimeWidget
        windowId="a11y-reload-trap"
        root="/repo"
        file="src/app.ts"
        paneId="pane-1"
      />,
    );
    await screen.findByTestId("editor-surface");
    act(() => {
      surface.props?.onContentChange({ text: "edited value\n", sizeBytes: 13 }, "human");
    });
    vi.mocked(saveFilesContent).mockRejectedValueOnce(
      new ApiError("CONFLICT", "The file changed on disk.", 409),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(await screen.findByRole("button", { name: "Reload" }));

    const dialog = await screen.findByRole("dialog");
    const discard = screen.getByRole("button", { name: "Discard and reload" });
    const cancel = screen.getByRole("button", { name: "Cancel" });

    // Initial focus is the dialog container, so the very first Shift+Tab must wrap to the last
    // control rather than escaping to whatever was tabbable before the dialog opened.
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cancel);

    // Tab off the last control wraps to the first, and Shift+Tab off the first wraps back.
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(discard);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cancel);
  });
});

// ─── Toolbar aria-disabled no-op announcement (GEN-UI-INTERACTION-003) ────────

describe("EditorRuntimeWidget toolbar — no-op announcement (GEN-UI-INTERACTION-003)", () => {
  it("keeps secondary file actions out of the tab strip until requested", async () => {
    const user = userEvent.setup();
    const openDiff = vi.fn();
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    render(<EditorRuntimeWidget root="/repo" file="src/app.ts" onOpenGitDiff={openDiff} />);
    await screen.findByTestId("editor-surface");
    expect(screen.queryByRole("button", { name: "Tests" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open file history" })).not.toBeVisible();
    expect(screen.getByRole("button", { name: "Save" })).toBeVisible();
    await user.click(screen.getByLabelText("More file actions"));
    expect(screen.getByRole("button", { name: "Open file history" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Show this file's diff in Git" }));
    expect(openDiff).toHaveBeenCalledWith("/repo", "src/app.ts");
    expect(screen.getByRole("button", { name: "Open file history" })).not.toBeVisible();
  });

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

// ─── Document tab strip — WAI-ARIA tablist structure (0.3.0 release audit, #2802) ─────────────
//
// The real-browser axe lane found `aria-required-children` (critical) on `.ed-tablist` the first
// time it scanned the Editor window, and the finding was parked in that lane's KNOWN_A11Y_ISSUES
// ledger instead of fixed. The rule is structural, not visual, so jsdom reproduces it exactly:
// every element a `role="tablist"` owns must be a `role="tab"`, and both the per-tab close control
// and the overflow chooser were owned children with other roles.

function tablistRoot(container: Element): HTMLElement {
  const strip = container.querySelector<HTMLElement>(".ed-tablist");
  if (strip === null) throw new Error("tab strip did not render");
  return strip;
}

function stubTablistWidth(width: number): { mockRestore: () => void } {
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ): DOMRect {
    if (this.classList.contains("ed-tablist")) {
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: width,
        bottom: 32,
        width,
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
}

describe("EditorRuntimeWidget document tabs — tablist structure (#2802)", () => {
  it("owns only tabs when every open document carries a close affordance", async () => {
    vi.mocked(fetchFilesContent).mockResolvedValue(fileResponse());
    const { container } = render(
      <EditorRuntimeWidget
        windowId="a11y-tabstrip"
        root="/repo"
        file="src/app.ts"
        paneId="pane-1"
        openFiles={["src/app.ts", "src/b.ts"]}
        onCloseOpenFile={() => true}
      />,
    );
    await screen.findByTestId("editor-surface");

    expect(await axe(tablistRoot(container))).toHaveNoViolations();
  });

  it("owns only tabs when the overflow chooser is rendered", async () => {
    const rectSpy = stubTablistWidth(260);
    try {
      vi.mocked(fetchFilesContent).mockResolvedValue(fileResponse());
      const { container } = render(
        <EditorRuntimeWidget
          windowId="a11y-tabstrip-overflow"
          root="/repo"
          file="src/app.ts"
          paneId="pane-1"
          openFiles={["src/app.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]}
          onCloseOpenFile={() => true}
        />,
      );
      await screen.findByTestId("editor-surface");
      await waitFor(() => {
        expect(container.querySelector(".ed-tab-summary-menu")).not.toBeNull();
      });

      expect(await axe(tablistRoot(container))).toHaveNoViolations();
    } finally {
      rectSpy.mockRestore();
    }
  });
});

// The close control is decoration now, so the keyboard affordance the APG prescribes for a
// deletable tab has to actually exist — otherwise the structural fix would remove a real capability
// from keyboard and AT users instead of correcting it.

describe("EditorRuntimeWidget document tabs — closable-tab keyboard model (#2802)", () => {
  const onSelect = vi.fn();

  afterEach(() => {
    onSelect.mockClear();
  });

  async function renderTabs(onCloseOpenFile?: (file: string) => boolean): Promise<Element> {
    vi.mocked(fetchFilesContent).mockResolvedValue(fileResponse());
    const closeProps = onCloseOpenFile === undefined ? {} : { onCloseOpenFile };
    const { container } = render(
      <EditorRuntimeWidget
        windowId="a11y-tab-close"
        root="/repo"
        file="src/app.ts"
        paneId="pane-1"
        openFiles={["src/app.ts", "src/b.ts"]}
        onSelectOpenFile={onSelect}
        {...closeProps}
      />,
    );
    await screen.findByTestId("editor-surface");
    return container;
  }

  it("closes the focused tab on Delete", async () => {
    const onClose = vi.fn(() => true);
    await renderTabs(onClose);

    fireEvent.keyDown(screen.getByRole("tab", { name: "src/app.ts" }), { key: "Delete" });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledWith("src/app.ts");
    });
  });

  it("closes the focused tab on Backspace, the key Mac keyboards send", async () => {
    const onClose = vi.fn(() => true);
    await renderTabs(onClose);

    fireEvent.keyDown(screen.getByRole("tab", { name: "src/b.ts" }), { key: "Backspace" });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledWith("src/b.ts");
    });
  });

  it("leaves other keys to the tab strip's own navigation model", async () => {
    const onClose = vi.fn(() => true);
    await renderTabs(onClose);

    fireEvent.keyDown(screen.getByRole("tab", { name: "src/app.ts" }), { key: "ArrowRight" });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders no close affordance and ignores Delete when the host cannot close tabs", async () => {
    const container = await renderTabs();

    expect(container.querySelector(".ed-tab-close")).toBeNull();
    // Both branches of the guard: the key path is inert too, not merely invisible.
    fireEvent.keyDown(screen.getByRole("tab", { name: "src/app.ts" }), { key: "Delete" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("closes on a click of the × without also selecting the tab", async () => {
    const onClose = vi.fn(() => true);
    const container = await renderTabs(onClose);
    const close = container.querySelector<HTMLElement>('[data-tab-close-file="src/b.ts"]');
    expect(close).not.toBeNull();

    fireEvent.click(close as HTMLElement);

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledWith("src/b.ts");
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps the × out of the accessibility tree so the tab stays a valid owned child", async () => {
    const onClose = vi.fn(() => true);
    const container = await renderTabs(onClose);

    const close = container.querySelector('[data-tab-close-file="src/app.ts"]');
    expect(close).toHaveAttribute("aria-hidden", "true");
    expect(close?.closest('[role="tab"]')).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Close src/app.ts" })).toBeNull();
  });
});
