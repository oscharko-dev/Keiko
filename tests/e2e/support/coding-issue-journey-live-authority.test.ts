import { describe, expect, it } from "vitest";
import { observeQualificationFlowAuthority } from "./coding-issue-journey-live-authority.js";

type Event = Readonly<Record<string, unknown>>;

function events(changes: readonly Event[] = []): readonly Event[] {
  return [
    {
      op: "coding-runtime.run.started",
      runId: "run-1",
      requestedMode: "governed-assist",
      effectiveMode: "governed-assist",
    },
    { op: "coding-runtime.approval.waiting", runId: "run-1", requestId: "approval-1" },
    { op: "tool-catalog.invocation-started", invocationId: "invocation-1" },
    {
      op: "tool-catalog.invocation-settled",
      invocationId: "invocation-1",
      status: "completed",
      effectStarted: true,
    },
    { op: "tool-catalog.invocation-started", invocationId: "invocation-2" },
    {
      op: "tool-catalog.invocation-settled",
      invocationId: "invocation-2",
      status: "denied",
      effectStarted: false,
    },
    { op: "coding-runtime.run.settled", runId: "run-1", state: "succeeded" },
    ...changes,
  ];
}

describe("observeQualificationFlowAuthority", () => {
  it("counts a policy denial settled before execution without inventing a start", () => {
    const observed = events().filter(
      (event) =>
        event.op !== "tool-catalog.invocation-started" || event.invocationId !== "invocation-2",
    );
    expect(
      observeQualificationFlowAuthority(observed, { runId: "run-1", mode: "governed-assist" }),
    ).toMatchObject({ toolInvocationCount: 2, deniedToolCount: 1, effectStartedCount: 1 });
  });

  it.each([
    { status: "completed", effectStarted: false },
    { status: "denied", effectStarted: true },
  ])("rejects an unstarted settlement with invalid execution evidence: %j", (settlement) => {
    expect(() =>
      observeQualificationFlowAuthority(
        events([
          { op: "tool-catalog.invocation-settled", invocationId: "unstarted", ...settlement },
        ]),
        { runId: "run-1", mode: "governed-assist" },
      ),
    ).toThrow("unmatched tool invocations");
  });

  it("rejects an execution start without its settlement", () => {
    expect(() =>
      observeQualificationFlowAuthority(
        events([{ op: "tool-catalog.invocation-started", invocationId: "unfinished" }]),
        { runId: "run-1", mode: "governed-assist" },
      ),
    ).toThrow("unmatched tool invocations");
  });

  it("derives exact mode, approval, settlement, and effect counts from the run event tree", () => {
    expect(
      observeQualificationFlowAuthority(events(), {
        runId: "run-1",
        mode: "governed-assist",
      }),
    ).toEqual({
      requestedMode: "governed-assist",
      effectiveMode: "governed-assist",
      approvalRequestCount: 1,
      toolInvocationCount: 2,
      effectStartedCount: 1,
      completedToolCount: 1,
      deniedToolCount: 1,
      failedToolCount: 0,
      otherToolCount: 0,
    });
  });

  it("retains a real zero approval count for a full-access run", () => {
    const fullAccessEvents = events()
      .filter((event) => event.op !== "coding-runtime.approval.waiting")
      .map((event) =>
        event.op === "coding-runtime.run.started"
          ? {
              ...event,
              requestedMode: "autonomous-delivery",
              effectiveMode: "autonomous-delivery",
            }
          : event,
      );
    expect(
      observeQualificationFlowAuthority(fullAccessEvents, {
        runId: "run-1",
        mode: "autonomous-delivery",
      }).approvalRequestCount,
    ).toBe(0);
  });

  it("refuses an effective-mode escalation, an unfinished run, and unobserved tool activity", () => {
    const escalated = events().map((event) =>
      event.op === "coding-runtime.run.started"
        ? { ...event, effectiveMode: "autonomous-delivery" }
        : event,
    );
    expect(() =>
      observeQualificationFlowAuthority(escalated, {
        runId: "run-1",
        mode: "governed-assist",
      }),
    ).toThrow("does not match");
    expect(() =>
      observeQualificationFlowAuthority(
        events().filter((event) => event.op !== "coding-runtime.run.settled"),
        { runId: "run-1", mode: "governed-assist" },
      ),
    ).toThrow("run-settled");
    expect(() =>
      observeQualificationFlowAuthority(
        events().filter((event) => event.op !== "tool-catalog.invocation-settled"),
        { runId: "run-1", mode: "governed-assist" },
      ),
    ).toThrow("tool settlement");
  });

  it("refuses duplicate approval and invocation identities", () => {
    expect(() =>
      observeQualificationFlowAuthority(
        events([
          { op: "coding-runtime.approval.waiting", runId: "run-1", requestId: "approval-1" },
        ]),
        { runId: "run-1", mode: "governed-assist" },
      ),
    ).toThrow("approval request");
    expect(() =>
      observeQualificationFlowAuthority(
        events([
          { op: "tool-catalog.invocation-started", invocationId: "invocation-1" },
          {
            op: "tool-catalog.invocation-settled",
            invocationId: "invocation-1",
            status: "failed",
            effectStarted: true,
          },
        ]),
        { runId: "run-1", mode: "governed-assist" },
      ),
    ).toThrow("tool invocation");
  });
});
