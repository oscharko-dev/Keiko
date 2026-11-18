import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
  type ClientDiagnosticMeta,
} from "@/lib/client-diagnostics";
import { NewWindowDialog, resolveFieldValue } from "./NewWindowDialog";
import {
  ApiError,
  createProject,
  fetchNativeFileDialogCapability,
  fetchProjects,
  openNativeFileDialog,
} from "@/lib/api";
import { resetNativeFileDialogCapabilityCacheForTests } from "@/lib/native-file-dialog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { DE_MESSAGES } from "@/lib/i18n-messages.de";
import { EN_MESSAGES } from "@/lib/i18n-messages.en";
import { WIN_TYPES } from "../windows/WindowsRegistry";
import { subText } from "../windows/connectionUtils";
import type { Cfg } from "./PermControl";

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  },
  fetchProjects: vi.fn(async () => ({ projects: [] })),
  createProject: vi.fn(),
  projectResponseWarningMessage: (response: {
    readonly warning?: { readonly message: string; readonly correlationId: string };
  }): string | undefined =>
    response.warning === undefined
      ? undefined
      : `${response.warning.message} Support ID: ${response.warning.correlationId}`,
  updateProject: vi.fn(),
  fetchNativeFileDialogCapability: vi.fn(async () => ({ supported: true })),
  openNativeFileDialog: vi.fn(async () => ({
    cancelled: true,
    selections: [],
    rejectedSelectionCount: 0,
    partial: false,
  })),
}));

beforeEach(() => {
  // The capability answer is memoized module state; reset it so each test's mock takes effect.
  resetNativeFileDialogCapabilityCacheForTests();
  // clearAllMocks() keeps implementations, so persistent mockResolvedValue overrides from one
  // test would leak into the next — pin the defaults here instead.
  vi.mocked(fetchNativeFileDialogCapability).mockResolvedValue({ supported: true });
  vi.mocked(openNativeFileDialog).mockResolvedValue({
    cancelled: true,
    selections: [],
    rejectedSelectionCount: 0,
    partial: false,
  });
});

afterEach(() => {
  resetClientDiagnosticWriter();
  vi.clearAllMocks();
});

function project(path = "/repo", name = "Repo", available = true) {
  return { path, name, favorite: false, createdAt: 1, lastOpenedAt: 2, available };
}

describe("resolveFieldValue", () => {
  it("passes a string field value through unchanged", () => {
    expect(resolveFieldValue("/repo/src")).toBe("/repo/src");
  });

  it("renders an undefined field value as an empty string", () => {
    expect(resolveFieldValue(undefined)).toBe("");
  });

  it("stringifies a non-string, non-undefined field value", () => {
    expect(resolveFieldValue(true)).toBe("true");
    expect(resolveFieldValue(42)).toBe("42");
  });
});

describe("chat window config", () => {
  it("does not expose a dead model field in the new-window dialog", () => {
    expect(WIN_TYPES.chat.config?.some((field) => field.key === "model")).toBe(false);
  });
});

