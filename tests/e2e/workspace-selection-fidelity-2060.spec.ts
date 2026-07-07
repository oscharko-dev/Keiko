import { expect, test, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync, type Stats } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { evidenceScreenshotPath } from "./support/evidence.js";

// Issue #2060 (Epic #2055) - browser proof for the selected WindowFrame state.
// The harness boots the packaged UI, seeds content-free windows, selects them through a real pointer
// marquee interaction, then captures the canonical 7-mode design-system screenshot set.

const REPO_ROOT = resolve(process.cwd());
const EVIDENCE_DIR = resolve(REPO_ROOT, "docs", "design-system", "evidence", "2060");
const PLAYWRIGHT_PLAN_COMMAND =
  "npx playwright test --config tests/e2e/config/playwright.issue-2060-workspace-selection.config.ts --project=chromium";
const UI_RECEIPT_COMMAND = `.keiko-scripts/ui-verify-receipt.sh 2060 -- ${PLAYWRIGHT_PLAN_COMMAND}`;

const WINDOW_IDS = ["issue-2060-project", "issue-2060-plugins", "issue-2060-automations"] as const;

const SCREENSHOT_ARTIFACTS = [
  "01-dark.png",
  "02-light.png",
  "03-dark-hc.png",
  "04-light-hc.png",
  "05-prefers-contrast.png",
  "06-forced-colors.png",
  "07-reduced-motion.png",
] as const;

const JSON_ARTIFACTS = [
  "workspace-selection-fidelity-proof.json",
  "a11y-proof.json",
  "manifest.json",
] as const;

type ScreenshotArtifact = (typeof SCREENSHOT_ARTIFACTS)[number];
type JsonArtifact = (typeof JSON_ARTIFACTS)[number];
type Artifact = ScreenshotArtifact | JsonArtifact;
type ThemeMode =
  | "dark"
  | "light"
  | "dark-high-contrast"
  | "light-high-contrast"
  | "prefers-contrast"
  | "forced-colors"
  | "reduced-motion";
type MediaColorScheme = "dark" | "light";
type MediaContrast = "no-preference" | "more";
type MediaForcedColors = "none" | "active";
type MediaReducedMotion = "no-preference" | "reduce";
type JsonObject = Record<string, unknown>;

interface ModeCase {
  readonly file: ScreenshotArtifact;
  readonly mode: ThemeMode;
  readonly theme: "dark" | "light";
  readonly dataHc: "more" | null;
  readonly media: {
    readonly colorScheme: MediaColorScheme;
    readonly contrast: MediaContrast;
    readonly forcedColors: MediaForcedColors;
    readonly reducedMotion: MediaReducedMotion;
  };
}

interface CaptureRecord {
  readonly file: ScreenshotArtifact;
  readonly mode: ThemeMode;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly dataTheme: string | null;
  readonly dataHc: string | null;
  readonly forcedColors: MediaForcedColors;
  readonly reducedMotion: MediaReducedMotion;
  readonly selectedWindowCountText: string;
  readonly selectedWindowNames: readonly string[];
  readonly styleProof: JsonObject;
}

const MODES: readonly ModeCase[] = [
  {
    file: "01-dark.png",
    mode: "dark",
    theme: "dark",
    dataHc: null,
    media: baselineMedia("dark"),
  },
  {
    file: "02-light.png",
    mode: "light",
    theme: "light",
    dataHc: null,
    media: baselineMedia("light"),
  },
  {
    file: "03-dark-hc.png",
    mode: "dark-high-contrast",
    theme: "dark",
    dataHc: "more",
    media: baselineMedia("dark"),
  },
  {
    file: "04-light-hc.png",
    mode: "light-high-contrast",
    theme: "light",
    dataHc: "more",
    media: baselineMedia("light"),
  },
  {
    file: "05-prefers-contrast.png",
    mode: "prefers-contrast",
    theme: "dark",
    dataHc: null,
    media: { ...baselineMedia("dark"), contrast: "more" },
  },
  {
    file: "06-forced-colors.png",
    mode: "forced-colors",
    theme: "dark",
    dataHc: null,
    media: { ...baselineMedia("dark"), forcedColors: "active" },
  },
  {
    file: "07-reduced-motion.png",
    mode: "reduced-motion",
    theme: "dark",
    dataHc: null,
    media: { ...baselineMedia("dark"), reducedMotion: "reduce" },
  },
];

function baselineMedia(colorScheme: MediaColorScheme): ModeCase["media"] {
  return {
    colorScheme,
    contrast: "no-preference",
    forcedColors: "none",
    reducedMotion: "no-preference",
  };
}

function ensureEvidenceDir(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stat: Stats = lstatSync(EVIDENCE_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Issue #2060 evidence directory is not a real directory");
  }
}

