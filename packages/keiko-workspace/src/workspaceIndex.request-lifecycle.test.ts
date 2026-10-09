import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type OpenFileHandle = Awaited<ReturnType<typeof import("node:fs/promises").open>>;
const hooks = vi.hoisted(() => ({
  afterOpen: undefined as ((path: string, handle: OpenFileHandle) => void) | undefined,
  beforeRename: undefined as (() => void) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>): Promise<OpenFileHandle> => {
      const handle = await original.open(...args);
      hooks.afterOpen?.(String(args[0]), handle);
      return handle;
    },
    rename: async (...args: Parameters<typeof original.rename>): Promise<void> => {
      if (String(args[0]).endsWith(".tmp")) hooks.beforeRename?.();
      await original.rename(...args);
    },
  };
});

import { buildWorkspaceIndexSnapshot, createFileWorkspaceIndexStore } from "./workspaceIndex.js";

const roots: string[] = [];
afterEach(() => {
  hooks.afterOpen = undefined;
  hooks.beforeRename = undefined;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  readonly store: ReturnType<typeof createFileWorkspaceIndexStore>;
  readonly snapshot: ReturnType<typeof buildWorkspaceIndexSnapshot>;
  readonly runtimeDir: string;
} {
  const runtimeDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-index-request-lifecycle-")));
  roots.push(runtimeDir);
  const records = Array.from({ length: 1_000 }, (_, index) => ({
    scopePath: `manuals/section-${String(index)}/operator-maintenance-reference.html`,
    sizeBytes: 31,
    kind: "text" as const,
  }));
  return {
    runtimeDir,
    store: createFileWorkspaceIndexStore({ runtimeDir, encryptionKey: Buffer.alloc(32, 31) }),
    snapshot: buildWorkspaceIndexSnapshot({
      scope: { relativePaths: [] },
      policy: {
        policyMode: "workspace-root-default",
        applyGitignore: true,
        omitLowValueWorkspaceFiles: true,
      },
      maxBytesPerFileScanned: 1_024,
      maxFilesScanned: 2_000,
      records,
      discovery: {
        files: records,
        directories: [],
        filesDiscovered: records.length,
        ignoredByDiscovery: 0,
        deniedByDiscovery: 0,
        depthPrunedByDiscovery: 0,
        truncated: false,
      },
    }),
  };
}

describe("request-owned encrypted workspace index operations", () => {
  it.each([false, true])(
    "closes an actual snapshot reader and stops subsequent chunks on abort=%s",
    async (abort) => {
      const { store, snapshot, runtimeDir } = fixture();
      await store.saveSnapshot("scope-query", snapshot);
      const name = readdirSync(runtimeDir).find((entry) => entry.endsWith(".json"));
      expect(name).toBeDefined();
      const path = join(runtimeDir, name ?? "missing");
      expect(statSync(path).size).toBeGreaterThan(64 * 1_024);
      const controller = new AbortController();
      const read = vi.fn();
      const close = vi.fn();
      hooks.afterOpen = (opened, handle): void => {
        if (opened !== path) return;
        const originalRead = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation(async (...args) => {
          const result = await originalRead(...args);
          read();
          if (abort) controller.abort();
          return result;
        });
        const originalClose = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(async () => {
          close();
          await originalClose();
        });
      };
      const loaded = await store.loadSnapshot("scope-query", () => !controller.signal.aborted);
      if (abort) {
        expect(loaded).toBeUndefined();
        expect(read).toHaveBeenCalledOnce();
      } else {
        expect(loaded).toEqual(snapshot);
        expect(read.mock.calls.length).toBeGreaterThan(1);
      }
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("does not start sync after a completed temporary write exhausts the request", async () => {
    const { store, snapshot, runtimeDir } = fixture();
    const controller = new AbortController();
    const sync = vi.fn();
    const close = vi.fn();
    hooks.afterOpen = (path, handle): void => {
      if (!path.endsWith(".tmp")) return;
      const originalWrite = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementation(async (...args) => {
        await originalWrite(...args);
        controller.abort();
      });
      vi.spyOn(handle, "sync").mockImplementation(() => {
        sync();
        return Promise.resolve();
      });
      const originalClose = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        close();
        await originalClose();
      });
    };
    await expect(
      store.saveSnapshot("scope-query", snapshot, () => !controller.signal.aborted),
    ).rejects.toThrow();
    expect(sync).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(
      readdirSync(runtimeDir).some((entry) => entry.endsWith(".json") || entry.endsWith(".tmp")),
    ).toBe(false);
  });

  it("does not start a new write after the runtime-directory identity await consumes the request", async () => {
    const { store, snapshot, runtimeDir } = fixture();
    const controller = new AbortController();
    const write = vi.fn();
    let tempOpened = false;
    hooks.afterOpen = (path, handle): void => {
      if (!path.endsWith(".tmp")) {
        if (tempOpened && path.endsWith("workspace-index-runtime-id")) controller.abort();
        return;
      }
      tempOpened = true;
      const originalWrite = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementation(async (...args) => {
        write();
        await originalWrite(...args);
      });
    };
    await expect(
      store.saveSnapshot("scope-query", snapshot, () => !controller.signal.aborted),
    ).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
    expect(
      readdirSync(runtimeDir).some((entry) => entry.endsWith(".json") || entry.endsWith(".tmp")),
    ).toBe(false);
  });

  it("cleans the owned temporary file without publishing after abort during descriptor closure", async () => {
    const { store, snapshot, runtimeDir } = fixture();
    const controller = new AbortController();
    const rename = vi.fn();
    hooks.beforeRename = rename;
    hooks.afterOpen = (path, handle): void => {
      if (!path.endsWith(".tmp")) return;
      const originalClose = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await originalClose();
        controller.abort();
      });
    };
    await expect(
      store.saveSnapshot("scope-query", snapshot, () => !controller.signal.aborted),
    ).rejects.toThrow();
    expect(rename).not.toHaveBeenCalled();
    expect(
      readdirSync(runtimeDir).some((entry) => entry.endsWith(".json") || entry.endsWith(".tmp")),
    ).toBe(false);
  });
});
