import { describe, expect, it } from "vitest";
import type { VerificationReport } from "@oscharko-dev/keiko-contracts";
import {
  appendVerificationCheck,
  EMPTY_VERIFICATION_CHECK_HISTORY,
  parseVerificationCheckHistory,
  VERIFICATION_CHECK_HISTORY_MAX,
  verificationCheckHistoryFromEvidence,
  verificationCheckRecord,
  type VerificationCheckRecord,
} from "./verificationChecks.js";

const TREE = "a".repeat(64);

function report(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return {
    workspaceRoot: "/private/workspace/root",
    overallStatus: "passed",
    startedAtMs: 1_000,
    durationMs: 900,
    counts: {
      passed: 1,
      failed: 0,
      skipped: 0,
      denied: 0,
      cancelled: 0,
      "resource-exceeded": 0,
      "timed-out": 0,
    },
    results: [
      {
        kind: "build",
        scriptName: "build",
        command: "npm",
        args: ["run", "build", "--secret-flag"],
        status: "passed",
        exitCode: 0,
        signal: null,
        durationMs: 867,
        truncated: false,
        redacted: true,
        outputSummary: "vite build output under /private/workspace/root",
        appliedLimits: [],
        detail: "private step detail",
      },
    ],
    dependencies: {
      state: "installed",
      lockfile: "created",
      exitCode: 0,
      durationMs: 6_100,
      detail: "project npm config present",
      egress: { allowed: 15, refused: 0 },
    },
    ...overrides,
  };
}

describe("verification check records (F57)", () => {
  it("keeps closed vocabulary and numbers only, never commands, output, paths or details", () => {
    const record = verificationCheckRecord(report(), TREE);
    expect(record).toEqual({
      startedAtMs: 1_000,
      stagedTreeDigest: TREE,
      install: {
        state: "installed",
        lockfile: "created",
        exitCode: 0,
        durationMs: 6_100,
        egressAllowed: 15,
        egressRefused: 0,
      },
      steps: [{ kind: "build", status: "passed", exitCode: 0, durationMs: 867 }],
    });
    const encoded = JSON.stringify(record);
    for (const forbidden of [
      "npm",
      "--secret-flag",
      "/private",
      "vite build output",
      "private step detail",
      "project npm config",
    ])
      expect(encoded).not.toContain(forbidden);
  });
  it("leaves the tree out for unstaged work and the counts out for an install without egress", () => {
    const record = verificationCheckRecord(
      report({
        dependencies: { state: "current", lockfile: "present", exitCode: null, durationMs: 0 },
      }),
    );
    expect(record).not.toHaveProperty("stagedTreeDigest");
    expect(record.install).toEqual({
      state: "current",
      lockfile: "present",
      exitCode: null,
      durationMs: 0,
    });
  });
  it("records no install for a report that ran none", () => {
    expect(verificationCheckRecord(report({ dependencies: undefined }))).not.toHaveProperty(
      "install",
    );
  });
  it("keeps the newest records up to the bound and counts the dropped ones", () => {
    let history = EMPTY_VERIFICATION_CHECK_HISTORY;
    for (let index = 0; index < VERIFICATION_CHECK_HISTORY_MAX + 3; index += 1)
      history = appendVerificationCheck(
        history,
        verificationCheckRecord(report({ startedAtMs: index })),
      );
    expect(history.records).toHaveLength(VERIFICATION_CHECK_HISTORY_MAX);
    expect(history.omitted).toBe(3);
    expect(history.records[0]?.startedAtMs).toBe(3);
    expect(history.records.at(-1)?.startedAtMs).toBe(VERIFICATION_CHECK_HISTORY_MAX + 2);
    expect(EMPTY_VERIFICATION_CHECK_HISTORY).toEqual({ records: [], omitted: 0 });
  });
});

describe("reading a history back from evidence (F57)", () => {
  const record: VerificationCheckRecord = verificationCheckRecord(report(), TREE);
  const step = record.steps[0];
  const install = record.install;
  const valid = { records: [record], omitted: 2 };
  it("round-trips a history through the evidence record's JSON", () => {
    expect(
      verificationCheckHistoryFromEvidence(JSON.stringify({ schemaVersion: "1", checks: valid })),
    ).toEqual(valid);
  });
  it.each([
    ["unparseable JSON", "{"],
    ["evidence recorded before the history existed", JSON.stringify({ commands: [] })],
    ["an evidence record that is not an object", JSON.stringify([valid])],
  ])("refuses %s", (_label, json) => {
    expect(verificationCheckHistoryFromEvidence(json)).toBeUndefined();
  });
  it.each([
    [
      "an unknown step kind",
      { ...valid, records: [{ ...record, steps: [{ ...step, kind: "deploy" }] }] },
    ],
    [
      "an unknown step status",
      { ...valid, records: [{ ...record, steps: [{ ...step, status: "ok" }] }] },
    ],
    [
      "a fractional exit code",
      { ...valid, records: [{ ...record, steps: [{ ...step, exitCode: 0.5 }] }] },
    ],
    [
      "a negative duration",
      { ...valid, records: [{ ...record, steps: [{ ...step, durationMs: -1 }] }] },
    ],
    [
      "a malformed staged tree digest",
      { ...valid, records: [{ ...record, stagedTreeDigest: "tree" }] },
    ],
    ["a start that is not a time", { ...valid, records: [{ ...record, startedAtMs: "now" }] }],
    [
      "an unknown install state",
      { ...valid, records: [{ ...record, install: { ...install, state: "done" } }] },
    ],
    [
      "an unknown lockfile state",
      { ...valid, records: [{ ...record, install: { ...install, lockfile: "maybe" } }] },
    ],
    [
      "half an egress pair",
      { ...valid, records: [{ ...record, install: { ...install, egressRefused: undefined } }] },
    ],
    [
      "an install that is not an object",
      { ...valid, records: [{ ...record, install: "installed" }] },
    ],
    ["steps that are not a list", { ...valid, records: [{ ...record, steps: {} }] }],
    ["a step that is not an object", { ...valid, records: [{ ...record, steps: ["build"] }] }],
    ["a record that is not an object", { ...valid, records: ["build passed"] }],
    ["a negative omitted count", { ...valid, omitted: -1 }],
    ["records that are not a list", { ...valid, records: {} }],
    [
      "more records than the bound",
      {
        records: Array.from({ length: VERIFICATION_CHECK_HISTORY_MAX + 1 }, () => record),
        omitted: 0,
      },
    ],
  ])("refuses a history with %s", (_label, checks) => {
    expect(parseVerificationCheckHistory(JSON.parse(JSON.stringify(checks)))).toBeUndefined();
  });
  it("refuses a history that is not an object", () => {
    expect(parseVerificationCheckHistory(null)).toBeUndefined();
  });
});
