import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { impliedSuccessTraps } from "../lib/workflow-trigger-scenarios.mjs";

// #3505 and ADR-0177 D9 (Epic #3495). The release button is the human authorization: an allowlisted
// owner dispatches release.yml on dev, and only that owner's dispatch may start the request job. The
// publish on the tag arrives either from that owner directly or from release-advance.yml, whose
// workflow-token dispatch GitHub attributes to github-actions[bot]; authorize accepts the bot only for
// a commit an owner requested (release-automation.test.mjs proves that refusal in-process). Every
// other bot and every account outside the allowlist is refused before any job with credentials runs.

const releaseYmlPath = fileURLToPath(
  new URL("../../.github/workflows/release.yml", import.meta.url),
);
const release = parse(readFileSync(releaseYmlPath, "utf8"));
const { authorize, publish, request } = release.jobs;

function normalized(expression) {
  return expression.replace(/\s+/gu, " ").trim();
}

const OWNER_GUARD =
  "!endsWith(github.triggering_actor, '[bot]') && contains(fromJSON(vars.KEIKO_RELEASE_OWNER_GITHUB_LOGINS), github.triggering_actor)";

// Evaluates the parsed button guard for one actor, after proving the expression has exactly the shape
// this evaluator models: a drifted expression fails here instead of being evaluated as if it matched.
function buttonAccepts(triggeringActor, ownerLogins) {
  if (!normalized(request.if).endsWith(`&& ${OWNER_GUARD}`)) {
    throw new TypeError("the request job's actor guard has an unsupported shape");
  }
  return !triggeringActor.endsWith("[bot]") && JSON.parse(ownerLogins).includes(triggeringActor);
}

describe("release dispatch guard (#3505, ADR-0177 D9)", () => {
  it("is started only by workflow_dispatch, with no input an operator must supply", () => {
    expect(release.on).toStrictEqual({ workflow_dispatch: null });
  });

  it("runs the button only on dev and the publish only on a v* tag", () => {
    expect(request.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(request.if).toContain("github.ref == 'refs/heads/dev'");
    expect(authorize.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(authorize.if).toContain("startsWith(github.ref, 'refs/tags/v')");
    expect(publish.if).toContain("startsWith(github.ref, 'refs/tags/v')");
  });

  it("refuses every bot at the button, the automation included", () => {
    expect(request.if).toMatch(/!\s*endsWith\(\s*github\.triggering_actor\s*,\s*'\[bot\]'\s*\)/u);
    expect(request.if).not.toContain("github-actions[bot]'");
  });

  it("requires exact JSON-array membership in KEIKO_RELEASE_OWNER_GITHUB_LOGINS at the button", () => {
    expect(request.if).toMatch(
      /contains\(\s*fromJSON\(vars\.KEIKO_RELEASE_OWNER_GITHUB_LOGINS\)\s*,\s*github\.triggering_actor\s*\)/u,
    );
  });

  it("decides who may publish in exactly one tested place, with no spoofable bot comparison", () => {
    // zizmor's bot-conditions audit: an `if:` that compares an actor with a bot login is spoofable on
    // some triggers. authorize compares nothing; releaseAuthorizePlan() decides, and
    // release-automation.test.mjs proves every accepted and refused actor.
    expect(normalized(authorize.if)).toBe(
      "github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/tags/v')",
    );
    expect(JSON.stringify(release.jobs)).not.toMatch(/triggering_actor ==|actor ==/u);
  });

  it.each([
    ["a human owner", "oscharko", '["oscharko"]', true],
    ["the release automation", "github-actions[bot]", '["oscharko"]', false],
    [
      "the automation smuggled into the allowlist",
      "github-actions[bot]",
      '["github-actions[bot]"]',
      false,
    ],
    ["another bot", "dependabot[bot]", '["oscharko"]', false],
    ["a human outside the allowlist", "contributor", '["oscharko"]', false],
    ["a substring login", "osch", '["oscharko"]', false],
  ])(
    "enforces the parsed button guard for %s",
    (_label, triggeringActor, ownerLogins, expected) => {
      expect(buttonAccepts(triggeringActor, ownerLogins)).toBe(expected);
    },
  );

  it("verifies the owner request in authorize before any credential is reachable", () => {
    const step = authorize.steps.find((entry) => entry.id === "authorize");
    expect(step.run).toBe("node scripts/release-authorize.mjs");
    expect(step.env).toMatchObject({
      KEIKO_RELEASE_OWNER_GITHUB_LOGINS: "${{ vars.KEIKO_RELEASE_OWNER_GITHUB_LOGINS }}",
      TRIGGERING_ACTOR: "${{ github.triggering_actor }}",
    });
    expect(authorize.environment).toBeUndefined();
    expect(authorize.permissions).toStrictEqual({ actions: "read", contents: "read" });
    expect(JSON.stringify(authorize)).not.toMatch(/secrets\./u);
  });

  it("starts the publish only after authorization and macOS qualification succeeded", () => {
    expect(publish.needs).toStrictEqual(["authorize", "qualify-customer-shape"]);
    expect(normalized(publish.if)).toBe(
      "${{ !cancelled() && needs.authorize.result == 'success' && needs.qualify-customer-shape.result == 'success' && startsWith(github.ref, 'refs/tags/v') }}",
    );
    expect(impliedSuccessTraps(release)).toStrictEqual([]);
  });

  it("keeps release credentials scoped to the npm-publish environment", () => {
    expect(publish.environment).toBe("npm-publish");
    expect(request.environment).toBe("release-tagging");
    expect(JSON.stringify(request)).not.toMatch(/KEIKO_PORTABLE_RELEASE_SIGNING_KEY/u);
  });
});
