import { cleanup, render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import * as skills from "@/lib/markdown-skills-api";
import { JiraTemplateList, useJiraTemplates } from "./JiraTemplateTools";
import type { MarkdownSkillLibrary } from "./useMarkdownSkillLibrary";

// #4354 AC3: a stored template names a Jira project the connected Jira does not have. The real
// templates API module runs; only the transport below it answers with the bodies the real routes
// return (markdown-skill-jira-template-routes.test.ts pins those bodies against a Jira that answers
// 404 for the project), so the sentence the person reads is proven end to end.
const transport = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@/lib/coding-app-session-client", () => ({
  codingAppSessionPairingSettled: (): Promise<boolean> => Promise.resolve(true),
}));
vi.mock("@/lib/http", async (original) => ({
  ...(await original<typeof import("@/lib/http")>()),
  bffFetchJson: (path: string): Promise<unknown> => {
    transport.calls.push(path);
    if (path === "/api/skills/jira-templates")
      return Promise.resolve({
        templates: [
          {
            id: "skill-epic",
            revision: 1,
            name: "KERNBANK · Epic",
            valid: true,
            project: "KERNBANK",
            issueType: "Epic",
            activations: ["create"],
          },
        ],
      });
    if (path === "/api/skills/jira-templates/validate")
      return Promise.resolve({
        valid: true,
        template: { project: "KERNBANK", issueType: "Epic", activations: ["create"] },
        findings: [{ code: "unknown-project", subject: "KERNBANK" }],
        checked: { project: false, fields: true, linkTypes: true, transitions: false },
      });
    return Promise.reject(new Error(`Unexpected request ${path}`));
  },
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

function Panel(): ReactNode {
  const jira = useJiraTemplates(library);
  return <JiraTemplateList jira={jira} library={library} openId={undefined} onOpen={vi.fn()} />;
}

beforeEach(() => {
  transport.calls.length = 0;
  vi.mocked(skills.readMarkdownSkill).mockResolvedValue({
    id: "skill-epic",
    revision: 1,
    digest: "a".repeat(64),
    name: "skill-epic",
    byteCount: 4,
    createdAt: 1,
    body: "BODY",
  });
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

describe("a template naming a project the connected Jira does not have", () => {
  it("tells the person in the template list, unprompted, that it does not apply", async () => {
    const { container } = render(<Panel />);
    const item = await row("KERNBANK · Epic");
    const notice = await within(item).findByText(
      /Project KERNBANK does not exist or is not visible/u,
    );
    expect(notice).toHaveTextContent("Not applied");
    expect(notice.closest("[data-state]")?.getAttribute("data-state")).toBe("mismatch");
    expect(within(item).queryByText(/Matches Jira/u)).toBeNull();
    expect(transport.calls).toContain("/api/skills/jira-templates/validate");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("says the same in German through the catalog", async () => {
    await Promise.all([loadLocaleMessages("de"), loadOptionalWidgetMessages("de")]);
    window.localStorage.setItem("keiko.locale", "de");
    const { container, unmount } = render(
      <I18nProvider>
        <Panel />
      </I18nProvider>,
    );
    try {
      const item = await row("KERNBANK · Epic");
      const notice = await within(item).findByText(
        /Das Projekt KERNBANK existiert nicht oder ist nicht sichtbar/u,
      );
      expect(notice).toHaveTextContent("Nicht angewendet");
      expect(await axe(container)).toHaveNoViolations();
    } finally {
      unmount();
      window.localStorage.removeItem("keiko.locale");
      document.documentElement.lang = "en";
    }
  });
});
