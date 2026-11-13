import { beforeAll, describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import {
  draftResult,
  type DraftItemResult,
} from "../../packages/keiko-server/src/atlassian/jiraChatDraft.js";
import { jiraMutationDeclaration } from "../../packages/keiko-server/src/atlassian/jiraManagedMutationDescriptors.js";

// The Chat card reads the result the production draft builder returns. Fixtures here are produced
// by that builder and checked against the declared result schema, so a schema change that the
// card does not follow turns this red instead of leaving a hand-written literal green.
const BASE_URL = "https://jira.example.test";
const SCHEMA = jiraMutationDeclaration("jira.draft").descriptor.resultSchema;

// keiko-ui is type-checked by its own bundler program (`@/` paths, extensionless imports), so the
// root program loads the card's view at run time instead of compiling the UI sources a second time.
const UI_OUTCOME_MODULE = "../../packages/keiko-ui/src/app/components/desktop/jira-tool-outcome.ts";

interface OutcomeView {
  readonly items: readonly {
    readonly key?: string;
    readonly href?: string;
    readonly labels: readonly string[];
  }[];
  readonly visibleItems?: number;
  readonly unlistedItemCount: number;
  readonly notCreatedCount?: number;
  readonly problems: readonly unknown[];
  readonly itemValidations: readonly unknown[];
}
type OutcomeViewer = (exchange: ChatToolExchange) => OutcomeView;

let jiraToolOutcomeView: OutcomeViewer;

function outcomeViewer(loaded: unknown): OutcomeViewer {
  if (
    typeof loaded === "object" &&
    loaded !== null &&
    "jiraToolOutcomeView" in loaded &&
    typeof loaded.jiraToolOutcomeView === "function"
  ) {
    return loaded.jiraToolOutcomeView as OutcomeViewer;
  }
  throw new TypeError("jira-tool-outcome.ts does not export jiraToolOutcomeView");
}

beforeAll(async () => {
  jiraToolOutcomeView = outcomeViewer(await import(UI_OUTCOME_MODULE));
});

// `reviewed` is the draft as the call listed it, with the summary the person reviewed for each item;
// without it the call lists nothing and an item is known by its place in the result.
function viewOf(
  items: readonly DraftItemResult[],
  reviewed: readonly { readonly ref: string; readonly summary: string }[] = [],
): OutcomeView {
  const { data } = draftResult(BASE_URL, items);
  expect(describeCatalogSchemaMismatch(SCHEMA, data)).toBeUndefined();
  const callItems = reviewed.map(({ ref, summary }) => ({ ref, fields: { summary } }));
  const exchange = {
    call: {
      id: "draft-1",
      name: "jira_draft",
      arguments: reviewed.length === 0 ? {} : { items: callItems },
    },
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
    expect(view.items.map((item) => ({ key: item.key, href: item.href }))).toEqual([
      { key: "SYN-1", href: "https://jira.example.test/browse/SYN-1" },
      { key: "SYN-2", href: "https://jira.example.test/browse/SYN-2" },
    ]);
  });

  // The model-internal ref never reaches the screen (#4355 AC3); what ties a refusal to its item is
  // the item a person knows: its place in the draft, or the summary they reviewed.
  const FAILED_ITEMS: readonly DraftItemResult[] = [
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
    {
      ref: "bug-4",
      state: "failed",
      detail: {
        fieldErrors: [
          { fieldId: "priority", fieldName: "Priority", message: "Priority is invalid." },
        ],
      },
    },
  ];

  it("ties each of Jira's field errors and Keiko's validation to the failed item it belongs to, by its place in the draft", () => {
    const view = viewOf(FAILED_ITEMS);

    // Each problem carries exactly its own item, and no other: the second and the fourth item of the
    // result for Jira's words, the third for Keiko's own check.
    expect(view.problems).toEqual([
      { item: { position: 2 }, field: "Epic Name", message: "Epic Name is required." },
      { item: { position: 4 }, field: "Priority", message: "Priority is invalid." },
    ]);
    expect(view.itemValidations).toEqual([{ item: { position: 3 }, validation: "required-field" }]);
    // The model's own references appear nowhere in what the card shows.
    const shown = JSON.stringify(view);
    for (const ref of ["story-7", "task-9", "bug-4"]) expect(shown).not.toContain(ref);
  });

  it("names a failed item by the summary the person reviewed, still with its own place", () => {
    const view = viewOf(FAILED_ITEMS, [
      { ref: "epic", summary: "Plan the release" },
      { ref: "story-7", summary: "Publish the notes" },
      { ref: "task-9", summary: "Tag the build" },
      { ref: "bug-4", summary: "Fix the banner" },
    ]);

    expect(view.problems).toEqual([
      {
        item: { position: 2, summary: "Publish the notes" },
        field: "Epic Name",
        message: "Epic Name is required.",
      },
      {
        item: { position: 4, summary: "Fix the banner" },
        field: "Priority",
        message: "Priority is invalid.",
      },
    ]);
    expect(view.itemValidations).toEqual([
      { item: { position: 3, summary: "Tag the build" }, validation: "required-field" },
    ]);
    const shown = JSON.stringify(view);
    for (const ref of ["story-7", "task-9", "bug-4"]) expect(shown).not.toContain(ref);
  });

  // #4355 AC1: every key the result carries is a row with its link, whatever the batch size; the
  // card opens 60 of them and mounts the rest on demand. The results are the production builder's.
  const created = (count: number): DraftItemResult[] =>
    Array.from({ length: count }, (_, index) => ({
      ref: `item-${String(index)}`,
      state: "created" as const,
      issueKey: `SYN-${String(index + 1)}`,
    }));
  const keysOf = (view: OutcomeView): (string | undefined)[] => view.items.map((item) => item.key);
  const expectedKeys = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `SYN-${String(index + 1)}`);

  it.each([1, 59, 60, 61, 400])("lists all %s created keys with their links", (count) => {
    const view = viewOf(created(count));
    expect(keysOf(view)).toEqual(expectedKeys(count));
    expect(view.items.every((item) => item.href === `${BASE_URL}/browse/${item.key}`)).toBe(true);
    expect(view.visibleItems).toBe(60);
    expect(view.unlistedItemCount).toBe(0);
  });

  it.each([1200, 5000])("lists every key of a compact result of %s issues", (count) => {
    const items = created(count);
    expect(draftResult(BASE_URL, items).data).toMatchObject({ compact: true, items: [] });
    const view = viewOf(items);
    expect(keysOf(view)).toEqual(expectedKeys(count));
    expect(view.items.every((item) => item.href !== undefined)).toBe(true);
    expect(view.unlistedItemCount).toBe(0);
  });

  it("labels the issues a compact result found as already existing", () => {
    const items: DraftItemResult[] = [
      ...created(1200),
      ...Array.from({ length: 3 }, (_, index) => ({
        ref: `old-${String(index)}`,
        state: "existing" as const,
        issueKey: `SYN-${String(2000 + index)}`,
      })),
    ];
    const view = viewOf(items);
    expect(draftResult(BASE_URL, items).data).toMatchObject({ compact: true });
    expect(view.items).toHaveLength(1203);
    expect(view.items.slice(0, 1200).every((item) => item.labels.length === 0)).toBe(true);
    expect(view.items.slice(1200).every((item) => item.labels.length === 1)).toBe(true);
  });

  it("names the issues of a partial draft that were not created", () => {
    const items: DraftItemResult[] = [
      ...created(2),
      { ref: "f", state: "failed" },
      { ref: "s", state: "skipped" },
    ];
    expect(viewOf(items).notCreatedCount).toBe(2);
    expect(viewOf(created(3)).notCreatedCount).toBeUndefined();
  });
});

