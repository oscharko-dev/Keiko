import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// GITHUB_TOKEN carries only the permissions a job declares, and GitHub's permission data for
// installation tokens requires attestations:read to list attestations and deployments:read to list
// deployments. release-publish.mjs does both after the npm-publish approval: `gh attestation verify`
// for the Windows setup companion once the GitHub release exists, and the alignment gate after npm
// already holds the release. No publish job ran after either call became reachable, so neither grant
// was ever exercised; reading the job against the publisher found both missing on 2026-09-14.

const workflow = parse(readFileSync(".github/workflows/release.yml", "utf8"));
const publisher = readFileSync("scripts/release-publish.mjs", "utf8");
const alignment = readFileSync("scripts/check-release-alignment.mjs", "utf8");

describe("release publish job token", () => {
  it("still makes the two reads the grants below exist for", () => {
    expect(publisher).toMatch(/"attestation",\s*"verify"/u);
    expect(publisher).toContain("checkReleaseAlignment(");
    expect(alignment).toMatch(/\/deployments\?environment=/u);
  });

  it("grants exactly what the publish path uses", () => {
    expect(workflow.jobs.publish.permissions).toEqual({
      actions: "read",
      attestations: "read",
      checks: "read",
      contents: "write",
      deployments: "read",
      "id-token": "write",
      statuses: "read",
    });
  });
});
