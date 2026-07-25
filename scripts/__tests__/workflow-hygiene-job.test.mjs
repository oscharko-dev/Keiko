import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const hygiene = readFileSync(resolve(repoRoot, ".github/workflows/workflow-hygiene.yml"), "utf8");
const ci = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");

// ADR-0159: the four workflow-hygiene micro-gates run as serial steps of one job producing the
// single required `workflow hygiene` context. The bundling is only legitimate while every tool runs
// at the same pinned version, with the same configuration, over the same evaluation surface - so
// that is what this file pins, machine-checked rather than asserted in a pull-request description.

// Sliced to the NEXT top-level job key rather than to a named follower, so reordering or removing
// jobs cannot silently change what these assertions read (the idiom dev-quality-workflows.test.mjs
// documents for the coverage jobs). The `$` alternative is load-bearing: `workflow-hygiene` is the
// only job in its file, so a bound that requires a following top-level key reads it as absent and
// turns every assertion below vacuous.
function jobBlock(source, jobId) {
  const block = new RegExp(` {2}${jobId}:\\n[\\s\\S]*?(?=\\n {2}\\S|$)`, "u").exec(source);
  if (block === null) throw new Error(`job ${jobId} not found`);
  return block[0];
}

// A job's steps in order, as { name, condition }. Parsing the steps is what lets an assertion bind
// a guard to the gate it protects; counting `!cancelled()` occurrences in the block would stay
// green while somebody moved a guard off a gate and onto a step that is not one.
function jobSteps(source, jobId) {
  const steps = [];
  for (const line of jobBlock(source, jobId).split("\n")) {
    const name = / {6}- name: (.+)$/u.exec(line);
    if (name !== null) steps.push({ condition: null, name: name[1] });
    const condition = / {8}if: (.+)$/u.exec(line);
    if (condition !== null && steps.length > 0) steps[steps.length - 1].condition = condition[1];
  }
  return steps;
}

// The four gates, in the order the job runs them, and the two steps that are not gates: the shared
// checkout, and downloading the actionlint binary, which is a prerequisite of `Run actionlint`.
const BUNDLED_JOB = "workflow-hygiene";
const CHECKOUT_STEP = "Check out repository";
const ACTIONLINT_PREREQUISITE = "Download and verify actionlint";
const GATE_STEPS = [
  "Run actionlint",
  "Assert all action references are pinned to 40-hex SHAs",
  "Run zizmor",
  "Scan dependency manifests with OSV Scanner",
];

// Every guard is exactly this, optionally followed by the step's own trigger. `!cancelled()` alone
// would also override the default `success()` against the shared checkout, so a gate would run over
// a workspace it never got - and the pinned-SHA grep, which ends in `|| true`, would report success
// over a directory it never read. A gate must survive another GATE failing, not a missing workspace.
// `!= 'failure'` rather than `== 'success'` so a renamed or dropped id runs the gates instead of
// skipping all four and reporting a green required context that checked nothing.
const GATE_GUARD = "!cancelled() && steps.checkout.outcome != 'failure'";

// The exact trigger condition the standalone `zizmor` job carried before ADR-0159 consolidated it.
// With that job gone this constant is the only record of the shape outside the workflow itself, and
// that is the point: a dropped clause silently widens zizmor's surface, an added one silently
// narrows it, and neither is visible in a green run.
const ZIZMOR_TRIGGER =
  "(github.event_name == 'pull_request' && github.base_ref == 'dev') || " +
  "(github.event_name == 'push' && github.ref == 'refs/heads/dev') || " +
  "github.event_name == 'merge_group'";

// What each tool invocation IS, at the granularity that decides whether the check still checks the
// same thing. These are the four standalone jobs' invocations character for character; the jobs
// themselves are gone (ADR-0159 phase 3), so this list is now the only record of what the context
// promised to keep running, and every entry must appear in the bundled job.
const TOOL_INVOCATIONS = [
  {
    tool: "actionlint",
    fingerprints: [
      "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz",
      "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8  actionlint.tar.gz",
      "sha256sum --check",
      "./actionlint -color .github/workflows/*.yml",
    ],
  },
  {
    tool: "pinned-SHA grep",
    fingerprints: [
      "grep -rnE '^\\s*-?\\s*uses:' .github/workflows/",
      "grep -vE 'uses:\\s*\\./'",
      "grep -vE 'uses:\\s*docker://'",
      "grep -vE 'uses:\\s*[A-Za-z0-9._/-]+@[0-9a-f]{40}([[:space:]]|$|#)'",
    ],
  },
  {
    tool: "zizmor",
    fingerprints: [
      "zizmorcore/zizmor-action@6599ee8b7a49aef6a770f63d261d214911a7ce02",
      'version: "1.26.1"',
      "config: .github/zizmor.yml",
      "advanced-security: false",
      "annotations: true",
    ],
  },
  {
    tool: "OSV Scanner",
    fingerprints: [
      "google/osv-scanner-action/osv-scanner-action@9a498708959aeaef5ef730655706c5a1df1edbc2",
      "--config=osv-scanner.toml",
      "--recursive",
    ],
  },
];

