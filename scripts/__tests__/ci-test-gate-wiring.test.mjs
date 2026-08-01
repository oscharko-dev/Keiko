import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// GEN-SYNTH-COVERAGE-003 / GEN-TEST-E2E-001 / GEN-TEST-RELEASE-GATE-*: the audit's core meta-finding
// is "the CI/release gate estate is green but load-bearing in the wrong places" — required proof
// suites were defined in package.json yet wired into NO workflow, and the largest UI surface is
// excluded from the headline `npm test`. This guard pins the wiring itself: if a required test/gate
// command is dropped from ci.yml, or the UI suite loses its dedicated job, THIS test fails. It
// complements check-release-required-workflow-names.mjs (which checks job NAMES, not the commands).

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const ci = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
const windowsNativeQuality = readFileSync(
  resolve(repoRoot, "scripts/check-windows-native-quality.ps1"),
  "utf8",
);
const windowsLauncher = readFileSync(
  resolve(repoRoot, "native/portable-launcher/keiko-portable-launcher.c"),
  "utf8",
);
const windowsRfc3161QualityProject = readFileSync(
  resolve(repoRoot, "scripts/native-quality/windows-rfc3161-quality.csproj"),
  "utf8",
);
const windowsRfc3161Source = readFileSync(
  resolve(repoRoot, "scripts/windows-portable-rfc3161.cs"),
  "utf8",
);
const rootVitestConfig = readFileSync(resolve(repoRoot, "vitest.config.ts"), "utf8");
const rootManifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const uiManifest = JSON.parse(
  readFileSync(resolve(repoRoot, "packages/keiko-ui/package.json"), "utf8"),
);
const extendedE2e = readFileSync(resolve(repoRoot, ".github/workflows/e2e-extended.yml"), "utf8");
const releaseWorkflow = readFileSync(resolve(repoRoot, ".github/workflows/release.yml"), "utf8");
const mutationSecurityWorkflow = readFileSync(
  resolve(repoRoot, ".github/workflows/mutation-security.yml"),
  "utf8",
);
const portableAssetsWorkflow = readFileSync(
  resolve(repoRoot, ".github/workflows/portable-assets.yml"),
  "utf8",
);
const htmlManualReleaseEvidence = readFileSync(
  resolve(repoRoot, "docs/qa/html-manual-retrieval-evaluation-evidence.md"),
  "utf8",
);
const retrievalFixtures = readFileSync(
  resolve(repoRoot, "packages/keiko-evaluations/src/local-knowledge/fixtures.ts"),
  "utf8",
);

// GEN-TEST-E2E-005: the editor/git/LK browser suites were wired into no workflow and could silently
// rot. e2e-extended.yml runs them on a schedule; pin that they stay wired.
// #2474: the Code-task journeys (#2385/#2386) joined the same workflow after shipping orphaned;
// every Wave-1 child of epic #2473 extends them, so their wiring is pinned the same way.
const REQUIRED_EXTENDED_SUITES = [
  "test:e2e:editor-baseline-1377",
  "test:e2e:editor-layout-1375",
  "test:e2e:coding-workbench-2253",
  "test:e2e:formatting-1380",
  "test:e2e:language-intelligence-1383",
  "test:e2e:git-changes-1575",
  "test:e2e:local-knowledge",
  "test:e2e:code-task:opencode-tracer",
  "test:e2e:code-task:authority",
  "test:e2e:code-task-research-2387",
];

