import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCapability } from "@/lib/types";
import { isAgentWorkflowModel, NewWindowDialog, resolveFieldValue } from "./NewWindowDialog";
import {
  ApiError,
  createProject,
  fetchModels,
  fetchNativeFileDialogCapability,
  fetchProjects,
  openNativeFileDialog,
  startRun,
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
  fetchModels: vi.fn(async () => ({ models: [] })),
  fetchProjects: vi.fn(async () => ({ projects: [] })),
  startRun: vi.fn(),
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
  vi.mocked(startRun).mockResolvedValue({
    runId: "run 1",
    fingerprint: "fp 1",
    governance: {
      requestedMode: "governed-assist",
      effectiveMode: "governed-assist",
      deploymentCeiling: "governed-assist",
      connectorExecution: "unavailable",
      deliveryExecution: "unavailable",
    },
  });
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
  filesContext: {
    readonly id: string;
    readonly root: string;
    readonly activeFilePath?: string;
  } | null = {
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
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent("example-chat-model"),
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
describe("NewWindowDialog agents: Start agent a11y attributes (FE-05/FE-03)", () => {
  it("Start agent button has aria-busy=false when not submitting", () => {
    render(
      <NewWindowDialog type="agents" types={WIN_TYPES} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    const btn = screen.getByRole("button", { name: /start .*agent/i });
    // Not yet submitting — aria-busy must be false, not absent.
    expect(btn).toHaveAttribute("aria-busy", "false");
  });

  it("Start agent button has aria-describedby pointing to the validation status output when disabled", () => {
    render(
      <NewWindowDialog type="agents" types={WIN_TYPES} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    const btn = screen.getByRole("button", { name: /start .*agent/i });
    // Button is disabled (models still loading) — aria-describedby must point at
    // the validation/loading live region so AT users know why it cannot be
    // activated (FE-03). That region is an <output>, the element that owns
    // role=status (S6819), so the role is implicit — assert the computed role
    // and the element, not a literal role attribute.
    expect(btn).toHaveAttribute("aria-describedby", "agent-start-validation");
    const desc = document.getElementById("agent-start-validation");
    expect(desc).not.toBeNull();
    expect(desc).toHaveRole("status");
    expect(desc?.tagName).toBe("OUTPUT");
  });
});

describe("NewWindowDialog agents: start-run contract", () => {
  it("starts the Unit Test Agent with the connected Files window context and persists the window cfg", async () => {
    const onConfirm = await renderAgentDialog();

    const startButton = screen.getByRole("button", { name: "Start Unit Test Agent" });
    fireEvent.click(startButton);

    await waitFor(() =>
      expect(startRun).toHaveBeenCalledWith({
        workflowId: "unit-test-generation",
        modelId: "example-chat-model",
        requestedMode: "governed-assist",
        input: {
          workspaceRoot: "/repo",
          target: { kind: "file", filePath: "src/app.ts" },
        },
      }),
    );
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: "unit-test-generation",
        model: "example-chat-model",
        runId: "run 1",
        fingerprint: "fp 1",
        workspaceRoot: "/repo",
        inputJson: JSON.stringify({
          workspaceRoot: "/repo",
          target: { kind: "file", filePath: "src/app.ts" },
        }),
        __connectFilesId: "files-1",
      }),
    );
  });

  it("normalizes the active file against a workspace root with trailing slashes", async () => {
    mockAgentDependencies();
    vi.mocked(fetchProjects).mockResolvedValue({
      projects: [project("/repo///")],
    });
    render(
      <NewWindowDialog
        type="agents"
        types={WIN_TYPES}
        filesContext={{
          id: "files-1",
          root: "/repo///",
          activeFilePath: "/repo/src/app.ts",
        }}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
        "example-chat-model",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Start Unit Test Agent" }));

    await waitFor(() =>
      expect(startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            workspaceRoot: "/repo///",
            target: { kind: "file", filePath: "src/app.ts" },
          },
        }),
      ),
    );
  });

  it("offers the production agents without exposing task utilities as agent choices", async () => {
    const user = userEvent.setup();
    await renderAgentDialog();

    await user.click(screen.getByRole("combobox", { name: "Agent" }));

    expect(await screen.findByRole("option", { name: "Unit Test Agent" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Bugfix Agent" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Verify" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Explain plan" })).toBeNull();
  });

  it("selects all three autonomy modes and keeps the server-clamped posture in the window config", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    await renderAgentDialog(onConfirm);
    vi.mocked(startRun).mockResolvedValueOnce({
      runId: "run-1",
      fingerprint: "fp-1",
      governance: {
        requestedMode: "autonomous-delivery",
        effectiveMode: "supervised-coding",
        deploymentCeiling: "supervised-coding",
        connectorExecution: "unavailable",
        deliveryExecution: "unavailable",
      },
    });

    expect(screen.getByRole("radio", { name: /Ask for approval/u })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Supervised workspace/u })).toBeEnabled();
    await user.click(screen.getByRole("radio", { name: /Full access/u }));
    await user.click(screen.getByRole("button", { name: "Start Unit Test Agent" }));

    await waitFor(() =>
      expect(startRun).toHaveBeenCalledWith(
        expect.objectContaining({ requestedMode: "autonomous-delivery" }),
      ),
    );
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedMode: "autonomous-delivery",
        effectiveMode: "supervised-coding",
        deploymentCeiling: "supervised-coding",
        connectorExecution: "unavailable",
        deliveryExecution: "unavailable",
      }),
    );
  });

  it("fails closed when the server omits the governed Authority projection", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    await renderAgentDialog(onConfirm);
    vi.mocked(startRun).mockResolvedValueOnce({ runId: "run-1", fingerprint: "fp-1" });

    await user.click(screen.getByRole("button", { name: "Start Unit Test Agent" }));

    expect(
      await screen.findByText(
        "The server did not confirm an Authority Envelope. The agent run was not opened.",
      ),
    ).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("starts unit-test-generation for one normalized source file", async () => {
    const user = userEvent.setup();
    await renderAgentDialog();

    await chooseComboboxOption(
      user,
      screen.getByRole("combobox", { name: "Agent" }),
      "Unit Test Agent",
    );
    expect(screen.queryByRole("combobox", { name: "Target" })).toBeNull();

    const sourceFile = screen.getByLabelText("Source file");
    fireEvent.change(sourceFile, {
      target: { value: "/repo/src/app.ts" },
    });
    fireEvent.blur(sourceFile);
    fireEvent.click(screen.getByRole("button", { name: "Start Unit Test Agent" }));

    await waitFor(() =>
      expect(startRun).toHaveBeenCalledWith({
        workflowId: "unit-test-generation",
        modelId: "example-chat-model",
        requestedMode: "governed-assist",
        input: {
          workspaceRoot: "/repo",
          target: { kind: "file", filePath: "src/app.ts" },
        },
      }),
    );
  });

  it("picks the unit-test source file natively and normalizes it repo-relative", async () => {
    const user = userEvent.setup();
    await renderAgentDialog(vi.fn(), { id: "files-1", root: "/repo" });
    vi.mocked(openNativeFileDialog).mockResolvedValueOnce({
      cancelled: false,
      selections: [{ path: "/repo/src/app.ts", kind: "file" }],
      rejectedSelectionCount: 0,
      partial: false,
    });

    const sourceBrowse = screen.getByRole("button", { name: "Browse source file" });
    await waitFor(() => expect(sourceBrowse).not.toBeDisabled());
    await user.click(sourceBrowse);

    await waitFor(() =>
      expect(openNativeFileDialog).toHaveBeenCalledWith({
        mode: "open-file",
        title: "Select source file",
        defaultPath: "/repo",
      }),
    );
    await waitFor(() => expect(screen.getByLabelText("Source file")).toHaveValue("src/app.ts"));

    fireEvent.click(screen.getByRole("button", { name: "Start Unit Test Agent" }));
    await waitFor(() =>
      expect(startRun).toHaveBeenCalledWith({
        workflowId: "unit-test-generation",
        modelId: "example-chat-model",
        requestedMode: "governed-assist",
        input: {
          workspaceRoot: "/repo",
          target: { kind: "file", filePath: "src/app.ts" },
        },
      }),
    );
  });

  it("refuses a natively picked source file outside the repository", async () => {
    const user = userEvent.setup();
    await renderAgentDialog(vi.fn(), { id: "files-1", root: "/repo" });
    vi.mocked(openNativeFileDialog).mockResolvedValueOnce({
      cancelled: false,
      selections: [{ path: "/elsewhere/main.ts", kind: "file" }],
      rejectedSelectionCount: 0,
      partial: false,
    });

    const sourceBrowse = screen.getByRole("button", { name: "Browse source file" });
    await waitFor(() => expect(sourceBrowse).not.toBeDisabled());
    await user.click(sourceBrowse);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a file inside the selected repository.",
    );
    expect(screen.getByLabelText("Source file")).toHaveValue("");
  });

  it("keeps Repository Browse disabled on unsupported platforms while manual entry works", async () => {
    vi.mocked(fetchNativeFileDialogCapability).mockResolvedValue({ supported: false });
    vi.mocked(fetchModels).mockResolvedValue({
      models: [model({ id: "example-chat-model" })],
    });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [] });

    render(
      <NewWindowDialog
        type="agents"
        types={WIN_TYPES}
        filesContext={null}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText("Repository is required.")).toBeInTheDocument();
    const repositoryInput = screen.getByPlaceholderText("/absolute/repository/path");
    expect(repositoryInput).not.toHaveAttribute("disabled");
    const repositoryBrowse = screen.getByRole("button", { name: "Browse" });
    expect(repositoryBrowse).toBeDisabled();
    expect(repositoryBrowse).toHaveAttribute("aria-describedby", "agent-repository-browse-help");
    expect(
      screen.getAllByText(
        "Native dialogs are unavailable on this platform. Enter the path manually.",
      ).length,
    ).toBeGreaterThan(0);

    fireEvent.click(repositoryBrowse);

    expect(openNativeFileDialog).not.toHaveBeenCalled();
    fireEvent.change(repositoryInput, { target: { value: "/manual/repo" } });
    expect(repositoryInput).toHaveValue("/manual/repo");
  });

  it("seeds the native repository dialog from the first online registered project", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchModels).mockResolvedValue({
      models: [model({ id: "example-chat-model" })],
    });
    vi.mocked(fetchProjects).mockResolvedValue({
      projects: [project("/offline", "Offline", false), project("/repo", "Repo", true)],
    });
    vi.mocked(openNativeFileDialog).mockResolvedValueOnce({
      cancelled: false,
      selections: [{ path: "/repo/nested", kind: "directory" }],
      rejectedSelectionCount: 0,
      partial: false,
    });

    render(
      <NewWindowDialog
        type="agents"
        types={WIN_TYPES}
        filesContext={null}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const repositoryBrowse = await screen.findByRole("button", { name: "Browse" });
    await waitFor(() => expect(repositoryBrowse).not.toBeDisabled());
    await user.click(repositoryBrowse);

    await waitFor(() =>
      expect(openNativeFileDialog).toHaveBeenCalledWith({
        mode: "open-directory",
        title: "Select repository folder",
        defaultPath: "/repo",
      }),
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText("/absolute/repository/path")).toHaveValue("/repo/nested"),
    );
  });

  it("disables Source file Browse until a repository path exists", async () => {
    const user = userEvent.setup();
    await renderAgentDialog(vi.fn(), null);

    const sourceBrowse = screen.getByRole("button", { name: "Browse source file" });
    expect(sourceBrowse).toBeDisabled();
    expect(sourceBrowse).toHaveAttribute("aria-describedby", "agent-source-file-browse-help");
    expect(
      await screen.findByText("Select a repository before browsing source files."),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("/absolute/repository/path"), {
      target: { value: "/repo" },
    });

    await waitFor(() => expect(sourceBrowse).not.toBeDisabled());
    vi.mocked(openNativeFileDialog).mockResolvedValueOnce({
      cancelled: true,
      selections: [],
      rejectedSelectionCount: 0,
      partial: false,
    });
    await user.click(sourceBrowse);

    await waitFor(() =>
      expect(openNativeFileDialog).toHaveBeenCalledWith({
        mode: "open-file",
        title: "Select source file",
        defaultPath: "/repo",
      }),
    );
  });

  it("renders Bugfix Agent Cancel and Start actions together without the outer footer", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    mockAgentDependencies();

    render(
      <NewWindowDialog
        type="agents"
        types={WIN_TYPES}
        filesContext={{ id: "files-1", root: "/repo" }}
        onConfirm={vi.fn()}
        onClose={onClose}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
        "example-chat-model",
      ),
    );
    await chooseComboboxOption(
      user,
      screen.getByRole("combobox", { name: "Agent" }),
      "Bugfix Agent",
    );

    const startButton = screen.getByRole("button", { name: "Start Bugfix Agent" });
    const actions = startButton.closest(".dlg-agent-actions");
    expect(actions).not.toBeNull();
    expect(
      within(actions as HTMLElement).getByRole("button", { name: "Cancel" }),
    ).toBeInTheDocument();
    expect(document.querySelector(".dlg-foot")).toBeNull();

    await user.click(within(actions as HTMLElement).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps bug-investigation disabled until evidence exists and then starts with the full report", async () => {
    const user = userEvent.setup();
    await renderAgentDialog(vi.fn(), { id: "files-1", root: "/repo" });

    await chooseComboboxOption(
      user,
      screen.getByRole("combobox", { name: "Agent" }),
      "Bugfix Agent",
    );
    expect(screen.getByText(/Bugfix Agent requires an observed behavior/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Bugfix Agent" })).toHaveAttribute("disabled");

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
    fireEvent.click(screen.getByRole("button", { name: "Start Bugfix Agent" }));

    await waitFor(() =>
      expect(startRun).toHaveBeenCalledWith({
        workflowId: "bug-investigation",
        modelId: "example-chat-model",
        requestedMode: "governed-assist",
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

  it("registers an unavailable repository before starting a run", async () => {
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
      warning: {
        code: "PROJECT_TRUST_GRANT_FAILED",
        message: "The project was registered but remains restricted.",
        correlationId: "new-window-trust-correlation",
      },
    });
    vi.mocked(startRun).mockResolvedValue({
      runId: "run 2",
      fingerprint: "fp 2",
      governance: {
        requestedMode: "governed-assist",
        effectiveMode: "governed-assist",
        deploymentCeiling: "governed-assist",
        connectorExecution: "unavailable",
        deliveryExecution: "unavailable",
      },
    });
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

    await screen.findByText("Repository is required.");
    fireEvent.change(screen.getByPlaceholderText("/absolute/repository/path"), {
      target: { value: "/external" },
    });

    await screen.findByText("Repository is not registered.");
    fireEvent.click(screen.getByRole("button", { name: "Register repository" }));

    await waitFor(() => expect(createProject).toHaveBeenCalledWith({ path: "/external" }));
    expect(await screen.findByText(/new-window-trust-correlation/u)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("Repository is not registered.")).not.toBeInTheDocument(),
    );

    fireEvent.change(screen.getByPlaceholderText("src/file.ts"), {
      target: { value: "src/app.ts" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start Unit Test Agent" }));

    await waitFor(() =>
      expect(startRun).toHaveBeenCalledWith({
        workflowId: "unit-test-generation",
        modelId: "example-chat-model",
        requestedMode: "governed-assist",
        input: {
          workspaceRoot: "/external",
          target: { kind: "file", filePath: "src/app.ts" },
        },
      }),
    );
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: "/external", runId: "run 2" }),
    );
  });

  it("refreshes project registration and surfaces a guarded message when start rejects an unregistered repository", async () => {
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
      expect(screen.getByRole("button", { name: "Start Unit Test Agent" })).not.toHaveAttribute(
        "disabled",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start Unit Test Agent" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Repository is not registered."),
    );
    expect(fetchProjects).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("NewWindowDialog native directory browse", () => {
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
    expect(onConfirm).toHaveBeenCalledWith({ root: "/repo-root" });
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
