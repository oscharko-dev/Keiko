import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";
import {
  feedbackScreenshotPath,
  feedbackResponsiveScreenshotPath,
  writeFeedbackEvidence,
  type FeedbackA11yCapture,
  type FeedbackModeCapture,
  type FeedbackOverflowProof,
  type FeedbackResponsiveCapture,
  type FeedbackStyleProof,
} from "./support/feedback-2073-evidence.js";
import {
  AMBIGUOUS_ASSIGNMENT,
  FEEDBACK_MODES,
  enterOrdinaryFeedback,
  expectNoBypass,
  fillRequiredDraft,
  openFeedbackFromSettings,
  resizeFeedbackWindowToWidth,
  scanFeedback,
  type FeedbackMode,
  type PreparedFeedbackResponse,
} from "./support/feedback-2073.js";

// Issue #2073 (Epic #2070) - tracked seven-mode fidelity, accessibility, and privacy evidence.

async function styleProof(
  page: Page,
  preview: Locator,
  notices: Locator,
): Promise<FeedbackStyleProof> {
  const previewStyle = await preview.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      borderColor: style.borderTopColor,
      color: style.color,
    };
  });
  const noticeStyle = await notices.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, borderColor: style.borderTopColor };
  });
  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const values: Record<string, string> = {};
    for (const name of [
      "--surface-primary",
      "--surface-inset",
      "--text-primary",
      "--text-secondary",
      "--border-subtle",
      "--focus-ring",
      "--feedback-warning",
      "--feedback-warning-surface",
    ]) {
      values[name] = style.getPropertyValue(name).trim();
    }
    return values;
  });
  return {
    previewBackground: previewStyle.background,
    previewBorderColor: previewStyle.borderColor,
    previewColor: previewStyle.color,
    noticeBackground: noticeStyle.background,
    noticeBorderColor: noticeStyle.borderColor,
    tokens,
  };
}

async function horizontalOverflowProof(feedback: Locator): Promise<FeedbackOverflowProof> {
  return feedback.evaluate((element) => {
    const body = element.querySelector<HTMLElement>(".win-body");
    const preview = element.querySelector<HTMLElement>('[aria-label="Sanitized preview"]');
    if (body === null || preview === null) throw new Error("Feedback overflow targets missing");
    const metrics = {
      window: { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth },
      body: { clientWidth: body.clientWidth, scrollWidth: body.scrollWidth },
      preview: { clientWidth: preview.clientWidth, scrollWidth: preview.scrollWidth },
    };
    return {
      ...metrics,
      pass:
        body.scrollWidth <= body.clientWidth + 1 && preview.scrollWidth <= preview.clientWidth + 1,
    };
  });
}

async function settleVisuals(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            resolve();
          }),
        );
      }),
  );
}

interface PreparedModeState {
  readonly feedback: Locator;
  readonly preview: Locator;
  readonly notices: Locator;
  readonly rawControl: Locator;
  readonly prepared: PreparedFeedbackResponse;
}

async function prepareModeState(page: Page, mode: FeedbackMode): Promise<PreparedModeState> {
  const feedback = await openFeedbackFromSettings(page, mode);
  await enterOrdinaryFeedback(feedback);
  await fillRequiredDraft(feedback, {
    title: "Privacy-safe feedback preview",
    description: "The prepared report keeps a safe semantic remainder.",
  });
  const rawControl = feedback.getByLabel("Browser description (optional)");
  await rawControl.fill(AMBIGUOUS_ASSIGNMENT);
  const response = await scanFeedback(page, feedback);
  expect(response.status()).toBe(200);
  const prepared = (await response.json()) as PreparedFeedbackResponse;
  expect(prepared.canonicalJson).not.toContain("opaque-value");
  expect(prepared.dispositionSidecar.records.map((record) => record.action)).toEqual([
    "quarantined",
    "omitted",
  ]);
  const preview = feedback.getByRole("region", { name: "Sanitized preview" });
  return {
    feedback,
    preview,
    notices: preview.getByRole("region", { name: "Privacy changes" }),
    rawControl,
    prepared,
  };
}

async function verifyPreparedMode(
  page: Page,
  mode: FeedbackMode,
  state: PreparedModeState,
): Promise<{
  readonly overflowFree: boolean;
  readonly overflow: FeedbackOverflowProof;
  readonly style: FeedbackStyleProof;
  readonly violations: Awaited<ReturnType<typeof runAxe>>;
}> {
  const { feedback, preview, notices, prepared } = state;
  await expect(preview.getByRole("heading", { name: "Sanitized preview" })).toBeFocused();
  await expect(notices).toContainText("ambiguous credential-like content was quarantined");
  await expect(notices).toContainText("no safe optional content remained, so it was omitted");
  await expect(preview).not.toContainText("opaque-value");
  await expect(preview.locator("code")).toHaveText(prepared.exactBodySha256);
  await expectNoBypass(feedback);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-theme")))
    .toBe(mode.theme);
  expect(await page.evaluate(() => document.documentElement.getAttribute("data-hc"))).toBe(
    mode.dataHc,
  );
  const overflow = await horizontalOverflowProof(feedback);
  expect(overflow, JSON.stringify(overflow)).toMatchObject({ pass: true });
  const style = await styleProof(page, preview, notices);
  for (const value of Object.values(style.tokens)) expect(value.length).toBeGreaterThan(0);
  const violations = await runAxe(page, '.window[data-window-id="feedback"]');
  expect(seriousOrCritical(violations), formatViolations(seriousOrCritical(violations))).toEqual(
    [],
  );
  return { overflowFree: overflow.pass, overflow, style, violations };
}

