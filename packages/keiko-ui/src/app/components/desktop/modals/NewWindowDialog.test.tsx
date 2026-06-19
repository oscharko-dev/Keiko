import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelCapability } from "@/lib/types";
import { isAgentWorkflowModel, directoryPickerError, NewWindowDialog } from "./NewWindowDialog";
import {
  ApiError,
  createProject,
  fetchFilesDirectories,
  fetchModels,
  fetchProjects,
  startRun,
} from "@/lib/api";
import { WIN_TYPES } from "../windows/WindowsRegistry";

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
  fetchModels: vi.fn(async () => ({ models: [] })),
  fetchProjects: vi.fn(async () => ({ projects: [] })),
  startRun: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  fetchFilesDirectories: vi.fn(async () => ({ entries: [] })),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function model(patch: Partial<ModelCapability>): ModelCapability {
  return {
    id: "test-model",
    kind: "chat",
    contextWindow: 1,
    maxOutputTokens: 1,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test",
    preferredUseCases: [],
    knownLimitations: [],
    ...patch,
  };
}

function project(path = "/repo", name = "Repo", available = true) {
  return { path, name, favorite: false, createdAt: 1, lastOpenedAt: 2, available };
}

function mockAgentDependencies(): void {
  vi.mocked(fetchModels).mockResolvedValue({
    models: [model({ id: "example-chat-model" })],
  });
  vi.mocked(fetchProjects).mockResolvedValue({
    projects: [project()],
  });
  vi.mocked(startRun).mockResolvedValue({ runId: "run 1", fingerprint: "fp 1" });
}

async function chooseComboboxOption(
  user: ReturnType<typeof userEvent.setup>,
  trigger: HTMLElement,
  optionName: string,
): Promise<void> {
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: optionName }));
}

async function renderAgentDialog(
  onConfirm = vi.fn(),
  filesContext: { readonly id: string; readonly root: string; readonly activeFilePath?: string } = {
    id: "files-1",
    root: "/repo",
    activeFilePath: "/repo/src/app.ts",
  },
): Promise<typeof onConfirm> {
  mockAgentDependencies();
  render(
    <NewWindowDialog
      type="agents"
      types={WIN_TYPES}
      filesContext={filesContext}
      onConfirm={onConfirm}
      onClose={vi.fn()}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /start agent/i })).not.toHaveAttribute("disabled"),
  );
  return onConfirm;
}

describe("isAgentWorkflowModel", () => {
  it("allows only chat models with tool calling and structured output", () => {
    expect(isAgentWorkflowModel(model({ id: "example-chat-model" }))).toBe(true);
    expect(
      isAgentWorkflowModel(
        model({ id: "example-chat-model-unstructured", structuredOutput: false }),
      ),
    ).toBe(false);
    expect(isAgentWorkflowModel(model({ id: "basic-chat", toolCalling: false }))).toBe(false);
    expect(isAgentWorkflowModel(model({ id: "embedding", kind: "embedding" }))).toBe(false);
    expect(isAgentWorkflowModel(model({ id: "example-vision-model", kind: "ocr-vision" }))).toBe(
      false,
    );
  });
});

describe("chat window config", () => {
  it("does not expose a dead model field in the new-window dialog", () => {
    expect(WIN_TYPES.chat.config?.some((field) => field.key === "model")).toBe(false);
  });
});