// GAP-C3 (#146): the "Keiko-Mode coming soon" disabled toggle must not render
describe("NewWindowDialog: focus-restoration guaranteed fallback (MD-05)", () => {
  it("restores the opener captured before the lazy dialog mounts", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const capturedOpener = document.activeElement as HTMLElement;
    capturedOpener.blur();

    const { unmount } = render(
      <NewWindowDialog
        type="chat"
        types={WIN_TYPES}
        opener={capturedOpener}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    unmount();

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("waits for AppShell to unlock an inert opener before restoring focus", async () => {
    const background = document.createElement("div");
    background.className = "app";
    background.setAttribute("inert", "");
    const opener = document.createElement("button");
    background.appendChild(opener);
    document.body.appendChild(background);
    const nativeFocus = opener.focus.bind(opener);
    const focus = vi.spyOn(opener, "focus").mockImplementation(() => {
      if (!background.hasAttribute("inert")) nativeFocus();
    });

    const { unmount } = render(
      <NewWindowDialog
        type="chat"
        types={WIN_TYPES}
        opener={opener}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    unmount();
    background.removeAttribute("inert");

    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(focus).toHaveBeenCalledTimes(1);
    focus.mockRestore();
    background.remove();
  });

  it("focuses document.body when no top-window or FAB is available on close", () => {
    // Ensure no stray .window[data-top=true] or .ws-fab elements exist.
    expect(document.querySelector('.window[data-top="true"]')).toBeNull();
    expect(document.querySelector(".ws-fab")).toBeNull();

    const { unmount } = render(
      <NewWindowDialog type="chat" types={WIN_TYPES} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    // Detach the trigger reference by putting focus on body before unmount.
    document.body.focus();
    unmount();
    // Without the guaranteed fallback, focus would land in limbo (null activeElement
    // on some browsers); with it, document.body is always the fallback.
    expect(document.activeElement).toBe(document.body);
  });

  it("does not treat document.body as a valid opener and uses the deterministic FAB fallback", async () => {
    const fab = document.createElement("button");
    fab.className = "ws-fab";
    document.body.appendChild(fab);

    const { unmount } = render(
      <NewWindowDialog
        type="chat"
        types={WIN_TYPES}
        opener={document.body}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    unmount();

    await waitFor(() => {
      expect(document.activeElement).toBe(fab);
    });
    fab.remove();
  });
});

// FE-05 (WCAG 4.1.2) + FE-03 (WCAG 3.3.4): Start agent button in the agents
// dialog must expose aria-busy reflecting the pending state, and aria-describedby
// pointing to the visible validation reason when the button is disabled.
describe("NewWindowDialog editor connection evidence", () => {
  async function openEditor(onConfirm = vi.fn()): Promise<void> {
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project()] });
    render(
      <NewWindowDialog type="editor" types={WIN_TYPES} onConfirm={onConfirm} onClose={vi.fn()} />,
    );
    await screen.findByDisplayValue("/repo");
  }

  it("settles a failed submit and does not start a phantom stage on repeated Enter", async () => {
    const records: ClientDiagnosticMeta[] = [];
    let reject: (error: Error) => void = () => undefined;
    vi.mocked(createProject).mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    await openEditor();
    setClientDiagnosticWriter((_message, meta) => {
      if (meta !== undefined) records.push(meta);
    });
    fireEvent.click(screen.getByRole("button", { name: "Open Editor" }));
    fireEvent.keyDown(document, { key: "Enter" });
    await act(async () => {
      reject(new Error("customer detail must not enter evidence"));
    });
    const stages = records.filter(
      (record) => record.stageReport?.stage === "editor project selection",
    );
    expect(stages).toHaveLength(2);
    expect(stages[0]?.stageReport?.phase).toBe("started");
    expect(stages[1]?.stageReport).toMatchObject({ phase: "settled", navigationOutcome: "failed" });
    expect(stages[1]?.correlationId).toBe(stages[0]?.correlationId);
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Open Editor" })).toBeEnabled();
  });

  it("hands a restricted registration to the editor through a closed notice code", async () => {
    const onConfirm = vi.fn();
    vi.mocked(createProject).mockResolvedValueOnce({
      project: { ...project(), workspaceAvailable: true },
      warning: {
        code: "PROJECT_TRUST_GRANT_FAILED",
        message: "Safe failure",
        correlationId: "warning-id",
      },
    });
    await openEditor(onConfirm);
    fireEvent.click(screen.getByRole("button", { name: "Open Editor" }));
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceNoticeCode: "trust-grant-failed",
          workspaceNoticeCorrelationId: "warning-id",
        }),
      ),
    );
    expect(JSON.stringify(onConfirm.mock.calls)).not.toContain("Safe failure");
  });
});

