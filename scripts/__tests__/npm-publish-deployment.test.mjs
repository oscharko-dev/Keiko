// Regression coverage for scripts/lib/npm-publish-deployment.mjs (issue #3252): the
// GitHub Deployment record a `latest` npm publish must carry so the Deployments panel never
// falls behind npm `latest` again the way 0.3.12-0.3.15 did through the governed-container path.
// This module is BRAND NEW — there is no prior recording behaviour to regress-test against;
// every scenario below proves the new recorder classifies and acts on its case correctly.

import { describe, expect, it } from "vitest";

import {
  recordNpmPublishDeployment,
  runsInsideActionsPublishJob,
} from "../lib/npm-publish-deployment.mjs";

const REPOSITORY = "oscharko-dev/Keiko";
const PKG = { name: "@oscharko-dev/keiko", version: "0.3.15" };
const FIXED_NOW = () => new Date("2026-08-22T10:00:00.000Z");
const EXPECTED_DESCRIPTION =
  "governed-container npm publish of @oscharko-dev/keiko@0.3.15 " +
  "(registry publish time 2026-08-22T10:00:00.000Z; dist-tag latest)";
const CREATE_DEPLOYMENT_PATH = "repos/oscharko-dev/Keiko/deployments";

function noopLog() {
  // Tests assert on return values and captured calls, not console output.
}

// `gh api repos/.../deployments` (a GET listing) puts the path at args[1]; a POST such as
// `gh api --method POST repos/.../deployments --input -` puts it at args[3]. Reading through
// this once keeps every dispatcher below shape-agnostic instead of hardcoding an index.
function pathOf(args) {
  return args[1] === "--method" ? args[3] : args[1];
}

function baseArgs(overrides = {}) {
  return {
    dryRun: false,
    env: {},
    log: noopLog,
    now: FIXED_NOW,
    pkg: PKG,
    planOnly: false,
    repository: REPOSITORY,
    tag: "latest",
    ...overrides,
  };
}

describe("runsInsideActionsPublishJob", () => {
  it("is true only for Actions AND the publish job id together", () => {
    expect(runsInsideActionsPublishJob({ GITHUB_ACTIONS: "true", GITHUB_JOB: "publish" })).toBe(
      true,
    );
    expect(
      runsInsideActionsPublishJob({ GITHUB_ACTIONS: "true", GITHUB_JOB: "release-verify" }),
    ).toBe(false);
    expect(runsInsideActionsPublishJob({ GITHUB_JOB: "publish" })).toBe(false);
    expect(runsInsideActionsPublishJob({})).toBe(false);
  });
});

