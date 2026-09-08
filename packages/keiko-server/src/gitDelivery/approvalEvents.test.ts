import { describe, expect, it } from "vitest";
import { captureActivityLog } from "../activityLogCapture.test-support.js";
import { logGitDeliveryApprovalEvent, parseVerifiedCommitSha } from "./approvalEvents.js";

const SHA_40 = "a".repeat(40);
const SHA_64 = "b".repeat(64);

describe("parseVerifiedCommitSha", () => {
  it("accepts an absent value as ok without a value", () => {
    expect(parseVerifiedCommitSha(undefined)).toEqual({ ok: true });
  });

  it("accepts a full 40-hex commit SHA as ok with that value", () => {
    expect(parseVerifiedCommitSha(SHA_40)).toEqual({ ok: true, value: SHA_40 });
  });

  it("accepts a full 64-hex (SHA-256) object id as ok with that value", () => {
    expect(parseVerifiedCommitSha(SHA_64)).toEqual({ ok: true, value: SHA_64 });
  });

  it("rejects an abbreviated, uppercase, or otherwise malformed SHA string", () => {
    expect(parseVerifiedCommitSha("a".repeat(7))).toEqual({ ok: false });
    expect(parseVerifiedCommitSha(SHA_40.toUpperCase())).toEqual({ ok: false });
    expect(parseVerifiedCommitSha("not-a-sha")).toEqual({ ok: false });
    expect(parseVerifiedCommitSha("")).toEqual({ ok: false });
  });

  it("rejects a non-string value (number, null, object, array)", () => {
    expect(parseVerifiedCommitSha(42)).toEqual({ ok: false });
    expect(parseVerifiedCommitSha(null)).toEqual({ ok: false });
    expect(parseVerifiedCommitSha({ sha: SHA_40 })).toEqual({ ok: false });
    expect(parseVerifiedCommitSha([SHA_40])).toEqual({ ok: false });
  });
});

// The exact shape pushRoutes.ts's and prRoutes.ts's four call sites rely on (#3394 review): same
// `category`/`status`, `op`/`operation` varying together. `commitPinned` was removed (#3394 review,
// section 9): once `verifiedCommitSha` is mandatory and validated at the request boundary, the field
// was `true` at every single call site, unconditionally, by construction — dead, not merely
// simplifiable (AGENTS.md §7).
describe("logGitDeliveryApprovalEvent", () => {
  it("writes the push approval-required line with the shape both routes rely on", () => {
    const activity = captureActivityLog();
    logGitDeliveryApprovalEvent(
      activity.sink,
      "git.delivery.push.approval.required",
      "push",
      "corr-1",
      "run-1",
    );
    expect(activity.events).toEqual([
      {
        category: "security",
        op: "git.delivery.push.approval.required",
        correlationId: "corr-1",
        status: 200,
        extra: { operation: "push", runId: "run-1" },
      },
    ]);
  });

  it("writes the pr approval-minted line with the shared shape", () => {
    const activity = captureActivityLog();
    logGitDeliveryApprovalEvent(
      activity.sink,
      "git.delivery.pr.approval.minted",
      "pr",
      "corr-2",
      "run-2",
    );
    expect(activity.events).toEqual([
      {
        category: "security",
        op: "git.delivery.pr.approval.minted",
        correlationId: "corr-2",
        status: 200,
        extra: { operation: "pr", runId: "run-2" },
      },
    ]);
  });
});