describe("NewWindowDialog native directory browse", () => {
  it.each(["files", "editor"] as const)(
    "pins an explicitly opened %s project to the selected repository",
    async (type) => {
      vi.mocked(fetchProjects).mockResolvedValue({ projects: [project()] });
      const onConfirm = vi.fn();
      render(
        <NewWindowDialog type={type} types={WIN_TYPES} onConfirm={onConfirm} onClose={vi.fn()} />,
      );
      const input = await screen.findByDisplayValue("/repo");
      fireEvent.change(input, { target: { value: "/selected/project" } });
      vi.mocked(createProject).mockResolvedValue({
        project: { ...project(), path: "/selected/project", workspaceAvailable: true },
      });
      fireEvent.click(
        screen.getByRole("button", { name: type === "files" ? "Open Files" : "Open Editor" }),
      );
      await waitFor(() =>
        expect(onConfirm).toHaveBeenCalledWith(
          expect.objectContaining({ root: "/selected/project", rootBinding: "coding-repository" }),
        ),
      );
      if (type === "editor")
        expect(createProject).toHaveBeenCalledWith(
          { path: "/selected/project", selectionIntent: "explicit-folder-selection" },
          expect.any(String),
        );
    },
  );

  it("browses the Files root natively and confirms the picked folder", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchProjects).mockResolvedValue({
      projects: [project(), project("/offline", "Offline", false)],
    });
    vi.mocked(openNativeFileDialog).mockResolvedValueOnce({
      cancelled: false,
      selections: [{ path: "/repo-root", kind: "directory" }],
      rejectedSelectionCount: 0,
      partial: false,
    });
    const onConfirm = vi.fn();

    render(
      <NewWindowDialog type="files" types={WIN_TYPES} onConfirm={onConfirm} onClose={vi.fn()} />,
    );

    const rootInput = await screen.findByDisplayValue("/repo");
    // Clicking the text input must NOT open a dialog: the input is the manual fallback.
    fireEvent.click(rootInput);
    expect(openNativeFileDialog).not.toHaveBeenCalled();

    const browse = screen.getByRole("button", { name: "Browse" });
    await waitFor(() => expect(browse).not.toBeDisabled());
    await user.click(browse);

    await waitFor(() =>
      expect(openNativeFileDialog).toHaveBeenCalledWith({
        mode: "open-directory",
        title: "Select folder",
        defaultPath: "/repo",
      }),
    );
    await waitFor(() => expect(rootInput).toHaveValue("/repo-root"));

    fireEvent.click(screen.getByRole("button", { name: "Open Files" }));
    expect(onConfirm).toHaveBeenCalledWith({
      root: "/repo-root",
      rootBinding: "coding-repository",
    });
  });

  it("treats native cancellation as a non-event", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project()] });
    vi.mocked(openNativeFileDialog).mockResolvedValueOnce({
      cancelled: true,
      selections: [],
      rejectedSelectionCount: 0,
      partial: false,
    });

    render(
      <NewWindowDialog type="files" types={WIN_TYPES} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );

    const rootInput = await screen.findByDisplayValue("/repo");
    const browse = screen.getByRole("button", { name: "Browse" });
    await waitFor(() => expect(browse).not.toBeDisabled());
    await user.click(browse);

    await waitFor(() => expect(openNativeFileDialog).toHaveBeenCalled());
    expect(rootInput).toHaveValue("/repo");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfaces a calm message when another native dialog is already open", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project()] });
    vi.mocked(openNativeFileDialog).mockRejectedValueOnce(
      new ApiError("NATIVE_DIALOG_ALREADY_OPEN", "busy", 409),
    );

    render(
      <NewWindowDialog type="files" types={WIN_TYPES} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );

    await screen.findByDisplayValue("/repo");
    const browse = screen.getByRole("button", { name: "Browse" });
    await waitFor(() => expect(browse).not.toBeDisabled());
    await user.click(browse);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A native dialog is already open. Close it first.",
    );
  });
});

