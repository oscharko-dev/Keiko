import { expect, test, type Page } from "@playwright/test";
import type { CodingWorkbenchRuntimeStateName } from "@oscharko-dev/keiko-contracts";
import { formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";
import {
  screenshotPath,
  type CodingWorkbenchEvidenceRecord,
  writeCodingWorkbenchEvidence,
} from "./support/coding-workbench-2257-evidence.js";
import { installLiveCodingWorkbenchRuntime } from "./support/coding-workbench-live-runtime.js";

const WORKBENCH_SELECTOR = 'section[aria-label="Coding Workbench"][data-state]';
const WINDOW_ID = "issue-2257-evidence-coding";
const WORKSPACE_KEY = "keiko.workspace.v4";

type Theme = "dark" | "light";
type ForcedColors = "none" | "active";
type ReducedMotion = "no-preference" | "reduce";

interface CaptureCase {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly theme: Theme;
  readonly highContrast: boolean;
  readonly forcedColors: ForcedColors;
  readonly reducedMotion: ReducedMotion;
  readonly state: CodingWorkbenchRuntimeStateName;
  readonly primaryAction: string;
  readonly focusTask?: true;
  readonly zoomEquivalent?: string;
}

const CAPTURES: readonly CaptureCase[] = [
  appearance("01-dark-820", "Dark", "dark", false, "none", "no-preference", "idle"),
  appearance("02-light-820", "Light", "light", false, "none", "no-preference", "awaiting-approval"),
  appearance(
    "03-dark-hc-820",
    "Dark High Contrast",
    "dark",
    true,
    "none",
    "no-preference",
    "recovery-required",
  ),
  appearance(
    "04-light-hc-820",
    "Light High Contrast",
    "light",
    true,
    "none",
    "no-preference",
    "idle",
  ),
  appearance(
    "05-forced-colors-820",
    "Forced colors",
    "dark",
    false,
    "active",
    "no-preference",
    "awaiting-approval",
  ),
  appearance(
    "06-reduced-motion-820",
    "Reduced motion",
    "dark",
    false,
    "none",
    "reduce",
    "recovery-required",
  ),
  widthCase("07-width-820", 820, "idle"),
  widthCase("08-width-768", 768, "awaiting-approval"),
  widthCase("09-width-560", 560, "recovery-required"),
  { ...widthCase("10-width-390-focus", 390, "idle"), focusTask: true },
  {
    ...widthCase("11-width-320-200pct", 320, "awaiting-approval"),
    zoomEquivalent: "320 CSS px is the 200% reflow equivalent of a 640 CSS px viewport",
  },
];

const records: CodingWorkbenchEvidenceRecord[] = [];

test.describe.configure({ mode: "serial" });
test.describe("#2257 retained Coding Workbench evidence", () => {
  for (const capture of CAPTURES) {
    test(capture.label, async ({ page }) => {
      records.push(await runCapture(page, capture));
    });
  }

  test.afterAll(() => {
    expect(records).toHaveLength(CAPTURES.length);
    writeCodingWorkbenchEvidence(records);
  });
});

async function runCapture(
  page: Page,
  capture: CaptureCase,
): Promise<CodingWorkbenchEvidenceRecord> {
  await configureAppearance(page, capture);
  const fixture = await installLiveCodingWorkbenchRuntime(page, { initialState: capture.state });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Coding Workbench" })).toBeVisible();
  await setHighContrast(page, capture.highContrast);
  const workbench = page.locator(WORKBENCH_SELECTOR);
  const primary = page.getByRole("button", { name: capture.primaryAction });
  await expect(workbench).toBeVisible();
  await expect(primary).toBeVisible();
  await primary.scrollIntoViewIfNeeded();
  const focusVisible = await inspectFocus(page, capture);
  const violations = seriousOrCritical(await runAxe(page, WORKBENCH_SELECTOR));
  expect(violations.length, formatViolations(violations)).toBe(0);
  const overflow = await measureOverflow(page);
  expect(overflow.documentHasHorizontalOverflow).toBe(false);
  expect(overflow.workbenchHasHorizontalOverflow).toBe(false);
  const primaryActionWithinViewport = await primary.evaluate((element, width) => {
    const bounds = element.getBoundingClientRect();
    return (
      bounds.left >= 0 &&
      bounds.right <= width + 1 &&
      bounds.top >= 0 &&
      bounds.bottom <= window.innerHeight + 1
    );
  }, capture.width);
  expect(primaryActionWithinViewport).toBe(true);
  const outerWindowWithinViewport = await frameWithinViewport(page, capture.width);
  expect(outerWindowWithinViewport).toBe(true);
  const file = `browser/${capture.id}.png`;
  await page.screenshot({ path: screenshotPath(file), fullPage: true });
  fixture.assertValidRequests();
  return captureRecord(capture, file, violations.length, focusVisible, overflow, {
    primaryActionWithinViewport,
    outerWindowWithinViewport,
    semanticTokens: await semanticTokens(workbench),
  });
}

async function frameWithinViewport(page: Page, width: number): Promise<boolean> {
  return page
    .locator(`section.window[data-window-id="${WINDOW_ID}"]`)
    .evaluate((element, viewportWidth) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= viewportWidth + 1;
    }, width);
}

