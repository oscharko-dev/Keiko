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

  it("runs PR analysis on dev and binds manual full analysis to remote dev", () => {
    const scanner = ci.indexOf("SonarCloud CI-based analysis");
    const verifier = ci.indexOf("Verify SonarCloud Banking Grade PR evidence");
    const mainVerifier = ci.indexOf("Verify SonarCloud Banking Grade dev evidence");
    expect(scanner).toBeGreaterThan(-1);
    expect(verifier).toBeGreaterThan(scanner);
    expect(mainVerifier).toBeGreaterThan(verifier);
    expect(ci).toContain("github.base_ref == 'dev'");
    expect(ci).toContain("SONAR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}");
    expect(ci).toContain("Verify changed production sources are mapped into LCOV");
    expect(ci).toContain(
      "ref: ${{ github.event_name == 'workflow_dispatch' && 'dev' || github.ref }}",
    );
    expect(ci).toContain("Verify manual analysis is bound to remote dev");
    expect(ci).toContain('expected="$(git rev-parse refs/remotes/origin/dev)"');
    expect(ci).toContain("SONAR_HEAD_SHA: ${{ steps.sonar-head.outputs.sha }}");
    expect(ci).toContain("node scripts/check-sonar-main-quality-gate.mjs");
  });

  it("keeps scanner files, logs, and working data outside the repository", () => {
    expect(ci).toContain('scanner_zip="$RUNNER_TEMP/sonar-scanner-cli.zip"');
    expect(ci).toContain("SONAR_SCANNER_HOME=$RUNNER_TEMP/sonar-scanner-8.1.0.6389-linux-x64");
    expect(ci).toContain('-Dsonar.projectBaseDir="$GITHUB_WORKSPACE"');
    expect(ci).toContain('-Dsonar.working.directory="$RUNNER_TEMP/sonar-work"');
    expect(ci).toContain('tee "$RUNNER_TEMP/sonar-scanner.log"');
    expect(ci).toContain("scanner_status=${PIPESTATUS[0]}");
    expect(ci).toContain(
      'node scripts/check-sonar-analysis-log.mjs --log "$RUNNER_TEMP/sonar-scanner.log"',
    );
    expect(ci).toContain('exit "$scanner_status"');
    expect(ci).toContain('if [ "$GITHUB_EVENT_NAME" = "workflow_dispatch" ]');
    expect(ci).toContain("if: ${{ always() && github.event_name == 'workflow_dispatch' }}");
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
    expect(aggregateJob).toContain("- cross-platform-smoke");
    expect(aggregateJob).toContain("CROSS_PLATFORM_RESULT");
    expect(aggregateJob).toContain('if [ "$result" != "success" ]');
  });

  it("runs native compensation on its owning platforms and aggregates it fail closed", () => {
    const crossPlatform = ci.match(/ {2}cross-platform-smoke:\n[\s\S]*?(?=\n {2}ui:\n)/u)?.[0];
    expect(crossPlatform).toBeDefined();
    expect(crossPlatform).toContain(
      "actions/setup-dotnet@26b0ec14cb23fa6904739307f278c14f94c95bf1",
    );
    expect(crossPlatform).toContain("npm run check:native:macos");
    expect(crossPlatform).toContain("npm run check:native:windows");
    expect(crossPlatform).toContain("Configure MSVC for native quality analysis");
    expect(crossPlatform).toContain('Join-Path $env:RUNNER_TEMP "keiko-vcvars-env.cmd"');
    expect(crossPlatform).toContain("$environment = & cmd.exe /d /c $vcvarsWrapper");
    expect(crossPlatform).toContain("MSVC environment initialization failed");
    expect(crossPlatform).not.toContain(
      "github.event_name == 'pull_request' && github.base_ref == 'feat/keiko-editor'",
    );
  });

  it("keeps release performance evidence off the pull-request critical path", () => {
    const performanceStep = ci.match(
      / {6}- name: Release performance E2E evidence\n[\s\S]*?(?=\n {6}- name: Performance evidence freshness)/u,
    )?.[0];

    expect(performanceStep).toBeDefined();
    expect(performanceStep).toContain('KEIKO_PERF_RUNS: "10"');
    expect(performanceStep).toContain("if: ${{ github.event_name != 'pull_request' }}");
    expect(performanceStep).toContain("npm run test:e2e:editor-perf");
    expect(performanceStep).not.toContain("continue-on-error");
  });

  it("contains no privileged pull-request trigger", () => {
    expect(mutation).not.toContain("pull_request_target");
    expect(mutation).not.toContain("workflow_run");
    expect(ci).not.toContain("pull_request_target");
    expect(ci).not.toContain("workflow_run");
  });
});
