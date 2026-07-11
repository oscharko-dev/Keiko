import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const workflow = readFileSync(resolve(repoRoot, ".github/workflows/osv-scanner.yml"), "utf8");

const OSV_SCANNER_RELEASE_SHA = "9a498708959aeaef5ef730655706c5a1df1edbc2";

describe("OSV Scanner workflow", () => {
  it("emits a scan for every pull request targeting dev", () => {
    const pullRequestBlock = workflow.match(/pull_request:\n([\s\S]*?)(?= {2}push:)/u)?.[1] ?? "";
    expect(pullRequestBlock).toMatch(/branches:\n\s+- dev/u);
    expect(pullRequestBlock).not.toContain("paths:");
    expect(pullRequestBlock).not.toContain("feat/");
    expect(pullRequestBlock).not.toContain("release/");
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
