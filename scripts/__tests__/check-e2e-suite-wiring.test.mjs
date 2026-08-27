import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkE2eConfigOwnership,
  checkE2eProtectionBaseline,
  checkE2eSuiteWiring,
  executableWorkflowSegments,
  formatGateReport,
  isWiredInWorkflows,
  main,
  runE2eSuiteWiringGate,
  suiteProtectionClass,
  playwrightConfigNames,
  validateBaselineSuites,
  validateUnownedConfigReasons,
  validateUnownedConfigs,
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

const REQUIRED_AND_SCHEDULED_LANE = {
  name: "required-and-scheduled.yml",
  text: `
on:
  pull_request:
  push:
  schedule:
    - cron: "0 6 * * *"
  workflow_dispatch:
jobs:
  e2e:
    steps:
      - run: npm run test:e2e:required
      - if: github.event_name == 'push' || github.event_name == 'workflow_dispatch'
        run: |
          npm run test:e2e:nonblocking
      - if: github.event_name == 'schedule'
        run: npm run test:e2e:scheduled
`,
};

const REQUIRED_PULL_REQUEST_LANE = {
  name: "required-pull-request.yml",
  text: `
on:
  pull_request:
jobs:
  e2e:
    if: \${{ github.event_name == 'pull_request' && github.base_ref == 'dev' }}
    steps:
      - if: \${{ github.event_name == 'pull_request' }}
        name: Run the required suite
        run: npm run test:e2e:required
`,
};

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

  // KEIKO-0151: a workflow's trigger is insufficient. Every class is attributed to the concrete
  // step that runs the suite, rather than to an unrelated sibling in the same workflow file.
  it("records the strongest event on which each suite step actually runs", () => {
    expect(suiteProtectionClass("test:e2e:required", [REQUIRED_AND_SCHEDULED_LANE])).toBe(
      "runs-per-pr",
    );
    expect(suiteProtectionClass("test:e2e:nonblocking", [REQUIRED_AND_SCHEDULED_LANE])).toBe(
      "push-nonblocking",
    );
    expect(suiteProtectionClass("test:e2e:scheduled", [REQUIRED_AND_SCHEDULED_LANE])).toBe(
      "scheduled-nonblocking",
    );

    const result = checkE2eProtectionBaseline({
      scripts: ["test:e2e:required", "test:e2e:nonblocking", "test:e2e:scheduled"],
      workflows: [REQUIRED_AND_SCHEDULED_LANE],
      protectionBaseline: {
        "test:e2e:required": "runs-per-pr",
        "test:e2e:nonblocking": "runs-per-pr",
        "test:e2e:scheduled": "push-nonblocking",
      },
    });
    expect(result.problems).toEqual([
      "test:e2e:nonblocking protection downgraded from runs-per-pr to push-nonblocking. " +
        "Update its lane or the baseline through an explicit reviewed change.",
      "test:e2e:scheduled protection downgraded from push-nonblocking to scheduled-nonblocking. " +
        "Update its lane or the baseline through an explicit reviewed change.",
    ]);
  });

  // A workflow's PR trigger is insufficient on its own: the exact job and step that run the suite
  // must execute for a dev-targeted pull request. The parser intentionally models only this small,
  // auditable condition language and treats every other expression as non-blocking.
  it("recognizes a direct suite run guarded for the required pull-request context", () => {
    expect(suiteProtectionClass("test:e2e:required", [REQUIRED_PULL_REQUEST_LANE])).toBe(
      "runs-per-pr",
    );
  });

  it.each([
    [
      "a condition separated from run by a comment",
      `
on:
  pull_request:
jobs:
  e2e:
    steps:
      - if: github.event_name == 'push'
        # This comment must not hide the step condition from the classifier.
        run: npm run test:e2e:unsafe
`,
    ],
    [
      "a condition before the step name",
      `
on:
  pull_request:
jobs:
  e2e:
    steps:
      - if: github.event_name == 'push'
        name: Run conditionally
        run: npm run test:e2e:unsafe
`,
    ],
    [
      "a job-level condition",
      `
on:
  pull_request:
jobs:
  e2e:
    if: github.event_name == 'push'
    steps:
      - run: npm run test:e2e:unsafe
`,
    ],
    [
      "a false pull-request/base-ref OR condition",
      `
on:
  pull_request:
jobs:
  e2e:
    steps:
      - if: \${{ github.event_name != 'pull_request' || github.base_ref != 'dev' }}
        run: npm run test:e2e:unsafe
`,
    ],
    [
      "an expression the classifier cannot prove",
      `
on:
  pull_request:
jobs:
  e2e:
    steps:
      - if: inputs.run_e2e
        run: npm run test:e2e:unsafe
`,
    ],
  ])("does not classify %s as required per PR", (_label, text) => {
    expect(suiteProtectionClass("test:e2e:unsafe", [{ name: "unsafe.yml", text }])).toBe("unwired");
  });

  it("attributes a matrix suite to the concrete matrix execution step", () => {
    const matrixOnPullRequest = {
      name: "matrix-on-pr.yml",
      text: `
on:
  pull_request:
jobs:
  e2e:
    strategy:
      matrix:
        suite:
          - test:e2e:matrix-only
    steps:
      - run: npm run \${{ matrix.suite }}
`,
    };
    expect(suiteProtectionClass("test:e2e:matrix-only", [matrixOnPullRequest])).toBe("runs-per-pr");
    expect(isWiredInWorkflows("test:e2e:matrix-only", matrixOnPullRequest.text)).toBe(true);
  });

  it("leaves an untraceable matrix reference unattributed", () => {
    const untraceableMatrix = {
      name: "untraceable-matrix.yml",
      text: `
on:
  schedule:
    - cron: "0 6 * * *"
jobs:
  e2e:
    strategy:
      matrix:
        suite:
          - test:e2e:matrix-only
    steps:
      - run: npm run \${{ matrix.another_value }}
`,
    };

    expect(suiteProtectionClass("test:e2e:matrix-only", [untraceableMatrix])).toBe("unwired");
  });

  it("does not turn an inline comment on the trigger declaration into a PR trigger", () => {
    const dispatchOnly = {
      name: "dispatch-only.yml",
      text: `
on: # pull_request disabled
  workflow_dispatch:
jobs:
  e2e:
    steps:
      - run: npm run test:e2e:demo-suite
`,
    };

    expect(suiteProtectionClass("test:e2e:demo-suite", [dispatchOnly])).toBe("manual-nonblocking");
  });

  it("reads quoted trigger keys but never promotes nested filters into triggers", () => {
    const quotedTrigger = {
      name: "quoted-trigger.yml",
      text: `
"on":
  push:
    branches: [dev]
  workflow_dispatch:
jobs:
  e2e:
    steps:
      - if: github.event_name == 'push'
        run: npm run test:e2e:quoted-trigger
`,
    };

    expect(suiteProtectionClass("test:e2e:quoted-trigger", [quotedTrigger])).toBe(
      "push-nonblocking",
    );
  });

  it("does not classify suite names embedded in a shell string as executable", () => {
    const nightly = readFileSync(".github/workflows/nightly-perf-evidence.yml", "utf8");
    expect(isWiredInWorkflows("test:e2e:workspace-perf", nightly)).toBe(false);
    expect(
      suiteProtectionClass("test:e2e:workspace-perf", [{ name: "nightly.yml", text: nightly }]),
    ).toBe("unwired");
  });

  it("ratchets a formerly required suite down when its direct PR execution is no longer provable", () => {
    const result = checkE2eProtectionBaseline({
      scripts: ["test:e2e:unsafe"],
      workflows: [
        {
          name: "unsafe.yml",
          text: `
on:
  pull_request:
jobs:
  e2e:
    steps:
      - if: github.event_name == 'push'
        name: Run conditionally
        run: npm run test:e2e:unsafe
`,
        },
      ],
      protectionBaseline: { "test:e2e:unsafe": "runs-per-pr" },
    });
    expect(result.problems).toEqual([
      "test:e2e:unsafe protection downgraded from runs-per-pr to unwired. " +
        "Update its lane or the baseline through an explicit reviewed change.",
    ]);
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

// KEIKO-0077: the suite check starts from the scripts, so a fully-built suite whose config never
// received a script is invisible to it — there is no script to find unwired. Four configs were in
// that state. This check runs the other direction: enumerate the configs, require an owning script.
describe("config ownership (KEIKO-0077)", () => {
  const OWNED = "playwright.issue-2253-coding-workbench.config.ts";
  const ORPHAN = "playwright.issue-9999-orphan.config.ts";
  const command = (config) =>
    `playwright test --config tests/e2e/config/${config} --project=chromium`;

  it("fails for a config that no test:e2e:* script names", () => {
    const problems = checkE2eConfigOwnership({
      configs: [OWNED, ORPHAN],
      scriptCommands: [command(OWNED)],
      unownedConfigs: [],
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(ORPHAN);
    expect(problems[0]).toContain("has no test:e2e:* script that runs it");
  });

  it("passes once an owning script is added", () => {
    expect(
      checkE2eConfigOwnership({
        configs: [OWNED, ORPHAN],
        scriptCommands: [command(OWNED), command(ORPHAN)],
        unownedConfigs: [],
      }),
    ).toEqual([]);
  });

  it("passes when the config is recorded in the register instead", () => {
    expect(
      checkE2eConfigOwnership({
        configs: [OWNED, ORPHAN],
        scriptCommands: [command(OWNED)],
        unownedConfigs: [ORPHAN],
      }),
    ).toEqual([]);
  });

  // Same ratchet as the suites register: an entry that has since been given a script, or whose
  // config was deleted, must leave. Without this the register accretes and stops meaning anything.
  it("fails on a stale register entry (config deleted, or script since added)", () => {
    expect(
      checkE2eConfigOwnership({
        configs: [OWNED],
        scriptCommands: [command(OWNED)],
        unownedConfigs: [ORPHAN],
      }),
    ).toEqual([
      `docs/qa/unwired-e2e-suites.json records ${ORPHAN}, which no longer exists. Remove the entry.`,
    ]);

    const [problem] = checkE2eConfigOwnership({
      configs: [ORPHAN],
      scriptCommands: [command(ORPHAN)],
      unownedConfigs: [ORPHAN],
    });
    expect(problem).toContain("but one now runs it");
  });

  // A malformed `"test:e2e:x": null` in package.json reaches here as a non-string command. Skipping
  // it is fail-closed — the config stays unowned — where `.includes` on it would crash the gate.
  it("treats a non-string script command as owning nothing rather than crashing", () => {
    const problems = checkE2eConfigOwnership({
      configs: [OWNED],
      scriptCommands: [null, undefined, 42, command(OWNED)],
      unownedConfigs: [],
    });

    expect(problems).toEqual([]);
    expect(
      checkE2eConfigOwnership({ configs: [OWNED], scriptCommands: [null], unownedConfigs: [] }),
    ).toHaveLength(1);
  });

  // Ownership must mean "this command runs the config", not "this command mentions it". A substring
  // test accepted `echo <name>` — a command that runs nothing — so any config could be waved past
  // the OWNED invariant by naming it.
  it("does not accept a mere mention of the config as ownership", () => {
    expect(playwrightConfigNames(`echo ${ORPHAN}`)).toEqual([]);
    expect(playwrightConfigNames(`# runs ${ORPHAN} one day`)).toEqual([]);
    expect(
      checkE2eConfigOwnership({
        configs: [ORPHAN],
        scriptCommands: [`echo ${ORPHAN}`],
        unownedConfigs: [],
      }),
    ).toHaveLength(1);
  });

  it("reads both --config spellings and an alternate path to the same file", () => {
    expect(playwrightConfigNames(command(ORPHAN))).toEqual([ORPHAN]);
    expect(playwrightConfigNames(`playwright test --config=tests/e2e/config/${ORPHAN}`)).toEqual([
      ORPHAN,
    ]);
    expect(playwrightConfigNames(`playwright test --config ./tests/e2e/config/${ORPHAN}`)).toEqual([
      ORPHAN,
    ]);
  });

  // Splitting on whitespace keeps the quotes, so an unquoted read would leave `.ts"` and match no
  // config — a legitimate command reading as unowned.
  it("reads a quoted --config value in both spellings", () => {
    expect(playwrightConfigNames(`playwright test --config="tests/e2e/config/${ORPHAN}"`)).toEqual([
      ORPHAN,
    ]);
    expect(playwrightConfigNames(`playwright test --config 'tests/e2e/config/${ORPHAN}'`)).toEqual([
      ORPHAN,
    ]);
  });

  // A whitespace split would break the quoted path into two tokens and lose the config entirely.
  it("reads a quoted --config value containing a space", () => {
    const spaced = "playwright.issue with space.config.ts";

    expect(playwrightConfigNames(`playwright test --config="tests/e2e/config/${spaced}"`)).toEqual([
      spaced,
    ]);
    expect(playwrightConfigNames(`playwright test --config "tests/e2e/config/${spaced}"`)).toEqual([
      spaced,
    ]);
  });

  it("does not let a filename prefix satisfy a different config", () => {
    const longer = "playwright.issue-9999-orphan-extended.config.ts";

    expect(
      checkE2eConfigOwnership({
        configs: [ORPHAN],
        scriptCommands: [command(longer)],
        unownedConfigs: [],
      }),
    ).toHaveLength(1);
  });

  // The recorded reason IS the justification for a scriptless config. An unreasoned entry is an
  // unexplained exemption, and a reason outliving its entry is stale evidence — both fail closed.
  it("requires a non-empty reason for every recorded config and rejects stale reasons", () => {
    expect(() => validateUnownedConfigReasons([ORPHAN], {})).toThrow(/no reason/u);
    expect(() => validateUnownedConfigReasons([ORPHAN], { [ORPHAN]: "   " })).toThrow(/no reason/u);
    expect(() => validateUnownedConfigReasons([ORPHAN], { [ORPHAN]: 42 })).toThrow(/no reason/u);
    expect(() => validateUnownedConfigReasons([], { [ORPHAN]: "why" })).toThrow(/stale reason/u);
    expect(() => validateUnownedConfigReasons([], [])).toThrow(/configsWithoutScriptReasons/u);
    expect(validateUnownedConfigReasons([ORPHAN], { [ORPHAN]: "why" })).toEqual({
      [ORPHAN]: "why",
    });
  });

  it("rejects duplicate and non-config register entries", () => {
    expect(() => validateUnownedConfigs([ORPHAN, ORPHAN])).toThrow(/more than once/u);
    expect(() => validateUnownedConfigs(["test:e2e:a"])).toThrow(/file names/u);
    expect(() => validateUnownedConfigs(undefined)).toThrow(/configsWithoutScript/u);
    expect(validateUnownedConfigs([ORPHAN])).toEqual([ORPHAN]);
  });

  // The real repository must satisfy the invariant, not only the fixtures: a gate whose only
  // coverage is synthetic never proves it can read its own inputs.
  it("holds over the real repository", () => {
    expect(runE2eSuiteWiringGate().problems).toEqual([]);
  });
});
