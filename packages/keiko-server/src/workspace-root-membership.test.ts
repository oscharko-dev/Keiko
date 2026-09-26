import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import { deriveWorkspaceRootRef, inspectWorkspaceRootIdentity } from "./workspace-root-identity.js";
import {
  projectsWithWorkspaceAvailability,
  resolveCurrentWorkspaceRootMembership,
} from "./workspace-root-membership.js";

type ManifestRecords = ReturnType<UiStore["listWorkspaceManifestRecords"]>;

/** The object-identity digest the store has recorded for one root, keyed by that root's own ref. */
function storedObjectIdentityDigest(source: UiStore, root: string): string | undefined {
  const rootRef = deriveWorkspaceRootRef(realpathSync(root));
  for (const record of source.listWorkspaceManifestRecords()) {
    const project = record.rootProjects.find((candidate) => candidate.rootRef === rootRef);
    const digest = project?.objectIdentityDigest;
    if (typeof digest === "string") return digest;
  }
  return undefined;
}

/** A store whose recorded object identity disagrees with the untouched root on disk. */
function tamperedObjectIdentityStore(source: UiStore, digest: string): UiStore {
  return {
    ...source,
    listWorkspaceManifestRecords: (): ManifestRecords =>
      source.listWorkspaceManifestRecords().map((record) => ({
        ...record,
        rootProjects: record.rootProjects.map((project) => ({
          ...project,
          objectIdentityDigest: digest,
        })),
      })),
  };
}

let tmp: string;
let rootA: string;
let rootB: string;
let store: UiStore;

beforeEach((): void => {
  tmp = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keiko-root-membership-")));
  rootA = join(tmp, "alpha");
  rootB = join(tmp, "beta");
  mkdirSync(rootA);
  mkdirSync(rootB);
  store = createInMemoryUiStore({ now: (): number => 100 });
  store.createProject(rootA, "Alpha");
  store.createProject(rootB, "Beta");
});

