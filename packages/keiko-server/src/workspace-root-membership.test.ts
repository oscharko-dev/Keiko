import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import {
  projectsWithWorkspaceAvailability,
  resolveCurrentWorkspaceRootMembership,
} from "./workspace-root-membership.js";

let tmp: string;
let rootA: string;
let rootB: string;
let store: UiStore;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keiko-root-membership-")));
  rootA = join(tmp, "alpha");
  rootB = join(tmp, "beta");
  mkdirSync(rootA);
  mkdirSync(rootB);
  store = createInMemoryUiStore({ now: () => 100 });
  store.createProject(rootA, "Alpha");
  store.createProject(rootB, "Beta");
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("workspace root membership", () => {
  it("fails closed with a distinct guard for every unavailable membership state", () => {
    expect(() => resolveCurrentWorkspaceRootMembership(store, join(tmp, "missing"))).toThrow(
      expect.objectContaining({ failure: "ROOT_UNRESOLVED" }),
    );

    const unregistered = join(tmp, "unregistered");
    mkdirSync(unregistered);
    expect(() => resolveCurrentWorkspaceRootMembership(store, unregistered)).toThrow(
      expect.objectContaining({ failure: "NOT_A_MEMBER" }),
    );

    rmSync(rootA, { recursive: true });
    mkdirSync(rootA);
    expect(() => resolveCurrentWorkspaceRootMembership(store, rootA)).toThrow(
      expect.objectContaining({ failure: "IDENTITY_DRIFT" }),
    );
  });

  it("reports identity metadata that disappears after root resolution as unreadable", () => {
    const listRecords = store.listWorkspaceManifestRecords;
    const disappearingStore: UiStore = {
      ...store,
      listWorkspaceManifestRecords: () => {
        const records = listRecords();
        rmSync(rootA, { recursive: true });
        return records;
      },
    };

    expect(() => resolveCurrentWorkspaceRootMembership(disappearingStore, rootA)).toThrow(
      expect.objectContaining({ failure: "IDENTITY_UNREADABLE" }),
    );
  });

  it("projects multiple projects from one complete validated manifest snapshot", () => {
    const listRecords = store.listWorkspaceManifestRecords;
    const findRecord = vi.fn(store.findWorkspaceManifestRecordByRoot);
    let listCount = 0;
    const countingStore: UiStore = {
      ...store,
      listWorkspaceManifestRecords: () => {
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

  it("fails every workspace projection closed when the manifest snapshot is unavailable", () => {
    const unavailableStore: UiStore = {
      ...store,
      listWorkspaceManifestRecords: () => {
        throw new Error("manifest storage unavailable");
      },
    };

    expect(projectsWithWorkspaceAvailability(unavailableStore, store.listProjects())).toEqual([
      expect.objectContaining({ path: rootA, available: true, workspaceAvailable: false }),
      expect.objectContaining({ path: rootB, available: true, workspaceAvailable: false }),
    ]);
  });
});
