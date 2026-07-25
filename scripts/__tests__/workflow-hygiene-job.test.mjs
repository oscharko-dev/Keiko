import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const ci = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
const osv = readFileSync(resolve(repoRoot, ".github/workflows/osv-scanner.yml"), "utf8");

// ADR-0159: the four workflow-hygiene micro-gates run as serial steps of one job producing the
// single required `workflow hygiene` context. The bundling is only legitimate while every tool runs
// at the same pinned version, with the same configuration, over the same evaluation surface - so
// that is what this file pins, machine-checked rather than asserted in a pull-request description.

// Sliced to the NEXT top-level job key rather than to a named follower, so reordering or removing
// jobs in ci.yml cannot silently change what these assertions read (the idiom
// dev-quality-workflows.test.mjs documents for the coverage jobs).
// The `$` alternative is load-bearing: `scan` is the last job in osv-scanner.yml, so a bound that
// only accepts a following top-level key reads it as absent and turns a real assertion vacuous.
function jobBlock(source, jobId) {
  const block = new RegExp(` {2}${jobId}:\\n[\\s\\S]*?(?=\\n {2}\\S|$)`, "u").exec(source);
  if (block === null) throw new Error(`job ${jobId} not found`);
  return block[0];
}

function jobLevelCondition(source, jobId) {
  const match = / {4}if: (.*)\n/u.exec(jobBlock(source, jobId));
  if (match === null) throw new Error(`job ${jobId} has no job-level if:`);
  return match[1];
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

// The exact trigger condition of the standalone `zizmor` job. Reproducing it character for
// character at step level is the whole safety argument for moving zizmor into a job that runs
// unconditionally: a dropped clause silently widens the surface, an added one silently narrows it,
// and neither is visible in a green run.
const ZIZMOR_TRIGGER =
  "(github.event_name == 'pull_request' && github.base_ref == 'dev') || " +
  "(github.event_name == 'push' && github.ref == 'refs/heads/dev') || " +
  "github.event_name == 'merge_group'";

// What each tool invocation IS, at the granularity that decides whether the check still checks the
// same thing. Every fingerprint must appear in the bundled job; while the standalone jobs still
// exist (ADR-0159 D4 phase 1) it must appear there too, which is what makes "same checks" a test
// rather than a claim.
const TOOL_INVOCATIONS = [
  {
    tool: "actionlint",
    standalone: { source: ci, jobId: "actionlint" },
    fingerprints: [
      "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz",
      "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8  actionlint.tar.gz",
      "sha256sum --check",
      "./actionlint -color .github/workflows/*.yml",
    ],
  },
  {
    tool: "pinned-SHA grep",
    standalone: { source: ci, jobId: "verify-pinned-shas" },
    fingerprints: [
      "grep -rnE '^\\s*-?\\s*uses:' .github/workflows/",
      "grep -vE 'uses:\\s*\\./'",
      "grep -vE 'uses:\\s*docker://'",
      "grep -vE 'uses:\\s*[A-Za-z0-9._/-]+@[0-9a-f]{40}([[:space:]]|$|#)'",
    ],
  },
  {
    tool: "zizmor",
    standalone: { source: ci, jobId: "zizmor" },
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
    standalone: { source: osv, jobId: "scan" },
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
    expect(jobBlock(ci, BUNDLED_JOB)).toContain("name: workflow hygiene\n");
  });

  it.each(TOOL_INVOCATIONS)("runs $tool at the pinned version it ran at before", (invocation) => {
    const bundled = jobBlock(ci, BUNDLED_JOB);
    for (const fingerprint of invocation.fingerprints) {
      expect(bundled, `bundled job must invoke ${invocation.tool} unchanged`).toContain(
        fingerprint,
      );
    }
  });

  it("runs zizmor on exactly the events the standalone job ran it on", () => {
    const bundled = jobBlock(ci, BUNDLED_JOB);
    // The guard composes with the trigger, it does not replace it: a job never skips because a
    // sibling job failed, so this is what makes a step behave like the independent job it came
    // from. It can only narrow the guard, never widen the trigger.
    expect(bundled).toContain(`if: \${{ ${GATE_GUARD} && (${ZIZMOR_TRIGGER}) }}\n`);
  });

  it("reads exactly the one job it claims to read", () => {
    // In phase 1 the same fingerprints also live in the three standalone jobs of this same file, so
    // an over-matching slice would satisfy every assertion above while reading a different job.
    const [first, ...rest] = jobBlock(ci, BUNDLED_JOB).split("\n");
    expect(first).toBe(`  ${BUNDLED_JOB}:`);
    expect(rest.filter((line) => line !== "" && !line.startsWith("    "))).toEqual([]);
  });

  it("lets no gate's finding be suppressed by another gate's failure", () => {
    // Four independent jobs gave this for free. Serial steps do not: without the guard an actionlint
    // finding hides a lockfile vulnerability until the next round, buying fewer contexts with more
    // repair rounds. It never softens the verdict - a failed step fails the job regardless.
    const steps = jobSteps(ci, BUNDLED_JOB);
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
    const steps = jobSteps(ci, BUNDLED_JOB);
    // The guard names the checkout step, so the checkout has to carry that id or every guard is
    // false and the whole job silently skips its gates while concluding success.
    expect(jobBlock(ci, BUNDLED_JOB)).toMatch(/\n {8}id: checkout\n/u);
    for (const step of steps) {
      if (step.condition === null) continue;
      expect(step.condition, `${step.name} must require the checkout it reads`).toContain(
        "steps.checkout.outcome != 'failure'",
      );
    }
  });

  it("fails the single context closed on any step", () => {
    expect(jobBlock(ci, BUNDLED_JOB)).not.toContain("continue-on-error");
  });

  it("bounds the required context with the timeout ADR-0159 D3 decides", () => {
    // Without it a stalled scanner sits on GitHub's six-hour default and the required context never
    // reports. The number is the ADR's, so tuning it is a decision-record change, not a test edit.
    expect(jobBlock(ci, BUNDLED_JOB)).toMatch(/\n {4}timeout-minutes: 15\n/u);
  });

  it("uses read-only repository permissions and disables checkout credentials", () => {
    const bundled = jobBlock(ci, BUNDLED_JOB);
    // The whole mapping, not a substring hunt: `contents: read` is the only key, so the job cannot
    // quietly gain a write scope. Searching the block for "write" would instead fail on the word
    // appearing in a comment, and pass on a scope smuggled in above the first `permissions:`.
    expect(bundled).toMatch(/\n {4}permissions:\n {6}contents: read\n {4}\S/u);
    expect(bundled).toContain("persist-credentials: false");
  });

  it("aggregates no check run, so no required check depends on another", () => {
    // ADR-0135 D3. This job executes tools directly; the `ci` aggregate must never wait on it, or
    // one required context would gate another.
    expect(jobBlock(ci, "ci")).not.toContain(BUNDLED_JOB);
  });
});

// ADR-0159 D4 phase 1: the bundle is added while the four micro-gates keep executing and keep being
// required, so both shapes produce green contexts on every pull request and the bundle can be
// observed before it is trusted. Phase 3 removes these jobs - strictly after the owner's atomic
// branch-protection swap - and this block goes with them; it is scoped to the phase by name and by
// that ADR reference, not relaxed into vacuity.
describe("workflow hygiene rollout phase 1 - no protection gap", () => {
  it.each(TOOL_INVOCATIONS)("still runs $tool in its own required context", (invocation) => {
    const standalone = jobBlock(invocation.standalone.source, invocation.standalone.jobId);
    for (const fingerprint of invocation.fingerprints) {
      expect(standalone).toContain(fingerprint);
    }
  });

  it("derives the bundled zizmor condition from the standalone job, not from a copy", () => {
    expect(jobLevelCondition(ci, "zizmor")).toBe(`\${{ ${ZIZMOR_TRIGGER} }}`);
  });
});
