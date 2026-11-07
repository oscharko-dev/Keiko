import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type {
  MarkdownSkillDocument,
  MarkdownSkillSelectionView,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import * as api from "@/lib/markdown-skills-api";
import * as atlassian from "@/lib/atlassian-connectors-api";
import * as jiraTemplates from "@/lib/jira-templates-api";
import { notifyCodingAppSessionChanged } from "@/lib/coding-app-session-client";
import { useChatMarkdownSkill } from "../hooks/useChatMarkdownSkill";
import { MarkdownSkillDialog } from "./MarkdownSkillDialog";
import { skillHeading } from "./useSkillWorkspace";

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

const REVIEW: MarkdownSkillDocument = {
  id: "review-skill",
  revision: 1,
  digest: "a".repeat(64),
  name: "Boundary review",
  byteCount: 60,
  createdAt: 1,
  body: "# Boundary review\n\nIdentify assumptions before writing tests.\n",
};
const PLAN: MarkdownSkillDocument = {
  ...REVIEW,
  id: "plan-skill",
  digest: "b".repeat(64),
  name: "Release plan",
  body: "# Release plan\n\nList the risks first.\n",
};
const EMPTY: MarkdownSkillSelectionView = {
  availability: "none",
  selection: { revision: 0, skill: null },
};

/** A small in-memory skill store behind the mocked skill API, so a save really changes the library. */
function seedStore(initial: readonly MarkdownSkillDocument[]): { all: MarkdownSkillDocument[] } {
  const store = { all: [...initial] };
  vi.mocked(api.fetchMarkdownSkills).mockImplementation(() => Promise.resolve([...store.all]));
  vi.mocked(api.readMarkdownSkill).mockImplementation(({ id }) => {
    const found = store.all.find((item) => item.id === id);
    return found === undefined ? Promise.reject(new Error("missing")) : Promise.resolve(found);
  });
  // The mocked upload carries the file text so the mocked save can store exactly what was sent.
  vi.mocked(api.markdownSkillUpload).mockImplementation(async (file) => ({
    fileName: file.name,
    contentBase64: await file.text(),
  }));
  vi.mocked(api.saveMarkdownSkill).mockImplementation((upload, previous) => {
    const body = upload.contentBase64;
    const saved: MarkdownSkillDocument = {
      id: previous?.id ?? `stored-${String(store.all.length + 1)}`,
      revision: (previous?.revision ?? 0) + 1,
      digest: String((previous?.revision ?? 0) + 1).repeat(64),
      name: skillHeading(body) ?? upload.fileName,
      byteCount: body.length,
      createdAt: 2,
      body,
    };
    store.all = [...store.all.filter((item) => item.id !== saved.id), saved];
    return Promise.resolve(saved);
  });
  vi.mocked(api.deleteMarkdownSkill).mockImplementation(({ id }) => {
    store.all = store.all.filter((item) => item.id !== id);
    return Promise.resolve();
  });
  return store;
}

const onClose = vi.fn();

function Harness({ disabled = false }: { readonly disabled?: boolean }): ReactNode {
  const skill = useChatMarkdownSkill("chat-a");
  return (
    <MarkdownSkillDialog skill={skill} modelId={undefined} disabled={disabled} onClose={onClose} />
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  onClose.mockReset();
  vi.mocked(jiraTemplates.fetchJiraTemplates).mockResolvedValue([]);
  vi.mocked(atlassian.listAtlassianConnectors).mockResolvedValue([]);
  vi.mocked(api.fetchMarkdownSkillSelection).mockResolvedValue(EMPTY);
});
afterEach(cleanup);

async function openDialog(): Promise<HTMLElement> {
  render(<Harness />);
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(within(dialog).queryByRole("status")).toBeNull());
  await waitFor(() => expect(within(dialog).getByLabelText("Import")).toBeEnabled());
  return dialog;
}

function newSkill(dialog: HTMLElement): void {
  fireEvent.click(within(dialog).getAllByRole("button", { name: "New skill" })[0] as HTMLElement);
}

/** The formatted view needs a real layout; the Markdown source view is the same editor's textarea. */
function writeMarkdown(dialog: HTMLElement, text: string): void {
  const source = within(dialog).getByRole("button", { name: "Markdown" });
  if (source.getAttribute("aria-pressed") !== "true") fireEvent.click(source);
  fireEvent.change(within(dialog).getByRole("textbox", { name: /· Markdown$/u }), {
    target: { value: text },
  });
}

