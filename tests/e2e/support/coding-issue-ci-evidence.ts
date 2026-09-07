import { expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CODING_WORKBENCH_EVIDENCE_MODES,
  applyCodingWorkbenchEvidenceMode,
  artifactDigest,
} from "./coding-issue-commit-evidence.js";
import { evidenceArtifactPath, evidenceScreenshotPath } from "./evidence.js";
import { runAxe, seriousOrCritical, formatViolations } from "./axe.js";
import { CI_WINDOW_ID } from "./coding-issue-ci-journey.js";

function sourceHashes(): Readonly<Record<string, string>> {
  const paths = [
    "packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchCiReadiness.tsx",
    "packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchCiReadiness.module.css",
    "packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/coding-workbench-i18n.en.ts",
    "packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/coding-workbench-i18n.de.ts",
    "tests/e2e/coding-issue-ci.spec.ts",
    "tests/e2e/servers/coding-issue-ci-fixture.mts",
    "tests/e2e/servers/coding-issue-ci-driver.mts",
    "packages/keiko-server/src/coding-runtime/productionCiObservationRuntime.ts",
    "packages/keiko-server/src/gitDelivery/ciObservationService.ts",
    "packages/keiko-server/src/gitDelivery/ciReadinessSnapshot.ts",
    "packages/keiko-tools/src/git-ci-facts.ts",
  ];
  return Object.fromEntries(paths.map((path) => [path, artifactDigest(path)]));
}
export async function captureCiModes(page: Page): Promise<void> {
  const selector = `section.window[data-window-id="${CI_WINDOW_ID}"]`;
  const captures: unknown[] = [];
  await page.setViewportSize({ width: 1440, height: 2200 });
  for (const mode of CODING_WORKBENCH_EVIDENCE_MODES) {
    await applyCodingWorkbenchEvidenceMode(page, selector, mode);
    await page.getByRole("region", { name: "CI readiness", exact: true }).scrollIntoViewIfNeeded();
    const violations = await runAxe(page, selector);
    expect(seriousOrCritical(violations), formatViolations(violations)).toEqual([]);
    const overflow = await page
      .locator(selector)
      .evaluate((element) => element.scrollWidth > element.clientWidth + 3);
    expect(overflow, `${mode.name} horizontal overflow`).toBe(false);
    const screenshot = `docs/design-system/evidence/3388/${mode.name}.png`;
    await page
      .locator(selector)
      .screenshot({ path: evidenceScreenshotPath(screenshot), animations: "disabled" });
    captures.push({
      ...mode,
      screenshot,
      screenshotSha256: artifactDigest(evidenceScreenshotPath(screenshot)),
      seriousOrCriticalViolations: 0,
      horizontalOverflow: overflow,
      violations: violations.map((item) => ({
        id: item.id,
        impact: item.impact,
        nodeCount: item.nodes.length,
      })),
    });
  }
  writeFileSync(
    evidenceArtifactPath("docs/design-system/evidence/3388/visual-proof.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        issue: 3388,
        checkedAt: new Date().toISOString(),
        evidenceClass: "production-composed-deterministic-browser",
        modelQualification: false,
        sourceHashes: sourceHashes(),
        captures,
      },
      null,
      2,
    ) + "\n",
  );
  await applyCodingWorkbenchEvidenceMode(page, selector, { name: "01-dark", theme: "dark" });
}
export function writeCiJourneyReceipt(stateDir: string, cases: readonly string[]): void {
  const log = readFileSync(join(stateDir, "bff-state", "state", "logs", "server.log"), "utf8");
  expect(log).not.toMatch(/required-build|advisory-analysis|REPAIRED_CI_3388/u);
  const lines = log
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const observations = lines.filter((line) => line.op === "git.ci-observation");
  const display = lines.filter(
    (line) =>
      typeof line.clientNote === "string" &&
      line.clientNote.startsWith("[keiko] CI readiness displayed:"),
  );
  expect(observations.length).toBeGreaterThan(0);
  expect(display.length).toBeGreaterThan(0);
  expect(
    [...observations, ...display].every((line) => typeof line.correlationId === "string"),
  ).toBe(true);
  writeFileSync(
    evidenceArtifactPath("docs/design-system/evidence/3388/journey-proof.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        issue: 3388,
        checkedAt: new Date().toISOString(),
        passed: true,
        evidenceClass: "production-composed-deterministic-browser",
        modelQualification: false,
        liveAuthenticationQualification: false,
        cases,
        correlatedObservationCount: observations.length,
        correlatedDisplayCount: display.length,
        sourceHashes: sourceHashes(),
        rawContentRecorded: false,
      },
      null,
      2,
    ) + "\n",
  );
}
