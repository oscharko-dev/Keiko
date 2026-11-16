import { describe, expect, it, vi } from "vitest";
import * as progress from "../testing/jira-chat-lab/requirements/progress-report.mjs";

const answer = (reason = "field-not-found") =>
  `SCHÄTZUNG;NICHT_VERFÜGBAR;${reason}\nSCOPE-LÜCKE;SCHÄTZUNG;${reason}`;
function exchange({ projectKey = "LRG", reason = "field-not-found", estimate = null } = {}) {
  return {
    call: { arguments: { projectKey } },
    result: {
      status: "completed",
      toolRef: { canonicalId: "keiko.jira.report" },
      data: {
        outcome: "succeeded",
        status: "complete",
        reportId: "native-report",
        report: {
          digest: "a".repeat(64),
          scope: {
            projectKey,
            estimateUnit: "unavailable",
            estimateSource: "unavailable",
            estimateUnavailableReason: reason,
          },
          progress: { project: { total: 42, estimate } },
          completeness: { complete: true, issuesRead: 42, issuesTotal: 42 },
        },
      },
    },
  };
}
const grade = (text, exchanges = [exchange()]) =>
  progress.gradeUnavailable(text, exchanges, { projectKey: "LRG" });

describe("W9 unavailable estimate evidence", () => {
  it.each(["field-not-found", "metadata-unavailable", "ambiguous-field"])(
    "requires the native unavailable state and reason %s",
    (reason) => {
      expect(grade(answer(reason), [exchange({ reason })])).toMatchObject({
        ok: true,
        metric: { status: "unavailable", reason },
      });
    },
  );
  it("accepts English and unrelated zero issue counts", () => {
    expect(
      grade(
        "ESTIMATE;UNAVAILABLE;field-not-found\nSCOPE GAP;ESTIMATE;field-not-found\nANZAHL;Bug;Done;0",
      ).ok,
    ).toBe(true);
  });
  it.each([
    "SCHÄTZUNG;0;0;0\nSCOPE-LÜCKE;SCHÄTZUNG;field-not-found",
    answer() + "\nSCHÄTZUNG;0;0;0",
    answer() + "\nDie Schätzung beträgt 0 Stunden.",
    answer() + "\n| Estimate | 0 |",
    "SCHÄTZUNG;NICHT_VERFÜGBAR;field-not-found",
    "SCOPE-LÜCKE;SCHÄTZUNG;field-not-found",
    answer("metadata-unavailable"),
  ])("refuses zero, an omitted scope gap or a conflicting reason: %s", (text) => {
    expect(grade(text).ok).toBe(false);
  });
  it.each([
    { exchanges: [] },
    { exchanges: [exchange({ projectKey: "OTHER" })] },
    { exchanges: [exchange({ reason: "invented" })] },
    { exchanges: [exchange({ reason: null, estimate: { total: 0, done: 0, remaining: 0 } })] },
  ])("credits no unavailable metric without native evidence (%j)", ({ exchanges }) => {
    expect(grade(answer(), exchanges).ok).toBe(false);
  });
  it("does not reuse an old unavailable result after a current available one", () => {
    expect(
      grade(answer(), [exchange(), exchange({ estimate: { total: 0, done: 0, remaining: 0 } })]).ok,
    ).toBe(false);
  });
  it("does not reuse an earlier report after the current request is denied", () => {
    const denied = {
      call: { arguments: { projectKey: "LRG" } },
      result: {
        status: "failed",
        toolRef: { canonicalId: "keiko.jira.report" },
        data: { outcome: "failed", reason: "permission-denied" },
      },
    };
    expect(grade(answer(), [exchange(), denied]).ok).toBe(false);
  });
  it("refuses a report for a different native scope even when the call requested this project", () => {
    const wrong = exchange({ projectKey: "OTHER" });
    wrong.call.arguments.projectKey = "LRG";
    expect(grade(answer(), [wrong]).ok).toBe(false);
  });
  it("invalidates a denied continuation of the same report, without invalidating a foreign report", () => {
    const continuation = (reportId) => ({
      call: { arguments: { reportId } },
      result: {
        status: "failed",
        toolRef: { canonicalId: "keiko.jira.report" },
        data: { outcome: "failed", reason: "permission-denied" },
      },
    });
    expect(grade(answer(), [exchange(), continuation("unrelated-report")]).ok).toBe(true);
    expect(grade(answer(), [exchange(), continuation("native-report")]).ok).toBe(false);
  });
  it("keeps a successfully read continuation bound to its summary", () => {
    const continuation = {
      call: { arguments: { reportId: "native-report" } },
      result: {
        status: "completed",
        toolRef: { canonicalId: "keiko.jira.report" },
        data: {
          outcome: "succeeded",
          status: "complete",
          reportId: "native-report",
          report: { digest: "a".repeat(64) },
          section: { name: "statuses", items: [] },
        },
      },
    };
    expect(grade(answer(), [exchange(), continuation]).ok).toBe(true);
    continuation.result.data.report.digest = "b".repeat(64);
    expect(grade(answer(), [exchange(), continuation]).ok).toBe(false);
  });
  it("does not infer unavailable from an initial reading slice and a section without its final summary", () => {
    const reading = exchange();
    reading.result.data = { outcome: "succeeded", status: "reading", reportId: "native-report" };
    const section = {
      call: { arguments: { reportId: "native-report" } },
      result: {
        status: "completed",
        toolRef: { canonicalId: "keiko.jira.report" },
        data: {
          outcome: "succeeded",
          status: "complete",
          reportId: "native-report",
          report: { digest: "a".repeat(64) },
          section: { name: "statuses", items: [] },
        },
      },
    };
    expect(grade(answer(), [reading, section]).ok).toBe(false);
  });
  it.each([true, false])(
    "does not grade a lab timeout, even when a partial answer looks complete (%s)",
    async (completeAnswer) => {
      const turn = {
        answer: completeAnswer ? answer() : "",
        termination: "lab-limit",
        failure: "timed-out",
        toolExchanges: [exchange()],
      };
      const ctx = {
        truth: { large: { project: "LRG" } },
        freshChat: async () => ({}),
        turn: async () => turn,
      };
      expect((await progress.unavailableProgressPart(ctx)).part).toMatchObject({
        status: "unverified",
        covers: [],
      });
    },
  );
  it("runs the unavailable-project turn and grades its structured evidence", async () => {
    const turn = { answer: answer(), durationMs: 1, toolCalls: 1, toolExchanges: [exchange()] };
    const ctx = {
      truth: { large: { project: "LRG" } },
      freshChat: vi.fn().mockResolvedValue({ id: "fresh" }),
      turn: vi.fn().mockResolvedValue(turn),
    };
    const result = await progress.unavailableProgressPart(ctx);
    expect(result).toMatchObject({
      turn,
      part: { status: "green", covers: ["unavailable-metrics-labelled"] },
    });
    expect(ctx.turn).toHaveBeenCalledExactlyOnceWith(
      { id: "fresh" },
      expect.stringContaining("LRG"),
    );
  });
  it("does not claim a proof when the required project was not seeded", async () => {
    const ctx = { truth: {}, turn: vi.fn() };
    expect((await progress.unavailableProgressPart(ctx)).part).toMatchObject({
      status: "unverified",
      covers: [],
    });
    expect(ctx.turn).not.toHaveBeenCalled();
  });
});
