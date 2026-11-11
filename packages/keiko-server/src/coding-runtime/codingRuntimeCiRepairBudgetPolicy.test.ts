import { describe, expect, it } from "vitest";

import { ciRepairExhaustion } from "./codingRuntimeCiRepairBudgetPolicy.js";
import {
  CI_REPAIR_MAX_CHARGES,
  CI_REPAIR_MAX_RECORD_BYTES,
  CI_REPAIR_WRITE_RESERVE_BYTES,
  type CiRepairAttempt,
  type CiRepairBudgetRecord,
} from "./codingRuntimeCiRepairBudgetTypes.js";

const NOW = 1_000;

function attempt(chargeCount: number, idLength: number): CiRepairAttempt {
  return {
    attemptId: "attempt-1",
    runId: "run-1",
    failureSignatureDigest: "f".repeat(64),
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    kind: "workspace-edit",
    status: "active",
    startedAtMs: 0,
    finishedAtMs: null,
    toolCalls: chargeCount,
    charges: Array.from({ length: chargeCount }, (_, index) => ({
      chargeId: String(index).padEnd(idLength, "c"),
      toolCalls: 1,
    })),
  };
}

function record(chargeCount: number, idLength: number): CiRepairBudgetRecord {
  return {
    schemaVersion: "1",
    revision: chargeCount,
    taskDigest: "t".repeat(64),
    remoteDigest: "r".repeat(64),
    issueBindingDigest: "i".repeat(64),
    prNumber: 1,
    startedAtMs: 0,
    updatedAtMs: NOW,
    deadlineMs: NOW * 10,
    limits: { maxRuntimeMs: NOW * 10, maxToolCalls: 10_000 },
    toolCalls: chargeCount,
    failedAttempts: 0,
    attempts: [attempt(chargeCount, idLength)],
  };
}

function bytes(value: CiRepairBudgetRecord): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

describe("ciRepairExhaustion JSON bound", () => {
  // The byte bound is independent of the receipt-count bound: a record whose serialized size
  // leaves less than one write reserve stops further effects even while it holds fewer than
  // CI_REPAIR_MAX_CHARGES receipts. Removing the prompt-token counters (#4346) made maximum-size
  // store records reach the count bound first, so this pins the byte branch directly.
  it("refuses at the byte bound before the receipt-count bound", () => {
    const limit = CI_REPAIR_MAX_RECORD_BYTES - CI_REPAIR_WRITE_RESERVE_BYTES;
    let count = 0;
    while (bytes(record(count + 1, 400)) <= limit) count += 1;
    expect(count + 1).toBeLessThan(CI_REPAIR_MAX_CHARGES);
    expect(ciRepairExhaustion(record(count, 400), NOW)).toBeUndefined();
    expect(ciRepairExhaustion(record(count + 1, 400), NOW)).toBe("storage-capacity");
  });

  it("refuses at the receipt-count bound while the record is small", () => {
    const small = record(CI_REPAIR_MAX_CHARGES, 1);
    expect(bytes(small)).toBeLessThan(CI_REPAIR_MAX_RECORD_BYTES - CI_REPAIR_WRITE_RESERVE_BYTES);
    expect(ciRepairExhaustion(record(CI_REPAIR_MAX_CHARGES - 1, 1), NOW)).toBeUndefined();
    expect(ciRepairExhaustion(small, NOW)).toBe("storage-capacity");
  });
});
