import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  acceptanceEvidenceFailures,
  acceptanceEvidenceSummary,
  runCheck,
} from "../check-acceptance-evidence.mjs";

const NO_RUNTIME = {
  dockerOnPath: false,
  podmanOnPath: false,
  otherClientOnPath: false,
  dockerHostConfigured: false,
  dockerSocketPresent: false,
  runtimeStatePresent: false,
  applicationPresent: false,
};

const CERTIFYING = {
  schemaVersion: 4,
  issue: 4492,
  platform: "darwin",
  arch: "arm64",
  darwinRelease: "24.6.0",
  node: "26.13.1",
  opencode: "2.2.5",
  userClass: "standard",
  containerRuntime: NO_RUNTIME,
  caseSetComplete: true,
  everyCaseMetExpectation: true,
  certifiesPromise: true,
  unmetPreconditions: [],
  cases: [
    { caseId: "verify-supervised-coding", metExpectation: true },
    { caseId: "wrong-fix", metExpectation: true },
  ],
};

describe("acceptanceEvidenceFailures (#4519)", () => {
  it("certifies a standard user without a container runtime whose cases all met", () => {
    expect(acceptanceEvidenceFailures(CERTIFYING)).toEqual([]);
  });

  it("names an administrator and a container runtime, each a failed precondition", () => {
    const admin = {
      ...CERTIFYING,
      userClass: "administrator",
      containerRuntime: { ...NO_RUNTIME, dockerOnPath: true },
      unmetPreconditions: ["administrator", "container-runtime-present"],
      certifiesPromise: false,
    };
    expect(acceptanceEvidenceFailures(admin)).toEqual([
      "administrator",
      "container-runtime-present",
    ]);
  });

  it("recomputes each condition instead of trusting certifiesPromise", () => {
    // A writer that set the flag while a fact disagrees must not certify.
    const planted = {
      ...CERTIFYING,
      containerRuntime: { ...NO_RUNTIME, applicationPresent: true },
    };
    expect(acceptanceEvidenceFailures(planted)).toEqual(["container-runtime-present"]);
    const missed = { ...CERTIFYING, cases: [{ caseId: "wrong-fix", metExpectation: false }] };
    expect(acceptanceEvidenceFailures(missed)).toEqual(["case-not-met"]);
    expect(acceptanceEvidenceFailures({ ...CERTIFYING, caseSetComplete: false })).toEqual([
      "case-set-incomplete",
    ]);
  });

  it("refuses evidence without its facts, another platform or another schema", () => {
    expect(acceptanceEvidenceFailures(null)).toEqual(["evidence-unreadable"]);
    const bare = { schemaVersion: 4, platform: "darwin", userClass: "standard" };
    expect(acceptanceEvidenceFailures(bare)).toEqual([
      "container-runtime-present",
      "unrecorded",
      "case-set-incomplete",
      "case-not-met",
    ]);
    expect(acceptanceEvidenceFailures({ ...CERTIFYING, platform: "win32" })).toEqual(["platform"]);
    expect(acceptanceEvidenceFailures({ ...CERTIFYING, schemaVersion: 3 })).toEqual([
      "schema-version",
    ]);
  });

  it("does not certify a run whose own verdict is false even when every fact agrees", () => {
    expect(acceptanceEvidenceFailures({ ...CERTIFYING, certifiesPromise: false })).toEqual([
      "not-certified",
    ]);
  });
});

describe("acceptanceEvidenceSummary", () => {
  it("prints closed values and counts only", () => {
    expect(acceptanceEvidenceSummary(CERTIFYING)).toEqual([
      "platform darwin 24.6.0 arm64",
      "node 26.13.1, opencode 2.2.5",
      "user class standard",
      "container runtime signs: none",
      "cases: 2 of 2 met, set complete true",
      "certifies the promise: true",
    ]);
    const signs = acceptanceEvidenceSummary({
      ...CERTIFYING,
      containerRuntime: { ...NO_RUNTIME, dockerOnPath: true, dockerSocketPresent: true },
    });
    expect(signs[3]).toBe("container runtime signs: dockerOnPath, dockerSocketPresent");
  });
});

describe("runCheck", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function evidenceFile(content) {
    const root = mkdtempSync(join(tmpdir(), "acceptance-evidence-"));
    roots.push(root);
    const file = join(root, "evidence.json");
    writeFileSync(file, content);
    return file;
  }

  function capture() {
    const lines = { log: [], error: [] };
    return {
      lines,
      io: { log: (line) => lines.log.push(line), error: (line) => lines.error.push(line) },
    };
  }

  it("passes and prints the facts for certifying evidence", () => {
    const { lines, io } = capture();
    expect(runCheck(["node", "check", evidenceFile(JSON.stringify(CERTIFYING))], io)).toBe(0);
    expect(lines.log.at(-1)).toBe(
      "check-acceptance-evidence: PASS a standard user without a container runtime, every case as expected",
    );
    expect(lines.log).toContain("check-acceptance-evidence: user class standard");
  });

  it("fails naming the precondition for an administrator's evidence", () => {
    const { lines, io } = capture();
    const admin = {
      ...CERTIFYING,
      userClass: "administrator",
      unmetPreconditions: ["administrator"],
      certifiesPromise: false,
    };
    expect(runCheck(["node", "check", evidenceFile(JSON.stringify(admin))], io)).toBe(1);
    expect(lines.error).toEqual([
      "check-acceptance-evidence: FAIL does not certify the promise: administrator",
    ]);
  });

  it("fails on unreadable evidence and without an argument", () => {
    const { lines, io } = capture();
    expect(runCheck(["node", "check", evidenceFile("{not json")], io)).toBe(1);
    expect(runCheck(["node", "check"], io)).toBe(2);
    expect(lines.error[0]).toMatch(
      /^check-acceptance-evidence: FAIL the evidence could not be read/u,
    );
    expect(lines.error[1]).toMatch(/^check-acceptance-evidence: FAIL usage:/u);
  });
});