afterEach((): void => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("workspace root membership", (): void => {
  it("fails closed with a distinct guard for every unavailable membership state", (): void => {
    expect((): unknown =>
      resolveCurrentWorkspaceRootMembership(store, join(tmp, "missing")),
    ).toThrow(expect.objectContaining({ failure: "ROOT_UNRESOLVED" }));

    const unregistered = join(tmp, "unregistered");
    mkdirSync(unregistered);
    expect((): unknown => resolveCurrentWorkspaceRootMembership(store, unregistered)).toThrow(
      expect.objectContaining({ failure: "NOT_A_MEMBER" }),
    );

    rmSync(rootA, { recursive: true });
    mkdirSync(rootA);
    // The replacement has to actually BE a different object, or this row asserts nothing about
    // drift. It also must not have become the filesystem-unsupported case, which short-circuits
    // ahead of the drift check and would turn a green pin red for an unrelated reason.
    const replaced = inspectWorkspaceRootIdentity(rootA);
    expect(replaced.objectIdentityUnsupported).toBe(false);
    expect(replaced.objectIdentityDigest).not.toBe(storedObjectIdentityDigest(store, rootA));
    expect((): unknown => resolveCurrentWorkspaceRootMembership(store, rootA)).toThrow(
      expect.objectContaining({ failure: "IDENTITY_DRIFT" }),
    );
  });

  // `rootIdentityMatches` is a conjunction, and a delete-and-recreate moves more than one of its
  // terms at once — on macOS the inode is fresh so both the path/mode digest and the object digest
  // change, on Linux the inode is reused so only the object digest does. Either way the row above
  // stays green with EITHER term deleted from the product, which was measured: removing
  // `inspected.identityDigest === root.identityDigest`, and separately removing
  // `inspected.objectIdentityDigest === storedObjectIdentityDigest`, each left the suite passing.
  //
  // These two rows move exactly one term each, so each is individually falsifiable on every
  // platform.
  it.skipIf(process.platform === "win32")(
    "drifts on the path-and-mode digest alone, with the object identity untouched",
    (): void => {
      const before = inspectWorkspaceRootIdentity(rootA);
      // Mode is part of the path/mode digest and of nothing else: device, inode and creation time are
      // all unchanged by a chmod. The target mode is chosen against the CURRENT mode rather than
      // hard-coded: `mkdtempSync` honours the process umask, so under `umask 077` the root is already
      // 0700 and a chmod to 0700 would be a no-op that leaves the digest unchanged — a false red on a
      // correct product, reproduced in review.
      const currentMode = statSync(rootA).mode & 0o777;
      chmodSync(rootA, currentMode === 0o700 ? 0o750 : 0o700);
      const after = inspectWorkspaceRootIdentity(rootA);

      expect(after.identityDigest).not.toBe(before.identityDigest);
      expect(after.objectIdentityDigest).toBe(before.objectIdentityDigest);
      expect((): unknown => resolveCurrentWorkspaceRootMembership(store, rootA)).toThrow(
        expect.objectContaining({ failure: "IDENTITY_DRIFT" }),
      );
    },
  );

  it("drifts on the object identity alone, with the root untouched on disk", (): void => {
    // The filesystem is not asked to cooperate here: the STORED digest is what differs, so the live
    // path/mode digest still matches and only the object-identity term can fire.
    const live = inspectWorkspaceRootIdentity(rootA);
    const drifted = tamperedObjectIdentityStore(store, `${live.identityDigest}-not-the-object`);

    expect(inspectWorkspaceRootIdentity(rootA).identityDigest).toBe(live.identityDigest);
    expect((): unknown => resolveCurrentWorkspaceRootMembership(drifted, rootA)).toThrow(
      expect.objectContaining({ failure: "IDENTITY_DRIFT" }),
    );
  });

  it("reports identity metadata that disappears after root resolution as unreadable", (): void => {
    const listRecords = store.listWorkspaceManifestRecords;
    const disappearingStore: UiStore = {
      ...store,
      listWorkspaceManifestRecords: (): ReturnType<UiStore["listWorkspaceManifestRecords"]> => {
        const records = listRecords();
        rmSync(rootA, { recursive: true });
        return records;
      },
    };

    expect((): unknown => resolveCurrentWorkspaceRootMembership(disappearingStore, rootA)).toThrow(
      expect.objectContaining({ failure: "IDENTITY_UNREADABLE" }),
    );
  });

  it("projects multiple projects from one complete validated manifest snapshot", (): void => {
    const listRecords = store.listWorkspaceManifestRecords;
    const findRecord = vi.fn(store.findWorkspaceManifestRecordByRoot);
    let listCount = 0;
    const countingStore: UiStore = {
      ...store,
      listWorkspaceManifestRecords: (): ReturnType<UiStore["listWorkspaceManifestRecords"]> => {
        listCount += 1;
        return listRecords();
      },
      findWorkspaceManifestRecordByRoot: findRecord,
    };

    expect(projectsWithWorkspaceAvailability(countingStore, store.listProjects())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: rootA, workspaceAvailable: true }),
        expect.objectContaining({ path: rootB, workspaceAvailable: true }),
      ]),
    );
    expect(listCount).toBe(1);
    expect(findRecord).not.toHaveBeenCalled();
  });

  it("fails every workspace projection closed when the manifest snapshot is unavailable", (): void => {
    const unavailableStore: UiStore = {
      ...store,
      listWorkspaceManifestRecords: (): never => {
        throw new Error("manifest storage unavailable");
      },
    };

    expect(projectsWithWorkspaceAvailability(unavailableStore, store.listProjects())).toEqual([
      expect.objectContaining({ path: rootA, available: true, workspaceAvailable: false }),
      expect.objectContaining({ path: rootB, available: true, workspaceAvailable: false }),
    ]);
  });
});