// GAP-C3 (#146): the "Keiko-Mode coming soon" disabled toggle must not render
describe("NewWindowDialog: no Keiko-Mode coming-soon toggle (#146 GAP-C3)", () => {
  it("does not render 'coming soon' text in the agents dialog", () => {
    render(
      <NewWindowDialog type="agents" types={WIN_TYPES} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });
});

// MD-05 (WCAG 2.4.3): focus-restoration fallback must always reach a focusable
// target — document.body is the guaranteed last resort when neither the top
// window nor the FAB is present in the DOM.
describe("NewWindowDialog: focus-restoration guaranteed fallback (MD-05)", () => {
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
});

// FE-05 (WCAG 4.1.2) + FE-03 (WCAG 3.3.4): Start agent button in the agents
// dialog must expose aria-busy reflecting the pending state, and aria-describedby
// pointing to the visible validation reason when the button is disabled.
describe("NewWindowDialog agents: Start agent a11y attributes (FE-05/FE-03)", () => {
  it("Start agent button has aria-busy=false when not submitting", () => {
    render(
      <NewWindowDialog type="agents" types={WIN_TYPES} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    const btn = screen.getByRole("button", { name: /start agent/i });
    // Not yet submitting — aria-busy must be false, not absent.
    expect(btn).toHaveAttribute("aria-busy", "false");
  });

  it("Start agent button has aria-describedby pointing to the validation status span when disabled", () => {
    render(
      <NewWindowDialog type="agents" types={WIN_TYPES} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    const btn = screen.getByRole("button", { name: /start agent/i });
    // Button is disabled (models still loading) — aria-describedby must point at
    // the validation/loading span so AT users know why it cannot be activated (FE-03).
    expect(btn).toHaveAttribute("aria-describedby", "agent-start-validation");
    const desc = document.getElementById("agent-start-validation");
    expect(desc).not.toBeNull();
    expect(desc?.getAttribute("role")).toBe("status");
  });
});

describe("NewWindowDialog agents: start-run contract", () => {
  it("starts a verify run with the connected Files window context and persists the window cfg", async () => {
    const onConfirm = await renderAgentDialog();

    const startButton = screen.getByRole("button", { name: /start agent/i });
    fireEvent.click(startButton);

    await waitFor(() =>
      expect(startRun).toHaveBeenCalledWith({
        taskType: "verify",
        modelId: "example-chat-model",
        input: { workspaceRoot: "/repo", targetFiles: ["src/app.ts"] },
      }),
    );
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: "verify",
        model: "example-chat-model",
        runId: "run 1",
        fingerprint: "fp 1",
        workspaceRoot: "/repo",
        inputJson: JSON.stringify({ workspaceRoot: "/repo", targetFiles: ["src/app.ts"] }),
        __connectFilesId: "files-1",
      }),
    );
  });

  it("starts explain-plan with a normalized file path and optional question", async () => {
    const user = userEvent.setup();
    await renderAgentDialog();

    await chooseComboboxOption(user, screen.getByRole("combobox", { name: "Workflow" }), "Explain plan");
    fireEvent.change(screen.getByPlaceholderText("What should the plan focus on?"), {
      target: { value: "Focus on RAG quality." },
    });
    fireEvent.click(screen.getByRole("button", { name: /start agent/i }));

    await waitFor(() =>
      expect(startRun).toHaveBeenCalledWith({
        taskType: "explain-plan",
        modelId: "example-chat-model",
        input: {
          workspaceRoot: "/repo",
          filePath: "src/app.ts",
          question: "Focus on RAG quality.",
        },
      }),
    );
  });

  it("starts unit-test-generation for changed files after normalizing mixed path input", async () => {
    const user = userEvent.setup();
    await renderAgentDialog();

    await chooseComboboxOption(
      user,
      screen.getByRole("combobox", { name: "Workflow" }),
      "Generate unit tests",
    );
    await chooseComboboxOption(
      user,
      screen.getByRole("combobox", { name: "Target" }),
      "Changed files",
    );
    const changedFiles = screen.getByPlaceholderText("src/file.ts, src/other.ts");
    fireEvent.change(changedFiles, {
      target: { value: "/repo/src/app.ts, src/other.ts" },
    });
    fireEvent.blur(changedFiles);
    fireEvent.click(screen.getByRole("button", { name: /start agent/i }));

    await waitFor(() =>
      expect(startRun).toHaveBeenCalledWith({
        workflowId: "unit-test-generation",
        modelId: "example-chat-model",
        input: {
          workspaceRoot: "/repo",
          target: { kind: "changedFiles", filePaths: ["src/app.ts", "src/other.ts"] },
        },
      }),
    );
  });

  it("keeps bug-investigation disabled until evidence exists and then starts with the full report", async () => {
    const user = userEvent.setup();
    await renderAgentDialog(vi.fn(), { id: "files-1", root: "/repo" });

    await chooseComboboxOption(
      user,
      screen.getByRole("combobox", { name: "Workflow" }),
      "Investigate bug",
    );
    expect(screen.getByText(/Bug investigation requires description/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start agent/i })).toHaveAttribute("disabled");

    fireEvent.change(screen.getByPlaceholderText("Describe the observed bug."), {
      target: { value: "Answer ignores the attached PDF." },
    });
    const textareas = screen
      .getAllByRole("textbox")
      .filter((element): element is HTMLTextAreaElement => element instanceof HTMLTextAreaElement);
    fireEvent.change(textareas[1] as HTMLTextAreaElement, {
      target: { value: "expected citation missing" },
    });
    fireEvent.change(textareas[2] as HTMLTextAreaElement, {
      target: { value: "GroundingError: missing evidence" },
    });
    fireEvent.change(screen.getByPlaceholderText("src/file.ts, src/other.ts"), {
      target: { value: "/repo/src/rag.ts" },
    });
    fireEvent.click(screen.getByRole("button", { name: /start agent/i }));

    await waitFor(() =>
      expect(startRun).toHaveBeenCalledWith({
        workflowId: "bug-investigation",
        modelId: "example-chat-model",
        input: {
          workspaceRoot: "/repo",
          report: {
            description: "Answer ignores the attached PDF.",
            failingOutput: "expected citation missing",
            stackTrace: "GroundingError: missing evidence",
            targetFiles: ["src/rag.ts"],
          },
        },
      }),
    );
  });

  it("registers an unavailable workspace before starting a run", async () => {
    vi.mocked(fetchModels).mockResolvedValue({
      models: [model({ id: "example-chat-model" })],
    });
    vi.mocked(fetchProjects)
      .mockResolvedValueOnce({ projects: [] })
      .mockResolvedValueOnce({
        projects: [project("/external", "External")],
      });
    vi.mocked(createProject).mockResolvedValue({
      project: project("/external", "External"),
    });
    vi.mocked(startRun).mockResolvedValue({ runId: "run 2", fingerprint: "fp 2" });
    const onConfirm = vi.fn();

    render(
      <NewWindowDialog
        type="agents"
        types={WIN_TYPES}
        filesContext={null}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => screen.getByText("Workspace is required."));
    fireEvent.change(screen.getByPlaceholderText("/absolute/project/path"), {
      target: { value: "/external" },
    });

    await waitFor(() => screen.getByText("Workspace is not registered."));
    fireEvent.click(screen.getByRole("button", { name: "Register workspace" }));

    await waitFor(() => expect(createProject).toHaveBeenCalledWith({ path: "/external" }));
    await waitFor(() =>
      expect(screen.queryByText("Workspace is not registered.")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /start agent/i }));

    await waitFor(() =>
      expect(startRun).toHaveBeenCalledWith({
        taskType: "verify",
        modelId: "example-chat-model",
        input: { workspaceRoot: "/external" },
      }),
    );
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: "/external", runId: "run 2" }),
    );
  });

  it("refreshes project registration and surfaces a guarded message when start rejects an unregistered workspace", async () => {
    mockAgentDependencies();
    vi.mocked(fetchProjects).mockResolvedValueOnce({
      projects: [project()],
    });
    vi.mocked(startRun).mockRejectedValue(new ApiError("WORKSPACE_NOT_REGISTERED", "/repo", 409));
    const onConfirm = vi.fn();

    render(
      <NewWindowDialog
        type="agents"
        types={WIN_TYPES}
        filesContext={{ id: "files-1", root: "/repo", activeFilePath: "/repo/src/app.ts" }}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /start agent/i })).not.toHaveAttribute("disabled"),
    );
    fireEvent.click(screen.getByRole("button", { name: /start agent/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Workspace is not registered."),
    );
    expect(fetchProjects).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("NewWindowDialog directory picker", () => {
  it("loads registered projects for Files windows and selects a browsed root", async () => {
    vi.mocked(fetchProjects).mockResolvedValue({
      projects: [
        project(),
        project("/offline", "Offline", false),
      ],
    });
    vi.mocked(fetchFilesDirectories).mockResolvedValueOnce({
      path: "/repo",
      parent: "/Users",
      roots: [{ label: "Workspace", path: "/repo-root" }],
      entries: [{ name: "src", path: "/repo/src" }],
    });
    const onConfirm = vi.fn();

    render(
      <NewWindowDialog type="files" types={WIN_TYPES} onConfirm={onConfirm} onClose={vi.fn()} />,
    );

    const rootInput = await screen.findByDisplayValue("/repo");
    fireEvent.click(rootInput);

    const picker = await screen.findByRole("group", { name: "Directory picker" });
    expect(fetchFilesDirectories).toHaveBeenCalledWith("/repo", "/repo");
    expect(within(picker).getByText("Parent directory")).toBeInTheDocument();
    expect(within(picker).getByText("src")).toBeInTheDocument();

    fireEvent.click(within(picker).getByRole("button", { name: "Use directory" }));
    expect(rootInput).toHaveValue("/repo-root");

    fireEvent.click(screen.getByRole("button", { name: "Open Files" }));
    expect(onConfirm).toHaveBeenCalledWith({ root: "/repo-root" });
  });

  it("keeps Enter local to the directory picker and shows mapped browse errors", async () => {
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [] });
    vi.mocked(fetchFilesDirectories)
      .mockRejectedValueOnce(new ApiError("BAD_ROOT", "relative", 400))
      .mockResolvedValueOnce({ path: "/tmp", parent: null, roots: [], entries: [] });
    const onConfirm = vi.fn();

    render(
      <NewWindowDialog type="files" types={WIN_TYPES} onConfirm={onConfirm} onClose={vi.fn()} />,
    );

    const rootInput = screen.getByPlaceholderText("Folder");
    fireEvent.change(rootInput, { target: { value: "/tmp" } });
    fireEvent.click(rootInput);

    const picker = await screen.findByRole("group", { name: "Directory picker" });
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter an absolute folder path.");

    const pickerInput = within(picker).getByLabelText("Folder path");
    fireEvent.change(pickerInput, { target: { value: "/tmp" } });
    fireEvent.keyDown(pickerInput, { key: "Enter" });

    await waitFor(() => expect(fetchFilesDirectories).toHaveBeenLastCalledWith("/tmp", "/tmp"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(within(picker).getByText("No child directories.")).toBeInTheDocument();
  });
});

describe("NewWindowDialog dialog controls and Files defaults", () => {
  it("prefills the first available Files project without using offline roots", async () => {
    vi.mocked(fetchProjects).mockResolvedValue({
      projects: [
        project("/offline", "Offline", false),
        project(),
      ],
    });

    render(
      <NewWindowDialog type="files" types={WIN_TYPES} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );

    expect(await screen.findByDisplayValue("/repo")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("/offline")).not.toBeInTheDocument();
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
    render(
      <NewWindowDialog type="chat" types={WIN_TYPES} onConfirm={vi.fn()} onClose={onClose} />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    const dialog = screen.getByRole("dialog");
    const closeButton = within(dialog).getAllByRole("button", { name: "Cancel" })[0] as HTMLButtonElement;
    const openButton = within(dialog).getByRole("button", { name: "Open Chat" });

    closeButton.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(openButton);

    openButton.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton);
  });
});

// M2 (#532) — arbitrary-folder browse error mapping
describe("directoryPickerError", () => {
  it("returns an absolute-path prompt for a 400 BAD_ROOT error", () => {
    const err = new ApiError("BAD_ROOT", "relative path", 400);
    expect(directoryPickerError(err)).toBe("Enter an absolute folder path.");
  });

  it("returns an exclusion message for a 403 DENIED error", () => {
    const err = new ApiError("DENIED", "excluded", 403);
    expect(directoryPickerError(err)).toBe("That location is excluded.");
  });

  it("passes through the raw message for other ApiErrors", () => {
    const err = new ApiError("INTERNAL_ERROR", "something went wrong", 500);
    expect(directoryPickerError(err)).toBe("something went wrong");
  });

  it("passes through the message for plain Error objects", () => {
    expect(directoryPickerError(new Error("network timeout"))).toBe("network timeout");
  });

  it("returns a generic fallback for non-Error values", () => {
    expect(directoryPickerError("string error")).toBe("Unable to read directories.");
    expect(directoryPickerError(null)).toBe("Unable to read directories.");
  });
});
