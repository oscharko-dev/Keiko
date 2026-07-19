import { readFile } from "node:fs/promises";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import { cleanupEditorWorkspaces, createEditorWorkspace } from "./support/editorWorkspace.js";

const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const SETTINGS_WINDOW = '.window[data-window-id="issue-2529-settings"]';

interface SettingsSnapshot {
  readonly profiles: {
    readonly etag: string;
    readonly revision: number;
  };
}

interface ProfileMutationResult {
  readonly etag: string;
  readonly profileRef: string;
}

async function registerProject(request: APIRequestContext, root: string): Promise<void> {
  const response = await request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: root, name: "Profile portability journey" },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function settings(request: APIRequestContext, root: string): Promise<SettingsSnapshot> {
  const response = await request.get("/api/editor/settings", { params: { root } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as SettingsSnapshot;
}

async function mutateProfile(
  request: APIRequestContext,
  root: string,
  etag: string,
  body: Record<string, unknown>,
  key: string,
): Promise<ProfileMutationResult> {
  const response = await request.patch("/api/editor/settings/profiles", {
    headers: { ...MUTATION_HEADERS, "If-Match": etag, "Idempotency-Key": key },
    data: { schemaVersion: "1", root, ...body },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as ProfileMutationResult;
}

async function seedFocusProfile(
  request: APIRequestContext,
  root: string,
): Promise<ProfileMutationResult> {
  const initial = await settings(request, root);
  const created = await mutateProfile(
    request,
    root,
    initial.profiles.etag,
    { action: "create", displayName: "Focus", expectedRevision: 0 },
    "issue-2529-create-focus",
  );
  await mutateProfile(
    request,
    root,
    created.etag,
    {
      action: "set",
      expectedRevision: 1,
      profileRef: created.profileRef,
      values: {
        fontSize: 18,
        keybindingOverrides: ["1|quick-access.files|CtrlOrMeta+Shift+O"],
      },
    },
    "issue-2529-configure-focus",
  );
  return created;
}

async function seedSettingsWindow(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem("keiko.theme", "dark");
    window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "issue-2529-settings",
          type: "settings",
          x: 24,
          y: 24,
          w: 1180,
          h: 900,
          z: 10,
          cfg: {},
          max: false,
        },
      ]),
    );
  });
}

async function openEditorSettings(page: Page): Promise<ReturnType<Page["locator"]>> {
  await page.goto("/");
  const window = page.locator(SETTINGS_WINDOW);
  await window.getByRole("button", { name: "Editor" }).click();
  await expect(window.getByText("Current profile: Default")).toBeVisible();
  return window;
}

async function downloadSelectedProfile(
  page: Page,
  window: Locator,
  profileRef: string,
): Promise<Record<string, unknown>> {
  await window.getByRole("combobox", { name: "Profile" }).selectOption(profileRef);
  const downloadPromise = page.waitForEvent("download");
  await window.getByRole("button", { name: "Export selected profile" }).click();
  const download = await downloadPromise;
  return JSON.parse(await readFile(await download.path(), "utf8")) as Record<string, unknown>;
}

async function deleteExportSource(
  request: APIRequestContext,
  root: string,
  profileRef: string,
): Promise<void> {
  const current = await settings(request, root);
  await mutateProfile(
    request,
    root,
    current.profiles.etag,
    { action: "delete", expectedRevision: 2, profileRef },
    "issue-2529-delete-export-source",
  );
}

function corruptExport(exported: Record<string, unknown>): Record<string, unknown> {
  const settingsLayer = exported.settings as Record<string, unknown>;
  return {
    ...exported,
    settings: {
      ...settingsLayer,
      values: {
        ...(settingsLayer.values as Record<string, unknown>),
        fontSize: 1000,
        tabSize: 4,
        watcherExclusions: ["/private/customer/**"],
        unknownSetting: true,
      },
    },
  };
}

async function expectRejectedPreview(window: Locator): Promise<void> {
  await expect(window.getByText("New profile: Focus")).toBeVisible();
  await expect(
    window.getByRole("row", { name: /fontSize Rejected VALUE_OUT_OF_BOUNDS/u }),
  ).toBeVisible();
  await expect(
    window.getByRole("row", { name: /unknownSetting Rejected UNKNOWN_SETTING/u }),
  ).toBeVisible();
  await expect(
    window.getByRole("row", { name: /watcherExclusions Rejected NON_PORTABLE_PATH/u }),
  ).toBeVisible();
}

test.afterEach(() => {
  cleanupEditorWorkspaces();
});

test("profile export, hostile preview, import-as-new, switch, and reset stay deterministic", async ({
  page,
  request,
}) => {
  const workspace = createEditorWorkspace([
    { path: "profile.ts", content: "export const profile = true;\n" },
  ]);
  await registerProject(request, workspace.root);
  const created = await seedFocusProfile(request, workspace.root);
  await seedSettingsWindow(page);
  const window = await openEditorSettings(page);
  const exported = await downloadSelectedProfile(page, window, created.profileRef);
  await deleteExportSource(request, workspace.root, created.profileRef);
  await expect(window.getByRole("combobox", { name: "Profile" })).toHaveValue("profile-default");
  const corrupted = corruptExport(exported);
  await window.getByLabel("Import profile file").setInputFiles({
    name: "focus-corrupted.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(corrupted), "utf8"),
  });

  await expectRejectedPreview(window);
  await window.getByRole("checkbox", { name: "Switch after import" }).check();
  await window.getByRole("button", { name: "Apply import" }).click();

  await expect(window.getByText("Current profile: Focus")).toBeVisible();
  await expect(window.getByRole("spinbutton", { name: "Font size" })).toHaveValue("13");
  await expect(window.getByRole("spinbutton", { name: "Tab size" })).toHaveValue("4");
  await window.getByRole("button", { name: "Reset to Default" }).click();
  await expect(window.getByRole("spinbutton", { name: "Tab size" })).toHaveValue("2");
});
