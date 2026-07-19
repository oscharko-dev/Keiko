import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateWorkspaceBinding } from "@oscharko-dev/keiko-contracts";
import type {
  WorkspaceManifest,
  WorkspaceRootDispatch,
  WorkspaceRootDispatchOperationClass,
} from "@oscharko-dev/keiko-contracts";
import { createInMemoryUiStore } from "./store/index.js";
import type { UiStore } from "./store/index.js";
import {
  createWorkspaceScriptTrustService,
  type WorkspaceScriptTrustService,
} from "./workspace-script-trust.js";
import { WorkspaceManifestError, WorkspaceManifestService } from "./workspace-manifests.js";

let tmp: string;
let rootA: string;
let rootB: string;
let store: UiStore;
let service: WorkspaceManifestService;
let trust: WorkspaceScriptTrustService;
let restrictedRoots: string[];

function dispatch(
  manifest: WorkspaceManifest,
  rootIndex: number,
  operationClass: WorkspaceRootDispatchOperationClass = "mutating",
): WorkspaceRootDispatch {
  const root = manifest.roots[rootIndex];
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
    operationClass,
  };
}

function errorCode(worker: () => unknown): string | undefined {
  try {
    worker();
    return undefined;
  } catch (error) {
    return error instanceof WorkspaceManifestError ? error.code : undefined;
  }
}

function recompute(roots: readonly string[]): readonly string[] {
  const worker = trust.recomputeForRoots;
  if (worker === undefined) throw new Error("missing trust recompute");
  return worker(roots);
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "keiko-workspace-manifest-")));
  rootA = join(tmp, "alpha");
  rootB = join(tmp, "beta");
  mkdirSync(rootA);
  mkdirSync(rootB);
  writeFileSync(join(rootA, "package.json"), '{"name":"alpha"}\n');
  writeFileSync(join(rootB, "package.json"), '{"name":"beta"}\n');
  store = createInMemoryUiStore({ now: () => 100 });
  store.createProject(rootA, "Alpha");
  store.createProject(rootB, "Beta");
  service = new WorkspaceManifestService(store);
  restrictedRoots = [];
  trust = createWorkspaceScriptTrustService({
    store,
    onRestricted: (root): void => {
      restrictedRoots.push(root);
    },
  });
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("WorkspaceManifestService", () => {
  it("runs the two-root journey with explicit dispatch and fail-closed trust recompute", () => {
    const initial = service.list();
    expect(initial).toHaveLength(2);
    const alpha = initial.find((manifest) => manifest.roots[0]?.canonicalRoot === rootA);
    if (alpha === undefined) throw new Error("missing alpha workspace");

    expect(trust.grant(rootB)).toEqual({ trusted: true });
    expect(trust.trustLevelForRoot(rootB)).toBe("trusted");

    const added = service.addRoot(dispatch(alpha, 0), rootB);
    expect(added.manifest.roots.map((root) => root.canonicalRoot)).toEqual([rootA, rootB]);
    expect(validateWorkspaceBinding(service.binding(alpha.workspaceId))).toEqual({ ok: true });
    expect(recompute(added.affectedRoots)).toEqual(["restricted", "restricted"]);
    expect(restrictedRoots).toEqual(expect.arrayContaining([rootA, rootB]));

    const current = added.manifest;
    expect(service.resolveDispatch(dispatch(current, 0, "executing")).canonicalRoot).toBe(rootA);
    expect(
      errorCode(() => service.resolveDispatch({ ...dispatch(current, 0), rootRef: undefined })),
    ).toBe("WORKSPACE_DISPATCH_INVALID");
    expect(
      errorCode(() =>
        service.resolveDispatch({
          ...dispatch(current, 0),
          rootRef: "root-foreign",
          rootIdentityDigest: "f".repeat(64),
        }),
      ),
    ).toBe("WORKSPACE_ROOT_NOT_MEMBER");

    expect(trust.grant(rootB)).toEqual({ trusted: true });
    expect(trust.trustLevelForRoot(rootB)).toBe("trusted");
    const removedRootRef = current.roots[1]?.rootRef;
    if (removedRootRef === undefined) throw new Error("missing beta root");
    const removed = service.removeRoot(dispatch(current, 0), removedRootRef);
    recompute(removed.affectedRoots);

    expect(removed.manifest.roots.map((root) => root.canonicalRoot)).toEqual([rootA]);
    expect(trust.trustLevelForRoot(rootB)).toBe("restricted");
    expect(store.readWorkspaceTrustRecord(removedRootRef)).toBeUndefined();
    expect(
      errorCode(() =>
        service.resolveDispatch({
          ...dispatch(removed.manifest, 0),
          rootRef: removedRootRef,
          rootIdentityDigest: current.roots[1]?.identityDigest,
        }),
      ),
    ).toBe("WORKSPACE_ROOT_NOT_MEMBER");
  });

  it("rejects stale, incomplete, and non-member mutation authority content-free", () => {
    const manifest = service.list()[0];
    if (manifest === undefined) throw new Error("missing manifest");
    expect(errorCode(() => service.addRoot(undefined, rootB))).toBe("WORKSPACE_DISPATCH_INVALID");
    expect(
      errorCode(() =>
        service.addRoot(
          { ...dispatch(manifest, 0), manifestRevision: manifest.revision + 1 },
          rootB,
        ),
      ),
    ).toBe("WORKSPACE_DISPATCH_STALE");
    expect(
      errorCode(() =>
        service.addRoot({ ...dispatch(manifest, 0), operationClass: "executing" }, rootB),
      ),
    ).toBe("WORKSPACE_DISPATCH_INVALID");
  });
});
