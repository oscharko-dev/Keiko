import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceManifest, WorkspaceRootDispatch } from "@oscharko-dev/keiko-contracts";
import { buildCspHeader } from "./csp.js";
import { buildRedactor, createRunRegistry } from "./index.js";
import type { UiHandlerDeps } from "./index.js";
import { createUiServer, UI_HOST } from "./server.js";
import { createInMemoryUiStore } from "./store/index.js";
import type { UiStore } from "./store/index.js";
import { createWorkspaceScriptTrustService } from "./workspace-script-trust.js";
import { createEditorSettingsControlService } from "./editor/settings/editorSettingsControl.js";
import type { EditorSettingsControlService } from "./editor/settings/editorSettingsControl.js";
import { createEditorSettingsStore } from "./editor/settings/editorSettingsStore.js";
import { createWorkspaceMutexRegistry } from "./task-workspace/mutex.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import { WorkspaceManifestService } from "./workspace-manifests.js";
import {
  createFakeSessionPairingPort,
  fakePairingRequestBody,
} from "./coding-app-session/_support.js";
import { APP_SESSION_COOKIE_NAME } from "./coding-app-session/sessionCookie.js";
import { createCodingAppSessionChannel } from "./coding-app-session/sessionChannel.js";
import { createSessionRegistry } from "./coding-app-session/sessionRegistry.js";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "X-Keiko-CSRF": "1",
  get Cookie(): string {
    return sessionCookie;
  },
} as const;
const UNPAIRED_JSON_HEADERS = {
  "Content-Type": "application/json",
  "X-Keiko-CSRF": "1",
} as const;

let server: Server;
let port: number;
let tmp: string;
let staticRoot: string;
let rootA: string;
let rootB: string;
let store: UiStore;
let editorSettingsControl: EditorSettingsControlService;
let diagnostics: ServerDiagnosticRecord[];
let sessionCookie: string;
// Read at call time, not at server construction, so a test can arm the failure after the fixture
// has already built its handler deps.
let invalidateRootFailure: Error | undefined;

function requestUrl(path: string): string {
  return `http://${UI_HOST}:${String(port)}${path}`;
}

function dispatch(manifest: WorkspaceManifest): WorkspaceRootDispatch {
  const root = manifest.roots[0];
  if (root === undefined) throw new Error("missing fixture root");
  return {
    kind: "workspace-root-dispatch",
    schemaVersion: manifest.schemaVersion,
    workspaceId: manifest.workspaceId,
    manifestRef: manifest.manifestRef,
    manifestRevision: manifest.revision,
    manifestDigest: manifest.manifestDigest,
    rootRef: root.rootRef,
    rootIdentityDigest: root.identityDigest,
    operationClass: "mutating",
  };
}

function deps(): UiHandlerDeps {
  const codingAppSessionChannel = createCodingAppSessionChannel({
    registry: createSessionRegistry(),
    pairingPort: createFakeSessionPairingPort(),
  });
  const paired = codingAppSessionChannel.pair(fakePairingRequestBody());
  if (!paired.paired) throw new Error("workspace route pairing failed");
  sessionCookie = `${APP_SESSION_COOKIE_NAME}=${paired.cookieToken}`;
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    workspaceScriptTrust: createWorkspaceScriptTrustService({ store }),
    editorSettingsControl: {
      ...editorSettingsControl,
      invalidateRoot: (realRoot: string): Promise<void> =>
        invalidateRootFailure === undefined
          ? (editorSettingsControl.invalidateRoot?.(realRoot) ?? Promise.resolve())
          : Promise.reject(invalidateRootFailure),
    },
    diagnostics: {
      record: (entry: ServerDiagnosticRecord): void => {
        diagnostics.push(entry);
      },
    },
    codingAppSessionChannel,
  };
}

async function setRootFontSize(realRoot: string, value: number, key: string): Promise<void> {
  await editorSettingsControl.mutate({
    action: "set",
    expectedRevision: 0,
    idempotencyKey: key,
    realRoot,
    scope: "root",
    values: { fontSize: value },
  });
}

async function rootFontSizeSource(realRoot: string): Promise<string | undefined> {
  const snapshot = await editorSettingsControl.read(realRoot);
  return snapshot.settings.find((entry) => entry.id === "fontSize")?.source;
}

