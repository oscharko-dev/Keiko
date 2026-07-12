import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");
const mutation = readFileSync(resolve(root, ".github/workflows/mutation-security.yml"), "utf8");
const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const mutationScope = readFileSync(resolve(root, "scripts/check-mutation-scope.mjs"), "utf8");

describe("dev quality workflows", () => {
  it("always emits a mutation check for dev PRs and runs a daily full scan", () => {
    expect(mutation).toMatch(/pull_request:\n\s+branches:\n\s+- dev/u);
    expect(mutation).toContain('cron: "17 2 * * *"');
    expect(mutation).toContain("name: Mutation quality gate");
    expect(mutation).toContain('node-version: "24.18.0"');
    expect(mutation).toContain("node scripts/check-runtime-toolchain.mjs --exact");
    expect(mutation).toContain('-- --mutate "$MUTATION_FILES"');
    expect(mutation).toContain('check:mutation:scoped -- --base "$BASE_SHA" --head "$HEAD_SHA"');
    expect(mutation).not.toContain('"${mutation_files[@]}"');
    expect(mutationScope).toContain('"--diff-filter=ACMR"');
    expect(mutation).not.toContain("continue-on-error: true");

    const install = mutation.indexOf("npm ci --ignore-scripts");
    const buildPackages = mutation.indexOf("npm run build:packages");
    const scope = mutation.indexOf("Determine whether critical production logic changed");
    expect(buildPackages).toBeGreaterThan(install);
    expect(buildPackages).toBeLessThan(scope);
  });

  it("runs Sonar and LCOV mapping only for dev pull requests", () => {
    const scanner = ci.indexOf("SonarCloud CI-based analysis");
    const verifier = ci.indexOf("Verify SonarCloud Banking Grade PR evidence");
    expect(scanner).toBeGreaterThan(-1);
    expect(verifier).toBeGreaterThan(scanner);
    expect(ci).toContain("github.base_ref == 'dev'");
    expect(ci).toContain("SONAR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}");
    expect(ci).toContain("Verify changed production sources are mapped into LCOV");
  });

  it("runs coverage and Sonar in parallel and aggregates required CI fail closed", () => {
    const coverageJob = ci.match(/ {2}coverage-sonar:\n[\s\S]*?(?=\n {2}ci:\n)/u)?.[0];
    const aggregateJob = ci.match(/ {2}ci:\n[\s\S]*?(?=\n {2}actionlint:\n)/u)?.[0];
    expect(coverageJob).toBeDefined();
    expect(coverageJob).not.toContain("needs:");
    expect(coverageJob).toContain("Install sandbox isolation backend (bubblewrap)");
    expect(coverageJob).toContain("kernel.apparmor_restrict_unprivileged_userns=0");
    expect(aggregateJob).toContain("if: ${{ always() }}");
    expect(aggregateJob).toContain("- core-quality");
    expect(aggregateJob).toContain("- coverage-sonar");
    expect(aggregateJob).toContain('if [ "$result" != "success" ]');
  });

  it("contains no privileged pull-request trigger", () => {
    expect(mutation).not.toContain("pull_request_target");
    expect(mutation).not.toContain("workflow_run");
    expect(ci).not.toContain("pull_request_target");
    expect(ci).not.toContain("workflow_run");
  });
});