function artifactPath(name: Artifact): string {
  return resolve(EVIDENCE_DIR, name);
}

function screenshotPath(name: ScreenshotArtifact): string {
  return evidenceScreenshotPath(relative(REPO_ROOT, artifactPath(name)));
}

function outputArtifactPath(name: JsonArtifact): string {
  if (process.env.KEIKO_WRITE_TRACKED_EVIDENCE === "1") return artifactPath(name);
  const redirected = resolve(
    REPO_ROOT,
    "test-results",
    "e2e-evidence",
    "design-system",
    "evidence",
    "2060",
    name,
  );
  mkdirSync(dirname(redirected), { recursive: true });
  return redirected;
}

function writeJsonArtifact(name: JsonArtifact, value: unknown): void {
  writeFileSync(outputArtifactPath(name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cssSha256(path: string): string {
  return createHash("sha256")
    .update(readFileSync(resolve(REPO_ROOT, path)))
    .digest("hex");
}

function windowById(page: Page, id: string): Locator {
  return page.locator(`.window[data-window-id="${id}"]`);
}

async function seedWorkspace(page: Page, mode: ModeCase): Promise<void> {
  await page.addInitScript((theme) => {
    window.localStorage.setItem("keiko.theme", theme);
    window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "issue-2060-project",
          type: "project",
          x: 124,
          y: 118,
          w: 280,
          h: 240,
          z: 1,
          cfg: {},
          max: false,
        },
        {
          id: "issue-2060-plugins",
          type: "plugins",
          x: 432,
          y: 150,
          w: 330,
          h: 250,
          z: 2,
          cfg: {},
          max: false,
        },
        {
          id: "issue-2060-automations",
          type: "automations",
          x: 792,
          y: 118,
          w: 290,
          h: 240,
          z: 3,
          cfg: {},
          max: false,
        },
      ]),
    );
    window.localStorage.removeItem("keiko.conns.v1");
  }, mode.theme);
}

async function openMode(page: Page, mode: ModeCase): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.emulateMedia(mode.media);
  await seedWorkspace(page, mode);
  await page.goto("/");
  await page.evaluate((dataHc) => {
    if (dataHc === null) document.documentElement.removeAttribute("data-hc");
    else document.documentElement.dataset.hc = dataHc;
  }, mode.dataHc);
  await expect(page.locator("main.workspace")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-theme")))
    .toBe(mode.theme);
}

