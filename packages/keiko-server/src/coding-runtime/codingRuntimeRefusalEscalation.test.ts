import { describe, expect, it } from "vitest";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";

import { EDIT_FAILURE_REASON_CODES } from "./codingToolFacade.js";
import type { CodingToolEditOutcome } from "./codingToolFacadePorts.js";
import {
  classifyEditRefusal,
  CodingRuntimeEditRefusalStreaks,
  EDIT_REFUSAL_REASON_CODES,
  recordRefusalEscalated,
  REPAIRABLE_EDIT_REFUSAL_BOUND,
  UNREPAIRABLE_EDIT_REFUSAL_BOUND,
  type CodingRuntimeRefusalEscalation,
} from "./codingRuntimeRefusalEscalation.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

const RUN_ID = "run-f5-0001";
const refused = (reasonCode: string): CodingToolEditOutcome => ({ kind: "refused", reasonCode });
const APPLIED: CodingToolEditOutcome = { kind: "applied" };

function observeTimes(
  streaks: CodingRuntimeEditRefusalStreaks,
  outcome: CodingToolEditOutcome,
  times: number,
  runId = RUN_ID,
): readonly (CodingRuntimeRefusalEscalation | undefined)[] {
  return Array.from({ length: times }, () => streaks.observe(runId, outcome));
}

// F5 (#3873, live Gemma qualification): the classification and the bounds the run's orchestration
// settles a run with once its edits keep being refused for the same closed reason.
describe("classifyEditRefusal", () => {
  it("pins the documented bounds: three for an unrepairable refusal, six for a repairable one", () => {
    expect(UNREPAIRABLE_EDIT_REFUSAL_BOUND).toBe(3);
    expect(REPAIRABLE_EDIT_REFUSAL_BOUND).toBe(6);
  });

  // The facade forwards the model a closed code from its own vocabulary; one it can forward but
  // this table does not classify would fall to UNCLASSIFIED and lose the class it really has.
  it("classifies every edit refusal code the facade can forward to the model", () => {
    for (const code of EDIT_FAILURE_REASON_CODES) {
      expect(EDIT_REFUSAL_REASON_CODES).toContain(code);
      expect(classifyEditRefusal(code).reasonCode).toBe(code);
    }
  });

  it.each([
    ["NO_ACTIVE_SESSION", "unavailable"],
    ["NO_ACTIVE_BRIDGE", "unavailable"],
    ["WORKSPACE_ACCESS_LOST", "authority-denied"],
    ["OUT_OF_SCOPE", "authority-denied"],
    ["POLICY_DENIED", "authority-denied"],
  ] as const)(
    "names %s a refusal the model cannot repair, settling as edits-blocked",
    (code, errorKind) => {
      expect(classifyEditRefusal(code)).toEqual({
        reasonCode: code,
        refusalClass: "unrepairable",
        errorKind,
        bound: UNREPAIRABLE_EDIT_REFUSAL_BOUND,
        failureCode: "edits-blocked",
      });
    },
  );

  it.each([
    ["INVALID_EDITS", "validation-failed"],
    ["CONTENT_HASH_MISMATCH", "conflict"],
    ["VERSION_MISMATCH", "conflict"],
    ["PRECONDITION_REQUIRED", "validation-failed"],
  ] as const)(
    "keeps %s a refusal the model can repair, bounded higher as edit-retries-exhausted",
    (code, errorKind) => {
      expect(classifyEditRefusal(code)).toEqual({
        reasonCode: code,
        refusalClass: "repairable",
        errorKind,
        bound: REPAIRABLE_EDIT_REFUSAL_BOUND,
        failureCode: "edit-retries-exhausted",
      });
    },
  );

  it("reads a code outside the closed vocabulary as UNCLASSIFIED, never echoing it", () => {
    expect(classifyEditRefusal("free text from a client /private/path")).toEqual({
      reasonCode: "UNCLASSIFIED",
      refusalClass: "repairable",
      errorKind: "unknown",
      bound: REPAIRABLE_EDIT_REFUSAL_BOUND,
      failureCode: "edit-retries-exhausted",
    });
  });
});