// A hostile or buggy compact result is read defensively: nothing vanishes silently (#4355).
describe("a compact result with unreadable key ranges", () => {
  function compactView(extra: Record<string, unknown>): OutcomeView {
    const exchange = {
      call: { id: "draft-2", name: "jira_draft", arguments: {} },
      result: {
        status: "completed",
        data: {
          outcome: "succeeded",
          compact: true,
          items: [],
          browseUrlPrefix: `${BASE_URL}/browse/`,
          ...extra,
        },
      },
    } as unknown as ChatToolExchange;
    return jiraToolOutcomeView(exchange);
  }
  it("counts a descending range, two prefixes and an over-long project key as unreadable parts", () => {
    const view = compactView({
      createdRanges: [
        "SYN-9..SYN-3",
        "SYN-1..OTH-4",
        `${"A".repeat(300)}-1..${"A".repeat(300)}-2`,
        "SYN-1",
      ],
    });
    expect(view.items.map((item) => item.key)).toEqual(["SYN-1"]);
    expect(view.unlistedItemCount).toBe(3);
  });
  it("returns at once for a range that claims a quadrillion keys", () => {
    const started = performance.now();
    const view = compactView({ createdRanges: ["SYN-1..SYN-999999999999999"] });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(view.items).toHaveLength(5000);
    expect(view.items.at(-1)?.key).toBe("SYN-5000");
    // The rest of the span is counted (up to a fixed ceiling), never expanded.
    expect(view.unlistedItemCount).toBe(1_000_000_000);
  });
  it("lists a key once when ranges overlap", () => {
    const view = compactView({ createdRanges: ["SYN-1..SYN-5", "SYN-3..SYN-8"] });
    expect(view.items.map((item) => item.key)).toEqual([
      "SYN-1",
      "SYN-2",
      "SYN-3",
      "SYN-4",
      "SYN-5",
      "SYN-6",
      "SYN-7",
      "SYN-8",
    ]);
  });
  it.each([2.5, -1, Number.NaN, "7", Number.MAX_SAFE_INTEGER + 2])(
    "ignores the unlisted key count %s unless it is a non-negative safe integer",
    (unlisted) => {
      const view = compactView({ createdRanges: ["SYN-1"], unlistedKeyCount: unlisted });
      expect(view.unlistedItemCount).toBe(0);
    },
  );
  it("adds a valid unlisted key count to the keys it could not expand", () => {
    expect(compactView({ createdRanges: ["SYN-1"], unlistedKeyCount: 7 }).unlistedItemCount).toBe(
      7,
    );
  });
});
