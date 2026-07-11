import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";
import {
  feedback2074ScreenshotPath,
  writeFeedback2074Evidence,
  type Feedback2074Capture,
  type Feedback2074Screenshot,
} from "./support/feedback-2074-evidence.js";
import {
  BASELINE_FEEDBACK_MODE,
  FEEDBACK_MODES,
  resizeFeedbackWindowToWidth,
  type FeedbackMode,
} from "./support/feedback-2073.js";

const RECEIPT = {
  receiptId: "A".repeat(22),
  receiptSecret: "A".repeat(43),
  expiresAt: "2026-08-10T00:00:00.000Z",
};

const COPY_TEXT = `Receipt ID: ${RECEIPT.receiptId}\nReceipt secret: ${RECEIPT.receiptSecret}\nExpires at: ${RECEIPT.expiresAt}`;

interface Labels {
  readonly general: string;
  readonly open: string;
  readonly continue: string;
  readonly productVersion: string;
  readonly title: string;
  readonly description: string;
  readonly steps: string;
  readonly expected: string;
  readonly actual: string;
  readonly scan: string;
  readonly continueSubmission: string;
  readonly submit: string;
  readonly copy: string;
  readonly copied: string;
  readonly copyError: string;
  readonly rateLimited: string;
  readonly warning: string;
  readonly edit: string;
  readonly publicFallback: string;
}

const LABELS: Readonly<Record<"en" | "de", Labels>> = {
  en: {
    general: "General",
    open: "Open feedback",
    continue: "Continue with ordinary feedback",
    productVersion: "Product version",
    title: "Title",
    description: "Description",
    steps: "Steps to reproduce",
    expected: "Expected result",
    actual: "Actual result",
    scan: "Scan and preview",
    continueSubmission: "Continue to submission",
    submit: "Submit feedback",
    copy: "Copy one-time receipt",
    copied: "Receipt copied. Keiko cleared it from this feedback window.",
    copyError: "Keiko could not copy the receipt. It remains available in this feedback window.",
    rateLimited: "Feedback submission paused",
    warning: "Warning",
    edit: "Edit feedback",
    publicFallback: "Open public GitHub form",
  },
  de: {
    general: "Allgemein",
    open: "Feedback oeffnen",
    continue: "Mit normalem Feedback fortfahren",
    productVersion: "Produktversion",
    title: "Titel",
    description: "Beschreibung",
    steps: "Schritte zum Reproduzieren",
    expected: "Erwartetes Ergebnis",
    actual: "Tatsaechliches Ergebnis",
    scan: "Pruefen und Vorschau anzeigen",
    continueSubmission: "Weiter zur Uebermittlung",
    submit: "Feedback uebermitteln",
    copy: "Einmaligen Beleg kopieren",
    copied: "Beleg kopiert. Keiko hat ihn aus diesem Feedback-Fenster entfernt.",
    copyError:
      "Keiko konnte den Beleg nicht kopieren. Er bleibt in diesem Feedback-Fenster verfuegbar.",
    rateLimited: "Feedback-Uebermittlung pausiert",
    warning: "Warnung",
    edit: "Feedback bearbeiten",
    publicFallback: "Oeffentliches GitHub-Formular oeffnen",
  },
};

function screenshot(
  mode: FeedbackMode,
  state: "accepted-copied" | "rate-limited",
): Feedback2074Screenshot {
  return `${mode.file.slice(0, -4)}-${state}.png` as Feedback2074Screenshot;
}

async function boot(
  page: Page,
  locale: "en" | "de",
  mode: FeedbackMode = BASELINE_FEEDBACK_MODE,
): Promise<{ readonly feedback: Locator; readonly labels: Labels }> {
  const labels = LABELS[locale];
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(
    ({ dataHc, locale: selectedLocale, theme }) => {
      localStorage.setItem("keiko.locale", selectedLocale);
      localStorage.setItem("keiko.theme", theme);
      localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
      localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: "issue-2074-settings",
            type: "settings",
            x: 32,
            y: 28,
            w: 500,
            h: 680,
            z: 10,
            cfg: {},
            max: false,
          },
        ]),
      );
      if (dataHc === null) document.documentElement.removeAttribute("data-hc");
      else document.documentElement.dataset.hc = dataHc;
    },
    { dataHc: mode.dataHc, locale, theme: mode.theme },
  );
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.emulateMedia(mode.media);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-locale", locale);
  const settings = page.locator('.window[data-window-id="issue-2074-settings"]');
  await settings.getByRole("button", { name: labels.general }).click();
  await settings.getByRole("button", { name: labels.open }).click();
  const feedback = page.locator('.window[data-window-id="feedback"]');
  await expect(feedback).toBeVisible();
  await feedback.getByRole("button", { name: labels.continue }).click();
  await feedback.getByLabel(labels.productVersion).fill("0.2.14");
  await feedback.getByLabel(labels.title, { exact: true }).fill("Safe feedback title");
  await feedback.getByLabel(labels.description, { exact: true }).fill("Safe feedback description.");
  await feedback.getByLabel(labels.steps).fill("Open Settings.");
  await feedback.getByLabel(labels.expected).fill("Feedback opens.");
  await feedback.getByLabel(labels.actual).fill("Feedback waits for review.");
  await feedback.getByRole("button", { name: labels.scan }).click();
  await expect(
    feedback.getByRole("region", { name: /Sanitized preview|Bereinigte Vorschau/u }),
  ).toBeVisible();
  return { feedback, labels };
}

