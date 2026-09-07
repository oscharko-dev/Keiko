import { describe, expect, it, vi } from "vitest";
import type { ServerLogEvent } from "../observability/server-log.js";
import {
  JourneyObservationController,
  type JourneyObservationOptions,
  type JourneyObservationContext,
} from "./journeyObservationService.js";
import { journeyFixture } from "./journeyOutcomeTest/_support.js";
import { gitDeliveryObservationFailure } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import type { GitJourneyFactsResult } from "@oscharko-dev/keiko-tools/internal/git-mutation";

function fixture(): {
  source: ReturnType<typeof journeyFixture>;
  context: JourneyObservationContext;
  options: JourneyObservationOptions;
  logs: ServerLogEvent[];
  read: ReturnType<typeof vi.fn<() => Promise<GitJourneyFactsResult>>>;
  readiness: ReturnType<typeof vi.fn<JourneyObservationOptions["readiness"]>>;
  description: ReturnType<typeof vi.fn<JourneyObservationOptions["description"]>>;
  record: ReturnType<typeof vi.fn<JourneyObservationOptions["recordOutcome"]>>;
} {
  const source = journeyFixture();
  const logs: ServerLogEvent[] = [];
  const context = {
    draft: source.draft,
    accessScope: {},
    correlationId: "journey-run-1",
    stillAuthorized: (): boolean => true,
  };
  const read = vi.fn((): Promise<GitJourneyFactsResult> =>
    Promise.resolve(structuredClone(source.facts)),
  );
  const readiness = vi.fn(() => Promise.resolve(source.readiness));
  const description = vi.fn(() => Promise.resolve(source.description));
  const record = vi.fn(() => true);
  return {
    source,
    context,
    logs,
    read,
    readiness,
    description,
    record,
    options: {
      context: () => context,
      reader: () => ({ readJourney: read }),
      readiness,
      description,
      recordOutcome: record,
      now: () => source.observedAtMs,
      activityLog: {
        write: (event): void => {
          logs.push(event);
        },
      },
    },
  };
}
describe("read-only journey observation owner", () => {
  it("brackets refreshed CI and body status with bound canonical provider reads and logs only facts", async () => {
    const f = fixture();
    expect(await new JourneyObservationController(f.options).observe()).toMatchObject({
      status: "observed",
      outcome: { state: "awaiting-ready-approval" },
    });
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.readiness).toHaveBeenCalledOnce();
    expect(f.description).toHaveBeenCalledOnce();
    expect(f.record).toHaveBeenCalledOnce();
    expect(f.logs).toEqual([
      expect.objectContaining({
        op: "git.journey-observation",
        correlationId: "journey-run-1",
        extra: expect.objectContaining({ phase: "started" }) as unknown,
      }),
      expect.objectContaining({
        op: "git.journey-observation",
        correlationId: "journey-run-1",
        extra: expect.objectContaining({
          phase: "observed",
          state: "awaiting-ready-approval",
        }) as unknown,
      }),
    ]);
    expect(JSON.stringify(f.logs)).not.toMatch(
      /https:|owner\/repository|outsideRegion|finalBody|approvalToken/u,
    );
  });
  it("does not refresh CI for an already merged PR and observes delayed issue closure", async () => {
    const f = fixture();
    const facts = {
      ...f.source.facts,
      identity: { ...f.source.facts.identity, state: "closed" as const, isDraft: false },
      mergedAt: "2026-09-05T00:00:00Z",
      mergeCommitSha: "f".repeat(40),
    };
    f.read.mockResolvedValue(facts);
    f.description.mockResolvedValue(null);
    expect(await new JourneyObservationController(f.options).observe()).toMatchObject({
      outcome: { state: "merged-awaiting-issue-closure" },
    });
    expect(f.readiness).not.toHaveBeenCalled();
    f.read.mockResolvedValue({
      ...facts,
      issue: { ...facts.issue, state: "closed", closedAt: "2026-09-05T00:00:00Z" },
    });
    expect(await new JourneyObservationController(f.options).observe()).toMatchObject({
      outcome: { state: "completed" },
    });
    expect(f.readiness).not.toHaveBeenCalled();
  });
  it("preserves provider visibility failure without falling back to prior ready evidence", async () => {
    const f = fixture();
    f.read.mockResolvedValue({
      status: "unavailable",
      failure: gitDeliveryObservationFailure("provider-forbidden"),
    });
    expect(await new JourneyObservationController(f.options).observe()).toMatchObject({
      outcome: { state: "blocked", observationFailure: { reason: "provider-forbidden" } },
    });
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.readiness).not.toHaveBeenCalled();
    expect(f.description).not.toHaveBeenCalled();
  });
  it("rejects changed review state even if an injected reader incorrectly reuses its digest", async () => {
    const f = fixture();
    f.read
      .mockResolvedValueOnce(f.source.facts)
      .mockResolvedValue({ ...f.source.facts, reviewDecision: "changes-requested" });
    expect(await new JourneyObservationController(f.options).observe()).toMatchObject({
      status: "unavailable",
      reason: "observation-superseded",
    });
    expect(f.record).not.toHaveBeenCalled();
  });
  it("captures initial provider facts before an awaited description read can mutate its source", async () => {
    const f = fixture();
    const first = structuredClone(f.source.facts);
    f.read.mockResolvedValue(first);
    f.description.mockImplementation(() => {
      Object.assign(first, { reviewDecision: "changes-requested" });
      return Promise.resolve(f.source.description);
    });
    expect(await new JourneyObservationController(f.options).observe()).toMatchObject({
      status: "unavailable",
      reason: "observation-superseded",
    });
    expect(f.record).not.toHaveBeenCalled();
  });
  it.each(["authority", "scope", "draft", "expiry"] as const)(
    "discards %s drift during remote reading",
    async (kind) => {
      const f = fixture();
      f.readiness.mockImplementation(() => {
        if (kind === "authority") Object.assign(f.context, { stillAuthorized: () => false });
        if (kind === "scope") Object.assign(f.context, { accessScope: {} });
        if (kind === "draft")
          Object.assign(f.source.draft, { revision: f.source.draft.revision + 1 });
        if (kind === "expiry")
          Object.assign(f.source, { observedAtMs: f.source.observedAtMs + 60_000 });
        return Promise.resolve(f.source.readiness);
      });
      expect(await new JourneyObservationController(f.options).observe()).toMatchObject({
        status: "unavailable",
        reason: "observation-superseded",
      });
      expect(f.record).not.toHaveBeenCalled();
    },
  );
  it("rejects a stale persistence CAS and never republishes a ready result", async () => {
    const f = fixture();
    f.record.mockReturnValue(false);
    expect(await new JourneyObservationController(f.options).observe()).toMatchObject({
      status: "unavailable",
      reason: "observation-superseded",
    });
  });
  it("keeps observation concurrency bounded and reports structured failures", async () => {
    const f = fixture();
    let finish: (value: GitJourneyFactsResult) => void = () => {
      throw new TypeError("Not started");
    };
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const service = new JourneyObservationController(f.options);
    const first = service.observe();
    expect(await service.observe()).toMatchObject({ reason: "observation-in-flight" });
    finish(f.source.facts);
    await first;
    f.read.mockRejectedValue(new TypeError("fixture failed without source content"));
    expect(await service.observe()).toMatchObject({ reason: "provider-unavailable" });
    expect(f.logs.at(-1)).toMatchObject({
      op: "git.journey-observation",
      correlationId: "journey-run-1",
      errorKind: "internal",
      extra: expect.objectContaining({ frames: expect.any(Array) as unknown }) as unknown,
    });
  });
});