describe("recordNpmPublishDeployment", () => {
  it("skips when running inside the Actions publish job — GitHub already deploys that job", () => {
    const spawnGh = () => {
      throw new Error("gh must not run inside the Actions publish job");
    };
    const result = recordNpmPublishDeployment(
      baseArgs({ env: { GITHUB_ACTIONS: "true", GITHUB_JOB: "publish" }, spawnGh }),
    );
    expect(result).toEqual({ kind: "skipped", reason: expect.stringContaining("Actions") });
  });

  it("skips on plan-only", () => {
    const spawnGh = () => {
      throw new Error("gh must not run on a plan-only publish");
    };
    const result = recordNpmPublishDeployment(baseArgs({ planOnly: true, spawnGh }));
    expect(result.kind).toBe("skipped");
  });

  it("skips on a dry run", () => {
    const spawnGh = () => {
      throw new Error("gh must not run on a dry run");
    };
    const result = recordNpmPublishDeployment(baseArgs({ dryRun: true, spawnGh }));
    expect(result.kind).toBe("skipped");
  });

  it("skips for any non-latest dist-tag", () => {
    const spawnGh = () => {
      throw new Error("gh must not run for a non-latest publish");
    };
    const result = recordNpmPublishDeployment(baseArgs({ spawnGh, tag: "beta" }));
    expect(result.kind).toBe("skipped");
  });

  it("creates the deployment and a success status with the exact documented shape", () => {
    const calls = [];
    const spawnGh = (args, options) => {
      calls.push({ args, input: options?.input });
      const path = pathOf(args);
      if (path?.startsWith(`${CREATE_DEPLOYMENT_PATH}?`)) return { status: 0, stdout: "[]" };
      if (path === CREATE_DEPLOYMENT_PATH) return { status: 0, stdout: JSON.stringify({ id: 42 }) };
      if (path === `${CREATE_DEPLOYMENT_PATH}/42/statuses`) {
        return { status: 0, stdout: JSON.stringify({ id: 1 }) };
      }
      throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
    };

    const result = recordNpmPublishDeployment(baseArgs({ spawnGh }));
    expect(result).toEqual({ deploymentId: 42, kind: "recorded" });

    const create = calls.find((call) => pathOf(call.args) === CREATE_DEPLOYMENT_PATH);
    expect(create.args).toEqual([
      "api",
      "--method",
      "POST",
      CREATE_DEPLOYMENT_PATH,
      "--input",
      "-",
    ]);
    expect(JSON.parse(create.input)).toEqual({
      auto_merge: false,
      description: EXPECTED_DESCRIPTION,
      environment: "npm-publish",
      ref: "v0.3.15",
      required_contexts: [],
      task: "deploy",
    });

    const status = calls.find(
      (call) => pathOf(call.args) === `${CREATE_DEPLOYMENT_PATH}/42/statuses`,
    );
    expect(status.args).toEqual([
      "api",
      "--method",
      "POST",
      `${CREATE_DEPLOYMENT_PATH}/42/statuses`,
      "--input",
      "-",
    ]);
    expect(JSON.parse(status.input)).toEqual({
      description: EXPECTED_DESCRIPTION,
      environment: "npm-publish",
      environment_url: "https://www.npmjs.com/package/@oscharko-dev/keiko/v/0.3.15",
      state: "success",
    });
  });

  it("labels the description GitHub Actions when GITHUB_ACTIONS=true but the job is not publish", () => {
    const calls = [];
    const spawnGh = (args, options) => {
      calls.push({ args, input: options?.input });
      const path = pathOf(args);
      if (path?.startsWith(`${CREATE_DEPLOYMENT_PATH}?`)) return { status: 0, stdout: "[]" };
      if (path === CREATE_DEPLOYMENT_PATH) return { status: 0, stdout: JSON.stringify({ id: 7 }) };
      return { status: 0, stdout: JSON.stringify({ id: 1 }) };
    };
    recordNpmPublishDeployment(
      baseArgs({ env: { GITHUB_ACTIONS: "true", GITHUB_JOB: "release-verify" }, spawnGh }),
    );
    const create = calls.find((call) => pathOf(call.args) === CREATE_DEPLOYMENT_PATH);
    expect(JSON.parse(create.input).description).toContain("GitHub Actions npm publish of");
  });

  it("is idempotent: does not create a second deployment when one already succeeded for this ref", () => {
    const calls = [];
    const spawnGh = (args, options) => {
      calls.push({ args, input: options?.input });
      const path = pathOf(args);
      if (path?.startsWith(`${CREATE_DEPLOYMENT_PATH}?`)) {
        return { status: 0, stdout: JSON.stringify([{ id: 99 }]) };
      }
      if (path === `${CREATE_DEPLOYMENT_PATH}/99/statuses`) {
        return { status: 0, stdout: JSON.stringify([{ state: "success" }]) };
      }
      throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
    };

    const result = recordNpmPublishDeployment(baseArgs({ spawnGh }));
    expect(result).toEqual({ kind: "already-recorded" });
    expect(calls.some((call) => call.args.includes("POST"))).toBe(false);
  });

  it("creates a fresh deployment when an existing one for the ref never reached success", () => {
    const spawnGh = (args) => {
      const path = pathOf(args);
      if (path?.startsWith(`${CREATE_DEPLOYMENT_PATH}?`)) {
        return { status: 0, stdout: JSON.stringify([{ id: 99 }]) };
      }
      if (path === `${CREATE_DEPLOYMENT_PATH}/99/statuses`) {
        return { status: 0, stdout: JSON.stringify([{ state: "pending" }]) };
      }
      if (path === CREATE_DEPLOYMENT_PATH)
        return { status: 0, stdout: JSON.stringify({ id: 100 }) };
      if (path === `${CREATE_DEPLOYMENT_PATH}/100/statuses`) {
        return { status: 0, stdout: JSON.stringify({ id: 1 }) };
      }
      throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
    };

    const result = recordNpmPublishDeployment(baseArgs({ spawnGh }));
    expect(result).toEqual({ deploymentId: 100, kind: "recorded" });
  });

  it("fails closed, naming deployments:write, when creating the deployment is refused with 403", () => {
    const spawnGh = (args) => {
      const path = pathOf(args);
      if (path?.startsWith(`${CREATE_DEPLOYMENT_PATH}?`)) return { status: 0, stdout: "[]" };
      return { status: 1, stderr: "HTTP 403: Resource not accessible by integration", stdout: "" };
    };
    const result = recordNpmPublishDeployment(baseArgs({ spawnGh }));
    expect(result.kind).toBe("failed");
    expect(result.failure).toContain("deployments:write");
    expect(result.failure).toContain("published but");
  });

  it("fails closed when the deployments endpoint is not found (404)", () => {
    const spawnGh = (args) => {
      const path = pathOf(args);
      if (path?.startsWith(`${CREATE_DEPLOYMENT_PATH}?`)) return { status: 0, stdout: "[]" };
      return { status: 1, stderr: "HTTP 404: Not Found", stdout: "" };
    };
    const result = recordNpmPublishDeployment(baseArgs({ spawnGh }));
    expect(result.kind).toBe("failed");
    expect(result.failure).toContain("deployments:write");
  });

  it("fails closed when the success status write is refused after the deployment was created", () => {
    const spawnGh = (args) => {
      const path = pathOf(args);
      if (path?.startsWith(`${CREATE_DEPLOYMENT_PATH}?`)) return { status: 0, stdout: "[]" };
      if (path === CREATE_DEPLOYMENT_PATH) return { status: 0, stdout: JSON.stringify({ id: 42 }) };
      return { status: 1, stderr: "HTTP 403: Resource not accessible by integration", stdout: "" };
    };
    const result = recordNpmPublishDeployment(baseArgs({ spawnGh }));
    expect(result.kind).toBe("failed");
    expect(result.failure).toContain("deployments:write");
    expect(result.failure).toContain("success status");
  });

  it("fails closed when the create response carries no deployment id", () => {
    const spawnGh = (args) => {
      const path = pathOf(args);
      if (path?.startsWith(`${CREATE_DEPLOYMENT_PATH}?`)) return { status: 0, stdout: "[]" };
      return { status: 0, stdout: JSON.stringify({}) };
    };
    const result = recordNpmPublishDeployment(baseArgs({ spawnGh }));
    expect(result).toEqual({
      failure: "published but the GitHub deployment response carried no deployment id.",
      kind: "failed",
    });
  });

  it("proceeds to create when the idempotency listing itself errors, rather than blocking on it", () => {
    const spawnGh = (args) => {
      const path = pathOf(args);
      if (path?.startsWith(`${CREATE_DEPLOYMENT_PATH}?`))
        return { error: new Error("spawn gh ENOENT") };
      if (path === CREATE_DEPLOYMENT_PATH) return { status: 0, stdout: JSON.stringify({ id: 5 }) };
      return { status: 0, stdout: JSON.stringify({ id: 1 }) };
    };
    const result = recordNpmPublishDeployment(baseArgs({ spawnGh }));
    expect(result).toEqual({ deploymentId: 5, kind: "recorded" });
  });

  it("logs an empty listing-failure detail, without throwing, when the listing gh call returns no result at all", () => {
    const logCalls = [];
    const spawnGh = (args) => {
      const path = pathOf(args);
      if (path?.startsWith(`${CREATE_DEPLOYMENT_PATH}?`)) return undefined;
      if (path === CREATE_DEPLOYMENT_PATH) return { status: 0, stdout: JSON.stringify({ id: 8 }) };
      return { status: 0, stdout: JSON.stringify({ id: 1 }) };
    };
    const result = recordNpmPublishDeployment(
      baseArgs({ log: (message) => logCalls.push(message), spawnGh }),
    );
    expect(result).toEqual({ deploymentId: 8, kind: "recorded" });
    expect(logCalls[0]).toBe(
      "npm-publish-deployment: could not list existing deployments for v0.3.15 ().",
    );
  });

  it("fails closed with the documented invalid-JSON detail when gh reports success but returns no parsable body", () => {
    const spawnGh = (args) => {
      const path = pathOf(args);
      if (path?.startsWith(`${CREATE_DEPLOYMENT_PATH}?`)) return { status: 0, stdout: "[]" };
      if (path === CREATE_DEPLOYMENT_PATH) return { status: 0 };
      throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
    };
    const result = recordNpmPublishDeployment(baseArgs({ spawnGh }));
    expect(result).toEqual({
      failure:
        "published but the GitHub deployment record was refused while creating the deployment: " +
        "gh returned a response that was not valid JSON.. The token needs the deployments:write " +
        "permission on the npm-publish environment.",
      kind: "failed",
    });
    expect(result.failure).not.toContain("HTTP");
  });

  it("does not treat an existing deployment as successful when its statuses response is not an array", () => {
    const spawnGh = (args) => {
      const path = pathOf(args);
      if (path?.startsWith(`${CREATE_DEPLOYMENT_PATH}?`)) {
        return { status: 0, stdout: JSON.stringify([{ id: 99 }]) };
      }
      if (path === `${CREATE_DEPLOYMENT_PATH}/99/statuses`) {
        return { status: 0, stdout: JSON.stringify({}) };
      }
      if (path === CREATE_DEPLOYMENT_PATH)
        return { status: 0, stdout: JSON.stringify({ id: 100 }) };
      if (path === `${CREATE_DEPLOYMENT_PATH}/100/statuses`) {
        return { status: 0, stdout: JSON.stringify({ id: 1 }) };
      }
      throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
    };
    const result = recordNpmPublishDeployment(baseArgs({ spawnGh }));
    expect(result).toEqual({ deploymentId: 100, kind: "recorded" });
  });

  it("does not log a listing failure when the existing-deployments response parses but is not an array", () => {
    const logCalls = [];
    const spawnGh = (args) => {
      const path = pathOf(args);
      if (path?.startsWith(`${CREATE_DEPLOYMENT_PATH}?`)) {
        return { status: 0, stdout: JSON.stringify({ message: "no results field" }) };
      }
      if (path === CREATE_DEPLOYMENT_PATH) return { status: 0, stdout: JSON.stringify({ id: 55 }) };
      return { status: 0, stdout: JSON.stringify({ id: 1 }) };
    };
    const result = recordNpmPublishDeployment(
      baseArgs({ log: (message) => logCalls.push(message), spawnGh }),
    );
    expect(result).toEqual({ deploymentId: 55, kind: "recorded" });
    expect(logCalls).toEqual([
      "npm-publish-deployment: recorded npm-publish deployment 55 for v0.3.15.",
    ]);
  });

  it("fails closed when the create response body is not a record at all (e.g. an array)", () => {
    const spawnGh = (args) => {
      const path = pathOf(args);
      if (path?.startsWith(`${CREATE_DEPLOYMENT_PATH}?`)) return { status: 0, stdout: "[]" };
      if (path === CREATE_DEPLOYMENT_PATH) return { status: 0, stdout: JSON.stringify([1, 2, 3]) };
      throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
    };
    const result = recordNpmPublishDeployment(baseArgs({ spawnGh }));
    expect(result).toEqual({
      failure: "published but the GitHub deployment response carried no deployment id.",
      kind: "failed",
    });
  });

  it("uses the current time for the description when now is not provided", () => {
    const calls = [];
    const spawnGh = (args, options) => {
      calls.push({ args, input: options?.input });
      const path = pathOf(args);
      if (path?.startsWith(`${CREATE_DEPLOYMENT_PATH}?`)) return { status: 0, stdout: "[]" };
      if (path === CREATE_DEPLOYMENT_PATH) return { status: 0, stdout: JSON.stringify({ id: 9 }) };
      return { status: 0, stdout: JSON.stringify({ id: 1 }) };
    };
    const before = Date.now();
    const result = recordNpmPublishDeployment({
      dryRun: false,
      env: {},
      log: noopLog,
      pkg: PKG,
      planOnly: false,
      repository: REPOSITORY,
      spawnGh,
      tag: "latest",
    });
    const after = Date.now();
    expect(result).toEqual({ deploymentId: 9, kind: "recorded" });

    const create = calls.find((call) => pathOf(call.args) === CREATE_DEPLOYMENT_PATH);
    const { description } = JSON.parse(create.input);
    const match = /registry publish time (\S+); dist-tag latest\)/u.exec(description);
    expect(match).not.toBeNull();
    const [, npmPublishTimeIso] = match;
    expect(new Date(npmPublishTimeIso).toISOString()).toBe(npmPublishTimeIso);
    const parsedMs = Date.parse(npmPublishTimeIso);
    expect(parsedMs).toBeGreaterThanOrEqual(before);
    expect(parsedMs).toBeLessThanOrEqual(after);
  });
});
