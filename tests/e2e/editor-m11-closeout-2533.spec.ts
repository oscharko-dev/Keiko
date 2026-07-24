import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  encodeCodingAppSessionPairingFragment,
  validateWorkspaceManifest,
  type WorkspaceManifest,
} from "@oscharko-dev/keiko-contracts";
import { mintLauncherPairingAttestation } from "@oscharko-dev/keiko-server";

import { formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";
import {
  cleanupEditorWorkspaces,
  createEditorWorkspace,
  firstPane,
  openEditorWorkspace,
  typeIntoActiveEditor,
} from "./support/editorWorkspace.js";
import { FILE_HISTORY_APP_SESSION_LAUNCHER_SECRET } from "./support/file-history-2531.js";

const FILE = "src/app.ts";
const MULTI_ROOT_ARIA_FINDING = 2605;
const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const SETTINGS_WINDOW = '.window[data-window-id="issue-2533-settings"]';
const INITIAL_VERSION = 'export const historyValue = "initial";\n';
const VERSION_ONE = 'export const historyValue = "one";\n';
const VERSION_TWO = 'export const historyValue = "two";\n';

type WorkspaceFixture = ReturnType<typeof createEditorWorkspace>;

interface CloseoutHarness {
  readonly alpha: WorkspaceFixture;
  readonly beta: WorkspaceFixture;
}

interface SettingsSnapshot {
  readonly profiles: {
    readonly etag: string;
    readonly revision: number;
  };
}

interface ProfileMutationResult {
  readonly profileRef: string;
}

interface SeedWindow {
  readonly id: string;
  readonly type: "editor" | "files" | "settings";
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly z: number;
  readonly cfg: Readonly<Record<string, unknown>>;
  readonly max: boolean;
}

interface ProfileSwitchResult {
  readonly page: Page;
  readonly durationMs: number;
}

function pairingFragment(): string {
  return encodeCodingAppSessionPairingFragment(
    mintLauncherPairingAttestation({
      secret: FILE_HISTORY_APP_SESSION_LAUNCHER_SECRET,
      requestId: `req_m11_closeout-${String(Date.now())}`,
      issuedAtMs: Date.now(),
    }),
  );
}

function createHarness(): CloseoutHarness {
  return {
    alpha: createEditorWorkspace([
      { path: "package.json", content: '{"name":"m11-alpha","private":true}\n' },
      { path: FILE, content: INITIAL_VERSION },
    ]),
    beta: createEditorWorkspace([
      { path: "package.json", content: '{"name":"m11-beta","private":true}\n' },
      { path: "src/beta.ts", content: "export const beta = true;\n" },
    ]),
  };
}

async function registerProject(
  request: APIRequestContext,
  root: string,
  name: string,
): Promise<void> {
  const response = await request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: root, name },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

function manifestFromList(value: unknown, root: string): WorkspaceManifest {
  if (typeof value !== "object" || value === null || !("manifests" in value)) {
    throw new Error("M11 workspace manifest list is unavailable.");
  }
  const manifests = value.manifests;
  if (!Array.isArray(manifests)) throw new Error("M11 workspace manifest list is invalid.");
  for (const candidate of manifests as readonly unknown[]) {
    if (!validateWorkspaceManifest(candidate).ok) continue;
    const manifest = candidate as WorkspaceManifest;
    if (manifest.roots.some((entry) => entry.canonicalRoot === root)) return manifest;
  }
  throw new Error("M11 workspace manifest is missing.");
}

async function addSecondRoot(request: APIRequestContext, harness: CloseoutHarness): Promise<void> {
  const list = await request.get("/api/workspaces");
  expect(list.ok(), await list.text()).toBe(true);
  const manifest = manifestFromList(await list.json(), harness.alpha.root);
  const actor = manifest.roots.find((root) => root.canonicalRoot === harness.alpha.root);
  if (actor === undefined) throw new Error("M11 actor root is unavailable.");
  const response = await request.post(`/api/workspaces/${manifest.workspaceId}/roots`, {
    headers: MUTATION_HEADERS,
    data: {
      dispatch: {
        kind: "workspace-root-dispatch",
        schemaVersion: manifest.schemaVersion,
        workspaceId: manifest.workspaceId,
        manifestRef: manifest.manifestRef,
        manifestRevision: manifest.revision,
        manifestDigest: manifest.manifestDigest,
        rootRef: actor.rootRef,
        rootIdentityDigest: actor.identityDigest,
        operationClass: "mutating",
      },
      projectPath: harness.beta.root,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function createFocusedProfile(request: APIRequestContext, root: string): Promise<string> {
  const settings = await request.get("/api/editor/settings", { params: { root } });
  expect(settings.ok(), await settings.text()).toBe(true);
  const snapshot = (await settings.json()) as SettingsSnapshot;
  const response = await request.patch("/api/editor/settings/profiles", {
    headers: {
      ...MUTATION_HEADERS,
      "If-Match": snapshot.profiles.etag,
      "Idempotency-Key": "issue-2533-create-focused-profile",
    },
    data: {
      schemaVersion: "1",
      root,
      action: "create",
      displayName: "Focused M11",
      expectedRevision: snapshot.profiles.revision,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as ProfileMutationResult).profileRef;
}

function seededWindows(root: string): readonly SeedWindow[] {
  return [
    {
      id: "issue-2533-editor",
      type: "editor",
      x: 12,
      y: 12,
      w: 1040,
      h: 980,
      z: 10,
      cfg: { root, file: FILE, openFiles: [FILE] },
      max: false,
    },
    {
      id: "issue-2533-files",
      type: "files",
      x: 1064,
      y: 12,
      w: 360,
      h: 980,
      z: 11,
      cfg: { root },
      max: false,
    },
    {
      id: "issue-2533-settings",
      type: "settings",
      x: 1436,
      y: 12,
      w: 460,
      h: 980,
      z: 12,
      cfg: {},
      max: false,
    },
  ];
}

async function seedWindows(page: Page, root: string): Promise<void> {
  await page.addInitScript((windows) => {
    window.localStorage.setItem("keiko.theme", "dark");
    window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
    if (window.localStorage.getItem("keiko.workspace.v4") !== null) return;
    window.localStorage.setItem("keiko.workspace.v4", JSON.stringify(windows));
  }, seededWindows(root));
}

async function replacePage(page: Page, windows: readonly SeedWindow[]): Promise<Page> {
  const browser = page.context().browser();
  if (browser === null) throw new Error("M11 closeout browser is unavailable.");
  const origin = new URL(page.url()).origin;
  await page.context().close();
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const replacement = await context.newPage();
  await replacement.addInitScript((value) => {
    window.localStorage.setItem("keiko.theme", "dark");
    window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
    window.localStorage.setItem("keiko.workspace.v4", JSON.stringify(value));
  }, windows);
  await replacement.goto(`${origin}/${pairingFragment()}`);
  return replacement;
}

async function grantAlphaAndRestrictBeta(page: Page): Promise<void> {
  const prompt = page.getByRole("alertdialog", { name: "Trust this workspace?" });
  await expect(prompt).toBeVisible();
  const grant = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/editor/verification/trust"),
  );
  await prompt.getByRole("button", { name: "Trust workspace" }).click();
  expect((await grant).status()).toBe(200);
  await page.getByRole("tab", { name: /M11 Root Beta/u }).click();
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "Stay restricted" }).click();
  await expect(page.getByTestId("workspace-trust-banner-editor")).toContainText("Restricted Mode");
  await expect(
    page.getByRole("treeitem", { name: "M11 Root Alpha" }).getByLabel("Trusted workspace"),
  ).toBeVisible();
  await expect(
    page.getByRole("treeitem", { name: "M11 Root Beta" }).getByLabel("Restricted Mode"),
  ).toBeVisible();
}

async function switchProfile(
  page: Page,
  root: string,
  profileRef: string,
): Promise<ProfileSwitchResult> {
  await page.getByRole("tab", { name: /M11 Root Alpha/u }).click();
  const settingsWindow = seededWindows(root).filter((window) => window.type === "settings");
  const settingsPage = await replacePage(page, settingsWindow);
  const settings = settingsPage.locator(SETTINGS_WINDOW);
  await settings.getByRole("button", { name: "Editor" }).click();
  await expect(settings.getByText("Current profile: Default")).toBeVisible();
  const profile = settings.getByRole("combobox", { name: "Profile" });
  await expect(profile).toBeEnabled();
  await profile.selectOption(profileRef);
  const startedAt = Date.now();
  const switched = settingsPage.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith("/api/editor/settings/profiles"),
  );
  await settings.getByRole("button", { name: "Switch", exact: true }).click();
  expect((await switched).ok()).toBe(true);
  await expect(settings.getByText("Current profile: Focused M11")).toBeVisible();
  const durationMs = Date.now() - startedAt;
  return { page: await replacePage(settingsPage, seededWindows(root)), durationMs };
}

async function saveVersion(page: Page, pane: Locator, content: string): Promise<void> {
  await typeIntoActiveEditor(page, pane, content);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" && response.url().endsWith("/api/files/content"),
  );
  await pane.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).ok()).toBe(true);
}

