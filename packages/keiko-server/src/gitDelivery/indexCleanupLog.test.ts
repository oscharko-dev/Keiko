import { describe, expect, it } from "vitest";
import { captureActivityLog } from "../activityLogCapture.test-support.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { logGitIndexCleanupIncomplete } from "./indexCleanupLog.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

const FACTS = {
  caller: "stage",
  quarantines: 2,
  temporaryIndex: false,
  lock: true,
  refLocks: 0,
  directories: 0,
} as const;

describe("git index transaction cleanup line", () => {
  it("records what stayed behind as counts and flags on the mutation's correlation", () => {
    const activity = captureActivityLog();
    logGitIndexCleanupIncomplete(activity.sink, FACTS, "mutation-correlation-1");
    expect(activity.events).toHaveLength(1);
    expect(activity.events[0]).toMatchObject({
      level: "warn",
      category: "diagnostic",
      op: "git.index-transaction.cleanup-incomplete",
      correlationId: "mutation-correlation-1",
      errorKind: "unavailable",
      extra: {
        caller: "stage",
        quarantineFailures: 2,
        temporaryIndexLeft: false,
        lockLeft: true,
        refLockFailures: 0,
        directoryFailures: 0,
      },
    });
    const persisted = expectActivityLogProof(
      "git.index-transaction.cleanup-incomplete.emitted-line",
      formatActivityLogProofLine(activity.events[0] ?? {}),
    );
    expect(persisted).toMatchObject({ caller: "stage", lockLeft: true });
  });

  it("falls back to the unknown correlation only when a caller has none", () => {
    const activity = captureActivityLog();
    logGitIndexCleanupIncomplete(
      activity.sink,
      { ...FACTS, caller: "turn-index-restore", lock: false, quarantines: 1 },
      undefined,
    );
    expect(activity.events[0]).toMatchObject({
      correlationId: UNKNOWN_CORRELATION_ID,
      extra: { caller: "turn-index-restore", quarantineFailures: 1, lockLeft: false },
    });
    expect(JSON.stringify(activity.events)).not.toMatch(/[\\/]/u);
  });
});
