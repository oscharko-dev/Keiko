import { expect, test, type Page, type Route } from "@playwright/test";
import { type AxeViolation, formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";
import { evidenceScreenshotPath } from "./support/evidence.js";

type JsonObject = Record<string, unknown>;
type CodingWorkbenchSeedState =
  | "supervised-approval-required"
  | "supervised-approved"
  | "supervised-denied"
  | "supervised-stopped"
  | "supervised-failed";

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
    id: `issue-1992-coding-${state}`,
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
  await expect(page.getByRole("heading", { name: /Issue #1992 Supervised Coding/u })).toBeVisible();
  await expect(page.locator('section[aria-label="Coding Workbench"][data-state]')).toBeVisible();
}

async function expectRedactedSurface(page: Page): Promise<void> {
  await expect(
    page.getByText(/stdout|stderr|diff --git|Bearer|access token|refresh token|\/Users\//iu),
  ).toHaveCount(0);
}

function unexplainedViolations(violations: readonly AxeViolation[]): readonly AxeViolation[] {
  return seriousOrCritical(violations);
}

test("supervised approval prompt shows redacted push metadata and keeps stop enabled @smoke", async ({
  page,
}) => {
  await installCodingProfileRoutes(page);
  await page.goto("/");
  await replaceCodingWindow(page, "supervised-approval-required");
  await visibleWorkbench(page);

  const workbench = page.locator('section[aria-label="Coding Workbench"][data-state]');
  const prompt = page.locator('[aria-labelledby="coding-workbench-permission-title"]');
  await expect(page.getByRole("heading", { name: "Just-in-time approval" })).toBeVisible();
  await expect(page.getByText("Push requires one-time approval")).toBeVisible();
  await expect(prompt.getByText("Action kind")).toBeVisible();
  await expect(prompt.getByText("push", { exact: true })).toBeVisible();
  await expect(prompt.getByText("Risk")).toBeVisible();
  await expect(prompt.getByText("high", { exact: true })).toBeVisible();
  await expect(prompt.getByText("Policy reason")).toBeVisible();
  await expect(prompt.getByText("approval-required", { exact: true })).toBeVisible();
  await expect(prompt.getByText("Scope", { exact: true })).toBeVisible();
  await expect(prompt.getByText("workspace-scope", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve once" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Deny" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Stop sidecar" })).toBeEnabled();
  await expect(workbench.getByRole("status")).toContainText("No operator override requested");
  await expectRedactedSurface(page);
  await page.screenshot({
    path: evidenceScreenshotPath("docs/design-system/evidence/1992/01-approval-required.png"),
  });

  await page.getByRole("button", { name: "Stop sidecar" }).click();
  await expect(workbench.getByRole("status")).toContainText("Stop requested");
});

test("supervised approved denied stopped and failed states stay distinct and redacted @smoke", async ({
  page,
}) => {
  await installCodingProfileRoutes(page);
  await page.goto("/");

  await replaceCodingWindow(page, "supervised-approved");
  await visibleWorkbench(page);
  await expect(page.getByText("Approved once for this scope")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop sidecar" })).toBeEnabled();
  await expectRedactedSurface(page);
  await page.screenshot({
    path: evidenceScreenshotPath("docs/design-system/evidence/1992/02-approved.png"),
  });

  await replaceCodingWindow(page, "supervised-denied");
  await visibleWorkbench(page);
  await expect(page.getByText("Denied before mutation")).toBeVisible();
  await expect(page.getByLabel("Governance holds").getByText("operator-denied")).toBeVisible();
  await expectRedactedSurface(page);
  await page.screenshot({
    path: evidenceScreenshotPath("docs/design-system/evidence/1992/03-denied.png"),
  });

  await replaceCodingWindow(page, "supervised-stopped");
  await visibleWorkbench(page);
  await expect(page.getByText("Stopped before mutation")).toBeVisible();
  await expect(page.getByLabel("Governance holds").getByText("operator-stopped")).toBeVisible();
  await expectRedactedSurface(page);
  await page.screenshot({
    path: evidenceScreenshotPath("docs/design-system/evidence/1992/04-stopped.png"),
  });

  await replaceCodingWindow(page, "supervised-failed");
  await visibleWorkbench(page);
  await expect(page.getByText("Verification failed with redacted output")).toBeVisible();
  await expect(page.getByLabel("Governance holds").getByText("redacted-failure")).toBeVisible();
  await expectRedactedSurface(page);
  await page.screenshot({
    path: evidenceScreenshotPath("docs/design-system/evidence/1992/05-failed.png"),
  });
});

test("supervised approval narrow viewport has no horizontal overflow or serious axe violations @smoke", async ({
  page,
}) => {
  await installCodingProfileRoutes(page);
  await page.setViewportSize({ width: 390, height: 860 });
  await page.goto("/");
  await replaceCodingWindow(page, "supervised-approval-required", {
    x: 54,
    y: 54,
    w: 330,
    h: 720,
  });
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
  await expectRedactedSurface(page);
  await page.screenshot({
    path: evidenceScreenshotPath(
      "docs/design-system/evidence/1992/06-approval-required-narrow.png",
    ),
  });
});