function item(dialog: HTMLElement, name: string): HTMLElement {
  return within(dialog).getByRole("button", { name: new RegExp(name, "u") });
}

const PANE_HEADINGS = new Set(["Chat skills", "Jira templates", "Open a skill or start a new one"]);

function documentHeading(dialog: HTMLElement): HTMLElement | undefined {
  return within(dialog)
    .queryAllByRole("heading", { level: 3 })
    .find((heading) => !PANE_HEADINGS.has(heading.textContent ?? ""));
}

function documentTitle(dialog: HTMLElement): string | null {
  return documentHeading(dialog)?.textContent ?? null;
}

/** The version badge of the open file; the library list shows its own, so scope to the header. */
function openFileMeta(dialog: HTMLElement): ReturnType<typeof within> {
  const head = documentHeading(dialog)?.parentElement;
  if (!head) throw new TypeError("No file is open");
  return within(head);
}

async function waitForVersion(dialog: HTMLElement, version: string): Promise<void> {
  await waitFor(() => expect(openFileMeta(dialog).getByText(version)).toBeInTheDocument());
}

describe("a new skill", () => {
  it("opens unsaved, becomes dirty with its text and is created by Save", async () => {
    seedStore([]);
    const dialog = await openDialog();
    expect(within(dialog).getByText("Open a skill or start a new one")).toBeInTheDocument();
    newSkill(dialog);
    expect(documentTitle(dialog)).toBe("New skill");
    expect(openFileMeta(dialog).getByText("Not saved yet")).toBeInTheDocument();
    expect(openFileMeta(dialog).getByText("Unsaved changes")).toBeInTheDocument();
    writeMarkdown(dialog, "# Garden review\n\nCheck the sensor boundaries.\n");
    expect(documentTitle(dialog)).toBe("Garden review");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitForVersion(dialog, "v1");
    expect(api.saveMarkdownSkill).toHaveBeenCalledOnce();
    expect(api.saveMarkdownSkill).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: "garden-review.md" }),
      undefined,
    );
    expect(within(dialog).queryByText("Unsaved changes")).toBeNull();
    expect(within(dialog).queryByText("Not saved yet")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(item(dialog, "Garden review")).toHaveAttribute("aria-current", "true");
    expect(api.changeMarkdownSkillSelection).not.toHaveBeenCalled();
  });

  it("refuses to save an empty or oversized text and says why", async () => {
    seedStore([]);
    const dialog = await openDialog();
    newSkill(dialog);
    writeMarkdown(dialog, "   ");
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Choose a non-empty .md file");
    writeMarkdown(dialog, "# Back\n");
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(api.saveMarkdownSkill).not.toHaveBeenCalled();
  });

  it("keeps a draft editable and downloadable, but unsavable, while the private library is unavailable", async () => {
    seedStore([]);
    vi.mocked(api.fetchMarkdownSkills).mockRejectedValue(new Error("offline"));
    render(<Harness />);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findAllByRole("alert");
    newSkill(dialog);
    writeMarkdown(dialog, "# Offline draft\n");
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Download Markdown" })).toBeEnabled();
    expect(api.saveMarkdownSkill).not.toHaveBeenCalled();
  });

  it("saves with the keyboard shortcut from anywhere in the open file", async () => {
    seedStore([]);
    const dialog = await openDialog();
    newSkill(dialog);
    writeMarkdown(dialog, "# Shortcut\n");
    fireEvent.keyDown(within(dialog).getByRole("textbox", { name: /· Markdown$/u }), {
      key: "s",
      metaKey: true,
    });
    await waitForVersion(dialog, "v1");
    expect(api.saveMarkdownSkill).toHaveBeenCalledOnce();
  });

  it("names the file after the heading and falls back to the draft name without one", async () => {
    seedStore([]);
    const dialog = await openDialog();
    newSkill(dialog);
    writeMarkdown(dialog, "No heading, just text.\n");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveMarkdownSkill).toHaveBeenCalledOnce());
    expect(api.saveMarkdownSkill).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: "skill.md" }),
      undefined,
    );
  });
});

