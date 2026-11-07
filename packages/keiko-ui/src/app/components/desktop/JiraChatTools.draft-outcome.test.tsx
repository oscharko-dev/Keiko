import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { JiraChatTools } from "./JiraChatTools";
import { jiraToolOutcomeView } from "./jira-tool-outcome";
import { I18N_STORAGE_KEY, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";

function draft(name: string, data: Record<string, unknown>): ChatToolExchange {
  return {
    call: { id: "draft-1", name, arguments: {} },
    result: {
      schemaVersion: 1,
      invocationId: "invocation-1",
      toolRef: null,
      projectionDigest: null,
      effectStarted: true,
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
      status: "completed",
      reason: "none",
      page: { truncated: false, reason: "none", cursor: null },
      data,
    } as NonNullable<ChatToolExchange["result"]>,
  };
}

async function show(exchange: ChatToolExchange): Promise<void> {
  await Promise.all([loadLocaleMessages("en"), loadOptionalWidgetMessages("en")]);
  localStorage.setItem(I18N_STORAGE_KEY, "en");
  render(
    <JiraChatTools
      transcript={{ schemaVersion: 1, exchanges: [exchange] }}
      turnState="completed"
    />,
  );
}

// Result shapes are pinned against the production builder and its declared result schema in
// tests/atlassian-connectors/jira-draft-result-outcome-view.test.ts; this file tests rendering.
describe("Jira draft results as the production draft tool reports them", () => {
  it("links every created issue of a completed draft without draftProgress", async () => {
    await show(
      draft("jira_draft", {
        outcome: "succeeded",
        items: [
          {
            ref: "epic",
            state: "created",
            issueKey: "SYN-1",
            browseUrl: "https://jira.example.test/browse/SYN-1",
          },
          {
            ref: "story",
            state: "existing",
            issueKey: "SYN-2",
            browseUrl: "https://jira.example.test/browse/SYN-2",
          },
        ],
        createdCount: 1,
        existingCount: 1,
      }),
    );
    expect(screen.getByRole("link", { name: /SYN-1/u })).toHaveAttribute(
      "href",
      "https://jira.example.test/browse/SYN-1",
    );
    expect(screen.getByRole("link", { name: /SYN-2/u })).toBeVisible();
  });

  it("names Jira's field error and Keiko's validation against the item's ref", async () => {
    await show(
      draft("jira_draft", {
        outcome: "partial",
        items: [
          { ref: "epic", state: "created", issueKey: "SYN-1" },
          {
            ref: "story-7",
            state: "failed",
            fieldErrors: [
              {
                fieldId: "customfield_10104",
                fieldName: "Epic Name",
                message: "Epic Name is required.",
              },
            ],
          },
          { ref: "task-9", state: "failed", validation: "required-field" },
        ],
      }),
    );
    const problems = screen.getByRole("list", { name: "What Jira said" });
    expect(problems).toHaveTextContent("story-7");
    expect(problems).toHaveTextContent("Epic Name: Epic Name is required.");
    const refused = screen.getByText(/task-9/u).closest("p");
    expect(refused).toHaveTextContent("A required Jira field was missing, so nothing was sent.");
    expect(within(problems).queryByText(/task-9/u)).toBeNull();
  });

  it("counts the keys of a compact large-draft result instead of showing nothing", async () => {
    await show(
      draft("jira_draft", {
        outcome: "succeeded",
        compact: true,
        browseUrlPrefix: "https://jira.example.test/browse/",
        omittedRowCount: 0,
        createdRanges: ["SYN-1..SYN-40", "SYN-50"],
        existingRanges: ["SYN-60..SYN-62"],
        rangesTruncated: true,
        unlistedKeyCount: 7,
        items: [],
      }),
    );
    const list = screen.getByRole("list", { name: "Jira issues" });
    expect(within(list).getByRole("link", { name: /SYN-1/u })).toHaveAttribute(
      "href",
      "https://jira.example.test/browse/SYN-1",
    );
    // 40 + 1 + 3 listed plus 7 unlisted keys, five shown.
    expect(list).toHaveTextContent("and 46 more");
  });

  it("keeps the read-result schema (items[].key) working", () => {
    const view = jiraToolOutcomeView(
      draft("jira_search", { outcome: "succeeded", items: [{ key: "KER-1" }, { key: "KER-2" }] }),
    );
    expect(view.issues.map((issue) => issue.key)).toEqual(["KER-1", "KER-2"]);
  });

  it("counts the requirements a draft batch could not draft", async () => {
    await show(
      draft("jira_draft_batch", {
        outcome: "succeeded",
        draftId: "d-1",
        itemCount: 37,
        plannedCount: 40,
        draftedCount: 37,
        failedCount: 3,
        requirementCount: 131,
        coveredRequirementCount: 128,
        failedRequirementRefs: ["R-1", "R-2", "R-3"],
      }),
    );
    expect(screen.getByText("Requirements that could not be drafted: 3.")).toBeVisible();
    expect(screen.queryByRole("list", { name: "Jira issues" })).toBeNull();
  });
});