describe("bundled workflow hygiene job", () => {
  it("produces the check context named in the branch-protection required list", () => {
    // The context string is the job's `name:` byte for byte (ADR-0002). A typo here is not a failing
    // check, it is a required context that never reports and a pull request blocked forever.
    expect(jobBlock(hygiene, BUNDLED_JOB)).toContain("name: workflow hygiene\n");
  });

  it.each(TOOL_INVOCATIONS)("runs $tool at the pinned version it ran at before", (invocation) => {
    const bundled = jobBlock(hygiene, BUNDLED_JOB);
    for (const fingerprint of invocation.fingerprints) {
      expect(bundled, `bundled job must invoke ${invocation.tool} unchanged`).toContain(
        fingerprint,
      );
    }
  });

  it("runs zizmor on exactly the events the standalone job ran it on", () => {
    const bundled = jobBlock(hygiene, BUNDLED_JOB);
    // The guard composes with the trigger, it does not replace it: a job never skips because a
    // sibling job failed, so this is what makes a step behave like the independent job it came
    // from. It can only narrow the guard, never widen the trigger.
    expect(bundled).toContain(`if: \${{ ${GATE_GUARD} && (${ZIZMOR_TRIGGER}) }}\n`);
  });

  it("reads exactly the one job it claims to read", () => {
    // An over-matching slice would satisfy every assertion above while reading something else; with
    // `$` as a bound that is the failure mode to guard, not under-matching.
    const [first, ...rest] = jobBlock(hygiene, BUNDLED_JOB).split("\n");
    expect(first).toBe(`  ${BUNDLED_JOB}:`);
    expect(rest.filter((line) => line !== "" && !line.startsWith("    "))).toEqual([]);
  });

  it("lets no gate's finding be suppressed by another gate's failure", () => {
    // Four independent jobs gave this for free. Serial steps do not: without the guard an actionlint
    // finding hides a lockfile vulnerability until the next round, buying fewer contexts with more
    // repair rounds. It never softens the verdict - a failed step fails the job regardless.
    const steps = jobSteps(hygiene, BUNDLED_JOB);
    // Order is pinned because the exemption below depends on it: `Run actionlint` needs no guard
    // only while nothing but the checkout and its own prerequisite run ahead of it.
    expect(steps.map((step) => step.name)).toEqual([
      CHECKOUT_STEP,
      ACTIONLINT_PREREQUISITE,
      ...GATE_STEPS,
    ]);
    for (const gate of GATE_STEPS.slice(1)) {
      const step = steps.find((candidate) => candidate.name === gate);
      expect(step?.condition, `${gate} must run even when an earlier gate failed`).toContain(
        GATE_GUARD,
      );
    }
  });

  it("skips every gate that lost the workspace instead of reporting over an empty one", () => {
    const steps = jobSteps(hygiene, BUNDLED_JOB);
    // The guard names the checkout step, so the checkout has to carry that id or every guard is
    // false and the whole job silently skips its gates while concluding success.
    expect(jobBlock(hygiene, BUNDLED_JOB)).toMatch(/\n {8}id: checkout\n/u);
    for (const step of steps) {
      if (step.condition === null) continue;
      expect(step.condition, `${step.name} must require the checkout it reads`).toContain(
        "steps.checkout.outcome != 'failure'",
      );
    }
  });

  it("fails the single context closed on any step", () => {
    expect(jobBlock(hygiene, BUNDLED_JOB)).not.toContain("continue-on-error");
  });

  it("bounds the required context with the timeout ADR-0159 D3 decides", () => {
    // Without it a stalled scanner sits on GitHub's six-hour default and the required context never
    // reports. The number is the ADR's, so tuning it is a decision-record change, not a test edit.
    expect(jobBlock(hygiene, BUNDLED_JOB)).toMatch(/\n {4}timeout-minutes: 15\n/u);
  });

  it("uses read-only repository permissions and disables checkout credentials", () => {
    const bundled = jobBlock(hygiene, BUNDLED_JOB);
    // The whole mapping, not a substring hunt: `contents: read` is the only key, so the job cannot
    // quietly gain a write scope. Searching the block for "write" would instead fail on the word
    // appearing in a comment, and pass on a scope smuggled in above the first `permissions:`.
    expect(bundled).toMatch(/\n {4}permissions:\n {6}contents: read\n {4}\S/u);
    expect(bundled).toContain("persist-credentials: false");
  });

  it("aggregates no check run, so no required check depends on another", () => {
    // ADR-0135 D3. This job executes tools directly; the `ci` aggregate must never wait on it, or
    // one required context would gate another. Now cross-workflow, which `needs:` cannot express -
    // so the assertion is that ci.yml never learns the name at all.
    expect(jobBlock(ci, "ci")).not.toContain(BUNDLED_JOB);
  });
});

// ADR-0159 phase 3 closed the rollout: branch protection requires `workflow hygiene`, the four
// micro-jobs are gone, and the bundle owns its own workflow file so its trigger surface can be the
// union of the four it replaced instead of ci.yml's.
describe("workflow hygiene trigger surface", () => {
  it("keeps the deny-all default and a manual lane", () => {
    expect(hygiene).toMatch(/\npermissions: \{\}\n/u);
    expect(hygiene).toMatch(/\n {2}workflow_dispatch:\n/u);
  });

  it("does not leave a second producer of the same context behind", () => {
    // Two workflows emitting a job named `workflow hygiene` would race for one required context.
    expect(ci).not.toContain("workflow-hygiene");
    expect(ci).not.toContain("name: workflow hygiene");
  });
});
