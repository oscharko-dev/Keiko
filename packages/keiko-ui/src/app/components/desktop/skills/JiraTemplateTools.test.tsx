import userEvent from "@testing-library/user-event";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as templates from "@/lib/jira-templates-api";
import * as skills from "@/lib/markdown-skills-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import type { JiraTemplateValidation } from "@/lib/jira-templates-api";
import { JiraTemplateTools } from "./JiraTemplateTools";
import type { MarkdownSkillLibrary } from "./useMarkdownSkillLibrary";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";

vi.mock("@/lib/jira-templates-api", () => ({
  fetchJiraTemplates: vi.fn(),
  validateJiraTemplate: vi.fn(),
  proposeJiraTemplates: vi.fn(),
}));
vi.mock("@/lib/markdown-skills-api", () => ({ readMarkdownSkill: vi.fn() }));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));
vi.mock("@/lib/atlassian-connectors-api", () => ({
  listAtlassianConnectors: vi.fn(() =>
    Promise.resolve(
      [1, 2].map((number) => ({
        displayName: `Synthetic Jira ${String(number)}`,
        deployment: "data-center",
        livePod: {
          podId: `pod-${String(number)}`,
          verificationStatus: "ok",
          verificationInProgress: false,
          capabilities: ["live-read", "live-write"],
        },
      })),
    ),
  ),
}));
vi.mock("../useConnectorRefresh", () => ({ useConnectorRefresh: vi.fn() }));

const upload = vi.fn(() => Promise.resolve());
function libraryOf(skills: MarkdownSkillLibrary["skills"]): MarkdownSkillLibrary {
  return { ...library, skills };
}
const library = {
  skills: [],
  preview: undefined,
  busy: false,
  available: true,
  error: undefined,
  refresh: vi.fn(),
  inspect: vi.fn(),
  upload,
  remove: vi.fn(),
  download: vi.fn(),
} as unknown as MarkdownSkillLibrary;

const ENTRY = {
  id: "skill-1",
  revision: 2,
  name: "Story template",
  valid: true,
  project: "SYN",
  issueType: "Story",
  activations: ["create", "transition:Ready"],
};

const DOCUMENT = {
  id: "skill-1",
  revision: 2,
  digest: "a".repeat(64),
  name: "Story template",
  byteCount: 4,
  createdAt: 1,
  body: "BODY",
};

