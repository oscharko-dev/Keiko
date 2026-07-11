import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const workflow = readFileSync(resolve(repoRoot, ".github/workflows/osv-scanner.yml"), "utf8");

const OSV_SCANNER_RELEASE_SHA = "9a498708959aeaef5ef730655706c5a1df1edbc2";

function readEventBlock(eventName) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${eventName}:`);

  if (start === -1) {
    return "";
  }

  const end = lines.findIndex(
    (line, index) => index > start && (/^ {2}[a-z_]+:/u.test(line) || line === "jobs:"),
  );

  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

describe("OSV Scanner workflow", () => {
  it("reports the required scan status on pull requests and protected branch pushes", () => {
    const pullRequestBlock = readEventBlock("pull_request");
    const pushBlock = readEventBlock("push");

    expect(pullRequestBlock).toContain("branches:");
    expect(pushBlock).toContain("branches:");
    expect(pullRequestBlock).not.toContain("paths:");
    expect(pushBlock).not.toContain("paths:");
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