describe("NewWindowDialog dialog controls and Files defaults", () => {
  it("prefills the first available Files project without using offline roots", async () => {
    vi.mocked(fetchProjects).mockResolvedValue({
      projects: [project("/offline", "Offline", false), project()],
    });

    render(
      <NewWindowDialog type="files" types={WIN_TYPES} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );

    expect(await screen.findByDisplayValue("/repo")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("/offline")).not.toBeInTheDocument();
  });

  it("does not prefill a Files project the read surface refuses (#4371)", async () => {
    vi.mocked(fetchProjects).mockResolvedValue({
      projects: [{ ...project("/refused", "Refused"), readable: false }, project()],
    });

    render(
      <NewWindowDialog type="files" types={WIN_TYPES} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );

    expect(await screen.findByDisplayValue("/repo")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("/refused")).not.toBeInTheDocument();
  });

  it("does not overwrite a manually entered Files root when project loading resolves later", async () => {
    let resolveProjects: ((value: Awaited<ReturnType<typeof fetchProjects>>) => void) | undefined;
    vi.mocked(fetchProjects).mockReturnValue(
      new Promise((resolve) => {
        resolveProjects = resolve;
      }),
    );

    render(
      <NewWindowDialog type="files" types={WIN_TYPES} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );

    const rootInput = screen.getByPlaceholderText("Folder");
    fireEvent.change(rootInput, { target: { value: "/manual" } });
    resolveProjects?.({ projects: [project()] });

    await waitFor(() => expect(rootInput).toHaveValue("/manual"));
  });

  it("surfaces project-loading errors in the Files dialog", async () => {
    vi.mocked(fetchProjects).mockRejectedValue(new Error("project index unavailable"));

    render(
      <NewWindowDialog type="files" types={WIN_TYPES} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("project index unavailable");
  });

  it("submits a one-field dialog with plain Enter from the input", () => {
    const onConfirm = vi.fn();
    render(
      <NewWindowDialog type="chat" types={WIN_TYPES} onConfirm={onConfirm} onClose={vi.fn()} />,
    );

    const titleInput = screen.getByPlaceholderText("Name this conversation");
    fireEvent.change(titleInput, { target: { value: "Release grounding review" } });
    fireEvent.keyDown(titleInput, { key: "Enter" });

    expect(onConfirm).toHaveBeenCalledWith({ title: "Release grounding review" });
  });

  it("supports global Escape and traps Tab inside the modal buttons", () => {
    const onClose = vi.fn();
    render(<NewWindowDialog type="chat" types={WIN_TYPES} onConfirm={vi.fn()} onClose={onClose} />);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    const dialog = screen.getByRole("dialog");
    const closeButton = within(dialog).getAllByRole("button", {
      name: "Cancel",
    })[0] as HTMLButtonElement;
    const openButton = within(dialog).getByRole("button", { name: "Open Chat" });

    closeButton.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(openButton);

    openButton.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton);
  });
});

