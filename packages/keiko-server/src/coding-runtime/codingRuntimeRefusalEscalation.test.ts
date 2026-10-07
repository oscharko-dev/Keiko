import { describe, expect, it } from "vitest";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";

import { EDIT_FAILURE_REASON_CODES } from "./codingToolFacade.js";
import {
  EDIT_PREPARE_CAUSES,
  EDIT_PREPARE_ERROR_KINDS,
  EDIT_READ_REASONS,
  type CodingToolEditOutcome,
  type EditPrepareCause,
  type EditReadReason,
} from "./codingToolFacadePorts.js";
import {
  classifyEditRefusal,
  CodingRuntimeEditRefusalStreaks,
  EDIT_REFUSAL_REASON_CODES,
  isUncountedEditRefusal,
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
// An edit the port refused while preparing it: the closed cause rides beside the code.
const prepareFailed = (
  prepareCause: EditPrepareCause,
  readReason?: EditReadReason,
): CodingToolEditOutcome => ({
  kind: "refused",
  reasonCode: "EDIT_PREPARE_FAILED",
  prepareCause,
  ...(readReason === undefined ? {} : { readReason }),
});

function observeTimes(
  streaks: CodingRuntimeEditRefusalStreaks,
  outcome: CodingToolEditOutcome,
  times: number,
  runId = RUN_ID,
): readonly (CodingRuntimeRefusalEscalation | undefined)[] {
  return Array.from({ length: times }, () => streaks.observe(runId, outcome));
}

// F5 (#3873, live Gemma qualification): the classification and the bounds the run's orchestration
// settles a run with once its edits keep being refused.
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

  it("ends the streak on an applied edit", () => {
    const streaks = new CodingRuntimeEditRefusalStreaks();
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

// #3873 review (PR #3876): the streak was kept per closed reason code, so a model that alternated two
// refusals — an edit that does not match, a stale re-read, an edit that does not match again — never
// repeated one code, was never bounded, and spent the whole prompt allowance. Both bounds now run
// over the refusals since the run's last applied edit, whatever their codes.
describe("a streak counts refusals whatever their code", () => {
  const alternating = (
    streaks: CodingRuntimeEditRefusalStreaks,
    codes: readonly string[],
    count: number,
  ): readonly (CodingRuntimeRefusalEscalation | undefined)[] =>
    Array.from({ length: count }, (_unused, index) =>
      streaks.observe(RUN_ID, refused(codes[index % codes.length] ?? "UNCLASSIFIED")),
    );

  it("settles a run that alternates two repairable refusals at the sixth, not never", () => {
    const streaks = new CodingRuntimeEditRefusalStreaks();
    const results = alternating(streaks, ["INVALID_EDITS", "CONTENT_HASH_MISMATCH"], 6);

    expect(results.slice(0, 5)).toEqual(Array(5).fill(undefined));
    expect(results[5]).toMatchObject({
      reasonCode: "CONTENT_HASH_MISMATCH",
      refusalClass: "repairable",
      errorKind: "conflict",
      consecutiveCount: REPAIRABLE_EDIT_REFUSAL_BOUND,
      bound: REPAIRABLE_EDIT_REFUSAL_BOUND,
      failureCode: "edit-retries-exhausted",
      refusalCount: 6,
      unrepairableCount: 0,
    });
    expect(streaks.escalation(RUN_ID)).toEqual(results[5]);
  });

  it("settles a run that alternates two unrepairable refusals at the third", () => {
    const streaks = new CodingRuntimeEditRefusalStreaks();
    const results = alternating(streaks, ["NO_ACTIVE_SESSION", "WORKSPACE_ACCESS_LOST"], 4);

    expect(results.slice(0, 2)).toEqual([undefined, undefined]);
    expect(results[2]).toMatchObject({
      reasonCode: "NO_ACTIVE_SESSION",
      refusalClass: "unrepairable",
      consecutiveCount: UNREPAIRABLE_EDIT_REFUSAL_BOUND,
      bound: UNREPAIRABLE_EDIT_REFUSAL_BOUND,
      failureCode: "edits-blocked",
      refusalCount: 3,
      unrepairableCount: 3,
    });
    expect(results[3]).toBeUndefined();
  });

  it("counts the unrepairable refusals between repairable ones, since the last applied edit", () => {
    const streaks = new CodingRuntimeEditRefusalStreaks();
    const results = alternating(
      streaks,
      ["INVALID_EDITS", "NO_ACTIVE_SESSION", "INVALID_EDITS", "NO_ACTIVE_SESSION", "DIRTY"],
      5,
    );

    expect(results.slice(0, 4)).toEqual(Array(4).fill(undefined));
    expect(results[4]).toMatchObject({
      reasonCode: "DIRTY",
      refusalClass: "unrepairable",
      failureCode: "edits-blocked",
      consecutiveCount: 3,
      refusalCount: 5,
      unrepairableCount: 3,
    });
  });

  it("meets the six-refusal bound on a mixed run whose unrepairable refusals stay below three", () => {
    const streaks = new CodingRuntimeEditRefusalStreaks();
    const results = alternating(
      streaks,
      ["INVALID_EDITS", "INVALID_EDITS", "CONTENT_HASH_MISMATCH", "INVALID_EDITS", "TIMED_OUT"],
      5,
    );
    expect(results).toEqual(Array(5).fill(undefined));

    // The sixth refusal is an unrepairable one, but only two of the six were.
    const sixth = streaks.observe(RUN_ID, refused("QUEUE_FULL"));
    expect(sixth).toMatchObject({
      // The latest refusal's own code and error class...
      reasonCode: "QUEUE_FULL",
      errorKind: "unavailable",
      // ...and the bound that was met: six refusals in a row, not three unrepairable ones.
      refusalClass: "repairable",
      consecutiveCount: 6,
      bound: REPAIRABLE_EDIT_REFUSAL_BOUND,
      failureCode: "edit-retries-exhausted",
      refusalCount: 6,
      unrepairableCount: 2,
    });
  });

  it("ends the whole streak on an applied edit, whatever refusals came before it", () => {
    const streaks = new CodingRuntimeEditRefusalStreaks();
    const codes = ["INVALID_EDITS", "CONTENT_HASH_MISMATCH"];
    expect(alternating(streaks, codes, 5)).toEqual(Array(5).fill(undefined));
    expect(streaks.observe(RUN_ID, APPLIED)).toBeUndefined();

    expect(alternating(streaks, codes, 5)).toEqual(Array(5).fill(undefined));
    expect(streaks.escalation(RUN_ID)).toBeUndefined();
    expect(streaks.observe(RUN_ID, refused("INVALID_EDITS"))).toMatchObject({
      failureCode: "edit-retries-exhausted",
      refusalCount: 6,
    });
  });

  it("settles an alternating run once: later refusals add no second escalation", () => {
    const streaks = new CodingRuntimeEditRefusalStreaks();
    const results = alternating(streaks, ["INVALID_EDITS", "CONTENT_HASH_MISMATCH"], 12);

    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
  });
});

// #3873 review (PR #3876): `EDIT_PREPARE_FAILED` was classed repairable by its code alone, although
// the facade also raises it for causes the model cannot repair: an edit whose governed read is
// refused, a workspace whose access was lost, a guard that no longer holds. Such a run took six
// refusals instead of three, and the Workbench then told the operator the edits "no longer matched
// the file".
describe("EDIT_PREPARE_FAILED is classified by its cause", () => {
  it.each([
    ["workspace-access-lost", "authority-denied"],
    ["guard-denied", "authority-denied"],
    ["binding-unavailable", "authority-denied"],
    ["editor-context-unavailable", "unavailable"],
    ["lease-unavailable", "conflict"],
    ["replacement-read-failed", "unavailable"],
  ] as const)(
    "names a refusal caused by %s one the model cannot repair, settling as edits-blocked",
    (prepareCause, errorKind) => {
      expect(classifyEditRefusal("EDIT_PREPARE_FAILED", { prepareCause })).toEqual({
        reasonCode: "EDIT_PREPARE_FAILED",
        refusalClass: "unrepairable",
        errorKind,
        bound: UNREPAIRABLE_EDIT_REFUSAL_BOUND,
        failureCode: "edits-blocked",
      });
    },
  );

  it("keeps an invalid changeset repairable: the model wrote it and can fix it", () => {
    expect(
      classifyEditRefusal("EDIT_PREPARE_FAILED", { prepareCause: "changeset-invalid" }),
    ).toEqual({
      reasonCode: "EDIT_PREPARE_FAILED",
      refusalClass: "repairable",
      errorKind: "validation-failed",
      bound: REPAIRABLE_EDIT_REFUSAL_BOUND,
      failureCode: "edit-retries-exhausted",
    });
  });

  it("reads a refusal that carried no cause as the repairable class its code names", () => {
    expect(classifyEditRefusal("EDIT_PREPARE_FAILED")).toEqual({
      reasonCode: "EDIT_PREPARE_FAILED",
      refusalClass: "repairable",
      errorKind: "validation-failed",
      bound: REPAIRABLE_EDIT_REFUSAL_BOUND,
      failureCode: "edit-retries-exhausted",
    });
  });

  it("gives no other code a cause: a code outside EDIT_PREPARE_FAILED keeps its own class", () => {
    expect(classifyEditRefusal("INVALID_EDITS", { prepareCause: "guard-denied" })).toMatchObject({
      refusalClass: "repairable",
      errorKind: "validation-failed",
    });
  });

  // The refusal line, the escalation and the settlement name one failure alike.
  it.each(EDIT_PREPARE_CAUSES.filter((cause) => cause !== "changeset-invalid"))(
    "records the error class the edit port logs for %s",
    (prepareCause) => {
      expect(classifyEditRefusal("EDIT_PREPARE_FAILED", { prepareCause }).errorKind).toBe(
        EDIT_PREPARE_ERROR_KINDS[prepareCause],
      );
    },
  );

  it("classifies every cause the edit port can raise, and only a cancelled one counts for nothing", () => {
    for (const prepareCause of EDIT_PREPARE_CAUSES) {
      expect(classifyEditRefusal("EDIT_PREPARE_FAILED", { prepareCause }).reasonCode).toBe(
        "EDIT_PREPARE_FAILED",
      );
      expect(isUncountedEditRefusal({ prepareCause })).toBe(prepareCause === "cancelled");
    }
    for (const readReason of EDIT_READ_REASONS) {
      expect(isUncountedEditRefusal({ prepareCause: "replacement-read-failed", readReason })).toBe(
        readReason === "cancelled",
      );
    }
  });

  it.each(["not-text", "too-large", "denied", "preflight-refused", "timeout"] as const)(
    "settles a run whose edits keep failing their governed read (%s) as edits-blocked at three",
    (readReason) => {
      const streaks = new CodingRuntimeEditRefusalStreaks();
      const outcome = prepareFailed("replacement-read-failed", readReason);

      expect(observeTimes(streaks, outcome, 2)).toEqual([undefined, undefined]);
      expect(streaks.observe(RUN_ID, outcome)).toMatchObject({
        reasonCode: "EDIT_PREPARE_FAILED",
        refusalClass: "unrepairable",
        errorKind: "unavailable",
        consecutiveCount: 3,
        bound: 3,
        failureCode: "edits-blocked",
        prepareCause: "replacement-read-failed",
        readReason,
      });
    },
  );

  it("still gives an invalid changeset the higher bound of six", () => {
    const streaks = new CodingRuntimeEditRefusalStreaks();
    const outcome = prepareFailed("changeset-invalid");

    expect(observeTimes(streaks, outcome, 5)).toEqual(Array(5).fill(undefined));
    expect(streaks.observe(RUN_ID, outcome)).toMatchObject({
      refusalClass: "repairable",
      failureCode: "edit-retries-exhausted",
      prepareCause: "changeset-invalid",
    });
  });

  it("counts an unrepairable preparation refusal with the other unrepairable refusals", () => {
    const streaks = new CodingRuntimeEditRefusalStreaks();
    streaks.observe(RUN_ID, refused("NO_ACTIVE_SESSION"));
    streaks.observe(RUN_ID, prepareFailed("guard-denied"));

    expect(
      streaks.observe(RUN_ID, prepareFailed("replacement-read-failed", "denied")),
    ).toMatchObject({ failureCode: "edits-blocked", unrepairableCount: 3 });
  });
});

// A cancelled preparation says nothing about the model's edit: the run, not the edit, was stopped.
describe("a cancelled preparation counts for nothing", () => {
  it("is neither a refusal nor the end of the streak", () => {
    const streaks = new CodingRuntimeEditRefusalStreaks();
    observeTimes(streaks, refused("NO_ACTIVE_SESSION"), 2);

    expect(observeTimes(streaks, prepareFailed("cancelled"), 10)).toEqual(
      Array(10).fill(undefined),
    );
    expect(
      observeTimes(streaks, prepareFailed("replacement-read-failed", "cancelled"), 10),
    ).toEqual(Array(10).fill(undefined));
    expect(streaks.escalation(RUN_ID)).toBeUndefined();

    // The two refusals before it still stand: the third settles the run.
    expect(streaks.observe(RUN_ID, refused("NO_ACTIVE_SESSION"))).toMatchObject({
      failureCode: "edits-blocked",
      refusalCount: 3,
    });
  });

  it("never settles a run by itself", () => {
    const streaks = new CodingRuntimeEditRefusalStreaks();

    expect(
      observeTimes(streaks, prepareFailed("cancelled"), REPAIRABLE_EDIT_REFUSAL_BOUND * 3),
    ).toEqual(Array(REPAIRABLE_EDIT_REFUSAL_BOUND * 3).fill(undefined));
    expect(streaks.escalation(RUN_ID)).toBeUndefined();
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

  // The line is the one place a mixed run's two counts, and the closed words that classified its
  // last refusal, are on record.
  it("records both counts of a mixed streak and the latest refusal's closed words", () => {
    const records: ServerLogEvent[] = [];
    const streaks = new CodingRuntimeEditRefusalStreaks();
    streaks.observe(RUN_ID, refused("INVALID_EDITS"));
    streaks.observe(RUN_ID, refused("CONTENT_HASH_MISMATCH"));
    streaks.observe(RUN_ID, prepareFailed("replacement-read-failed", "not-text"));
    streaks.observe(RUN_ID, refused("INVALID_EDITS"));
    streaks.observe(RUN_ID, refused("CONTENT_HASH_MISMATCH"));
    const escalation = streaks.observe(RUN_ID, prepareFailed("changeset-invalid"));
    if (escalation === undefined) throw new Error("expected an escalation");

    recordRefusalEscalated({ write: (event) => void records.push(event) }, RUN_ID, escalation);

    const [line] = records;
    if (line === undefined) throw new Error("expected the escalation line");
    expect(line).toMatchObject({ level: "warn", errorKind: "validation-failed" });
    expect(
      expectActivityLogProof(
        "coding-runtime.run.refusal-escalated.emitted-line",
        formatActivityLogProofLine(line),
      ),
    ).toEqual(
      expect.objectContaining({
        reasonCode: "EDIT_PREPARE_FAILED",
        refusalClass: "repairable",
        consecutiveCount: 6,
        bound: 6,
        failureCode: "edit-retries-exhausted",
        refusalCount: 6,
        unrepairableCount: 1,
        prepareCause: "changeset-invalid",
      }),
    );
  });

  it("records the preparation cause and read reason that made a refusal unrepairable", () => {
    const records: ServerLogEvent[] = [];
    const escalation = observeTimes(
      new CodingRuntimeEditRefusalStreaks(),
      prepareFailed("replacement-read-failed", "denied"),
      3,
    )[2];
    if (escalation === undefined) throw new Error("expected an escalation");

    recordRefusalEscalated({ write: (event) => void records.push(event) }, RUN_ID, escalation);

    const [line] = records;
    if (line === undefined) throw new Error("expected the escalation line");
    expect(line).toMatchObject({ level: "warn", errorKind: "unavailable" });
    const recorded = expectActivityLogProof(
      "coding-runtime.run.refusal-escalated.emitted-line",
      formatActivityLogProofLine(line),
    );
    expect(recorded).toEqual(
      expect.objectContaining({
        reasonCode: "EDIT_PREPARE_FAILED",
        refusalClass: "unrepairable",
        failureCode: "edits-blocked",
        prepareCause: "replacement-read-failed",
        readReason: "denied",
        refusalCount: 3,
        unrepairableCount: 3,
      }),
    );
  });

  it("writes no cause words for a refusal that had none", () => {
    const records: ServerLogEvent[] = [];
    const escalation = observeTimes(
      new CodingRuntimeEditRefusalStreaks(),
      refused("OUT_OF_SCOPE"),
      3,
    )[2];
    if (escalation === undefined) throw new Error("expected an escalation");

    recordRefusalEscalated({ write: (event) => void records.push(event) }, RUN_ID, escalation);

    const [line] = records;
    if (line === undefined) throw new Error("expected the escalation line");
    const recorded = expectActivityLogProof(
      "coding-runtime.run.refusal-escalated.emitted-line",
      formatActivityLogProofLine(line),
    );
    expect(recorded).not.toHaveProperty("prepareCause");
    expect(recorded).not.toHaveProperty("readReason");
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