describe("CodingRuntimeEditRefusalStreaks", () => {
  it("escalates the third consecutive NO_ACTIVE_SESSION refusal, and only once", () => {
    const streaks = new CodingRuntimeEditRefusalStreaks();
    const results = observeTimes(streaks, refused("NO_ACTIVE_SESSION"), 5);

    expect(results.slice(0, 2)).toEqual([undefined, undefined]);
    expect(results[2]).toMatchObject({
      reasonCode: "NO_ACTIVE_SESSION",
      refusalClass: "unrepairable",
      consecutiveCount: 3,
      bound: 3,
      failureCode: "edits-blocked",
    });
    expect(results.slice(3)).toEqual([undefined, undefined]);
    expect(streaks.escalation(RUN_ID)).toEqual(results[2]);
  });

  it("escalates the sixth consecutive INVALID_EDITS refusal, not the fifth", () => {
    const streaks = new CodingRuntimeEditRefusalStreaks();
    expect(observeTimes(streaks, refused("INVALID_EDITS"), 5)).toEqual(Array(5).fill(undefined));
    expect(streaks.observe(RUN_ID, refused("INVALID_EDITS"))).toMatchObject({
      reasonCode: "INVALID_EDITS",
      refusalClass: "repairable",
      consecutiveCount: 6,
      bound: 6,
      failureCode: "edit-retries-exhausted",
    });
  });

  it("starts a new streak on another reason and ends it on an applied edit", () => {
    const streaks = new CodingRuntimeEditRefusalStreaks();
    observeTimes(streaks, refused("NO_ACTIVE_SESSION"), 2);
    expect(streaks.observe(RUN_ID, refused("WORKSPACE_ACCESS_LOST"))).toBeUndefined();
    observeTimes(streaks, refused("NO_ACTIVE_SESSION"), 2);
    expect(streaks.observe(RUN_ID, APPLIED)).toBeUndefined();
    expect(observeTimes(streaks, refused("NO_ACTIVE_SESSION"), 2)).toEqual([undefined, undefined]);
    expect(streaks.escalation(RUN_ID)).toBeUndefined();
    expect(streaks.observe(RUN_ID, refused("NO_ACTIVE_SESSION"))).toMatchObject({
      consecutiveCount: 3,
    });
  });

  it("keeps runs apart and forgets a cleared run", () => {
    const streaks = new CodingRuntimeEditRefusalStreaks();
    observeTimes(streaks, refused("NO_ACTIVE_SESSION"), 2, "run-f5-other");
    observeTimes(streaks, refused("NO_ACTIVE_SESSION"), 3);
    expect(streaks.escalation("run-f5-other")).toBeUndefined();
    expect(streaks.escalation(RUN_ID)).toBeDefined();

    streaks.clear(RUN_ID);
    expect(streaks.escalation(RUN_ID)).toBeUndefined();
    expect(observeTimes(streaks, refused("NO_ACTIVE_SESSION"), 2)).toEqual([undefined, undefined]);
  });
});

describe("recordRefusalEscalated", () => {
  it("writes one body-free warn line under the run's correlation", () => {
    const records: ServerLogEvent[] = [];
    const streaks = new CodingRuntimeEditRefusalStreaks();
    const escalation = observeTimes(streaks, refused("OUT_OF_SCOPE"), 3)[2];
    if (escalation === undefined) throw new Error("expected an escalation");

    recordRefusalEscalated({ write: (event) => void records.push(event) }, RUN_ID, escalation);

    expect(records).toHaveLength(1);
    const [line] = records;
    if (line === undefined) throw new Error("expected the escalation line");
    expect(line).toMatchObject({
      level: "warn",
      correlationId: RUN_ID,
      errorKind: "authority-denied",
    });
    expect(
      expectActivityLogProof(
        "coding-runtime.run.refusal-escalated.emitted-line",
        formatActivityLogProofLine(line),
      ),
    ).toEqual(
      expect.objectContaining({
        runId: RUN_ID,
        reasonCode: "OUT_OF_SCOPE",
        refusalClass: "unrepairable",
        consecutiveCount: 3,
        bound: 3,
        failureCode: "edits-blocked",
      }),
    );
  });

  it("falls back to the unknown correlation for a run id the correlation shape refuses", () => {
    const records: ServerLogEvent[] = [];
    const escalation = observeTimes(
      new CodingRuntimeEditRefusalStreaks(),
      refused("NO_ACTIVE_SESSION"),
      3,
      "run-1",
    )[2];
    if (escalation === undefined) throw new Error("expected an escalation");
    recordRefusalEscalated({ write: (event) => void records.push(event) }, "run-1", escalation);
    expect(records[0]?.correlationId).toBe("unknown-correlation-id");
  });
});