async function forceClipboardFailure(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async (): Promise<void> => Promise.reject(new Error("clipboard blocked")),
    });
  });
}

async function confirm(feedback: Locator, labels: Labels): Promise<Locator> {
  const preview = feedback.getByRole("region", { name: /Sanitized preview|Bereinigte Vorschau/u });
  await preview.getByRole("checkbox").check();
  await preview.getByRole("button", { name: labels.continueSubmission }).click();
  return preview.getByRole("button", { name: labels.submit });
}

async function stubSubmit(page: Page, outcome: "accepted" | "rate-limited"): Promise<void> {
  await page.route("**/api/feedback/submit", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(outcome === "accepted" ? { outcome, receipt: RECEIPT } : { outcome }),
    }),
  );
}

async function captureStyle(
  page: Page,
  result: Locator,
): Promise<Readonly<Record<string, string>>> {
  return result.evaluate((element) => {
    const root = getComputedStyle(document.documentElement);
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      borderColor: style.borderTopColor,
      warning: root.getPropertyValue("--feedback-warning").trim(),
      warningSurface: root.getPropertyValue("--feedback-warning-surface").trim(),
    };
  });
}

async function assertForcedColorsActionReadability(
  page: Page,
  controls: readonly Locator[],
): Promise<void> {
  const system = await page.evaluate(() => {
    const probe = document.createElement("button");
    probe.style.background = "ButtonFace";
    probe.style.color = "ButtonText";
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const values = { background: style.backgroundColor, color: style.color };
    probe.remove();
    return values;
  });
  for (const control of controls) {
    const style = await control.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        background: computed.backgroundColor,
        color: computed.color,
        textFill: computed.getPropertyValue("-webkit-text-fill-color"),
        forcedColorAdjust: computed.forcedColorAdjust,
      };
    });
    expect(style.background).toBe(system.background);
    expect(style.color).toBe(system.color);
    expect(style.textFill).toBe(system.color);
    expect(style.forcedColorAdjust).toBe("auto");
  }
}

async function acceptAndCopy(
  page: Page,
  locale: "en" | "de",
  mode?: FeedbackMode,
): Promise<Locator> {
  await stubSubmit(page, "accepted");
  const { feedback, labels } = await boot(page, locale, mode);
  await expect(feedback.getByRole("button", { name: labels.publicFallback })).toBeVisible();
  await (await confirm(feedback, labels)).click();
  await expect(feedback).not.toContainText(RECEIPT.receiptSecret);
  const copy = feedback.getByRole("button", { name: labels.copy });
  await copy.focus();
  await copy.click();
  const copied = feedback.locator("p").filter({ hasText: labels.copied });
  await expect(copied).toBeFocused();
  await expect(copy).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(COPY_TEXT);
  return feedback;
}

