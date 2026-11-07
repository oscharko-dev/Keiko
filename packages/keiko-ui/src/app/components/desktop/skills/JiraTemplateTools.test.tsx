import userEvent from "@testing-library/user-event";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import * as templates from "@/lib/jira-templates-api";
import * as skills from "@/lib/markdown-skills-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import type { JiraTemplateValidation } from "@/lib/jira-templates-api";
import {
  JiraTemplateList,
  JiraTemplateProposal,
  useJiraTemplates,
  type JiraTemplates,
} from "./JiraTemplateTools";
import type { MarkdownSkillLibrary } from "./useMarkdownSkillLibrary";

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

const library = {
  skills: [],
  preview: undefined,
  busy: false,
  available: true,
  error: undefined,
  refresh: vi.fn(),
  inspect: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  download: vi.fn(),
} as unknown as MarkdownSkillLibrary;

function libraryOf(stored: MarkdownSkillLibrary["skills"]): MarkdownSkillLibrary {
  return { ...library, skills: stored };
}

const ENTRY = {
  id: "skill-1",
  revision: 2,
  name: "Story template",
  valid: true,
  project: "SYN",
  issueType: "Story",
  activations: ["create", "transition:Ready"],
};
const TASK = { ...ENTRY, id: "skill-task", revision: 1, name: "Task template", issueType: "Task" };

const DOCUMENT = {
  id: "skill-1",
  revision: 2,
  digest: "a".repeat(64),
  name: "Story template",
  byteCount: 4,
  createdAt: 1,
  body: "BODY",
};

const MATCH: JiraTemplateValidation = {
  valid: true,
  findings: [],
  checked: { project: true, fields: true, linkTypes: true, transitions: true },
};
const MATCHES = "Synthetic: matches Jira.";

let latest: JiraTemplates | undefined;
const onOpen = vi.fn();
const onDraft = vi.fn();

/** The templates, as the dialog composes them: the hook once, then the library-column parts. */
function Panel({ stored }: { readonly stored: MarkdownSkillLibrary }): ReactNode {
  const jira = useJiraTemplates(stored);
  latest = jira;
  return (
    <main>
      <JiraTemplateList jira={jira} library={stored} openId={undefined} onOpen={onOpen} />
      <JiraTemplateProposal jira={jira} onDraft={onDraft} />
    </main>
  );
}

