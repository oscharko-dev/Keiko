import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

// PR #1907 consolidated updater UX coverage. This plan is intentionally narrow and
// contract-shaped: it boots the packaged Keiko UI, mocks only the update BFF routes,
// and exercises the user-visible states changed on the branch.

const APP_ORIGIN = `http://127.0.0.1:${process.env.KEIKO_E2E_UI_PORT ?? "32207"}`;
const SETTINGS_WINDOW_ID = "issue-1907-settings";
const RELEASE_URL = "https://github.com/oscharko-dev/Keiko/releases/tag/v0.2.12";

type JsonObject = Record<string, unknown>;

interface RouteLedger {
  verifyRestartRequests: unknown[];
}

interface RouteState {
  report: JsonObject;
  sessionStatus: JsonObject;
  remediation: JsonObject;
  verifyRestartSession?: JsonObject;
}

function patchNotesFixture(): JsonObject {
  return {
    collapsed: true,
    summary: "Improves repository understanding without repeating this summary.",
    bullets: [
      "Improves repository understanding without repeating this summary.",
      "Hardens security and supply-chain posture.",
      "Fixes startup and SSE stability hot spots.",
    ],
    sections: [
      {
        title: "High · Improvements",
        bullets: ["Improves repository understanding without repeating this summary."],
      },
      { title: "Normal · Improvements", bullets: ["Hardens security and supply-chain posture."] },
      { title: "Normal · Fixes", bullets: ["Fixes startup and SSE stability hot spots."] },
    ],
    details: [],
  };
}

function releaseFixture(): JsonObject {
  return {
    source: "github-release",
    tag: "v0.2.12",
    title: "Keiko 0.2.12",
    summary: "Current release notes.",
    notes: ["Hardens updater guidance."],
    noteSections: [
      { title: "High · Improvements", bullets: ["Improves repository understanding."] },
    ],
    url: RELEASE_URL,
    publishedAt: "2026-07-05T12:00:00.000Z",
  };
}

function preflight(overrides: JsonObject = {}): JsonObject {
  return {
    schemaVersion: 1,
    checkedAt: "2026-07-05T12:00:00.000Z",
    currentVersion: "0.2.12",
    targetVersion: "0.2.12",
    updateAvailable: false,
    status: "current",
    availabilityState: "current",
    severity: "none",
    registryStatus: "ok",
    releaseMetadataStatus: "live",
    userActionRequired: false,
    affectedStateStores: [],
    blockers: [],
    manualUpdateRequired: false,
    oneClickEligible: true,
    patchNotes: patchNotesFixture(),
    release: releaseFixture(),
    warnings: [],
    ...overrides,
  };
}

function sessionStatus(overrides: JsonObject = {}): JsonObject {
  return {
    schemaVersion: "1",
    installMode: {
      schemaVersion: "1",
      status: "supported",
      packageName: "@oscharko-dev/keiko",
      packageManager: "npm",
      commandPreview: {
        executable: "npm",
        args: ["install", "--global", "--ignore-scripts", "@oscharko-dev/keiko@0.2.12"],
        label: "npm install --global --ignore-scripts @oscharko-dev/keiko@0.2.12",
      },
    },
    policy: { enabled: true, source: "default" },
    ...overrides,
  };
}

function updateSession(overrides: JsonObject = {}): JsonObject {
  return {
    schemaVersion: "1",
    sessionId: "issue-1907-update-session",
    packageName: "@oscharko-dev/keiko",
    targetVersion: "0.2.12",
    phase: "restart-required",
    failureReason: "none",
    packageManager: "npm",
    startedAt: "2026-07-05T12:00:00.000Z",
    updatedAt: "2026-07-05T12:00:04.000Z",
    cancelable: false,
    retryable: false,
    restartRequired: true,
    message: "Restart Keiko to complete the update.",
    restartCommandPreview: {
      executable: "keiko",
      args: ["restart", "--port", "1990", "--host", "127.0.0.1", "--state-dir", "/tmp/keiko"],
      label: "keiko restart --port 1990 --host 127.0.0.1 --state-dir /tmp/keiko",
    },
    ...overrides,
  };
}

function remediation(overrides: JsonObject = {}): JsonObject {
  return {
    schemaVersion: 1,
    checkedAt: "2026-07-05T12:00:00.000Z",
    targetVersion: "0.2.12",
    overallStatus: "not-required",
    updateCanComplete: true,
    actions: [],
    affectedFeatures: [],
    warnings: [],
    ...overrides,
  };
}

function manualReport(): JsonObject {
  return preflight({
    currentVersion: "0.2.11",
    targetVersion: "0.2.12",
    updateAvailable: true,
    status: "update-available",
    availabilityState: "update-available",
    severity: "normal",
    manualUpdateRequired: true,
    oneClickEligible: false,
    userActionRequired: true,
    blockers: [
      {
        code: "one-click-ineligible",
        message: "This installation was started from a local checkout.",
        severity: "normal",
        userActionRequired: true,
      },
    ],
  });
}

