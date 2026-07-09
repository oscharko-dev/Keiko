import { expect, test, type Page, type Route } from "@playwright/test";
import { type AxeViolation, formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";
import { evidenceScreenshotPath } from "./support/evidence.js";

type JsonObject = Record<string, unknown>;
type CodingWorkbenchSeedState =
  "empty" | "running" | "approval-required" | "blocked" | "failed" | "completed";

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

function codingWindow(state: CodingWorkbenchSeedState): JsonObject {
  return {
    id: `issue-1990-coding-${state}`,
    type: "coding",
    x: 70,
    y: 58,
    w: 900,
    h: 700,
    z: 10,
    cfg: { state },
    max: false,
  };
}

async function replaceCodingWindow(page: Page, state: CodingWorkbenchSeedState): Promise<void> {
  await page.addInitScript(
    ({ key, win }) => {
      window.localStorage.setItem(key, JSON.stringify([win]));
      window.localStorage.removeItem("keiko.conns.v1");
    },
    { key: WORKSPACE_KEY, win: codingWindow(state) },
  );
  await page.reload({ waitUntil: "domcontentloaded" });
}

async function visibleWorkbench(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: /Coding Workbench|Ready for a coding run/u }),
  ).toBeVisible();
  await expect(page.locator('section[aria-label="Coding Workbench"][data-state]')).toBeVisible();
}

function unexplainedViolations(violations: readonly AxeViolation[]): readonly AxeViolation[] {
  return seriousOrCritical(violations);
}

test("opens the Coding Workbench from the rail with usable pre-run authority @smoke", async ({
  page,
}) => {
  await installCodingProfileRoutes(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Coding Workbench" }).click();

  await expect(page.getByRole("heading", { name: "Ready for a coding run" })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Coding autonomy mode" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Governed Assist/u })).toBeEnabled();
  await expect(page.getByRole("radio", { name: /Autonomous Delivery/u })).toBeDisabled();
  await expect(page.getByText("ChatGPT/Codex subscription profile")).toBeVisible();
  await expect(page.getByText("Connected")).toBeVisible();
  await page.screenshot({
    path: evidenceScreenshotPath("docs/design-system/evidence/1990/01-empty-desktop.png"),
  });
});

test("empty workbench captures Light and High-Contrast appearance @smoke", async ({ page }) => {
  await installCodingProfileRoutes(page);
  await page.addInitScript(() => {
    window.localStorage.setItem("keiko.theme", "light");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Coding Workbench" }).click();
  await expect(page.getByRole("heading", { name: "Ready for a coding run" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({
    path: evidenceScreenshotPath("docs/design-system/evidence/1990/04-empty-light.png"),
  });

  await page.evaluate(() => {
    document.documentElement.setAttribute("data-hc", "more");
  });
  await expect(page.locator("html")).toHaveAttribute("data-hc", "more");
  await page.screenshot({
    path: evidenceScreenshotPath("docs/design-system/evidence/1990/05-empty-high-contrast.png"),
  });
});

test("running and approval-required states keep operator controls active @smoke", async ({
  page,
}) => {
  await installCodingProfileRoutes(page);
  await page.goto("/");
  await replaceCodingWindow(page, "running");
  await visibleWorkbench(page);

  const workbench = page.locator('section[aria-label="Coding Workbench"][data-state]');
  await expect(page.getByRole("button", { name: "Stop sidecar" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Take over manually" })).toBeEnabled();
  await page.getByRole("button", { name: "Stop sidecar" }).click();
  await expect(workbench.getByRole("status")).toContainText("Stop requested");

  await replaceCodingWindow(page, "approval-required");
  await visibleWorkbench(page);
  await expect(page.getByRole("heading", { name: "Just-in-time approval" })).toBeVisible();
  await expect(page.getByText(/workspace write requested/iu)).toBeVisible();
  await expect(page.getByText(/diff --git|access token|refresh token/iu)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop sidecar" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Take over manually" })).toBeEnabled();
  await page.screenshot({
    path: evidenceScreenshotPath("docs/design-system/evidence/1990/02-approval-required.png"),
  });
});

test("blocked, failed, and completed states render distinct closeout status @smoke", async ({
  page,
}) => {
  await installCodingProfileRoutes(page);
  await page.goto("/");
  await replaceCodingWindow(page, "blocked");
  await visibleWorkbench(page);
  await expect(page.getByText("Governance holds")).toBeVisible();
  await expect(page.getByText(/network-egress denied/iu)).toBeVisible();

  await replaceCodingWindow(page, "failed");
  await visibleWorkbench(page);
  await expect(page.getByText("One verification gate failed")).toBeVisible();

  await replaceCodingWindow(page, "completed");
  await visibleWorkbench(page);
  await expect(page.getByText("Ready for issue PR handoff")).toBeVisible();
});

test("workbench fits narrow width and has no serious axe violations @smoke", async ({ page }) => {
  await installCodingProfileRoutes(page);
  await page.setViewportSize({ width: 390, height: 860 });
  await page.goto("/");
  await replaceCodingWindow(page, "running");
  await visibleWorkbench(page);
  const workbench = page.locator('section[aria-label="Coding Workbench"][data-state]');
  const overflows = await workbench.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
  expect(overflows).toBe(false);
  const violations = unexplainedViolations(
    await runAxe(page, 'section[aria-label="Coding Workbench"][data-state]'),
  );
  expect(violations.length, formatViolations(violations)).toBe(0);
  await page.screenshot({
    path: evidenceScreenshotPath("docs/design-system/evidence/1990/03-running-narrow.png"),
  });
});
