import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceStorageKey } from "../../packages/keiko-ui/src/app/components/desktop/hooks/workspace-storage.ts";
import { workspaceStorageArgs } from "../../tests/e2e/support/workspace-storage.ts";
import { seedWorkbenchWindow } from "../testing/coding-workbench-lab/wb-ui.mjs";
import { BASELINE_COMMIT } from "../run-d12-perf-comparison.mjs";

const STORAGE_ID = "a".repeat(64);

function fixturePage(body = { workspace: { storageId: STORAGE_ID } }, ok = true) {
  return {
    request: { get: vi.fn(async () => ({ ok: () => ok, json: async () => body })) },
    addInitScript: vi.fn(async (script, argument) => script(argument)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("workspace fixture storage ownership", () => {
  it("uses the server installation identity and production key builder for every stored lane", async () => {
    const page = fixturePage();
    const result = await workspaceStorageArgs(page, {
      windows: ["keiko.workspace.v4"],
      connections: "keiko.conns.v1",
      view: "keiko.view",
      unchanged: "fixture-value",
    });
    expect(page.request.get).toHaveBeenCalledExactlyOnceWith("/api/workspace/state");
    expect(result).toEqual({
      storageKeys: {
        workspace: workspaceStorageKey("keiko.workspace.v4", STORAGE_ID),
        connections: workspaceStorageKey("keiko.conns.v1", STORAGE_ID),
        view: workspaceStorageKey("keiko.view", STORAGE_ID),
      },
      argument: {
        windows: [workspaceStorageKey("keiko.workspace.v4", STORAGE_ID)],
        connections: workspaceStorageKey("keiko.conns.v1", STORAGE_ID),
        view: workspaceStorageKey("keiko.view", STORAGE_ID),
        unchanged: "fixture-value",
      },
    });
  });

  it("resolves an explicit browser origin before the first navigation", async () => {
    const page = fixturePage();
    await workspaceStorageArgs(page, null, "http://127.0.0.1:32183");
    expect(page.request.get).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:32183/api/workspace/state",
    );
  });

  it("loads the same fixture and production producer in native Node for qualification scripts", () => {
    const source = `
      import { workspaceStorageArgs } from "./scripts/lib/workspace-storage-fixture.mjs";
      import { workspaceStorageKey } from "./packages/keiko-ui/src/app/components/desktop/hooks/workspace-storage.ts";
      const id = "b".repeat(64);
      const page = { request: { get: async () => ({ ok: () => true, json: async () => ({ workspace: { storageId: id } }) }) } };
      const result = await workspaceStorageArgs(page, null);
      if (result.storageKeys.workspace !== workspaceStorageKey("keiko.workspace.v4", id)) process.exit(1);
    `;
    expect(() =>
      execFileSync(process.execPath, ["--input-type=module", "-e", source]),
    ).not.toThrow();
  });

  it.each([null, {}, { workspace: {} }, { workspace: { storageId: "legacy" } }])(
    "refuses an unavailable installation identity (%j)",
    async (body) => {
      await expect(workspaceStorageArgs(fixturePage(body), {})).rejects.toThrow();
    },
  );

  it("refuses failed identity reads", async () => {
    await expect(workspaceStorageArgs(fixturePage({}, false), {})).rejects.toThrow(
      "cannot resolve its data store",
    );
  });

  it("uses the historical keys only for the exact frozen D12 baseline contract", async () => {
    vi.stubEnv("KEIKO_PERF_D12_REVISION", "baseline");
    vi.stubEnv("KEIKO_PERF_COMMIT", BASELINE_COMMIT);
    const result = await workspaceStorageArgs(fixturePage({ workspace: {} }), null);
    expect(result.storageKeys).toEqual({
      workspace: workspaceStorageKey("keiko.workspace.v4", undefined),
      connections: workspaceStorageKey("keiko.conns.v1", undefined),
      view: workspaceStorageKey("keiko.view", undefined),
    });
  });

  it.each([
    [undefined, undefined],
    ["baseline", undefined],
    [undefined, BASELINE_COMMIT],
    ["candidate", BASELINE_COMMIT],
    ["baseline", "a".repeat(40)],
    ["baseline", BASELINE_COMMIT.slice(0, 7)],
  ])("refuses missing storage identity for revision %s and commit %s", async (revision, commit) => {
    vi.stubEnv("KEIKO_PERF_D12_REVISION", revision);
    vi.stubEnv("KEIKO_PERF_COMMIT", commit);
    await expect(workspaceStorageArgs(fixturePage({ workspace: {} }), null)).rejects.toThrow(
      "storage identity",
    );
  });

  it("never treats an invalid supplied identity as the old baseline contract", async () => {
    vi.stubEnv("KEIKO_PERF_D12_REVISION", "baseline");
    vi.stubEnv("KEIKO_PERF_COMMIT", BASELINE_COMMIT);
    await expect(
      workspaceStorageArgs(fixturePage({ workspace: { storageId: "invalid" } }), null),
    ).rejects.toThrow("Invalid workspace fixture storage identity");
  });

  // #4271: the window names the canonical repository, as Keiko registers a project; an alias
  // (macOS's `/var` for `/private/var`) never matches the canonical root of its task workspace.
  it("opens the Workbench through its owned key on the canonical repository path", async () => {
    const base = mkdtempSync(join(tmpdir(), "keiko-wb-ui-seed-"));
    try {
      const repository = join(base, "ledger-lab");
      mkdirSync(repository);
      const alias = join(base, "alias");
      symlinkSync(repository, alias);
      const storage = new Map();
      vi.stubGlobal("localStorage", { setItem: (key, value) => storage.set(key, value) });
      const page = fixturePage();
      await seedWorkbenchWindow(page, alias);
      expect(page.request.get).toHaveBeenCalledExactlyOnceWith("/api/workspace/state");
      expect(storage.has("keiko.workspace.v4")).toBe(false);
      const stored = JSON.parse(storage.get(workspaceStorageKey("keiko.workspace.v4", STORAGE_ID)));
      expect(stored).toEqual([
        expect.objectContaining({
          id: "lab-workbench",
          type: "coding",
          cfg: { repositoryPath: realpathSync(repository) },
        }),
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
