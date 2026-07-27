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
  EDITOR_SELECTORS,
  firstPane,
  openEditorWorkspace,
  typeIntoActiveEditor,
} from "./support/editorWorkspace.js";
import { FILE_HISTORY_APP_SESSION_LAUNCHER_SECRET } from "./support/file-history-2531.js";

const FILE = "src/app.ts";
const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const SETTINGS_WINDOW = '.window[data-window-id="issue-2533-settings"]';
const INITIAL_VERSION = 'export const historyValue = "initial";\n';
const VERSION_ONE = 'export const historyValue = "one";\n';
const VERSION_TWO = 'export const historyValue = "two";\n';
// Deliberately UNSAVED, and deliberately carrying `historyValue` like every saved version: this is
// the buffer the hot-exit route persists an index record for, so the leak assertion below is asked
// about a body that genuinely exists and is genuinely pending (#2768).
const UNSAVED_VERSION = 'export const historyValue = "unsaved-hot-exit";\n';

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
    // Positive control for the leak probe's sessionStorage arm. The journey writes nothing to
    // sessionStorage of its own, so without a value planted here a broken reader and an empty sink
    // are indistinguishable and the probe's negative would mean nothing.
    window.sessionStorage.setItem("keiko.e2e.storage-probe", "session-sink-reachable");
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

/**
 * Issue #2768 — the leak probe reads three sinks, but only two could ever answer. The journey
 * saved every edit, so the editor was never dirty, so the hot-exit effect never ran and the
 * IndexedDB index was not merely clean — it did not exist. Both halves of that arm were vacuous:
 * "did the reader work" and "is there a leak" were answered by the same empty result, and the
 * `localStorage`-seeded control could not tell them apart because it is a different sink.
 *
 * The fix is to make the journey produce the state, not to relax the assertion: one deliberate
 * unsaved edit, driven through the product's own hot-exit write route (the dirty-buffer effect in
 * EditorRuntimeWidget, debounced, which POSTs the body to the server and persists a CONTENT-FREE
 * index record to IndexedDB). Waiting on that POST anchors the wait on the product's own signal
 * rather than on a sleep, and it is the request whose body is the thing that must not also land in
 * the browser.
 */
async function leaveUnsavedHotExitEdit(page: Page, pane: Locator): Promise<void> {
  // `restoreOldest` leaves the history panel open, and it overlays the editor surface — typing has
  // to reach Monaco, so close it through its own control rather than clicking past it.
  await pane.getByRole("button", { name: "Close file history" }).click();
  await expect(page.locator("aside[aria-label='File history']")).toHaveCount(0);
  const persisted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/editor/hot-exit/write"),
  );
  await typeIntoActiveEditor(page, pane, UNSAVED_VERSION);
  expect((await persisted).ok()).toBe(true);
  // The index write is a separate IndexedDB transaction the POST only precedes, so settle on the
  // product's own observable outcome — the dirty marker the same effect gates on — before dumping.
  await expect(pane.locator(`${EDITOR_SELECTORS.tab}[data-dirty="true"]`).first()).toBeVisible();
  // Restore the surface this journey still scans for accessibility further down.
  await pane.getByRole("button", { name: "Open file history" }).click();
  await expect(page.locator("aside[aria-label='File history']")).toBeVisible();
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

// The settings window opens on its Models tab. Scanning it in that state answers a question the
// closeout never asked — the M11 claim is about the profile surface — so the Editor tab is opened
// and its profile controls are proven present before any axe scan of this window (#2626).
async function openProfileSettingsSurface(page: Page): Promise<void> {
  const settings = page.locator(SETTINGS_WINDOW);
  await settings.getByRole("button", { name: "Editor" }).click();
  await expect(settings.getByText("Current profile: Focused M11")).toBeVisible();
  await expect(settings.getByRole("combobox", { name: "Profile" })).toBeVisible();
}

// Every durable browser sink, not localStorage alone: the editor's hot-exit index lives in
// IndexedDB and is content-free by contract, so a probe that cannot see IndexedDB cannot observe
// the regression that would matter most. `storageState` covers cookies, localStorage, and
// IndexedDB for every origin in the context; sessionStorage is read separately because storage
// state does not carry it.
//
// sessionStorage is read through the documented `length`/`key(i)` API rather than by serializing
// the `Storage` object. Chromium does expose stored entries as own-enumerable named properties, so
// `JSON.stringify(sessionStorage)` happens to work there — but that is an engine detail, and a
// leak probe that depends on it reports "clean" without looking on any engine that differs.
async function browserStorageDump(page: Page): Promise<string> {
  const state = await page.context().storageState({ indexedDB: true });
  const session = await page.evaluate(() => {
    const entries: Record<string, string> = {};
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (key !== null) entries[key] = window.sessionStorage.getItem(key) ?? "";
    }
    return JSON.stringify(entries);
  });
  return `${JSON.stringify(state)}\n${session}`;
}

