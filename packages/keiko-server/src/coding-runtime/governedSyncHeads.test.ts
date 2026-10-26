import { describe, expect, it } from "vitest";

import { createGovernedSyncHeads, GOVERNED_SYNC_HEADS_MAX_RUNS } from "./governedSyncHeads.js";

describe("the heads governed fast-forwards wrote (#3902 AC2)", () => {
  it("answers the last head of each run, and forgets the run synchronized longest ago first", () => {
    const heads = createGovernedSyncHeads();
    const head = (runId: string, n: number): Parameters<typeof heads.record>[0] => ({
      runId,
      headSha: String(n).repeat(40).slice(0, 40),
      workspaceDigest: "a".repeat(64),
    });
    expect(heads.latest("run-a")).toBeUndefined();
    heads.record(head("run-a", 1));
    heads.record(head("run-a", 2));
    expect(heads.latest("run-a")?.headSha).toBe("2".repeat(40));
    for (let index = 0; index < GOVERNED_SYNC_HEADS_MAX_RUNS; index += 1)
      heads.record(head(`run-${String(index)}`, 3));
    expect(heads.latest("run-a")).toBeUndefined();
    expect(heads.latest(`run-${String(GOVERNED_SYNC_HEADS_MAX_RUNS - 1)}`)).toBeDefined();
  });
});
