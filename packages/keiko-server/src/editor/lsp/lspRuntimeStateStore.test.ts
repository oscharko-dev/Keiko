import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createLspRuntimeStatePort,
  lspRuntimeStateRecordPath,
  type LspRuntimeStateStoreOptions,
} from "./lspRuntimeStateStore.js";

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function options(): LspRuntimeStateStoreOptions {
  return {
    stateDir: temporaryRoot("keiko-lsp-runtime-state-"),
    workspaceRoot: temporaryRoot("keiko-lsp-runtime-workspace-"),
    managerId: "python-lsp",
    configurationRevision: 7,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("createLspRuntimeStatePort", () => {
  it("canonicalizes the real os.tmpdir path before applying the no-symlink guard", () => {
    const storeOptions = options();
    const path = lspRuntimeStateRecordPath(storeOptions);

    expect(path.startsWith(`${realpathSync(storeOptions.stateDir)}/`)).toBe(true);
    expect(createLspRuntimeStatePort(storeOptions).load()).toEqual({ state: "absent" });
  });

  it("persists only identity-safe generation, lease, and restart-window evidence", () => {
    const storeOptions = options();
    const port = createLspRuntimeStatePort(storeOptions);
    port.save({
      generation: 4,
      leaseState: "active",
      leaseReason: "tree-unconfirmed",
      crashTimestampsMs: [100, 200],
      restartCount: 2,
      updatedAtMs: 300,
    });

    expect(port.load()).toEqual({
      state: "ready",
      snapshot: {
        generation: 4,
        leaseState: "active",
        leaseReason: "tree-unconfirmed",
        crashTimestampsMs: [100, 200],
        restartCount: 2,
        updatedAtMs: 300,
      },
    });
    const serialized = readFileSync(lspRuntimeStateRecordPath(storeOptions), "utf8");
    expect(serialized).not.toContain(storeOptions.workspaceRoot);
    expect(serialized).not.toContain(storeOptions.managerId);
    expect(serialized).not.toMatch(/"pid"|"childPid"/u);
  });

  it("keeps an active lease blocking across a configuration revision change", () => {
    const original = options();
    createLspRuntimeStatePort(original).save({
      generation: 2,
      leaseState: "active",
      leaseReason: "process-live",
      crashTimestampsMs: [10],
      restartCount: 1,
      updatedAtMs: 20,
    });

    const changed = createLspRuntimeStatePort({ ...original, configurationRevision: 8 }).load();
    expect(changed).toMatchObject({
      state: "ready",
      snapshot: { generation: 2, leaseState: "active" },
    });
  });

  it("drops released throttle history for a new configuration but keeps the generation", () => {
    const original = options();
    createLspRuntimeStatePort(original).save({
      generation: 6,
      leaseState: "released",
      crashTimestampsMs: [10, 11, 12],
      restartCount: 2,
      updatedAtMs: 20,
    });

    expect(createLspRuntimeStatePort({ ...original, configurationRevision: 8 }).load()).toEqual({
      state: "ready",
      snapshot: {
        generation: 6,
        leaseState: "released",
        crashTimestampsMs: [],
        restartCount: 0,
        updatedAtMs: 20,
      },
    });
  });

  it("fails closed for a malformed or oversized record", () => {
    const storeOptions = options();
    const path = lspRuntimeStateRecordPath(storeOptions);
    writeFileSync(path, JSON.stringify({ pid: 1234 }), "utf8");
    expect(createLspRuntimeStatePort(storeOptions).load()).toEqual({ state: "unavailable" });

    const oversized = createLspRuntimeStatePort({ ...storeOptions, size: () => 16_385 });
    expect(oversized.load()).toEqual({ state: "unavailable" });
  });

  it("rejects state storage inside or above the workspace", () => {
    const workspaceRoot = temporaryRoot("keiko-lsp-runtime-overlap-");
    const nested = join(workspaceRoot, "state");
    const common = {
      workspaceRoot,
      managerId: "python-lsp",
      configurationRevision: 1,
    };

    expect(createLspRuntimeStatePort({ ...common, stateDir: nested }).load()).toEqual({
      state: "unavailable",
    });
    expect(createLspRuntimeStatePort({ ...common, stateDir: tmpdir() }).load()).toEqual({
      state: "unavailable",
    });
  });
});
