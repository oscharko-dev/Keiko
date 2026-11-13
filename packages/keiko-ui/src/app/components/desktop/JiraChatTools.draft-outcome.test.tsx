import { render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { JIRA_DRAFT_PROBLEMS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { JiraChatTools } from "./JiraChatTools";
import { jiraToolOutcomeView } from "./jira-tool-outcome";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { OPTIONAL_WIDGET_DE_MESSAGES } from "@/lib/i18n-messages.optional.de";
import { OPTIONAL_WIDGET_EN_MESSAGES } from "@/lib/i18n-messages.optional.en";

function draft(
  name: string,
  data: Record<string, unknown>,
  args: Record<string, unknown> = {},
): ChatToolExchange {
  return {
    call: { id: "draft-1", name, arguments: args },
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

  // #4355 AC3: a refused draft item is named by the summary the person reviewed, or by its place
  // in the draft. The model's own item reference ("story-7") is never shown.
  it("names Jira's field error and Keiko's validation against the item's summary", async () => {
    await show(
      draft(
        "jira_draft",
        {
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
        },
        {
          items: [
            { ref: "epic", fields: { summary: "Checkout" } },
            { ref: "story-7", fields: { summary: "Pay by card" } },
            { ref: "task-9", fields: { summary: "Send receipt" } },
          ],
        },
      ),
    );
    const problems = screen.getByRole("list", { name: "What Jira said" });
    expect(problems).toHaveTextContent("Pay by card");
    expect(problems).toHaveTextContent("Epic Name: Epic Name is required.");
    const refused = screen.getByText(/Send receipt/u).closest("p");
    expect(refused).toHaveTextContent("A required Jira field was missing.");
    expect(within(problems).queryByText(/Send receipt/u)).toBeNull();
    expect(screen.getAllByText("Nothing was sent to Jira.")).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/story-7|task-9|\bepic\b/u);
    // A created row is named by the reviewed summary, not by the model's reference.
    expect(screen.getByText(/Checkout/u)).toBeVisible();
  });

  it("names a refused item by its place in the draft when no summary was reviewed", async () => {
    await show(
      draft("jira_draft", {
        outcome: "partial",
        items: [
          { ref: "REQOBA001A1", state: "created", issueKey: "SYN-1" },
          { ref: "bug1", state: "failed", validation: "required-field" },
        ],
      }),
    );
    expect(screen.getByText(/Item 2/u).closest("p")).toHaveTextContent(
      "A required Jira field was missing.",
    );
    expect(document.body.textContent).not.toMatch(/REQOBA001A1|bug1/u);
  });

  // Wiki text (an issue's description, a comment's body) is read; plain text (a sprint goal, a
  // version's description) is shown exactly as stored. See `itemBody` in jira-tool-outcome.ts.
  it.each([
    [
      "an issue description",
      "jira_search",
      { key: "KER-1", description: "h2. Ziel\n* *a*" },
      "Ziel\n• a",
    ],
    ["a comment body", "jira_comments", { id: "10001", body: "h2. Ziel\n* *a*" }, "Ziel\n• a"],
    ["a stored comment", "jira_get_comment", { id: "10001", body: "h2. Ziel\n* *a*" }, "Ziel\n• a"],
    [
      "a worklog comment",
      "jira_worklogs",
      { id: "10002", comment: "h2. Ziel\n* *a*" },
      "Ziel\n• a",
    ],
    ["a sprint goal", "jira_sprints", { id: 5, name: "S1", goal: "h2. Ziel *a*" }, "h2. Ziel *a*"],
    [
      "a version description",
      "jira_versions",
      { versionName: "1.0", description: "h2. Ziel *a*" },
      "h2. Ziel *a*",
    ],
  ])("shows %s as it is stored or read", (_name, tool, row, expected) => {
    const view = jiraToolOutcomeView(draft(tool, { outcome: "succeeded", items: [row] }));
    expect(view.items[0]?.body).toBe(expected);
  });

  it("marks a result item the call never listed instead of borrowing a place", async () => {
    await show(
      draft(
        "jira_draft",
        {
          outcome: "partial",
          items: [{ ref: "ghost", state: "failed", validation: "required-field" }],
        },
        { items: [{ ref: "a", fields: { summary: "A" } }] },
      ),
    );
    expect(screen.getByText(/Item not in your request/u)).toBeVisible();
    expect(document.body.textContent).not.toMatch(/Item 1/u);
  });

  it("tells refused items with the same summary apart by their place in the call", async () => {
    await show(
      draft(
        "jira_draft",
        {
          outcome: "partial",
          items: [
            { ref: "a", state: "failed", validation: "required-field" },
            { ref: "b", state: "failed", validation: "required-field" },
            { ref: "c", state: "failed", validation: "required-field" },
          ],
        },
        {
          items: [
            { ref: "a", fields: { summary: "Pay" } },
            { ref: "b", fields: { summary: "Pay" } },
            { ref: "c", fields: { summary: "Send receipt" } },
          ],
        },
      ),
    );
    expect(screen.getByText("Pay (1)")).toBeVisible();
    expect(screen.getByText("Pay (2)")).toBeVisible();
    expect(screen.getByText("Send receipt")).toBeVisible();
  });

  it("marks a reference the call lists twice with its first place", async () => {
    await show(
      draft(
        "jira_draft",
        {
          outcome: "partial",
          items: [{ ref: "x", state: "failed", validation: "required-field" }],
        },
        {
          items: [
            { ref: "x", fields: { summary: "First" } },
            { ref: "x", fields: { summary: "Second" } },
          ],
        },
      ),
    );
    expect(screen.getByText("First (1)")).toBeVisible();
    expect(document.body.textContent).not.toMatch(/Second/u);
  });

  it("takes the place from the call's order, not from the result array", async () => {
    await show(
      draft(
        "jira_draft",
        {
          outcome: "partial",
          items: [{ ref: "c", state: "failed", validation: "required-field" }],
        },
        {
          items: [
            { ref: "a", fields: { summary: "A" } },
            { ref: "b", fields: {} },
            { ref: "c", fields: {} },
          ],
        },
      ),
    );
    expect(screen.getByText(/Item 3/u)).toBeVisible();
    expect(document.body.textContent).not.toMatch(/Item 1/u);
  });

  it("shows a description written in Jira wiki markup as readable text", () => {
    const view = jiraToolOutcomeView(
      draft("jira_search", {
        outcome: "succeeded",
        items: [
          {
            key: "KER-1",
            summary: "Login",
            description: "h2. Ziel\n* Anmeldung mit *Passwort*\n{code}\nx = 1\n{code}",
          },
        ],
      }),
    );
    expect(view.items[0]?.body).toBe("Ziel\n• Anmeldung mit Passwort\nx = 1");
  });

  // #4355 AC5: a refused draft names what to change, in the person's language, for every closed
  // problem. Expressions are literals; the item is the 1-based place in the call.
  const DRAFT_PROBLEMS_EN: Readonly<Record<(typeof JIRA_DRAFT_PROBLEMS)[number], string>> = {
    "draft-shape": "The draft is not in a readable form. Ask Keiko to draft the issues again.",
    "items-missing": "The draft contains no issues. Ask Keiko to name the issues to create.",
    "item-shape": "Item 2 contains an entry Keiko cannot read. Ask Keiko to rewrite this issue.",
    "item-ref": "Item 2 has no usable name. Ask Keiko to give every issue its own short name.",
    "item-ids":
      "Item 2 has no valid project or issue type. Choose the project and the issue type again.",
    "item-fields":
      "Item 2 needs a summary and must not name another project or issue type. Ask Keiko to complete its fields.",
    "item-parent":
      "Item 2 has a parent Keiko cannot read. Ask Keiko to name the parent issue again.",
    "item-links":
      "Item 2 has a link Keiko cannot read. Ask Keiko to name the link type, its direction and its target again.",
    "item-requirements":
      "Item 2 has requirement references Keiko cannot read. Ask Keiko to list them again.",
    "ref-duplicate": "Two issues share one name. Ask Keiko to give every issue its own name.",
    "ref-self":
      "Item 2 names itself as its parent or link target. Ask Keiko to point it at another issue.",
    "ref-unknown":
      "Item 2 points to an issue that is not in this draft. Add that issue to the draft or name an existing issue key.",
    "ref-cycle":
      "The parent and link relations form a cycle. Ask Keiko to make each parent an issue that does not depend on its child.",
  };
  it.each(JIRA_DRAFT_PROBLEMS)("names what to change for the draft problem %s", async (problem) => {
    await show(
      draft("jira_draft", {
        outcome: "rejected",
        reason: "field-validation",
        draftRefusal: "draft-invalid",
        draftProblem: problem,
        draftItem: 2,
        guidance: "Model-facing guidance that the person never reads.",
        items: [],
      }),
    );
    expect(screen.getByText(DRAFT_PROBLEMS_EN[problem])).toBeVisible();
    expect(screen.getByText("Nothing was sent to Jira.")).toBeVisible();
    expect(document.body.textContent).not.toContain("Review the required Jira fields");
    expect(document.body.textContent).not.toContain("Model-facing guidance");
    expect(document.body.textContent).not.toMatch(/chat\.jira\./u);
  });

  it("never says Item 0: without a position the sentence says An item", async () => {
    await show(
      draft("jira_draft", {
        outcome: "rejected",
        reason: "field-validation",
        draftProblem: "item-ids",
        items: [],
      }),
    );
    expect(
      screen.getByText(
        "An item has no valid project or issue type. Choose the project and the issue type again.",
      ),
    ).toBeVisible();
    expect(document.body.textContent).not.toMatch(/Item 0|Eintrag 0/u);
  });

  it("shows the draft problem in German and passes the accessibility check", async () => {
    await Promise.all([loadLocaleMessages("de"), loadOptionalWidgetMessages("de")]);
    localStorage.setItem(I18N_STORAGE_KEY, "de");
    const { container } = render(
      <I18nProvider>
        <JiraChatTools
          transcript={{
            schemaVersion: 1,
            exchanges: [
              draft("jira_draft", {
                outcome: "rejected",
                reason: "field-validation",
                draftRefusal: "draft-invalid",
                draftProblem: "item-ids",
                draftItem: 3,
                items: [],
              }),
            ],
          }}
          turnState="completed"
        />
      </I18nProvider>,
    );
    expect(
      screen.getByText(
        "Eintrag 3 hat kein gültiges Projekt oder keinen gültigen Vorgangstyp. Wählen Sie Projekt und Vorgangstyp erneut aus.",
      ),
    ).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });

  // The expired and revoked approvals get their closed reason and hint in #4354 (closed reason
  // `expired` end to end); this case is proven after merging child/4354-approval-and-project-message.
  it.todo("tells the person what to do after an expired approval (waits for #4354)");
  it.todo("tells the person what to do after a revoked approval (waits for #4354)");

  // #4355 AC6: every text added for the results exists in both languages with the same placeholders.
  it("has an English and a German text, with the same placeholders, for every added result text", () => {
    const keys = [
      "chat.jira.outcome.itemOrdinal",
      "chat.jira.outcome.itemUnlisted",
      "chat.jira.outcome.notCreated",
      "chat.jira.outcome.draftItem",
      "chat.jira.outcome.draftItemUnknown",
      ...JIRA_DRAFT_PROBLEMS.map((problem) => `chat.jira.outcome.draftProblem.${problem}`),
    ] as const;
    const placeholders = (text: string): string[] => text.match(/\{\w+\}/gu)?.sort() ?? [];
    for (const key of keys) {
      const en = (OPTIONAL_WIDGET_EN_MESSAGES as Readonly<Record<string, string>>)[key];
      const de = (OPTIONAL_WIDGET_DE_MESSAGES as Readonly<Record<string, string>>)[key];
      expect(en, key).toBeTruthy();
      expect(de, key).toBeTruthy();
      expect(de, key).not.toBe(en);
      expect(placeholders(de ?? ""), key).toEqual(placeholders(en ?? ""));
    }
  });

  it.each(["en", "de"] as const)(
    "passes the accessibility check with item names in %s",
    async (locale) => {
      await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
      localStorage.setItem(I18N_STORAGE_KEY, locale);
      const { container } = render(
        <I18nProvider>
          <JiraChatTools
            transcript={{
              schemaVersion: 1,
              exchanges: [
                draft(
                  "jira_draft",
                  {
                    outcome: "partial",
                    items: [
                      { ref: "a", state: "failed", validation: "required-field" },
                      { ref: "b", state: "failed", validation: "required-field" },
                      { ref: "ghost", state: "failed", validation: "required-field" },
                    ],
                  },
                  {
                    items: [
                      { ref: "a", fields: { summary: "Pay" } },
                      { ref: "b", fields: {} },
                    ],
                  },
                ),
              ],
            }}
            turnState="completed"
          />
        </I18nProvider>,
      );
      expect(container.textContent).not.toMatch(/chat\.jira\./u);
      expect(await axe(container)).toHaveNoViolations();
    },
  );

  it("ignores a draft problem code outside the closed vocabulary", async () => {
    await show(
      draft("jira_draft", {
        outcome: "rejected",
        reason: "field-validation",
        draftProblem: "made-up",
        items: [],
      }),
    );
    expect(
      screen.getByText(
        "Review the required Jira fields and template rules before requesting the change again.",
      ),
    ).toBeVisible();
  });

  // #4355 AC1: the card lists every created key with its link, from the stored result alone, so it
  // does not depend on the model repeating the keys and survives a reload (a remount).
  const BROWSE = "https://jira.example.test/browse/";
  const keysOf = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `SYN-${String(index + 1)}`);
  // A key is "listed with its link" when a link opens under the browse prefix and names that key.
  const linkedKeys = (): string[] =>
    screen.getAllByRole("link", { hidden: true }).flatMap((link) => {
      const href = link.getAttribute("href") ?? "";
      const key = href.startsWith(BROWSE) ? href.slice(BROWSE.length) : "";
      return /^SYN-\d+$/u.test(key) && (link.textContent ?? "").includes(key) ? [key] : [];
    });

  it("lists all 25 created keys with their links, not only the first few", async () => {
    await show(
      draft("jira_draft", {
        outcome: "succeeded",
        items: keysOf(25).map((key, index) => ({
          ref: `r${String(index)}`,
          state: "created",
          issueKey: key,
          browseUrl: `${BROWSE}${key}`,
        })),
        createdCount: 25,
      }),
    );
    expect(linkedKeys()).toEqual(keysOf(25));
  });

  it("lists every key of a compact large-draft result with its link", async () => {
    await show(
      draft("jira_draft", {
        outcome: "succeeded",
        compact: true,
        items: [],
        createdRanges: ["SYN-1..SYN-25"],
        createdCount: 25,
        browseUrlPrefix: BROWSE,
      }),
    );
    expect(linkedKeys()).toEqual(keysOf(25));
  });

  it("shows the same keys after a remount from the stored result", async () => {
    const exchange = draft("jira_draft", {
      outcome: "succeeded",
      compact: true,
      items: [],
      createdRanges: ["SYN-1..SYN-12,SYN-20"],
      createdCount: 13,
      browseUrlPrefix: BROWSE,
    });
    await show(exchange);
    const first = linkedKeys();
    document.body.innerHTML = "";
    await show(exchange);
    expect(linkedKeys()).toEqual(first);
    expect(first).toEqual([...keysOf(12), "SYN-20"]);
  });

  it("lists exactly the created keys of a partial draft and names the rest as not created", async () => {
    await show(
      draft(
        "jira_draft",
        {
          outcome: "partial",
          items: [
            ...keysOf(7).map((key, index) => ({
              ref: `r${String(index)}`,
              state: "created",
              issueKey: key,
              browseUrl: `${BROWSE}${key}`,
            })),
            { ref: "r7", state: "failed", validation: "required-field" },
            { ref: "r8", state: "skipped", blockedBy: ["r7"] },
            { ref: "r9", state: "skipped", blockedBy: ["r7"] },
          ],
          createdCount: 7,
          failedCount: 1,
          skippedCount: 2,
        },
        {
          items: Array.from({ length: 10 }, (_, index) => ({
            ref: `r${String(index)}`,
            fields: { summary: `Issue ${String(index + 1)}` },
          })),
        },
      ),
    );
    expect(linkedKeys()).toEqual(keysOf(7));
    expect(screen.getByText("Not created: 3")).toBeVisible();
  });

  it("lists the keys of a compact large-draft result and counts the keys its ranges could not carry", async () => {
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
    expect(within(list).getByRole("link", { name: /^SYN-1\b/u })).toHaveAttribute(
      "href",
      "https://jira.example.test/browse/SYN-1",
    );
    // 40 + 1 + 3 listed keys all stand in the list; the 7 the result could not carry are counted.
    expect(within(list).getAllByRole("link")).toHaveLength(44);
    expect(within(list).getByRole("link", { name: /^SYN-62\b/u })).toBeVisible();
    expect(screen.getByText("and 7 more")).toBeVisible();
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
    expect(screen.getByText("Requirements that could not be drafted: 3")).toBeVisible();
    expect(screen.queryByRole("list", { name: "Jira issues" })).toBeNull();
  });
});
