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
import { useLayoutEffect, type ReactNode } from "react";
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
import { notifyCodingAppSessionChanged } from "@/lib/coding-app-session-client";
import { MarkdownSkillControl } from "./MarkdownSkillControl";
import { MarkdownSkillDialog } from "./MarkdownSkillDialog";
import { useMarkdownSkillLibrary } from "./useMarkdownSkillLibrary";

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
  it("keeps the picker unavailable from first paint until the initial library read completes", async () => {
    let initiallyDisabled: boolean | undefined;
    function InitialDialog(): ReactNode {
      const skill = useChatMarkdownSkill("chat-a");
      useLayoutEffect(() => {
        const picker = document.querySelector('input[type="file"]');
        if (picker instanceof HTMLInputElement) initiallyDisabled = picker.disabled;
      }, []);
      return (
        <MarkdownSkillDialog
          skill={skill}
          modelId={undefined}
          disabled={false}
          onClose={(): void => undefined}
        />
      );
    }
    render(<InitialDialog />);
    expect(initiallyDisabled).toBe(true);
    await waitFor(() => expect(screen.getByLabelText(/Upload Markdown/)).toBeEnabled());
  });

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
    const content = within(dialog).getByRole("region", { name: "Boundary review · v1" });
    content.focus();
    expect(content).toHaveFocus();
    expect(api.changeMarkdownSkillSelection).not.toHaveBeenCalled();
    expect(dialog.querySelector("img")).toBeNull();
    vi.mocked(api.changeMarkdownSkillSelection).mockResolvedValue(SELECTED);
    fireEvent.click(within(dialog).getByRole("button", { name: "Select" }));
    await screen.findByRole("button", { name: "Active in this chat" });
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
    expect(
      within(dialog).getByRole("button", { name: "Create from document or text" }),
    ).toHaveFocus();
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

  it("disables unavailable uploads and reloads an open dialog after launcher pairing", async () => {
    const unavailable = new ApiError("NOT_FOUND", "Skill not found", 404);
    vi.mocked(api.fetchMarkdownSkills).mockRejectedValue(unavailable);
    vi.mocked(api.fetchMarkdownSkillSelection).mockRejectedValue(unavailable);
    render(<Harness />);
    const dialog = await open();
    await within(dialog).findByText(/Open Keiko from its launcher/);
    expect(within(dialog).getByLabelText(/Upload Markdown/)).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Reload" })).toBeEnabled();
    vi.mocked(api.fetchMarkdownSkills).mockResolvedValue([DOCUMENT]);
    vi.mocked(api.fetchMarkdownSkillSelection).mockResolvedValue(EMPTY);
    act(() => notifyCodingAppSessionChanged());
    await within(dialog).findByRole("button", { name: DOCUMENT.name });
    await waitFor(() => expect(within(dialog).queryByRole("alert")).toBeNull());
    expect(within(dialog).getByLabelText(/Upload Markdown/)).toBeEnabled();
    expect(api.saveMarkdownSkill).not.toHaveBeenCalled();
  });

  it("retries the library after pairing that arrives during its initial read", async () => {
    let rejectRead: ((error: Error) => void) | undefined;
    vi.mocked(api.fetchMarkdownSkills).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectRead = reject;
        }),
    );
    const hook = renderHook(() => useMarkdownSkillLibrary(async () => undefined));
    await waitFor(() => expect(api.fetchMarkdownSkills).toHaveBeenCalledTimes(1));
    vi.mocked(api.fetchMarkdownSkills).mockResolvedValue([DOCUMENT]);
    act(() => notifyCodingAppSessionChanged());
    await act(async () => rejectRead?.(new ApiError("NOT_FOUND", "Skill not found", 404)));
    await waitFor(() => expect(hook.result.current.skills).toEqual([DOCUMENT]));
    expect(hook.result.current.error).toBeUndefined();
    expect(api.fetchMarkdownSkills).toHaveBeenCalledTimes(2);
  });

  it("hides the previous private library and preview when its authoritative refresh fails", async () => {
    vi.mocked(api.fetchMarkdownSkills).mockResolvedValue([DOCUMENT]);
    const hook = renderHook(() => useMarkdownSkillLibrary(async () => undefined));
    await waitFor(() => expect(hook.result.current.available).toBe(true));
    await act(async () => hook.result.current.inspect(DOCUMENT));
    expect(hook.result.current.preview).toEqual(DOCUMENT);
    vi.mocked(api.fetchMarkdownSkills).mockRejectedValue(
      new ApiError("NOT_FOUND", "Skill not found", 404),
    );
    await act(async () => hook.result.current.refresh());
    expect(hook.result.current.available).toBe(false);
    expect(hook.result.current.skills).toEqual([]);
    expect(hook.result.current.preview).toBeUndefined();
  });

  it("refreshes after a pending upload loses its session without repeating the mutation", async () => {
    let rejectUpload: ((error: Error) => void) | undefined;
    vi.mocked(api.saveMarkdownSkill).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectUpload = reject;
        }),
    );
    const hook = renderHook(() => useMarkdownSkillLibrary(async () => undefined));
    await waitFor(() => expect(hook.result.current.busy).toBe(false));
    act(() => {
      void hook.result.current.upload(new File(["# Test"], "test.md"));
    });
    await waitFor(() => expect(api.saveMarkdownSkill).toHaveBeenCalledTimes(1));
    vi.mocked(api.fetchMarkdownSkills).mockResolvedValue([DOCUMENT]);
    act(() => notifyCodingAppSessionChanged());
    await act(async () => rejectUpload?.(new ApiError("NOT_FOUND", "Skill not found", 404)));
    await waitFor(() => expect(hook.result.current.skills).toEqual([DOCUMENT]));
    expect(api.saveMarkdownSkill).toHaveBeenCalledTimes(1);
    expect(hook.result.current.error).toBeUndefined();
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
  it("rereads a selection after pairing during a mutation and discards its obsolete result", async () => {
    let finish: ((view: MarkdownSkillSelectionView) => void) | undefined;
    vi.mocked(api.changeMarkdownSkillSelection).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const hook = renderHook(() => useChatMarkdownSkill("chat-a"));
    await waitFor(() => expect(hook.result.current.view).toEqual(EMPTY));
    act(() => {
      void hook.result.current.select(DOCUMENT);
    });
    await waitFor(() => expect(api.changeMarkdownSkillSelection).toHaveBeenCalledTimes(1));
    act(() => notifyCodingAppSessionChanged());
    await act(async () => finish?.(SELECTED));
    await waitFor(() => expect(api.fetchMarkdownSkillSelection).toHaveBeenCalledTimes(2));
    expect(hook.result.current.view).toEqual(EMPTY);
    expect(hook.result.current.busy).toBe(false);
    expect(api.changeMarkdownSkillSelection).toHaveBeenCalledTimes(1);
  });

  it("refreshes an unpaired selection when the launcher restores the session", async () => {
    vi.mocked(api.fetchMarkdownSkillSelection).mockRejectedValueOnce(
      new ApiError("NOT_FOUND", "Skill not found", 404),
    );
    const hook = renderHook(() => useChatMarkdownSkill("chat-a"));
    await waitFor(() => expect(hook.result.current.requireNoSkill).toBe(true));
    act(() => notifyCodingAppSessionChanged());
    await waitFor(() => expect(hook.result.current.view).toEqual(EMPTY));
    expect(hook.result.current.requireNoSkill).toBe(false);
    expect(hook.result.current.failed).toBe(false);
  });

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
