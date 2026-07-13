import { expect, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const WORKBENCH = 'section[aria-label="Coding Workbench"][data-state]';

export async function openWorkbench(page: Page): Promise<void> {
  await page.goto("/");
  if (await page.locator(WORKBENCH).isVisible()) return;
  await page.getByRole("button", { name: "Coding Workbench", exact: true }).click();
  await expect(page.locator(WORKBENCH)).toBeVisible();
}

export async function prepareAppearance(
  page: Page,
  input: {
    readonly width: number;
    readonly theme: "dark" | "light";
    readonly reducedMotion: boolean;
    readonly forcedColors?: "active" | "none";
    readonly highContrast?: boolean;
  },
): Promise<void> {
  await page.setViewportSize({ width: input.width, height: 900 });
  await page.emulateMedia({
    colorScheme: input.theme,
    forcedColors: input.forcedColors ?? "none",
    reducedMotion: input.reducedMotion ? "reduce" : "no-preference",
  });
  await page.addInitScript((theme) => {
    window.localStorage.setItem("keiko.theme", theme);
  }, input.theme);
  if (input.highContrast === true) {
    await page.addInitScript(() => {
      document.documentElement.setAttribute("data-hc", "more");
    });
  }
}

export async function resetLiveScenario(
  page: Page,
  mode: "productive" | "out-of-scope" = "productive",
): Promise<void> {
  const response = await page.request.post(`/_keiko-2258-test/reset?mode=${mode}`);
  expect(response.status()).toBe(204);
  await expect
    .poll(() => liveHarnessStatus(page))
    .toMatchObject({
      fixtureSourceDigestMatches: true,
      workspaceHeadMatchesFixture: true,
      workspaceHealthy: true,
      scriptCalls: 0,
    });
}

export async function liveHarnessStatus(page: Page): Promise<{
  readonly outsideUnchanged: boolean;
  readonly outOfScopeAttemptRecorded: boolean;
  readonly workspaceDriftInjected: boolean;
  readonly fixtureSourceDigestMatches: boolean;
  readonly workspaceHeadMatchesFixture: boolean;
  readonly workspaceHealthy: boolean;
  readonly scriptCalls: number;
}> {
  const response = await page.request.get(`/_keiko-2258-test/status`);
  expect(response.status()).toBe(200);
  const status: unknown = await response.json();
  if (!isHarnessStatus(status)) throw new Error("invalid-live-harness-status");
  return status;
}

export async function injectWorkspaceDrift(page: Page): Promise<void> {
  const response = await page.request.post(`/_keiko-2258-test/drift`);
  expect(response.status()).toBe(204);
}

export async function injectRecoveryRequiredOnStop(page: Page): Promise<void> {
  const response = await page.request.post(`/_keiko-2258-test/recovery`);
  expect(response.status()).toBe(204);
}

export async function captureLiveProof(page: Page, testInfo: TestInfo, id: string): Promise<void> {
  if (process.env.KEIKO_2258_CAPTURE !== "1") return;
  const path = join(testInfo.outputDir, "proof", `${id}.png`);
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(`${id}.proof.json`, {
    body: JSON.stringify({ issue: 2258, status: "captured", screenshot: `${id}.png` }),
    contentType: "application/json",
  });
}

export async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
}

function isHarnessStatus(value: unknown): value is {
  readonly outsideUnchanged: boolean;
  readonly outOfScopeAttemptRecorded: boolean;
  readonly workspaceDriftInjected: boolean;
  readonly fixtureSourceDigestMatches: boolean;
  readonly workspaceHeadMatchesFixture: boolean;
  readonly workspaceHealthy: boolean;
  readonly scriptCalls: number;
} {
  if (typeof value !== "object" || value === null) return false;
  const status = value as Record<string, unknown>;
  return (
    typeof status.outsideUnchanged === "boolean" &&
    typeof status.outOfScopeAttemptRecorded === "boolean" &&
    typeof status.workspaceDriftInjected === "boolean" &&
    typeof status.fixtureSourceDigestMatches === "boolean" &&
    typeof status.workspaceHeadMatchesFixture === "boolean" &&
    typeof status.workspaceHealthy === "boolean" &&
    typeof status.scriptCalls === "number"
  );
}
