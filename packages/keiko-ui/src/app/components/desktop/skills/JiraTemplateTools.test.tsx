import userEvent from "@testing-library/user-event";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as templates from "@/lib/jira-templates-api";
import * as skills from "@/lib/markdown-skills-api";
import { JiraTemplateTools } from "./JiraTemplateTools";
import type { MarkdownSkillLibrary } from "./useMarkdownSkillLibrary";

vi.mock("@/lib/jira-templates-api", () => ({
  fetchJiraTemplates: vi.fn(),
  validateJiraTemplate: vi.fn(),
  proposeJiraTemplates: vi.fn(),
}));
vi.mock("@/lib/markdown-skills-api", () => ({ readMarkdownSkill: vi.fn() }));
vi.mock("@/lib/atlassian-connectors-api", () => ({
  listAtlassianConnectors: vi.fn(() =>
    Promise.resolve([
      {
        displayName: "Synthetic Jira",
        deployment: "data-center",
        livePod: {
          podId: "pod-1",
          verificationStatus: "ok",
          verificationInProgress: false,
          capabilities: ["live-read", "live-write"],
        },
      },
    ]),
  ),
}));
vi.mock("../useConnectorRefresh", () => ({ useConnectorRefresh: vi.fn() }));

const upload = vi.fn(() => Promise.resolve());
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
    expect(templates.validateJiraTemplate).toHaveBeenCalledWith("pod-1", "BODY");
    expect(await screen.findByText(/Field Story Points does not exist/u)).toBeInTheDocument();
  });

  it("proposes templates from a project and saves an edited one as a skill", async () => {
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
    expect(templates.proposeJiraTemplates).toHaveBeenCalledWith("pod-1", "SYN");
    await screen.findByText("Proposed for Story (3 issues sampled)");
    await user.click(screen.getByRole("button", { name: "Save as skill" }));
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
