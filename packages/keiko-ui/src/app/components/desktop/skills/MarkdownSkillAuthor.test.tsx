import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptEnhancementWireResponse } from "@oscharko-dev/keiko-contracts";
import { enhancePrompt } from "@/lib/api";
import { MarkdownSkillAuthor } from "./MarkdownSkillAuthor";
import type { MarkdownSkillLibrary } from "./useMarkdownSkillLibrary";

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
const upload = vi.fn();
const library = { upload, busy: false } as unknown as MarkdownSkillLibrary;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(enhancePrompt).mockResolvedValue(RESULT);
  upload.mockResolvedValue(undefined);
});
afterEach(cleanup);

async function generate(): Promise<void> {
  fireEvent.click(screen.getByText("Create from document or text"));
  fireEvent.change(screen.getByLabelText("Source text"), {
    target: { value: "Complete concept." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Prepare draft" }));
  await waitFor(() => expect(enhancePrompt).toHaveBeenCalled());
}

describe("reviewed document-to-skill authoring", () => {
  it("uses the selected model, permits editing and only saves after explicit review", async () => {
    render(<MarkdownSkillAuthor modelId="test-model" library={library} />);
    await generate();
    const editor = await screen.findByLabelText("Skill draft (Markdown)");
    expect(editor).toHaveValue(DRAFT);
    expect(enhancePrompt).toHaveBeenCalledWith(
      {
        text: "Complete concept.",
        modelId: "test-model",
        outputKind: "markdown-skill",
        candidateCount: 1,
      },
      expect.any(AbortSignal),
    );
    expect(upload).not.toHaveBeenCalled();
    fireEvent.change(editor, { target: { value: `${DRAFT}\nReviewed.` } });
    fireEvent.click(screen.getByRole("button", { name: "Save reviewed skill" }));
    expect(upload).toHaveBeenCalledWith(expect.any(File));
  });

  it("cancels and discards a late model response", async () => {
    let resolve!: (value: PromptEnhancementWireResponse) => void;
    vi.mocked(enhancePrompt).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(<MarkdownSkillAuthor modelId="test-model" library={library} />);
    await generate();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(vi.mocked(enhancePrompt).mock.calls[0]?.[1]?.aborted).toBe(true);
    await act(async () => {
      resolve(RESULT);
    });
    expect(screen.queryByLabelText("Skill draft (Markdown)")).toBeNull();
    expect(upload).not.toHaveBeenCalled();
  });

  it("does not accept fallback output and retains the source for retry", async () => {
    vi.mocked(enhancePrompt).mockResolvedValue({
      ...RESULT,
      outputKind: undefined,
    } as unknown as PromptEnhancementWireResponse);
    render(<MarkdownSkillAuthor modelId="test-model" library={library} />);
    await generate();
    expect(await screen.findByRole("alert")).toHaveTextContent("No complete skill draft");
    expect(screen.getByLabelText("Source text")).toHaveValue("Complete concept.");
    expect(screen.queryByLabelText("Skill draft (Markdown)")).toBeNull();
  });

  it("requires a model and rejects oversized sources before calling the gateway", async () => {
    const view = render(<MarkdownSkillAuthor modelId={undefined} library={library} />);
    fireEvent.click(screen.getByText("Create from document or text"));
    expect(screen.getByRole("button", { name: "Prepare draft" })).toBeDisabled();
    view.rerender(<MarkdownSkillAuthor modelId="test-model" library={library} />);
    fireEvent.change(screen.getByLabelText("Source text"), {
      target: { value: "x".repeat(100001) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare draft" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("100,000");
    expect(enhancePrompt).not.toHaveBeenCalled();
  });
});

it("keeps an emptied draft editable and prevents saving until it is valid again", async () => {
  render(<MarkdownSkillAuthor modelId="test-model" library={library} />);
  await generate();
  const editor = await screen.findByLabelText("Skill draft (Markdown)");
  fireEvent.change(editor, { target: { value: "" } });
  expect(editor).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save reviewed skill" })).toBeDisabled();
  fireEvent.change(editor, { target: { value: DRAFT } });
  expect(screen.getByRole("button", { name: "Save reviewed skill" })).toBeEnabled();
});

it.each([new Uint8Array([0xff]), new Uint8Array()])(
  "refuses invalid or empty UTF-8 files",
  async (bytes) => {
    render(<MarkdownSkillAuthor modelId="test-model" library={library} />);
    fireEvent.click(screen.getByText("Create from document or text"));
    const file = new File(["synthetic"], "concept.txt");
    Object.defineProperty(file, "arrayBuffer", {
      value: (): Promise<ArrayBufferLike> => Promise.resolve(bytes.buffer),
    });
    fireEvent.change(screen.getByLabelText("Source file (.md or .txt)"), {
      target: { files: [file] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("UTF-8");
    expect(enhancePrompt).not.toHaveBeenCalled();
  },
);

it("aborts on close and discards a late completed draft", async () => {
  let resolve!: (value: PromptEnhancementWireResponse) => void;
  vi.mocked(enhancePrompt).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<MarkdownSkillAuthor modelId="test-model" library={library} />);
  await generate();
  fireEvent.click(screen.getByText("Create from document or text"));
  expect(vi.mocked(enhancePrompt).mock.calls[0]?.[1]?.aborted).toBe(true);
  await act(async () => {
    resolve(RESULT);
  });
  fireEvent.click(screen.getByText("Create from document or text"));
  expect(screen.queryByLabelText("Skill draft (Markdown)")).toBeNull();
  expect(upload).not.toHaveBeenCalled();
});
