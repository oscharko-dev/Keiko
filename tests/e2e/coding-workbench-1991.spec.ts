import { expect, test, type Page, type Route } from "@playwright/test";
import { type AxeViolation, formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";
import { evidenceScreenshotPath } from "./support/evidence.js";

type JsonObject = Record<string, unknown>;
type CodingWorkbenchSeedState = "governed-assist" | "governed-assist-blocked";

const WORKSPACE_KEY = "keiko.workspace.v4";

function sidecarProfile(): JsonObject {
  return {
    status: "available",
    profileId: "gateway-redacted",
    modelAlias: "model-redacted",
    localEndpointPath: "/api/coding-sidecar/gateway/chat/completions",
    supportsStreaming: true,
    supportsToolCalling: true,
    runMetadata: {
      maxPromptTokens: 200_000,
      maxOutputTokens: 16_000,
      maxInputMessages: 64,
      maxRequestBytes: 1_000_000,
    },
  };
}

function codexProfile(): JsonObject {
  return {
    schemaVersion: "1",
    profileId: "codex-subscription",
    modelSource: "chatgpt-codex-subscription-profile",
    runtimeSource: "codex-cli-adapter",
    status: "connected",
    authMethod: "codex-access-token",
    credentialStore: "file",
    stateScope: "keiko-owned-state",
    stateRoot: "keiko-codex-runtime-state",
    usesGlobalCodexHome: false,
    runtimeBinarySources: ["managed-sidecar-runtime"],
    supportsBrowserLogin: true,
    supportsDeviceCode: true,
    supportsAccessToken: true,
    deploymentPolicyDisabled: false,
    headless: false,
  };
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function installCodingProfileRoutes(page: Page): Promise<void> {
  await page.route("**/api/coding-sidecar/gateway/profile", async (route) => {
    await fulfillJson(route, sidecarProfile());
  });
  await page.route("**/api/coding-workbench/codex-subscription/profile", async (route) => {
    await fulfillJson(route, codexProfile());
  });
}

function codingWindow(
  state: CodingWorkbenchSeedState,
  overrides: Readonly<Partial<Record<"x" | "y" | "w" | "h", number>>> = {},
): JsonObject {
  return {
    id: `issue-1991-coding-${state}`,
    type: "coding",
    x: 70,
    y: 58,
    w: 900,
    h: 700,
    ...overrides,
    z: 10,
    cfg: { state },
    max: false,
  };
}

async function replaceCodingWindow(
  page: Page,
  state: CodingWorkbenchSeedState,
  overrides: Readonly<Partial<Record<"x" | "y" | "w" | "h", number>>> = {},
): Promise<void> {
  await page.addInitScript(
    ({ key, win }) => {
      window.localStorage.setItem(key, JSON.stringify([win]));
      window.localStorage.removeItem("keiko.conns.v1");
    },
    { key: WORKSPACE_KEY, win: codingWindow(state, overrides) },
  );
  await page.reload({ waitUntil: "domcontentloaded" });
}

async function visibleWorkbench(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: /Issue #1991 Governed Assist/u })).toBeVisible();
  await expect(page.locator('section[aria-label="Coding Workbench"][data-state]')).toBeVisible();
}

function unexplainedViolations(violations: readonly AxeViolation[]): readonly AxeViolation[] {
  return seriousOrCritical(violations);
}

test("governed assist proposed diff remains review-only @smoke", async ({ page }) => {
  await installCodingProfileRoutes(page);
  await page.goto("/");
  await replaceCodingWindow(page, "governed-assist");
  await visibleWorkbench(page);

  await expect(page.getByText("Proposed diff only")).toBeVisible();
  await expect(page.getByText("120 added, 14 deleted")).toBeVisible();
  await expect(
    page.getByText("No file, Git, PR, merge, or external write authority"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve once" })).toHaveCount(0);
  await expect(page.getByText(/diff --git|access token|refresh token/iu)).toHaveCount(0);
  await page.screenshot({
    path: evidenceScreenshotPath("docs/design-system/evidence/1991/01-proposed-diff.png"),
  });
});

test("governed assist blocked actions show policy reasons @smoke", async ({ page }) => {
  await installCodingProfileRoutes(page);
  await page.goto("/");
  await replaceCodingWindow(page, "governed-assist-blocked");
  await visibleWorkbench(page);

  await expect(page.getByText("Governance holds")).toBeVisible();
  await expect(page.getByText(/workspace-write denied in Governed Assist/iu)).toBeVisible();
  await expect(page.getByText(/command-execution denied/iu)).toBeVisible();
  await expect(
    page.getByText(/connector-write denied; external systems stay read-only/iu),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve once" })).toHaveCount(0);
  await page.screenshot({
    path: evidenceScreenshotPath("docs/design-system/evidence/1991/02-blocked-action.png"),
  });
});

test("governed assist narrow viewport has no serious axe violations @smoke", async ({ page }) => {
  await installCodingProfileRoutes(page);
  await page.setViewportSize({ width: 390, height: 860 });
  await page.goto("/");
  await replaceCodingWindow(page, "governed-assist-blocked", { x: 54, y: 54, w: 330, h: 720 });
  await visibleWorkbench(page);

  const workbench = page.locator('section[aria-label="Coding Workbench"][data-state]');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
  ).toBe(false);
  expect(await workbench.evaluate((node) => node.scrollWidth > node.clientWidth + 1)).toBe(false);
  const violations = unexplainedViolations(
    await runAxe(page, 'section[aria-label="Coding Workbench"][data-state]'),
  );
  expect(violations.length, formatViolations(violations)).toBe(0);
  await page.screenshot({
    path: evidenceScreenshotPath("docs/design-system/evidence/1991/03-blocked-narrow.png"),
  });
});