// Every command here must run in a GitHub workflow on the default-branch path. Each maps to a
// release-blocker gate closed by an earlier remediation step; dropping any of them re-opens a
// "green but unproven" gap.
const REQUIRED_CI_COMMANDS = [
  // Coverage: package + UI ratchets (headline npm test excludes UI, so the UI job is mandatory).
  // Issue #2704 / ADR-0157 split the serial `npm run test:coverage:quality` chain into parallel
  // measuring jobs plus one judging job. The pin follows the chain rather than the old entry point:
  // every link it used to cover is asserted individually, so no part of it can go missing.
  //
  // Issue #2705 / ADR-0158 D2 then collapsed the six per-run evaluations behind
  // `check:coverage:quality` into ONE invocation covering all four metrics, the per-file floors and
  // the strict release targets. The chain pin is unchanged; what it points at now evaluates more in
  // a single parse. `check:coverage:ui` is gone with the duplicate UI execution it judged — the
  // exactly-once assertion below is what replaced it.
  "npm run test:coverage:packages:shard",
  "npm run test:coverage:packages:merge",
  "npm run test:coverage:scripts",
  "npm run check:coverage:quality",
  "npm run test:coverage:ui",
  // Browser release proof.
  "npm run test:e2e:smoke",
  "npm run test:e2e:editor-debugging-2348",
  // Performance e2e evidence + freshness/budget gate (Step 07, GEN-TEST-E2E-001).
  "npm run test:e2e:workspace-perf",
  "npm run check:perf-evidence:editor",
  "npm run check:perf-evidence",
  // Grounding/retrieval release gates (Step 05, RB-4/RB-5).
  "npm run check:retrieval-quality",
  "npm run check:grounded-retrieval-quality",
  "npm run check:grounded-faithfulness",
  "npm run check:grounded-entailment",
  // Knowledge M2 closeout gate (Knowledge M2.8, Epic #2556): the wave's anti-false-green artifact.
  // It shipped defined in package.json but wired into NO workflow — exactly the meta-finding this
  // guard exists for. Pin it so it cannot silently unwire again.
  "npm run check:knowledge-m2-closeout",
  "npm run check:context-quality",
  // Server error observability gate (Step 11, RB-6 / GEN-OBS-DIAGNOSTICS-901): the top-level 500 must
  // carry a correlation id + logged cause. Goes red against a bare error-swallowing `.catch`.
  "npm run check:error-observability",
  // Editor bundle release evidence (Step 06, RB-3).
  "npm run check:editor-release-evidence",
  // Version-drift governance (Step 06, RB-15).
  "npm run check:version-consistency",
  // Dependency-placement hygiene (Step 11, GEN-SYNTH-COVERAGE-005 / GEN-PKG-DEPENDENCY-001/003/004):
  // the dependency verifier the general audit never completed — no @types/* in runtime deps, engines
  // floors present, build-tool script imports declared at root.
  "npm run check:dependency-hygiene",
  "npm run check:knip",
  "npm run check:external-quality-config",
  "npm run check:semantic-duplication",
  // Formatting baseline + ADR registry integrity (Step 10, RB-19 / GEN-SYNTH-MISSING-EVIDENCE-001 /
  // GEN-DOC-ADR-002): format:check was unwired while 205 files drifted; check:adr-index guards the
  // ADR numbering-collision fix so a duplicate/unindexed ADR can never silently return.
  "npm run format:check",
  "npm run check:adr-index",
  // Sonar scope and native compensation must remain required CI evidence.
  "npm run check:sonar-scope",
  "npm run check:native:macos",
  "npm run check:native:windows",
];

const REQUIRED_HTML_MANUAL_RELEASE_GATES = [
  "check:retrieval-quality",
  "check:grounded-retrieval-quality",
  "check:grounded-faithfulness",
  "Leakage suites",
  "typecheck",
  "lint",
  "format:check",
  "arch:check",
];

const HTML_MANUAL_FIXTURE_IDS = [
  ...new Set(
    [...retrievalFixtures.matchAll(/\n\s*id: "(html-manual-[^"]+)"/gu)].map((match) =>
      String(match[1]),
    ),
  ),
];

