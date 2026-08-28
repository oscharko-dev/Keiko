/**
 * The repository half of the npm Trusted Publisher binding (ADR-0130 D4/D5, issue #3088).
 *
 * npmjs.com stores the publisher entry as `repository + workflow BASENAME + environment` and never
 * re-validates it: renaming `release.yml`, renaming the `npm-publish` environment, dropping
 * `id-token: write`, moving the job to a self-hosted runner, wrapping it behind `workflow_call`, or
 * letting a registry token reach the publish step from any env scope all leave CI green and break
 * authentication only at the registry, mid-release. The npm-side entry cannot be read from here, so
 * this pins every condition the entry depends on that IS readable — the ADR previously stated the
 * obligation in prose with no gate behind it.
 *
 * The conditions are evaluated by `bindingFailures()` over a parsed workflow document, so the live
 * file proves acceptance and weakened copies of it prove rejection. A suite that only asserted the
 * current file would pass just as happily over assertions that can no longer fail.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/** The exact basename registered as the Trusted Publisher's workflow on npmjs.com. */
const TRUSTED_PUBLISHER_WORKFLOW = "release.yml";
/** The exact GitHub Actions environment the publisher entry is bound to. */
const TRUSTED_PUBLISHER_ENVIRONMENT = "npm-publish";
/** Trusted publishing needs a GitHub-hosted runner: self-hosted mints no identity npm accepts. */
const HOSTED_RUNNER = "ubuntu-latest";
/** The job that runs `npm publish`; its name is local, the conditions on it are not. */
const PUBLISH_JOB = "publish";
const PUBLISH_STEP = "Publish package";
/** A token under either name, from any scope, returns the pipeline to classic-token publishing. */
const REGISTRY_TOKEN_ENV = ["NODE_AUTH_TOKEN", "NPM_TOKEN"];

const workflowsDir = resolve(import.meta.dirname, "..", "..", ".github", "workflows");
const workflowPath = join(workflowsDir, TRUSTED_PUBLISHER_WORKFLOW);
const workflow = parse(readFileSync(workflowPath, "utf8"));

/** @returns the env variable names declared at workflow, job, and step scope — all inherited. */
function declaredEnvNames(document, job) {
  const scopes = [document.env, job.env, ...(job.steps ?? []).map((step) => step.env)];
  return scopes.flatMap((scope) => Object.keys(scope ?? {}));
}

function jobShapeFailures(document, job) {
  const failures = [];
  if (job.environment !== TRUSTED_PUBLISHER_ENVIRONMENT) failures.push("environment is not bound");
  if (job.permissions?.["id-token"] !== "write") failures.push("id-token write is missing");
  if (job["runs-on"] !== HOSTED_RUNNER) failures.push("runner is not GitHub-hosted");
  if (job.uses !== undefined || !Array.isArray(job.steps)) failures.push("job is a reusable call");
  if (Object.keys(document.on ?? {}).includes("workflow_call")) failures.push("workflow_call");
  return failures;
}

/**
 * @returns one message per condition the publisher entry depends on that this document breaks;
 *   empty means the OIDC exchange can happen and npm's stored entry still matches.
 */
function bindingFailures(document) {
  const job = document.jobs?.[PUBLISH_JOB];
  if (job === undefined) return ["publish job is missing"];

  const failures = jobShapeFailures(document, job);
  const declared = declaredEnvNames(document, job);
  for (const name of REGISTRY_TOKEN_ENV) {
    if (declared.includes(name)) failures.push(`${name} reaches the publish step`);
  }
  return failures;
}

/** @returns a deep copy of the live workflow with `mutate` applied — never the shared document. */
function weakened(mutate) {
  const document = structuredClone(workflow);
  mutate(document, document.jobs[PUBLISH_JOB]);
  return document;
}

const TOKEN_EXPRESSION = "${{ secrets.KEIKO_REGISTRY }}";

// Each token scope is fed by a DIFFERENTLY NAMED secret on purpose: the `secrets.NPM_TOKEN` scan
// in the last case never sees these, so only the env-name check rejects them (Codex on #3299).
const WEAKENED_VARIANTS = [
  [
    "a renamed environment",
    (_doc, job) => (job.environment = "npm-release"),
    "environment is not bound",
  ],
  ["a dropped environment", (_doc, job) => delete job.environment, "environment is not bound"],
  [
    "id-token downgraded to read",
    (_doc, job) => (job.permissions["id-token"] = "read"),
    "id-token write is missing",
  ],
  ["dropped job permissions", (_doc, job) => delete job.permissions, "id-token write is missing"],
  [
    "a self-hosted runner",
    (_doc, job) => (job["runs-on"] = "self-hosted"),
    "runner is not GitHub-hosted",
  ],
  [
    "a reusable-workflow job",
    (_doc, job) => (job.uses = "./.github/workflows/publish.yml"),
    "job is a reusable call",
  ],
  ["a stepless job", (_doc, job) => delete job.steps, "job is a reusable call"],
  ["a workflow_call trigger", (doc) => (doc.on.workflow_call = null), "workflow_call"],
  [
    "a workflow-scope token",
    (doc) => (doc.env.NPM_TOKEN = TOKEN_EXPRESSION),
    "NPM_TOKEN reaches the publish step",
  ],
  [
    "a job-scope token",
    (_doc, job) => (job.env = { NODE_AUTH_TOKEN: TOKEN_EXPRESSION }),
    "NODE_AUTH_TOKEN reaches the publish step",
  ],
  [
    "a step-scope token",
    (_doc, job) => (job.steps.at(-1).env.NODE_AUTH_TOKEN = TOKEN_EXPRESSION),
    "NODE_AUTH_TOKEN reaches the publish step",
  ],
  [
    "a removed publish job",
    (doc) => {
      doc.jobs = Object.fromEntries(
        Object.entries(doc.jobs).filter(([name]) => name !== PUBLISH_JOB),
      );
    },
    "publish job is missing",
  ],
];

describe("npm trusted publishing binding", () => {
  it("accepts the live release workflow", () => {
    // ADR-0130 D1/D4: the tokenless job configuration is what evidences the OIDC auth path — the
    // publish attestation does not, since `--provenance` is added wherever the OIDC variables exist.
    expect(bindingFailures(workflow)).toEqual([]);

    const publishStep = workflow.jobs[PUBLISH_JOB].steps.find((step) => step.name === PUBLISH_STEP);
    expect(publishStep?.run).toContain("npm run release:publish");
  });

  it.each(WEAKENED_VARIANTS)("rejects %s", (_label, mutate, expected) => {
    expect(bindingFailures(weakened(mutate))).toContain(expected);
  });

  it("leaves the classic registry secret unconsumed by every workflow", () => {
    // ADR-0130 D4's retirement follow-up: the `NPM_TOKEN` Actions secret was deleted once trusted
    // publishing worked. A workflow that starts reading it again reintroduces exactly the
    // long-lived-credential exposure this decision removed.
    const consumers = readdirSync(workflowsDir)
      .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
      .filter((entry) =>
        /secrets\.NPM_TOKEN/u.test(readFileSync(join(workflowsDir, entry), "utf8")),
      );

    expect(consumers).toEqual([]);
  });
});
