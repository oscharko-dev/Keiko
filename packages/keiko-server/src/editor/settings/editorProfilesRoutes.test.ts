import { mkdtemp, realpath, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EDITOR_M11_DEFAULT_PROFILE_REF,
  isWorkspaceProfileRef,
  type EditorM11ProfilesSnapshot,
  type WorkspaceProfileExportResult,
  type WorkspaceProfileImportPreview,
  type WorkspaceProfileRef,
} from "@oscharko-dev/keiko-contracts";

import { buildCspHeader } from "../../csp.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "../../index.js";
import { createRunRegistry } from "../../runs.js";
import { createUiServer, UI_HOST } from "../../server.js";
import { createWorkspaceMutexRegistry } from "../../task-workspace/mutex.js";
import { createEditorSettingsControlService } from "./editorSettingsControl.js";
import { createEditorSettingsEventBus } from "./editorSettingsEvents.js";
import { createEditorSettingsStore } from "./editorSettingsStore.js";

let server: Server;
let staticRoot: string;
let workspaceRoot: string;
let stateDir: string;
let port: number;

function profileRef(value: string): WorkspaceProfileRef {
  if (!isWorkspaceProfileRef(value)) throw new Error(`invalid profile fixture: ${value}`);
  return value;
}

async function listen(srv: Server): Promise<number> {
  await new Promise<void>((resolve) => srv.listen(0, UI_HOST, resolve));
  return (srv.address() as AddressInfo).port;
}

async function closeServer(srv: Server = server): Promise<void> {
  await new Promise<void>((resolve) =>
    srv.close(() => {
      resolve();
    }),
  );
}

async function buildServer(handlerDeps: UiHandlerDeps): Promise<{ server: Server; port: number }> {
  const probe = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0, handlerDeps });
  const chosenPort = await listen(probe);
  await closeServer(probe);
  const next = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port: chosenPort,
    handlerDeps,
  });
  await new Promise<void>((resolve) => next.listen(chosenPort, UI_HOST, resolve));
  return { server: next, port: chosenPort };
}

function baseDeps(): UiHandlerDeps {
  const store = createInMemoryUiStore();
  store.createProject(workspaceRoot);
  const refs = [profileRef("profile-focus"), profileRef("profile-copy")];
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: () => "",
      list: () => [],
      get: () => undefined,
      delete: () => undefined,
    },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    editorSettingsControl: createEditorSettingsControlService({
      store: createEditorSettingsStore({ stateDir }),
      mutex: createWorkspaceMutexRegistry(),
      profileRefFactory: () => refs.shift() ?? profileRef("profile-exhausted"),
    }),
    editorSettingsEvents: createEditorSettingsEventBus(),
  };
}

beforeEach(async () => {
  staticRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-editor-profiles-static-")));
  workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-editor-profiles-root-")));
  stateDir = await realpath(await mkdtemp(join(tmpdir(), "keiko-editor-profiles-state-")));
  const built = await buildServer(baseDeps());
  server = built.server;
  port = built.port;
});

afterEach(async () => {
  await closeServer();
  await Promise.all(
    [staticRoot, workspaceRoot, stateDir].map((path) => rm(path, { recursive: true, force: true })),
  );
});

function baseUrl(): string {
  return `http://${UI_HOST}:${String(port)}`;
}

async function profiles(): Promise<{
  readonly response: Response;
  readonly body: EditorM11ProfilesSnapshot;
}> {
  const response = await fetch(`${baseUrl()}/api/editor/settings/profiles`);
  const body = (await response.json()) as EditorM11ProfilesSnapshot;
  expect(response.status, JSON.stringify(body)).toBe(200);
  return { response, body };
}

async function mutate(body: Record<string, unknown>, etag: string, key: string): Promise<Response> {
  return fetch(`${baseUrl()}/api/editor/settings/profiles`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Keiko-CSRF": "1",
      "If-Match": etag,
      "Idempotency-Key": key,
    },
    body: JSON.stringify({ schemaVersion: "1", root: workspaceRoot, ...body }),
  });
}

async function exportProfile(ref: WorkspaceProfileRef): Promise<WorkspaceProfileExportResult> {
  const response = await fetch(
    `${baseUrl()}/api/editor/settings/profiles/export?profileRef=${encodeURIComponent(ref)}`,
  );
  const body = (await response.json()) as WorkspaceProfileExportResult;
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body;
}

async function previewImport(
  manifest: unknown,
  etag: string,
): Promise<WorkspaceProfileImportPreview> {
  const response = await fetch(`${baseUrl()}/api/editor/settings/profiles/import/preview`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Keiko-CSRF": "1",
      "If-Match": etag,
    },
    body: JSON.stringify(manifest),
  });
  const body = (await response.json()) as WorkspaceProfileImportPreview;
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body;
}

