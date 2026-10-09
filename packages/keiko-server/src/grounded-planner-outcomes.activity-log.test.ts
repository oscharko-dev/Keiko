import { describe, expect, it } from "vitest";
import { DEFAULT_EXPLORATION_BUDGET } from "@oscharko-dev/keiko-contracts/connected-context";
import { createExplorationPlan } from "@oscharko-dev/keiko-workflows";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import {
  ClarificationNeededError,
  retrieveConnectedContextPack,
  type OrchestratorDeps,
  type OrchestratorInput,
} from "./grounded-orchestrator.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const ROOT = "/private/customer/planner-outcomes";
const CORRELATION = "planner-outcome-correlation";
type Log = ReturnType<typeof createBufferedServerLogSink>;

function input(text: string): OrchestratorInput {
  return {
    workspaceRoot: ROOT,
    scope: {
      schemaVersion: "1",
      scopeId: "private-scope",
      workspaceRoot: ROOT,
      kind: "workspace-root",
      relativePaths: [],
      conversationId: undefined,
      connectedAtMs: 0,
      explicitConnection: false,
    },
    query: { kind: "natural-language", text, maxResults: 20, caseSensitive: false, emittedAtMs: 0 },
    budget: { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 0 },
  };
}

function deps(log: Log): OrchestratorDeps {
  return {
    activityLog: log,
    correlationId: CORRELATION,
    nowMs: () => 0,
    fs: memFs(ROOT, { "fact.txt": "Needle is recorded here." }),
    answerer: { answer: () => Promise.reject(new TypeError("No model call is permitted.")) },
  };
}

const CLARIFICATIONS = [
  { reason: "no-anchors", text: "the and for of" },
  { reason: "too-generic", text: "alpha bravo charlie delta" },
  { reason: "scope-empty", text: "`Solo`" },
  { reason: "scope-invalid", text: "Find Needle" },
] as const;

const DIRECT_LOOKUPS = [
  ["Where is Needle defined?", true, ["lexical"]],
  ["Which file implements POST /api/payments/:id/refund?", true, ["lexical"]],
  [
    "Where is Needle defined and which callers use it?",
    false,
    ["lexical", "structural", "git-history"],
  ],
] as const;

function clarificationInput(reason: string, text: string): OrchestratorInput {
  const request = input(text);
  return reason === "scope-invalid"
    ? { ...request, scope: { ...request.scope, scopeId: "" } }
    : request;
}

describe("planner outcome evidence", () => {
  it.each(CLARIFICATIONS)(
    "records $reason as a correlated clarification outcome",
    async (entry) => {
      const request = clarificationInput(entry.reason, entry.text);
      const plan = createExplorationPlan(
        {
          scope: request.scope,
          query: request.query,
          ...(request.budget === undefined ? {} : { budget: request.budget }),
        },
        { nowMs: () => 0 },
      );
      expect(plan.clarification?.reason).toBe(entry.reason);
      const log = createBufferedServerLogSink();
      await expect(retrieveConnectedContextPack(request, deps(log))).rejects.toBeInstanceOf(
        ClarificationNeededError,
      );
      expect(log.events.map((event) => event.op)).toEqual([
        "search.connected-context.started",
        "search.connected-context.clarification-needed",
      ]);
      expect(log.events.at(-1)).toMatchObject({
        level: "info",
        correlationId: CORRELATION,
        extra: {
          clarificationReason: entry.reason,
          retrievalIntent: plan.retrievalIntent,
          anchorCount: plan.anchors.length,
          plannedRingCount: 0,
          directEvidenceLookup: false,
          completeness: "complete",
          loss: "none",
        },
      });
      expect(log.lines().join("\n")).not.toContain(entry.text);
      expect(log.lines().join("\n")).not.toContain(ROOT);
    },
  );

  it.each(DIRECT_LOOKUPS)(
    "emits the actual planner lookup decision for %s",
    async (text, direct, rings) => {
      const request = input(text);
      const log = createBufferedServerLogSink();
      const result = await retrieveConnectedContextPack(
        { ...request, scope: { ...request.scope, explicitConnection: true } },
        deps(log),
      );
      expect(result.plan).toMatchObject({ directEvidenceLookup: direct });
      expect(result.plan.rings.map((ring) => ring.kind)).toEqual(rings);
      expect(
        log.events.find((event) => event.op === "search.connected-context.source-details")?.extra,
      ).toMatchObject({ directEvidenceLookup: direct });
    },
  );

  it("retains a failed outcome for an unexpected planner error", async () => {
    const request = input("Find Needle");
    const log = createBufferedServerLogSink();
    const failure = new TypeError("Private planner fixture failure");
    const query = { ...request.query };
    Object.defineProperty(query, "text", {
      get: () => {
        throw failure;
      },
    });
    await expect(retrieveConnectedContextPack({ ...request, query }, deps(log))).rejects.toBe(
      failure,
    );
    expect(log.events.some((event) => event.op === "search.connected-context.failed")).toBe(true);
    expect(
      log.events.some((event) => event.op === "search.connected-context.clarification-needed"),
    ).toBe(false);
  });
});

describe("canonical planner outcome lines", () => {
  it.each(DIRECT_LOOKUPS)("persists the actual lookup decision for %s", async (text, direct) => {
    const request = input(text);
    const log = createBufferedServerLogSink();
    await retrieveConnectedContextPack(
      { ...request, scope: { ...request.scope, explicitConnection: true } },
      deps(log),
    );
    const event = log.events.find((line) => line.op === "search.connected-context.source-details");
    const line = expectActivityLogProof(
      "search.connected-context.source-details.line",
      formatActivityLogProofLine(event ?? {}),
    );
    expect(line).toMatchObject({ correlationId: CORRELATION, directEvidenceLookup: direct });
  });

  it.each(CLARIFICATIONS)("persists the exact $reason proof", async (entry) => {
    const log = createBufferedServerLogSink();
    await expect(
      retrieveConnectedContextPack(clarificationInput(entry.reason, entry.text), deps(log)),
    ).rejects.toBeInstanceOf(ClarificationNeededError);
    const event = log.events.find(
      (line) => line.op === "search.connected-context.clarification-needed",
    );
    const line = expectActivityLogProof(
      "search.connected-context.clarification-needed.line",
      formatActivityLogProofLine(event ?? {}),
    );
    expect(line).toMatchObject({ correlationId: CORRELATION, clarificationReason: entry.reason });
  });
});
