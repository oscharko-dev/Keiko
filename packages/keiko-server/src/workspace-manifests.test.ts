import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  validateWorkspaceBinding,
  WORKSPACE_MANIFEST_MAX_ROOTS,
} from "@oscharko-dev/keiko-contracts";
import type {
  WorkspaceManifest,
  WorkspaceRootDispatch,
  WorkspaceRootDispatchOperationClass,
} from "@oscharko-dev/keiko-contracts";
import { createInMemoryUiStore } from "./store/index.js";
import type { UiStore } from "./store/index.js";
import {
  createWorkspaceScriptTrustService,
  WorkspaceScriptTrustError,
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

function alphaWorkspace(): WorkspaceManifest {
  const alpha = service.list().find((manifest) => manifest.roots[0]?.canonicalRoot === rootA);
  if (alpha === undefined) throw new Error("missing alpha workspace");
  return alpha;
}

function rootRefAt(manifest: WorkspaceManifest, index: number): string {
  const root = manifest.roots[index];
  if (root === undefined) throw new Error("missing fixture root");
  return root.rootRef;
}

/**
 * The membership invariant #2620 exists to protect: every registered project resolves to a
 * workspace manifest. A project that survives a membership change with no workspace of its own is
 * silently orphaned — it keeps its registration but can never be dispatched against again.
 */
function expectNoOrphanedProjects(): void {
  const orphans = store
    .listProjects()
    .filter((project) => store.findWorkspaceManifestRecordByProject(project.path) === undefined)
    .map((project) => project.path);
  expect(orphans).toEqual([]);
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

  it("keeps workspace trust across focus and reorder, and drops it only on membership change", () => {
    // Regression: replaceWorkspaceManifest deleted the trust rows for the UNION of previous and
    // next root refs, and affectedRootPaths reported that same union, so a mutation that changes
    // no membership at all destroyed every stored grant and recomputed every root. Focus and
    // reorder change no membership and therefore no authority.
    // ADR-0155 completes the repair at the contract layer: the binding comparison no longer
    // includes the workspace-level manifest revision and digest, so the grant survives the
    // revision bump that focus and reorder produce.
    const alpha = service.list().find((manifest) => manifest.roots[0]?.canonicalRoot === rootA);
    if (alpha === undefined) throw new Error("missing alpha workspace");
    const twoRoots = service.addRoot(dispatch(alpha, 0), rootB).manifest;

    expect(trust.grant(rootA)).toEqual({ trusted: true });
    expect(trust.grant(rootB)).toEqual({ trusted: true });

    const beta = twoRoots.roots[1];
    const first = twoRoots.roots[0];
    if (beta === undefined || first === undefined) throw new Error("missing fixture roots");

    const focused = service.focusRoot(dispatch(twoRoots, 0), beta.rootRef);
    expect(focused.manifest.focusedRootRef).toBe(beta.rootRef);
    expect(focused.affectedRoots).toEqual([]);
    expect(store.readWorkspaceTrustRecord(first.rootRef)).toBeDefined();
    expect(store.readWorkspaceTrustRecord(beta.rootRef)).toBeDefined();
    // ADR-0155: the grant still projects as trusted, because focus changes no authority.
    expect(trust.trustLevelForRoot(rootA)).toBe("trusted");
    expect(trust.trustLevelForRoot(rootB)).toBe("trusted");

    const reordered = service.reorderRoots(dispatch(focused.manifest, 0), [
      beta.rootRef,
      first.rootRef,
    ]);
    expect(reordered.manifest.roots.map((root) => root.canonicalRoot)).toEqual([rootB, rootA]);
    expect(reordered.affectedRoots).toEqual([]);
    expect(store.readWorkspaceTrustRecord(first.rootRef)).toBeDefined();
    expect(store.readWorkspaceTrustRecord(beta.rootRef)).toBeDefined();
    expect(trust.trustLevelForRoot(rootA)).toBe("trusted");
    expect(trust.trustLevelForRoot(rootB)).toBe("trusted");

    // Membership change must still invalidate, which is the behaviour the union was protecting.
    const removed = service.removeRoot(dispatch(reordered.manifest, 0), first.rootRef);
    recompute(removed.affectedRoots);
    expect(store.readWorkspaceTrustRecord(first.rootRef)).toBeUndefined();
    expect(trust.trustLevelForRoot(rootA)).toBe("restricted");
  });

  it("returns a removed root to its own standalone single-root workspace", () => {
    // #2620: addRoot absorbs the joining root's single-root manifest and deletes it, so before this
    // removeRoot left the project registered with no workspace of its own — permanently orphaned
    // and undispatchable. Membership changes must be reversible (ADR-0147 D8).
    const twoRoots = service.addRoot(dispatch(alphaWorkspace(), 0), rootB).manifest;
    const betaRef = rootRefAt(twoRoots, 1);
    expect(trust.grant(rootB)).toEqual({ trusted: true });

    const removed = service.removeRoot(dispatch(twoRoots, 0), betaRef);

    expect(removed.manifest.roots.map((root) => root.canonicalRoot)).toEqual([rootA]);
    const restored = store.findWorkspaceManifestRecordByProject(rootB);
    expect(restored?.workspaceId).toBeDefined();
    expect(removed.restoredWorkspaceIds).toEqual([restored?.workspaceId]);

    const standalone = service.get(restored?.workspaceId ?? "");
    expect(standalone.roots.map((root) => root.canonicalRoot)).toEqual([rootB]);
    expect(standalone.focusedRootRef).toBe(standalone.roots[0]?.rootRef);
    expect(validateWorkspaceBinding(service.binding(standalone.workspaceId))).toEqual({ ok: true });

    // Restoration returns membership, never authority. The departed grant stays revoked in the same
    // committed transition (ADR-0155), so the human must grant the standalone workspace again.
    expect(store.readWorkspaceTrustRecord(betaRef)).toBeUndefined();
    expect(trust.trustLevelForRoot(rootB)).toBe("restricted");
    expectNoOrphanedProjects();
  });

  it("restores the founding root, whose identity the workspace it founded still carries", () => {
    // A workspace keeps the workspaceId and manifestRef derived from the root that founded it, even
    // after that root leaves. Restoring the founding root therefore collides with its own former
    // workspace, which is still alive under the remaining members. The first cut of #2620 swallowed
    // that UNIQUE violation and orphaned exactly the root the restore exists to rescue.
    const twoRoots = service.addRoot(dispatch(alphaWorkspace(), 0), rootB).manifest;
    const foundingRef = rootRefAt(twoRoots, 0);
    expect(twoRoots.workspaceId).toBe(alphaWorkspace().workspaceId);

    const removed = service.removeRoot(dispatch(twoRoots, 1), foundingRef);

    expect(removed.manifest.roots.map((root) => root.canonicalRoot)).toEqual([rootB]);
    expect(removed.unrestoredProjectPaths).toEqual([]);
    expect(removed.restoredWorkspaceIds).toHaveLength(1);
    expectNoOrphanedProjects();

    // The restored workspace is a genuinely separate one, not a second claim on the surviving id.
    const restored = store.findWorkspaceManifestRecordByProject(rootA);
    expect(restored?.workspaceId).not.toBe(removed.manifest.workspaceId);
    const standalone = service.get(restored?.workspaceId ?? "");
    expect(standalone.roots.map((root) => root.canonicalRoot)).toEqual([rootA]);
    expect(service.list()).toHaveLength(2);
  });

  it("reports an unrestorable removal instead of silently orphaning the project", () => {
    // A root whose directory is gone cannot be re-inspected, so its standalone workspace cannot be
    // minted. Two things must still hold: the removal itself succeeds — a root that vanished from
    // disk has to stay removable, or the workspace is stuck with it forever — and the loss is
    // explicit rather than silent, which is what the empty `restoredWorkspaceIds` reports (#2620).
    const twoRoots = service.addRoot(dispatch(alphaWorkspace(), 0), rootB).manifest;
    const beta = twoRoots.roots[1];
    if (beta === undefined) throw new Error("missing beta root");
    rmSync(rootB, { recursive: true, force: true });
    const removed = service.removeRoot(dispatch(twoRoots, 0), beta.rootRef);

    expect(removed.manifest.roots.map((root) => root.canonicalRoot)).toEqual([rootA]);
    expect(removed.restoredWorkspaceIds).toEqual([]);
    expect(store.findWorkspaceManifestRecordByRoot(beta.rootRef)).toBeUndefined();
    expect(store.listProjects().some((project) => project.path === rootB)).toBe(true);
    // The failed restore rolled back to its savepoint without taking the membership change with it.
    expect(store.readWorkspaceManifestRecord(twoRoots.workspaceId)?.revision).toBe(
      removed.manifest.revision,
    );

    // Every trust entry point still fails closed with a coded error rather than an uncoded one the
    // server would turn into an opaque 500. The pre-manifest projection itself is pinned at the
    // layer that owns it, in workspace-script-trust.test.ts.
    for (const worker of [
      (): unknown => trust.status(rootB),
      (): unknown => trust.grant(rootB),
      (): unknown => trust.revoke(rootB),
    ]) {
      expect(worker).toThrow(WorkspaceScriptTrustError);
    }
  });

  it("proves reorder authority: invalid, non-mutating, stale, and non-member dispatch all fail", () => {
    // #2620: reorderRoots was a named #2524 deliverable with zero server-side coverage, so nothing
    // pinned that it re-proves authority the way addRoot/removeRoot do (ADR-0147 D4).
    const twoRoots = service.addRoot(dispatch(alphaWorkspace(), 0), rootB).manifest;
    const order = [rootRefAt(twoRoots, 1), rootRefAt(twoRoots, 0)];

    expect(errorCode(() => service.reorderRoots(undefined, order))).toBe(
      "WORKSPACE_DISPATCH_INVALID",
    );
    expect(
      errorCode(() =>
        service.reorderRoots({ ...dispatch(twoRoots, 0), operationClass: "executing" }, order),
      ),
    ).toBe("WORKSPACE_DISPATCH_INVALID");
    expect(
      errorCode(() =>
        service.reorderRoots(
          { ...dispatch(twoRoots, 0), manifestRevision: twoRoots.revision + 1 },
          order,
        ),
      ),
    ).toBe("WORKSPACE_DISPATCH_STALE");
    expect(
      errorCode(() =>
        service.reorderRoots({ ...dispatch(twoRoots, 0), manifestDigest: "f".repeat(64) }, order),
      ),
    ).toBe("WORKSPACE_DISPATCH_STALE");
    expect(
      errorCode(() =>
        service.reorderRoots(
          { ...dispatch(twoRoots, 0), rootRef: "root-foreign", rootIdentityDigest: "f".repeat(64) },
          order,
        ),
      ),
    ).toBe("WORKSPACE_ROOT_NOT_MEMBER");

    // The ordered set must name every current root exactly once: a short, duplicated, or foreign
    // list is a root-set change smuggled through a view-only operation.
    for (const invalidOrder of [
      [rootRefAt(twoRoots, 0)],
      [rootRefAt(twoRoots, 0), rootRefAt(twoRoots, 0)],
      [rootRefAt(twoRoots, 0), "root-foreign"],
      [...order, "root-foreign"],
    ]) {
      expect(errorCode(() => service.reorderRoots(dispatch(twoRoots, 0), invalidOrder))).toBe(
        "WORKSPACE_ROOT_SET_INVALID",
      );
    }
    // Every rejection is inert: the stored manifest never moved off its revision.
    expect(service.get(twoRoots.workspaceId).revision).toBe(twoRoots.revision);
  });

  it("proves focus authority: invalid, non-mutating, stale, and non-member dispatch all fail", () => {
    // #2620: focusRoot shipped with the same coverage gap as reorderRoots.
    const twoRoots = service.addRoot(dispatch(alphaWorkspace(), 0), rootB).manifest;
    const target = rootRefAt(twoRoots, 1);

    expect(errorCode(() => service.focusRoot(undefined, target))).toBe(
      "WORKSPACE_DISPATCH_INVALID",
    );
    expect(
      errorCode(() =>
        service.focusRoot({ ...dispatch(twoRoots, 0), operationClass: "reading" }, target),
      ),
    ).toBe("WORKSPACE_DISPATCH_INVALID");
    expect(
      errorCode(() =>
        service.focusRoot(
          { ...dispatch(twoRoots, 0), manifestRevision: twoRoots.revision + 1 },
          target,
        ),
      ),
    ).toBe("WORKSPACE_DISPATCH_STALE");
    expect(
      errorCode(() =>
        service.focusRoot({ ...dispatch(twoRoots, 0), manifestDigest: "f".repeat(64) }, target),
      ),
    ).toBe("WORKSPACE_DISPATCH_STALE");
    // Authority is proven for the dispatching root...
    expect(
      errorCode(() =>
        service.focusRoot(
          { ...dispatch(twoRoots, 0), rootRef: "root-foreign", rootIdentityDigest: "f".repeat(64) },
          target,
        ),
      ),
    ).toBe("WORKSPACE_ROOT_NOT_MEMBER");
    // ...and separately for the root the caller asks to focus.
    expect(errorCode(() => service.focusRoot(dispatch(twoRoots, 0), "root-foreign"))).toBe(
      "WORKSPACE_ROOT_NOT_MEMBER",
    );
    expect(service.get(twoRoots.workspaceId).revision).toBe(twoRoots.revision);
  });

  it("keeps every project bound to a workspace across add, reorder, focus, remove and re-add", () => {
    // #2620 AC4: the full membership round trip. The invariant checked after every single step is
    // that no registered project is left without a workspace of its own.
    expectNoOrphanedProjects();
    const added = service.addRoot(dispatch(alphaWorkspace(), 0), rootB).manifest;
    expect(added.roots.map((root) => root.canonicalRoot)).toEqual([rootA, rootB]);
    expectNoOrphanedProjects();

    const reordered = service.reorderRoots(dispatch(added, 0), [
      rootRefAt(added, 1),
      rootRefAt(added, 0),
    ]).manifest;
    expect(reordered.roots.map((root) => root.canonicalRoot)).toEqual([rootB, rootA]);
    expectNoOrphanedProjects();

    const focused = service.focusRoot(dispatch(reordered, 0), rootRefAt(reordered, 1)).manifest;
    expect(focused.focusedRootRef).toBe(rootRefAt(reordered, 1));
    expectNoOrphanedProjects();

    const removed = service.removeRoot(dispatch(focused, 0), rootRefAt(focused, 0));
    expect(removed.manifest.roots.map((root) => root.canonicalRoot)).toEqual([rootA]);
    expect(removed.restoredWorkspaceIds).toHaveLength(1);
    expectNoOrphanedProjects();
    // Focus followed the survivor rather than dangling on the departed root.
    expect(removed.manifest.focusedRootRef).toBe(removed.manifest.roots[0]?.rootRef);

    // Re-adding absorbs the restored standalone workspace again, which is the round trip the
    // orphaning bug made impossible: rootB had no workspace left to absorb.
    const readded = service.addRoot(dispatch(removed.manifest, 0), rootB).manifest;
    expect(readded.roots.map((root) => root.canonicalRoot)).toEqual([rootA, rootB]);
    expectNoOrphanedProjects();
    expect(service.list().map((manifest) => manifest.workspaceId)).toEqual([readded.workspaceId]);
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

  it("rejects dispatch when the private filesystem object binding changed", () => {
    const manifest = alphaWorkspace();
    const guardedStore: UiStore = {
      ...store,
      readWorkspaceManifestRecord: (workspaceId) => {
        const row = store.readWorkspaceManifestRecord(workspaceId);
        if (row === undefined) return undefined;
        return {
          ...row,
          rootProjects: row.rootProjects.map((root) => ({
            ...root,
            objectIdentityDigest: "f".repeat(64),
          })),
        };
      },
    };

    expect(
      errorCode(() =>
        new WorkspaceManifestService(guardedStore).resolveDispatch(dispatch(manifest, 0)),
      ),
    ).toBe("WORKSPACE_ROOT_IDENTITY_CHANGED");
  });

  // KEIKO-0213: three genuinely reachable M11 root-management error states had ZERO coverage
  // anywhere in the repository (verified: grep for these three codes across
  // packages/keiko-server/src/*.test.ts returned nothing before this change). A refactor of
  // addRoot / persistRevision could have silently broken any of these fail-closed paths.

  it("refuses a root past the real WORKSPACE_MANIFEST_MAX_ROOTS cap (KEIKO-0213)", () => {
    // Exercises the production constant deliberately, so the test tracks the cap if it moves.
    let manifest = alphaWorkspace();
    let index = 0;
    while (manifest.roots.length < WORKSPACE_MANIFEST_MAX_ROOTS) {
      const extraRoot = join(tmp, `cap-${String(index)}`);
      mkdirSync(extraRoot);
      writeFileSync(join(extraRoot, "package.json"), `{"name":"cap-${String(index)}"}\n`);
      store.createProject(extraRoot, `Cap ${String(index)}`);
      manifest = service.addRoot(dispatch(manifest, 0), extraRoot).manifest;
      index += 1;
    }
    expect(manifest.roots).toHaveLength(WORKSPACE_MANIFEST_MAX_ROOTS);

    const overflowRoot = join(tmp, "overflow");
    mkdirSync(overflowRoot);
    writeFileSync(join(overflowRoot, "package.json"), '{"name":"overflow"}\n');
    store.createProject(overflowRoot, "Overflow");
    expect(errorCode(() => service.addRoot(dispatch(manifest, 0), overflowRoot))).toBe(
      "WORKSPACE_ROOT_LIMIT_REACHED",
    );
    // Fail-closed: the rejected root must not have been absorbed.
    expect(alphaWorkspace().roots).toHaveLength(WORKSPACE_MANIFEST_MAX_ROOTS);
  });

  it("refuses a root already bound to another MULTI-root workspace (KEIKO-0213)", () => {
    // A single-root owner is absorbed (the #2620 path). A multi-root owner must not be, or the
    // root would end up claimed by two workspaces at once.
    const gammaRoot = join(tmp, "gamma");
    mkdirSync(gammaRoot);
    writeFileSync(join(gammaRoot, "package.json"), '{"name":"gamma"}\n');
    store.createProject(gammaRoot, "Gamma");

    // Build beta into a two-root workspace by absorbing gamma.
    const beta = service.list().find((entry) => entry.roots[0]?.canonicalRoot === rootB);
    if (beta === undefined) throw new Error("missing beta workspace");
    const betaTwoRoots = service.addRoot(dispatch(beta, 0), gammaRoot).manifest;
    expect(betaTwoRoots.roots).toHaveLength(2);

    // Alpha now tries to take gamma, which beta owns as part of a multi-root workspace.
    expect(errorCode(() => service.addRoot(dispatch(alphaWorkspace(), 0), gammaRoot))).toBe(
      "WORKSPACE_ROOT_ALREADY_BOUND",
    );
    expect(alphaWorkspace().roots).toHaveLength(1);
    expectNoOrphanedProjects();
  });

  it("refuses a mutation whose compare-and-swap loses a concurrent race (KEIKO-0213)", () => {
    // WORKSPACE_REVISION_CONFLICT is NOT reachable via a stale dispatch — authorizeDispatch
    // rejects that earlier with WORKSPACE_DISPATCH_STALE. It guards the narrower TOCTOU window
    // inside a single valid call: the row is read, the new manifest is built, and only then does
    // the store's compare-and-swap run. This drives the REAL persistRevision check by making that
    // CAS lose the race (returning false, exactly as the store does when another writer committed
    // first) rather than by mocking the error itself.
    const gammaRoot = join(tmp, "cas-gamma");
    mkdirSync(gammaRoot);
    writeFileSync(join(gammaRoot, "package.json"), '{"name":"cas-gamma"}\n');
    store.createProject(gammaRoot, "CAS Gamma");

    const losingStore: UiStore = {
      ...store,
      replaceWorkspaceManifest: () => false,
    };

    expect(
      errorCode(() =>
        new WorkspaceManifestService(losingStore).addRoot(dispatch(alphaWorkspace(), 0), gammaRoot),
      ),
    ).toBe("WORKSPACE_REVISION_CONFLICT");
    // Fail-closed: the losing writer must not have mutated the winner's manifest.
    expect(alphaWorkspace().roots).toHaveLength(1);
    expectNoOrphanedProjects();
  });
});
