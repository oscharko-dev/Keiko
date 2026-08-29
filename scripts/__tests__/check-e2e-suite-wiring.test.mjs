import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  apiPathReferences,
  blankComments,
  checkE2eConfigOwnership,
  checkE2eProtectionBaseline,
  checkE2eRouteResolution,
  checkE2eSpecReachability,
  commandSpecNames,
  checkE2eSuiteWiring,
  declaredSpecTags,
  executableWorkflowSegments,
  formatGateReport,
  isWiredInWorkflows,
  main,
  mountedRoutePatterns,
  parseConfigSelection,
  reachableSpecs,
  routeResolves,
  runE2eSuiteWiringGate,
  suiteProtectionClass,
  playwrightConfigNames,
  validateBaselineSuites,
  validateExternalApiPathReasons,
  validateExternalApiPaths,
  validateUnreachableSpecReasons,
  validateUnreachableSpecs,
  validateUnownedConfigReasons,
  validateUnownedConfigs,
} from "../check-e2e-suite-wiring.mjs";

// Each caller owns its directory for the length of one test, so nothing is shared and no ordering
// between tests can matter.
async function withFixtureRoot(build, assert) {
  const root = mkdtempSync(join(tmpdir(), "keiko-e2e-wiring-"));
  try {
    build(root);
    await assert(root);
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

// The gate imports the BUILT server package to read the real route table. That module graph is
// large, and vitest re-transforms it whenever a `build:packages` run has touched it, which is long
// enough to blow a per-test timeout. Every real-repository assertion in this file therefore shares
// one evaluation instead of paying for its own.
let realRepositoryGate;

beforeAll(async () => {
  realRepositoryGate = await runE2eSuiteWiringGate();
}, 180_000);

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
    const result = realRepositoryGate;
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
      "test:e2e:nonblocking protection changed from runs-per-pr to push-nonblocking. " +
        "Update its lane or the baseline through an explicit reviewed change.",
      "test:e2e:scheduled protection changed from push-nonblocking to scheduled-nonblocking. " +
        "Update its lane or the baseline through an explicit reviewed change.",
    ]);
  });

  // KEIKO-0151: suiteProtection is an audited snapshot of the concrete execution surface, not a
  // lower-bound. A stronger class changes CI cost and merge semantics, so it needs the same
  // explicit, reviewed baseline update as a downgrade.
  it("rejects a silent protection upgrade", () => {
    const result = checkE2eProtectionBaseline({
      scripts: ["test:e2e:baseline-ratchet"],
      workflows: [
        {
          name: "push.yml",
          text: `
on:
  push:
jobs:
  e2e:
    steps:
      - run: npm run test:e2e:baseline-ratchet
`,
        },
      ],
      protectionBaseline: { "test:e2e:baseline-ratchet": "manual-nonblocking" },
    });
    expect(result.problems).toEqual([
      "test:e2e:baseline-ratchet protection changed from manual-nonblocking to push-nonblocking. " +
        "Update its lane or the baseline through an explicit reviewed change.",
    ]);
  });

  it.each([
    [
      "step-level continue-on-error",
      `
on:
  pull_request:
jobs:
  e2e:
    steps:
      - continue-on-error: true
        run: npm run test:e2e:best-effort
`,
    ],
    [
      "job-level continue-on-error",
      `
on:
  pull_request:
jobs:
  e2e:
    continue-on-error: true
    steps:
      - run: npm run test:e2e:best-effort
`,
    ],
  ])("classifies %s as a non-blocking pull-request execution", (_label, text) => {
    const workflows = [{ name: "best-effort.yml", text }];
    expect(suiteProtectionClass("test:e2e:best-effort", workflows)).toBe(
      "pull-request-nonblocking",
    );
    expect(
      checkE2eProtectionBaseline({
        scripts: ["test:e2e:best-effort"],
        workflows,
        protectionBaseline: { "test:e2e:best-effort": "runs-per-pr" },
      }).problems,
    ).toEqual([
      "test:e2e:best-effort protection changed from runs-per-pr to pull-request-nonblocking. " +
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
      "test:e2e:unsafe protection changed from runs-per-pr to unwired. " +
        "Update its lane or the baseline through an explicit reviewed change.",
    ]);
  });

  it("rejects a baseline document that is not a suites array", async () => {
    // Fail loudly on a malformed register rather than treating it as "nothing recorded", which
    // would silently re-admit every suite it was holding.
    await withFixtureRoot(
      (root) => {
        mkdirSync(join(root, "docs", "qa"), { recursive: true });
        writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {} }), "utf8");
        writeFileSync(
          join(root, "docs", "qa", "unwired-e2e-suites.json"),
          JSON.stringify({ suites: "not-an-array" }),
          "utf8",
        );
      },
      async (root) => {
        // The gate is async since #2955 (it imports the built server route table), so a malformed
        // register surfaces as a rejection rather than a synchronous throw. Same invariant.
        await expect(runE2eSuiteWiringGate(root)).rejects.toThrow(/must carry a "suites" array/u);
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

  it("runs end to end and reports success without writing to the real stdout", async () => {
    const written = [];
    expect(await main((text) => written.push(text))).toBe(0);
    expect(written.join("")).toContain("e2e-suite-wiring: PASS");
  }, 180_000);
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

  // A mention is not the only way to name a config a command never runs: an option in an UNRELATED
  // shell segment is read by Playwright not at all. Left unsegmented, `--config` and `--grep` were
  // scanned across the whole line while the spec-operand reader already was not — so the three
  // readers disagreed about what the invocation received, and the widest one decided reachability.
  it("ignores options that belong to a different command in the same line", () => {
    expect(
      playwrightConfigNames(`echo --config tests/e2e/config/${ORPHAN} && playwright test`),
    ).toEqual([]);
    expect(commandSpecNames(`echo tests/e2e/never.spec.ts && playwright test`)).toEqual([]);
    expect(
      checkE2eConfigOwnership({
        configs: [ORPHAN],
        scriptCommands: [`echo --config tests/e2e/config/${ORPHAN} && playwright test`],
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
    expect(realRepositoryGate.problems).toEqual([]);
  });
});

// Audits KEIKO-0078 / KEIKO-0080 (#2955). Invariants 1-3 all start from an artifact that already
// declares itself runnable. A spec file declares nothing, so nothing enumerated tests/e2e — the
// dimension in which eleven specs were reachable from no script at all.
describe("spec reachability (KEIKO-0078 / KEIKO-0080)", () => {
  const CONFIGURED = "configured.spec.ts";
  const TAGGED = "tagged.spec.ts";
  const NAMED = "named.spec.ts";
  const ORPHAN = "orphan.spec.ts";
  const SPECS = [CONFIGURED, TAGGED, NAMED, ORPHAN];

  // The shared config's catch-all glob, and one config that names a spec literally.
  const SELECTIONS = new Map([
    [
      "playwright.config.ts",
      parseConfigSelection('testMatch: "**/*.spec.ts",\ntestIgnore: "code-task-*.spec.ts",'),
    ],
    ["playwright.configured.config.ts", parseConfigSelection(`testMatch: ["${CONFIGURED}"],`)],
  ]);
  const SPEC_TAGS = new Map([
    [CONFIGURED, new Set()],
    [TAGGED, new Set(["@smoke"])],
    [NAMED, new Set()],
    [ORPHAN, new Set()],
  ]);
  const SCRIPTS = [
    {
      name: "test:e2e:configured",
      command: "playwright test --config tests/e2e/config/playwright.configured.config.ts",
    },
    {
      name: "test:e2e:smoke",
      command: "playwright test --config tests/e2e/config/playwright.config.ts --grep @smoke",
    },
    {
      name: "test:e2e:named",
      command: `playwright test tests/e2e/${NAMED} --config tests/e2e/config/playwright.config.ts`,
    },
  ];

  function reachability(recordedSpecs = []) {
    return checkE2eSpecReachability({
      specs: SPECS,
      scripts: SCRIPTS,
      selections: SELECTIONS,
      specTags: SPEC_TAGS,
      recordedSpecs,
    });
  }

  it("reaches a spec through a config's literal testMatch, a grep tag, and a named path", () => {
    const reached = reachableSpecs({
      specs: SPECS,
      scripts: SCRIPTS,
      selections: SELECTIONS,
      specTags: SPEC_TAGS,
    });
    expect(reached.get(CONFIGURED)).toBe("test:e2e:configured");
    expect(reached.get(TAGGED)).toBe("test:e2e:smoke");
    expect(reached.get(NAMED)).toBe("test:e2e:named");
    expect(reached.has(ORPHAN)).toBe(false);
  });

  it("reports a spec no script can reach", () => {
    const { problems } = reachability();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(ORPHAN);
    expect(problems[0]).toContain("reachable from no test:e2e:* script");
  });

  // The whole point of literal-only config matching. The shared config's "**/*.spec.ts" collects
  // every spec in the tree while its only script greps @smoke; honouring the glob would report the
  // orphan as covered by a lane that never runs it.
  it("does not let a catch-all config glob stand in for a lane", () => {
    const untagged = reachableSpecs({
      specs: [ORPHAN],
      scripts: [SCRIPTS[1]],
      selections: SELECTIONS,
      specTags: new Map([[ORPHAN, new Set()]]),
    });
    expect(untagged.has(ORPHAN)).toBe(false);
  });

  it("honours testIgnore, so an excluded spec is not reached by the tag lane", () => {
    const ignored = "code-task-thing.spec.ts";
    const reached = reachableSpecs({
      specs: [ignored],
      scripts: [SCRIPTS[1]],
      selections: SELECTIONS,
      specTags: new Map([[ignored, new Set(["@smoke"])]]),
    });
    expect(reached.has(ignored)).toBe(false);
  });

  it("passes when the spec is recorded in the register instead", () => {
    expect(reachability([ORPHAN]).problems).toEqual([]);
  });

  // The ratchet: a register that only shrinks is a debt list; one that can hold stale entries is a
  // permanent exemption.
  it("reports a recorded spec that is now reachable, or has been deleted", () => {
    expect(reachability([CONFIGURED]).problems.join("\n")).toContain(
      "test:e2e:configured now runs it",
    );
    expect(reachability([ORPHAN, "gone.spec.ts"]).problems.join("\n")).toContain(
      "gone.spec.ts, which no longer exists",
    );
  });

  it("reads testMatch as a string, an array, or a single-file regular expression", () => {
    expect(parseConfigSelection('testMatch: "one.spec.ts",').literals).toEqual(["one.spec.ts"]);
    expect(parseConfigSelection('testMatch: ["a.spec.ts", "b.spec.ts"],').literals).toEqual([
      "a.spec.ts",
      "b.spec.ts",
    ]);
    expect(parseConfigSelection("testMatch: /local\\.spec\\.ts/u,").literals).toEqual([
      "local.spec.ts",
    ]);
    expect(parseConfigSelection("timeout: 1,").collectsByGlob).toBe(true);
  });

  // `.exec` returns the FIRST match in a file, so a prose comment naming a quoted `testMatch:`
  // above the real declaration used to win over it — in a repository whose configs are full of
  // prose comments. The spec-side extractors already blanked; this one did not.
  it("reads a config's real testMatch, not one quoted in a comment above it", () => {
    const text = [
      '// Prior to #2955 this file used testMatch: "smoke.spec.ts" and a grep lane.',
      'testMatch: "**/*.spec.ts",',
      'testIgnore: "code-task-*.spec.ts",',
    ].join("\n");
    expect(parseConfigSelection(text)).toEqual({
      literals: [],
      collectsByGlob: true,
      ignoredGlobs: ["code-task-*.spec.ts"],
    });
  });

  // A literal testMatch and testIgnore share the guard; only the grep lane was covered before.
  it("honours testIgnore against a literal testMatch too", () => {
    const ignored = "code-task-thing.spec.ts";
    const selections = new Map([
      [
        "playwright.literal.config.ts",
        parseConfigSelection(`testMatch: ["${ignored}"],\ntestIgnore: "code-task-*.spec.ts",`),
      ],
    ]);
    const reached = reachableSpecs({
      specs: [ignored],
      scripts: [
        {
          name: "test:e2e:literal",
          command: "playwright test --config x/playwright.literal.config.ts",
        },
      ],
      selections,
      specTags: new Map([[ignored, new Set()]]),
    });
    expect(reached.has(ignored)).toBe(false);
  });

  it("reads a literal testMatch as not collecting by glob", () => {
    expect(parseConfigSelection('testMatch: "one.spec.ts",').collectsByGlob).toBe(false);
  });

  // Playwright registers --grep through Commander, so a repeated flag OVERWRITES; and
  // --grep-invert excludes. Modelling several --grep flags as a conjunction, or ignoring the
  // inversion, both report coverage the lane does not have.
  it("takes the last --grep, honours --grep-invert, and reads the inline form", () => {
    const specs = ["tagged.spec.ts"];
    const specTags = new Map([["tagged.spec.ts", new Set(["@smoke", "@slow"])]]);
    const via = (command) =>
      reachableSpecs({
        specs,
        scripts: [{ name: "test:e2e:x", command }],
        selections: SELECTIONS,
        specTags,
      }).has("tagged.spec.ts");
    const base = "playwright test --config tests/e2e/config/playwright.config.ts";
    expect(via(`${base} --grep=@smoke`)).toBe(true);
    expect(via(`${base} --grep @other --grep @smoke`)).toBe(true);
    expect(via(`${base} --grep @smoke --grep @other`)).toBe(false);
    expect(via(`${base} --grep @smoke --grep-invert @slow`)).toBe(false);
  });

  // Only a positional argument names a file Playwright runs. A flag's VALUE that happens to end in
  // .spec.ts marked an otherwise-unreachable spec reachable.
  it("does not read a flag value as a named spec", () => {
    expect(commandSpecNames("playwright test --output=stale.spec.ts real.spec.ts")).toEqual([
      "real.spec.ts",
    ]);
    expect(commandSpecNames("playwright test --grep other.spec.ts real.spec.ts")).toEqual([
      "real.spec.ts",
    ]);
  });

  // …and only operands of a PLAYWRIGHT command count. A neighbouring command in the same script
  // naming a spec Playwright never collects recreates the false-green inventory.
  it("takes spec operands only from a playwright invocation", () => {
    expect(commandSpecNames("echo tests/e2e/new.spec.ts")).toEqual([]);
    expect(commandSpecNames("echo new.spec.ts && playwright test real.spec.ts")).toEqual([
      "real.spec.ts",
    ]);
    expect(commandSpecNames("npx playwright test real.spec.ts")).toEqual(["real.spec.ts"]);
    expect(commandSpecNames("playwright test a.spec.ts && echo b.spec.ts")).toEqual(["a.spec.ts"]);
  });

  it("reads a tag from a spec's code but not from its comments", () => {
    expect(declaredSpecTags('test("runs @smoke", () => {});')).toContain("@smoke");
    expect(declaredSpecTags("// @smoke is not wired yet\nconst x = 1;")).not.toContain("@smoke");
    // `--grep` matches the rendered TITLE, so a tag-shaped string anywhere else declares nothing.
    // Both of these used to mark a spec reachable from a lane that would run zero of its tests.
    expect(declaredSpecTags('const diagnostic = "@smoke";')).not.toContain("@smoke");
    expect(declaredSpecTags('import { test } from "@playwright/test";')).not.toContain(
      "@playwright",
    );
    // …while the established "name the tag once, interpolate it into every title" pattern resolves.
    expect(
      declaredSpecTags('const TAG = "@git-status-1386";\ntest(`opens a diff ${TAG}`, () => {});'),
    ).toContain("@git-status-1386");
    expect(declaredSpecTags('test.describe("Atlassian connectors @smoke", () => {});')).toContain(
      "@smoke",
    );
  });

  it("requires a non-empty reason for every recorded spec and rejects stale reasons", () => {
    expect(() => validateUnreachableSpecReasons([ORPHAN], {})).toThrow(/no reason/u);
    expect(() => validateUnreachableSpecReasons([], { [ORPHAN]: "why" })).toThrow(/stale reason/u);
    expect(validateUnreachableSpecReasons([ORPHAN], { [ORPHAN]: "why" })).toEqual({
      [ORPHAN]: "why",
    });
  });

  it("rejects duplicate and non-spec register entries", () => {
    expect(() => validateUnreachableSpecs([ORPHAN, ORPHAN])).toThrow(/more than once/u);
    expect(() => validateUnreachableSpecs(["playwright.x.config.ts"])).toThrow(/file names/u);
    expect(() => validateUnreachableSpecs(undefined)).toThrow(/specsWithoutLane/u);
  });
});

// Audit KEIKO-0094 (#2955). A wired suite calling a route the server does not mount reads as a
// passing journey right up to the moment it runs — which is how editor-agent-docking-2122 kept
// POSTing two routes #2256 deliberately unmounted, in a lane nobody watched.
describe("route resolution (KEIKO-0094)", () => {
  // Method-pattern pairs, as the production table is: the server dispatches on both.
  const PATTERNS = [
    { method: "GET", pattern: "/api/editor/agent/sessions" },
    { method: "GET", pattern: "/api/editor/agent/audit" },
    { method: "GET", pattern: "/api/git/status" },
    { method: "POST", pattern: "/api/runs/:runId/cancel" },
    { method: "GET", pattern: "/api/prompt-enhancement/evidence/:runId" },
  ];
  const source = (body) => [{ name: "one.spec.ts", source: body }];

  function problemsFor(body, externalPaths = []) {
    return checkE2eRouteResolution({
      specSources: source(body),
      patterns: PATTERNS,
      externalPaths,
    });
  }

  it("reports a path no mounted route serves", () => {
    const problems = problemsFor('await request.post("/api/editor/agent/authority", {});');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("/api/editor/agent/authority");
    expect(problems[0]).toContain("no mounted server route serves");
  });

  it("resolves an exact path and a :param segment", () => {
    expect(problemsFor('request.get("/api/editor/agent/sessions")')).toEqual([]);
    expect(problemsFor('request.post("/api/runs/run-7/cancel")')).toEqual([]);
  });

  it("does not let a shorter or longer path match a mounted pattern", () => {
    expect(problemsFor('request.get("/api/runs/run-7")')).toHaveLength(1);
    expect(problemsFor('request.get("/api/git/status/extra")')).toHaveLength(1);
  });

  // Interception globs and interpolated template literals name a FAMILY of paths, not one route.
  it("resolves a wildcard route glob and an interpolated path by prefix", () => {
    expect(problemsFor('page.route("**/api/git/status**", handler)')).toEqual([]);
    // POST, because that is the method the fixture mounts for this family — the prefix branch
    // consults the method too, and a GET here would be the "cannot succeed" case.
    expect(problemsFor("request.post(`/api/runs/${id}/cancel`)")).toEqual([]);
    expect(problemsFor('expect(url).toContain("/api/prompt-enhancement/evidence/")')).toEqual([]);
  });

  // A spec that RECOGNISES a route with a regular expression spells the separators escaped. A
  // finder anchored on a bare `/api/` matched none of them, so a route named that way was exempt
  // from this invariant for no reason but the syntax that named it — `editor-run-verification-2215`
  // is exactly that shape.
  it("finds a route named by a regular expression, with escaped separators", () => {
    const source = String.raw`const r = /\/api\/runs\/[^/]+\/cancel$/u;`;
    expect(apiPathReferences(source)).toEqual([{ path: "/api/runs", prefix: true }]);
    expect(problemsFor(source)).toEqual([]);
    expect(problemsFor(String.raw`const r = /\/api\/editor\/authority$/u;`)).toHaveLength(1);
  });

  // A nested template desynchronised the scanner: the inner backtick closed the outer string, the
  // scanner fell into code mode, and the first `//` it met — inside a URL — blanked the rest of the
  // line together with any real call on it. Silent, and in the fail-OPEN direction.
  it("does not lose a call that follows a nested template literal", () => {
    const source = 'const l = `outer ${`http://nested`} tail`; page.route("/api/git/status", h);';
    expect(apiPathReferences(source).map((reference) => reference.path)).toEqual([
      "/api/git/status",
    ]);
  });

  // A `:` names one parameterised SEGMENT, exactly as the mounted patterns do. Truncating at it
  // turned a stale template into a prefix that any sibling route satisfied.
  it("matches a parameterised path segment instead of truncating to a prefix", () => {
    expect(problemsFor('request.post("/api/runs/:runId/cancel")')).toEqual([]);
    const stale = problemsFor('request.post("/api/editor/gone/:id/rename")');
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain("/api/editor/gone/:id/rename");
  });

  it("does not let a :param stand in for an empty segment", () => {
    expect(problemsFor('request.post("/api/runs//cancel")')).toHaveLength(1);
  });

  // The other direction of this register's ratchet. Without it a recorded path is exempt forever,
  // and the register would stop describing the server the day it started mounting one.
  it("reports a recorded external path that the server now mounts", () => {
    const problems = checkE2eRouteResolution({
      specSources: source('request.get("/api/git/status")'),
      patterns: PATTERNS,
      externalPaths: ["/api/git/status"],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("a route now serves it");
  });

  // The server dispatches on method AND pattern, so a path-only projection called a POST to a
  // GET-only route "mounted" — a journey that cannot succeed.
  it("requires the method a call site names to be one the table serves", () => {
    const methodPatterns = [
      { method: "GET", pattern: "/api/git/status" },
      { method: "POST", pattern: "/api/runs/:runId/cancel" },
    ];
    const problems = (src) =>
      checkE2eRouteResolution({
        specSources: source(src),
        patterns: methodPatterns,
        externalPaths: [],
      });
    expect(problems('request.get("/api/git/status")')).toEqual([]);
    expect(problems('request.post("/api/git/status")')).toHaveLength(1);
    expect(problems('request.post("/api/runs/run-7/cancel")')).toEqual([]);
    // An interception glob names no verb, so it stays a path-only question.
    expect(problems('page.route("**/api/git/status", handler)')).toEqual([]);
  });

  it("ignores a path that appears only in a comment", () => {
    expect(problemsFor("// calls /api/editor/agent/authority one day\nconst x = 1;")).toEqual([]);
  });

  it("passes an allowlisted path and reports one no spec names any more", () => {
    const body = 'if (!String(url).includes("/api/voice/control")) return;';
    expect(problemsFor(body, ["/api/voice/control"])).toEqual([]);
    const stale = problemsFor("const x = 1;", ["/api/voice/control"]);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain("no spec names it any more");
  });

  it("requires a non-empty reason for every allowlisted path and rejects stale reasons", () => {
    expect(() => validateExternalApiPathReasons(["/api/x"], {})).toThrow(/no reason/u);
    expect(() => validateExternalApiPathReasons([], { "/api/x": "why" })).toThrow(/stale reason/u);
    expect(() => validateExternalApiPaths(["not-a-path"])).toThrow(/paths/u);
    expect(() => validateExternalApiPaths(["/api/x", "/api/x"])).toThrow(/more than once/u);
  });

  it("matches a path by segment arity, and a prefix by containment", () => {
    expect(routeResolves({ path: "/api/git/status", prefix: false }, PATTERNS)).toBe(true);
    expect(routeResolves({ path: "/api/git", prefix: false }, PATTERNS)).toBe(false);
    expect(routeResolves({ path: "/api/git", prefix: true }, PATTERNS)).toBe(true);
    expect(routeResolves({ path: "/api/gitx", prefix: true }, PATTERNS)).toBe(false);
  });

  // Blanking, not deleting: a `//` inside a string is not a comment, and losing the rest of that
  // line would silently drop any call after it — the fail-OPEN direction this gate cannot afford.
  it("blanks comments while leaving string literals byte-identical", () => {
    expect(blankComments('const a = "http://127.0.0.1/api/git/status";')).toContain(
      "http://127.0.0.1/api/git/status",
    );
    expect(blankComments("/* /api/gone */ const a = 1;")).not.toContain("/api/gone");
    expect(blankComments("const a = 1; // /api/gone\nconst b = 2;")).not.toContain("/api/gone");
    expect(blankComments("/* x */ const a = 1;")).toContain("const a = 1;");
  });

  it("extracts one reference per path and prefers the exact form over a prefix", () => {
    const refs = apiPathReferences(
      'page.route("**/api/git/status**"); request.get("/api/git/status")',
    );
    // Two entries: the interception glob names no verb, the request names GET. They are different
    // questions of the table, so they are kept apart rather than collapsed.
    expect(refs).toEqual([
      { path: "/api/git/status", prefix: true, method: undefined },
      { path: "/api/git/status", prefix: false, method: "GET" },
    ]);
    expect(apiPathReferences('const base = "/api/";')).toEqual([]);
  });

  // Fail closed on unreadable input: an unloadable route table means the mounted set is UNKNOWN, and
  // a gate that quietly skipped the invariant there would remove itself exactly when it is needed.
  it("reports an unreadable route table instead of skipping the invariant", async () => {
    await expect(mountedRoutePatterns(join(tmpdir(), "keiko-no-such-checkout"))).rejects.toThrow(
      /could not be loaded/u,
    );
  });

  // An empty `problems` array cannot distinguish "the invariant ran and found nothing" from "the
  // invariant was never spread into the aggregate". These assert the two new registers against the
  // REAL repository, the way the suite register already was, so dropping either spread goes red.
  it("holds both new invariants over the real repository", () => {
    const result = realRepositoryGate;
    expect(result.problems).toEqual([]);
    // Every spec is accounted for: reachable, or recorded with a reason.
    expect(result.specs).toBeGreaterThan(result.unreachableSpecs);
    expect(result.unreachableSpecs).toBeGreaterThan(0);
    expect(result.externalPaths).toBeGreaterThan(0);
    expect(formatGateReport(result)).toContain("deliberately unmounted");
  });

  it("still finds the real recorded spec unreachable, and its recorded paths unmounted", async () => {
    const repoRoot = join(import.meta.dirname, "..", "..");
    const baseline = JSON.parse(
      readFileSync(join(repoRoot, "docs", "qa", "unwired-e2e-suites.json"), "utf8"),
    );
    expect(baseline.specsWithoutLane).toContain("human-loop-1405.spec.ts");
    const patterns = await mountedRoutePatterns(repoRoot);
    for (const path of baseline.externalApiPaths) {
      // The reason each entry carries is "this server deliberately does not mount it" — asserted
      // here against the real table rather than trusted from the prose.
      expect(routeResolves({ path, prefix: false }, patterns)).toBe(false);
    }
  }, 180_000);

  // A table that loads but says nothing is as unusable as one that does not load, and silently
  // resolving nothing would turn the invariant into a no-op rather than a failure.
  it("reports a route table that loads but exports nothing", async () => {
    await withFixtureRoot(
      (root) => {
        mkdirSync(join(root, "packages", "keiko-server", "dist"), { recursive: true });
        writeFileSync(
          join(root, "packages", "keiko-server", "dist", "index.js"),
          "export const API_ROUTES = [];\n",
          "utf8",
        );
      },
      async (root) => {
        await expect(mountedRoutePatterns(root)).rejects.toThrow(/exported no API_ROUTES/u);
      },
    );
  }, 180_000);

  it("reads the real mounted table from the built server package", async () => {
    const patterns = await mountedRoutePatterns(join(import.meta.dirname, "..", ".."));
    const mounted = patterns.map((route) => route.pattern);
    expect(mounted).toContain("/api/editor/agent/sessions");
    // #2256 unmounted the browser-owned authority routes on purpose; routes.test.ts pins that they
    // stay unmounted. If this ever resolves, the register entry — not the gate — is what moved.
    expect(mounted).not.toContain("/api/editor/agent/authority");
  }, 180_000);
});
