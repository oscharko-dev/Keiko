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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { parseJiraIssueTemplate } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  MarkdownSkillDocument,
  MarkdownSkillSelectionView,
  JiraTemplateOptions,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import * as api from "@/lib/markdown-skills-api";
import * as atlassian from "@/lib/atlassian-connectors-api";
import * as jiraTemplates from "@/lib/jira-templates-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { notifyCodingAppSessionChanged } from "@/lib/coding-app-session-client";
import { useChatMarkdownSkill } from "../hooks/useChatMarkdownSkill";
import { MarkdownSkillDialog } from "./MarkdownSkillDialog";
import { skillHeading, useSkillWorkspace } from "./useSkillWorkspace";
import type { MarkdownSkillLibrary } from "./useMarkdownSkillLibrary";

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
  fetchJiraTemplateOptions: vi.fn(),
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

const POD: atlassian.AtlassianConnectorMetadata = {
  schemaVersion: "1",
  authRef: "synthetic-ref",
  provider: "jira",
  deployment: "data-center",
  authScheme: "bearer-pat",
  generation: 1,
  displayName: "Lab Jira",
  baseUrl: "https://jira.example.invalid",
  createdAt: 1,
  livePod: {
    kind: "jira-live",
    podId: "pod-one",
    authenticationGeneration: 1,
    verificationRevision: 1,
    verificationInProgress: false,
    verificationStatus: "ok",
    capabilities: ["live-read"],
  },
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
  vi.mocked(jiraTemplates.fetchJiraTemplateOptions).mockResolvedValue({
    kind: "projects",
    projects: [],
  });
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

function starterButtons(dialog: HTMLElement): HTMLElement[] {
  return within(within(dialog).getByRole("list", { name: "Jira starter templates" })).getAllByRole(
    "button",
  );
}

function refreshPods(): void {
  act(() => {
    window.dispatchEvent(new Event(atlassian.ATLASSIAN_CONNECTORS_CHANGED_EVENT));
  });
}

describe("Jira starter templates", () => {
  it("enables all three on Pod activation and disables them again on removal or refresh failure", async () => {
    seedStore([]);
    const dialog = await openDialog();
    const buttons = starterButtons(dialog);
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Jira Epic",
      "Jira Issue",
      "Jira Bug",
    ]);
    for (const button of buttons) expect(button).toBeDisabled();

    vi.mocked(atlassian.listAtlassianConnectors).mockResolvedValue([POD]);
    refreshPods();
    await waitFor(() => {
      for (const button of buttons) expect(button).toBeEnabled();
    });

    vi.mocked(atlassian.listAtlassianConnectors).mockRejectedValueOnce(new Error("offline"));
    refreshPods();
    for (const button of buttons) expect(button).toBeDisabled();
    await act(async () => {});
    for (const button of buttons) expect(button).toBeDisabled();

    refreshPods();
    await waitFor(() => expect(buttons[0]).toBeEnabled());
    vi.mocked(atlassian.listAtlassianConnectors).mockResolvedValue([]);
    refreshPods();
    await act(async () => {});
    for (const button of buttons) expect(button).toBeDisabled();
    expect(api.saveMarkdownSkill).not.toHaveBeenCalled();
    expect(api.changeMarkdownSkillSelection).not.toHaveBeenCalled();
  });

  it.each([
    ["Jira Epic", "Epic", ["Objective", "Scope", "Acceptance criteria"]],
    ["Jira Issue", "Task", ["Description", "Acceptance criteria"]],
    ["Jira Bug", "Bug", ["Steps to reproduce", "Expected behavior", "Actual behavior"]],
  ])("opens %s as an editable, unsaved template", async (name, issueType, sections) => {
    seedStore([]);
    vi.mocked(atlassian.listAtlassianConnectors).mockResolvedValue([POD]);
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name }));
    expect(documentTitle(dialog)).toBe(name);
    expect(openFileMeta(dialog).getByText("Not saved yet")).toBeInTheDocument();
    const metadata = within(dialog).getByLabelText<HTMLTextAreaElement>("Metadata (YAML)");
    fireEvent.click(within(dialog).getByRole("button", { name: "Markdown" }));
    const body = within(dialog).getByRole<HTMLTextAreaElement>("textbox", { name: /· Markdown$/u });
    const draft = `---\n${metadata.value}\n---\n${body.value}`;
    expect(parseJiraIssueTemplate(draft).ok).toBe(false);
    expect(parseJiraIssueTemplate(draft.replace('project: ""', "project: LAB"))).toMatchObject({
      ok: true,
      template: { project: "LAB", issueType, requiredSections: sections },
    });
    expect(api.saveMarkdownSkill).not.toHaveBeenCalled();
    expect(api.changeMarkdownSkillSelection).not.toHaveBeenCalled();
    expect(jiraTemplates.proposeJiraTemplates).not.toHaveBeenCalled();
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        stageReport: expect.objectContaining({ stage: "jira starter draft", phase: "settled" }),
      }),
    );
  });

  it("authors a template with the localized types and fields of the selected Jira project", async () => {
    const store = seedStore([]);
    vi.mocked(atlassian.listAtlassianConnectors).mockResolvedValue([POD]);
    vi.mocked(jiraTemplates.fetchJiraTemplateOptions).mockImplementation((selection) => {
      if (selection.issueTypeId !== undefined)
        return Promise.resolve({
          kind: "details",
          fields: [
            { id: "customfield_10016", name: "Fachlicher Ansprechpartner", required: false },
          ],
          statuses: [{ id: "6", name: "Erledigt" }],
        });
      if (selection.projectKey !== undefined)
        return Promise.resolve({
          kind: "types",
          instanceId: "synthetic-instance",
          issueTypes: [
            { id: "1", name: "Aufgabe" },
            { id: "2", name: "Fachliche Aufgabe" },
          ],
        });
      return Promise.resolve({ kind: "projects", projects: [{ key: "LAB", name: "Lab project" }] });
    });
    const dialogElement = await openDialog();
    const dialog = within(dialogElement);
    fireEvent.click(dialog.getByRole("button", { name: "Jira Issue" }));
    expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
    const project = await dialog.findByRole("combobox", { name: "Jira project" });
    await dialog.findByRole("option", { name: "Lab project (LAB)" });
    fireEvent.change(project, { target: { value: "LAB" } });
    await dialog.findByRole("option", { name: "Aufgabe" });
    expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(dialog.getByRole("combobox", { name: "Issue type" }), {
      target: { value: "1" },
    });
    fireEvent.click(dialog.getByText("Template rules"));
    await dialog.findByRole("option", { name: "Fachlicher Ansprechpartner" });
    fireEvent.change(dialog.getByRole("combobox", { name: "Add required field" }), {
      target: { value: "customfield_10016" },
    });
    fireEvent.change(dialog.getByRole("combobox", { name: "Apply on entering a status" }), {
      target: { value: "transition:Erledigt" },
    });

    const source = dialog.getByLabelText<HTMLTextAreaElement>("Metadata (YAML)");
    expect(source.value).toContain('issueType: "Aufgabe"');
    expect(source.value).toContain('requiredFields: ["customfield_10016"]');
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitForVersion(dialogElement, "v1");
    expect(parseJiraIssueTemplate(store.all[0]?.body ?? "")).toMatchObject({
      ok: true,
      template: {
        project: "LAB",
        issueType: "Aufgabe",
        requiredFields: ["customfield_10016"],
        activations: [{ kind: "create" }, { kind: "transition", target: "Erledigt" }],
        requiredSections: ["Description", "Acceptance criteria"],
      },
    });
  });

  it("never offers a late issue-type list for a project the author has left", async () => {
    seedStore([]);
    vi.mocked(atlassian.listAtlassianConnectors).mockResolvedValue([POD]);
    const old = deferred<JiraTemplateOptions>();
    vi.mocked(jiraTemplates.fetchJiraTemplateOptions).mockImplementation((selection) => {
      if (selection.projectKey === "OLD") return old.promise;
      if (selection.projectKey === "NEW")
        return Promise.resolve({
          kind: "types",
          instanceId: "synthetic-instance",
          issueTypes: [{ id: "3", name: "Epic" }],
        });
      return Promise.resolve({
        kind: "projects",
        projects: [
          { key: "OLD", name: "Old project" },
          { key: "NEW", name: "New project" },
        ],
      });
    });
    const dialog = within(await openDialog());
    fireEvent.click(dialog.getByRole("button", { name: "Jira Issue" }));
    const project = await dialog.findByRole("combobox", { name: "Jira project" });
    await dialog.findByRole("option", { name: "Old project (OLD)" });
    fireEvent.change(project, { target: { value: "OLD" } });
    await waitFor(() => expect(jiraTemplates.fetchJiraTemplateOptions).toHaveBeenCalledTimes(2));
    fireEvent.change(project, { target: { value: "NEW" } });
    expect(await dialog.findByRole("option", { name: "Epic" })).toBeVisible();
    await act(async () =>
      old.resolve({
        kind: "types",
        instanceId: "synthetic-instance",
        issueTypes: [{ id: "1", name: "Aufgabe" }],
      }),
    );
    expect(dialog.getByRole("option", { name: "Epic" })).toBeVisible();
    expect(dialog.queryByRole("option", { name: "Aufgabe" })).toBeNull();
  });

  it("keeps the YAML editor open and focused while the author is typing incomplete metadata", async () => {
    seedStore([]);
    vi.mocked(atlassian.listAtlassianConnectors).mockResolvedValue([POD]);
    const dialogElement = await openDialog();
    await waitFor(() => expect(dialogElement).toHaveFocus());
    const dialog = within(dialogElement);
    fireEvent.click(dialog.getByRole("button", { name: "Jira Issue" }));
    const yaml = dialog.getByLabelText<HTMLTextAreaElement>("Metadata (YAML)");
    const source = yaml.closest("details");
    if (source === null) throw new TypeError("The metadata source must be expandable");
    source.open = true;
    yaml.focus();
    const original = yaml.value;
    await waitFor(() => expect(jiraTemplates.fetchJiraTemplateOptions).toHaveBeenCalledOnce());
    const guided = (): HTMLElement | null =>
      dialog.getByRole("combobox", { name: "Jira project" }).closest("fieldset");

    // A half-typed list holds the last form that read, disabled, instead of removing it.
    fireEvent.change(yaml, { target: { value: original + '\nrequiredFields: ["' } });
    expect(yaml).toHaveFocus();
    expect(source.open).toBe(true);
    expect(guided()).toBeDisabled();
    expect(dialog.getByText(/^Correct the rules in the text below/u)).toBeVisible();

    fireEvent.change(yaml, { target: { value: original + '\nrequiredFields: ["description"]' } });
    await waitFor(() => expect(guided()).toBeEnabled());
    expect(dialog.queryByText(/^Correct the rules in the text below/u)).toBeNull();
    expect(yaml).toHaveFocus();
    expect(source.open).toBe(true);
    // The held form kept its reads: nothing asked Jira again for the same project list.
    expect(jiraTemplates.fetchJiraTemplateOptions).toHaveBeenCalledOnce();
  });

  it("marks a required field the selected issue type does not offer and never offers a written field twice", async () => {
    seedStore([]);
    vi.mocked(atlassian.listAtlassianConnectors).mockResolvedValue([POD]);
    vi.mocked(jiraTemplates.fetchJiraTemplateOptions).mockImplementation((selection) => {
      if (selection.issueTypeId !== undefined)
        return Promise.resolve({
          kind: "details",
          fields: [
            { id: "customfield_10016", name: "Fachlicher Ansprechpartner", required: false },
            { id: "duedate", name: "Fälligkeitsdatum", required: true },
          ],
          statuses: [],
        });
      if (selection.projectKey !== undefined)
        return Promise.resolve({
          kind: "types",
          instanceId: "synthetic-instance",
          issueTypes: [{ id: "1", name: "Aufgabe" }],
        });
      return Promise.resolve({ kind: "projects", projects: [{ key: "LAB", name: "Lab project" }] });
    });
    const dialog = within(await openDialog());
    fireEvent.click(dialog.getByRole("button", { name: "Jira Issue" }));
    const yaml = dialog.getByLabelText<HTMLTextAreaElement>("Metadata (YAML)");
    fireEvent.change(yaml, {
      target: {
        value: yaml.value
          .replace('project: ""', "project: LAB")
          .replace("issueType: Task", "issueType: Aufgabe")
          .concat('\nrequiredFields: ["Gone field", "fachlicher ansprechpartner"]'),
      },
    });
    fireEvent.click(dialog.getByText("Template rules"));

    const gone = await dialog.findByText(
      "Gone field (not offered for this issue type)",
      {},
      { timeout: 3000 },
    );
    expect(gone.closest("li")).toHaveAttribute("data-offered", "false");
    // A reference written by name shows Jira's own name and counts as that field.
    const known = dialog.getByText("Fachlicher Ansprechpartner");
    expect(known.closest("li")).toHaveAttribute("data-offered", "true");
    const add = within(dialog.getByRole("combobox", { name: "Add required field" }));
    expect(add.queryByRole("option", { name: "Fachlicher Ansprechpartner" })).toBeNull();
    expect(add.getByRole("option", { name: "Fälligkeitsdatum (required by Jira)" })).toBeVisible();
  });

  it("tells same-named Jira fields apart by their id and saves the one chosen", async () => {
    // Review finding on PR #4464 (P2): two Team fields rendered as two identical choices with two
    // different ids, so an operator could not tell which field would govern writes.
    seedStore([]);
    vi.mocked(atlassian.listAtlassianConnectors).mockResolvedValue([POD]);
    vi.mocked(jiraTemplates.fetchJiraTemplateOptions).mockImplementation((selection) => {
      if (selection.issueTypeId !== undefined)
        return Promise.resolve({
          kind: "details",
          fields: [
            { id: "customfield_10010", name: "Team", required: false },
            { id: "customfield_10011", name: "Team", required: true },
            { id: "duedate", name: "Fälligkeitsdatum", required: false },
          ],
          statuses: [],
        });
      if (selection.projectKey !== undefined)
        return Promise.resolve({
          kind: "types",
          instanceId: "synthetic-instance",
          issueTypes: [{ id: "1", name: "Aufgabe" }],
        });
      return Promise.resolve({ kind: "projects", projects: [{ key: "LAB", name: "Lab project" }] });
    });
    const dialog = within(await openDialog());
    fireEvent.click(dialog.getByRole("button", { name: "Jira Issue" }));
    const yaml = dialog.getByLabelText<HTMLTextAreaElement>("Metadata (YAML)");
    fireEvent.change(yaml, {
      target: {
        value: yaml.value
          .replace('project: ""', "project: LAB")
          .replace("issueType: Task", "issueType: Aufgabe"),
      },
    });
    fireEvent.click(dialog.getByText("Template rules"));

    const picker = await dialog.findByRole(
      "combobox",
      { name: "Add required field" },
      { timeout: 3000 },
    );
    const add = within(picker);
    await waitFor(() =>
      expect(add.getByRole("option", { name: "Team (customfield_10010)" })).toBeVisible(),
    );
    expect(
      add.getByRole("option", { name: "Team (customfield_10011) (required by Jira)" }),
    ).toHaveValue("customfield_10011");
    // A name only one field carries stays as Jira writes it.
    expect(add.getByRole("option", { name: "Fälligkeitsdatum" })).toHaveValue("duedate");

    fireEvent.change(picker, { target: { value: "customfield_10011" } });
    await waitFor(() => expect(yaml.value).toMatch(/customfield_10011/u));
    expect(yaml.value).not.toMatch(/customfield_10010/u);
    // The written rule shows which of the two fields it names, and that one is no longer offered.
    expect(dialog.getByText("Team (customfield_10011)").closest("li")).toHaveAttribute(
      "data-offered",
      "true",
    );
    expect(add.queryByRole("option", { name: /customfield_10011/u })).toBeNull();
    expect(add.getByRole("option", { name: "Team (customfield_10010)" })).toBeVisible();
  });

  it("keeps the user's draft if the Pod is removed while confirming a switch", async () => {
    seedStore([]);
    vi.mocked(atlassian.listAtlassianConnectors).mockResolvedValue([POD]);
    const dialog = await openDialog();
    newSkill(dialog);
    writeMarkdown(dialog, "# Keep this draft\n");
    fireEvent.click(within(dialog).getByRole("button", { name: "Jira Bug" }));

    vi.mocked(atlassian.listAtlassianConnectors).mockResolvedValue([]);
    refreshPods();
    await act(async () => {});
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard changes" }));
    expect(documentTitle(dialog)).toBe("Keep this draft");
    expect(openFileMeta(dialog).getByText("Unsaved changes")).toBeInTheDocument();
    expect(api.saveMarkdownSkill).not.toHaveBeenCalled();
  });

  it("ends pending validation in the library and editor when the last Jira Pod is removed", async () => {
    seedStore([REVIEW, PLAN]);
    vi.mocked(atlassian.listAtlassianConnectors).mockResolvedValue([POD]);
    vi.mocked(jiraTemplates.fetchJiraTemplates).mockResolvedValue([
      {
        id: REVIEW.id,
        revision: 1,
        name: REVIEW.name,
        valid: true,
        project: "LAB",
        issueType: "Task",
      },
      { id: PLAN.id, revision: 1, name: PLAN.name, valid: false },
    ]);
    vi.mocked(jiraTemplates.validateJiraTemplate).mockImplementation(() => new Promise(() => {}));
    const dialog = await openDialog();
    const library = within(dialog);
    expect(await library.findByText(/Checking against Jira/u)).toBeVisible();
    fireEvent.click(item(dialog, REVIEW.name));
    await waitFor(() => expect(library.getAllByText(/Checking against Jira/u)).toHaveLength(2));

    vi.mocked(atlassian.listAtlassianConnectors).mockResolvedValue([]);
    refreshPods();
    await waitFor(() => expect(library.queryAllByText(/Checking against Jira/u)).toHaveLength(0));
    expect(library.getAllByText("LAB · Task")).toHaveLength(2);
    expect(library.getByText("Needs repair")).toBeVisible();
    expect(documentTitle(dialog)).toBe(REVIEW.name);
    expect(openFileMeta(dialog).getByText("v1")).toBeVisible();
    expect(api.saveMarkdownSkill).not.toHaveBeenCalled();
  });
});