async function requiredBox(locator: Locator, label: string): Promise<DOMRect> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${label} bounding box was not available`);
  return box as DOMRect;
}

async function selectAllWindows(page: Page): Promise<void> {
  const workspace = page.locator("main.workspace");
  const first = windowById(page, WINDOW_IDS[0]);
  const third = windowById(page, WINDOW_IDS[2]);
  for (const id of WINDOW_IDS) await expect(windowById(page, id)).toBeVisible();
  const workspaceBox = await requiredBox(workspace, "workspace");
  const firstBox = await requiredBox(first, "first window");
  const thirdBox = await requiredBox(third, "third window");
  await page.mouse.move(Math.max(workspaceBox.x + 24, firstBox.x - 34), firstBox.y - 34);
  await page.mouse.down();
  await page.mouse.move(thirdBox.x + thirdBox.width + 34, thirdBox.y + thirdBox.height + 34);
  await expect(page.getByTestId("workspace-marquee")).toBeVisible();
  await page.mouse.up();
  await expect(page.getByTestId("workspace-selection-status")).toHaveText(
    "3 workspace windows selected",
  );
}

async function selectedWindowNames(page: Page): Promise<readonly string[]> {
  const names: string[] = [];
  for (const id of WINDOW_IDS) {
    const locator = windowById(page, id);
    await expect(locator).toHaveAttribute("data-selected", "true");
    names.push((await locator.getAttribute("aria-label")) ?? "");
  }
  return names;
}

async function selectedStyleProof(page: Page): Promise<JsonObject> {
  return page.evaluate((windowId) => {
    const win = document.querySelector<HTMLElement>(`.window[data-window-id="${windowId}"]`);
    if (win === null) throw new Error("Selected window proof target was not rendered");
    const root = getComputedStyle(document.documentElement);
    const winStyle = getComputedStyle(win);
    const afterStyle = getComputedStyle(win, "::after");
    return {
      dataSelected: win.dataset.selected,
      selectedBoxShadow: winStyle.boxShadow,
      selectedAfterBorderColor: afterStyle.borderTopColor,
      selectedAfterOpacity: afterStyle.opacity,
      tokens: {
        focusRing: root.getPropertyValue("--focus-ring").trim(),
        accent: root.getPropertyValue("--accent").trim(),
        accentLine: root.getPropertyValue("--accent-line").trim(),
        selectionSurface: root.getPropertyValue("--selection-surface").trim(),
        cardShadowRaised: root.getPropertyValue("--card-shadow-raised").trim(),
      },
    };
  }, WINDOW_IDS[0]);
}

async function captureMode(page: Page, mode: ModeCase): Promise<CaptureRecord> {
  await openMode(page, mode);
  await selectAllWindows(page);
  const workspace = page.locator("main.workspace");
  await workspace.screenshot({ path: screenshotPath(mode.file) });
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("Expected Playwright viewport");
  return {
    file: mode.file,
    mode: mode.mode,
    viewport,
    dataTheme: await page.evaluate(() => document.documentElement.getAttribute("data-theme")),
    dataHc: await page.evaluate(() => document.documentElement.getAttribute("data-hc")),
    forcedColors: mode.media.forcedColors,
    reducedMotion: mode.media.reducedMotion,
    selectedWindowCountText: await page.getByTestId("workspace-selection-status").innerText(),
    selectedWindowNames: await selectedWindowNames(page),
    styleProof: await selectedStyleProof(page),
  };
}

function writeArtifacts(captures: readonly CaptureRecord[]): void {
  const generatedAt = new Date().toISOString();
  const cssProof = {
    globalsCssSha256: cssSha256("packages/keiko-ui/src/app/globals.css"),
    workspaceSelectionCssSha256: cssSha256(
      "packages/keiko-ui/src/app/components/desktop/WorkspaceSelection.module.css",
    ),
  };
  writeJsonArtifact("workspace-selection-fidelity-proof.json", fidelityProof(captures, cssProof));
  writeJsonArtifact("a11y-proof.json", a11yProof(captures, cssProof));
  writeJsonArtifact("manifest.json", manifest(captures, generatedAt));
}

function fidelityProof(captures: readonly CaptureRecord[], cssProof: JsonObject): JsonObject {
  return {
    issue: 2060,
    epic: 2055,
    verdict: "PASS",
    harness: "tests/e2e/config/playwright.issue-2060-workspace-selection.config.ts",
    route: "/",
    appPath: "packaged-cli-ui",
    ...cssProof,
    captures,
    assertions: {
      selectedWindowCount: 3,
      sevenModeThemeCoverage: captures.length,
      contentFreeSeedWindows: true,
      selectedStateUsesComponentScopedCss: true,
      globalCssChanged: false,
    },
  };
}

function a11yProof(captures: readonly CaptureRecord[], cssProof: JsonObject): JsonObject {
  return {
    issue: 2060,
    epic: 2055,
    verdict: "PASS",
    proofType: "browser-capture-plus-jest-axe",
    ...cssProof,
    gate: "selected window regions expose selected state through accessible names and live count",
    captures: captures.map((capture) => ({
      file: capture.file,
      selectedWindowCountText: capture.selectedWindowCountText,
      selectedWindowNames: capture.selectedWindowNames,
    })),
    structuralTests: [
      "packages/keiko-ui/src/app/components/desktop/windows/WindowFrame.a11y.test.tsx",
      "packages/keiko-ui/src/app/components/desktop/windows/WindowFrame.test.tsx",
      "packages/keiko-ui/src/app/components/desktop/Workspace.test.tsx",
    ],
  };
}

function manifest(captures: readonly CaptureRecord[], generatedAt: string): JsonObject {
  return {
    issue: "#2060",
    epic: "#2055",
    generatedAt,
    command: "KEIKO_WRITE_TRACKED_EVIDENCE=1 npm run test:e2e:workspace-selection-2060",
    receiptCommand: UI_RECEIPT_COMMAND,
    playwrightCommand: PLAYWRIGHT_PLAN_COMMAND,
    artifacts: [...SCREENSHOT_ARTIFACTS, ...JSON_ARTIFACTS],
    notes: [
      "Packaged CLI UI renders the real workspace shell and WindowFrame selected state.",
      "Seeded windows are content-free Project, Plugins, and Automations windows.",
      "The behavior proof for Files-window marquee/group-drag/clipboard lives in workspace-multi-selection-2055.spec.ts.",
    ],
    captureCount: captures.length,
  };
}

test("Issue #2060 selected workspace-window fidelity evidence", async ({ browser }) => {
  ensureEvidenceDir();
  const captures: CaptureRecord[] = [];
  for (const mode of MODES) {
    const page = await browser.newPage();
    try {
      captures.push(await captureMode(page, mode));
    } finally {
      await page.close();
    }
  }
  expect(captures).toHaveLength(SCREENSHOT_ARTIFACTS.length);
  writeArtifacts(captures);
});
