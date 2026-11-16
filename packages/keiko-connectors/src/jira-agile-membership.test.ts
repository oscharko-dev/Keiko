import { describe, expect, it, vi } from "vitest";
import type { JiraAgileRequests } from "./jira-agile-request.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { mutateAgileMembership } from "./jira-agile-membership.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";

function fixture(
  error: Error,
  controller = new AbortController(),
  beforeRead?: () => void,
): {
  readonly requests: JiraAgileRequests;
  readonly write: ReturnType<typeof vi.fn<JiraMutationRequest>>;
} {
  const write = vi.fn<JiraMutationRequest>(() =>
    Promise.resolve({ ok: true, status: 204, body: undefined }),
  );
  const read = vi.fn<JiraMutationRequest>(() => {
    beforeRead?.();
    return Promise.reject(error);
  });
  return {
    write,
    requests: {
      agile: write,
      issue: write,
      signal: new AbortController().signal,
      readback: () => ({ agile: read, issue: read, signal: controller.signal }),
    },
  };
}
const INPUT = {
  operation: "jira.backlog-move-issues",
  issues: ["APP-1"],
  body: { issues: ["APP-1"] },
} as const;

describe("acknowledged membership readback failures", () => {
  it("preserves programming error frames and cause alongside the native receipt", async () => {
    const cause = new RangeError("synthetic projection defect");
    const f = fixture(cause);
    let failure: unknown;
    try {
      await mutateAgileMembership(f.requests, INPUT, undefined);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(JiraAcknowledgedMutationError);
    expect(failure).toMatchObject({ cause, receipt: { issueKeys: ["APP-1"] } });
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it("retains the receipt for the exact aborted readback signal without reissuing the write", async () => {
    const controller = new AbortController();
    const cause = new Error("synthetic cancellation");
    controller.abort(cause);
    const f = fixture(cause, controller);
    expect(await mutateAgileMembership(f.requests, INPUT, undefined)).toEqual({
      ok: false,
      reason: "timeout",
      receipt: { issueKeys: ["APP-1"] },
    });
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it("does not hide a programming error when an unrelated cancellation races with it", async () => {
    const controller = new AbortController();
    const cause = new RangeError("synthetic worker defect");
    const f = fixture(cause, controller, () => {
      controller.abort(new Error("separate abort"));
    });
    await expect(mutateAgileMembership(f.requests, INPUT, undefined)).rejects.toMatchObject({
      cause,
      receipt: { issueKeys: ["APP-1"] },
    });
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it("copies and freezes acknowledgement facts while retaining the original error identity", () => {
    const issueKeys = ["APP-1"];
    const cause = new TypeError("synthetic defect");
    const error = new JiraAcknowledgedMutationError(cause, { issueKeys });
    issueKeys.push("APP-2");
    expect(error.cause).toBe(cause);
    expect(error.receipt).toEqual({ issueKeys: ["APP-1"] });
    expect(Object.isFrozen(error.receipt)).toBe(true);
    expect(Object.isFrozen(error.receipt.issueKeys)).toBe(true);
  });
});
