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

// The shape productionOpenCodeBackend.acceptance.test.ts writes per case (EvidenceEntry with an
// AcceptanceObservation): closed values, counts, and closed `a:b:c` or `state step` lines.
const OBSERVED = {
  state: "succeeded",
  settledState: "succeeded",
  failureCode: null,
  verificationBlockedReason: "verification-command-denied",
  approvalCount: 2,
  denialCount: 1,
  testerCheckExitCode: 0,
  runCheckCount: 1,
  outsideSourceUnchanged: true,
  editLanded: true,
  confinement: [
    {
      backend: "seatbelt",
      profile: "keiko-native",
      egressDisposition: "loopback-only",
      workspaceAccess: "read-write",
    },
  ],
  verificationSummaries: ["test:failed", "test:passed"],
  continuations: ["completed"],
  buildSettings: [{ launchMode: "native", relayRefusalReasons: ["none"], relayMavenBoundCount: 0 }],
  repositoryRequests: { 200: 3, 401: 1 },
  relayLines: ["request:allowed:-"],
  governedVerifications: ["not-run test:isolation-unavailable"],
  dependencyBootstraps: ["host-shell:installed:-:refused=0"],
  credentialFootprint: {
    scanCount: 4,
    settingsFilesScanned: 2,
    leakedFileCount: 0,
    leakedLogLineCount: 0,
  },
  durationMs: 1234,
};
const REAL_CASE = {
  caseId: "verify-supervised-coding",
  acceptanceCase: { mode: "supervised-coding", variant: "fixed", check: "verify" },
  observed: OBSERVED,
  metExpectation: true,
};
const REAL_SHAPE = { ...CERTIFYING, cases: [REAL_CASE] };

function withObserved(patch) {
  return { ...REAL_SHAPE, cases: [{ ...REAL_CASE, observed: { ...OBSERVED, ...patch } }] };
}

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

  it("counts a sign the evidence no longer records as present (#4519 audit)", () => {
    const { dockerHostConfigured: _dropped, ...shrunk } = NO_RUNTIME;
    expect(acceptanceEvidenceFailures({ ...CERTIFYING, containerRuntime: shrunk })).toEqual([
      "container-runtime-present",
    ]);
    expect(acceptanceEvidenceSummary({ ...CERTIFYING, containerRuntime: {} })[3]).toBe(
      "container runtime signs: dockerOnPath-unrecorded, podmanOnPath-unrecorded, otherClientOnPath-unrecorded, dockerHostConfigured-unrecorded, dockerSocketPresent-unrecorded, runtimeStatePresent-unrecorded, applicationPresent-unrecorded",
    );
  });

  it("does not certify a run whose own verdict is false even when every fact agrees", () => {
    expect(acceptanceEvidenceFailures({ ...CERTIFYING, certifiesPromise: false })).toEqual([
      "not-certified",
    ]);
  });
});

describe("acceptanceEvidenceFailures body-free scan (#4492 AC6)", () => {
  const BODY = "/Users/jane/work/invoice.js";

  it("passes evidence of the producer's real shape", () => {
    expect(acceptanceEvidenceFailures(REAL_SHAPE)).toEqual([]);
  });

  it.each([
    ["a task text in a nested field", { dependencyBootstraps: ["Fix the invoice total please"] }],
    ["an absolute path", { relayLines: ["/Users/jane/project/src/invoice.js"] }],
    ["a home-relative path", { relayLines: ["~/project/src/invoice.js"] }],
    ["a Windows path", { relayLines: ["C:\\Users\\jane\\invoice.js"] }],
    ["a model answer with spaces", { state: "I changed the total to add VAT" }],
    ["a newline", { state: "succeeded\nsecond" }],
    ["an over-long string", { state: "a".repeat(129) }],
    ["a string inside an array", { verificationSummaries: ["test:passed", "see /etc/hosts"] }],
  ])("fails %s, naming the pointer and never the value", (_name, patch) => {
    const failures = acceptanceEvidenceFailures(withObserved(patch));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^body-free:\/cases\/0\/observed\/[A-Za-z]+(\/\d+)?$/u);
    expect(JSON.stringify(failures)).not.toMatch(/invoice|jane|VAT|hosts|second|aaaa|Users/u);
  });

  it("fails a content-named key even when its value is a closed token", () => {
    const failures = acceptanceEvidenceFailures(withObserved({ prompt: "ok", taskPath: "ok" }));
    expect(failures).toEqual([
      "body-free:/cases/0/observed/prompt",
      "body-free:/cases/0/observed/taskPath",
    ]);
  });

  it("names a hostile key by position, never by its text", () => {
    const failures = acceptanceEvidenceFailures(withObserved({ [BODY]: 1 }));
    expect(failures).toHaveLength(1);
    expect(failures[0]).not.toContain("Users");
    expect(failures[0]).toMatch(/^body-free:\/cases\/0\/observed\/<key>$/u);
  });

  it("fails a body inside the top-level facts and unreadable nesting", () => {
    expect(acceptanceEvidenceFailures({ ...REAL_SHAPE, node: "26 /usr/bin/node" })).toEqual([
      "body-free:/node",
    ]);
    expect(acceptanceEvidenceFailures({ ...REAL_SHAPE, extra: [[BODY]] })).toEqual([
      "body-free:/extra/0/0",
    ]);
  });

  it("reports the failure through runCheck without echoing the value", () => {
    const lines = { log: [], error: [] };
    const io = { log: (l) => lines.log.push(l), error: (l) => lines.error.push(l) };
    const root = mkdtempSync(join(tmpdir(), "acceptance-evidence-"));
    try {
      const file = join(root, "evidence.json");
      writeFileSync(file, JSON.stringify(withObserved({ state: BODY })));
      expect(runCheck(["node", "check", file], io)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(lines.error).toEqual([
      "check-acceptance-evidence: FAIL does not certify the promise: body-free:/cases/0/observed/state",
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
