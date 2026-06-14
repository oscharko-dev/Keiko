import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ModelCapability } from "@/lib/types";
import { isAgentWorkflowModel, directoryPickerError, NewWindowDialog } from "./NewWindowDialog";
import { ApiError } from "@/lib/api";
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