// ─── 0.3.0 release audit — the chat window's untitled default must never be load-bearing copy ────
// The dialog seeds the title field with the LOCALIZED default. Before this fix that localized
// string was submitted as the window title, so (a) the workspace sentinel that asks "is this chat
// still untitled" compared it against the English literal "New chat" and missed under `de`, and
// (b) the localized string was persisted as the chat record's title, which permanently disabled
// the server's first-turn auto-title (it keys on the canonical stored default).
//
// Every expectation below is derived from the production catalog and the production consumer —
// nothing restates a default title as a test literal.
describe("NewWindowDialog chat title (0.3.0 audit: locale-independent untitled marker)", () => {
  afterEach(() => {
    window.localStorage.removeItem(I18N_STORAGE_KEY);
  });

  async function renderGermanChatDialog(onConfirm: (cfg: Cfg) => void): Promise<void> {
    await loadLocaleMessages("de");
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    render(
      <I18nProvider>
        <NewWindowDialog type="chat" types={WIN_TYPES} onConfirm={onConfirm} onClose={vi.fn()} />
      </I18nProvider>,
    );
    await screen.findByDisplayValue(DE_MESSAGES["window.default.chatTitle"]);
  }

  function confirmedCfg(onConfirm: ReturnType<typeof vi.fn>): Record<string, unknown> {
    expect(onConfirm).toHaveBeenCalledTimes(1);
    return onConfirm.mock.calls[0]?.[0] as Record<string, unknown>;
  }

  it("marks an accepted German default as untitled instead of shipping it as a title", async () => {
    const onConfirm = vi.fn();
    await renderGermanChatDialog(onConfirm);

    fireEvent.click(
      screen.getByRole("button", {
        name: DE_MESSAGES["newWindow.open"].replace(
          "{label}",
          DE_MESSAGES["window.type.chat.title"],
        ),
      }),
    );

    const cfg = confirmedCfg(onConfirm);
    // The consumer decides on the structural marker, not on the display string.
    expect(subText("chat", cfg)).toBeNull();
    // The localized default is never persisted as data, so the server's canonical default (and
    // with it the first-turn auto-title) still applies to a German-locale chat.
    expect(cfg["title"]).toBeUndefined();
  });

  it("keeps an operator-chosen German title as a real title", async () => {
    const onConfirm = vi.fn();
    await renderGermanChatDialog(onConfirm);

    const input = screen.getByDisplayValue(DE_MESSAGES["window.default.chatTitle"]);
    fireEvent.change(input, { target: { value: "Freigabeprüfung" } });
    fireEvent.click(
      screen.getByRole("button", {
        name: DE_MESSAGES["newWindow.open"].replace(
          "{label}",
          DE_MESSAGES["window.type.chat.title"],
        ),
      }),
    );

    const cfg = confirmedCfg(onConfirm);
    expect(cfg["title"]).toBe("Freigabeprüfung");
    expect(subText("chat", cfg)).toBe("Freigabeprüfung");
  });

  it("selects the prefilled default so typing replaces it instead of appending (#4335)", async () => {
    const onConfirm = vi.fn();
    render(
      <NewWindowDialog type="chat" types={WIN_TYPES} onConfirm={onConfirm} onClose={vi.fn()} />,
    );
    const input = screen.getByDisplayValue(EN_MESSAGES["window.default.chatTitle"]);
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveProperty("selectionStart", 0);
    expect(input).toHaveProperty("selectionEnd", input.getAttribute("value")?.length);
    await userEvent.setup().keyboard("Online-Banking-App");
    expect(input).toHaveValue("Online-Banking-App");
  });

  it("treats an accepted English default exactly the same way", () => {
    const onConfirm = vi.fn();
    render(
      <NewWindowDialog type="chat" types={WIN_TYPES} onConfirm={onConfirm} onClose={vi.fn()} />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: EN_MESSAGES["newWindow.open"].replace(
          "{label}",
          EN_MESSAGES["window.type.chat.title"],
        ),
      }),
    );

    const cfg = confirmedCfg(onConfirm);
    expect(subText("chat", cfg)).toBeNull();
    expect(cfg["title"]).toBeUndefined();
  });

  it("treats a blank title as untitled rather than as an empty operator title", async () => {
    const onConfirm = vi.fn();
    await renderGermanChatDialog(onConfirm);

    const input = screen.getByDisplayValue(DE_MESSAGES["window.default.chatTitle"]);
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(
      screen.getByRole("button", {
        name: DE_MESSAGES["newWindow.open"].replace(
          "{label}",
          DE_MESSAGES["window.type.chat.title"],
        ),
      }),
    );

    const cfg = confirmedCfg(onConfirm);
    expect(subText("chat", cfg)).toBeNull();
    expect(cfg["title"]).toBeUndefined();
  });
});
