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
  schemaVersion: 5,
  issue: 4492,
  platform: "darwin",
  arch: "arm64",
  osRelease: "24.6.0",
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
    const bare = { schemaVersion: 5, platform: "darwin", userClass: "standard" };
    expect(acceptanceEvidenceFailures(bare)).toEqual([
      "container-runtime-present",
      "unrecorded",
      "case-set-incomplete",
      "case-not-met",
    ]);
    expect(acceptanceEvidenceFailures({ ...CERTIFYING, platform: "linux" })).toEqual(["platform"]);
    expect(acceptanceEvidenceFailures({ ...CERTIFYING, schemaVersion: 4 })).toEqual([
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

  // Built at run time so no credential-shaped literal sits in the repository.
  const FILLER = "a1B2c3D4e5".repeat(4);
  it.each([
    ["an issuer-prefixed token", `${"gh"}p_${FILLER}`],
    ["a provider key", `${"sk"}-proj-${FILLER}`],
    ["a JWT", `${"ey"}JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.${FILLER}`],
  ])("fails %s although it is one closed token, never naming it", (_name, value) => {
    const failures = acceptanceEvidenceFailures(withObserved({ state: value }));
    expect(failures).toEqual(["body-free:/cases/0/observed/state"]);
    expect(JSON.stringify(failures)).not.toContain(FILLER);
  });

  it("names a credential-shaped key by position, even when its value is a closed token", () => {
    const failures = acceptanceEvidenceFailures(withObserved({ [`${"sk"}-proj-${FILLER}`]: "ok" }));
    expect(failures).toEqual(["body-free:/cases/0/observed/<key>"]);
  });

  it("prints a credential-shaped key on neither stream of runCheck", () => {
    const key = `${"sk"}-proj-${FILLER}`;
    const lines = { log: [], error: [] };
    const io = { log: (l) => lines.log.push(l), error: (l) => lines.error.push(l) };
    const evidence = {
      ...withObserved({ [key]: BODY }),
      containerRuntime: { ...NO_RUNTIME, [key]: true },
    };
    const root = mkdtempSync(join(tmpdir(), "acceptance-evidence-"));
    try {
      const file = join(root, "evidence.json");
      writeFileSync(file, JSON.stringify(evidence));
      expect(runCheck(["node", "check", file], io)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const printed = [...lines.log, ...lines.error].join("\n");
    expect(printed).not.toContain(FILLER);
    expect(printed).not.toContain("jane");
    expect(lines.log).toContain("check-acceptance-evidence: container runtime signs: <sign>");
    expect(lines.error[0]).toContain("body-free:/containerRuntime/<key>");
    expect(lines.error[0]).toContain("body-free:/cases/0/observed/<key>");
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

// The shape the Windows run writes (windowsAcceptancePreconditions.ts, #4492 AC3).
const WINDOWS_NO_RUNTIME = {
  dockerOnPath: false,
  podmanOnPath: false,
  otherClientOnPath: false,
  dockerHostConfigured: false,
  dockerServiceInstalled: false,
  runtimePipePresent: false,
  applicationPresent: false,
};
const WINDOWS_CERTIFYING = {
  ...CERTIFYING,
  platform: "win32",
  osRelease: "10.0.26100",
  containerRuntime: WINDOWS_NO_RUNTIME,
  services: { keikoGatewayServiceInstalled: false, keikoServiceCount: 0 },
};

describe("acceptanceEvidenceFailures on Windows (#4492 AC3)", () => {
  it("certifies a standard user without a container runtime or a Keiko service", () => {
    expect(acceptanceEvidenceFailures(WINDOWS_CERTIFYING)).toEqual([]);
  });

  it("names an administrator alone", () => {
    const evidence = { ...WINDOWS_CERTIFYING, userClass: "administrator" };
    expect(acceptanceEvidenceFailures(evidence)).toEqual(["administrator"]);
  });

  it("names a reachable container runtime alone", () => {
    const evidence = {
      ...WINDOWS_CERTIFYING,
      containerRuntime: { ...WINDOWS_NO_RUNTIME, runtimePipePresent: true },
    };
    expect(acceptanceEvidenceFailures(evidence)).toEqual(["container-runtime-present"]);
  });

  it.each([
    ["the gateway service", { keikoGatewayServiceInstalled: true, keikoServiceCount: 1 }],
    ["a Keiko-prefixed service", { keikoGatewayServiceInstalled: false, keikoServiceCount: 2 }],
  ])("names %s alone", (_name, services) => {
    expect(acceptanceEvidenceFailures({ ...WINDOWS_CERTIFYING, services })).toEqual([
      "service-installed",
    ]);
  });

  it("names every failed precondition, not only the first", () => {
    const evidence = {
      ...WINDOWS_CERTIFYING,
      userClass: "administrator",
      containerRuntime: { ...WINDOWS_NO_RUNTIME, dockerOnPath: true },
      services: { keikoGatewayServiceInstalled: true, keikoServiceCount: 1 },
      unmetPreconditions: ["administrator", "container-runtime-present", "service-installed"],
      certifiesPromise: false,
    };
    expect(acceptanceEvidenceFailures(evidence)).toEqual([
      "administrator",
      "container-runtime-present",
      "service-installed",
    ]);
  });

  it("refuses a probe that could not run, as its own code", () => {
    const evidence = {
      ...WINDOWS_CERTIFYING,
      userClass: "unknown",
      containerRuntime: {},
      services: undefined,
      unmetPreconditions: [
        "administrator-probe-failed",
        "container-runtime-probe-failed",
        "service-probe-failed",
      ],
      certifiesPromise: false,
    };
    const failures = acceptanceEvidenceFailures(evidence);
    expect(failures).toEqual(
      expect.arrayContaining([
        "administrator-probe-failed",
        "container-runtime-probe-failed",
        "service-probe-failed",
        "service-installed",
      ]),
    );
    expect(failures).not.toContain("administrator");
  });

  it("refuses Windows evidence that does not record the services at all", () => {
    const { services: _dropped, ...bare } = WINDOWS_CERTIFYING;
    expect(acceptanceEvidenceFailures(bare)).toEqual(["service-installed"]);
  });

  it("counts a Windows sign the evidence no longer records as present", () => {
    const { runtimePipePresent: _dropped, ...shrunk } = WINDOWS_NO_RUNTIME;
    expect(acceptanceEvidenceFailures({ ...WINDOWS_CERTIFYING, containerRuntime: shrunk })).toEqual(
      ["container-runtime-present"],
    );
  });

  it("does not certify macOS-shaped signs on Windows", () => {
    expect(
      acceptanceEvidenceFailures({ ...WINDOWS_CERTIFYING, containerRuntime: NO_RUNTIME }),
    ).toEqual(["container-runtime-present"]);
  });

  it("prints the Windows facts and the PASS line, naming the service check", () => {
    const lines = { log: [], error: [] };
    const directory = mkdtempSync(join(tmpdir(), "win-evidence-"));
    const file = join(directory, "evidence.json");
    writeFileSync(file, JSON.stringify(WINDOWS_CERTIFYING));
    try {
      expect(
        runCheck(["node", "check", file], {
          log: (line) => lines.log.push(line),
          error: (line) => lines.error.push(line),
        }),
      ).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(lines.log).toContain("check-acceptance-evidence: platform win32 10.0.26100 arm64");
    expect(lines.log).toContain("check-acceptance-evidence: keiko service signs: none");
    expect(lines.log.at(-1)).toContain("or Keiko service");
  });
});

describe("--preconditions-only (#4492 AC3)", () => {
  const MACHINE_ONLY = {
    ...WINDOWS_CERTIFYING,
    caseSetComplete: false,
    everyCaseMetExpectation: false,
    certifiesPromise: false,
    cases: [],
  };

  function check(evidence, flag) {
    const lines = { log: [], error: [] };
    const directory = mkdtempSync(join(tmpdir(), "pre-evidence-"));
    const file = join(directory, "evidence.json");
    writeFileSync(file, JSON.stringify(evidence));
    try {
      const code = runCheck(["node", "check", file, ...(flag ? ["--preconditions-only"] : [])], {
        log: (line) => lines.log.push(line),
        error: (line) => lines.error.push(line),
      });
      return { code, ...lines };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("passes a machine whose preconditions are met, and says no result is certified", () => {
    const result = check(MACHINE_ONLY, true);
    expect(result.code).toBe(0);
    expect(result.log.at(-1)).toContain("no case was run, so no result is certified");
  });

  it("refuses the same machine without the flag, for its missing cases", () => {
    const result = check(MACHINE_ONLY, false);
    expect(result.code).toBe(1);
    expect(result.error[0]).toContain("case-set-incomplete, case-not-met");
  });

  it("still refuses an unmet precondition and a body-free violation", () => {
    const evidence = { ...MACHINE_ONLY, userClass: "administrator", taskText: "x" };
    const result = check(evidence, true);
    expect(result.code).toBe(1);
    expect(result.error[0]).toContain("administrator");
    expect(result.error[0]).toContain("body-free:/taskText");
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
  const BODY_PLATFORM = "darwin on /Users/jane";
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

  it("never prints a recorded precondition or fact that is not a closed value", () => {
    const { lines, io } = capture();
    const hostile = {
      ...CERTIFYING,
      platform: BODY_PLATFORM,
      node: "26 /Users/jane/node",
      unmetPreconditions: ["administrator", "private /Users/jane/project"],
      certifiesPromise: false,
    };
    expect(runCheck(["node", "check", evidenceFile(JSON.stringify(hostile))], io)).toBe(1);
    const printed = [...lines.log, ...lines.error].join("\n");
    expect(printed).not.toMatch(/jane|Users|project/u);
    expect(lines.log).toContain("check-acceptance-evidence: platform <not-closed> 24.6.0 arm64");
    expect(lines.error).toEqual([
      "check-acceptance-evidence: FAIL does not certify the promise: platform, administrator, " +
        "precondition-unrecognized, body-free:/platform, body-free:/node, " +
        "body-free:/unmetPreconditions/1",
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
