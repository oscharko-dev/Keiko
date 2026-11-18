import userEvent from "@testing-library/user-event";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JiraTemplateOptions } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  bindJiraIssueTemplateText,
  jiraTemplateBindingDigest,
  jiraTemplateForInstance,
  parseJiraIssueTemplate,
  readJiraTemplateForm,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { fetchJiraTemplateOptions } from "@/lib/jira-templates-api";
import { joinMarkdownDocument, splitMarkdownDocument } from "../markdown-editor/markdown-document";
import { JiraTemplateMetadata } from "./JiraTemplateMetadata";

vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));
vi.mock("@/lib/jira-templates-api", () => ({ fetchJiraTemplateOptions: vi.fn() }));

const INSTANCE_A = "0123456789abcdef0123456789abcdef";
const INSTANCE_B = "fedcba9876543210fedcba9876543210";
const BODY = "# Aufgabe\n\n## Kontext\n";

function plain(issueType: string, extra: readonly string[] = []): string {
  return joinMarkdownDocument({
    frontMatter: [
      "keiko: jira-issue-template",
      "version: 1",
      "project: SYN",
      `issueType: ${issueType}`,
      "activateOn: [create]",
      ...extra,
    ].join("\n"),
    body: BODY,
  });
}

function boundTo(instance: string): string {
  const markdown = plain("Aufgabe", ["requiredFields: [Team, Prio]"]);
  const parsed = parseJiraIssueTemplate(markdown);
  if (!parsed.ok) throw new TypeError("Expected a parseable template");
  const ids = { issueTypeId: "10002", requiredFieldIds: ["customfield_1", "priority"] };
  const digest = jiraTemplateBindingDigest(instance, parsed.template, ids);
  return bindJiraIssueTemplateText(markdown, { digest, ...ids }) ?? "";
}

function answers(types: JiraTemplateOptions): void {
  vi.mocked(fetchJiraTemplateOptions).mockImplementation((selection) => {
    if (selection.projectKey === undefined)
      return Promise.resolve({ kind: "projects", projects: [{ key: "SYN", name: "Syn" }] });
    if (selection.issueTypeId === undefined) return Promise.resolve(types);
    return Promise.resolve({
      kind: "details",
      fields: [
        { id: "customfield_1", name: "Team", required: false },
        { id: "priority", name: "Prio", required: false },
      ],
      statuses: [],
      ambiguousFieldNames: [],
    });
  });
}

let latest = "";

function Harness({ initial }: { readonly initial: string }): ReactNode {
  const [markdown, setMarkdown] = useState(initial);
  latest = markdown;
  const parts = splitMarkdownDocument(markdown);
  const form = readJiraTemplateForm(parts.frontMatter ?? "");
  if (form === undefined) return null;
  return (
    <JiraTemplateMetadata
      value={parts.frontMatter ?? ""}
      form={form}
      markdown={markdown}
      stale={false}
      podId="pod"
      onChange={(frontMatter) =>
        setMarkdown(joinMarkdownDocument({ frontMatter, body: parts.body }))
      }
    />
  );
}

beforeEach(() => {
  vi.mocked(fetchJiraTemplateOptions).mockReset();
});
afterEach(cleanup);

describe("issue type picks", () => {
  it("never writes a name that reads as a native id or that the grammar cannot keep (PRRT_kwDOSqilAM65BHdB)", async () => {
    answers({
      kind: "types",
      instanceId: INSTANCE_A,
      issueTypes: [
        { id: "71", name: "31" },
        { id: "72", name: "Bug\tfix" },
        { id: "73", name: "Story" },
      ],
    });
    render(<Harness initial={plain('""')} />);
    const select = await screen.findByRole("combobox", { name: /issue type/i });
    await waitFor(() => expect(select.querySelectorAll("option").length).toBeGreaterThan(1));
    const options = Array.from(select.querySelectorAll("option"));
    const state = (id: string): boolean | undefined =>
      options.find((option) => option.value === id)?.disabled;
    expect(state("71")).toBe(true);
    expect(state("72")).toBe(true);
    expect(state("73")).toBe(false);
    await userEvent.selectOptions(select, "73");
    expect(parseJiraIssueTemplate(latest)).toMatchObject({
      ok: true,
      template: { issueType: "Story" },
    });
  });
});

describe("guided rule edits against the loaded Jira (PRRT_kwDOSqilAM65BJIV)", () => {
  const types = (instanceId: string): JiraTemplateOptions => ({
    kind: "types",
    instanceId,
    issueTypes: [{ id: "10002", name: "Aufgabe" }],
  });

  async function openRules(): Promise<void> {
    // The Jira identity is known only once the issue types were read.
    const type = await screen.findByRole("combobox", { name: /issue type/i });
    await waitFor(() => expect(type.querySelectorAll("option").length).toBeGreaterThan(1));
    await userEvent.click(
      await screen.findByText(/template rules|chat\.skills\.jira\.form\.rules$/i),
    );
  }

  it("keeps the rules locked while the binding belongs to another Jira", async () => {
    answers(types(INSTANCE_B));
    render(<Harness initial={boundTo(INSTANCE_A)} />);
    await openRules();
    const before = latest;
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: /required field/i }).closest("fieldset"),
      ).toHaveProperty("disabled", true);
    });
    const remove = await screen.findAllByRole("button", { name: /remove/i });
    await userEvent.click(remove[0] as HTMLElement);
    expect(latest).toBe(before);
  });

  it("lets the rules be edited when the loaded Jira confirms the binding", async () => {
    answers(types(INSTANCE_A));
    render(<Harness initial={boundTo(INSTANCE_A)} />);
    await openRules();
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: /required field/i }).closest("fieldset"),
      ).toHaveProperty("disabled", false);
    });
  });
  it("refuses guided rule edits while the strict parser rejects the document, keeping the binding digest true", async () => {
    answers(types(INSTANCE_A));
    // The form reader still succeeds, the strict parser does not: `summaryMinLength` has no number.
    const invalid = boundTo(INSTANCE_A).replace(
      "requiredFields:",
      "summaryMinLength:\nrequiredFields:",
    );
    expect(parseJiraIssueTemplate(invalid).ok).toBe(false);
    expect(readJiraTemplateForm(splitMarkdownDocument(invalid).frontMatter ?? "")).toBeDefined();
    render(<Harness initial={invalid} />);
    await openRules();
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: /required field/i }).closest("fieldset"),
      ).toHaveProperty("disabled", true);
    });
    const remove = await screen.findAllByRole("button", { name: /remove/i });
    await userEvent.click(remove[0] as HTMLElement);
    expect(latest).toBe(invalid);
    // Restoring the number leaves a document whose binding still confirms for the Jira.
    const restored = invalid.replace("summaryMinLength:", "summaryMinLength: 5");
    const parsed = parseJiraIssueTemplate(restored);
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(jiraTemplateForInstance(parsed.template, INSTANCE_A).binding).toBeDefined();
  });
});
