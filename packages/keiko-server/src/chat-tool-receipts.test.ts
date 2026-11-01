import { describe, expect, it } from "vitest";

import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { jiraMutationToolId } from "./atlassian/jiraMutationToolId.js";
import { chatToolDraftReceipts, chatToolRequirementReceipts } from "./chat-tool-receipts.js";

describe("requirement receipts (#4179)", () => {
  it("keeps the scoped reference, title and priority of each unit, bounded", () => {
    const items = Array.from({ length: 80 }, (_, index) => ({
      reference: `abcdef01:LH-${String(index).padStart(3, "0")}`,
      title: "T".repeat(200),
      priority: "Muss",
      statement: "dropped",
    }));

    const receipts = chatToolRequirementReceipts({ view: "units", items });

    expect(receipts).toHaveLength(50);
    expect(receipts?.[0]).toEqual({
      reference: "abcdef01:LH-000",
      title: "T".repeat(60),
      priority: "Muss",
    });
    expect(JSON.stringify(receipts)).not.toContain("dropped");
  });

  it("ignores other views, other tools' lists and items without a valid reference", () => {
    expect(
      chatToolRequirementReceipts({ view: "documents", items: [{ reference: "abcdef01:A-1" }] }),
    ).toBeUndefined();
    expect(chatToolRequirementReceipts({ items: [{ state: "created" }] })).toBeUndefined();
    expect(
      chatToolRequirementReceipts({ view: "units", items: [{ reference: "LH-1" }] }),
    ).toBeUndefined();
    expect(chatToolRequirementReceipts("units")).toBeUndefined();
    expect(
      chatToolRequirementReceipts({
        view: "units",
        items: [{ reference: "abcdef01:A-1", title: 3 }],
      }),
    ).toEqual([{ reference: "abcdef01:A-1", title: "" }]);
  });
});

describe("draft receipts of a large draft (#4178)", () => {
  const exchange = (data: unknown): ChatToolExchange =>
    ({
      call: { id: "call", name: "jira_draft", arguments: {} },
      mutationOutcome: "succeeded",
      result: { toolRef: { canonicalId: jiraMutationToolId("jira.draft") }, data },
    }) as unknown as ChatToolExchange;

  it("keeps every row of a draft with thousands of items: no count cuts the receipts", () => {
    const items = Array.from({ length: 1200 }, (_, index) => ({
      ref: `i${String(index)}`,
      state: "created",
      issueKey: `SYN-${String(index + 1)}`,
    }));
    expect(chatToolDraftReceipts(exchange({ items }))).toHaveLength(1200);
  });

  it("names the exact created and found key ranges of a compact result, and its pending rows", () => {
    const receipts = chatToolDraftReceipts(
      exchange({
        compact: true,
        createdRanges: ["SYN-1..SYN-900", "SYN-905", "not a key"],
        existingRanges: ["SYN-1000..SYN-1100"],
        items: [{ ref: "late", state: "pending" }],
      }),
    );
    expect(receipts).toEqual([
      { state: "created", issueKey: "SYN-1..SYN-900" },
      { state: "created", issueKey: "SYN-905" },
      { state: "existing", issueKey: "SYN-1000..SYN-1100" },
      { state: "pending" },
    ]);
  });
});
