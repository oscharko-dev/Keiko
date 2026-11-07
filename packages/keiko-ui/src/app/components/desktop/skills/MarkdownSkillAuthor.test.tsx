import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptEnhancementWireResponse } from "@oscharko-dev/keiko-contracts";
import { enhancePrompt } from "@/lib/api";
import { MarkdownSkillAuthor } from "./MarkdownSkillAuthor";

vi.mock("@/lib/api", () => ({ enhancePrompt: vi.fn() }));
vi.mock("@/lib/coding-app-session-client", () => ({
  codingAppSessionPairingSettled: (): Promise<void> => Promise.resolve(),
}));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));
const DRAFT = "# Garden review\nReview sensor boundaries and unresolved decisions.";
const RESULT = {
  outputKind: "markdown-skill",
  renderedPrompt: DRAFT,
  modelRouting: { executionStatus: "model-applied" },
} as PromptEnhancementWireResponse;
const onDraft = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(enhancePrompt).mockResolvedValue(RESULT);
});
afterEach(cleanup);

function deferredModelResponse(): { resolve: (value: PromptEnhancementWireResponse) => void } {
  const handle = { resolve: (_value: PromptEnhancementWireResponse): void => undefined };
  vi.mocked(enhancePrompt).mockImplementation(
    () =>
      new Promise((done) => {
        handle.resolve = done;
      }),
  );
  return handle;
}

async function generate(): Promise<void> {
  fireEvent.change(screen.getByLabelText("Source text"), {
    target: { value: "Complete concept." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Prepare draft" }));
  await waitFor(() => expect(enhancePrompt).toHaveBeenCalled());
}

describe("document-to-skill authoring", () => {
  it("uses the selected model and hands the draft to the editor once, saving nothing itself", async () => {
    const view = render(<MarkdownSkillAuthor modelId="test-model" onDraft={onDraft} />);
    await generate();
    await waitFor(() => expect(onDraft).toHaveBeenCalledWith(DRAFT));
    expect(enhancePrompt).toHaveBeenCalledWith(
      {
        text: "Complete concept.",
        modelId: "test-model",
        outputKind: "markdown-skill",
        candidateCount: 1,
      },
      expect.any(AbortSignal),
    );
    view.rerender(<MarkdownSkillAuthor modelId="test-model" onDraft={onDraft} />);
    expect(onDraft).toHaveBeenCalledOnce();
    // The review and the save moved to the editor: this form no longer shows the draft.
    expect(screen.queryByLabelText("Skill draft (Markdown)")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save reviewed skill" })).toBeNull();
  });

  it("hands an identical draft from a later generation to the editor again", async () => {
    render(<MarkdownSkillAuthor modelId="test-model" onDraft={onDraft} />);
    await generate();
    await waitFor(() => expect(onDraft).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Prepare draft" }));
    await waitFor(() => expect(onDraft).toHaveBeenCalledTimes(2));
    expect(onDraft).toHaveBeenLastCalledWith(DRAFT);
  });

  it("cancels and discards a late model response", async () => {
    const response = deferredModelResponse();
    render(<MarkdownSkillAuthor modelId="test-model" onDraft={onDraft} />);
    await generate();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(vi.mocked(enhancePrompt).mock.calls[0]?.[1]?.aborted).toBe(true);
    await act(async () => {
      response.resolve(RESULT);
    });
    expect(onDraft).not.toHaveBeenCalled();
  });

  it("aborts when the form goes away and discards a late completed draft", async () => {
    const response = deferredModelResponse();
    const view = render(<MarkdownSkillAuthor modelId="test-model" onDraft={onDraft} />);
    await generate();
    view.unmount();
    expect(vi.mocked(enhancePrompt).mock.calls[0]?.[1]?.aborted).toBe(true);
    await act(async () => {
      response.resolve(RESULT);
    });
    expect(onDraft).not.toHaveBeenCalled();
  });

  it("does not accept fallback output and retains the source for retry", async () => {
    vi.mocked(enhancePrompt).mockResolvedValue({
      ...RESULT,
      outputKind: undefined,
    } as unknown as PromptEnhancementWireResponse);
    render(<MarkdownSkillAuthor modelId="test-model" onDraft={onDraft} />);
    await generate();
    expect(await screen.findByRole("alert")).toHaveTextContent("No complete skill draft");
    expect(screen.getByLabelText("Source text")).toHaveValue("Complete concept.");
    expect(onDraft).not.toHaveBeenCalled();
  });

  it("requires a model and rejects oversized sources before calling the gateway", async () => {
    const view = render(<MarkdownSkillAuthor modelId={undefined} onDraft={onDraft} />);
    expect(screen.getByRole("button", { name: "Prepare draft" })).toBeDisabled();
    view.rerender(<MarkdownSkillAuthor modelId="test-model" onDraft={onDraft} />);
    fireEvent.change(screen.getByLabelText("Source text"), {
      target: { value: "x".repeat(100001) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare draft" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("100,000");
    expect(enhancePrompt).not.toHaveBeenCalled();
    expect(onDraft).not.toHaveBeenCalled();
  });
});

it.each([new Uint8Array([0xff]), new Uint8Array()])(
  "refuses invalid or empty UTF-8 files",
  async (bytes) => {
    render(<MarkdownSkillAuthor modelId="test-model" onDraft={onDraft} />);
    const file = new File(["synthetic"], "concept.txt");
    Object.defineProperty(file, "arrayBuffer", {
      value: (): Promise<ArrayBufferLike> => Promise.resolve(bytes.buffer),
    });
    fireEvent.change(screen.getByLabelText("Source file (.md or .txt)"), {
      target: { files: [file] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("UTF-8");
    expect(enhancePrompt).not.toHaveBeenCalled();
    expect(onDraft).not.toHaveBeenCalled();
  },
);