async function setHighContrast(page: Page, highContrast: boolean): Promise<void> {
  await page.evaluate((enabled) => {
    if (enabled) document.documentElement.setAttribute("data-hc", "more");
    else document.documentElement.removeAttribute("data-hc");
  }, highContrast);
}

async function inspectFocus(page: Page, capture: CaptureCase): Promise<boolean | null> {
  if (capture.focusTask !== true) return null;
  const task = page.getByLabel("Task instructions");
  await task.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  const focusVisible = await task.evaluate((element) => {
    const style = getComputedStyle(element);
    return element === document.activeElement && style.outlineStyle !== "none";
  });
  expect(focusVisible).toBe(true);
  return focusVisible;
}

function captureRecord(
  capture: CaptureCase,
  file: string,
  violations: number,
  focusVisible: boolean | null,
  overflow: Pick<
    CodingWorkbenchEvidenceRecord,
    "documentHasHorizontalOverflow" | "workbenchHasHorizontalOverflow"
  >,
  measured: Pick<
    CodingWorkbenchEvidenceRecord,
    "outerWindowWithinViewport" | "primaryActionWithinViewport" | "semanticTokens"
  >,
): CodingWorkbenchEvidenceRecord {
  return {
    ...capture,
    file,
    seriousOrCriticalAxeViolations: violations,
    ...overflow,
    primaryActionVisible: true,
    ...measured,
    focusVisible,
  };
}

function appearance(
  id: string,
  label: string,
  theme: Theme,
  highContrast: boolean,
  forcedColors: ForcedColors,
  reducedMotion: ReducedMotion,
  state: CodingWorkbenchRuntimeStateName,
): CaptureCase {
  return {
    id,
    label,
    width: 820,
    theme,
    highContrast,
    forcedColors,
    reducedMotion,
    state,
    primaryAction: actionFor(state),
  };
}

function widthCase(id: string, width: number, state: CodingWorkbenchRuntimeStateName): CaptureCase {
  return {
    id,
    label: `${String(width)} px reflow`,
    width,
    theme: "dark",
    highContrast: false,
    forcedColors: "none",
    reducedMotion: "no-preference",
    state,
    primaryAction: actionFor(state),
  };
}

function actionFor(state: CodingWorkbenchRuntimeStateName): string {
  if (state === "awaiting-approval") return "Approve once";
  if (state === "recovery-required") return "Acknowledge recovery";
  return "Start coding run";
}

async function configureAppearance(page: Page, capture: CaptureCase): Promise<void> {
  await page.setViewportSize({ width: capture.width, height: 900 });
  await page.emulateMedia({
    colorScheme: capture.theme,
    forcedColors: capture.forcedColors,
    reducedMotion: capture.reducedMotion,
  });
  await page.addInitScript(
    ({ frameWidth, key, theme, windowId }) => {
      window.localStorage.setItem("keiko.theme", theme);
      window.localStorage.setItem(
        key,
        JSON.stringify([
          {
            id: windowId,
            type: "coding",
            x: 8,
            y: 42,
            w: frameWidth,
            h: 800,
            z: 10,
            zoom: 1,
            cfg: {},
            max: false,
          },
        ]),
      );
    },
    {
      // The desktop rail and canvas inset consume 84 CSS px before the window's workspace x-origin.
      frameWidth: Math.max(304, capture.width - 84),
      key: WORKSPACE_KEY,
      theme: capture.theme,
      windowId: WINDOW_ID,
    },
  );
}

async function measureOverflow(page: Page): Promise<{
  readonly documentHasHorizontalOverflow: boolean;
  readonly workbenchHasHorizontalOverflow: boolean;
}> {
  const documentHasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  const workbenchHasHorizontalOverflow = await page
    .locator(WORKBENCH_SELECTOR)
    .evaluate((element) => element.scrollWidth > element.clientWidth + 1);
  return { documentHasHorizontalOverflow, workbenchHasHorizontalOverflow };
}

async function semanticTokens(
  workbench: ReturnType<Page["locator"]>,
): Promise<Readonly<Record<string, string>>> {
  return workbench.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      textPrimary: style.getPropertyValue("--text-primary").trim(),
      surfacePrimary: style.getPropertyValue("--surface-primary").trim(),
      borderSubtle: style.getPropertyValue("--border-subtle").trim(),
      focusRing: style.getPropertyValue("--focus-ring").trim(),
    };
  });
}
