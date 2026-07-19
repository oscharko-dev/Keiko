import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { cleanupEditorWorkspaces, createEditorWorkspace } from "./support/editorWorkspace.js";

const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const SETTINGS_WINDOW = '.window[data-window-id="issue-2528-settings"]';

interface SettingsSnapshot {
  readonly etag: string;
  readonly userRevision: number;
  readonly profiles: {
    readonly etag: string;
    readonly revision: number;
    readonly activeProfileRef: string;
  };
}

interface ProfileMutationResult {
  readonly etag: string;
  readonly profileRef: string;
}

async function registerProject(request: APIRequestContext, root: string): Promise<void> {
  const response = await request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: root, name: "Profile journey" },
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

async function mutateUserFont(
  request: APIRequestContext,
  root: string,
  action: "set" | "reset",
): Promise<void> {
  const current = await settings(request, root);
  const response = await request.patch("/api/editor/settings", {
    headers: {
      ...MUTATION_HEADERS,
      "If-Match": current.etag,
      "Idempotency-Key": `issue-2528-user-${action}-${String(current.userRevision)}`,
    },
    data: {
      schemaVersion: "1",
      root,
      scope: "user",
      action,
      expectedRevision: current.userRevision,
      ...(action === "set" ? { values: { fontSize: 20 } } : { settingIds: ["fontSize"] }),
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function seedSettingsWindow(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem("keiko.theme", "dark");
    window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "issue-2528-settings",
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

async function createConfiguredProfile(
  request: APIRequestContext,
  root: string,
): Promise<ProfileMutationResult> {
  const initial = await settings(request, root);
  const created = await mutateProfile(
    request,
    root,
    initial.profiles.etag,
    { action: "create", displayName: "Focus", expectedRevision: 0 },
    "issue-2528-create-focus",
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
    "issue-2528-configure-focus",
  );
  return created;
}

test.afterEach(() => {
  cleanupEditorWorkspaces();
});

test("named profile settings and shortcuts switch live and persist", async ({ page, request }) => {
  const workspace = createEditorWorkspace([
    { path: "profile.ts", content: "export const profile = true;\n" },
  ]);
  await registerProject(request, workspace.root);
  const created = await createConfiguredProfile(request, workspace.root);

  await seedSettingsWindow(page);
  const window = await openEditorSettings(page);
  await window.getByRole("combobox", { name: "Profile" }).selectOption(created.profileRef);
  await window.getByRole("button", { name: "Switch" }).click();
  await expect(window.getByText("Current profile: Focus")).toBeVisible();
  await expect(window.getByRole("spinbutton", { name: "Font size" })).toHaveValue("18");
  await expect(window.getByText("Source: profile").first()).toBeVisible();
  await window
    .getByRole("textbox", { name: "Search keyboard shortcuts" })
    .fill("Quick Access: files");
  await expect(window.getByRole("button", { name: "Remove" })).toBeEnabled();

  await mutateUserFont(request, workspace.root, "set");
  await expect(window.getByRole("spinbutton", { name: "Font size" })).toHaveValue("20");
  await expect(window.getByText("Source: user").first()).toBeVisible();
  await window.getByRole("combobox", { name: "Profile" }).selectOption("profile-default");
  await window.getByRole("button", { name: "Switch" }).click();
  await expect(window.getByText("Current profile: Default")).toBeVisible();
  await mutateUserFont(request, workspace.root, "reset");
  await window.getByRole("combobox", { name: "Profile" }).selectOption(created.profileRef);
  await window.getByRole("button", { name: "Switch" }).click();
  await expect(window.getByRole("spinbutton", { name: "Font size" })).toHaveValue("18");

  await page.reload();
  await window.getByRole("button", { name: "Editor" }).click();
  await expect(window.getByText("Current profile: Focus")).toBeVisible();
  await expect(window.getByRole("spinbutton", { name: "Font size" })).toHaveValue("18");
  await expect(window.getByText("Source: profile").first()).toBeVisible();
});
