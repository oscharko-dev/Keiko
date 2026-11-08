import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import {
  draftResult,
  type DraftItemResult,
} from "../../packages/keiko-server/src/atlassian/jiraChatDraft.js";
import { JIRA_MUTATION_DECLARATIONS } from "../../packages/keiko-server/src/atlassian/jiraManagedMutationDescriptors.js";
import { jiraToolOutcomeView } from "../../packages/keiko-ui/src/app/components/desktop/jira-tool-outcome.js";

// The Chat card reads the result the production draft builder returns. Fixtures here are produced
// by that builder and checked against the declared result schema, so a schema change that the
// card does not follow turns this red instead of leaving a hand-written literal green.
const BASE_URL = "https://jira.example.test";
const SCHEMA = JIRA_MUTATION_DECLARATIONS.find((entry) => entry.name === "jira.draft")?.descriptor
  .resultSchema;

function viewOf(items: readonly DraftItemResult[]): ReturnType<typeof jiraToolOutcomeView> {
  const { data } = draftResult(BASE_URL, items);
  expect(describeCatalogSchemaMismatch(SCHEMA ?? {}, data)).toBeUndefined();
  const exchange = {
    call: { id: "draft-1", name: "jira_draft", arguments: {} },
    result: { status: "completed", data },
  } as unknown as ChatToolExchange;
  return jiraToolOutcomeView(exchange);
}

describe("jira.draft result as the Chat outcome card reads it", () => {
  it("links created and existing issues of a completed draft", () => {
    const view = viewOf([
      { ref: "epic", state: "created", issueKey: "SYN-1" },
      { ref: "story", state: "existing", issueKey: "SYN-2" },
    ]);
    expect(view.issues).toEqual([
      { key: "SYN-1", href: "https://jira.example.test/browse/SYN-1" },
      { key: "SYN-2", href: "https://jira.example.test/browse/SYN-2" },
    ]);
  });

  it("ties Jira's field errors and Keiko's validation to each failed item's ref", () => {
    const view = viewOf([
      { ref: "epic", state: "created", issueKey: "SYN-1" },
      {
        ref: "story-7",
        state: "failed",
        detail: {
          fieldErrors: [
            {
              fieldId: "customfield_10104",
              fieldName: "Epic Name",
              message: "Epic Name is required.",
            },
          ],
        },
      },
      { ref: "task-9", state: "failed", detail: { validation: "required-field" } },
    ]);
    expect(view.problems).toEqual([
      { ref: "story-7", field: "Epic Name", message: "Epic Name is required." },
    ]);
    expect(view.itemValidations).toEqual([{ ref: "task-9", validation: "required-field" }]);
  });

  it("lists the keys of a compact large draft with links and counts the rest", () => {
    const items: DraftItemResult[] = Array.from({ length: 1200 }, (_, index) => ({
      ref: `item-${String(index)}`,
      state: "created",
      issueKey: `SYN-${String(index + 1)}`,
    }));
    const { data } = draftResult(BASE_URL, items);
    expect(data).toMatchObject({ compact: true, items: [] });
    const view = viewOf(items);
    expect(view.issues.map((issue) => issue.key)).toEqual([
      "SYN-1",
      "SYN-2",
      "SYN-3",
      "SYN-4",
      "SYN-5",
    ]);
    expect(view.issues[0]?.href).toBe("https://jira.example.test/browse/SYN-1");
    expect(view.hiddenIssueCount).toBe(1195);
  });
});