async function restoreOldest(page: Page, pane: Locator): Promise<number> {
  await pane.getByRole("button", { name: "Open file history" }).click();
  const rows = pane.locator("li[data-entry-ref]");
  await expect(rows).toHaveCount(2);
  const startedAt = Date.now();
  await rows.last().getByRole("button", { name: "Restore", exact: true }).click();
  const restored = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" && response.url().endsWith("/api/files/content"),
  );
  await page.getByRole("alertdialog").getByRole("button", { name: "Restore version" }).click();
  expect((await restored).ok()).toBe(true);
  await expect(pane.locator("li[data-entry-ref]")).toHaveCount(3);
  return Date.now() - startedAt;
}

async function expectAxeGreen(page: Page, selector: string): Promise<void> {
  const violations = seriousOrCritical(await runAxe(page, selector));
  expect(violations, formatViolations(violations)).toEqual([]);
}

async function expectKnownMultiRootAxeFinding(page: Page): Promise<void> {
  const violations = seriousOrCritical(await runAxe(page, "[data-multi-root-explorer]"));
  const finding = violations[0];
  expect(
    finding === undefined
      ? undefined
      : { id: finding.id, impact: finding.impact, nodeCount: finding.nodes.length },
    `Follow-up #${String(MULTI_ROOT_ARIA_FINDING)} owns the exact M11 Explorer finding.`,
  ).toEqual({ id: "aria-required-children", impact: "critical", nodeCount: 2 });
  expect(violations).toHaveLength(1);
}

