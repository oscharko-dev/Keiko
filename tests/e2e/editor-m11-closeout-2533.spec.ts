import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { WorkspaceManifest } from "@oscharko-dev/keiko-contracts";
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { validateWorkspaceManifest } from "@oscharko-dev/keiko-contracts/runtime/workspace-manifest";
import { mintLauncherPairingAttestation } from "@oscharko-dev/keiko-server";

import { formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";
import {
  cleanupEditorWorkspaces,
  createEditorWorkspace,
  EDITOR_SELECTORS,
  firstPane,
  openEditorWorkspace,
  openTreeFile,
  revokeEditorWorkspaceTrust,
} from "./support/editorWorkspace.js";
import { replaceEditorBuffer } from "./support/editor-chord.js";
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
    const seededKey = "keiko.e2e.issue-2533-seeded";
    if (window.sessionStorage.getItem(seededKey) === "1") return;
    window.localStorage.setItem("keiko.workspace.v4", JSON.stringify(windows));
    window.sessionStorage.setItem(seededKey, "1");
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

/**
 * How long a root tab may take to appear before we call it missing.
 *
 * Deliberately far below the 180s test timeout: the point is that a tab which never renders fails
 * HERE, naming the tab, instead of being absorbed into a bare "Test timeout exceeded" at the end of
 * the run. Generous enough that a slow CI bootstrap is not mistaken for a missing tab.
 */
const ROOT_TAB_TIMEOUT_MS = 30_000;

/**
 * Whether a root tab is currently the selected one.
 *
 * The single `getAttribute` call this replaces looked harmless and was not, for two reasons. It
 * waits only for ATTACHMENT and then samples once, so on a bootstrap slow enough that the tab has
 * not rendered yet it blocks until the whole test times out — 180 seconds spent to learn nothing,
 * and a failure message that names a `getAttribute` call rather than the tab that never appeared.
 * That is exactly how this spec failed on `dev` (run 30985220224). And because `aria-selected` is
 * set asynchronously during bootstrap, a single sample can observe the value of a tab that is
 * about to become selected anyway.
 *
 * Waiting for visibility first fixes the first half. The caller asserting the END STATE rather than
 * trusting its own click fixes the second — see `selectRootTab`.
 */
async function rootTabIsSelected(tab: Locator): Promise<boolean> {
  await expect(tab).toBeVisible({ timeout: ROOT_TAB_TIMEOUT_MS });
  return (await tab.getAttribute("aria-selected")) === "true";
}

/**
 * A root tab, addressed through the DOM instead of the accessibility tree.
 *
 * Playwright's role engine honours `aria-modal`: while the workspace-trust dialog that selecting a
 * root raises is open, every `getByRole("tab", …)` query for that tab reports "element(s) not
 * found" for its whole timeout, even though the tab is attached, on screen, and carrying the
 * correct `aria-selected`. That is how this spec failed on `dev` — the assertion could not observe
 * the very state the click had just produced. A CSS locator does not consult the accessibility
 * tree, so `aria-selected` stays readable through the dialog the selection itself raised. Measured
 * here with the dialog open: the role query resolves 0 elements, this one resolves 1 and reads
 * `aria-selected="true"` — the selection HAD taken, only the assertion could not see it.
 *
 * Scoped to the roots switcher so the locator stays strict: the editor mounts a second tablist for
 * open documents, and a strict-mode violation here must fail by name rather than as a timeout.
 */
function rootTab(page: Page, displayName: string): Locator {
  return page
    .locator('[role="tablist"][aria-label="Editor workspace roots"]')
    .first()
    .locator('[role="tab"]')
    .filter({ hasText: displayName });
}

/**
 * Selects a root tab and proves it took, idempotently.
 *
 * Clicking is still conditional — clicking an already-selected tab is not a no-op in this UI, it
 * re-enters the trust flow the caller may have just resolved. What changed is that the outcome is
 * asserted with a retrying, web-first expectation instead of being inferred from the click having
 * been issued: under the bootstrap race described in `rootTabIsSelected`, the click and the
 * bootstrap's own selection can land in either order, and only the end state is stable.
 */
async function selectRootTab(tab: Locator): Promise<void> {
  if (!(await rootTabIsSelected(tab))) await tab.click();
  // Still `aria-selected` on THIS tab, and nothing weaker. Treating "some trust dialog is open" as
  // proof that the selection took would accept a dialog raised for a different root — and would
  // answer it, which is how the caller below silently restricted the wrong workspace. `rootTab`
  // keeps the attribute observable through the dialog, so the strict assertion needs no escape.
  await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: ROOT_TAB_TIMEOUT_MS });
}

