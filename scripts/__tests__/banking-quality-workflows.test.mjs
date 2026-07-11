import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");
const banking = readFileSync(resolve(root, ".github/workflows/banking-quality-gate.yml"), "utf8");
const mutation = readFileSync(resolve(root, ".github/workflows/mutation-security.yml"), "utf8");
const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");

describe("Banking Grade workflows", () => {
  it("runs the trusted aggregator only after the protected CI workflow", () => {
    expect(banking).toMatch(/workflow_run:\n\s+workflows:\n\s+- CI/u);
    expect(banking).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(banking).not.toContain("pull_request_target");
    expect(banking).toMatch(/checks: write/u);
  });

  it("always emits a mutation check for dev PRs and runs a daily full scan", () => {
    expect(mutation).toMatch(/pull_request:\n\s+branches:\n\s+- dev/u);
    expect(mutation).toContain('cron: "17 2 * * *"');
    expect(mutation).toContain("name: Mutation quality gate");
    expect(mutation).not.toContain("continue-on-error: true");
  });

  it("verifies exact-head Sonar evidence after the scanner", () => {
    const scanner = ci.indexOf("SonarCloud CI-based analysis");
    const verifier = ci.indexOf("Verify SonarCloud Banking Grade PR evidence");
    expect(scanner).toBeGreaterThan(-1);
    expect(verifier).toBeGreaterThan(scanner);
    expect(ci).toContain("SONAR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}");
  });
});