describe("CI test/gate wiring guard", () => {
  it("refreshes workspace evidence without replacing the immutable D12 comparison", () => {
    const performanceStep = ci.slice(
      ci.indexOf("      - name: Refresh workspace performance evidence"),
      ci.indexOf("      - name: Build package and UI assets"),
    );
    expect(performanceStep).toContain("npm run test:e2e:workspace-perf");
    expect(performanceStep).not.toContain("npm run test:e2e:editor-perf");
    expect(performanceStep).not.toContain("rm -f docs/release/1209-perf-evidence.json");
    expect(performanceStep).toContain("immutable D12 baseline/candidate comparison");
    // ADR-0139 D7: the immutable editor evidence is validated on pull requests and merge groups;
    // the workspace refresh and freshness gate stay on push/dispatch (post-merge) only.
    expect(performanceStep).toContain(
      "if: ${{ github.event_name == 'pull_request' || github.event_name == 'merge_group' }}",
    );
    expect(performanceStep).toContain("npm run check:perf-evidence:editor");
    expect(performanceStep).toContain("Upload redacted performance evidence");
    expect(performanceStep).toContain("if-no-files-found: warn");
    expect(performanceStep).not.toContain("always()");
    expect(performanceStep.indexOf("npm run check:perf-evidence")).toBeLessThan(
      performanceStep.indexOf("Upload redacted performance evidence"),
    );
  });

  it("keeps Keiko native warnings strict while treating MSVC SDK headers as external", () => {
    expect(windowsNativeQuality).toContain('"/nologo", "/std:c17", "/W4", "/WX", "/analyze"');
    expect(windowsNativeQuality).toContain('"/external:env:INCLUDE", "/external:W0"');
    expect(windowsNativeQuality).toContain("$env:CAExcludePath = $env:INCLUDE");
    expect(windowsNativeQuality).toContain("MSVC INCLUDE environment is required");
  });

  it("keeps the Windows launcher path and command buffers off the process stack", () => {
    expect(windowsLauncher).toContain("HeapAlloc(heap, HEAP_ZERO_MEMORY");
    expect(windowsLauncher).toContain("free_launcher_buffers(buffers)");
    expect(windowsLauncher).not.toContain("wchar_t root[32768]");
    expect(windowsLauncher).not.toContain("wchar_t command[98304]");
  });

  it("pins the PKCS assembly required by the RFC3161 analyzer build", () => {
    expect(windowsRfc3161QualityProject).toContain("<TargetFramework>net8.0</TargetFramework>");
    expect(windowsRfc3161QualityProject).toContain(
      '<PackageReference Include="System.Security.Cryptography.Pkcs" Version="10.0.9" />',
    );
  });

  it("keeps the Windows RFC3161 boundary namespaced and P/Invoke resolution constrained", () => {
    expect(windowsRfc3161Source).toContain("namespace Keiko.Portable;");
    expect(windowsRfc3161Source).toContain("IReadOnlyList<X509Certificate2> Certificates");
    expect(
      windowsRfc3161Source.match(
        /\[DefaultDllImportSearchPaths\(DllImportSearchPath\.System32\)\]/gu,
      ),
    ).toHaveLength(4);
    expect(windowsRfc3161Source).not.toMatch(/catch\s*\{/gu);
  });

  it("pins every Node workflow lane to the governed Node.js and npm toolchain", () => {
    const runtimeWorkflows = [
      ci,
      extendedE2e,
      releaseWorkflow,
      portableAssetsWorkflow,
      mutationSecurityWorkflow,
    ].join("\n");
    const nodeSetupCount = runtimeWorkflows.match(/node-version: "24\.18\.0"/gu)?.length ?? 0;
    const verificationCount =
      runtimeWorkflows.match(/node scripts\/check-runtime-toolchain\.mjs --exact/gu)?.length ?? 0;
    // 17 -> 20 with the three coverage suite jobs Issue #2704 split out of `coverage-sonar`,
    // then 20 -> 22 with the credential-free macOS qualification and protected sealing lanes,
    // then 22 -> 23 with the diff-scoped semantic-duplication lane, 23 -> 24 when the secret scan
    // adopted the governed runtime. The retired hosted performance policy no longer adds a lane.
    // The load-bearing assertion is the pairing below: every Node lane, old or new, verifies the
    // governed toolchain.
    expect(nodeSetupCount).toBe(24);
    expect(verificationCount).toBe(nodeSetupCount);
    expect(runtimeWorkflows).not.toMatch(/node-version: "22/u);
  });

  it("executes typecheck, build, and install smokes on every desktop OS", () => {
    const start = ci.indexOf("  cross-platform-smoke:");
    const end = ci.indexOf("\n  ui:", start);
    const crossPlatform = ci.slice(start, end);
    expect(crossPlatform).toContain("os: [ubuntu-latest, windows-latest, macos-latest]");
    expect(crossPlatform).toContain("Typecheck the complete package graph");
    expect(crossPlatform).toContain("- name: Build");
    expect(crossPlatform).toContain("Installable-package smoke with native optional dependencies");
    expect(crossPlatform).toContain("Verify productive native sources on macOS");
    expect(crossPlatform).toContain("Verify productive native sources on Windows");
    expect(crossPlatform).not.toContain("npm test");
  });

  for (const command of REQUIRED_CI_COMMANDS) {
    it(`ci.yml wires \`${command}\``, () => {
      expect(ci.includes(command), `\`${command}\` is not run by any ci.yml job`).toBe(true);
    });
  }

  it("keeps the replacement quality gates in required ci and the retired bridge out", () => {
    const aggregate = ci.slice(ci.indexOf("  ci:"), ci.indexOf("\n  build-scan-sbom-smoke:"));
    expect(aggregate).toContain("      - semantic-duplication");
    expect(ci).not.toContain("npm run check:qodo-config");
    expect(ci).not.toContain("  codspeed-policy:");
    expect(ci).not.toMatch(/codspeed|greptile/iu);
  });

  // GEN-SYNTH-COVERAGE-003: the root suite intentionally excludes keiko-ui (235 files) — they run in
  // jsdom under a dedicated config + CI job. Pin BOTH facts so the exclusion can never become silent
  // (headline suite drops UI) NOR unenforced (UI job removed).
  it("documents the intentional keiko-ui exclusion from the headline root suite", () => {
    expect(rootVitestConfig).toContain("packages/keiko-ui/**");
  });

  // Issue #2705 / ADR-0158 D4: the pin is relocated and tightened rather than dropped. Before, the
  // UI suite ran twice — once in `coverage-ui`, once in `ui` — and the second run's ratchet judged a
  // summary no other step ever read. "The UI job was removed" is still caught (count 0 fails), and
  // "the UI suite is measured twice again" is now caught too (count 2 fails), which the previous
  // `toContain` could not see. The ratchet half of the pin moved to the consolidated evaluation,
  // asserted directly against its arguments below.
  const runLineCount = (command) =>
    ci.split("\n").filter((line) => line.trim() === `run: ${command}`).length;

  it("measures each coverage suite exactly once per run", () => {
    expect(runLineCount("npm run test:coverage:ui")).toBe(1);
    expect(runLineCount("npm run test:coverage:scripts")).toBe(1);
    expect(runLineCount("npm run check:coverage:quality")).toBe(1);
  });

  it("keeps the strict release lines targets inside the one consolidated evaluation", () => {
    const consolidated = rootManifest.scripts["check:coverage:quality"];
    expect(consolidated).toContain("--release-target keiko-ui=88");
    expect(consolidated).toContain("--release-target keiko-cli=87");
    expect(consolidated).toContain("--all-metrics");
    expect(consolidated).toContain("--enforce-file-floors");
  });

  it("keeps the supported UI compiler and TypeScript 7 compatibility check separate", () => {
    expect(uiManifest.devDependencies.typescript).toBe("5.7.3");
    expect(uiManifest.scripts.typecheck).toBe("tsc --noEmit");
    expect(uiManifest.scripts["typecheck:native"]).toContain(
      "node ../../node_modules/@typescript/native/bin/tsc",
    );
    expect(ci).toContain("npm run typecheck:native --workspace @oscharko-dev/keiko-ui");
  });

  it("machine-pins the HTML manual release evidence gate matrix (AUDIT-E1858-002)", () => {
    expect(htmlManualReleaseEvidence).toContain("## Required vs advisory gates");
    for (const gate of REQUIRED_HTML_MANUAL_RELEASE_GATES) {
      expect(htmlManualReleaseEvidence, `${gate} must stay listed in release evidence`).toContain(
        gate,
      );
    }
    for (const fixtureId of HTML_MANUAL_FIXTURE_IDS) {
      expect(
        htmlManualReleaseEvidence,
        `${fixtureId} must stay represented in release evidence`,
      ).toContain(fixtureId);
    }
    expect(htmlManualReleaseEvidence).not.toContain("not a machine-enforced artifact");
  });

  // GEN-TEST-E2E-005: the previously-orphaned editor/git/LK suites must stay wired into a scheduled
  // workflow so they cannot silently rot again.
  it("schedules the extended e2e workflow", () => {
    expect(extendedE2e).toMatch(/on:\s*[\s\S]*schedule:/u);
  });

  for (const suite of REQUIRED_EXTENDED_SUITES) {
    it(`e2e-extended.yml runs \`${suite}\``, () => {
      expect(extendedE2e.includes(suite), `${suite} is not wired into e2e-extended.yml`).toBe(true);
    });
  }
});