beforeEach(() => {
  vi.mocked(templates.fetchJiraTemplates).mockResolvedValue([
    ENTRY,
    { id: "skill-2", revision: 1, name: "Broken", valid: false },
  ]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openPanel(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(
    <main>
      <JiraTemplateTools library={library} />
    </main>,
  );
  await user.click(screen.getByRole("button", { name: "Jira issue templates" }));
  await screen.findByText("Story template");
  return user;
}

const MATCH: JiraTemplateValidation = {
  valid: true,
  findings: [],
  checked: { project: true, fields: true, linkTypes: true, transitions: true },
};
const TASK = { ...ENTRY, id: "skill-task", revision: 1, name: "Task template", issueType: "Task" };

function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest("li");
  if (row === null) throw new TypeError("Missing template row");
  return row;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {
    throw new Error("Promise not initialized");
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function validateRow(
  user: ReturnType<typeof userEvent.setup>,
  name = ENTRY.name,
): Promise<void> {
  const button = within(rowFor(name)).getByRole("button", { name: "Validate against Jira" });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}

describe("Jira issue template tools", () => {
  it("stays closed and reads nothing until opened", () => {
    render(<JiraTemplateTools library={library} />);
    expect(templates.fetchJiraTemplates).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Jira issue templates" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("lists templates, marks an unreadable one and has no accessibility violations", async () => {
    await openPanel();
    expect(screen.getByText(/SYN · Story · create, transition:Ready/u)).toBeInTheDocument();
    expect(screen.getByText("Needs repair")).toBeInTheDocument();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it("validates the stored revision against the selected Pod and shows each finding", async () => {
    vi.mocked(skills.readMarkdownSkill).mockResolvedValue({
      id: "skill-1",
      revision: 2,
      digest: "a".repeat(64),
      name: "Story template",
      byteCount: 4,
      createdAt: 1,
      body: "BODY",
    });
    vi.mocked(templates.validateJiraTemplate).mockResolvedValue({
      valid: true,
      findings: [{ code: "unknown-field", subject: "Story Points" }],
      checked: { project: true, fields: true, linkTypes: true, transitions: true },
    });
    const user = await openPanel();
    const [validate] = screen.getAllByRole("button", { name: "Validate against Jira" });
    await waitFor(() => expect(validate).toBeEnabled());
    if (validate) await user.click(validate);
    expect(templates.validateJiraTemplate).toHaveBeenCalledWith(
      "pod-1",
      "BODY",
      expect.any(String),
    );
    const correlationId = vi.mocked(templates.validateJiraTemplate).mock.calls[0]?.[2];
    expect(skills.readMarkdownSkill).toHaveBeenCalledWith(
      { id: ENTRY.id, revision: ENTRY.revision, digest: "" },
      correlationId,
    );
    expect(reportClientDiagnostic).toHaveBeenCalledWith("Jira template validation started.", {
      correlationId,
    });
    expect(await screen.findByText(/Field Story Points does not exist/u)).toBeInTheDocument();
    expect(reportClientDiagnostic).toHaveBeenCalledWith("Jira template validation completed.", {
      correlationId,
    });
  });

  it("says which instance checks could not run instead of reporting a full match", async () => {
    vi.mocked(skills.readMarkdownSkill).mockResolvedValue(DOCUMENT);
    vi.mocked(templates.validateJiraTemplate).mockResolvedValue({
      valid: true,
      findings: [],
      checked: { project: true, fields: false, linkTypes: true, transitions: false },
    });
    const user = await openPanel();
    const [validate] = screen.getAllByRole("button", { name: "Validate against Jira" });
    await waitFor(() => expect(validate).toBeEnabled());
    if (validate) await user.click(validate);
    expect(await screen.findByText(/Not fully checked/u)).toHaveTextContent(
      "Jira did not provide its fields, workflow statuses",
    );
    expect(screen.queryByText("The template matches the Jira instance.")).not.toBeInTheDocument();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it("reports a match only when every instance check ran", async () => {
    vi.mocked(skills.readMarkdownSkill).mockResolvedValue(DOCUMENT);
    vi.mocked(templates.validateJiraTemplate).mockResolvedValue({
      valid: true,
      findings: [],
      checked: { project: true, fields: true, linkTypes: true, transitions: true },
    });
    const user = await openPanel();
    const [validate] = screen.getAllByRole("button", { name: "Validate against Jira" });
    await waitFor(() => expect(validate).toBeEnabled());
    if (validate) await user.click(validate);
    expect(await screen.findByText("The template matches the Jira instance.")).toBeInTheDocument();
    expect(screen.queryByText(/Not fully checked/u)).not.toBeInTheDocument();
  });

  it("re-reads templates and validates the new revision after a same-count replacement", async () => {
    const stored = (revision: number): MarkdownSkillLibrary["skills"] => [
      {
        id: "skill-1",
        revision,
        digest: String(revision).repeat(64),
        name: "Story template",
        byteCount: 4,
        createdAt: 1,
      },
    ];
    vi.mocked(skills.readMarkdownSkill).mockImplementation((reference) =>
      Promise.resolve({
        ...DOCUMENT,
        revision: reference.revision,
        body: `BODY-${String(reference.revision)}`,
      }),
    );
    vi.mocked(templates.validateJiraTemplate).mockResolvedValue({
      valid: true,
      findings: [{ code: "unknown-field", subject: "Story Points" }],
      checked: { project: true, fields: true, linkTypes: true, transitions: true },
    });
    const user = userEvent.setup();
    const view = render(<JiraTemplateTools library={libraryOf(stored(2))} />);
    await user.click(screen.getByRole("button", { name: "Jira issue templates" }));
    await screen.findByText("Story template");
    const [first] = screen.getAllByRole("button", { name: "Validate against Jira" });
    await waitFor(() => expect(first).toBeEnabled());
    if (first) await user.click(first);
    await screen.findByText(/Field Story Points does not exist/u);
    expect(templates.validateJiraTemplate).toHaveBeenLastCalledWith(
      "pod-1",
      "BODY-2",
      expect.any(String),
    );
    vi.mocked(templates.fetchJiraTemplates).mockResolvedValue([{ ...ENTRY, revision: 3 }]);
    view.rerender(<JiraTemplateTools library={libraryOf(stored(3))} />);
    await waitFor(() => expect(templates.fetchJiraTemplates).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText(/Field Story Points does not exist/u)).not.toBeInTheDocument(),
    );
    const [second] = screen.getAllByRole("button", { name: "Validate against Jira" });
    await waitFor(() => expect(second).toBeEnabled());
    if (second) await user.click(second);
    await waitFor(() =>
      expect(skills.readMarkdownSkill).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "skill-1", revision: 3 }),
        expect.any(String),
      ),
    );
    expect(templates.validateJiraTemplate).toHaveBeenLastCalledWith(
      "pod-1",
      "BODY-3",
      expect.any(String),
    );
  });

  it("withdraws the old template and its validation when the refresh after a replacement fails", async () => {
    const stored = (revision: number): MarkdownSkillLibrary["skills"] => [
      {
        id: "skill-1",
        revision,
        digest: String(revision).repeat(64),
        name: "Story template",
        byteCount: 4,
        createdAt: 1,
      },
    ];
    vi.mocked(skills.readMarkdownSkill).mockImplementation((reference) =>
      Promise.resolve({ ...DOCUMENT, revision: reference.revision, body: "BODY" }),
    );
    vi.mocked(templates.validateJiraTemplate).mockResolvedValue({
      valid: true,
      findings: [],
      checked: { project: true, fields: true, linkTypes: true, transitions: true },
    });
    const user = userEvent.setup();
    const view = render(<JiraTemplateTools library={libraryOf(stored(2))} />);
    await user.click(screen.getByRole("button", { name: "Jira issue templates" }));
    await screen.findByText("Story template");
    const [first] = screen.getAllByRole("button", { name: "Validate against Jira" });
    await waitFor(() => expect(first).toBeEnabled());
    if (first) await user.click(first);
    await screen.findByText("The template matches the Jira instance.");
    vi.mocked(templates.fetchJiraTemplates).mockRejectedValue(new Error("unavailable"));
    view.rerender(<JiraTemplateTools library={libraryOf(stored(3))} />);
    await screen.findByRole("alert");
    expect(screen.queryByText("The template matches the Jira instance.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Validate against Jira" })).not.toBeInTheDocument();
    expect(skills.readMarkdownSkill).toHaveBeenCalledTimes(1);
  });

  it("keeps a result with its template and clears it while only the next row is checking", async () => {
    vi.mocked(templates.fetchJiraTemplates).mockResolvedValue([ENTRY, TASK]);
    vi.mocked(skills.readMarkdownSkill).mockResolvedValue(DOCUMENT);
    const pending = deferred<JiraTemplateValidation>();
    vi.mocked(templates.validateJiraTemplate)
      .mockResolvedValueOnce(MATCH)
      .mockReturnValueOnce(pending.promise);
    const user = await openPanel();
    await validateRow(user);
    await screen.findByText("The template matches the Jira instance.");
    expect(
      within(rowFor(ENTRY.name)).getByText("The template matches the Jira instance."),
    ).toBeInTheDocument();
    await validateRow(user, TASK.name);
    expect(screen.queryByText("The template matches the Jira instance.")).not.toBeInTheDocument();
    expect(within(rowFor(TASK.name)).getByRole("button", { name: "Validating…" })).toBeDisabled();
    expect(
      within(rowFor(ENTRY.name)).getByRole("button", { name: "Validate against Jira" }),
    ).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Validating…" })).toHaveLength(1);
    await act(async () => {
      pending.resolve(MATCH);
    });
    expect(
      within(rowFor(TASK.name)).getByText("The template matches the Jira instance."),
    ).toBeInTheDocument();
    expect(reportClientDiagnostic).toHaveBeenCalledWith("Jira template validation completed.", {
      correlationId: vi.mocked(templates.validateJiraTemplate).mock.calls[1]?.[2],
    });
  });

  it("keeps the verified row result when an independent skill preview changes", async () => {
    vi.mocked(skills.readMarkdownSkill).mockResolvedValue(DOCUMENT);
    vi.mocked(templates.validateJiraTemplate).mockResolvedValue(MATCH);
    const user = userEvent.setup();
    const view = render(<JiraTemplateTools library={library} />);
    await user.click(screen.getByRole("button", { name: "Jira issue templates" }));
    await screen.findByText(ENTRY.name);
    await validateRow(user);
    await screen.findByText("The template matches the Jira instance.");
    view.rerender(
      <JiraTemplateTools
        library={{ ...library, preview: { ...DOCUMENT, id: TASK.id, name: TASK.name } }}
      />,
    );
    expect(
      within(rowFor(ENTRY.name)).getByText("The template matches the Jira instance."),
    ).toBeInTheDocument();
    expect(templates.fetchJiraTemplates).toHaveBeenCalledTimes(1);
  });

  it("withdraws a result on Pod changes, including returning to the original Pod", async () => {
    vi.mocked(skills.readMarkdownSkill).mockResolvedValue(DOCUMENT);
    vi.mocked(templates.validateJiraTemplate).mockResolvedValue(MATCH);
    const user = await openPanel();
    await validateRow(user);
    await screen.findByText("The template matches the Jira instance.");
    const select = screen.getByRole("combobox", { name: "Jira Pod" });
    await user.selectOptions(select, "pod-2");
    expect(screen.queryByText("The template matches the Jira instance.")).not.toBeInTheDocument();
    await user.selectOptions(select, "pod-1");
    expect(screen.queryByText("The template matches the Jira instance.")).not.toBeInTheDocument();
  });

  it("discards a late response after Pod A → B → A without ending a newer check", async () => {
    vi.mocked(skills.readMarkdownSkill).mockResolvedValue(DOCUMENT);
    const old = deferred<JiraTemplateValidation>();
    const current = deferred<JiraTemplateValidation>();
    vi.mocked(templates.validateJiraTemplate)
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const user = await openPanel();
    await validateRow(user);
    await waitFor(() => expect(templates.validateJiraTemplate).toHaveBeenCalledTimes(1));
    const select = screen.getByRole("combobox", { name: "Jira Pod" });
    expect(select).toBeEnabled();
    await user.selectOptions(select, "pod-2");
    await user.selectOptions(select, "pod-1");
    await validateRow(user);
    await waitFor(() => expect(templates.validateJiraTemplate).toHaveBeenCalledTimes(2));
    await act(async () => {
      old.resolve(MATCH);
    });
    expect(screen.queryByText("The template matches the Jira instance.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Validating…" })).toBeDisabled();
    const earlierCorrelationId = vi.mocked(templates.validateJiraTemplate).mock.calls[0]?.[2];
    const laterCorrelationId = vi.mocked(templates.validateJiraTemplate).mock.calls[1]?.[2];
    expect(earlierCorrelationId).toEqual(expect.any(String));
    expect(laterCorrelationId).toEqual(expect.any(String));
    expect(earlierCorrelationId).not.toBe(laterCorrelationId);
    expect(reportClientDiagnostic).toHaveBeenCalledWith("Jira template validation superseded.", {
      correlationId: earlierCorrelationId,
    });
    await act(async () => {
      current.resolve(MATCH);
    });
    expect(await screen.findByText("The template matches the Jira instance.")).toBeInTheDocument();
  });

  it("does not start a stale Jira validation when the stored revision changes during its read", async () => {
    const old = deferred<typeof DOCUMENT>();
    vi.mocked(skills.readMarkdownSkill).mockReturnValue(old.promise);
    vi.mocked(templates.validateJiraTemplate).mockResolvedValue(MATCH);
    const user = userEvent.setup();
    const view = render(<JiraTemplateTools library={library} />);
    await user.click(screen.getByRole("button", { name: "Jira issue templates" }));
    await screen.findByText(ENTRY.name);
    await validateRow(user);
    vi.mocked(templates.fetchJiraTemplates).mockResolvedValue([{ ...ENTRY, revision: 3 }]);
    view.rerender(<JiraTemplateTools library={libraryOf([{ ...DOCUMENT, revision: 3 }])} />);
    await waitFor(() => expect(templates.fetchJiraTemplates).toHaveBeenCalledTimes(2));
    await act(async () => {
      old.resolve(DOCUMENT);
    });
    expect(templates.validateJiraTemplate).not.toHaveBeenCalled();
    expect(screen.queryByText("The template matches the Jira instance.")).not.toBeInTheDocument();
  });

  it("discards a late result after the library changes even if its template revision remains", async () => {
    vi.mocked(skills.readMarkdownSkill).mockResolvedValue(DOCUMENT);
    const old = deferred<JiraTemplateValidation>();
    vi.mocked(templates.validateJiraTemplate).mockReturnValue(old.promise);
    const user = userEvent.setup();
    const view = render(<JiraTemplateTools library={library} />);
    await user.click(screen.getByRole("button", { name: "Jira issue templates" }));
    await screen.findByText(ENTRY.name);
    await validateRow(user);
    await waitFor(() => expect(templates.validateJiraTemplate).toHaveBeenCalledTimes(1));
    view.rerender(
      <JiraTemplateTools library={libraryOf([{ ...DOCUMENT, id: "other", revision: 3 }])} />,
    );
    await waitFor(() => expect(templates.fetchJiraTemplates).toHaveBeenCalledTimes(2));
    await act(async () => {
      old.resolve(MATCH);
    });
    expect(screen.queryByText("The template matches the Jira instance.")).not.toBeInTheDocument();
  });

  it("withdraws a completed proposal across Pod A to B to A and logs its original request once", async () => {
    vi.mocked(templates.proposeJiraTemplates).mockResolvedValue([
      { issueType: "Story", markdown: "PRIVATE_DRAFT", sampledIssueCount: 3 },
    ]);
    const user = await openPanel();
    await user.type(screen.getByLabelText("Project key"), "PRIVATE");
    await user.click(screen.getByRole("button", { name: "Propose from project" }));
    expect(await screen.findByRole("textbox", { name: "Story" })).toHaveValue("PRIVATE_DRAFT");
    const correlationId = vi.mocked(templates.proposeJiraTemplates).mock.calls[0]?.[2];
    expect(correlationId).toEqual(expect.any(String));
    const pod = screen.getByRole("combobox", { name: "Jira Pod" });
    await user.selectOptions(pod, "pod-2");
    expect(screen.queryByRole("textbox", { name: "Story" })).not.toBeInTheDocument();
    await user.selectOptions(pod, "pod-1");
    expect(screen.queryByRole("textbox", { name: "Story" })).not.toBeInTheDocument();
    const discarded = vi
      .mocked(reportClientDiagnostic)
      .mock.calls.filter(([message]) => message === "Jira template proposal superseded.");
    expect(discarded).toEqual([
      ["Jira template proposal superseded.", { correlationId, errorKind: "conflict" }],
    ]);
    expect(JSON.stringify(discarded)).not.toMatch(/PRIVATE|pod-1|pod-2|Story/u);
    expect(upload).not.toHaveBeenCalled();
    vi.mocked(templates.proposeJiraTemplates).mockResolvedValue([
      { issueType: "Story", markdown: "CURRENT_DRAFT", sampledIssueCount: 4 },
    ]);
    await user.click(screen.getByRole("button", { name: "Propose from project" }));
    expect(await screen.findByRole("textbox", { name: "Story" })).toHaveValue("CURRENT_DRAFT");
  });

  it("withdraws a completed proposal when a same-count stored library revision changes", async () => {
    vi.mocked(templates.proposeJiraTemplates).mockResolvedValue([
      { issueType: "Story", markdown: "STALE_DRAFT", sampledIssueCount: 3 },
    ]);
    const user = userEvent.setup();
    const view = render(<JiraTemplateTools library={libraryOf([DOCUMENT])} />);
    await user.click(screen.getByRole("button", { name: "Jira issue templates" }));
    await screen.findByText(ENTRY.name);
    await user.type(screen.getByLabelText("Project key"), "SYN");
    await user.click(screen.getByRole("button", { name: "Propose from project" }));
    expect(await screen.findByRole("textbox", { name: "Story" })).toHaveValue("STALE_DRAFT");
    view.rerender(<JiraTemplateTools library={libraryOf([{ ...DOCUMENT, revision: 3 }])} />);
    await waitFor(() => expect(templates.fetchJiraTemplates).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("textbox", { name: "Story" })).not.toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
  });

  it.each([
    ["en", "Jira issue templates", "Project key", "Propose from project", "Save Jira template"],
    [
      "de",
      "Jira-Vorlagen",
      "Projektschlüssel",
      "Aus Projekt vorschlagen",
      "Als Jira-Vorlage speichern",
    ],
  ] as const)(
    "names the saved formal Jira template explicitly and accessibly in %s",
    async (locale, title, project, propose, save) => {
      localStorage.setItem(I18N_STORAGE_KEY, locale);
      await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
      vi.mocked(templates.proposeJiraTemplates).mockResolvedValue([
        {
          issueType: "Story",
          markdown: "---\nkeiko: jira-issue-template\n---\n",
          sampledIssueCount: 3,
        },
      ]);
      try {
        const user = userEvent.setup();
        const view = render(
          <I18nProvider>
            <main>
              <JiraTemplateTools library={library} />
            </main>
          </I18nProvider>,
        );
        await user.click(screen.getByRole("button", { name: title }));
        await screen.findByText(ENTRY.name);
        await user.type(screen.getByLabelText(project), "SYN");
        await user.click(screen.getByRole("button", { name: propose }));
        expect(await screen.findByRole("button", { name: save })).toBeEnabled();
        expect(await axe(view.container)).toHaveNoViolations();
      } finally {
        localStorage.removeItem(I18N_STORAGE_KEY);
      }
    },
  );

  it("starts each proposal from its own Markdown, not the previous project's edits", async () => {
    vi.mocked(templates.proposeJiraTemplates).mockImplementation((_pod, projectKey) =>
      Promise.resolve([
        {
          issueType: "Story",
          markdown: `---\nproject: ${projectKey}\n---\n`,
          sampledIssueCount: projectKey === "OLD" ? 3 : 5,
        },
      ]),
    );
    const user = await openPanel();
    const key = screen.getByLabelText("Project key");
    const propose = screen.getByRole("button", { name: "Propose from project" });
    await user.type(key, "OLD");
    await waitFor(() => expect(propose).toBeEnabled());
    await user.click(propose);
    expect(await screen.findByRole("textbox", { name: "Story" })).toHaveValue(
      "---\nproject: OLD\n---\n",
    );
    await user.clear(key);
    await user.type(key, "NEW");
    await waitFor(() => expect(propose).toBeEnabled());
    await user.click(propose);
    await screen.findByText("Proposed for Story (5 issues sampled)");
    expect(screen.getByRole("textbox", { name: "Story" })).toHaveValue("---\nproject: NEW\n---\n");
    await user.click(screen.getByRole("button", { name: "Save Jira template" }));
    const [file] = upload.mock.calls[0] as unknown as [File];
    expect(await file.text()).toBe("---\nproject: NEW\n---\n");
  });

  it("proposes templates from a project and saves an edited Jira template", async () => {
    vi.mocked(templates.proposeJiraTemplates).mockResolvedValue([
      {
        issueType: "Story",
        markdown: "---\nkeiko: jira-issue-template\n---\n",
        sampledIssueCount: 3,
      },
    ]);
    const user = await openPanel();
    const propose = screen.getByRole("button", { name: "Propose from project" });
    expect(propose).toBeDisabled();
    await user.type(screen.getByLabelText("Project key"), "SYN");
    await waitFor(() => expect(propose).toBeEnabled());
    await user.click(propose);
    expect(templates.proposeJiraTemplates).toHaveBeenCalledWith("pod-1", "SYN", expect.any(String));
    await screen.findByText("Proposed for Story (3 issues sampled)");
    await user.click(screen.getByRole("button", { name: "Save Jira template" }));
    expect(upload).toHaveBeenCalledOnce();
    const [file] = upload.mock.calls[0] as unknown as [File];
    expect(file.name).toBe("Story-template.md");
  });

  it("reports a failed read without hiding the library", async () => {
    vi.mocked(templates.fetchJiraTemplates).mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<JiraTemplateTools library={library} />);
    await user.click(screen.getByRole("button", { name: "Jira issue templates" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be read");
  });
});
