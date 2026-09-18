import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  carriesExplicitStatusFunction,
  impliedSuccessTraps,
} from "../lib/workflow-trigger-scenarios.mjs";

const releaseYmlPath = fileURLToPath(
  new URL("../../.github/workflows/release.yml", import.meta.url),
);
const release = parse(readFileSync(releaseYmlPath, "utf8"));
const publish = release.jobs.publish;

function normalizedPublishCondition() {
  return publish.if.replace(/\s+/gu, " ").trim();
}

function evaluateParsedActorGuard(triggeringActor, serializedOwnerLogins) {
  const condition = normalizedPublishCondition();
  const actorGuard = condition.match(
    /!endsWith\(github\.triggering_actor, '(?<botSuffix>\[bot\])'\) && contains\(fromJSON\(vars\.KEIKO_RELEASE_OWNER_GITHUB_LOGINS\), github\.triggering_actor\)$/u,
  );
  if (actorGuard?.groups?.botSuffix === undefined) {
    throw new TypeError("release workflow actor guard has an unsupported shape");
  }
  const ownerLogins = JSON.parse(serializedOwnerLogins);
  if (!Array.isArray(ownerLogins)) throw new TypeError("release owner allowlist is not an array");
  return (
    !triggeringActor.endsWith(actorGuard.groups.botSuffix) && ownerLogins.includes(triggeringActor)
  );
}

describe("release publish dispatch guard (#3505, Epic #3495)", () => {
  it("has no tag-push or workflow-owned automatic publish trigger", () => {
    expect(release.on).toStrictEqual({ workflow_dispatch: expect.any(Object) });
  });

  it("has an if: expression on the publish job", () => {
    expect(typeof publish.if).toBe("string");
    expect(publish.if.length).toBeGreaterThan(0);
  });

  it("gates the publish job on workflow_dispatch, publish input, and a v* tag", () => {
    expect(publish.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(publish.if).toContain("inputs.publish");
    expect(publish.if).toContain("startsWith(github.ref, 'refs/tags/v')");
  });

  it("refuses any dispatch from a bot account (github.triggering_actor ends with [bot])", () => {
    // The refusal is expressed as `!endsWith(github.triggering_actor, '[bot]')`. The double-quoted
    // form is what YAML preserves; the workflow author wrote it as-is.
    expect(publish.if).toMatch(/!\s*endsWith\(\s*github\.triggering_actor\s*,\s*'\[bot\]'\s*\)/u);
  });

  it("requires exact JSON-array membership in KEIKO_RELEASE_OWNER_GITHUB_LOGINS", () => {
    expect(publish.if).toMatch(
      /contains\(\s*fromJSON\(vars\.KEIKO_RELEASE_OWNER_GITHUB_LOGINS\)\s*,\s*github\.triggering_actor\s*\)/u,
    );
  });

  it.each([
    ["a human owner", "oscharko", '["oscharko"]', true],
    ["a GITHUB_TOKEN dispatch", "github-actions[bot]", '["github-actions[bot]"]', false],
    ["a bot-triggered rerun", "github-actions[bot]", '["oscharko"]', false],
    ["a human outside the allowlist", "contributor", '["oscharko"]', false],
    ["a substring login", "osch", '["oscharko"]', false],
  ])(
    "enforces the parsed workflow guard for %s",
    (_label, triggeringActor, ownerLogins, expected) => {
      expect(evaluateParsedActorGuard(triggeringActor, ownerLogins)).toBe(expected);
    },
  );

  it("keeps release credentials scoped to the npm-publish environment", () => {
    expect(publish.environment).toBe("npm-publish");
  });

  it("has no implicit-success trap: the publish job carries no needs: chain", () => {
    expect(publish.needs).toBeUndefined();
    // Cross-check: the whole release workflow's job graph is armoured against the
    // v1.0.0-class silent skip through implied success() (#3502).
    expect(impliedSuccessTraps(release)).toStrictEqual([]);
  });

  it("uses no explicit status function on the publish if (the whole expression is trigger-gating, not needs-gating)", () => {
    // Sanity check: the publish job has no `needs:`, so an explicit status function is
    // meaningless. This assertion documents why the #3502 trap detector does not flag it.
    expect(carriesExplicitStatusFunction(publish.if)).toBe(false);
  });
});