async function capturePreparedMode(
  page: Page,
  mode: FeedbackMode,
): Promise<{ readonly fidelity: FeedbackModeCapture; readonly a11y: FeedbackA11yCapture }> {
  const state = await prepareModeState(page, mode);
  const { feedback, preview, rawControl, prepared } = state;
  const verified = await verifyPreparedMode(page, mode, state);
  const gatingViolations = seriousOrCritical(verified.violations);
  await settleVisuals(page);
  await feedback.screenshot({
    path: feedbackScreenshotPath(mode.file),
    animations: "disabled",
    mask: [rawControl],
    maskColor: "#6f7672",
  });
  return {
    fidelity: {
      file: mode.file,
      mode: mode.name,
      dataTheme: await page.evaluate(() => document.documentElement.getAttribute("data-theme")),
      dataHc: await page.evaluate(() => document.documentElement.getAttribute("data-hc")),
      forcedColors: mode.media.forcedColors,
      reducedMotion: mode.media.reducedMotion,
      windowName: await feedback.getAttribute("aria-label"),
      activeElementText: await page.evaluate(() => {
        const active = document.activeElement;
        return active === null ? "" : active.textContent.trim();
      }),
      noHorizontalOverflow: verified.overflowFree,
      horizontalOverflowProof: verified.overflow,
      exactDigestVisible: await preview.locator("code").isVisible(),
      privacyActions: prepared.dispositionSidecar.records.map(
        (record) => `${record.action}:${record.reason}`,
      ),
      style: verified.style,
    },
    a11y: { mode: mode.name, violations: verified.violations, seriousOrCritical: gatingViolations },
  };
}

async function responsiveControlProof(feedback: Locator): Promise<{
  readonly visibleControlCount: number;
  readonly enabledControlCount: number;
  readonly keyboardReachableControlCount: number;
}> {
  const controls = feedback.getByRole("region", { name: "Sanitized preview" }).getByRole("button");
  let visibleControlCount = 0;
  let enabledControlCount = 0;
  let keyboardReachableControlCount = 0;
  for (let index = 0; index < (await controls.count()); index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible())) continue;
    visibleControlCount += 1;
    if (await control.isDisabled()) continue;
    enabledControlCount += 1;
    await control.focus();
    if (await control.evaluate((node) => document.activeElement === node)) {
      keyboardReachableControlCount += 1;
    }
  }
  return { visibleControlCount, enabledControlCount, keyboardReachableControlCount };
}

async function responsiveMetrics(feedback: Locator): Promise<{
  readonly actualWidth: number;
  readonly windowScrollWidth: number;
  readonly bodyClientWidth: number;
  readonly bodyScrollWidth: number;
}> {
  return feedback.evaluate((element) => {
    const body = element.querySelector<HTMLElement>(".win-body");
    if (body === null) throw new Error("Feedback body missing");
    return {
      actualWidth: element.getBoundingClientRect().width,
      windowScrollWidth: element.scrollWidth,
      bodyClientWidth: body.clientWidth,
      bodyScrollWidth: body.scrollWidth,
    };
  });
}

async function captureResponsiveEvidence(browser: Browser): Promise<FeedbackResponsiveCapture> {
  const context = await browser.newContext({
    bypassCSP: true,
    viewport: { width: 1440, height: 980 },
  });
  const page = await context.newPage();
  try {
    const feedback = await openFeedbackFromSettings(page);
    await enterOrdinaryFeedback(feedback);
    await fillRequiredDraft(feedback);
    const response = await scanFeedback(page, feedback);
    expect(response.status()).toBe(200);
    await expect(feedback.getByRole("region", { name: "Sanitized preview" })).toBeVisible();
    await resizeFeedbackWindowToWidth(page, feedback, 500);
    const controls = await responsiveControlProof(feedback);
    const metrics = await responsiveMetrics(feedback);
    const capture: FeedbackResponsiveCapture = {
      targetWidth: 500,
      ...metrics,
      ...controls,
      pass:
        Math.abs(metrics.actualWidth - 500) <= 2 &&
        metrics.windowScrollWidth <= metrics.actualWidth + 1 &&
        metrics.bodyScrollWidth <= metrics.bodyClientWidth + 1 &&
        controls.visibleControlCount > 0 &&
        controls.keyboardReachableControlCount === controls.enabledControlCount,
    };
    expect(capture.pass, JSON.stringify(capture)).toBe(true);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              resolve();
            });
          });
        }),
    );
    await feedback.screenshot({ path: feedbackResponsiveScreenshotPath(), animations: "disabled" });
    return capture;
  } finally {
    await context.close();
  }
}

test("Issue #2073 prepared feedback fidelity evidence", async ({ browser }) => {
  const fidelity: FeedbackModeCapture[] = [];
  const a11y: FeedbackA11yCapture[] = [];
  for (const mode of FEEDBACK_MODES) {
    // Axe is injected from the committed local dependency; bypass CSP only in this isolated
    // evidence context, matching the established update-fidelity browser harness.
    const context = await browser.newContext({
      bypassCSP: true,
      viewport: { width: 1440, height: 980 },
    });
    const page = await context.newPage();
    try {
      const capture = await capturePreparedMode(page, mode);
      fidelity.push(capture.fidelity);
      a11y.push(capture.a11y);
    } finally {
      await context.close();
    }
  }
  expect(fidelity).toHaveLength(7);
  expect(a11y).toHaveLength(7);
  const responsive = await captureResponsiveEvidence(browser);
  writeFeedbackEvidence(fidelity, a11y, responsive);
});
