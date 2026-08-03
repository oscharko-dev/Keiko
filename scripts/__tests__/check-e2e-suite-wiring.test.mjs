import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkE2eSuiteWiring,
  executableWorkflowSegments,
  formatGateReport,
  isWiredInWorkflows,
  main,
  runE2eSuiteWiringGate,
  validateBaselineSuites,
} from "../check-e2e-suite-wiring.mjs";

// Each caller owns its directory for the length of one test, so nothing is shared and no ordering
// between tests can matter.
function withFixtureRoot(build, assert) {
  const root = mkdtempSync(join(tmpdir(), "keiko-e2e-wiring-"));
  try {
    build(root);
    assert(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const RUN_LANE = `
jobs:
  e2e:
    steps:
      - run: npm run test:e2e:wired
`;

// The shape e2e-extended.yml uses: the script name alone in a matrix, invoked indirectly.
const MATRIX_LANE = `
jobs:
  e2e:
    strategy:
      matrix:
        suite:
          - test:e2e:matrix-wired
    steps:
      - run: npm run \${{ matrix.suite }}
`;

function problemsFor(scripts, workflowText, baseline = []) {
  return checkE2eSuiteWiring({ scripts, workflowText, baseline });
}

describe("e2e suite wiring gate (#2629)", () => {
  // The gate's whole reason to exist. An unwired suite reads as coverage while running nowhere, so
  // the one thing it must never do is pass over one.
  it("detects a suite that exists in package.json and runs in no workflow", () => {
    const problems = problemsFor(["build", "test:e2e:wired", "test:e2e:orphan"], RUN_LANE);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("test:e2e:orphan");
    expect(problems[0]).toContain("no workflow runs it");
  });

  it("accepts a suite invoked directly and one named only in a matrix", () => {
    const both = `${RUN_LANE}\n${MATRIX_LANE}`;
    expect(problemsFor(["test:e2e:wired", "test:e2e:matrix-wired"], both)).toEqual([]);
  });

  it("ignores non-e2e scripts entirely", () => {
    expect(problemsFor(["build", "lint", "test:coverage:ui"], "")).toEqual([]);
  });

  // A prefix match would let one lane vouch for a suite it never runs.
  it("does not let a longer suite name satisfy a shorter one", () => {
    const lane = "      - run: npm run test:e2e:wired-extended\n";
    const problems = problemsFor(["test:e2e:wired"], lane);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("test:e2e:wired");
  });

  // Only a `run:` command or a bare matrix entry executes anything. Everything else is prose, and
  // a gate that reads prose as execution can be silenced by an unrelated mention — which is the
  // failure this gate exists to prevent, arriving through the gate itself.
  it.each([
    [
      "a full-line comment",
      "        # test:e2e:orphan is not wired yet\n        - run: npm run x\n",
    ],
    ["a trailing comment on another command", "      - run: npm run build # test:e2e:orphan\n"],
    ["a step name", "      - name: test:e2e:orphan\n        run: npm run build\n"],
    ["an unrelated key", "      env:\n        SUITE_DOC: test:e2e:orphan\n"],
  ])("does not treat %s as wiring", (_label, lane) => {
    expect(isWiredInWorkflows("test:e2e:orphan", lane)).toBe(false);
    expect(problemsFor(["test:e2e:orphan"], lane)).toHaveLength(1);
  });

  it("reads a suite invoked inside a run block scalar", () => {
    const lane = [
      "      - name: Run it",
      "        run: |",
      "          npm ci",
      "          npm run test:e2e:blocked",
      "      - name: Next step",
      "        run: npm run build",
    ].join("\n");
    expect(isWiredInWorkflows("test:e2e:blocked", lane)).toBe(true);
    // The block ends at the next step: a suite named there must not inherit the block's status.
    expect(executableWorkflowSegments(lane).some((s) => s.includes("Next step"))).toBe(false);
  });

  it("accepts a recorded suite and names the baseline in the failure it prints", () => {
    expect(problemsFor(["test:e2e:orphan"], "", ["test:e2e:orphan"])).toEqual([]);
    expect(problemsFor(["test:e2e:orphan"], "")[0]).toContain("docs/qa/unwired-e2e-suites.json");
  });

  // The ratchet: the baseline is a debt register, so it may only shrink. Both ways an entry can go
  // stale have to fail, or a wired-then-recorded suite would sit there forever.
  it("rejects a baseline entry that is now wired, and one that no longer exists", () => {
    const wiredButRecorded = problemsFor(["test:e2e:wired"], RUN_LANE, ["test:e2e:wired"]);
    expect(wiredButRecorded).toHaveLength(1);
    expect(wiredButRecorded[0]).toContain("the baseline only shrinks");

    const deletedButRecorded = problemsFor([], "", ["test:e2e:gone"]);
    expect(deletedButRecorded).toHaveLength(1);
    expect(deletedButRecorded[0]).toContain("no longer exists");
  });

  // Live wiring, through the gate's own readers rather than a re-implementation of them. This is
  // what turns the register into a ratchet on the actual repository instead of only on fixtures,
  // and it is the only thing that proves the gate can load its real inputs at all.
  it("holds over the real package.json, workflows, and baseline", () => {
    const result = runE2eSuiteWiringGate();
    expect(result.problems).toEqual([]);
    expect(result.total).toBeGreaterThan(result.recorded);
    expect(formatGateReport(result)).toContain("e2e-suite-wiring: PASS");

    const workflowText = readdirSync(".github/workflows")
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .map((name) => readFileSync(`.github/workflows/${name}`, "utf8"))
      .join("\n");
    const baseline = JSON.parse(readFileSync("docs/qa/unwired-e2e-suites.json", "utf8"));
    // The M11 journeys #2629 was filed over: seven per-child suites that ran in no lane at all.
    for (const suite of ["test:e2e:workspace-trust-2523", "test:e2e:file-history-2531"]) {
      expect(isWiredInWorkflows(suite, workflowText), suite).toBe(true);
      expect(baseline.suites, suite).not.toContain(suite);
    }
    expect(isWiredInWorkflows("test:e2e:merge-governance-478", workflowText)).toBe(true);
  });

  it("reports failures with every problem listed under a FAIL headline", () => {
    const report = formatGateReport({
      problems: ["test:e2e:orphan runs nowhere"],
      total: 3,
      recorded: 0,
    });
    expect(report).toContain("e2e-suite-wiring: FAIL — 1 problem(s)");
    expect(report).toContain("  - test:e2e:orphan runs nowhere");
  });

  it("rejects a baseline document that is not a suites array", () => {
    // Fail loudly on a malformed register rather than treating it as "nothing recorded", which
    // would silently re-admit every suite it was holding.
    withFixtureRoot(
      (root) => {
        mkdirSync(join(root, "docs", "qa"), { recursive: true });
        writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {} }), "utf8");
        writeFileSync(
          join(root, "docs", "qa", "unwired-e2e-suites.json"),
          JSON.stringify({ suites: "not-an-array" }),
          "utf8",
        );
      },
      (root) => {
        expect(() => runE2eSuiteWiringGate(root)).toThrow(/must carry a "suites" array/u);
      },
    );
  });

  // A duplicate passes a naive read and then inflates `recorded`, so the PASS line under-reports
  // wired suites — and with enough duplicates goes negative. An entry that is not a suite name
  // records debt against nothing.
  it("rejects duplicate and non-suite baseline entries", () => {
    expect(() => validateBaselineSuites(["test:e2e:a", "test:e2e:a"])).toThrow(/more than once/u);
    expect(() => validateBaselineSuites(["lint"])).toThrow(/script names/u);
    expect(() => validateBaselineSuites([42])).toThrow(/script names/u);
    expect(validateBaselineSuites(["test:e2e:a", "test:e2e:b"])).toEqual([
      "test:e2e:a",
      "test:e2e:b",
    ]);
  });

  it("runs end to end and reports success without writing to the real stdout", () => {
    const written = [];
    expect(main((text) => written.push(text))).toBe(0);
    expect(written.join("")).toContain("e2e-suite-wiring: PASS");
  });
});
