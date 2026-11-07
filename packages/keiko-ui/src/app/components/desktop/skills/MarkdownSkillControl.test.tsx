import userEvent from "@testing-library/user-event";
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
import * as atlassian from "@/lib/atlassian-connectors-api";
import * as jiraTemplates from "@/lib/jira-templates-api";
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
vi.mock("@/lib/jira-templates-api", () => ({
  fetchJiraTemplates: vi.fn(),
  proposeJiraTemplates: vi.fn(),
  validateJiraTemplate: vi.fn(),
}));
vi.mock(import("@/lib/atlassian-connectors-api"), async (importOriginal) => ({
  ...(await importOriginal()),
  listAtlassianConnectors: vi.fn(),
}));

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
  vi.mocked(jiraTemplates.fetchJiraTemplates).mockResolvedValue([]);
  vi.mocked(atlassian.listAtlassianConnectors).mockResolvedValue([]);
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

/** Opens a stored skill in the editor and waits until its text is shown. */
async function openSkill(dialog: HTMLElement, name = DOCUMENT.name): Promise<void> {
  fireEvent.click(await within(dialog).findByRole("button", { name: new RegExp(name, "u") }));
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save" })).toBeVisible());
}

describe("Chat Markdown skill controls", () => {
  // #4173: a business user could not tell chat skills from the project lead's Jira templates.
  it("lists Jira templates in their own section and lets each row put one into the chat", async () => {
    const template = { ...DOCUMENT, id: "epic-template", name: "Epic template" };
    vi.mocked(api.fetchMarkdownSkills).mockResolvedValue([DOCUMENT, template]);
    vi.mocked(api.readMarkdownSkill).mockResolvedValue(template);
    vi.mocked(jiraTemplates.fetchJiraTemplates).mockResolvedValue([
      { id: template.id, revision: 1, name: template.name, valid: true, project: "KER" },
    ]);
    render(<Harness />);
    const dialog = await open();
    const chat = within(dialog).getByRole("region", { name: "Chat skills" });
    const jira = within(dialog).getByRole("region", { name: "Jira templates" });
    await waitFor(() =>
      expect(within(chat).queryByRole("button", { name: /Epic template/u })).toBeNull(),
    );
    expect(within(chat).getByRole("button", { name: /Boundary review/u })).toBeInTheDocument();
    expect(within(jira).getByRole("button", { name: /Epic template/u })).toBeInTheDocument();
    // Opening a template edits it; it is not put into the chat by opening it.
    fireEvent.click(within(jira).getByRole("button", { name: /Epic template/u }));
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Save" })).toBeInTheDocument(),
    );
    expect(within(dialog).getByText("Jira template")).toBeInTheDocument();
    expect(api.changeMarkdownSkillSelection).not.toHaveBeenCalled();
    // Every row carries its own visible switch: the template's selects the template's revision.
    expect(within(chat).getByRole("button", { name: "Use in this chat" })).toBeVisible();
    vi.mocked(api.changeMarkdownSkillSelection).mockResolvedValue({
      ...SELECTED,
      name: template.name,
      selection: {
        revision: 1,
        skill: { id: template.id, revision: template.revision, digest: template.digest },
      },
    });
    fireEvent.click(within(jira).getByRole("button", { name: "Use in this chat" }));
    await within(jira).findByRole("button", { name: "Active in this chat" });
    expect(api.changeMarkdownSkillSelection).toHaveBeenCalledWith(
      "chat-a",
      { id: template.id, revision: template.revision, digest: template.digest },
      0,
    );
    expect(within(chat).getByRole("button", { name: "Use in this chat" })).toBeVisible();
  });

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
    await waitFor(() => expect(screen.getByLabelText("Import")).toBeEnabled());
  });

  it("imports without activation, opens safely, selects explicitly and removes the chip", async () => {
    render(<Harness />);
    const dialog = await open();
    expect(within(dialog).getByText(/No chat skills yet/)).toBeInTheDocument();
    vi.mocked(api.saveMarkdownSkill).mockResolvedValue(DOCUMENT);
    vi.mocked(api.fetchMarkdownSkills).mockResolvedValue([DOCUMENT]);
    fireEvent.change(within(dialog).getByLabelText("Import"), {
      target: { files: [new File([DOCUMENT.body], "method.md")] },
    });
    // The imported file opens in the editor; it is not put into the chat by importing it.
    await within(dialog).findByRole("button", { name: "Save" });
    await within(dialog).findByRole("button", { name: "Use in this chat" });
    expect(api.saveMarkdownSkill).toHaveBeenCalledOnce();
    expect(api.changeMarkdownSkillSelection).not.toHaveBeenCalled();
    // The Markdown image of the file never becomes a remote fetch inside the dialog.
    expect(dialog.querySelector("img[src]")).toBeNull();
    expect(dialog.querySelector("[data-markdown-image]")).not.toBeNull();
    vi.mocked(api.changeMarkdownSkillSelection).mockResolvedValue(SELECTED);
    fireEvent.click(within(dialog).getByRole("button", { name: "Use in this chat" }));
    await within(dialog).findByRole("button", { name: "Active in this chat" });
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

  it("opens the chip's skill from the chat and shows the active state in the library", async () => {
    vi.mocked(api.fetchMarkdownSkills).mockResolvedValue([DOCUMENT]);
    vi.mocked(api.fetchMarkdownSkillSelection).mockResolvedValue(SELECTED);
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: /Boundary review\s*· v1/ }));
    const dialog = await screen.findByRole("dialog");
    const row = (await within(dialog).findByRole("button", { name: /Boundary review/u })).closest(
      "li",
    );
    if (row === null) throw new TypeError("The skill has no list row.");
    expect(await within(row).findByRole("button", { name: "Active in this chat" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps keyboard focus on the library entry while its read is pending", async () => {
    vi.mocked(api.fetchMarkdownSkills).mockResolvedValue([DOCUMENT]);
    let resolve!: (document: MarkdownSkillDocument) => void;
    vi.mocked(api.readMarkdownSkill).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<Harness />);
    const dialog = await open();
    await waitFor(() => expect(dialog).toHaveFocus());
    const entry = await within(dialog).findByRole("button", { name: /Boundary review/u });
    entry.focus();
    const user = userEvent.setup();
    await user.keyboard("{Enter}");
    expect(entry).toBeEnabled();
    await user.keyboard("{Enter}");
    expect(api.readMarkdownSkill).toHaveBeenCalledOnce();
    await act(async () => resolve(DOCUMENT));
    expect(entry).toHaveFocus();
    expect(entry).toHaveAttribute("aria-current", "true");
  });

  it("keeps selection keyboard focus through activation so Escape returns to Skills", async () => {
    vi.mocked(api.fetchMarkdownSkills).mockResolvedValue([DOCUMENT]);
    let resolve!: (view: MarkdownSkillSelectionView) => void;
    vi.mocked(api.changeMarkdownSkillSelection).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Skills" });
    trigger.focus();
    const dialog = await open();
    await waitFor(() => expect(dialog).toHaveFocus());
    await openSkill(dialog);
    const select = within(dialog).getByRole("button", { name: "Use in this chat" });
    select.focus();
    const user = userEvent.setup();
    await user.keyboard("{Enter}");
    expect(select).toBeEnabled();
    expect(select).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(api.changeMarkdownSkillSelection).toHaveBeenCalledOnce();
    await act(async () => resolve(SELECTED));
    expect(select).toHaveFocus();
    expect(select).toHaveAccessibleName("Active in this chat");
    await user.keyboard("{Enter}{Escape}");
    expect(api.changeMarkdownSkillSelection).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("does not upload unsupported or oversized files", async () => {
    render(<Harness />);
    const dialog = await open();
    const input = within(dialog).getByLabelText("Import");
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
    // Shift+Tab from the dialog wraps to the last control, the workspace's "Draft with AI".
    expect(within(dialog).getAllByRole("button", { name: "Draft with AI" }).at(-1)).toHaveFocus();
    expect((await axe(dialog)).violations).toEqual([]);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("saves a new revision without changing the selected revision and requires confirmed deletion", async () => {
    vi.mocked(api.fetchMarkdownSkills).mockResolvedValue([DOCUMENT]);
    vi.mocked(api.fetchMarkdownSkillSelection).mockResolvedValue(SELECTED);
    render(<Harness />);
    const dialog = await open();
    await openSkill(dialog);
    const revised = { ...DOCUMENT, revision: 2, digest: "b".repeat(64) };
    vi.mocked(api.saveMarkdownSkill).mockResolvedValue(revised);
    vi.mocked(api.fetchMarkdownSkills).mockResolvedValue([revised]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Markdown" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: /· Markdown$/u }), {
      target: { value: `${DOCUMENT.body}\nRevised.` },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveMarkdownSkill).toHaveBeenCalledOnce());
    expect(api.saveMarkdownSkill).toHaveBeenCalledWith(expect.any(Object), DOCUMENT);
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled(),
    );
    expect(api.changeMarkdownSkillSelection).not.toHaveBeenCalled();
    // The chat keeps the revision it selected; the chip does not follow the new one.
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
    await screen.findByText(/No chat skills yet/);
    expect(api.deleteMarkdownSkill).toHaveBeenCalledWith(revised);
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "Save" })).toBeNull());
    expect(
      screen.getByRole("button", { name: /Selected skill unavailable/, hidden: true }),
    ).toBeInTheDocument();
  });

  it("exports only the explicitly opened revision as a local Markdown download", async () => {
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
    await openSkill(dialog);
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
    await within(dialog).findByRole("button", { name: /Boundary review/u });
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("disables unavailable uploads and reloads an open dialog after launcher pairing", async () => {
    const unavailable = new ApiError("NOT_FOUND", "Skill not found", 404);
    vi.mocked(api.fetchMarkdownSkills).mockRejectedValue(unavailable);
    vi.mocked(api.fetchMarkdownSkillSelection).mockRejectedValue(unavailable);
    render(<Harness />);
    const dialog = await open();
    await within(dialog).findByText(/Open Keiko from its launcher/);
    expect(within(dialog).getByLabelText("Import")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Reload" })).toBeEnabled();
    vi.mocked(api.fetchMarkdownSkills).mockResolvedValue([DOCUMENT]);
    vi.mocked(api.fetchMarkdownSkillSelection).mockResolvedValue(EMPTY);
    act(() => notifyCodingAppSessionChanged());
    await within(dialog).findByRole("button", { name: /Boundary review/u });
    await waitFor(() => expect(within(dialog).queryByRole("alert")).toBeNull());
    expect(within(dialog).getByLabelText("Import")).toBeEnabled();
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
