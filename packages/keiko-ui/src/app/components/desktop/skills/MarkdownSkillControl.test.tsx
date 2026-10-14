import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type {
  MarkdownSkillDocument,
  MarkdownSkillSelectionView,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import * as api from "@/lib/markdown-skills-api";
import {
  useChatMarkdownSkill,
  chatSkillBlocksSend,
  expectedMarkdownSkillSelection,
} from "../hooks/useChatMarkdownSkill";
import { ApiError } from "@/lib/api";
import { MarkdownSkillControl } from "./MarkdownSkillControl";

vi.mock("@/lib/markdown-skills-api", () => ({
  fetchMarkdownSkills: vi.fn(),
  readMarkdownSkill: vi.fn(),
  saveMarkdownSkill: vi.fn(),
  deleteMarkdownSkill: vi.fn(),
  exportMarkdownSkill: vi.fn(),
  markdownSkillUpload: vi.fn(),
  fetchMarkdownSkillSelection: vi.fn(),
  changeMarkdownSkillSelection: vi.fn(),
}));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

const DOCUMENT: MarkdownSkillDocument = {
  id: "synthetic-skill",
  revision: 1,
  digest: "a".repeat(64),
  name: "Boundary review",
  byteCount: 80,
  createdAt: 1,
  body: "# Boundary review\nIdentify assumptions before writing tests.\n![external](https://example.invalid/pixel)",
};
const EMPTY: MarkdownSkillSelectionView = {
  availability: "none",
  selection: { revision: 0, skill: null },
};
const SELECTED: MarkdownSkillSelectionView = {
  availability: "available",
  name: DOCUMENT.name,
  selection: {
    revision: 1,
    skill: { id: DOCUMENT.id, revision: DOCUMENT.revision, digest: DOCUMENT.digest },
  },
};

function Harness({ chatId = "chat-a" }: { readonly chatId?: string }): ReactNode {
  const skill = useChatMarkdownSkill(chatId);
  return <MarkdownSkillControl skill={skill} disabled={false} />;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchMarkdownSkills).mockResolvedValue([]);
  vi.mocked(api.fetchMarkdownSkillSelection).mockResolvedValue(EMPTY);
  vi.mocked(api.readMarkdownSkill).mockResolvedValue(DOCUMENT);
  vi.mocked(api.markdownSkillUpload).mockResolvedValue({
    fileName: "method.md",
    contentBase64: "c3ludGhldGlj",
  });
});
afterEach(cleanup);

async function open(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Skills" }));
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(within(dialog).queryByRole("status")).toBeNull());
  return dialog;
}

