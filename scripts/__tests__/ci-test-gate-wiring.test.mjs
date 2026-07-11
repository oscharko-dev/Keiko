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
const rootVitestConfig = readFileSync(resolve(repoRoot, "vitest.config.ts"), "utf8");
const uiManifest = JSON.parse(
  readFileSync(resolve(repoRoot, "packages/keiko-ui/package.json"), "utf8"),
);
const extendedE2e = readFileSync(resolve(repoRoot, ".github/workflows/e2e-extended.yml"), "utf8");
const releaseWorkflow = readFileSync(resolve(repoRoot, ".github/workflows/release.yml"), "utf8");
const portableAssetsWorkflow = readFileSync(
  resolve(repoRoot, ".github/workflows/portable-assets.yml"),
  "utf8",
);
const htmlManualReleaseEvidence = readFileSync(
  resolve(repoRoot, "docs/qa/html-manual-retrieval-evaluation-evidence.md"),
  "utf8",
);
const retrievalFixtures = readFileSync(
  resolve(repoRoot, "packages/keiko-local-knowledge/src/evaluations/fixtures.ts"),
  "utf8",
);

// GEN-TEST-E2E-005: the editor/git/LK browser suites were wired into no workflow and could silently
// rot. e2e-extended.yml runs them on a schedule; pin that they stay wired.
const REQUIRED_EXTENDED_SUITES = [
  "test:e2e:editor-baseline-1377",
  "test:e2e:editor-layout-1375",
  "test:e2e:git-changes-1575",
  "test:e2e:local-knowledge",
];

// Every command here must run in a GitHub workflow on the default-branch path. Each maps to a
// release-blocker gate closed by an earlier remediation step; dropping any of them re-opens a
// "green but unproven" gap.
const REQUIRED_CI_COMMANDS = [
  // Coverage: package + UI ratchets (headline npm test excludes UI, so the UI job is mandatory).
  "npm run test:coverage:quality",
  "npm run test:coverage:ui",
  "npm run check:coverage:ui",
  // Browser release proof.
  "npm run test:e2e:smoke",
  // Performance e2e evidence + freshness/budget gate (Step 07, GEN-TEST-E2E-001).
  "npm run test:e2e:editor-perf",
  "npm run test:e2e:workspace-perf",
  "npm run check:perf-evidence",
  // Grounding/retrieval release gates (Step 05, RB-4/RB-5).
  "npm run check:retrieval-quality",
  "npm run check:grounded-retrieval-quality",
  "npm run check:grounded-faithfulness",
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
  // Formatting baseline + ADR registry integrity (Step 10, RB-19 / GEN-SYNTH-MISSING-EVIDENCE-001 /
  // GEN-DOC-ADR-002): format:check was unwired while 205 files drifted; check:adr-index guards the
  // ADR numbering-collision fix so a duplicate/unindexed ADR can never silently return.
  "npm run format:check",
  "npm run check:adr-index",
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
  it("pins every Node workflow lane to the governed Node.js and npm toolchain", () => {
    const runtimeWorkflows = [ci, extendedE2e, releaseWorkflow, portableAssetsWorkflow].join("\n");
    const nodeSetupCount = runtimeWorkflows.match(/node-version: "24\.18\.0"/gu)?.length ?? 0;
    const verificationCount =
      runtimeWorkflows.match(/node scripts\/check-runtime-toolchain\.mjs --exact/gu)?.length ?? 0;
    expect(nodeSetupCount).toBe(14);
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
    expect(crossPlatform).not.toContain("npm test");
  });

  for (const command of REQUIRED_CI_COMMANDS) {
    it(`ci.yml wires \`${command}\``, () => {
      expect(ci.includes(command), `\`${command}\` is not run by any ci.yml job`).toBe(true);
    });
  }

  // GEN-SYNTH-COVERAGE-003: the root suite intentionally excludes keiko-ui (235 files) — they run in
  // jsdom under a dedicated config + CI job. Pin BOTH facts so the exclusion can never become silent
  // (headline suite drops UI) NOR unenforced (UI job removed).
  it("documents the intentional keiko-ui exclusion from the headline root suite", () => {
    expect(rootVitestConfig).toContain("packages/keiko-ui/**");
  });

  it("runs the excluded UI suite in its own required CI job with a coverage ratchet", () => {
    expect(ci).toContain("npm run test:coverage:ui");
    expect(ci).toContain("npm run check:coverage:ui");
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