async function expectAxeGreen(page: Page, selector: string): Promise<void> {
  const violations = seriousOrCritical(await runAxe(page, selector));
  expect(violations, formatViolations(violations)).toEqual([]);
}

// Until #2605 this surface had a tolerated critical finding: the scan asserted the exact known
// violation on exactly two nodes. The defect is fixed — the tree role now owns only treeitem rows —
// so the Explorer is held to the same zero-violation bar as Settings and history. This is
// deliberately a strengthening: the previous form would have FAILED once the surface became clean.

/**
 * The grant read back from the governed route, which is what "the profile switch did not alter
 * trust" actually means. Asserting the absence of the trust banner instead would also assert that
 * the catalog read succeeded on the replaced page — a different property, and one this journey does
 * not control.
 */
async function expectRootStillTrusted(request: APIRequestContext, root: string): Promise<void> {
  const response = await request.get("/api/editor/verification/trust", {
    params: { projectId: root },
  });
  expect(response.ok(), await response.text()).toBe(true);
  expect((await response.json()) as { readonly trust: string }).toMatchObject({ trust: "trusted" });
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
  // Every trust assertion in this journey happens BEFORE the profile switch, inside
  // grantAlphaAndRestrictBeta. The closeout documents nonetheless claim the journey proves "a
  // profile switch does not alter trust" — and it did not: this call defaulted to
  // dismissTrustPrompt, so a switch that dropped Alpha's grant would have re-raised the prompt on
  // the replaced page and the shared helper would have quietly dismissed it, absorbing exactly the
  // regression the claim is about. Assert the preserved state here instead of delegating it.
  const editor = await openEditorWorkspace(journeyPage, { dismissTrustPrompt: false });
  // openEditorWorkspace has already awaited data-trust-settled="true", so "no dialog in the DOM"
  // provably means "no prompt will be raised for this load" — these need no timeout.
  await expect(journeyPage.getByRole("alertdialog", { name: "Trust this workspace?" })).toHaveCount(
    0,
  );
  await expectRootStillTrusted(request, harness.alpha.root);
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
  await leaveUnsavedHotExitEdit(journeyPage, pane);
  const storage = await browserStorageDump(journeyPage);
  // Assert on booleans and carry the diagnosis in the message, never in the subject: a failing
  // `toContain` prints what it searched, and here that is every browser sink including cookies —
  // the failure report would publish into CI logs the very content this assertion exists to prove
  // absent, plus session material besides.
  //
  // Self-check EVERY reader before trusting its negative, or a dump that captured nothing satisfies
  // the leak assertion vacuously. One control per sink, because a control in one sink says nothing
  // about another: `keiko.workspace.v4` is localStorage, the seeded probe is sessionStorage, and
  // `snapshotRef` is a field only a real EditorHotExitIndexRecordV2 carries — so it proves the
  // IndexedDB arm reached the `keiko-editor-hot-exit` database, its store, AND a record inside it.
  //
  // #2768: that third control did not exist, and neither did the state it needed. The journey saved
  // every edit, so the editor was never dirty and the hot-exit index was never written — the
  // IndexedDB arm of this probe reported "clean" about a database that did not exist and could not
  // have failed. `leaveUnsavedHotExitEdit` above is what makes this arm answerable.
  expect(storage.includes("keiko.workspace.v4"), "localStorage arm read no state").toBe(true);
  expect(storage.includes("session-sink-reachable"), "sessionStorage arm read no state").toBe(true);
  expect(storage.includes("snapshotRef"), "IndexedDB arm read no hot-exit index record").toBe(true);
  // `historyValue` is the one identifier every version shares — saved AND the pending unsaved one —
  // so any leaked body carries it. The hot-exit index is content-free by contract: it holds hashes,
  // sizes, and a server-side `snapshotRef`, never the buffer. That contract is what is under test.
  expect(storage.includes("historyValue"), "a checkpoint body reached browser storage").toBe(false);
  await expectAxeGreen(journeyPage, "[data-multi-root-explorer]");
  await openProfileSettingsSurface(journeyPage);
  await expectAxeGreen(journeyPage, SETTINGS_WINDOW);
  await expectAxeGreen(journeyPage, "aside[aria-label='File history']");
  const metrics = {
    profileSwitchMs: switched.durationMs,
    historyRestoreMs,
  };
  await testInfo.attach("editor-m11-closeout-metrics.json", {
    body: Buffer.from(`${JSON.stringify(metrics, null, 2)}\n`, "utf8"),
    contentType: "application/json",
  });
  const screenshot = testInfo.outputPath("editor-m11-closeout.png");
  await journeyPage.screenshot({ animations: "disabled", path: screenshot });
  await testInfo.attach("editor-m11-closeout.png", { path: screenshot, contentType: "image/png" });
});