function manualSessionStatus(): JsonObject {
  return sessionStatus({
    installMode: {
      schemaVersion: "1",
      status: "unsupported",
      packageName: "@oscharko-dev/keiko",
      reason: "local-checkout",
      manualInstructions:
        "Automatic update is unavailable: this is a repository checkout. Use your package manager outside Keiko, then restart Keiko.",
    },
    policy: { enabled: true, source: "default" },
  });
}

function restartRequiredStatus(session: JsonObject = updateSession()): JsonObject {
  return sessionStatus({ activeSession: session });
}

function postedJson(route: Route): unknown {
  const raw = route.request().postData();
  if (raw === null) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function installRoutes(page: Page, state: RouteState): Promise<RouteLedger> {
  const ledger: RouteLedger = { verifyRestartRequests: [] };
  await page.route("**/api/update/preflight/check", async (route) => {
    await fulfillJson(route, state.report);
  });
  await page.route("**/api/update/preflight", async (route) => {
    await fulfillJson(route, state.report);
  });
  await page.route("**/api/update/session/verify-restart", async (route) => {
    ledger.verifyRestartRequests.push(postedJson(route));
    const nextSession =
      state.verifyRestartSession ??
      updateSession({ phase: "succeeded", restartRequired: false, message: "Update verified." });
    state.sessionStatus =
      nextSession["phase"] === "restart-required"
        ? sessionStatus({ activeSession: nextSession })
        : sessionStatus({ lastSession: nextSession });
    await fulfillJson(route, nextSession);
  });
  await page.route("**/api/update/session", async (route) => {
    await fulfillJson(route, state.sessionStatus);
  });
  await page.route("**/api/update/remediation/status", async (route) => {
    await fulfillJson(route, state.remediation);
  });
  await page.route("**/api/update/remediation/actions", async (route) => {
    await fulfillJson(route, state.remediation);
  });
  await page.route("**/api/update/remediation", async (route) => {
    await fulfillJson(route, state.remediation);
  });
  return ledger;
}

async function seedSettingsWindow(
  page: Page,
  opts: { readonly theme: "dark" | "light"; readonly height?: number } = { theme: "dark" },
): Promise<void> {
  await page.addInitScript(
    ({ theme, height, windowId }) => {
      window.localStorage.setItem("keiko.theme", theme);
      window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
      window.localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: windowId,
            type: "settings",
            x: 32,
            y: 28,
            w: 500,
            h: height,
            z: 10,
            cfg: {},
            max: false,
          },
        ]),
      );
      window.localStorage.removeItem("keiko.conns.v1");
    },
    { theme: opts.theme, height: opts.height ?? 640, windowId: SETTINGS_WINDOW_ID },
  );
}

async function openUpdateWindow(page: Page, title: RegExp | string): Promise<Locator> {
  await page.goto(APP_ORIGIN);
  const settings = page.locator(`.window[data-window-id="${SETTINGS_WINDOW_ID}"]`);
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "General" }).click();
  await expect(settings.getByRole("button", { name: "Review updates" })).toBeVisible();
  await settings.getByRole("button", { name: "Review updates" }).click();
  const updateWindow = page.locator(".window").filter({
    has: page.getByRole("heading", { name: title }),
  });
  await expect(updateWindow).toBeVisible();
  return updateWindow;
}

async function assertWindowBodyClipped(updateWindow: Locator): Promise<void> {
  const metrics = await updateWindow.evaluate((element) => {
    const clip = element.querySelector<HTMLElement>(".win-frame-clip");
    const body = element.querySelector<HTMLElement>(".win-body");
    if (clip === null || body === null) throw new Error("Window clip/body not found");
    const clipRect = clip.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    return {
      bodyBottom: bodyRect.bottom,
      bodyTop: bodyRect.top,
      clipBottom: clipRect.bottom,
      clipTop: clipRect.top,
      scrollTop: body.scrollTop,
      scrollHeight: body.scrollHeight,
      clientHeight: body.clientHeight,
    };
  });
  expect(metrics.bodyTop).toBeGreaterThanOrEqual(metrics.clipTop - 1);
  expect(metrics.bodyBottom).toBeLessThanOrEqual(metrics.clipBottom + 1);
}