beforeEach(() => {
  latest = undefined;
  vi.mocked(templates.fetchJiraTemplates).mockResolvedValue([
    ENTRY,
    { id: "skill-2", revision: 1, name: "Broken", valid: false },
  ]);
  vi.mocked(skills.readMarkdownSkill).mockResolvedValue(DOCUMENT);
  vi.mocked(templates.validateJiraTemplate).mockResolvedValue(MATCH);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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

async function row(name: string): Promise<HTMLElement> {
  await screen.findByText(name);
  return rowFor(name);
}

const SYN_MATCH = /SYN · Story — matches Jira\./u;

describe("the template list", () => {
  it("reads the templates at once and names which stored skills are templates", async () => {
    render(<Panel stored={library} />);
    await screen.findByText("Story template");
    expect(templates.fetchJiraTemplates).toHaveBeenCalledTimes(1);
    expect(latest?.templateIds?.has(ENTRY.id)).toBe(true);
    expect(latest?.templateIds?.has("skill-2")).toBe(true);
    expect(latest?.templateIds?.has("unrelated")).toBe(false);
  });

  it("has no template ids until the list was read, and an empty set when the read failed", async () => {
    vi.mocked(templates.fetchJiraTemplates).mockRejectedValue(new Error("offline"));
    render(<Panel stored={library} />);
    expect(latest?.templateIds).toBeUndefined();
    expect(await screen.findAllByRole("alert")).not.toHaveLength(0);
    await waitFor(() => expect(latest?.templateIds?.size).toBe(0));
  });

  it("lists templates with project and issue type, marks an unreadable one and is accessible", async () => {
    render(<Panel stored={libraryOf([DOCUMENT])} />);
    const story = await row("Story template");
    await within(story).findByText(/matches Jira\./u);
    expect(within(story).getByText(/SYN · Story — /u)).toBeInTheDocument();
    expect(within(rowFor("Broken")).getByText("Needs repair")).toBeInTheDocument();
    // An unreadable template is never sent to Jira.
    expect(templates.validateJiraTemplate).toHaveBeenCalledTimes(1);
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it("opens a template through its library entry, and disables one the library does not hold", async () => {
    const user = userEvent.setup();
    render(<Panel stored={libraryOf([DOCUMENT])} />);
    const story = await row("Story template");
    await user.click(within(story).getByRole("button"));
    expect(onOpen).toHaveBeenCalledWith(DOCUMENT);
    expect(within(rowFor("Broken")).getByRole("button")).toBeDisabled();
  });

  it("reports a failed read without hiding the library", async () => {
    vi.mocked(templates.fetchJiraTemplates).mockRejectedValue(new Error("offline"));
    render(<Panel stored={library} />);
    expect(await screen.findAllByText(/could not be read/u)).not.toHaveLength(0);
    expect(screen.queryByText("Needs repair")).toBeNull();
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      "Jira template request failed.",
      expect.objectContaining({ correlationId: expect.any(String) }),
    );
  });
});

describe("the automatic check names its findings", () => {
  it("compares the stored revision with the selected Pod and shows each finding", async () => {
    vi.mocked(templates.validateJiraTemplate).mockResolvedValue({
      valid: true,
      findings: [{ code: "unknown-field", subject: "Story Points" }],
      checked: { project: true, fields: true, linkTypes: true, transitions: true },
    });
    render(<Panel stored={library} />);
    expect(await screen.findByText(/Field Story Points does not exist/u)).toBeInTheDocument();
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
    expect(reportClientDiagnostic).toHaveBeenCalledWith("Jira template validation completed.", {
      correlationId,
    });
  });

  it("says which instance checks could not run instead of reporting a full match", async () => {
    vi.mocked(templates.validateJiraTemplate).mockResolvedValue({
      valid: true,
      findings: [],
      checked: { project: true, fields: false, linkTypes: true, transitions: false },
    });
    render(<Panel stored={library} />);
    expect(
      await screen.findByText(/matches Jira; fields, workflow statuses could not be read\./u),
    ).toBeInTheDocument();
    expect(screen.queryByText(/— matches Jira\.$/u)).toBeNull();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it("reports a match only when every instance check ran", async () => {
    render(<Panel stored={library} />);
    expect(await screen.findByText(SYN_MATCH)).toBeInTheDocument();
    expect(screen.queryByText(/could not be read\./u)).toBeNull();
  });

  it("reports a template Jira itself judged invalid as needing repair", async () => {
    vi.mocked(templates.validateJiraTemplate).mockResolvedValue({ valid: false } as never);
    render(<Panel stored={library} />);
    expect(await within(await row("Story template")).findByText(/Needs repair/u)).toBeVisible();
  });

  it("shows the checking state while a check is running", async () => {
    const pending = deferred<JiraTemplateValidation>();
    vi.mocked(templates.validateJiraTemplate).mockReturnValue(pending.promise);
    render(<Panel stored={library} />);
    expect(
      await within(await row("Story template")).findByText(/checking against Jira…/u),
    ).toBeInTheDocument();
    await act(async () => {
      pending.resolve(MATCH);
    });
    expect(await screen.findByText(SYN_MATCH)).toBeInTheDocument();
  });

  it("keeps a result with its template while only the next row is still being checked", async () => {
    vi.mocked(templates.fetchJiraTemplates).mockResolvedValue([ENTRY, TASK]);
    vi.mocked(skills.readMarkdownSkill).mockImplementation(({ id }) =>
      Promise.resolve({ ...DOCUMENT, id, body: `BODY:${id}` }),
    );
    const pending = deferred<JiraTemplateValidation>();
    vi.mocked(templates.validateJiraTemplate).mockImplementation((_pod, body) =>
      body === "BODY:skill-1" ? Promise.resolve(MATCH) : pending.promise,
    );
    render(<Panel stored={library} />);
    expect(await within(await row(ENTRY.name)).findByText(/matches Jira\./u)).toBeInTheDocument();
    expect(within(rowFor(TASK.name)).getByText(/checking against Jira…/u)).toBeInTheDocument();
    expect(within(rowFor(TASK.name)).queryByText(/matches Jira\./u)).toBeNull();
    await act(async () => {
      pending.resolve(MATCH);
    });
    expect(await within(rowFor(TASK.name)).findByText(/matches Jira\./u)).toBeInTheDocument();
  });
});

describe("the automatic check follows the stored library", () => {
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

  it("re-reads templates and checks the new revision after a same-count replacement", async () => {
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
    const view = render(<Panel stored={libraryOf(stored(2))} />);
    await screen.findByText(/Field Story Points does not exist/u);
    expect(templates.validateJiraTemplate).toHaveBeenLastCalledWith(
      "pod-1",
      "BODY-2",
      expect.any(String),
    );
    vi.mocked(templates.fetchJiraTemplates).mockResolvedValue([{ ...ENTRY, revision: 3 }]);
    view.rerender(<Panel stored={libraryOf(stored(3))} />);
    await waitFor(() => expect(templates.fetchJiraTemplates).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(templates.validateJiraTemplate).toHaveBeenLastCalledWith(
        "pod-1",
        "BODY-3",
        expect.any(String),
      ),
    );
    expect(skills.readMarkdownSkill).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "skill-1", revision: 3 }),
      expect.any(String),
    );
  });

  it("withdraws the old template and its result when the refresh after a replacement fails", async () => {
    const view = render(<Panel stored={libraryOf(stored(2))} />);
    await screen.findByText(SYN_MATCH);
    vi.mocked(templates.fetchJiraTemplates).mockRejectedValue(new Error("unavailable"));
    view.rerender(<Panel stored={libraryOf(stored(3))} />);
    await screen.findAllByText(/could not be read/u);
    expect(screen.queryByText(SYN_MATCH)).toBeNull();
    expect(screen.queryByText("Story template")).toBeNull();
    expect(skills.readMarkdownSkill).toHaveBeenCalledTimes(1);
    expect(templates.validateJiraTemplate).toHaveBeenCalledTimes(1);
  });

  it("does not validate a stale body when the stored revision changes during its read", async () => {
    const old = deferred<typeof DOCUMENT>();
    vi.mocked(skills.readMarkdownSkill).mockImplementation((reference) =>
      reference.revision === 2
        ? old.promise
        : Promise.resolve({ ...DOCUMENT, revision: 3, body: "BODY-3" }),
    );
    const view = render(<Panel stored={libraryOf(stored(2))} />);
    await waitFor(() => expect(skills.readMarkdownSkill).toHaveBeenCalledTimes(1));
    vi.mocked(templates.fetchJiraTemplates).mockResolvedValue([{ ...ENTRY, revision: 3 }]);
    view.rerender(<Panel stored={libraryOf(stored(3))} />);
    await screen.findByText(SYN_MATCH);
    await act(async () => {
      old.resolve({ ...DOCUMENT, body: "BODY-2" });
    });
    expect(templates.validateJiraTemplate).not.toHaveBeenCalledWith(
      expect.anything(),
      "BODY-2",
      expect.anything(),
    );
    expect(screen.getByText(SYN_MATCH)).toBeInTheDocument();
  });

  it("ignores a late result of an earlier library state and shows the current one", async () => {
    const old = deferred<JiraTemplateValidation>();
    const current = deferred<JiraTemplateValidation>();
    vi.mocked(templates.validateJiraTemplate)
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const view = render(<Panel stored={library} />);
    await waitFor(() => expect(templates.validateJiraTemplate).toHaveBeenCalledTimes(1));
    view.rerender(<Panel stored={libraryOf([{ ...DOCUMENT, id: "other", revision: 3 }])} />);
    await waitFor(() => expect(templates.fetchJiraTemplates).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(templates.validateJiraTemplate).toHaveBeenCalledTimes(2));
    await act(async () => {
      old.resolve(MATCH);
    });
    expect(screen.queryByText(SYN_MATCH)).toBeNull();
    expect(screen.getByText(/checking against Jira…/u)).toBeInTheDocument();
    await act(async () => {
      current.resolve(MATCH);
    });
    expect(await screen.findByText(SYN_MATCH)).toBeInTheDocument();
  });

  it("keeps the verified result when only an independent skill preview changes", async () => {
    const view = render(<Panel stored={library} />);
    await screen.findByText(SYN_MATCH);
    view.rerender(
      <Panel stored={{ ...library, preview: { ...DOCUMENT, id: TASK.id, name: TASK.name } }} />,
    );
    expect(screen.getByText(SYN_MATCH)).toBeInTheDocument();
    expect(templates.fetchJiraTemplates).toHaveBeenCalledTimes(1);
    expect(templates.validateJiraTemplate).toHaveBeenCalledTimes(1);
  });
});

describe("the automatic check follows the selected Pod", () => {
  it("withdraws a result on Pod changes, including returning to the original Pod", async () => {
    const pod2 = deferred<JiraTemplateValidation>();
    vi.mocked(templates.validateJiraTemplate).mockImplementation((pod) =>
      pod === "pod-2" ? pod2.promise : Promise.resolve(MATCH),
    );
    const user = userEvent.setup();
    render(<Panel stored={library} />);
    await screen.findByText(SYN_MATCH);
    const select = await screen.findByRole("combobox", { name: "Jira Pod" });
    await user.selectOptions(select, "pod-2");
    expect(screen.queryByText(SYN_MATCH)).toBeNull();
    expect(await screen.findByText(/checking against Jira…/u)).toBeInTheDocument();
    expect(templates.validateJiraTemplate).toHaveBeenLastCalledWith(
      "pod-2",
      "BODY",
      expect.any(String),
    );
    await user.selectOptions(select, "pod-1");
    // The earlier pod-1 result is not reused: the template is compared with that Jira again.
    await waitFor(() => expect(templates.validateJiraTemplate).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(SYN_MATCH)).toBeInTheDocument();
  });

  it("discards a late response after Pod A → B → A without ending a newer check", async () => {
    const old = deferred<JiraTemplateValidation>();
    const current = deferred<JiraTemplateValidation>();
    vi.mocked(templates.validateJiraTemplate).mockImplementation((pod) => {
      if (pod === "pod-2") return new Promise<never>(() => undefined);
      return vi.mocked(templates.validateJiraTemplate).mock.calls.length === 1
        ? old.promise
        : current.promise;
    });
    const user = userEvent.setup();
    render(<Panel stored={library} />);
    await waitFor(() => expect(templates.validateJiraTemplate).toHaveBeenCalledTimes(1));
    const select = await screen.findByRole("combobox", { name: "Jira Pod" });
    await user.selectOptions(select, "pod-2");
    await user.selectOptions(select, "pod-1");
    await waitFor(() => expect(templates.validateJiraTemplate).toHaveBeenCalledTimes(3));
    await act(async () => {
      old.resolve({
        valid: true,
        findings: [{ code: "unknown-project", subject: "STALE" }],
        checked: { project: true, fields: true, linkTypes: true, transitions: true },
      });
    });
    expect(screen.queryByText(/STALE/u)).toBeNull();
    expect(screen.queryByText(SYN_MATCH)).toBeNull();
    expect(screen.getByText(/checking against Jira…/u)).toBeInTheDocument();
    await act(async () => {
      current.resolve(MATCH);
    });
    expect(await screen.findByText(SYN_MATCH)).toBeInTheDocument();
  });

  it("offers the Pod choice only when there are several ready Pods", async () => {
    render(<Panel stored={library} />);
    expect(await screen.findByRole("combobox", { name: "Jira Pod" })).toBeEnabled();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("offers no Pod choice for a single ready Pod, and asks for one when there is none", async () => {
    const connectors = await import("@/lib/atlassian-connectors-api");
    vi.mocked(connectors.listAtlassianConnectors).mockResolvedValueOnce([]);
    render(<Panel stored={library} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Connect a ready Jira Pod");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("button", { name: "Propose from project" })).toBeDisabled();
    expect(templates.validateJiraTemplate).not.toHaveBeenCalled();
  });
});

describe("template proposals", () => {
  it("proposes templates from a project and opens one in the editor with a safe file name", async () => {
    vi.mocked(templates.proposeJiraTemplates).mockResolvedValue([
      {
        issueType: "Sub-task / Bug",
        markdown: "---\nkeiko: jira-issue-template\n---\n",
        sampledIssueCount: 3,
      },
    ]);
    const user = userEvent.setup();
    render(<Panel stored={library} />);
    await screen.findByText("Story template");
    const propose = screen.getByRole("button", { name: "Propose from project" });
    expect(propose).toBeDisabled();
    await user.type(screen.getByLabelText("Project key"), "SYN");
    await waitFor(() => expect(propose).toBeEnabled());
    await user.click(propose);
    expect(templates.proposeJiraTemplates).toHaveBeenCalledWith("pod-1", "SYN", expect.any(String));
    await screen.findByText("Proposed for Sub-task / Bug (3 issues sampled)");
    expect(onDraft).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Open in editor" }));
    expect(onDraft).toHaveBeenCalledExactlyOnceWith(
      "---\nkeiko: jira-issue-template\n---\n",
      "Sub-task-Bug-template.md",
    );
  });

  it("starts each proposal from its own Markdown, never the previous project's", async () => {
    vi.mocked(templates.proposeJiraTemplates).mockImplementation((_pod, projectKey) =>
      Promise.resolve([
        {
          issueType: "Story",
          markdown: `---\nproject: ${projectKey}\n---\n`,
          sampledIssueCount: projectKey === "OLD" ? 3 : 5,
        },
      ]),
    );
    const user = userEvent.setup();
    render(<Panel stored={library} />);
    await screen.findByText("Story template");
    const key = screen.getByLabelText("Project key");
    const propose = screen.getByRole("button", { name: "Propose from project" });
    await user.type(key, "OLD");
    await waitFor(() => expect(propose).toBeEnabled());
    await user.click(propose);
    await screen.findByText("Proposed for Story (3 issues sampled)");
    await user.click(screen.getByRole("button", { name: "Open in editor" }));
    expect(onDraft).toHaveBeenLastCalledWith("---\nproject: OLD\n---\n", "Story-template.md");
    await user.clear(key);
    await user.type(key, "NEW");
    await waitFor(() => expect(propose).toBeEnabled());
    await user.click(propose);
    await screen.findByText("Proposed for Story (5 issues sampled)");
    expect(screen.queryByText("Proposed for Story (3 issues sampled)")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open in editor" }));
    expect(onDraft).toHaveBeenLastCalledWith("---\nproject: NEW\n---\n", "Story-template.md");
    expect(onDraft).toHaveBeenCalledTimes(2);
  });

  it("says when a project yields nothing, and rejects keys that are not a project key", async () => {
    vi.mocked(templates.proposeJiraTemplates).mockResolvedValue([]);
    const user = userEvent.setup();
    render(<Panel stored={library} />);
    await screen.findByText("Story template");
    const key = screen.getByLabelText("Project key");
    const propose = screen.getByRole("button", { name: "Propose from project" });
    await user.type(key, "1BAD");
    await waitFor(() => expect(propose).toBeDisabled());
    await user.clear(key);
    await user.type(key, "  SYN  ");
    await waitFor(() => expect(propose).toBeEnabled());
    await user.click(propose);
    expect(
      await screen.findByText("No template could be derived from this project."),
    ).toBeInTheDocument();
    expect(templates.proposeJiraTemplates).toHaveBeenCalledWith("pod-1", "SYN", expect.any(String));
  });

  it("reports a failed proposal and keeps the library list", async () => {
    vi.mocked(templates.proposeJiraTemplates).mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<Panel stored={library} />);
    await screen.findByText("Story template");
    await user.type(screen.getByLabelText("Project key"), "SYN");
    const propose = screen.getByRole("button", { name: "Propose from project" });
    await waitFor(() => expect(propose).toBeEnabled());
    await user.click(propose);
    expect(await screen.findAllByText(/could not be read/u)).not.toHaveLength(0);
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      "Jira template request failed.",
      expect.objectContaining({ correlationId: expect.any(String) }),
    );
  });
});
