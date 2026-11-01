import { describe, expect, it } from "vitest";

import { chatToolRequirementReceipts } from "./chat-tool-receipts.js";

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
