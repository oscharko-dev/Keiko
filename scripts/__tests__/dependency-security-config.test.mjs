import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const dependencyReview = readFileSync(
  resolve(repoRoot, ".github/workflows/dependency-review.yml"),
  "utf8",
);
const socketConfig = readFileSync(resolve(repoRoot, "socket.yml"), "utf8");

describe("dependency security configuration", () => {
  it("reviews every pull request targeting dev without path filters", () => {
    expect(dependencyReview).toMatch(/pull_request:\n\s+branches:\n\s+- dev/u);
    expect(dependencyReview).not.toMatch(/pull_request:[\s\S]*?paths:/u);
  });

  it("blocks moderate vulnerabilities in every dependency scope", () => {
    expect(dependencyReview).toContain("fail-on-severity: moderate");
    expect(dependencyReview).toContain("fail-on-scopes: development, runtime, unknown");
  });

  it("uses the repository license allowlist instead of the deprecated denylist", () => {
    expect(dependencyReview).toContain("allow-licenses: >-");
    expect(dependencyReview).toContain("Apache-2.0");
    expect(dependencyReview).toContain("BlueOak-1.0.0");
    expect(dependencyReview).not.toContain("deny-licenses:");
  });

  it("retries incomplete snapshots and exposes remediation and Scorecard context", () => {
    expect(dependencyReview).toContain("retry-on-snapshot-warnings: true");
    expect(dependencyReview).toContain("show-openssf-scorecard: true");
    expect(dependencyReview).toContain("show-patched-versions: true");
  });

  it("forces Socket reports for all users and all monorepo paths", () => {
    expect(socketConfig).toContain("version: 2");
    expect(socketConfig).toContain("pullRequestAlertsEnabled: true");
    expect(socketConfig).toContain("dependencyOverviewEnabled: true");
    expect(socketConfig).toContain("projectReportsEnabled: true");
    expect(socketConfig).toContain("disableCommentsAndCheckRuns: false");
    expect(socketConfig).toContain("ignoreUsers: []");
    expect(socketConfig).not.toMatch(/^\s*triggerPaths:/mu);
    expect(socketConfig).not.toMatch(/^\s*projectIgnorePaths:/mu);
  });
});