describe("a new skill", () => {
  it("opens unsaved, becomes dirty with its text and is created by Save", async () => {
    seedStore([]);
    const dialog = await openDialog();
    expect(within(dialog).getByText("Open a skill or start a new one")).toBeInTheDocument();
    expect(
      within(dialog).getByText("Choose a skill or template, or write a new one."),
    ).toBeInTheDocument();
    // The editor is never one live region: only its alerts are announced.
    expect(dialog.querySelector("[aria-live], [aria-busy]")).toBeNull();
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

  it("withdraws the discard question when the person saves instead of answering it (#4371)", async () => {
    const dialog = await dirtyDraft();
    fireEvent.click(item(dialog, "Release plan"));
    expect(within(dialog).getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitForVersion(dialog, "v1");
    expect(within(dialog).queryByRole("alertdialog")).toBeNull();
    expect(within(dialog).queryByText(/unsaved changes/iu)).toBeNull();
    // The withdrawn question leaves nothing behind: the next edit asks nothing until a guarded leave.
    writeMarkdown(dialog, "# Draft in progress\n\nMore.\n");
    expect(within(dialog).queryByRole("alertdialog")).toBeNull();
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

describe("a delete confirmation belongs to the file it was started for", () => {
  async function startDeleteOnReview(): Promise<HTMLElement> {
    seedStore([REVIEW, PLAN]);
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole("button", { name: /Boundary review/u }));
    await waitForVersion(dialog, "v1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(within(dialog).getByRole("button", { name: "Delete skill" })).toBeInTheDocument();
    return dialog;
  }

  it("is discarded when another skill opens, so the old confirmation cannot delete it", async () => {
    const dialog = await startDeleteOnReview();
    fireEvent.click(item(dialog, "Release plan"));
    await waitFor(() => expect(documentTitle(dialog)).toBe("Release plan"));
    expect(within(dialog).queryByRole("button", { name: "Delete skill" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(api.deleteMarkdownSkill).not.toHaveBeenCalled();
  });

  it("is discarded across a new draft in between, and deleting then needs a fresh decision", async () => {
    const dialog = await startDeleteOnReview();
    newSkill(dialog);
    await waitFor(() => expect(documentTitle(dialog)).toBe("New skill"));
    expect(within(dialog).queryByRole("button", { name: "Delete skill" })).toBeNull();
    fireEvent.click(item(dialog, "Release plan"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(documentTitle(dialog)).toBe("Release plan"));
    expect(within(dialog).queryByRole("button", { name: "Delete skill" })).toBeNull();
    expect(api.deleteMarkdownSkill).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete skill" }));
    await waitFor(() => expect(api.deleteMarkdownSkill).toHaveBeenCalledOnce());
    expect(api.deleteMarkdownSkill).toHaveBeenCalledWith(PLAN);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sourceValue(dialog: HTMLElement): string {
  return (within(dialog).getByRole("textbox", { name: /· Markdown$/u }) as HTMLTextAreaElement)
    .value;
}

describe("late replies never overwrite newer work", () => {
  it("keeps text typed while a save is in flight, dirty against the confirmed baseline", async () => {
    seedStore([REVIEW]);
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole("button", { name: /Boundary review/u }));
    await waitForVersion(dialog, "v1");
    const sent = `${REVIEW.body}First edit.\n`;
    const newer = `${sent}Typed during the save.\n`;
    const reply = deferred<MarkdownSkillDocument>();
    vi.mocked(api.saveMarkdownSkill).mockImplementation(() => reply.promise);
    writeMarkdown(dialog, sent);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveMarkdownSkill).toHaveBeenCalledOnce());
    writeMarkdown(dialog, newer);
    reply.resolve({ ...REVIEW, revision: 2, digest: "2".repeat(64), body: sent });
    await waitForVersion(dialog, "v2");
    expect(sourceValue(dialog)).toBe(newer);
    expect(within(dialog).getByText("Unsaved changes")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("ignores the reply of an open that a new draft has overtaken", async () => {
    seedStore([REVIEW]);
    const dialog = await openDialog();
    const reply = deferred<MarkdownSkillDocument>();
    vi.mocked(api.readMarkdownSkill).mockImplementation(() => reply.promise);
    fireEvent.click(await within(dialog).findByRole("button", { name: /Boundary review/u }));
    await waitFor(() => expect(api.readMarkdownSkill).toHaveBeenCalledOnce());
    newSkill(dialog);
    writeMarkdown(dialog, "# Newer draft\n\nMine.\n");
    reply.resolve(REVIEW);
    await waitFor(() => expect(within(dialog).getByLabelText("Import")).toBeEnabled());
    await act(() => Promise.resolve());
    expect(documentTitle(dialog)).toBe("Newer draft");
    expect(sourceValue(dialog)).toBe("# Newer draft\n\nMine.\n");
    expect(within(dialog).getByText("Not saved yet")).toBeInTheDocument();
  });
});

describe("a pending open or import never overwrites newer edits to the visible file", () => {
  it("keeps edits typed into the open file while another skill is still being read", async () => {
    seedStore([REVIEW, PLAN]);
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole("button", { name: /Release plan/u }));
    await waitForVersion(dialog, "v1");
    const reply = deferred<MarkdownSkillDocument>();
    vi.mocked(api.readMarkdownSkill).mockImplementation(() => reply.promise);
    fireEvent.click(item(dialog, "Boundary review"));
    await waitFor(() => expect(api.readMarkdownSkill).toHaveBeenCalledTimes(2));
    const typed = `${PLAN.body}Typed while loading.\n`;
    writeMarkdown(dialog, typed);
    reply.resolve(REVIEW);
    await act(() => Promise.resolve());
    await waitFor(() => expect(within(dialog).getByLabelText("Import")).toBeEnabled());
    expect(documentTitle(dialog)).toBe("Release plan");
    expect(sourceValue(dialog)).toBe(typed);
    expect(within(dialog).getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("keeps edits typed into the open file while an imported file is still being stored", async () => {
    const store = seedStore([REVIEW]);
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole("button", { name: /Boundary review/u }));
    await waitForVersion(dialog, "v1");
    const gate = deferred<undefined>();
    const stored = vi.mocked(api.saveMarkdownSkill).getMockImplementation();
    vi.mocked(api.saveMarkdownSkill).mockImplementation(async (upload, previous) => {
      await gate.promise;
      return (stored as NonNullable<typeof stored>)(upload, previous);
    });
    const input = within(dialog).getByLabelText("Import");
    fireEvent.change(input, {
      target: { files: [new File([PLAN.body], "plan.md", { type: "text/markdown" })] },
    });
    await waitFor(() => expect(api.saveMarkdownSkill).toHaveBeenCalledOnce());
    const typed = `${REVIEW.body}Typed while importing.\n`;
    writeMarkdown(dialog, typed);
    gate.resolve(undefined);
    await waitFor(() => expect(store.all).toHaveLength(2));
    await act(() => Promise.resolve());
    await waitFor(() => expect(within(dialog).getByLabelText("Import")).toBeEnabled());
    expect(documentTitle(dialog)).toBe("Boundary review");
    expect(sourceValue(dialog)).toBe(typed);
    expect(within(dialog).getByText("Unsaved changes")).toBeInTheDocument();
  });
});

describe("a saved text the server normalized", () => {
  function fakeLibrary(preview: MarkdownSkillDocument | undefined): MarkdownSkillLibrary {
    return {
      skills: preview === undefined ? [] : [preview],
      preview,
      busy: false,
      available: true,
      error: undefined,
      refresh: vi.fn(),
      inspect: vi.fn(),
      upload: vi.fn(() => Promise.resolve()),
      remove: vi.fn(),
      download: vi.fn(),
    };
  }

  it("is adopted as text and baseline, so a CRLF draft is clean after its save", () => {
    const { result, rerender } = renderHook(
      ({ preview }: { preview: MarkdownSkillDocument | undefined }) =>
        useSkillWorkspace(fakeLibrary(preview)),
      { initialProps: { preview: undefined as MarkdownSkillDocument | undefined } },
    );
    act(() => result.current.create("# Crlf\r\n\r\nBody\r\n", "skill.md"));
    act(() => result.current.save());
    rerender({ preview: { ...REVIEW, body: "# Crlf\n\nBody\n" } });
    const view = result.current.view;
    if (view.kind !== "document") throw new TypeError("expected a document");
    expect(view.document.text).toBe("# Crlf\n\nBody\n");
    expect(view.document.saved).toBe("# Crlf\n\nBody\n");
    expect(result.current.dirty).toBe(false);
  });

  it("keeps newer typing dirty against the normalized baseline", () => {
    const { result, rerender } = renderHook(
      ({ preview }: { preview: MarkdownSkillDocument | undefined }) =>
        useSkillWorkspace(fakeLibrary(preview)),
      { initialProps: { preview: undefined as MarkdownSkillDocument | undefined } },
    );
    act(() => result.current.create("# Crlf\r\n", "skill.md"));
    act(() => result.current.save());
    act(() => result.current.edit("# Crlf\r\nmore"));
    rerender({ preview: { ...REVIEW, body: "# Crlf\n" } });
    const view = result.current.view;
    if (view.kind !== "document") throw new TypeError("expected a document");
    expect(view.document.text).toBe("# Crlf\r\nmore");
    expect(view.document.saved).toBe("# Crlf\n");
    expect(result.current.dirty).toBe(true);
  });

  it("advances the open revision after a background binding while keeping newer typing", () => {
    const { result, rerender } = renderHook(
      ({ preview }: { preview: MarkdownSkillDocument | undefined }) =>
        useSkillWorkspace(fakeLibrary(preview)),
      { initialProps: { preview: undefined as MarkdownSkillDocument | undefined } },
    );
    act(() => result.current.open(REVIEW));
    rerender({ preview: REVIEW });
    act(() => result.current.edit("New typing"));
    const bound = { ...REVIEW, revision: 2, body: "Stored binding" };
    act(() => result.current.adoptBinding(1, bound));
    expect(result.current.view).toMatchObject({
      kind: "document",
      document: { stored: bound, text: "New typing", saved: bound.body },
    });
    act(() => result.current.adoptBinding(1, { ...bound, body: "Late reply" }));
    expect(result.current.view).toMatchObject({ document: { saved: bound.body } });
    expect(result.current.canSave).toBe(true);
  });

  it("adopts a binding into a clean file under the same key and ignores one for another skill", () => {
    const { result, rerender } = renderHook(
      ({ preview }: { preview: MarkdownSkillDocument | undefined }) =>
        useSkillWorkspace(fakeLibrary(preview)),
      { initialProps: { preview: undefined as MarkdownSkillDocument | undefined } },
    );
    act(() => result.current.open(REVIEW));
    rerender({ preview: REVIEW });
    const opened = result.current.view;
    if (opened.kind !== "document") throw new TypeError("expected a document");
    act(() => result.current.adoptBinding(1, { ...PLAN, revision: 2, body: "Foreign" }));
    expect(result.current.view).toMatchObject({ document: { text: REVIEW.body } });

    const bound = { ...REVIEW, revision: 2, body: "Stored binding" };
    act(() => result.current.adoptBinding(1, bound));
    expect(result.current.view).toMatchObject({
      kind: "document",
      document: { key: opened.document.key, stored: bound, text: bound.body, saved: bound.body },
    });
    expect(result.current.dirty).toBe(false);
  });
});