describe("Chat Markdown skill controls", () => {
  it("uploads without activation, previews safely, selects explicitly and removes the chip", async () => {
    render(<Harness />);
    const dialog = await open();
    expect(within(dialog).getByText(/No skills yet/)).toBeInTheDocument();
    vi.mocked(api.saveMarkdownSkill).mockResolvedValue(DOCUMENT);
    vi.mocked(api.fetchMarkdownSkills).mockResolvedValue([DOCUMENT]);
    fireEvent.change(within(dialog).getByLabelText(/Upload Markdown/), {
      target: { files: [new File([DOCUMENT.body], "method.md")] },
    });
    await screen.findByRole("heading", { name: "Boundary review · v1" });
    expect(api.changeMarkdownSkillSelection).not.toHaveBeenCalled();
    expect(dialog.querySelector("img")).toBeNull();
    vi.mocked(api.changeMarkdownSkillSelection).mockResolvedValue(SELECTED);
    fireEvent.click(within(dialog).getByRole("button", { name: "Select" }));
    await screen.findByRole("button", { name: "Selected for next message" });
    expect(api.changeMarkdownSkillSelection).toHaveBeenCalledWith(
      "chat-a",
      SELECTED.selection.skill,
      0,
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Close skills" }));
    expect(screen.getByRole("button", { name: /Boundary review/ })).toBeInTheDocument();
    vi.mocked(api.changeMarkdownSkillSelection).mockResolvedValue({
      ...EMPTY,
      selection: { revision: 2, skill: null },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove skill from this chat" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Boundary review/ })).toBeNull(),
    );
    expect(api.changeMarkdownSkillSelection).toHaveBeenLastCalledWith("chat-a", null, 1);
  });

  it("does not upload unsupported or oversized files", async () => {
    render(<Harness />);
    const dialog = await open();
    const input = within(dialog).getByLabelText(/Upload Markdown/);
    for (const file of [
      new File(["x"], "method.exe"),
      new File([], "empty.md"),
      new File(["x".repeat(131073)], "big.md"),
    ]) {
      fireEvent.change(input, { target: { files: [file] } });
      expect(within(dialog).getByRole("alert")).toHaveTextContent("Choose a non-empty .md file");
    }
    expect(api.markdownSkillUpload).not.toHaveBeenCalled();
    expect(api.saveMarkdownSkill).not.toHaveBeenCalled();
  });

  it("supports keyboard focus, Escape and an accessible empty dialog", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Skills" });
    trigger.focus();
    const dialog = await open();
    await waitFor(() => expect(dialog).toHaveFocus());
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(within(dialog).getByLabelText(/Upload Markdown/)).toHaveFocus();
    expect((await axe(dialog)).violations).toEqual([]);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("replaces a document without changing the selected revision and requires confirmed deletion", async () => {
    vi.mocked(api.fetchMarkdownSkills).mockResolvedValue([DOCUMENT]);
    vi.mocked(api.fetchMarkdownSkillSelection).mockResolvedValue(SELECTED);
    render(<Harness />);
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: DOCUMENT.name }));
    await screen.findByRole("heading", { name: "Boundary review · v1" });
    const revised = { ...DOCUMENT, revision: 2, digest: "b".repeat(64) };
    vi.mocked(api.saveMarkdownSkill).mockResolvedValue(revised);
    vi.mocked(api.fetchMarkdownSkills).mockResolvedValue([revised]);
    fireEvent.change(within(dialog).getByLabelText("Replace with Markdown"), {
      target: { files: [new File([DOCUMENT.body], "replacement.md")] },
    });
    await screen.findByRole("heading", { name: "Boundary review · v2" });
    expect(api.saveMarkdownSkill).toHaveBeenCalledWith(expect.any(Object), DOCUMENT);
    expect(api.changeMarkdownSkillSelection).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Boundary review\s*· v1/ })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(api.deleteMarkdownSkill).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    vi.mocked(api.fetchMarkdownSkills).mockResolvedValue([]);
    vi.mocked(api.fetchMarkdownSkillSelection).mockResolvedValue({
      availability: "unavailable",
      selection: SELECTED.selection,
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete skill" }));
    await screen.findByText(/No skills yet/);
    expect(api.deleteMarkdownSkill).toHaveBeenCalledWith(revised);
    expect(screen.queryByRole("heading", { name: "Boundary review · v2" })).toBeNull();
    expect(
      screen.getByRole("button", { name: /Selected skill unavailable/, hidden: true }),
    ).toBeInTheDocument();
  });

  it("exports only the explicitly previewed revision as a local Markdown download", async () => {
    const create = vi.fn().mockReturnValue("blob:synthetic-download");
    const revoke = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = create;
        static override revokeObjectURL = revoke;
      },
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    vi.mocked(api.fetchMarkdownSkills).mockResolvedValue([DOCUMENT]);
    vi.mocked(api.exportMarkdownSkill).mockResolvedValue({
      fileName: "review.md",
      content: DOCUMENT.body,
    });
    render(<Harness />);
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: DOCUMENT.name }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Download Markdown" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:synthetic-download"));
    expect(api.exportMarkdownSkill).toHaveBeenCalledWith(DOCUMENT);
    expect(create.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect(click.mock.instances[0]).toMatchObject({
      download: "review.md",
      href: "blob:synthetic-download",
    });
    expect(api.changeMarkdownSkillSelection).not.toHaveBeenCalled();
    click.mockRestore();
    vi.unstubAllGlobals();
  });

  it("recovers a failed library load using the existing retry control", async () => {
    vi.mocked(api.fetchMarkdownSkills).mockRejectedValueOnce(new Error("offline"));
    render(<Harness />);
    const dialog = await open();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Skills could not be updated");
    vi.mocked(api.fetchMarkdownSkills).mockResolvedValue([DOCUMENT]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Reload" }));
    await within(dialog).findByRole("button", { name: DOCUMENT.name });
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("keeps unavailable selections removable and refuses stale changes without false success", async () => {
    vi.mocked(api.fetchMarkdownSkillSelection).mockResolvedValue({
      availability: "unavailable",
      selection: SELECTED.selection,
    });
    vi.mocked(api.changeMarkdownSkillSelection).mockRejectedValue(new Error("stale"));
    render(<Harness />);
    const remove = await screen.findByRole("button", { name: "Remove skill from this chat" });
    fireEvent.click(remove);
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: /Selected skill unavailable/ })).toBeInTheDocument();
  });
});

