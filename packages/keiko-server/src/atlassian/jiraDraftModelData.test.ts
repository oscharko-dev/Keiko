import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { gatewayMessagesForToolExchange } from "../conversation-gateway.js";
import { draftResult } from "./jiraChatDraft.js";
import { JIRA_DRAFT_UNLISTED_GUIDANCE } from "./jiraDraftKeyRanges.js";
import {
  JIRA_DRAFT_MODEL_ROWS_MAX,
  jiraDraftCondensedRows,
  jiraDraftModelData,
  jiraDraftRowsForModel,
} from "./jiraDraftModelData.js";

const BASE_URL = "https://jira.example";

type Item = Parameters<typeof draftResult>[1][number];

function created(count: number, from = 4): Item[] {
  return Array.from({ length: count }, (_, index) => ({
    ref: `item-${String(index)}`,
    state: "created",
    issueKey: `KER-${String(from + index)}`,
  })) as unknown as Item[];
}

// The stored data comes from the production producer, never a restated row shape.
function stored(items: readonly Item[]): CatalogJsonObject {
  return draftResult(BASE_URL, items).data;
}

function exchange(data: unknown): ChatToolExchange {
  return {
    call: { id: "draft-1", name: "jira_draft", arguments: { draftId: "d" } },
    result: {
      schemaVersion: 1,
      invocationId: "invocation",
      toolRef: { canonicalId: "keiko.jira.draft", contractVersion: 1 },
      projectionDigest: null,
      status: "completed",
      reason: "none",
      page: { truncated: false, reason: "none", cursor: null },
      data,
      effectStarted: true,
      metrics: { inputBytes: 0, outputBytes: 0, resultCount: 1, durationMs: 0 },
    },
    mutationOutcome: "succeeded",
  } as unknown as ChatToolExchange;
}

describe("the model's view of a long draft result", () => {
  it("names 370 created issues as one key range instead of 370 rows", () => {
    const data = stored(created(370));
    expect(data.items).toHaveLength(370);

    const model = jiraDraftModelData("keiko.jira.draft", data) as Record<string, unknown>;

    expect(model).toMatchObject({
      outcome: data.outcome,
      createdCount: 370,
      compact: true,
      items: [],
      createdRanges: ["KER-4..KER-373"],
      existingRanges: [],
    });
    expect(JSON.stringify(model).length).toBeLessThan(JSON.stringify(data).length / 50);
    // The stored result the person's view reads is not changed.
    expect(data.items).toHaveLength(370);
  });

  it("keeps every row that needs the model's words, with its details", () => {
    const failed = {
      ref: "item-x",
      state: "failed",
      detail: { fieldErrors: { summary: "required" } },
    } as unknown as Item;
    const data = stored([...created(20), failed]);

    const model = jiraDraftModelData("keiko.jira.draft", data) as Record<string, unknown>;

    expect(model.createdRanges).toEqual(["KER-4..KER-23"]);
    expect(model.items).toEqual([expect.objectContaining({ ref: "item-x", state: "failed" })]);
    expect(model.failedCount).toBe(1);
    expect(model.guidance).toBe(data.guidance);
  });

  it("leaves a short draft, a compact result and other tools as they are", () => {
    const short = stored(created(JIRA_DRAFT_MODEL_ROWS_MAX));
    expect(jiraDraftModelData("keiko.jira.draft", short)).toBe(short);
    const compact: CatalogJsonObject = { ...stored(created(40)), compact: true };
    expect(jiraDraftRowsForModel(compact)).toBe(compact);
    const other = stored(created(40));
    expect(jiraDraftModelData("keiko.jira.create", other)).toBe(other);
    expect(jiraDraftRowsForModel(null)).toBeNull();
  });

  it("sends the compact view through the model history and its draft progress", () => {
    const data = stored(created(30));
    const [, result] = gatewayMessagesForToolExchange({
      ...exchange(data),
      draftProgress: { outcome: "unknown", items: created(30) },
    });
    const sent = JSON.parse(result?.content ?? "") as {
      result: { data: Record<string, unknown> };
      draftProgress: Record<string, unknown>;
    };

    expect(sent.result.data).toMatchObject({ createdRanges: ["KER-4..KER-33"], items: [] });
    expect(sent.draftProgress).toMatchObject({ createdRanges: ["KER-4..KER-33"], items: [] });
  });

  it("keeps uncertain and pending rows and drops only listed or deselected ones", () => {
    const rows = [
      ...created(12),
      { ref: "maybe", state: "uncertain", issueKey: "KER-90" },
      { ref: "later", state: "pending" },
      { ref: "off", state: "excluded" },
      { ref: "found", state: "existing", issueKey: "KER-99" },
    ] as unknown as Item[];
    const data = stored(rows);

    const model = jiraDraftModelData("keiko.jira.draft", data) as Record<string, unknown>;

    expect(model.items).toEqual([
      expect.objectContaining({ ref: "maybe", state: "uncertain", issueKey: "KER-90" }),
      expect.objectContaining({ ref: "later", state: "pending" }),
    ]);
    expect(model).toMatchObject({
      createdRanges: ["KER-4..KER-15"],
      existingRanges: ["KER-99"],
      excludedCount: 1,
      guidance: data.guidance,
    });
    expect(jiraDraftCondensedRows("keiko.jira.draft", data)).toEqual({
      rowCount: 16,
      keptRowCount: 2,
    });
    // The same stored data always reads the same, so an unchanged prompt prefix stays reusable.
    expect(JSON.stringify(jiraDraftModelData("keiko.jira.draft", data))).toBe(
      JSON.stringify(model),
    );
  });

  it("adds the unlisted-key guidance to the producer's own when keys do not fit", () => {
    // Every other key of a long project key: no two are adjacent, so no range can pack them.
    const scattered = Array.from({ length: 900 }, (_, index) => ({
      ref: `item-${String(index)}`,
      state: "created",
      issueKey: `KERNBANKMIGRATION-${String(2 * index + 1)}`,
    })) as unknown as Item[];
    const failed = { ref: "bad", state: "failed", detail: { messages: ["refused"] } };
    const data = stored([...scattered, failed as unknown as Item]);

    const model = jiraDraftModelData("keiko.jira.draft", data) as Record<string, unknown>;

    expect(model.rangesTruncated).toBe(true);
    expect(model.unlistedKeyCount).toBeGreaterThan(0);
    const own = data.guidance;
    if (typeof own !== "string") throw new TypeError("The producer gave no guidance");
    expect(model.guidance).toBe(`${own} ${JIRA_DRAFT_UNLISTED_GUIDANCE}`);
  });

  it("names no condensed rows for a short draft or another tool", () => {
    expect(jiraDraftCondensedRows("keiko.jira.draft", stored(created(10)))).toBeUndefined();
    expect(jiraDraftCondensedRows("keiko.jira.create", stored(created(40)))).toBeUndefined();
  });
});
