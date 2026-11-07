import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import * as templates from "@/lib/jira-templates-api";
import * as skills from "@/lib/markdown-skills-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { JiraTemplateList, useJiraTemplates } from "./JiraTemplateTools";
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

// The owner's 2026-11-07 walk: the stored Epic template named project KERNBANK, the Jira project
// key is KER, and nothing said so; every create in KER ran without the project lead's rules.
const WRONG = {
  id: "skill-epic",
  revision: 1,
  name: "KERNBANK · Epic",
  valid: true,
  project: "KERNBANK",
  issueType: "Epic",
  activations: ["create"],
};
const RIGHT = { ...WRONG, id: "skill-task", name: "KER · Task", project: "KER", issueType: "Task" };

function Panel(): ReactNode {
  const jira = useJiraTemplates(library);
  return <JiraTemplateList jira={jira} library={library} openId={undefined} onOpen={vi.fn()} />;
}

beforeEach(() => {
  vi.mocked(templates.fetchJiraTemplates).mockResolvedValue([WRONG, RIGHT]);
  vi.mocked(skills.readMarkdownSkill).mockImplementation(({ id, revision }) =>
    Promise.resolve({
      id,
      revision,
      digest: "a".repeat(64),
      name: id,
      byteCount: 4,
      createdAt: 1,
      body: `BODY:${id}`,
    }),
  );
  vi.mocked(templates.validateJiraTemplate).mockImplementation((_pod, body) =>
    Promise.resolve(
      body === "BODY:skill-epic"
        ? {
            valid: true,
            findings: [{ code: "unknown-project", subject: "KERNBANK" }],
            checked: { project: false, fields: false, linkTypes: false, transitions: false },
          }
        : {
            valid: true,
            findings: [],
            checked: { project: true, fields: true, linkTypes: true, transitions: true },
          },
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function row(name: string): Promise<HTMLElement> {
  await screen.findByText(name);
  const item = screen.getByText(name).closest("li");
  if (item === null) throw new TypeError("Missing template row");
  return item;
}

/** The status line of a row carries the match state for styling and assistive output. */
function stateOf(element: HTMLElement): string | null {
  return element.closest("[data-state]")?.getAttribute("data-state") ?? null;
}

describe("Jira templates are compared with the selected Jira without a click (#4173 AC1)", () => {
  it("names a template whose project this Jira does not have, and confirms the matching one", async () => {
    render(<Panel />);
    const wrong = await row("KERNBANK · Epic");
    const notice = await within(wrong).findByText(/Project KERNBANK does not exist/u);
    expect(notice).toHaveTextContent("does not apply");
    expect(stateOf(notice)).toBe("mismatch");
    const right = await row("KER · Task");
    const match = await within(right).findByText(/matches Jira\./u);
    expect(stateOf(match)).toBe("ok");
    expect(templates.validateJiraTemplate).toHaveBeenCalledWith(
      "pod-1",
      "BODY:skill-epic",
      expect.any(String),
    );
    expect(templates.validateJiraTemplate).toHaveBeenCalledTimes(2);
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      "Jira template validation completed.",
      expect.objectContaining({ correlationId: expect.any(String) }),
    );
  });

  it("reports a failed check with its error evidence and keeps checking the other templates", async () => {
    vi.mocked(templates.validateJiraTemplate).mockRejectedValueOnce(new Error("offline"));
    render(<Panel />);
    const right = await row("KER · Task");
    expect(await within(right).findByText(/matches Jira\./u)).toBeInTheDocument();
    const wrong = await row("KERNBANK · Epic");
    const failed = within(wrong).getByText(/could not be checked against Jira right now\./u);
    expect(stateOf(failed)).toBe("mismatch");
    expect(within(wrong).queryByText(/does not exist/u)).toBeNull();
    expect(within(right).queryByText(/could not be checked/u)).toBeNull();
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      "Jira template request failed.",
      expect.objectContaining({
        correlationId: expect.any(String),
        errorKind: expect.any(String),
        errorEvidence: expect.anything(),
      }),
    );
  });
});