describe("an existing skill", () => {
  it("opens in the editor without changing the chat selection and saves a new revision", async () => {
    seedStore([REVIEW]);
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole("button", { name: /Boundary review/u }));
    await waitForVersion(dialog, "v1");
    expect(documentTitle(dialog)).toBe("Boundary review");
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    writeMarkdown(dialog, `${REVIEW.body}Also name the owner.\n`);
    expect(within(dialog).getByText("Unsaved changes")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitForVersion(dialog, "v2");
    expect(api.saveMarkdownSkill).toHaveBeenCalledWith(expect.any(Object), REVIEW);
    expect(within(dialog).queryByText("Unsaved changes")).toBeNull();
    expect(api.changeMarkdownSkillSelection).not.toHaveBeenCalled();
  });

  it("closes when the library no longer holds it, including a removal made elsewhere", async () => {
    const store = seedStore([REVIEW]);
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole("button", { name: /Boundary review/u }));
    await waitForVersion(dialog, "v1");
    store.all = [];
    act(() => notifyCodingAppSessionChanged());
    await within(dialog).findByText("Open a skill or start a new one");
    expect(within(dialog).queryByRole("button", { name: /Boundary review/u })).toBeNull();
  });

  it("stays open when a delete fails", async () => {
    seedStore([REVIEW]);
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole("button", { name: /Boundary review/u }));
    await waitForVersion(dialog, "v1");
    vi.mocked(api.deleteMarkdownSkill).mockRejectedValue(new Error("offline"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete skill" }));
    await waitFor(() => expect(api.deleteMarkdownSkill).toHaveBeenCalledOnce());
    await within(dialog).findByRole("alert");
    expect(documentTitle(dialog)).toBe("Boundary review");
    expect(openFileMeta(dialog).getByText("v1")).toBeInTheDocument();
  });
});

