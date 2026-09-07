import { expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { evidenceArtifactPath, evidenceScreenshotPath } from "./evidence.js";
import { formatViolations, runAxe, seriousOrCritical } from "./axe.js";
import { join } from "node:path";

interface ColorMode {
  readonly name: string;
  readonly theme: "dark" | "light";
  readonly highContrast?: boolean;
  readonly contrast?: "more";
  readonly forcedColors?: "active";
  readonly reducedMotion?: "reduce";
  readonly width?: number;
}

interface WorkbenchTrustLayoutEvidence {
  readonly noticeHeight: number;
  readonly bodyTop: number;
  readonly approvalTop?: number;
}

async function visibleBox(
  locator: ReturnType<Page["locator"]>,
  label: string,
): Promise<NonNullable<Awaited<ReturnType<typeof locator.boundingBox>>>> {
  await expect(locator, `${label} is visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label} has rendered bounds`).not.toBeNull();
  if (box === null) throw new TypeError(`${label} has no rendered bounds`);
  return box;
}

/** Pins the trust notice to the header and keeps it clear of the scrollable workbench body. */
export async function assertWorkbenchTrustLayout(
  page: Page,
  surface: string,
  approvalLabel?: string,
): Promise<WorkbenchTrustLayoutEvidence> {
  const workbench = page.locator(surface);
  const notice = await visibleBox(
    workbench.getByTestId("coding-workbench-trust-affordance"),
    "repository trust notice",
  );
  const button = workbench.getByRole("button", {
    name: "Allow package scripts for verification",
    exact: true,
  });
  await visibleBox(button, "repository trust action");
  const controlHeight = await button.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).minHeight),
  );
  expect(Number.isFinite(controlHeight) && controlHeight > 0).toBe(true);
  const body = await visibleBox(workbench.locator(":scope > div").last(), "workbench body");
  expect(
    notice.height,
    "repository trust notice stays a bounded header control",
  ).toBeLessThanOrEqual(controlHeight * 3);
  expect(
    notice.y + notice.height,
    "workbench body starts below repository trust notice",
  ).toBeLessThanOrEqual(body.y + 1);
  if (approvalLabel === undefined) return { noticeHeight: notice.height, bodyTop: body.y };
  const approval = await visibleBox(
    workbench.getByRole("region", { name: approvalLabel }),
    "approval review",
  );
  expect(
    notice.y + notice.height,
    "approval review starts below repository trust notice",
  ).toBeLessThanOrEqual(approval.y + 1);
  return { noticeHeight: notice.height, bodyTop: body.y, approvalTop: approval.y };
}
const MODES: readonly ColorMode[] = [
  { name: "01-dark", theme: "dark" },
  { name: "02-light", theme: "light" },
  { name: "03-dark-high-contrast", theme: "dark", highContrast: true },
  { name: "04-light-high-contrast", theme: "light", highContrast: true },
  { name: "05-prefers-contrast", theme: "dark", contrast: "more" },
  { name: "06-forced-colors", theme: "dark", forcedColors: "active" },
  { name: "07-reduced-motion", theme: "dark", reducedMotion: "reduce" },
  { name: "08-compact", theme: "dark", width: 360 },
];
const APPROVAL_REVIEW_LABELS = {
  commit: "Reviewed commit message",
  delivery: "Reviewed pull request description",
} as const;
export function artifactDigest(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
async function applyMode(page: Page, frameSelector: string, mode: ColorMode): Promise<void> {
  await page.emulateMedia({
    colorScheme: mode.theme,
    contrast: mode.contrast ?? "no-preference",
    forcedColors: mode.forcedColors ?? "none",
    reducedMotion: mode.reducedMotion ?? "no-preference",
  });
  await page.evaluate(
    ({ theme, highContrast }) => {
      document.documentElement.dataset.theme = theme;
      if (highContrast) document.documentElement.dataset.hc = "more";
      else document.documentElement.removeAttribute("data-hc");
    },
    { theme: mode.theme, highContrast: mode.highContrast === true },
  );
  await page.locator(frameSelector).evaluate((element, width) => {
    const height = width === 360 ? 2100 : 1400;
    const frame = element as HTMLElement;
    frame.style.width = `${String(width)}px`;
    frame.style.height = `${String(height)}px`;
    const zoom = frame.querySelector<HTMLElement>(".win-content-zoom");
    if (zoom !== null) {
      zoom.style.width = `${String(width - 2)}px`;
      zoom.style.height = `${String(height - 2)}px`;
    }
  }, mode.width ?? 1120);
}
export async function captureCommitModes(
  page: Page,
  windowId: string,
  surface: string,
): Promise<void> {
  await captureApprovalModes(page, windowId, surface, "commit");
}
export async function captureDeliveryModes(
  page: Page,
  windowId: string,
  surface: string,
): Promise<void> {
  await captureApprovalModes(page, windowId, surface, "delivery");
}
async function captureApprovalModes(
  page: Page,
  windowId: string,
  surface: string,
  kind: "commit" | "delivery",
): Promise<void> {
  const frameSelector = `section.window[data-window-id="${windowId}"]`;
  const captures: unknown[] = [];
  await page.setViewportSize({ width: 1440, height: 2200 });
  if (kind === "commit") await page.getByText("Exact commit binding", { exact: true }).click();
  const issue = kind === "commit" ? 3386 : 3387;
  const reviewLabel = APPROVAL_REVIEW_LABELS[kind];
  for (const mode of MODES) {
    await applyMode(page, frameSelector, mode);
    await page.getByRole("region", { name: reviewLabel }).scrollIntoViewIfNeeded();
    await page.locator(surface).evaluate(async (element) => {
      await Promise.allSettled(
        element.getAnimations({ subtree: true }).map((animation) => animation.finished),
      );
    });
    const violations = await runAxe(page, surface);
    expect(seriousOrCritical(violations), formatViolations(violations)).toEqual([]);
    const overflow = await page
      .locator(surface)
      .evaluate((element) => element.scrollWidth > element.clientWidth + 3);
    expect(overflow, `${mode.name} horizontal overflow`).toBe(false);
    if (mode.width === 360) await proveReviewKeyboard(kind, page, surface);
    await page.locator('section[aria-labelledby="permission-title"]').scrollIntoViewIfNeeded();
    const trustLayout = await assertWorkbenchTrustLayout(page, surface, reviewLabel);
    const screenshot = `docs/design-system/evidence/${String(issue)}/${mode.name}.png`;
    await page
      .locator(frameSelector)
      .screenshot({ path: evidenceScreenshotPath(screenshot), animations: "disabled" });
    captures.push({
      ...mode,
      screenshot,
      screenshotSha256: artifactDigest(evidenceScreenshotPath(screenshot)),
      seriousOrCriticalViolations: 0,
      violations: violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodeCount: violation.nodes.length,
      })),
      horizontalOverflow: overflow,
      trustLayout,
    });
  }
  writeCommitVisualReceipt(captures, issue);
  await applyMode(page, frameSelector, { name: "01-dark", theme: "dark" });
}