test.describe("Issue #2074 packaged feedback receipt and conflict journeys", () => {
  for (const locale of ["en", "de"] as const) {
    test(`${locale}: accepted receipt copies once and moves focus to its surviving status`, async ({
      page,
    }) => {
      await acceptAndCopy(page, locale);
    });

    test(`${locale}: clipboard failure retains the receipt until an edit clears it`, async ({
      page,
    }) => {
      await stubSubmit(page, "accepted");
      const { feedback, labels } = await boot(page, locale);
      await (await confirm(feedback, labels)).click();
      await forceClipboardFailure(page);
      await feedback.getByRole("button", { name: labels.copy }).click();
      await expect(feedback.getByText(labels.copyError)).toBeVisible();
      await expect(feedback.getByRole("button", { name: labels.copy })).toBeVisible();
      await expect(feedback.getByText(RECEIPT.receiptId)).toBeVisible();
      const title = feedback.getByLabel(labels.title, { exact: true });
      await title.fill("Edited safe feedback title");
      await expect(title).toBeFocused();
      await expect(feedback.getByRole("button", { name: labels.copy })).toHaveCount(0);
      await expect(feedback.getByText(RECEIPT.receiptId)).toHaveCount(0);
    });

    test(`${locale}: rate-limited recovery is conflict-safe and returns to title editing`, async ({
      page,
    }) => {
      await stubSubmit(page, "rate-limited");
      const { feedback, labels } = await boot(page, locale);
      await (await confirm(feedback, labels)).click();
      const result = feedback.getByRole("region", { name: labels.rateLimited });
      await expect(result).toBeFocused();
      await expect(result.getByText(labels.warning)).toBeVisible();
      await expect(result.locator("svg")).toHaveCount(1);
      await expect(result).not.toContainText(/limit|threshold|minute|hour|class/iu);
      await result.getByRole("button", { name: labels.edit }).click();
      await expect(feedback.getByLabel(labels.title, { exact: true })).toBeFocused();
      await expect(feedback.getByRole("region", { name: labels.rateLimited })).toHaveCount(0);
    });
  }
});

test("Issue #2074 fidelity evidence", async ({ browser }) => {
  const captures: Feedback2074Capture[] = [];
  for (const mode of FEEDBACK_MODES) {
    const context = await browser.newContext({
      bypassCSP: true,
      viewport: { width: 1440, height: 980 },
    });
    try {
      const accepted = await context.newPage();
      const feedback = await acceptAndCopy(accepted, "en", mode);
      const acceptedViolations = await runAxe(accepted, '.window[data-window-id="feedback"]');
      const copied = feedback.locator("p").filter({ hasText: LABELS.en.copied });
      await feedback.screenshot({
        path: feedback2074ScreenshotPath(screenshot(mode, "accepted-copied")),
        animations: "disabled",
      });
      captures.push({
        file: screenshot(mode, "accepted-copied"),
        state: "accepted-copied",
        mode: mode.name,
        locale: "en",
        focusText: (await copied.textContent()) ?? "",
        seriousOrCritical: seriousOrCritical(acceptedViolations),
        style: await captureStyle(accepted, copied),
      });

      const limited = await context.newPage();
      await stubSubmit(limited, "rate-limited");
      const { feedback: rateFeedback, labels } = await boot(limited, "en", mode);
      await (await confirm(rateFeedback, labels)).click();
      const result = rateFeedback.getByRole("region", { name: labels.rateLimited });
      if (mode.name === "forced-colors") {
        await assertForcedColorsActionReadability(limited, [
          result.getByRole("button", { name: labels.edit }),
          rateFeedback.getByRole("button", { name: labels.publicFallback }),
        ]);
      }
      const violations = await runAxe(limited, '.window[data-window-id="feedback"]');
      await rateFeedback.screenshot({
        path: feedback2074ScreenshotPath(screenshot(mode, "rate-limited")),
        animations: "disabled",
      });
      captures.push({
        file: screenshot(mode, "rate-limited"),
        state: "rate-limited",
        mode: mode.name,
        locale: "en",
        focusText: (await result.textContent()) ?? "",
        seriousOrCritical: seriousOrCritical(violations),
        style: await captureStyle(limited, result),
      });
    } finally {
      await context.close();
    }
  }
  const responsiveContext = await browser.newContext({
    bypassCSP: true,
    viewport: { width: 1440, height: 980 },
  });
  try {
    const page = await responsiveContext.newPage();
    await stubSubmit(page, "rate-limited");
    const { feedback, labels } = await boot(page, "en");
    await (await confirm(feedback, labels)).click();
    await resizeFeedbackWindowToWidth(page, feedback, 500);
    const result = feedback.getByRole("region", { name: labels.rateLimited });
    const violations = await runAxe(page, '.window[data-window-id="feedback"]');
    await feedback.screenshot({
      path: feedback2074ScreenshotPath("08-responsive-500-rate-limited.png"),
      animations: "disabled",
    });
    captures.push({
      file: "08-responsive-500-rate-limited.png",
      state: "rate-limited",
      mode: "responsive-500",
      locale: "en",
      focusText: (await result.textContent()) ?? "",
      seriousOrCritical: seriousOrCritical(violations),
      style: await captureStyle(page, result),
    });
  } finally {
    await responsiveContext.close();
  }
  const blocking = captures.flatMap((capture) => capture.seriousOrCritical);
  expect(blocking, formatViolations(blocking)).toEqual([]);
  writeFeedback2074Evidence(captures);
});