describe("Chat skill selection lifecycle", () => {
  it("keeps an unpaired ordinary Chat usable only with an explicit server-checked no-skill precondition", async () => {
    vi.mocked(api.fetchMarkdownSkillSelection).mockRejectedValue(
      new ApiError("NOT_FOUND", "Skill not found", 404),
    );
    const hook = renderHook(() => useChatMarkdownSkill("chat-a"));
    await waitFor(() => expect(hook.result.current.requireNoSkill).toBe(true));
    expect(chatSkillBlocksSend(hook.result.current)).toBe(false);
    expect(expectedMarkdownSkillSelection(hook.result.current)).toBeNull();
  });

  it("never converts a previously selected private skill into an implicit no-skill send on loss of access", async () => {
    vi.mocked(api.fetchMarkdownSkillSelection)
      .mockResolvedValueOnce(SELECTED)
      .mockRejectedValue(new ApiError("NOT_FOUND", "Skill not found", 404));
    const hook = renderHook(() => useChatMarkdownSkill("chat-a"));
    await waitFor(() => expect(hook.result.current.view).toEqual(SELECTED));
    await act(async () => hook.result.current.refresh());
    expect(hook.result.current.requireNoSkill).toBe(false);
    expect(chatSkillBlocksSend(hook.result.current)).toBe(true);
    expect(hook.result.current.view).toEqual(SELECTED);
  });
  it("never exposes the previous chat selection when the next read fails", async () => {
    vi.mocked(api.fetchMarkdownSkillSelection)
      .mockResolvedValueOnce(SELECTED)
      .mockRejectedValueOnce(new Error("offline"));
    const hook = renderHook(({ id }) => useChatMarkdownSkill(id), {
      initialProps: { id: "chat-a" },
    });
    await waitFor(() => expect(hook.result.current.view).toEqual(SELECTED));
    hook.rerender({ id: "chat-b" });
    expect(hook.result.current.view).toBeUndefined();
    await waitFor(() => expect(hook.result.current.failed).toBe(true));
    expect(hook.result.current.view).toBeUndefined();
  });

  it("ignores late reads from a previous chat and duplicate selection clicks", async () => {
    let finish: ((value: MarkdownSkillSelectionView) => void) | undefined;
    vi.mocked(api.fetchMarkdownSkillSelection).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const hook = renderHook(({ id }) => useChatMarkdownSkill(id), {
      initialProps: { id: "chat-a" },
    });
    await waitFor(() => expect(api.fetchMarkdownSkillSelection).toHaveBeenCalledWith("chat-a"));
    hook.rerender({ id: "chat-b" });
    await waitFor(() => expect(hook.result.current.view).toEqual(EMPTY));
    await act(async () => {
      finish?.(SELECTED);
    });
    expect(hook.result.current.view).toEqual(EMPTY);
    vi.mocked(api.changeMarkdownSkillSelection).mockResolvedValue(SELECTED);
    await act(async () => {
      await Promise.all([
        hook.result.current.select(DOCUMENT),
        hook.result.current.select(DOCUMENT),
      ]);
    });
    expect(api.changeMarkdownSkillSelection).toHaveBeenCalledTimes(1);
  });
});
