import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const workflow = readFileSync(resolve(repoRoot, ".github/workflows/osv-scanner.yml"), "utf8");

const OSV_SCANNER_RELEASE_SHA = "9a498708959aeaef5ef730655706c5a1df1edbc2";
const ci = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
// ADR-0159: the pull-request and merge-queue executions of this scan moved into the single required
// `workflow hygiene` context. The branch-coverage property below did not move with them - it is
// asserted against whichever workflow now owns each event.
const hygiene = readFileSync(resolve(repoRoot, ".github/workflows/workflow-hygiene.yml"), "utf8");

// Branch targets the npm audit gates run on. Since those gates scope to `--omit=dev` (#2696), this
// scan is the ONLY vulnerability coverage build-time dependencies get, so it has to reach every
// target they do — leaving release/** or an integration branch out means shipping a release
// candidate whose tooling was never scanned at all.
function branchList(source, event, label) {
  const block = new RegExp(`\\n {2}${event}:\\n {4}branches:\\n((?: {6}- .*\\n)+)`, "u").exec(
    source,
  );
  if (block === null) throw new Error(`${label} ${event} branch list not found`);
  return block[1]
    .split("\n")
    .map((line) =>
      line
        .replace(/^ {6}- /u, "")
        .trim()
        .replace(/^"|"$/gu, ""),
    )
    .filter((entry) => entry.length > 0);
}

describe("OSV Scanner workflow", () => {
  it("always emits a scan for pull requests targeting dev", () => {
    // Relocated to the bundled context, which is where the pull-request execution lives now. The
    // `ready_for_review` type is the reason the bundle owns its own workflow file: ci.yml takes
    // GitHub's default types, so hosting the job there would have dropped this trigger entirely.
    expect(hygiene).toMatch(/pull_request:\n\s+branches:\n\s+- dev/u);
    expect(hygiene).toMatch(
      /types:\n\s+- opened\n\s+- ready_for_review\n\s+- reopened\n\s+- synchronize/u,
    );
    expect(hygiene).not.toMatch(/pull_request:[\s\S]*?paths:/u);
    // And it is gone from here rather than running twice.
    expect(workflow).not.toMatch(/\n {2}pull_request:/u);
  });

  // Replaces an earlier pin that asserted the scan stayed dev-only. That held while `npm audit`
  // still covered devDependencies; with the audit gates scoped to the shipped graph, a branch this
  // scan skips has NO dependency coverage. The pin now enforces the stronger property.
  // Each event is checked against its OWN list: a branch present under `push` must not satisfy the
  // `pull_request` expectation, which a whole-document search would have allowed.
  // Unchanged property, re-pointed at its owner: since ADR-0159 both event-driven lanes belong to
  // the bundled context. A branch it skips has NO dependency coverage, which is what makes this
  // stricter than "scans dev". The `push` case is also the only thing standing between a tidy-up and
  // a hung release: `workflow hygiene` is a RELEASE_REQUIRED_CHECKS entry, and
  // verify-release-required-checks.mjs reads it off a release commit - evidence only a push run
  // produces.
  it.each([
    { event: "pull_request", owner: "workflow-hygiene.yml", source: hygiene },
    { event: "push", owner: "workflow-hygiene.yml", source: hygiene },
  ])("covers every $event target the audit gates run on", ({ event, owner, source }) => {
    const expected = branchList(ci, event, "ci.yml");
    const actual = branchList(source, event, owner);
    expect(expected).toContain("dev");
    expect(expected.length).toBeGreaterThan(1);
    for (const branch of expected) expect(actual).toContain(branch);
  });

  it("keeps exactly the lane an event-driven workflow cannot replace", () => {
    // `schedule` re-reads a live vulnerability database against an unchanged tree, so a newly
    // published advisory is found without anyone pushing. Every event-driven lane moved to the
    // bundled context, whose push branch list is byte-identical - running both would scan every
    // pushed commit twice, which is the duplication ADR-0158's charter exists to remove.
    expect(() => branchList(workflow, "push", "osv-scanner.yml")).toThrow();
    expect(() => branchList(workflow, "pull_request", "osv-scanner.yml")).toThrow();
    expect(workflow).toContain('cron: "37 3 * * *"');
  });

  it("validates merge-queue groups like the audit gates do", () => {
    expect(branchList(hygiene, "merge_group", "workflow-hygiene.yml")).toEqual(
      branchList(ci, "merge_group", "ci.yml"),
    );
  });

  it("scans every dev push without a path filter", () => {
    expect(hygiene).toMatch(/push:\n\s+branches:\n\s+- dev/u);
    expect(hygiene).not.toMatch(/push:[\s\S]*?paths:/u);
  });

  it("runs daily and supports a manual scan", () => {
    expect(workflow).toContain('cron: "37 3 * * *"');
    expect(workflow).toMatch(/workflow_dispatch:\s*\n/u);
  });

  it.each([
    { lane: "scheduled and push", source: workflow },
    { lane: "pull request", source: hygiene },
  ])("uses the verified OSV Scanner release commit on the $lane lane", ({ source }) => {
    expect(source).toContain(
      `google/osv-scanner-action/osv-scanner-action@${OSV_SCANNER_RELEASE_SHA}`,
    );
    expect(source).not.toContain("continue-on-error: true");
  });

  it("uses read-only repository permissions and disables checkout credentials", () => {
    expect(workflow).toMatch(/permissions:\s*\{\}/u);
    expect(workflow).toMatch(/permissions:\s*\n\s+contents: read/u);
    expect(workflow).toContain("persist-credentials: false");
  });
});
