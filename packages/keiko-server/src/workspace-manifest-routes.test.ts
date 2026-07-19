import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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

const JSON_HEADERS = { "Content-Type": "application/json", "X-Keiko-CSRF": "1" } as const;

let server: Server;
let port: number;
let tmp: string;
let staticRoot: string;
let rootA: string;
let rootB: string;
let store: UiStore;

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
  };
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
  it("accepts a member-root dispatch and rejects missing or non-member authority", async () => {
    const listed = await fetch(requestUrl("/api/workspaces"));
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
});
