import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const workflow = readFileSync(resolve(repoRoot, ".github/workflows/osv-scanner.yml"), "utf8");

const OSV_SCANNER_RELEASE_SHA = "9a498708959aeaef5ef730655706c5a1df1edbc2";
const ci = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");

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
    expect(workflow).toMatch(/pull_request:\n\s+branches:\n\s+- dev/u);
    expect(workflow).toMatch(
      /types:\n\s+- opened\n\s+- ready_for_review\n\s+- reopened\n\s+- synchronize/u,
    );
    expect(workflow).not.toMatch(/pull_request:[\s\S]*?paths:/u);
  });

  // Replaces an earlier pin that asserted the scan stayed dev-only. That held while `npm audit`
  // still covered devDependencies; with the audit gates scoped to the shipped graph, a branch this
  // scan skips has NO dependency coverage. The pin now enforces the stronger property.
  // Each event is checked against its OWN list: a branch present under `push` must not satisfy the
  // `pull_request` expectation, which a whole-document search would have allowed.
  it.each(["pull_request", "push"])("covers every %s target the audit gates run on", (event) => {
    const expected = branchList(ci, event, "ci.yml");
    const actual = branchList(workflow, event, "osv-scanner.yml");
    expect(expected).toContain("dev");
    expect(expected.length).toBeGreaterThan(1);
    for (const branch of expected) expect(actual).toContain(branch);
  });

  it("validates merge-queue groups like the audit gates do", () => {
    expect(branchList(workflow, "merge_group", "osv-scanner.yml")).toEqual(
      branchList(ci, "merge_group", "ci.yml"),
    );
  });

  it("scans every dev push without a path filter", () => {
    expect(workflow).toMatch(/push:\n\s+branches:\n\s+- dev/u);
    expect(workflow).not.toMatch(/push:[\s\S]*?paths:/u);
  });

  it("runs daily and supports a manual scan", () => {
    expect(workflow).toContain('cron: "37 3 * * *"');
    expect(workflow).toMatch(/workflow_dispatch:\s*\n/u);
  });

  it("uses the verified OSV Scanner release commit and fails on vulnerabilities", () => {
    expect(workflow).toContain(
      `google/osv-scanner-action/osv-scanner-action@${OSV_SCANNER_RELEASE_SHA}`,
    );
    expect(workflow).not.toContain("continue-on-error: true");
  });

  it("uses read-only repository permissions and disables checkout credentials", () => {
    expect(workflow).toMatch(/permissions:\s*\{\}/u);
    expect(workflow).toMatch(/permissions:\s*\n\s+contents: read/u);
    expect(workflow).toContain("persist-credentials: false");
  });
});
