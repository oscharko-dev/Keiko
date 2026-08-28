/**
 * The repository half of the npm Trusted Publisher binding (ADR-0130 D4/D5, issue #3088).
 *
 * npmjs.com stores the publisher entry as `repository + workflow BASENAME + environment` and never
 * re-validates it: renaming `release.yml`, renaming the `npm-publish` environment, dropping
 * `id-token: write`, moving the job to a self-hosted runner, wrapping it behind `workflow_call`, or
 * reintroducing a registry token into the publish step all leave CI green and break authentication
 * only at the registry, mid-release. The npm-side entry cannot be read from here, so this pins
 * every identifier the entry names on the side that IS readable — the ADR previously stated this
 * obligation in prose with no gate behind it.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/** The exact basename registered as the Trusted Publisher's workflow on npmjs.com. */
const TRUSTED_PUBLISHER_WORKFLOW = "release.yml";
/** The exact GitHub Actions environment the publisher entry is bound to. */
const TRUSTED_PUBLISHER_ENVIRONMENT = "npm-publish";
/** The job that runs `npm publish`; its name is local, its bindings are not. */
const PUBLISH_JOB = "publish";
const PUBLISH_STEP = "Publish package";

const workflowsDir = resolve(import.meta.dirname, "..", "..", ".github", "workflows");
const workflowPath = join(workflowsDir, TRUSTED_PUBLISHER_WORKFLOW);
const workflowSource = readFileSync(workflowPath, "utf8");
const workflow = parse(workflowSource);
const publishJob = workflow.jobs[PUBLISH_JOB];
const publishStep = publishJob.steps.find((step) => step.name === PUBLISH_STEP);

describe("npm trusted publishing binding", () => {
  it("keeps the publish job on the exact environment the npm publisher entry names", () => {
    // The environment binding is also the human-approval boundary (ADR-0170 D3): npm rejects the
    // OIDC token of any run that did not pass through `npm-publish`, so a dispatched workflow
    // variant that drops the environment cannot publish either.
    expect(publishJob.environment).toBe(TRUSTED_PUBLISHER_ENVIRONMENT);
  });

  it("keeps the OIDC exchange available to the publish job", () => {
    // Without `id-token: write` the npm CLI has no identity to exchange and falls straight back to
    // token auth — the ENEEDAUTH shape the 0.3.6 dispatch publish failed with.
    expect(publishJob.permissions["id-token"]).toBe("write");
  });

  it("publishes from a GitHub-hosted runner", () => {
    // Trusted publishing is unavailable on self-hosted runners; GitHub issues no OIDC identity
    // npm accepts there.
    expect(publishJob["runs-on"]).toBe("ubuntu-latest");
  });

  it("never wraps the publish job behind a reusable workflow", () => {
    // npm matches the OIDC claim against the registered basename. A `workflow_call` indirection
    // publishes under the caller's identity and stops matching the stored entry.
    expect(Object.keys(workflow.on)).not.toContain("workflow_call");
    expect(publishJob.uses).toBeUndefined();
    expect(Array.isArray(publishJob.steps)).toBe(true);
  });

  it("lets no registry token reach the publish step from any env scope", () => {
    // ADR-0130 D1: an unset NODE_AUTH_TOKEN/NPM_TOKEN is precisely what makes the npm CLI attempt
    // the OIDC exchange instead of writing an `_authToken` line, so a reintroduced token env var
    // silently returns the pipeline to classic-token publishing. A workflow-level or job-level
    // entry is inherited by the step exactly like a step-level one — and it can be fed by a secret
    // of any name, which the `secrets.NPM_TOKEN` scan below would never see (Codex finding on
    // #3299) — so all three scopes are checked, not just the step's own block.
    expect(publishStep).toBeDefined();
    expect(publishStep.run).toContain("npm run release:publish");

    const envScopes = [workflow.env, publishJob.env, ...publishJob.steps.map((step) => step.env)];
    const declared = envScopes.flatMap((scope) => Object.keys(scope ?? {}));

    expect(declared).not.toContain("NODE_AUTH_TOKEN");
    expect(declared).not.toContain("NPM_TOKEN");
  });

  it("leaves the classic registry secret unconsumed by every workflow", () => {
    // ADR-0130 D4's retirement follow-up: the standing `NPM_TOKEN` Actions secret has no consumer
    // once trusted publishing works. A workflow that starts reading it again reintroduces exactly
    // the long-lived-credential exposure this decision removed.
    const consumers = readdirSync(workflowsDir)
      .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
      .filter((entry) =>
        /secrets\.NPM_TOKEN/u.test(readFileSync(join(workflowsDir, entry), "utf8")),
      );

    expect(consumers).toEqual([]);
  });
});