async function proveReviewKeyboard(
  kind: "commit" | "delivery",
  page: Page,
  surface: string,
): Promise<void> {
  if (kind === "commit") await proveDiffKeyboardScroll(page, surface);
  else await proveDeliveryKeyboardReview(page);
}

async function proveDiffKeyboardScroll(page: Page, surface: string): Promise<void> {
  const viewport = page.locator(surface).locator(".rv-code").first();
  await viewport.focus();
  await expect(viewport).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
}
async function proveDeliveryKeyboardReview(page: Page): Promise<void> {
  const body = page
    .getByRole("region", { name: "Reviewed pull request description" })
    .locator("pre");
  await body.focus();
  await expect(body).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Approve once", exact: true })).toBeFocused();
}

function writeCommitVisualReceipt(captures: readonly unknown[], issue: 3386 | 3387): void {
  const sources = [
    "packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchCommitReview.tsx",
    "packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchCommitResult.tsx",
    "packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchWindow.tsx",
    "packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchWindow.module.css",
    "packages/keiko-ui/src/lib/useCodingWorkbenchApprovalReview.ts",
    "packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchDeliveryReview.tsx",
    "packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchDraftDelivery.tsx",
    "packages/keiko-ui/src/app/components/desktop/widgets/cards/shared/diffView.tsx",
  ];
  writeFileSync(
    evidenceArtifactPath(`docs/design-system/evidence/${String(issue)}/visual-proof.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        issue,
        evidenceClass: "production-composed-deterministic-browser",
        modelQualification: false,
        checkedAt: new Date().toISOString(),
        sourceHashes: Object.fromEntries(sources.map((file) => [file, artifactDigest(file)])),
        captures,
      },
      null,
      2,
    )}\n`,
  );
}

export function writeCommitJourneyReceipt(stateDir: string, cases: readonly string[]): void {
  expect(cases).toHaveLength(6);
  const log = readFileSync(join(stateDir, "bff-state", "state", "logs", "server.log"), "utf8");
  expect(log).not.toContain("Reviewed <script>text</script>");
  expect(log).not.toContain("VERIFIED_COMMIT_3386");
  const lines = log
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const commits = lines.filter((line) => line.op === "git.verified-commit");
  expect(commits.length).toBeGreaterThan(0);
  expect(commits.every((line) => typeof line.correlationId === "string")).toBe(true);
  writeFileSync(
    evidenceArtifactPath("docs/design-system/evidence/3386/journey-proof.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        issue: 3386,
        checkedAt: new Date().toISOString(),
        passed: true,
        evidenceClass: "production-composed-deterministic-browser",
        modelQualification: false,
        cases,
        correlatedCommitLogCount: commits.length,
        rawContentRecorded: false,
      },
      null,
      2,
    )}\n`,
  );
}

// Reuse the canonical color/contrast/motion matrix for the adjacent read-only CI surface.
export { MODES as CODING_WORKBENCH_EVIDENCE_MODES, applyMode as applyCodingWorkbenchEvidenceMode };
