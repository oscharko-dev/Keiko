import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  validateExternalQualitySources,
  loadExternalQualitySources,
} from "../check-external-quality-config.mjs";
import { FOLLOWERS, REFERENCE, readBranchList } from "../check-workflow-branch-parity.mjs";

const branch = "codex/epic-anti-slop-quality";
const root = resolve(import.meta.dirname, "../..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const ci = parse(read(".github/workflows/ci.yml"));
const prScope = `(github.base_ref == 'dev' || github.base_ref == '${branch}')`;
const scanScope = `github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && ${prScope}) || (github.event_name == 'push' && github.ref == 'refs/heads/dev')`;

function step(name) {
  const result = ci.jobs["coverage-sonar"].steps.find((candidate) => candidate.name === name);
  expect(result, name).toBeDefined();
  return result;
}

describe("#3915 exact epic delivery path", () => {
  it.each([REFERENCE, ...FOLLOWERS])(
    "registers the exact branch in $file",
    ({ file, triggers }) => {
      for (const trigger of triggers) {
        expect(readBranchList(read(`.github/workflows/${file}`), trigger)).toContain(branch);
      }
    },
  );

  it.each([
    ["refs/heads/dev", "", 0],
    [`refs/heads/${branch}`, "", 0],
    ["refs/pull/1/merge", "dev", 0],
    ["refs/pull/1/merge", branch, 0],
    ["refs/pull/1/merge", `${branch}-unaccepted`, 1],
    [`refs/heads/${branch}-unaccepted`, "", 1],
  ])("checks actual protected-branch shell for %s:%s", (ref, base, status) => {
    const command = ci.jobs["protected-branch-gate"].steps[0].run;
    const result = spawnSync("bash", ["-c", command], {
      env: { ...process.env, GITHUB_REF: ref, GITHUB_BASE_REF: base },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(status);
  });

  it.each([
    "Resolve project version for SonarCloud",
    "Restore the pinned Sonar Scanner CLI archive",
    "Download Sonar Scanner CLI",
    "SonarCloud CI-based analysis (ADR-0131 / ADR-0134)",
  ])("executes %s for exact epic PRs with unchanged dispatch/dev semantics", (name) => {
    expect(step(name).if).toBe(`\${{ ${scanScope} }}`);
  });

  it.each([
    "Verify changed production sources are mapped into LCOV",
    "Verify SonarCloud Banking Grade PR evidence",
  ])("requires %s on exact epic PRs", (name) => {
    expect(step(name).if).toBe(`\${{ github.event_name == 'pull_request' && ${prScope} }}`);
  });

  it("runs zizmor for the exact epic while retaining existing events and failure reporting", () => {
    const hygiene = parse(read(".github/workflows/workflow-hygiene.yml"));
    const zizmor = hygiene.jobs["workflow-hygiene"].steps.find(
      (candidate) => candidate.name === "Run zizmor",
    );
    expect(zizmor.if).toBe(
      `\${{ !cancelled() && steps.checkout.outcome != 'failure' && ((github.event_name == 'pull_request' && ${prScope}) || (github.event_name == 'push' && (github.ref == 'refs/heads/dev' || github.ref == 'refs/heads/${branch}')) || github.event_name == 'merge_group') }}`,
    );
  });

  it("requires automatic child review without changing the remaining semantic policy", () => {
    const sources = loadExternalQualitySources(root);
    const config = parse(sources.codeRabbitConfig);
    expect(config.reviews.auto_review.base_branches).toEqual(["dev", branch]);
    expect(validateExternalQualitySources(sources)).toEqual([]);
    const missing = sources.codeRabbitConfig.replace(`      - "${branch}"\n`, "");
    expect(validateExternalQualitySources({ ...sources, codeRabbitConfig: missing })).toContain(
      "CodeRabbit semantic review policy must match the reviewed configuration",
    );
  });
});
