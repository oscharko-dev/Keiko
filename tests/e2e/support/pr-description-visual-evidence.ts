import { expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CODING_WORKBENCH_EVIDENCE_MODES,
  applyCodingWorkbenchEvidenceMode,
  artifactDigest,
} from "./coding-issue-commit-evidence.js";
import { evidenceArtifactPath, evidenceScreenshotPath } from "./evidence.js";
import { formatViolations, runAxe, seriousOrCritical } from "./axe.js";

const A11Y_MEASURE_SOURCE = readFileSync(
  join(process.cwd(), "design-system/a11y-measure.js"),
  "utf8",
);

export type PrDescriptionVisualIssue = 3389 | 3400 | 3401;

interface CaptureInput {
  readonly issue: PrDescriptionVisualIssue;
  readonly page: Page;
  readonly windowId: string;
  readonly surface: string;
  readonly state: string;
  readonly sources: readonly string[];
  readonly keyboardTarget?: string | undefined;
}

function sourceHashes(paths: readonly string[]): Readonly<Record<string, string>> {
  return Object.fromEntries(paths.map((path) => [path, artifactDigest(path)]));
}

async function settleAnimations(page: Page, selector: string): Promise<void> {
  await page.locator(selector).evaluate(async (element) => {
    await Promise.allSettled(
      element.getAnimations({ subtree: true }).map((animation) => animation.finished),
    );
  });
}

async function proveKeyboardAccess(page: Page, selector: string | undefined): Promise<void> {
  if (selector === undefined) return;
  const target = page.locator(selector);
  await target.focus();
  await expect(target).toBeFocused();
}

async function captureMode(
  input: CaptureInput,
  frame: string,
  mode: (typeof CODING_WORKBENCH_EVIDENCE_MODES)[number],
): Promise<unknown> {
  await applyCodingWorkbenchEvidenceMode(input.page, frame, mode);
  await input.page.locator(frame).evaluate((element) => {
    (element as HTMLElement).style.transform = "translate3d(0, 0, 0)";
  });
  await input.page.locator(input.surface).scrollIntoViewIfNeeded();
  await settleAnimations(input.page, frame);
  const violations = await runAxe(input.page, input.surface);
  expect(seriousOrCritical(violations), formatViolations(violations)).toEqual([]);
  const overflow = await input.page
    .locator(input.surface)
    .evaluate((element) => element.scrollWidth > element.clientWidth + 3);
  expect(overflow, `${mode.name} horizontal overflow`).toBe(false);
  if (mode.width === 360) await proveKeyboardAccess(input.page, input.keyboardTarget);
  const screenshot = `docs/design-system/evidence/${String(input.issue)}/${mode.name}.png`;
  await input.page
    .locator(frame)
    .screenshot({ path: evidenceScreenshotPath(screenshot), animations: "disabled" });
  return {
    ...mode,
    state: input.state,
    screenshot,
    screenshotSha256: artifactDigest(evidenceScreenshotPath(screenshot)),
    seriousOrCriticalViolations: 0,
    horizontalOverflow: overflow,
    violations: violations.map((item) => ({
      id: item.id,
      impact: item.impact,
      nodeCount: item.nodes.length,
    })),
  };
}

export async function capturePrDescriptionModes(input: CaptureInput): Promise<void> {
  const frame = `section.window[data-window-id="${input.windowId}"]`;
  const captures: unknown[] = [];
  await input.page.setViewportSize({ width: 1440, height: 2200 });
  for (const mode of CODING_WORKBENCH_EVIDENCE_MODES) {
    captures.push(await captureMode(input, frame, mode));
  }
  writeFileSync(
    evidenceArtifactPath(`docs/design-system/evidence/${String(input.issue)}/visual-proof.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        issue: input.issue,
        checkedAt: new Date().toISOString(),
        evidenceClass: "production-ui-deterministic-browser-fixture",
        modelQualification: false,
        liveAuthenticationQualification: false,
        sourceHashes: sourceHashes(input.sources),
        captures,
      },
      null,
      2,
    )}\n`,
  );
  await applyCodingWorkbenchEvidenceMode(input.page, frame, { name: "01-dark", theme: "dark" });
}

export async function capturePrDescriptionState(
  page: Page,
  issue: PrDescriptionVisualIssue,
  windowId: string,
  name: string,
): Promise<{ readonly screenshot: string; readonly screenshotSha256: string }> {
  const screenshot = `docs/design-system/evidence/${String(issue)}/${name}.png`;
  await page
    .locator(`section.window[data-window-id="${windowId}"]`)
    .screenshot({ path: evidenceScreenshotPath(screenshot), animations: "disabled" });
  return { screenshot, screenshotSha256: artifactDigest(evidenceScreenshotPath(screenshot)) };
}

/** Measures rendered text/background contrast through the design system's canonical WCAG ruler. */
export async function measureRenderedTextContrast(page: Page, selector: string): Promise<number> {
  await page.addScriptTag({ content: A11Y_MEASURE_SOURCE });
  return page.locator(selector).evaluate((element) => {
    const measure = (
      window as unknown as {
        KeikoA11y?: {
          readonly toRGBA: (value: string) => readonly [number, number, number, number];
          readonly ratio: (
            foreground: readonly [number, number, number, number],
            background: readonly [number, number, number, number],
          ) => number;
        };
      }
    ).KeikoA11y;
    if (measure === undefined) throw new TypeError("design-system contrast ruler is unavailable");
    const style = getComputedStyle(element);
    return measure.ratio(measure.toRGBA(style.color), measure.toRGBA(style.backgroundColor));
  });
}

export function writePrDescriptionJourneyEvidence(input: {
  readonly issue: PrDescriptionVisualIssue;
  readonly cases: readonly string[];
  readonly observations: Readonly<Record<string, unknown>>;
  readonly sources: readonly string[];
}): void {
  writeFileSync(
    evidenceArtifactPath(`docs/design-system/evidence/${String(input.issue)}/journey-proof.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        issue: input.issue,
        checkedAt: new Date().toISOString(),
        passed: true,
        evidenceClass: "production-ui-deterministic-browser-fixture",
        modelQualification: false,
        liveAuthenticationQualification: false,
        cases: input.cases,
        observations: input.observations,
        sourceHashes: sourceHashes(input.sources),
        rawContentRecorded: false,
      },
      null,
      2,
    )}\n`,
  );
}