async function closeServer(): Promise<void> {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
}

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "keiko-workspace-routes-")));
  staticRoot = join(tmp, "static");
  rootA = join(tmp, "alpha");
  rootB = join(tmp, "beta");
  mkdirSync(staticRoot);
  mkdirSync(rootA);
  mkdirSync(rootB);
  store = createInMemoryUiStore();
  diagnostics = [];
  invalidateRootFailure = undefined;
  editorSettingsControl = createEditorSettingsControlService({
    store: createEditorSettingsStore({ stateDir: join(tmp, "state") }),
    mutex: createWorkspaceMutexRegistry(),
  });
  store.createProject(rootA, "Alpha");
  store.createProject(rootB, "Beta");
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0 });
  await new Promise<void>((resolve) => server.listen(0, UI_HOST, resolve));
  port = (server.address() as AddressInfo).port;
  await closeServer();
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port, handlerDeps: deps() });
  await new Promise<void>((resolve) => server.listen(port, UI_HOST, resolve));
});

afterEach(async () => {
  await closeServer();
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("workspace manifest routes", () => {
  it("withholds canonical roots from an unpaired caller and serves them to the paired app", async () => {
    const unpaired = await fetch(requestUrl("/api/workspaces"));
    const unpairedText = await unpaired.text();
    expect(unpaired.status).toBe(200);
    expect(JSON.parse(unpairedText)).toEqual({ session: "unpaired", manifests: [] });
    expect(unpairedText).not.toContain(rootA);
    expect(unpairedText).not.toContain(rootB);

    const paired = await fetch(requestUrl("/api/workspaces"), {
      headers: { Cookie: sessionCookie },
    });
    const pairedText = await paired.text();
    expect(paired.status).toBe(200);
    expect(pairedText).toContain(rootA);
    expect(pairedText).toContain(rootB);

    const body = JSON.parse(pairedText) as { readonly manifests: readonly WorkspaceManifest[] };
    const knownWorkspaceId = body.manifests[0]?.workspaceId;
    if (knownWorkspaceId === undefined) throw new Error("missing paired workspace");
    const known = await fetch(requestUrl(`/api/workspaces/${knownWorkspaceId}`));
    const unknown = await fetch(requestUrl("/api/workspaces/ws-does-not-exist"));
    const knownText = await known.text();
    const unknownText = await unknown.text();
    expect(known.status).toBe(403);
    expect(unknown.status).toBe(403);
    expect(knownText).toBe(unknownText);
    expect(knownText).not.toContain(rootA);
    expect(knownText).not.toContain(rootB);
  });

  it("rejects an unpaired mutation before it can change membership or echo a path", async () => {
    const manifest = await alphaManifest();
    const response = await fetch(requestUrl(`/api/workspaces/${manifest.workspaceId}/roots`), {
      method: "POST",
      headers: UNPAIRED_JSON_HEADERS,
      body: JSON.stringify({ projectPath: rootB, dispatch: dispatch(manifest) }),
    });
    const responseText = await response.text();

    expect(response.status).toBe(403);
    expect(JSON.parse(responseText)).toEqual({
      error: {
        code: "APP_SESSION_REQUIRED",
        message: "The local app session is not paired.",
      },
    });
    expect(responseText).not.toContain(rootA);
    expect(responseText).not.toContain(rootB);
    expect(new WorkspaceManifestService(store).get(manifest.workspaceId).roots).toHaveLength(1);
  });

  it("accepts a member-root dispatch and rejects missing or non-member authority", async () => {
    const listed = await fetch(requestUrl("/api/workspaces"), {
      headers: { Cookie: sessionCookie },
    });
    const listBody = (await listed.json()) as { readonly manifests: readonly WorkspaceManifest[] };
    const manifest = listBody.manifests.find((item) => item.roots[0]?.canonicalRoot === rootA);
    if (manifest === undefined) throw new Error("missing alpha manifest");
    const endpoint = `/api/workspaces/${manifest.workspaceId}/roots`;

    const missing = await fetch(requestUrl(endpoint), {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ projectPath: rootB }),
    });
    expect(missing.status).toBe(400);

    const nonMember = await fetch(requestUrl(endpoint), {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        projectPath: rootB,
        dispatch: {
          ...dispatch(manifest),
          rootRef: "root-foreign",
          rootIdentityDigest: "f".repeat(64),
        },
      }),
    });
    expect(nonMember.status).toBe(403);
    expect(await nonMember.json()).toEqual({
      error: {
        code: "WORKSPACE_ROOT_NOT_MEMBER",
        message: "The selected root is not a workspace member.",
      },
    });

    const accepted = await fetch(requestUrl(endpoint), {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ projectPath: rootB, dispatch: dispatch(manifest) }),
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = (await accepted.json()) as { readonly manifest: WorkspaceManifest };
    expect(acceptedBody.manifest.roots.map((root) => root.canonicalRoot)).toEqual([rootA, rootB]);
  });

  it("serves a manifest with its binding and 404s an unknown workspace id", async () => {
    const manifest = await alphaManifest();
    const found = await fetch(requestUrl(`/api/workspaces/${manifest.workspaceId}`), {
      headers: { Cookie: sessionCookie },
    });
    expect(found.status).toBe(200);
    const foundBody = (await found.json()) as {
      readonly manifest: WorkspaceManifest;
      readonly binding: unknown;
    };
    expect(foundBody.manifest.workspaceId).toBe(manifest.workspaceId);
    expect(foundBody.binding).toBeDefined();

    const missing = await fetch(requestUrl("/api/workspaces/ws-does-not-exist"), {
      headers: { Cookie: sessionCookie },
    });
    expect(missing.status).toBe(404);
    const missingBody = (await missing.json()) as { readonly error: { readonly code: string } };
    expect(missingBody.error.code).toBe("WORKSPACE_MANIFEST_UNAVAILABLE");
  });

  it("rejects malformed bodies without reaching the store", async () => {
    const manifest = await alphaManifest();
    const endpoint = requestUrl(`/api/workspaces/${manifest.workspaceId}/roots`);

    const nonJson = await fetch(endpoint, {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{not json",
    });
    expect(nonJson.status).toBe(400);

    const arrayBody = await fetch(endpoint, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify([1, 2, 3]),
    });
    expect(arrayBody.status).toBe(400);

    const unknownKey = await fetch(endpoint, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ projectPath: rootB, dispatch: dispatch(manifest), extra: true }),
    });
    expect(unknownKey.status).toBe(400);

    const emptyProjectPath = await fetch(endpoint, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ projectPath: "", dispatch: dispatch(manifest) }),
    });
    expect(emptyProjectPath.status).toBe(400);

    const dispatchForOtherWorkspace = await fetch(endpoint, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        projectPath: rootB,
        dispatch: { ...dispatch(manifest), workspaceId: "ws-other" },
      }),
    });
    expect(dispatchForOtherWorkspace.status).toBe(400);
    expect(
      ((await dispatchForOtherWorkspace.json()) as { readonly error: { readonly code: string } })
        .error.code,
    ).toBe("WORKSPACE_REQUEST_INVALID");
  });

  it("rejects an over-limit body while streaming, before parsing", async () => {
    const manifest = await alphaManifest();
    const oversized = await fetch(requestUrl(`/api/workspaces/${manifest.workspaceId}/roots`), {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ projectPath: "x".repeat(70_000), dispatch: dispatch(manifest) }),
    });
    expect(oversized.status).toBe(400);
  });

  it("reorders, focuses, and removes roots through member-root dispatches", async () => {
    const initial = await alphaManifest();
    const added = await fetch(requestUrl(`/api/workspaces/${initial.workspaceId}/roots`), {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ projectPath: rootB, dispatch: dispatch(initial) }),
    });
    expect(added.status).toBe(200);
    let manifest = ((await added.json()) as { readonly manifest: WorkspaceManifest }).manifest;
    const [first, second] = manifest.roots;
    if (first === undefined || second === undefined) throw new Error("expected two roots");

    const reversed = await fetch(
      requestUrl(`/api/workspaces/${manifest.workspaceId}/roots/order`),
      {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          dispatch: dispatch(manifest),
          orderedRootRefs: [second.rootRef, first.rootRef],
        }),
      },
    );
    expect(reversed.status).toBe(200);
    manifest = ((await reversed.json()) as { readonly manifest: WorkspaceManifest }).manifest;
    expect(manifest.roots.map((root) => root.rootRef)).toEqual([second.rootRef, first.rootRef]);

    const badOrder = await fetch(
      requestUrl(`/api/workspaces/${manifest.workspaceId}/roots/order`),
      {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ dispatch: dispatch(manifest), orderedRootRefs: [1, 2] }),
      },
    );
    expect(badOrder.status).toBe(400);

    const focused = await fetch(requestUrl(`/api/workspaces/${manifest.workspaceId}/focus`), {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ dispatch: dispatch(manifest), focusedRootRef: first.rootRef }),
    });
    expect(focused.status).toBe(200);
    manifest = ((await focused.json()) as { readonly manifest: WorkspaceManifest }).manifest;
    expect(manifest.focusedRootRef).toBe(first.rootRef);

    const staleRemove = await fetch(
      requestUrl(`/api/workspaces/${manifest.workspaceId}/roots/${second.rootRef}`),
      {
        method: "DELETE",
        headers: JSON_HEADERS,
        body: JSON.stringify({ dispatch: { ...dispatch(manifest), manifestRevision: 0 } }),
      },
    );
    expect(staleRemove.status).toBe(409);

    const removed = await fetch(
      requestUrl(`/api/workspaces/${manifest.workspaceId}/roots/${second.rootRef}`),
      {
        method: "DELETE",
        headers: JSON_HEADERS,
        body: JSON.stringify({ dispatch: dispatch(manifest) }),
      },
    );
    expect(removed.status).toBe(200);
    manifest = ((await removed.json()) as { readonly manifest: WorkspaceManifest }).manifest;
    expect(manifest.roots.map((root) => root.rootRef)).toEqual([first.rootRef]);
  });

  it("invalidates the departed root's settings binding and leaves the survivor's intact", async () => {
    // #2620: ADR-0147 requires root removal to invalidate settings bindings, but this seam only
    // recomputed trust, so per-root settings outlived their root and could be re-applied to a
    // different directory that later occupied the same reference. Only the departed root is
    // invalidated — `affectedRoots` names the whole workspace and would have wiped the survivor.
    let manifest = await alphaManifest();
    const added = await fetch(requestUrl(`/api/workspaces/${manifest.workspaceId}/roots`), {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ dispatch: dispatch(manifest), projectPath: rootB }),
    });
    expect(added.status).toBe(200);
    manifest = ((await added.json()) as { readonly manifest: WorkspaceManifest }).manifest;
    const departing = manifest.roots.find((root) => root.canonicalRoot === rootB);
    if (departing === undefined) throw new Error("missing beta root");

    await setRootFontSize(rootA, 16, "routes-root-a");
    await setRootFontSize(rootB, 18, "routes-root-b");
    expect(await rootFontSizeSource(rootA)).toBe("root");
    expect(await rootFontSizeSource(rootB)).toBe("root");

    const removed = await fetch(
      requestUrl(`/api/workspaces/${manifest.workspaceId}/roots/${departing.rootRef}`),
      {
        method: "DELETE",
        headers: JSON_HEADERS,
        body: JSON.stringify({ dispatch: dispatch(manifest) }),
      },
    );
    expect(removed.status).toBe(200);

    expect(await rootFontSizeSource(rootB)).toBe("builtInDefault");
    expect(await rootFontSizeSource(rootA)).toBe("root");
  });

  it("keeps every per-root settings binding across a view-only reorder", async () => {
    // Reorder changes no membership, so it invalidates nothing — the same rule that keeps trust
    // grants alive across a focus click (ADR-0155).
    let manifest = await alphaManifest();
    const added = await fetch(requestUrl(`/api/workspaces/${manifest.workspaceId}/roots`), {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ dispatch: dispatch(manifest), projectPath: rootB }),
    });
    manifest = ((await added.json()) as { readonly manifest: WorkspaceManifest }).manifest;
    await setRootFontSize(rootA, 16, "routes-reorder-a");
    await setRootFontSize(rootB, 18, "routes-reorder-b");

    const reordered = await fetch(
      requestUrl(`/api/workspaces/${manifest.workspaceId}/roots/order`),
      {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          dispatch: dispatch(manifest),
          orderedRootRefs: [...manifest.roots].reverse().map((root) => root.rootRef),
        }),
      },
    );
    expect(reordered.status).toBe(200);

    expect(await rootFontSizeSource(rootA)).toBe("root");
    expect(await rootFontSizeSource(rootB)).toBe("root");
  });

  it("still reports a successful removal when the departed root left the filesystem", async () => {
    // The membership change commits before settings invalidation runs. A root whose directory is
    // gone has no readable identity, and reporting the propagation failure as a failed mutation
    // would answer a removal that DID happen with a 500 — and the retry would then fail as a
    // non-member. The stale record stays inert either way, because it binds an identity that no
    // longer resolves.
    let manifest = await alphaManifest();
    const added = await fetch(requestUrl(`/api/workspaces/${manifest.workspaceId}/roots`), {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ dispatch: dispatch(manifest), projectPath: rootB }),
    });
    manifest = ((await added.json()) as { readonly manifest: WorkspaceManifest }).manifest;
    const departing = manifest.roots.find((root) => root.canonicalRoot === rootB);
    if (departing === undefined) throw new Error("missing beta root");
    await setRootFontSize(rootB, 18, "routes-vanished-b");

    mkdirSync(`${rootB}.replacement`);
    rmSync(rootB, { recursive: true, force: true });

    const removed = await fetch(
      requestUrl(`/api/workspaces/${manifest.workspaceId}/roots/${departing.rootRef}`),
      {
        method: "DELETE",
        headers: JSON_HEADERS,
        body: JSON.stringify({ dispatch: dispatch(manifest) }),
      },
    );
    expect(removed.status).toBe(200);
    const body = (await removed.json()) as { readonly manifest: WorkspaceManifest };
    expect(body.manifest.roots.map((root) => root.canonicalRoot)).toEqual([rootA]);

    // The loss is reported, not swallowed: the project stays registered with no workspace of its
    // own, and that degradation reaches an operator instead of dying inside the store transaction.
    expect(store.findWorkspaceManifestRecordByProject(rootB)).toBeUndefined();
    const restoreDiagnostic = diagnostics.find(
      (record) => record.operation === "workspace.root.restore",
    );
    // The count must actually reach the record, not just be interpolated into a message string the
    // diagnostic sink never reads (#2768): occurrenceCount is a real field on the record, unlike
    // the discarded `WORKSPACE_ROOT_NOT_RESTORED count=…` message the pre-fix code only built.
    expect(restoreDiagnostic).toMatchObject({
      correlationId: manifest.workspaceId,
      source: "workspace-manifest-routes",
      errorClass: "WorkspaceRootNotRestoredError",
      occurrenceCount: 1,
    });
    expect(JSON.stringify(restoreDiagnostic)).not.toContain(rootB);

    // The reason travels with the report, not just the count: a vanished directory and an exhausted
    // identity space are different operational stories (Qodo review, PR #2714), and
    // `restoreFailureClasses` must actually be consumed rather than computed and discarded (#2768).
    // The class name is content-free — no path, no message text.
    const reasonDiagnostic = diagnostics.find(
      (record) => record.operation === "workspace.root.restore.reason",
    );
    expect(reasonDiagnostic).toMatchObject({
      correlationId: manifest.workspaceId,
      source: "workspace-manifest-routes",
      occurrenceCount: 1,
    });
    expect(reasonDiagnostic?.errorClass).toBeDefined();
    expect(JSON.stringify(reasonDiagnostic)).not.toContain(rootB);

    // A new directory taking the departed root's place inherits nothing: the record binds the old
    // filesystem identity, so it stays inert whether or not the invalidation rewrite landed. The
    // replacement is staged before the removal so its inode cannot be the recycled one — Linux
    // commonly reuses a freed inode, which would leave the identity digest byte-identical.
    renameSync(`${rootB}.replacement`, rootB);
    expect(await rootFontSizeSource(rootB)).toBe("builtInDefault");
  });

  it("answers a failing settings invalidation with a body-free diagnostic, not a failed mutation", async () => {
    // The membership change is already committed when invalidation runs. Reporting a propagation
    // failure as a failed mutation would answer a removal that DID happen with a 500, and the
    // retry would then fail as a non-member.
    let manifest = await alphaManifest();
    const added = await fetch(requestUrl(`/api/workspaces/${manifest.workspaceId}/roots`), {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ dispatch: dispatch(manifest), projectPath: rootB }),
    });
    manifest = ((await added.json()) as { readonly manifest: WorkspaceManifest }).manifest;
    const departing = manifest.roots.find((root) => root.canonicalRoot === rootB);
    if (departing === undefined) throw new Error("missing beta root");
    invalidateRootFailure = new Error("settings sink unavailable");

    const removed = await fetch(
      requestUrl(`/api/workspaces/${manifest.workspaceId}/roots/${departing.rootRef}`),
      {
        method: "DELETE",
        headers: JSON_HEADERS,
        body: JSON.stringify({ dispatch: dispatch(manifest) }),
      },
    );

    expect(removed.status).toBe(200);
    const entry = diagnostics.find(
      (record) => record.operation === "workspace.root.settings.invalidate",
    );
    expect(entry).toMatchObject({
      correlationId: manifest.workspaceId,
      source: "workspace-manifest-routes",
    });
    // Body-free: no canonical path and no foreign error text reach the diagnostic.
    expect(JSON.stringify(entry)).not.toContain(rootB);
    expect(JSON.stringify(entry)).not.toContain("settings sink unavailable");
  });
});

async function alphaManifest(): Promise<WorkspaceManifest> {
  const listed = await fetch(requestUrl("/api/workspaces"), {
    headers: { Cookie: sessionCookie },
  });
  const body = (await listed.json()) as { readonly manifests: readonly WorkspaceManifest[] };
  const manifest = body.manifests.find((item) => item.roots[0]?.canonicalRoot === rootA);
  if (manifest === undefined) throw new Error("missing alpha manifest");
  return manifest;
}