test("shows current release notes without target-unknown or degraded copy", async ({ page }) => {
  await installRoutes(page, {
    report: preflight(),
    sessionStatus: sessionStatus(),
    remediation: remediation(),
  });
  await seedSettingsWindow(page, { theme: "dark" });

  const updateWindow = await openUpdateWindow(page, "Keiko is up to date");

  await expect(updateWindow.getByRole("heading", { name: "Keiko is up to date" })).toBeVisible();
  await expect(updateWindow.getByText("Current 0.2.12 -> target 0.2.12")).toBeVisible();
  await expect(updateWindow.getByText(/target unknown/u)).toHaveCount(0);
  await expect(updateWindow.getByText("Update status degraded")).toHaveCount(0);

  const patchNotes = updateWindow.locator("details").filter({ hasText: "Patch notes" });
  await patchNotes.locator("summary").click();
  await expect(patchNotes).toHaveAttribute("open", "");
  await expect(updateWindow.getByRole("heading", { name: "High · Improvements" })).toBeVisible();
  await expect(updateWindow.getByRole("heading", { name: "Normal · Improvements" })).toBeVisible();
  await expect(updateWindow.getByRole("heading", { name: "Normal · Fixes" })).toBeVisible();
  await expect(
    updateWindow.getByText("Improves repository understanding without repeating this summary."),
  ).toHaveCount(1);
});

test("renders manual update instructions as copyable commands and keeps release notes in a new tab", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-write"], { origin: APP_ORIGIN });
  await page.context().route("https://github.com/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: "<title>Release</title>" });
  });
  await installRoutes(page, {
    report: manualReport(),
    sessionStatus: manualSessionStatus(),
    remediation: remediation({ overallStatus: "manual-review-required", updateCanComplete: false }),
  });
  await seedSettingsWindow(page, { theme: "light", height: 520 });

  const updateWindow = await openUpdateWindow(page, "Update available");

  await expect(updateWindow.getByRole("heading", { name: "Update available" })).toBeVisible();
  await expect(updateWindow.getByRole("button", { name: "Show instructions" })).toHaveCount(0);
  await expect(updateWindow.getByText("Manual update path")).toBeVisible();

  const manualInstructions = updateWindow.locator("details").filter({
    hasText: "Manual update instructions",
  });
  await manualInstructions.locator("summary").click();
  await expect(manualInstructions).toHaveAttribute("open", "");
  await expect(updateWindow.getByText("npm", { exact: true })).toBeVisible();
  await expect(updateWindow.getByText("Yarn", { exact: true })).toBeVisible();
  await expect(
    updateWindow.getByText("npm install --global --ignore-scripts @oscharko-dev/keiko@0.2.12"),
  ).toBeVisible();
  await expect(
    updateWindow.getByText("yarn global add --ignore-scripts @oscharko-dev/keiko@0.2.12"),
  ).toBeVisible();

  const npmCopy = updateWindow.getByRole("button", { name: "Copy npm command" });
  await npmCopy.click();
  await expect(npmCopy).toHaveAttribute("data-copied", "true");

  const releaseLink = updateWindow.getByRole("link", { name: "Open release notes" });
  await expect(releaseLink).toHaveAttribute("target", "_blank");
  await expect(releaseLink).toHaveAttribute("rel", "noopener noreferrer");
  const popupPromise = page.waitForEvent("popup");
  await releaseLink.click();
  const popup = await popupPromise;
  await expect.poll(() => popup.url()).toContain(RELEASE_URL);
  await popup.close();

  await assertWindowBodyClipped(updateWindow);
  const body = updateWindow.locator(".win-body");
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() =>
      body.evaluate((element) => element.scrollTop + element.clientHeight >= element.scrollHeight),
    )
    .toBe(true);
  await assertWindowBodyClipped(updateWindow);
});

test("keeps failed restart verification in the restart-required flow", async ({ page }) => {
  const mismatchSession = updateSession({
    failureReason: "restart-version-mismatch",
    message: "Restart not detected yet. Run the restart command, then try Verify restart again.",
  });
  const ledger = await installRoutes(page, {
    report: manualReport(),
    sessionStatus: restartRequiredStatus(),
    remediation: remediation(),
    verifyRestartSession: mismatchSession,
  });
  await seedSettingsWindow(page, { theme: "dark", height: 640 });

  const updateWindow = await openUpdateWindow(page, "Restart required");

  await expect(updateWindow.getByRole("heading", { name: "Restart required" })).toBeVisible();
  await expect(
    updateWindow.getByText("Restart and verification are needed to finish the update."),
  ).toBeVisible();
  const restartDetails = updateWindow
    .locator("details")
    .filter({ hasText: "Restart instructions" });
  await expect(restartDetails).toHaveAttribute("open", "");
  await expect(updateWindow.getByText("Restart Keiko", { exact: true })).toBeVisible();
  await expect(updateWindow.getByText(/keiko restart --port 1990/u)).toBeVisible();

  await updateWindow.getByRole("button", { name: "Verify restart" }).click();

  await expect(
    updateWindow.locator(".upd-restart-verification-feedback").filter({
      hasText: "Restart not detected yet. Run the restart command, then try Verify restart again.",
    }),
  ).toBeVisible();
  await expect(updateWindow.getByRole("button", { name: "Install update" })).toHaveCount(0);
  await expect(updateWindow.getByRole("button", { name: "Verify restart" })).toBeEnabled();
  expect(ledger.verifyRestartRequests).toEqual([{ targetVersion: "0.2.12" }]);
});
