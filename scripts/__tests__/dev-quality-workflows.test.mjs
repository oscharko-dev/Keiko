import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..", "..");
const mutation = readFileSync(resolve(root, ".github/workflows/mutation-security.yml"), "utf8");
const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const nightlyPerfEvidence = readFileSync(
  resolve(root, ".github/workflows/nightly-perf-evidence.yml"),
  "utf8",
);
const visualRegression = readFileSync(
  resolve(root, "docs/design-system/visual-regression.md"),
  "utf8",
);
const ciWorkflow = parse(ci, { maxAliasCount: 0 });
const mutationWorkflow = parse(mutation, { maxAliasCount: 0 });
const mutationScope = readFileSync(resolve(root, "scripts/check-mutation-scope.mjs"), "utf8");
const localSonar = readFileSync(resolve(root, "docker/gates/run-sonar.sh"), "utf8");
const localSonarCompose = readFileSync(resolve(root, "docker/gates/sonar-compose.yml"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const devDispatchCoverageJobs = new Set([
  "coverage-packages",
  "coverage-ui",
  "coverage-scripts",
  "coverage-sonar",
]);

function runCiAggregate(overrides = {}) {
  const aggregateStep = ciWorkflow.jobs.ci.steps.find(
    (step) => step.name === "Aggregate required CI results fail closed",
  );
  return spawnSync("bash", ["-euo", "pipefail", "-c", aggregateStep.run], {
    encoding: "utf8",
    env: {
      ...process.env,
      BUILD_SCAN_SBOM_SMOKE_RESULT: "success",
      CHANGE_SCOPE_RESULT: "success",
      CORE_QUALITY_RESULT: "success",
      COVERAGE_SONAR_RESULT: "success",
      CROSS_PLATFORM_RESULT: "success",
      DOCUMENTATION_ONLY: "false",
      EDITOR_FAST_PR: "false",
      PROTECTED_BRANCH_RESULT: "success",
      SECRET_SCAN_RESULT: "success",
      SEMANTIC_DUPLICATION_RESULT: "success",
      UI_RESULT: "success",
      ...overrides,
    },
  });
}

describe("dev quality workflows", () => {
  it("isolates metadata edits from code-head CI concurrency", () => {
    expect(ciWorkflow.concurrency.group).toBe(
      "ci-${{ github.event_name == 'pull_request' && github.event.action != 'edited' && format('pr-{0}', github.event.pull_request.number) || github.run_id }}",
    );
    expect(ciWorkflow.concurrency["cancel-in-progress"]).toBe(
      "${{ github.event_name == 'pull_request' && github.event.action != 'edited' }}",
    );
  });

  it("runs full mutation on a daily or explicit bounded lane, never on the PR critical path", () => {
    expect(mutation).not.toContain("pull_request:");
    expect(mutation).toContain('cron: "17 2 * * *"');
    expect(mutation).toContain("workflow_dispatch:");
    expect(mutation).toContain("name: Full mutation regression");
    expect(mutation).toContain("timeout-minutes: 180");
    expect(mutation).toContain("group: mutation-security-full");
    expect(mutation).toContain("cancel-in-progress: false");
    expect(mutation).toContain('node-version: "24.18.0"');
    expect(mutation).toContain("node scripts/check-runtime-toolchain.mjs --exact");
    expect(mutation).toContain("npm run test:mutation:security");
    expect(mutation).not.toContain("check-mutation-scope.mjs");
    // KEIKO-0588: the mutation step now runs with continue-on-error so a failure files a
    // tracking issue (mirrors nightly-perf-evidence.yml). The lane must STILL fail — assert
    // the companion `Fail the lane after reporting` step exists and fires on the same outcome.
    expect(mutation).toContain("continue-on-error: true");
    expect(mutation).toMatch(/Fail the lane after reporting/u);
    expect(mutation).toMatch(/steps\.mutation\.outcome == 'failure'/u);
    expect(packageJson.scripts["test:mutation:security"]).toContain(
      "npm run test:mutation:debug-launch-security",
    );

    expect(mutationScope).toContain('"--diff-filter=ACMR"');
    expect(mutationScope).toContain('"packages/keiko-server/src/editor/dap/"');
    expect(mutationScope).toContain('"packages/keiko-server/src/editor/processHardening.ts"');
  });

  it("wires mutation failure reporting and the terminal failure to the measured suite", () => {
    const steps = mutationWorkflow.jobs["mutation-quality-gate"].steps;
    const installAt = steps.findIndex((step) => step.run === "npm ci --ignore-scripts");
    const buildAt = steps.findIndex((step) => step.run === "npm run build:packages");
    const mutationAt = steps.findIndex((step) => step.id === "mutation");
    const reportAt = steps.findIndex(
      (step) => step.name === "Report mutation failure as a tracking issue",
    );
    const failureAt = steps.findIndex((step) => step.name === "Fail the lane after reporting");
    const mutationStep = steps[mutationAt];
    const reportStep = steps[reportAt];
    const failureStep = steps[failureAt];

    expect(installAt).toBeGreaterThan(-1);
    expect(buildAt).toBeGreaterThan(installAt);
    expect(mutationAt).toBeGreaterThan(buildAt);
    expect(reportAt).toBeGreaterThan(mutationAt);
    expect(failureAt).toBeGreaterThan(reportAt);
    expect(mutationStep).toMatchObject({
      id: "mutation",
      name: "Run security mutation suite",
      run: "npm run test:mutation:security",
    });
    expect(mutationStep["continue-on-error"]).toBe(true);
    expect(reportStep.if).toBe("${{ steps.mutation.outcome == 'failure' }}");
    expect(reportStep.run).toContain("gh issue");
    expect(failureStep.if).toBe(reportStep.if);
    expect(failureStep.run).toContain("exit 1");
  });

  it("checks out complete history before validating immutable editor evidence", () => {
    const uiJob = ci.match(/ {2}ui:\n[\s\S]*$/u)?.[0];
    const checkoutStep = uiJob?.match(
      /- uses: actions\/checkout@[^\n]+\n[\s\S]*?(?=\n\s+- uses: actions\/setup-node)/u,
    )?.[0];
    expect(checkoutStep).toBeDefined();
    expect(checkoutStep).toContain("fetch-depth: 0");
    expect(uiJob).toContain("npm run check:perf-evidence:editor");
  });

  it("checks both committed performance documents nightly without running a hosted measurement", () => {
    expect(nightlyPerfEvidence).toContain("npm run --silent check:perf-evidence --");
    expect(nightlyPerfEvidence).not.toContain("check:perf-evidence:editor --");
    expect(nightlyPerfEvidence).toContain("performance-evidence-drift:");
    expect(nightlyPerfEvidence).toContain("d12-drift:");
    expect(nightlyPerfEvidence).toContain("Performance evidence versus");
  });

  it("does not represent migration-era design equivalence evidence as a standing gate", () => {
    expect(visualRegression).toContain("All twelve browser equivalence harnesses");
    expect(visualRegression).toContain("not standing CI or pull-request gates");
  });

  it("keeps functional UI checks blocking and moves hosted performance to post-merge evidence", () => {
    const uiJob = ci.match(/ {2}ui:\n[\s\S]*$/u)?.[0];
    const performanceStep = uiJob?.match(
      /- name: Refresh workspace performance evidence\n[\s\S]*?(?=\n\s+- name: Performance evidence freshness)/u,
    )?.[0];
    const freshnessStep = uiJob?.match(
      /- name: Performance evidence freshness \+ budget gate\n[\s\S]*?(?=\n\s+- name: Build package and UI assets)/u,
    )?.[0];
    expect(uiJob).toBeDefined();
    expect(uiJob).toContain("Release smoke E2E");
    // Issue #2705 / ADR-0158 D4: the two jsdom coverage steps this job used to own were the second,
    // discarded execution of a suite `coverage-ui` already measures for the whole lane. Their
    // enforcement is asserted at its new home in the block below; here the pin is inverted, so the
    // duplicate execution cannot quietly come back.
    expect(uiJob).not.toContain("npm run test:coverage:ui");
    expect(uiJob).not.toContain("npm run check:coverage");
    // ADR-0139 D7: hosted workspace-perf refresh and the freshness gate run post-merge only
    // (push/dispatch), while the immutable editor D12 evidence is validated on PRs and merge groups.
    expect(performanceStep).toContain(
      "if: ${{ github.event_name == 'push' || github.event_name == 'workflow_dispatch' }}",
    );
    expect(performanceStep).not.toContain("npm run test:e2e:editor-perf");
    expect(performanceStep).not.toContain("rm -f docs/release/1209-perf-evidence.json");
    expect(performanceStep).toContain("rm -f docs/release/1580-workspace-perf-evidence.json");
    expect(performanceStep).toContain("npm run test:e2e:workspace-perf");
    expect(performanceStep).toContain("immutable D12 baseline/candidate comparison");
    expect(performanceStep).toContain("Validate immutable editor D12 performance evidence");
    expect(performanceStep).toContain(
      "if: ${{ github.event_name == 'pull_request' || github.event_name == 'merge_group' }}",
    );
    expect(performanceStep).toContain("npm run check:perf-evidence:editor");
    expect(performanceStep).toContain("Validate workspace performance evidence freshness");
    expect(performanceStep).toContain("npm run check:perf-evidence:workspace");
    expect(freshnessStep).toContain(
      "if: ${{ github.event_name == 'push' || github.event_name == 'workflow_dispatch' }}",
    );
    expect(freshnessStep).toContain("Upload redacted performance evidence");
    expect(freshnessStep).not.toContain("always()");
    expect(freshnessStep).toContain("docs/release/1209-perf-evidence.json");
    expect(freshnessStep).toContain("docs/release/1580-workspace-perf-evidence.json");
    expect(freshnessStep).toContain("if-no-files-found: warn");
    expect(freshnessStep.indexOf("npm run check:perf-evidence")).toBeLessThan(
      freshnessStep.indexOf("Upload redacted performance evidence"),
    );
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
      "ref: ${{ github.event_name == 'workflow_dispatch' && 'dev' || github.sha }}",
    );
    expect(ci).toContain("Verify manual analysis is bound to remote dev");
    expect(ci).toContain('expected="$(git rev-parse refs/remotes/origin/dev)"');
    expect(ci).toContain("SONAR_HEAD_SHA: ${{ steps.sonar-head.outputs.sha }}");
    expect(ci).toContain("node scripts/check-sonar-main-quality-gate.mjs");
  });

  it("binds every full-tree quality lane to the same immutable merge candidate", () => {
    const candidateJobs = [
      "core-quality",
      "coverage-packages",
      "coverage-ui",
      "coverage-scripts",
      "coverage-sonar",
      "build-scan-sbom-smoke",
      "cross-platform-smoke",
      "ui",
    ];

    for (const jobName of candidateJobs) {
      const job = ciWorkflow.jobs[jobName];
      const steps = job.steps;
      const checkoutAt = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
      const setupNodeAt = steps.findIndex((step) => step.uses?.startsWith("actions/setup-node@"));
      const candidateCheckAt = steps.findIndex(
        (step) => step.name === "Verify pull-request merge candidate consistency",
      );
      const checkout = steps[checkoutAt];
      const candidateCheck = steps[candidateCheckAt];

      expect(job["timeout-minutes"], `${jobName} must have a bounded timeout`).toBeGreaterThan(0);
      expect(checkout, `${jobName} checkout must exist`).toBeDefined();
      expect(checkout.with.ref, `${jobName} must pin the run revision`).toBe(
        devDispatchCoverageJobs.has(jobName)
          ? "${{ github.event_name == 'workflow_dispatch' && 'dev' || github.sha }}"
          : "${{ github.sha }}",
      );
      expect(candidateCheck, `${jobName} must verify its candidate`).toMatchObject({
        if: "${{ github.event_name == 'pull_request' }}",
        env: {
          KEIKO_CANDIDATE_BASE_SHA: "${{ github.event.pull_request.base.sha }}",
          KEIKO_CANDIDATE_HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
        },
        run: "node scripts/check-ci-merge-candidate.mjs",
      });
      expect(setupNodeAt, `${jobName} must set up the trusted action runtime`).toBeGreaterThan(
        checkoutAt,
      );
      expect(
        candidateCheckAt,
        `${jobName} must verify before another action or candidate command runs`,
      ).toBe(setupNodeAt + 1);
      expect(steps.some((step) => step.name === "Verify candidate tree remains immutable")).toBe(
        false,
      );
    }

    const sonarEvidence = ciWorkflow.jobs["coverage-sonar"].steps.find(
      (step) => step.name === "Verify Sonar full-analysis evidence",
    );
    expect(sonarEvidence).toMatchObject({
      if: "${{ always() && steps.sonar-scan.outcome != 'skipped' }}",
      run: 'node scripts/check-sonar-analysis-log.mjs --log "$RUNNER_TEMP/sonar-scanner.log" --require-full-analysis',
    });
    expect(ci).not.toContain("oscharko-dev/Keiko/.github/actions/verify-");
    expect(ciWorkflow.jobs["coverage-sonar"]["timeout-minutes"]).toBe(50);
  });

  it("isolates local Sonar state by repository and selectable loopback port", () => {
    expect(localSonar).toContain('sonar_port="${KEIKO_LOCAL_SONAR_PORT:-9234}"');
    expect(localSonar).toContain("--path-format=absolute --git-common-dir");
    expect(localSonar).toContain(
      'compose_project="${COMPOSE_PROJECT_NAME:-keiko-sonar-${repository_id}-${sonar_port}}"',
    );
    expect(localSonar).toContain(
      'credentials="${git_common_dir}/keiko-local-sonar-${instance_id}"',
    );
    expect(localSonar).toContain('--stop) action="stop"');
    expect(localSonar).toContain(
      'git -C "${repo_root}" diff -z --name-only --diff-filter=ACMR HEAD',
    );
    expect(localSonar).toContain('git -C "${repo_root}" ls-files -z --others --exclude-standard');
    expect(localSonar).toContain("--needs-full-scan");
    expect(localSonar).not.toContain("-Dsonar.javascript.node.maxspace=4096");
    expect(localSonar).toContain("--partition-inclusions");
    expect(localSonar).toContain(
      '"-Dsonar.inclusions=${source_inclusions:-${empty_source_inclusion}}"',
    );
    expect(localSonar).toContain(
      '"-Dsonar.test.inclusions=${test_inclusions:-${empty_test_inclusion}}"',
    );
    expect(localSonar).toContain(
      'empty_source_inclusion=".keiko/local-sonar-empty-source-${checkout_id}"',
    );
    expect(localSonar).toContain(
      'empty_test_inclusion=".keiko/local-sonar-empty-test-${checkout_id}"',
    );
    expect(localSonar).not.toContain('"-Dsonar.test.inclusions=${inclusions}"');
    expect(localSonarCompose).toContain('"127.0.0.1:${KEIKO_LOCAL_SONAR_PORT:-9234}:9000"');
    expect(packageJson.scripts["gates:sonar:stop"]).toBe("./docker/gates/run-sonar.sh --stop");
  });

  it("keeps the changed-file verdict when a dynamic [capsuleId] route needs a full scan", () => {
    const unsafePathFallback = localSonar.match(
      /elif \[\[ "\$\{unsafe_path\}" == "yes" \]\]; then[\s\S]*?\n {2}else/u,
    )?.[0];

    expect(localSonar).toContain('readonly changed_scope="changed"');
    expect(localSonar).toContain('analysis_scope="${changed_scope}"');
    expect(localSonar).toContain('report_scope="${changed_scope}"');
    expect(localSonar).toContain('analysis_scope="all"');
    expect(localSonar).toContain(
      'KEIKO_SONAR_SCOPE="${report_scope}" KEIKO_SONAR_CHANGED_JSON="${changed_json}"',
    );
    expect(localSonar).toContain("analysis covers the whole project; verdict remains filtered to");
    expect(localSonar).toContain(
      'if [[ "${report_scope}" == "${changed_scope}" && "${changed_count}" != "0" ]]',
    );
    expect(localSonar).toContain('while IFS= read -r -d "" file');
    expect(unsafePathFallback).toContain('analysis_scope="all"');
    expect(unsafePathFallback).not.toContain('report_scope="all"');
  });

  it("keeps scanner files, logs, and working data outside the repository", () => {
    expect(ci).toContain('scanner_zip="$RUNNER_TEMP/sonar-scanner-cli.zip"');
    expect(ci).toContain("SONAR_SCANNER_HOME=$RUNNER_TEMP/sonar-scanner-8.1.0.6389-linux-x64");
    expect(ci).toContain('-Dsonar.projectBaseDir="$GITHUB_WORKSPACE"');
    expect(ci).toContain('-Dsonar.working.directory="$RUNNER_TEMP/sonar-work"');
    // Pin the analysis revision to the pull-request head so the merge-ref checkout does not trip the
    // SonarCloud "detected as changed but without having changed lines" SCM warning.
    expect(ci).toContain('-Dsonar.scm.revision="${SONAR_HEAD_SHA}"');
    expect(ci).toContain("-Dsonar.analysisCache.enabled=false");
    expect(ci).toContain("-Dsonar.sensor.cache.enable=false");
    expect(ci).toContain(
      "SONAR_HEAD_SHA: ${{ github.event.pull_request.head.sha || steps.sonar-head.outputs.sha || github.sha }}",
    );
    expect(ci).toContain('tee "$RUNNER_TEMP/sonar-scanner.log"');
    expect(ci).toContain("scanner_status=${PIPESTATUS[0]}");
    expect(ci).toContain('exit "$scanner_status"');
    expect(ci).toContain("node scripts/check-sonar-analysis-log.mjs");
    expect(ci).toContain('--log "$RUNNER_TEMP/sonar-scanner.log"');
    expect(ci).toContain("--require-full-analysis");
    expect(ci).not.toContain("SONAR_SCANNER_STATUS:");
    expect(ci).toContain("if: ${{ always() && github.event_name == 'workflow_dispatch' }}");
  });

  // Issue #2704 / ADR-0157 moved the three coverage suites into their own jobs, so `coverage-sonar`
  // finalizes them and necessarily declares `needs:`. What ADR-0131 D1 actually protects — Sonar
  // never queuing behind the unrelated package, retrieval, editor and architecture gates — is now
  // asserted directly instead of through the proxy "this job has no dependencies at all".
  it("keeps Sonar off the unrelated gate queue and fails closed on every coverage suite", () => {
    // Sliced to the next top-level key, not to `ci:` by name: a job inserted between the two
    // would otherwise be pulled into this block and the ordering assertions would hold over it.
    const coverageJob = ci.match(/ {2}coverage-sonar:\n[\s\S]*?(?=\n {2}\S)/u)?.[0];
    expect(coverageJob).toBeDefined();
    // Set equality, not a denylist: a job added to this `needs:` later must fail here rather than
    // slip through because nobody thought to enumerate it.
    const declaredNeeds = (coverageJob.match(/\n {4}needs:\n((?: {6}- \S+\n)+)/u)?.[1] ?? "")
      .split("\n")
      .map((line) => line.replace(/^ {6}- /u, "").trim())
      .filter(Boolean)
      .sort();
    expect(declaredNeeds).toEqual(["coverage-packages", "coverage-scripts", "coverage-ui"]);
    // always() plus an explicit per-suite success check: failure, cancelled AND skipped must all
    // turn this context red, so a silently skipped shard can never pass it with a suite unexecuted.
    expect(coverageJob).toContain("if: ${{ always() }}");
    expect(coverageJob).toContain('if [ "${entry#*:}" != "success" ]');
    expect(coverageJob).toContain("needs.coverage-packages.result");
    expect(coverageJob).toContain("needs.coverage-scripts.result");
    expect(coverageJob).toContain("needs.coverage-ui.result");
    // Reassembly must precede every evaluation: a per-file floor read off a shard-local summary
    // under-reports.
    // Issue #2705 / ADR-0158 D4: with the `ui` job's duplicate execution removed, this download is
    // the ONLY way keiko-ui's summary reaches the ratchet, the strict 88 release target and Sonar.
    // If it is dropped, the consolidated evaluation loses its keiko-ui input entirely.
    expect(coverageJob).toContain("Download keiko-ui coverage evidence");
    const mergeAt = coverageJob.indexOf("npm run test:coverage:packages:merge");
    const judgeAt = coverageJob.indexOf("npm run check:coverage:quality");
    const scanAt = coverageJob.indexOf("SonarCloud CI-based analysis");
    expect(mergeAt).toBeGreaterThan(-1);
    expect(judgeAt).toBeGreaterThan(mergeAt);
    expect(scanAt).toBeGreaterThan(mergeAt);
  });

  // The live isolation proof the coverage run depends on moved with the suites. Asserting it on all
  // three jobs is stricter than the single assertion it replaces.
  // KEIKO-1020: the identical `Install sandbox isolation backend (bubblewrap)` + AppArmor-relax
  // block that was previously inlined 7 times was extracted into
  // `.github/actions/setup-sandbox-isolation`. The invariant this test pins is unchanged:
  // every coverage suite job must call for the sandbox backend before running its coverage
  // command; the assertion targets the composite-action invocation rather than the inline shell.
  it("gives every coverage suite job a real bubblewrap isolation backend", () => {
    // Sliced to the NEXT top-level job key rather than to a named follower, so reordering jobs in
    // ci.yml cannot silently change what each iteration asserts.
    for (const job of ["coverage-packages", "coverage-ui", "coverage-scripts"]) {
      const block = ci.match(new RegExp(` {2}${job}:\\n[\\s\\S]*?(?=\\n {2}\\S)`, "u"))?.[0];
      const steps = ciWorkflow.jobs[job].steps;
      const sandboxAt = steps.findIndex(
        (step) => step.uses === "./.github/actions/setup-sandbox-isolation",
      );
      const provisionAt = steps.findIndex((step) => step.run === "npm run provision:usearch");
      const measureAt = steps.findIndex((step) => step.run?.startsWith("npm run test:coverage:"));
      expect(block, `${job} job block must exist`).toBeDefined();
      expect(block).toContain("uses: ./.github/actions/setup-sandbox-isolation");
      expect(block).toContain("npm run provision:usearch");
      expect(sandboxAt).toBeGreaterThan(-1);
      expect(provisionAt).toBeGreaterThan(sandboxAt);
      expect(measureAt).toBeGreaterThan(provisionAt);
    }
    // The composite action itself must still install bubblewrap AND relax AppArmor — this pin
    // moved from the caller to the callee, and losing it defeats the whole isolation proof.
    const compositeAction = readFileSync(
      resolve(root, ".github/actions/setup-sandbox-isolation/action.yml"),
      "utf8",
    );
    expect(compositeAction).toContain("sudo apt-get install -y bubblewrap");
    expect(compositeAction).toContain("kernel.apparmor_restrict_unprivileged_userns=0");
  });

  it("aggregates required CI fail closed", () => {
    // Sliced to the NEXT top-level key rather than to the `actionlint:` job, which ADR-0159 moved
    // into the `workflow hygiene` context. Same idiom as the coverage-suite test above, and it can
    // no longer be silently re-scoped by removing or reordering whatever job happens to follow.
    const aggregateJob = ci.match(/ {2}ci:\n[\s\S]*?(?=\n {2}\S|$)/u)?.[0];
    expect(aggregateJob, "ci aggregate job block must exist").toBeDefined();
    expect(aggregateJob).toContain("if: ${{ always() }}");
    expect(aggregateJob).toContain("- core-quality");
    expect(aggregateJob).toContain("- build-scan-sbom-smoke");
    expect(aggregateJob).toContain("- coverage-sonar");
    expect(aggregateJob).toContain("- cross-platform-smoke");
    expect(aggregateJob).toContain("- ui");
    expect(aggregateJob).toContain("BUILD_SCAN_SBOM_SMOKE_RESULT");
    expect(aggregateJob).toContain("CHANGE_SCOPE_RESULT");
    expect(aggregateJob).toContain("CROSS_PLATFORM_RESULT");
    expect(aggregateJob).toContain("EDITOR_FAST_PR");
    expect(aggregateJob).toContain("UI_RESULT");
    expect(aggregateJob).toContain('if [ "$result" != "success" ]');
  });

  it("allows the build skip only for editor fast-path pull requests", () => {
    const editor = runCiAggregate({
      BUILD_SCAN_SBOM_SMOKE_RESULT: "skipped",
      EDITOR_FAST_PR: "true",
    });
    const nonEditor = runCiAggregate({
      BUILD_SCAN_SBOM_SMOKE_RESULT: "skipped",
      EDITOR_FAST_PR: "false",
    });

    expect(editor.status).toBe(0);
    expect(editor.stdout).toContain("editor fast-path PR");
    expect(nonEditor.status).not.toBe(0);
    expect(nonEditor.stdout).toContain("skipped outside an editor fast-path PR");
  });

  it("fails the aggregate when change-scope does not succeed", () => {
    const result = runCiAggregate({ CHANGE_SCOPE_RESULT: "failure" });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Required CI dependency did not succeed: failure");
  });

  it.each(["failure", "skipped", "cancelled"])(
    "fails the aggregate when the UI result is %s",
    (uiResult) => {
      const result = runCiAggregate({ UI_RESULT: uiResult });

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain(`Required CI dependency did not succeed: ${uiResult}`);
    },
  );

  it("retries transient npm audit service failures without weakening advisory enforcement", () => {
    const rootAudit = ciWorkflow.jobs["build-scan-sbom-smoke"].steps.find(
      (step) => step.name === "Security audit (high and above)",
    );
    const uiAudit = ciWorkflow.jobs.ui.steps.find(
      (step) => step.name === "Security audit UI dependencies (moderate and above)",
    );

    expect(rootAudit.run).toBe(
      "node scripts/run-npm-audit-with-retry.mjs --audit-level=high --omit=dev",
    );
    expect(uiAudit.run).toBe(
      "node scripts/run-npm-audit-with-retry.mjs --audit-level=moderate --omit=dev --workspace=@oscharko-dev/keiko-ui",
    );
    expect(ci).not.toMatch(/^\s*run: npm audit\b/mu);
  });

  it("runs native compensation on its owning platforms and aggregates it fail closed", () => {
    const crossPlatform = ci.match(/ {2}cross-platform-smoke:\n[\s\S]*?(?=\n {2}ui:\n)/u)?.[0];
    expect(crossPlatform).toBeDefined();
    expect(crossPlatform).toContain(
      "actions/setup-dotnet@a98b56852c35b8e3190ac28c8c2271da59106c68",
    );
    expect(crossPlatform).toContain("npm run check:native:macos");
    expect(crossPlatform).toContain("npm run check:native:windows");
    // #3350: the command-spawn wrapper smoke needs no MSVC, so it runs before the compiler config.
    const cmdSpawnSmoke = ciWorkflow.jobs["cross-platform-smoke"].steps.find(
      (step) => step.name === "Smoke the Windows command spawn wrapper",
    );
    expect(cmdSpawnSmoke, "command spawn wrapper smoke step must exist").toBeDefined();
    expect(cmdSpawnSmoke.if).toBe("runner.os == 'Windows'");
    expect(cmdSpawnSmoke.run).toContain("node scripts/__tests__/windows-cmd-spawn-smoke.mjs");
    // A step-level `continue-on-error: true` soft-fails the step while the job (and therefore
    // `needs.cross-platform-smoke.result` in the `ci` aggregate) still reports success, defeating
    // the fail-closed aggregation the .if/.run pins above assume. Neither smoke step carries it
    // today; this pin catches the one edit that would silently disarm them.
    expect(cmdSpawnSmoke["continue-on-error"]).toBeUndefined();
    // #2992: the setup bootstrap smoke compiles the C stub, so it MUST run after MSVC is configured.
    const setupSteps = ciWorkflow.jobs["cross-platform-smoke"].steps;
    const setupBootstrapSmoke = setupSteps.find(
      (step) => step.name === "Smoke the Windows setup bootstrap",
    );
    expect(setupBootstrapSmoke, "setup bootstrap smoke step must exist").toBeDefined();
    expect(setupBootstrapSmoke.if).toBe("runner.os == 'Windows'");
    expect(setupBootstrapSmoke.run).toContain(
      "node scripts/__tests__/windows-setup-bootstrap-smoke.mjs",
    );
    // Same fail-closed reasoning as the command-spawn smoke step above.
    expect(setupBootstrapSmoke["continue-on-error"]).toBeUndefined();
    const msvcIndex = setupSteps.findIndex(
      (step) => step.name === "Configure MSVC for native quality analysis",
    );
    const setupSmokeIndex = setupSteps.findIndex(
      (step) => step.name === "Smoke the Windows setup bootstrap",
    );
    expect(msvcIndex).toBeGreaterThanOrEqual(0);
    expect(setupSmokeIndex).toBeGreaterThan(msvcIndex);
    expect(crossPlatform).toContain("Configure MSVC for native quality analysis");
    expect(crossPlatform).toContain('Join-Path $env:RUNNER_TEMP "keiko-vcvars-env.cmd"');
    expect(crossPlatform).toContain("$environment = & cmd.exe /d /c $vcvarsWrapper");
    expect(crossPlatform).toContain("MSVC environment initialization failed");
    expect(crossPlatform).not.toContain(
      "github.event_name == 'pull_request' && github.base_ref == 'feat/keiko-editor'",
    );
  });

  it("runs the Git executable reparse regression on the required Windows host", () => {
    const steps = ciWorkflow.jobs["cross-platform-smoke"].steps;
    const buildIndex = steps.findIndex(
      (step) => step.name === "Build packages for the Windows smokes",
    );
    const regressionIndex = steps.findIndex(
      (step) => step.name === "Verify Git executable Windows reparse containment",
    );
    const regression = steps[regressionIndex];

    expect(regression, "Windows Git reparse regression step must exist").toBeDefined();
    expect(regression.if).toBe("runner.os == 'Windows'");
    expect(regression.run).toBe("node scripts/__tests__/windows-git-reparse-smoke.mjs");
    expect(regression["continue-on-error"]).toBeUndefined();
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(regressionIndex).toBeGreaterThan(buildIndex);
  });

  it("contains no privileged pull-request trigger", () => {
    expect(mutation).not.toContain("pull_request_target");
    expect(mutation).not.toContain("workflow_run");
    expect(ci).not.toContain("pull_request_target");
    expect(ci).not.toContain("workflow_run");
  });
});