test.afterAll(() => {
  cleanupEditorWorkspaces();
});

test("mixed-trust multi-root, profile switching, and local-history restore compose end to end", async ({
  page,
  request,
}, testInfo) => {
  const harness = createHarness();
  await registerProject(request, harness.alpha.root, "M11 Root Alpha");
  await registerProject(request, harness.beta.root, "M11 Root Beta");
  await addSecondRoot(request, harness);
  const profileRef = await createFocusedProfile(request, harness.alpha.root);
  await seedWindows(page, harness.alpha.root);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/${pairingFragment()}`);
  await openEditorWorkspace(page, { dismissTrustPrompt: false });
  await grantAlphaAndRestrictBeta(page);
  const switched = await switchProfile(page, harness.alpha.root, profileRef);
  const journeyPage = switched.page;
  const editor = await openEditorWorkspace(journeyPage);
  const pane = firstPane(editor);
  await saveVersion(journeyPage, pane, VERSION_ONE);
  // Read the oldest checkpoint's content from disk instead of hard-coding it (the sibling #2531
  // journey established this pattern): `typeIntoActiveEditor` selects-all-and-replaces, but how
  // much Monaco actually selects differs per platform/focus timing, so a literal expectation
  // encodes one platform's artifact. What restore must guarantee is exactly "the file equals the
  // oldest checkpoint" — assert that.
  const oldestContent = readFileSync(join(harness.alpha.root, FILE), "utf8");
  await saveVersion(journeyPage, pane, VERSION_TWO);
  const historyRestoreMs = await restoreOldest(journeyPage, pane);
  expect(readFileSync(join(harness.alpha.root, FILE), "utf8")).toBe(oldestContent);
  expect(JSON.stringify(await journeyPage.evaluate(() => window.localStorage))).not.toContain(
    "historyValue",
  );
  await expectKnownMultiRootAxeFinding(journeyPage);
  await expectAxeGreen(journeyPage, SETTINGS_WINDOW);
  await expectAxeGreen(journeyPage, "aside[aria-label='File history']");
  const metrics = {
    profileSwitchMs: switched.durationMs,
    historyRestoreMs,
    knownA11yFinding: MULTI_ROOT_ARIA_FINDING,
  };
  await testInfo.attach("editor-m11-closeout-metrics.json", {
    body: Buffer.from(`${JSON.stringify(metrics, null, 2)}\n`, "utf8"),
    contentType: "application/json",
  });
  const screenshot = testInfo.outputPath("editor-m11-closeout.png");
  await journeyPage.screenshot({ animations: "disabled", path: screenshot });
  await testInfo.attach("editor-m11-closeout.png", { path: screenshot, contentType: "image/png" });
});
