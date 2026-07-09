import { expect, test, type Page, type Route } from "@playwright/test";
import { type AxeViolation, formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";
import { evidenceScreenshotPath } from "./support/evidence.js";

type JsonObject = Record<string, unknown>;
type CodingWorkbenchSeedState =
  | "autonomous-confirmed"
  | "autonomous-policy-blocked"
  | "autonomous-verification-failed"
  | "autonomous-completed";

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
    id: `issue-1994-coding-${state}`,
    type: "coding",
    x: 70,
    y: 58,
    w: 940,
    h: 720,
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

async function expectAutonomousWorkbench(page: Page): Promise<void> {
  await expect(page.locator('section[aria-label="Coding Workbench"][data-state]')).toBeVisible();
  await expect(page.getByRole("radio", { name: /Autonomous Delivery/u })).toBeChecked();
  await expect(page.getByText("Delivery runner")).toBeVisible();
  await expect(page.getByText("Keiko Gateway providers")).toBeVisible();
}

async function expectRedactedSurface(page: Page): Promise<void> {
  await expect(
    page.getByText(
      /stdout|stderr|diff --git|Bearer|Authorization|access token|refresh token|ghp_|github_pat_|\/Users\//iu,
    ),
  ).toHaveCount(0);
}

function unexplainedViolations(violations: readonly AxeViolation[]): readonly AxeViolation[] {
  return seriousOrCritical(violations);
}

test("autonomous confirmed and completed states show governed gateway handoff @smoke", async ({
  page,
}) => {
  await installCodingProfileRoutes(page);
  await page.goto("/");

  await replaceCodingWindow(page, "autonomous-confirmed");
  await expectAutonomousWorkbench(page);
  await expect(
    page.getByRole("heading", { name: "Issue #1994 Autonomous Delivery confirmed envelope" }),
  ).toBeVisible();
  await expect(page.getByText("Governed PR gateway handoff pending")).toBeVisible();
  await expect(page.getByText("Executing bounded issue-to-PR delivery")).toBeVisible();
  await expect(page.getByText("Content-free change summary")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop sidecar" })).toBeEnabled();
  await expectRedactedSurface(page);
  await page.screenshot({
    path: evidenceScreenshotPath("docs/design-system/evidence/1994/01-autonomous-confirmed.png"),
  });

  await replaceCodingWindow(page, "autonomous-completed");
  await expectAutonomousWorkbench(page);
  await expect(
    page.getByRole("heading", { name: "Issue #1994 Autonomous Delivery PR handoff" }),
  ).toBeVisible();
  await expect(page.getByText("Draft PR created through governed PR gateway")).toBeVisible();
  await expect(page.getByText("All closeout gates passed")).toBeVisible();
  await expect(page.getByText("governed-pr-gateway-handoff")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop sidecar" })).toBeDisabled();
  await expectRedactedSurface(page);
  await page.screenshot({
    path: evidenceScreenshotPath("docs/design-system/evidence/1994/02-autonomous-completed.png"),
  });
});

test("autonomous policy and verification failures fail closed without provider writes @smoke", async ({
  page,
}) => {
  await installCodingProfileRoutes(page);
  await page.goto("/");

  await replaceCodingWindow(page, "autonomous-policy-blocked");
  await expectAutonomousWorkbench(page);
  await expect(page.getByText("No provider write executed")).toBeVisible();
  await expect(page.getByLabel("Governance holds").getByText("authority-expired")).toBeVisible();
  await expect(
    page.getByLabel("Governance holds").getByText("connector-scope-missing"),
  ).toBeVisible();
  await expectRedactedSurface(page);
  await page.screenshot({
    path: evidenceScreenshotPath("docs/design-system/evidence/1994/03-autonomous-policy-hold.png"),
  });

  await replaceCodingWindow(page, "autonomous-verification-failed");
  await expectAutonomousWorkbench(page);
  await expect(page.getByText("PR creation blocked by verification")).toBeVisible();
  await expect(page.getByText("Verification failed with redacted output")).toBeVisible();
  await expect(page.getByLabel("Governance holds").getByText("verification-failed")).toBeVisible();
  await expectRedactedSurface(page);
  await page.screenshot({
    path: evidenceScreenshotPath(
      "docs/design-system/evidence/1994/04-autonomous-verification-failed.png",
    ),
  });
});

test("autonomous closeout narrow viewport has no horizontal overflow or serious axe violations @smoke", async ({
  page,
}) => {
  await installCodingProfileRoutes(page);
  await page.setViewportSize({ width: 390, height: 860 });
  await page.goto("/");
  await replaceCodingWindow(page, "autonomous-confirmed", {
    x: 54,
    y: 54,
    w: 330,
    h: 730,
  });
  await expectAutonomousWorkbench(page);

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
    path: evidenceScreenshotPath("docs/design-system/evidence/1994/05-autonomous-narrow.png"),
  });
});