describe("unsaved text is never lost silently", () => {
  async function dirtyDraft(): Promise<HTMLElement> {
    seedStore([REVIEW, PLAN]);
    const dialog = await openDialog();
    await within(dialog).findByRole("button", { name: /Boundary review/u });
    newSkill(dialog);
    writeMarkdown(dialog, "# Draft in progress\n");
    return dialog;
  }

  it("asks before opening another skill: Keep editing keeps the text, Discard switches", async () => {
    const dialog = await dirtyDraft();
    fireEvent.click(item(dialog, "Release plan"));
    expect(within(dialog).getByRole("alertdialog", { name: "Unsaved changes" })).toHaveTextContent(
      "This file has unsaved changes. Discard them?",
    );
    expect(api.readMarkdownSkill).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(within(dialog).queryByRole("alertdialog")).toBeNull();
    expect(documentTitle(dialog)).toBe("Draft in progress");
    expect(api.readMarkdownSkill).not.toHaveBeenCalled();
    fireEvent.click(item(dialog, "Release plan"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(documentTitle(dialog)).toBe("Release plan"));
    expect(api.readMarkdownSkill).toHaveBeenCalledOnce();
    expect(within(dialog).queryByRole("alertdialog")).toBeNull();
    expect(within(dialog).queryByText("Unsaved changes")).toBeNull();
  });

  it("guards the other ways of leaving the file: a new skill, drafting with AI and importing", async () => {
    const dialog = await dirtyDraft();
    newSkill(dialog);
    expect(within(dialog).getByRole("alertdialog")).toBeInTheDocument();
    expect(documentTitle(dialog)).toBe("Draft in progress");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Draft with AI" }));
    expect(within(dialog).getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    fireEvent.change(within(dialog).getByLabelText("Import"), {
      target: { files: [new File(["# Imported\n"], "imported.md")] },
    });
    expect(within(dialog).getByRole("alertdialog")).toBeInTheDocument();
    expect(api.saveMarkdownSkill).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard changes" }));
    await waitForVersion(dialog, "v1");
    expect(documentTitle(dialog)).toBe("Imported");
  });

  it("guards closing the dialog by button and by Escape", async () => {
    const dialog = await dirtyDraft();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close skills" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard changes" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes at once when nothing is unsaved", async () => {
    seedStore([REVIEW]);
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole("button", { name: /Boundary review/u }));
    await waitForVersion(dialog, "v1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close skills" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(within(dialog).queryByRole("alertdialog")).toBeNull();
  });

  it("does not turn a saved file dirty again, and a saved draft can be left freely", async () => {
    const dialog = await dirtyDraft();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitForVersion(dialog, "v1");
    fireEvent.click(item(dialog, "Release plan"));
    expect(within(dialog).queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(documentTitle(dialog)).toBe("Release plan"));
  });
});

describe("Use in this chat", () => {
  it("is a switch in the skill's own row and selects its saved revision", async () => {
    seedStore([REVIEW]);
    const selected: MarkdownSkillSelectionView = {
      availability: "available",
      name: "Boundary review",
      selection: {
        revision: 1,
        skill: { id: REVIEW.id, revision: 1, digest: "a".repeat(64) },
      },
    };
    vi.mocked(api.changeMarkdownSkillSelection).mockResolvedValue(selected);
    const dialog = await openDialog();
    const row = (await within(dialog).findByRole("button", { name: /Boundary review/u })).closest(
      "li",
    );
    if (row === null) throw new TypeError("The skill has no list row.");
    // Selecting needs no open document and no detour through the editor.
    const useIt = within(row).getByRole("button", { name: "Use in this chat" });
    expect(useIt).toHaveAttribute("aria-disabled", "false");
    expect(within(dialog).queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.click(useIt);
    await within(row).findByRole("button", { name: "Active in this chat" });
    expect(api.changeMarkdownSkillSelection).toHaveBeenCalledWith(
      "chat-a",
      { id: REVIEW.id, revision: 1, digest: "a".repeat(64) },
      0,
    );
    // The active row is a state, not a second request.
    fireEvent.click(within(row).getByRole("button", { name: "Active in this chat" }));
    expect(api.changeMarkdownSkillSelection).toHaveBeenCalledOnce();
  });

  it("is offered only for a saved file, not for a new draft", async () => {
    seedStore([]);
    const dialog = await openDialog();
    newSkill(dialog);
    expect(within(dialog).queryByRole("button", { name: "Use in this chat" })).toBeNull();
  });

  it("is inert while the chat is not accepting changes", async () => {
    seedStore([REVIEW]);
    render(<DisabledHarness />);
    const dialog = await screen.findByRole("dialog");
    const useIt = await within(dialog).findByRole("button", { name: "Use in this chat" });
    expect(useIt).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(useIt);
    expect(api.changeMarkdownSkillSelection).not.toHaveBeenCalled();
  });
});

function DisabledHarness(): ReactNode {
  return <Harness disabled />;
}

describe("download and delete", () => {
  let created: Blob[];
  let click: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    created = [];
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = (blob: Blob): string => {
          created.push(blob);
          return "blob:synthetic";
        };
        static override revokeObjectURL = vi.fn();
      },
    );
    click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  });
  afterEach(() => {
    click.mockRestore();
    vi.unstubAllGlobals();
  });

  it("downloads a clean stored revision through the library export", async () => {
    seedStore([REVIEW]);
    vi.mocked(api.exportMarkdownSkill).mockResolvedValue({
      fileName: "review.md",
      content: REVIEW.body,
    });
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole("button", { name: /Boundary review/u }));
    await waitForVersion(dialog, "v1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Download Markdown" }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(api.exportMarkdownSkill).toHaveBeenCalledWith(REVIEW);
    expect(await created[0]?.text()).toBe(REVIEW.body);
  });

  it("downloads exactly what is shown when the text is unsaved or a new draft", async () => {
    seedStore([REVIEW]);
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole("button", { name: /Boundary review/u }));
    await waitForVersion(dialog, "v1");
    writeMarkdown(dialog, "# Boundary review\n\nEdited but not saved.\n");
    fireEvent.click(within(dialog).getByRole("button", { name: "Download Markdown" }));
    expect(api.exportMarkdownSkill).not.toHaveBeenCalled();
    expect(await created[0]?.text()).toBe("# Boundary review\n\nEdited but not saved.\n");
  });

  it("downloads a new draft without storing it", async () => {
    seedStore([]);
    const dialog = await openDialog();
    newSkill(dialog);
    writeMarkdown(dialog, "# Local only\n");
    fireEvent.click(within(dialog).getByRole("button", { name: "Download Markdown" }));
    expect(await created[0]?.text()).toBe("# Local only\n");
    expect(click.mock.instances[0]).toMatchObject({ download: "skill.md" });
    expect(api.exportMarkdownSkill).not.toHaveBeenCalled();
    expect(api.saveMarkdownSkill).not.toHaveBeenCalled();
    expect(within(dialog).queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("deletes only after confirmation and shows the empty workspace afterwards", async () => {
    seedStore([REVIEW, PLAN]);
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole("button", { name: /Boundary review/u }));
    await waitForVersion(dialog, "v1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(within(dialog).getByText(/will require a new selection/u)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(api.deleteMarkdownSkill).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete skill" }));
    await within(dialog).findByText("Open a skill or start a new one");
    expect(api.deleteMarkdownSkill).toHaveBeenCalledWith(REVIEW);
    expect(within(dialog).queryByRole("button", { name: /Boundary review/u })).toBeNull();
    expect(within(dialog).getByRole("button", { name: /Release plan/u })).toBeInTheDocument();
  });
});