async function applyImport(
  manifest: unknown,
  preview: WorkspaceProfileImportPreview,
  root: string,
): Promise<Response> {
  return fetch(`${baseUrl()}/api/editor/settings/profiles/import/apply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Keiko-CSRF": "1",
      "If-Match": `"edp-${String(preview.expectedRevision)}"`,
      "Idempotency-Key": "apply-profile-import",
    },
    body: JSON.stringify({
      schemaVersion: "1",
      expectedRevision: preview.expectedRevision,
      manifest,
      previewDigest: preview.previewDigest,
      switchAfterImport: true,
      root,
    }),
  });
}

describe("editor profile routes", () => {
  it("creates, configures, and live-switches a profile", async () => {
    const initial = await profiles();
    const created = await mutate(
      { action: "create", displayName: "Focus", expectedRevision: 0 },
      initial.body.etag,
      "create-focus",
    );
    const createBody = (await created.json()) as { readonly etag: string };
    const configured = await mutate(
      {
        action: "set",
        expectedRevision: 1,
        profileRef: "profile-focus",
        values: { fontSize: 18, keybindingOverrides: ["1|quick-access.files|CtrlOrMeta+Shift+O"] },
      },
      createBody.etag,
      "configure-focus",
    );
    const configuredBody = (await configured.json()) as { readonly etag: string };
    const switched = await mutate(
      { action: "switch", expectedRevision: 2, profileRef: "profile-focus" },
      configuredBody.etag,
      "switch-focus",
    );
    const body = (await switched.json()) as {
      readonly settings: {
        readonly settings: readonly { readonly id: string; readonly source: string }[];
      };
    };

    expect(initial.body.profiles).toMatchObject([{ displayName: "Default", builtIn: true }]);
    expect(created.status, JSON.stringify(createBody)).toBe(200);
    expect(configured.status).toBe(200);
    expect(switched.status).toBe(200);
    expect(body.settings.settings.find((setting) => setting.id === "fontSize")?.source).toBe(
      "profile",
    );
  });

  it("rejects stale etags and idempotency-key reuse", async () => {
    const initial = await profiles();
    const body = { action: "create", displayName: "Focus", expectedRevision: 0 };
    const first = await mutate(body, initial.body.etag, "profile-once");
    const stale = await mutate(body, initial.body.etag, "profile-stale");
    const reused = await mutate(
      { ...body, displayName: "Other" },
      initial.body.etag,
      "profile-once",
    );

    expect(first.status, await first.clone().text()).toBe(200);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "STALE_REVISION" } });
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });
  });

  it("keeps Default immutable", async () => {
    const initial = await profiles();
    const response = await mutate(
      { action: "delete", expectedRevision: 0, profileRef: "profile-default" },
      initial.body.etag,
      "delete-default",
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "DEFAULT_PROFILE_IMMUTABLE" },
    });
  });

  it("exports deterministically and imports only the explicitly previewed valid subset", async () => {
    const initial = await profiles();
    const created = await mutate(
      { action: "create", displayName: "Focus", expectedRevision: 0 },
      initial.body.etag,
      "create-export-focus",
    );
    const createBody = (await created.json()) as { readonly etag: string };
    const configured = await mutate(
      {
        action: "set",
        expectedRevision: 1,
        profileRef: "profile-focus",
        values: { fontSize: 18, tabSize: 4 },
      },
      createBody.etag,
      "configure-export-focus",
    );
    const configuredBody = (await configured.json()) as { readonly etag: string };
    const exported = await exportProfile(profileRef("profile-focus"));
    const corrupted = {
      ...exported.manifest,
      settings: {
        ...exported.manifest.settings,
        values: {
          ...exported.manifest.settings.values,
          fontSize: 1000,
          watcherExclusions: ["/private/customer/**"],
          unknownSetting: true,
        },
      },
    };
    const preview = await previewImport(corrupted, configuredBody.etag);
    const forged = await applyImport(
      corrupted,
      { ...preview, previewDigest: "0".repeat(64) },
      workspaceRoot,
    );
    const response = await applyImport(corrupted, preview, workspaceRoot);
    const body = (await response.json()) as {
      readonly profileRef: string;
      readonly profiles: EditorM11ProfilesSnapshot;
      readonly settings: {
        readonly settings: readonly { readonly id: string; readonly value: unknown }[];
      };
    };

    expect(exported.serializedManifest).toContain('"displayName": "Focus"');
    expect(preview.proposedDisplayName).toBe("Focus (Imported)");
    expect(preview.rows).toMatchObject([
      { settingId: "fontSize", disposition: "rejected" },
      { settingId: "tabSize", disposition: "add", value: 4 },
      { settingId: "watcherExclusions", disposition: "rejected" },
      { settingId: "unknownSetting", disposition: "rejected" },
    ]);
    expect(forged.status).toBe(400);
    expect(await forged.json()).toMatchObject({ error: { code: "PREVIEW_MISMATCH" } });
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.profileRef).toBe("profile-copy");
    expect(body.profiles.activeProfileRef).toBe("profile-copy");
    expect(body.profiles.profiles).toMatchObject([
      { displayName: "Default" },
      { displayName: "Focus", settingCount: 2 },
      { displayName: "Focus (Imported)", settingCount: 1 },
    ]);
    expect(body.settings.settings.find((setting) => setting.id === "fontSize")?.value).toBe(13);
    expect(body.settings.settings.find((setting) => setting.id === "tabSize")?.value).toBe(4);
  });

  it("refuses future manifests and stale apply attempts without creating a profile", async () => {
    const initial = await profiles();
    const future = await fetch(`${baseUrl()}/api/editor/settings/profiles/import/preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Keiko-CSRF": "1",
        "If-Match": initial.body.etag,
      },
      body: JSON.stringify({ schemaVersion: 2 }),
    });

    expect(future.status).toBe(400);
    expect(await future.json()).toMatchObject({ error: { code: "FUTURE_SCHEMA_VERSION" } });
    const exported = await exportProfile(EDITOR_M11_DEFAULT_PROFILE_REF);
    const preview = await previewImport(exported.manifest, initial.body.etag);
    await mutate(
      { action: "create", displayName: "Other", expectedRevision: 0 },
      initial.body.etag,
      "advance-before-import",
    );
    const stale = await applyImport(exported.manifest, preview, workspaceRoot);

    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "STALE_REVISION" } });
    expect((await profiles()).body.profiles).toHaveLength(2);
  });
});
