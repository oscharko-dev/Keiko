import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { validateWorkspaceManifest, type WorkspaceManifest } from "@oscharko-dev/keiko-contracts";

import { cleanupEditorWorkspaces, createEditorWorkspace } from "./support/editorWorkspace.js";

const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const SETTINGS_WINDOW = '.window[data-window-id="issue-2527-settings"]';

interface SettingsSnapshot {
  readonly etag: string;
  readonly userRevision: number;
  readonly workspaceRevision: number;
  readonly rootRevision: number;
  readonly settings: readonly {
    readonly id: string;
    readonly value: unknown;
    readonly source: string;
  }[];
  readonly managedLanguages?: {
    readonly languages?: readonly {
      readonly language?: string;
      readonly reasonCode?: string;
      readonly state?: string;
    }[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function manifestFrom(value: unknown, root: string): WorkspaceManifest {
  if (!isRecord(value) || !Array.isArray(value.manifests)) {
    throw new Error("workspace manifests unavailable");
  }
  const manifests = value.manifests as readonly unknown[];
  const manifest = manifests.find(
    (candidate) =>
      validateWorkspaceManifest(candidate).ok &&
      (candidate as WorkspaceManifest).roots.some((entry) => entry.canonicalRoot === root),
  );
  if (manifest === undefined) throw new Error("workspace manifest missing");
  return manifest as WorkspaceManifest;
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

async function addRoot(
  request: APIRequestContext,
  actorRoot: string,
  nextRoot: string,
): Promise<void> {
  const listed = await request.get("/api/workspaces");
  const manifest = manifestFrom(await listed.json(), actorRoot);
  const actor = manifest.roots.find((root) => root.canonicalRoot === actorRoot);
  if (actor === undefined) throw new Error("workspace actor root missing");
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
      projectPath: nextRoot,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function settings(request: APIRequestContext, root: string): Promise<SettingsSnapshot> {
  const response = await request.get("/api/editor/settings", { params: { root } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as SettingsSnapshot;
}

async function mutateSetting(
  request: APIRequestContext,
  root: string,
  scope: "user" | "workspace" | "root",
  action: "set" | "reset",
  value?: number,
): Promise<SettingsSnapshot> {
  const current = await settings(request, root);
  const expectedRevision =
    scope === "user"
      ? current.userRevision
      : scope === "workspace"
        ? current.workspaceRevision
        : current.rootRevision;
  const response = await request.patch("/api/editor/settings", {
    headers: {
      ...MUTATION_HEADERS,
      "If-Match": current.etag,
      "Idempotency-Key": `issue-2527-${scope}-${action}-${String(expectedRevision)}`,
    },
    data: {
      schemaVersion: "1",
      root,
      scope,
      action,
      expectedRevision,
      ...(action === "set" ? { values: { fontSize: value } } : { settingIds: ["fontSize"] }),
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { readonly snapshot: SettingsSnapshot }).snapshot;
}

function fontSize(snapshot: SettingsSnapshot): SettingsSnapshot["settings"][number] | undefined {
  return snapshot.settings.find((setting) => setting.id === "fontSize");
}

async function grantTrust(request: APIRequestContext, root: string): Promise<void> {
  const response = await request.post("/api/editor/verification/trust", {
    headers: MUTATION_HEADERS,
    data: { projectId: root },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function activatePython(request: APIRequestContext, root: string): Promise<void> {
  const initial = await request.get("/api/editor/lsp/settings", { params: { root } });
  expect(initial.ok(), await initial.text()).toBe(true);
  const snapshot = (await initial.json()) as { readonly revision: number; readonly etag: string };
  const response = await request.put("/api/editor/lsp/settings", {
    headers: {
      ...MUTATION_HEADERS,
      "If-Match": snapshot.etag,
      "Idempotency-Key": "issue-2527-python-root-a",
    },
    data: { root, language: "python", action: "activate", expectedRevision: snapshot.revision },
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
          id: "issue-2527-settings",
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

async function verifyActiveRootSettingsPanel(page: Page): Promise<void> {
  await seedSettingsWindow(page);
  await page.goto("/");
  const window = page.locator(SETTINGS_WINDOW);
  await window.getByRole("button", { name: "Editor" }).click();
  await expect(window.getByRole("spinbutton", { name: "Font size" })).toHaveValue("18");
  await expect(window.getByText("Source: root").first()).toBeVisible();
  await window.getByRole("combobox", { name: "Scope" }).selectOption("root");
  await expect(window.getByRole("combobox", { name: "Scope" })).toHaveValue("root");
}

test.afterEach(() => {
  cleanupEditorWorkspaces();
});

test("two roots resolve independent settings and managed-language composition", async ({
  page,
  request,
}) => {
  const rootA = createEditorWorkspace([
    { path: "a.ts", content: "export const a = 1;\n" },
    { path: "package.json", content: '{"name":"settings-root-a","private":true}\n' },
  ]);
  const rootB = createEditorWorkspace([
    { path: "b.ts", content: "export const b = 2;\n" },
    { path: "package.json", content: '{"name":"settings-root-b","private":true}\n' },
  ]);
  await registerProject(request, rootA.root, "Settings root A");
  await registerProject(request, rootB.root, "Settings root B");
  await addRoot(request, rootA.root, rootB.root);

  await mutateSetting(request, rootA.root, "user", "set", 12);
  await mutateSetting(request, rootA.root, "workspace", "set", 14);
  expect(fontSize(await mutateSetting(request, rootA.root, "root", "set", 16))).toMatchObject({
    value: 16,
    source: "root",
  });
  expect(fontSize(await mutateSetting(request, rootB.root, "root", "set", 18))).toMatchObject({
    value: 18,
    source: "root",
  });
  expect(fontSize(await mutateSetting(request, rootA.root, "root", "reset"))).toMatchObject({
    value: 14,
    source: "workspace",
  });
  expect(fontSize(await mutateSetting(request, rootA.root, "workspace", "reset"))).toMatchObject({
    value: 12,
    source: "user",
  });
  await mutateSetting(request, rootA.root, "workspace", "set", 14);
  await mutateSetting(request, rootA.root, "root", "set", 16);

  await grantTrust(request, rootA.root);
  await activatePython(request, rootA.root);
  const [a, b] = await Promise.all([settings(request, rootA.root), settings(request, rootB.root)]);
  const pythonA = a.managedLanguages?.languages?.find((language) => language.language === "python");
  const pythonB = b.managedLanguages?.languages?.find((language) => language.language === "python");
  expect(pythonA?.reasonCode).not.toBe("WORKSPACE_UNTRUSTED");
  expect(pythonB).toMatchObject({ state: "disabledByPolicy", reasonCode: "WORKSPACE_UNTRUSTED" });

  await verifyActiveRootSettingsPanel(page);
});