async function restrictBetaAndExpectAlphaTrusted(page: Page): Promise<void> {
  const prompt = page.getByRole("alertdialog", { name: "Trust this workspace?" });
  // Project bootstrap may focus either root when both registrations share the same timestamp, and
  // WHICH one it focused decides whether Beta can be clicked at all. When bootstrap lands on Beta,
  // Beta's trust prompt is already open — and it is `aria-modal`, so everything outside it leaves
  // the accessibility tree. Role-based locators then resolve to nothing even though the tab is in
  // the DOM and 235x32 pixels large: measured directly, `querySelector` finds the tablist in 3ms
  // while `getByRole` reports "element(s) not found" for the entire timeout. That is the whole
  // flake — not a slow bootstrap and not a sampling race, but a modal that legitimately hides the
  // tab this step used to insist on clicking first.
  //
  // So the prompt is consulted BEFORE the tab. If it is already open, bootstrap focused Beta, the
  // selection this function wanted has already happened, and clicking a tab that is not in the
  // accessibility tree is both impossible and unnecessary.
  if (!(await prompt.isVisible())) {
    // Bootstrap focused Alpha instead: Beta is reachable, and selecting it raises its prompt.
    await selectRootTab(rootTab(page, "M11 Root Beta"));
  }
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "Stay restricted" }).click();
  await expect(page.getByRole("note", { name: "Restricted Mode", exact: true })).toContainText(
    "Restricted Mode",
  );
  await expect(
    page.getByRole("treeitem", { name: "M11 Root Beta" }).getByLabel("Restricted Mode"),
  ).toBeVisible();
  await rootTab(page, "M11 Root Alpha").click();
  await expect(prompt).toHaveCount(0);
  await expect(
    page.getByRole("treeitem", { name: "M11 Root Alpha" }).getByLabel("Trusted workspace"),
  ).toBeVisible();
}

async function switchProfile(
  page: Page,
  root: string,
  profileRef: string,
): Promise<ProfileSwitchResult> {
  await rootTab(page, "M11 Root Alpha").click();
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
  await replaceEditorBuffer(page, pane, content);
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
  await replaceEditorBuffer(page, pane, UNSAVED_VERSION);
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

async function prepareCloseoutJourney(
  page: Page,
): Promise<{ readonly harness: CloseoutHarness; readonly switched: ProfileSwitchResult }> {
  const harness = createHarness();
  await page.goto(`/${pairingFragment()}`);
  await expect.poll(() => page.url()).not.toContain("keiko-app-session");
  await registerProject(page.request, harness.alpha.root, "M11 Root Alpha");
  await registerProject(page.request, harness.beta.root, "M11 Root Beta");
  await addSecondRoot(page.request, harness);
  await revokeEditorWorkspaceTrust(page.request, harness.beta.root);
  const profileRef = await createFocusedProfile(page.request, harness.alpha.root);
  await seedWindows(page, harness.alpha.root);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await openEditorWorkspace(page, { dismissTrustPrompt: false });
  await restrictBetaAndExpectAlphaTrusted(page);
  return { harness, switched: await switchProfile(page, harness.alpha.root, profileRef) };
}

async function reopenTrustedAlphaAfterProfileSwitch(page: Page, root: string): Promise<Locator> {
  // The active root is server-owned and can legitimately start on either root after replacement.
  // Clear only Beta's expected restricted prompt when Beta is active, then select Alpha explicitly
  // and prove the profile switch preserved Alpha's server-owned grant.
  const betaTab = rootTab(page, "M11 Root Beta");
  if (await rootTabIsSelected(betaTab)) {
    await page
      .getByRole("alertdialog", { name: "Trust this workspace?" })
      .getByRole("button", { name: "Stay restricted" })
      .click();
  }
  const alphaTab = rootTab(page, "M11 Root Alpha");
  await selectRootTab(alphaTab);
  const editor = await openEditorWorkspace(page, { dismissTrustPrompt: false });
  await expect(page.getByRole("alertdialog", { name: "Trust this workspace?" })).toHaveCount(0);
  await expectRootStillTrusted(page.request, root);
  await editor.locator(`${EDITOR_SELECTORS.treeRow}[data-path="src"]`).click();
  await openTreeFile(editor, FILE);
  return editor;
}

test.afterAll(() => {
  cleanupEditorWorkspaces();
});

test("mixed-trust multi-root, profile switching, and local-history restore compose end to end", async ({
  page,
  browserName,
}, testInfo) => {
  // KNOWN CROSS-ENGINE GAP — Gecko only, tracked, NOT a silent exclusion.
  // This journey replaces the whole editor buffer (`replaceEditorBuffer`) before asserting. Monaco
  // 0.56 uses the EditContext API where it exists and falls back to `textarea.inputarea` where it
  // does not; Firefox has no EditContext. On that fallback surface neither Ctrl+A nor Cmd+A reaches
  // Monaco's keybinding service, so the select-all selects nothing and the following insert APPENDS.
  // Verified on this host, not assumed: the sibling #2531 spec run with --project=firefox fails
  // inside the shared helper with `expected "…" at most 1x after replacing the buffer` — the helper
  // catching the corruption where it happens, which is the improvement over the silent doubling that
  // preceded it. Same gap and same wording as release-smoke.spec.ts.
  //
  // This config inherits BOTH projects from the shared base config, but its npm script pins
  // --project=chromium, so this guard changes no CI lane today; it exists so a future firefox run
  // fails as a documented skip rather than as a confusing corruption error.
  test.skip(
    browserName === "firefox",
    "Monaco select-all does not reach the EditContext fallback surface on Gecko; the buffer-replacement gesture is unproven there",
  );
  const { harness, switched } = await prepareCloseoutJourney(page);
  const journeyPage = switched.page;
  const editor = await reopenTrustedAlphaAfterProfileSwitch(journeyPage, harness.alpha.root);
  const pane = firstPane(editor);
  await saveVersion(journeyPage, pane, VERSION_ONE);
  // Read the oldest checkpoint's content from disk instead of hard-coding it (the sibling #2531
  // journey established this pattern): `replaceEditorBuffer` now VERIFIES the replacement rather
  // than assuming it, but what restore must guarantee is exactly "the file equals the oldest
  // checkpoint", and asserting that directly stays independent of how the buffer got there.
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
