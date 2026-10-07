import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { memFs } from "./_memfs.js";
import {
  PathDeniedError,
  PathEscapeError,
  RepoSearchInvalidQueryError,
  WorkspaceReadError,
} from "./errors.js";
import { WorkspaceDescriptorReadError, type WorkspaceFs } from "./fs.js";
import {
  createStructuralExecutionControl,
  StructuralExecutionStoppedError,
} from "./structuralExecution.js";
import type { WorkspaceInfo } from "./types.js";
import { discoverWorkspacePaths } from "./workspacePathDiscovery.js";

const WORKSPACE: WorkspaceInfo = {
  root: "/repo",
  selectedRoot: "/repo",
  name: "fixture",
  version: "1",
  testFramework: "vitest",
  sourceDirs: [],
  testDirs: [],
  languages: [],
  ignoreLines: ["generated/"],
};
const REQUEST = { mode: "keywords", directory: "", query: "target", maxResults: 10 } as const;

function discover(fs: WorkspaceFs): ReturnType<typeof discoverWorkspacePaths> {
  return discoverWorkspacePaths(WORKSPACE, REQUEST, createStructuralExecutionControl(5_000), fs);
}

describe("workspace path discovery scope and coverage", () => {
  it("keeps original deny and gitignore rules on root and explicit subdirectory discovery", async () => {
    const fs = memFs(WORKSPACE.root, {
      "src/target.ts": "target",
      "src/generated/target.ts": "ignored",
      "src/.env": "denied",
      "generated/target.ts": "ignored",
      "node_modules/target.ts": "denied",
    });
    const result = await discoverWorkspacePaths(
      WORKSPACE,
      { ...REQUEST, directory: "src" },
      createStructuralExecutionControl(5_000),
      fs,
    );
    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["src/target.ts"]);
    expect(result.stats).toMatchObject({ filesDiscovered: 1, denied: 1, ignored: 1 });
    expect(result.coverageIncomplete).toBe(false);
    expect((await discover(fs)).entries).toEqual(result.entries);
  });

  it.each(["generated", "node_modules"])(
    "refuses selected excluded directory %s before enumeration",
    async (directory) => {
      const fs = memFs(WORKSPACE.root, { [`${directory}/target.ts`]: "source" });
      const iterate = vi.spyOn(fs, "iterateDirectory");
      await expect(
        discoverWorkspacePaths(
          WORKSPACE,
          { ...REQUEST, directory },
          createStructuralExecutionControl(5_000),
          fs,
        ),
      ).rejects.toBeInstanceOf(PathDeniedError);
      expect(iterate).not.toHaveBeenCalled();
    },
  );

  it("refuses a file used as a directory instead of silently treating it as a scope", async () => {
    const fs = memFs(WORKSPACE.root, { "target.ts": "source" });
    await expect(
      discoverWorkspacePaths(
        WORKSPACE,
        { ...REQUEST, directory: "target.ts" },
        createStructuralExecutionControl(5_000),
        fs,
      ),
    ).rejects.toBeInstanceOf(RepoSearchInvalidQueryError);
  });

  it("reports unsupported names before stat or descent", async () => {
    const fs = memFs(WORKSPACE.root, { "target.ts": "source", "~archive/target.ts": "unsafe" });
    const stat = vi.spyOn(fs, "stat");
    const result = await discover(fs);
    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["target.ts"]);
    expect(result.stats.unrepresentablePaths).toBe(1);
    expect(result.coverageIncomplete).toBe(true);
    expect(result.truncationReasons).toEqual(["unrepresentable-path"]);
    expect(stat.mock.calls.some(([path]) => path.includes("~archive"))).toBe(false);
  });

  it("keeps verified siblings but reports an unreadable subtree as partial", async () => {
    const base = memFs(WORKSPACE.root, { "bad/target.ts": "source", "good/target.ts": "source" });
    const failure = Object.assign(new Error("PRIVATE_IO_DETAIL"), { code: "EACCES" });
    const fs: WorkspaceFs = {
      ...base,
      iterateDirectory: async function* (path) {
        if (path === "/repo/bad") throw failure;
        yield* base.iterateDirectory?.(path) ?? [];
      },
    };
    const result = await discover(fs);
    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["good/target.ts"]);
    expect(result.stats.ioErrors).toBe(1);
    expect(result.coverageIncomplete).toBe(true);
    expect(result.truncationReasons).toEqual(["io-error"]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_IO_DETAIL");
  });

  it("reports descriptor membership changes even after a verified matching entry", async () => {
    const base = memFs(WORKSPACE.root, { "changed/target.ts": "source" });
    const fs: WorkspaceFs = {
      ...base,
      iterateDirectory: async function* (path) {
        yield* base.iterateDirectory?.(path) ?? [];
        if (path === "/repo/changed")
          throw new WorkspaceDescriptorReadError("directory-membership-changed");
      },
    };
    const result = await discover(fs);
    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["changed/target.ts"]);
    expect(result.truncationReasons).toEqual(["io-error"]);
    expect(result.coverageIncomplete).toBe(true);
  });

  it("reports a selected directory replaced by an alias after enumeration as partial", async () => {
    const base = memFs(WORKSPACE.root, { "changed/target.ts": "source" });
    let moved = false;
    const fs: WorkspaceFs = {
      ...base,
      realPath: (path) => (moved && path === "/repo/changed" ? "/repo/other" : base.realPath(path)),
      iterateDirectory: async function* (path) {
        yield* base.iterateDirectory?.(path) ?? [];
        if (path === "/repo/changed") moved = true;
      },
    };
    const result = await discoverWorkspacePaths(
      WORKSPACE,
      { ...REQUEST, directory: "changed" },
      createStructuralExecutionControl(5_000),
      fs,
    );
    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["changed/target.ts"]);
    expect(result.stats.ioErrors).toBe(1);
    expect(result.truncationReasons).toEqual(["io-error"]);
    expect(result.coverageIncomplete).toBe(true);
  });

  it("refuses root IO failure with a body-free error instead of a completed empty response", async () => {
    const failure = Object.assign(new Error("PRIVATE_ROOT_DETAIL"), { code: "EIO" });
    const fs: WorkspaceFs = {
      ...memFs(WORKSPACE.root, {}),
      iterateDirectory: async function* () {
        yield* [];
        await Promise.reject(failure);
      },
    };
    const result = discover(fs);
    await expect(result).rejects.toBeInstanceOf(WorkspaceReadError);
    await expect(result).rejects.toMatchObject({ cause: failure });
    await expect(result).rejects.not.toHaveProperty(
      "message",
      expect.stringContaining("PRIVATE_ROOT_DETAIL"),
    );
  });

  it.each([false, true])(
    "rejects a repointed admitted root during iteration, descriptor failure=%s",
    async (descriptorFailure) => {
      const base = memFs(WORKSPACE.root, { "target.ts": "source" });
      let moved = false;
      const fs: WorkspaceFs = {
        ...base,
        realPath: (path) => (moved && path === WORKSPACE.root ? "/outside" : base.realPath(path)),
        iterateDirectory: async function* (path) {
          yield* base.iterateDirectory?.(path) ?? [];
          moved = true;
          if (descriptorFailure)
            throw new WorkspaceDescriptorReadError("directory-membership-changed");
        },
      };
      await expect(discover(fs)).rejects.toBeInstanceOf(
        descriptorFailure ? PathDeniedError : PathEscapeError,
      );
    },
  );

  it("does not read contained or external symlink targets in native directory listings", async () => {
    const selectedRoot = mkdtempSync(join(tmpdir(), "keiko-path-discovery-"));
    const root = realpathSync(selectedRoot);
    try {
      mkdirSync(join(root, "real"));
      writeFileSync(join(root, "real/target.ts"), "source");
      symlinkSync(join(root, "real"), join(root, "alias"), "dir");
      symlinkSync(tmpdir(), join(root, "external"), "dir");
      const workspace = { ...WORKSPACE, root, selectedRoot };
      const result = await discoverWorkspacePaths(
        workspace,
        { ...REQUEST, mode: "directory", query: "*" },
        createStructuralExecutionControl(5_000),
      );
      expect(result.entries.map((entry) => entry.relativePath)).toEqual(["real"]);
      expect(result.stats.denied).toBe(2);
      await expect(
        discoverWorkspacePaths(
          workspace,
          { ...REQUEST, directory: "alias" },
          createStructuralExecutionControl(5_000),
        ),
      ).rejects.toBeInstanceOf(RepoSearchInvalidQueryError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds pending-directory memory and exposes skipped directory coverage", async () => {
    const base = memFs(WORKSPACE.root, {});
    const fs: WorkspaceFs = {
      ...base,
      iterateDirectory: async function* (path) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        if (path !== WORKSPACE.root) return;
        for (let index = 0; index < 10_001; index += 1) {
          yield {
            name: `directory-${String(index)}`,
            isDirectory: true,
            isFile: false,
            isSymbolicLink: false,
          };
        }
      },
    };
    const result = await discover(fs);
    expect(result.entries).toEqual([]);
    expect(result.stats).toMatchObject({ directoriesDiscovered: 10_001, directoriesPruned: 1 });
    expect(result.coverageIncomplete).toBe(true);
    expect(result.truncationReasons).toEqual(["directory-limit"]);
  });
});

describe("workspace path discovery execution controls", () => {
  it("bounds an actually blocked iterator by the deadline and preserves truthful partial coverage", async () => {
    const base = memFs(WORKSPACE.root, { "target.ts": "source" });
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fs: WorkspaceFs = {
      ...base,
      iterateDirectory: async function* (path) {
        yield* base.iterateDirectory?.(path) ?? [];
        await blocked;
      },
    };
    const result = await discoverWorkspacePaths(
      WORKSPACE,
      REQUEST,
      createStructuralExecutionControl(250),
      fs,
    );
    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["target.ts"]);
    expect(result.coverageIncomplete).toBe(true);
    expect(result.truncationReasons).toEqual(["time-limit"]);
    release();
  });

  it("interrupts a blocked iterator on abort and does not report a completed task", async () => {
    const controller = new AbortController();
    const base = memFs(WORKSPACE.root, { "target.ts": "source" });
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fs: WorkspaceFs = {
      ...base,
      iterateDirectory: async function* (path) {
        yield* base.iterateDirectory?.(path) ?? [];
        controller.abort();
        await blocked;
      },
    };
    const result = discoverWorkspacePaths(
      WORKSPACE,
      REQUEST,
      createStructuralExecutionControl(5_000, Date.now, controller.signal),
      fs,
    );
    await expect(result).rejects.toBeInstanceOf(StructuralExecutionStoppedError);
    await expect(result).rejects.toMatchObject({ reason: "aborted" });
    release();
  });

  it("captures an immutable request before asynchronous directory traversal", async () => {
    const request = { mode: "directory", directory: "", query: "*", maxResults: 10 };
    const base = memFs(WORKSPACE.root, { "deep/target.ts": "source" });
    const fs: WorkspaceFs = {
      ...base,
      iterateDirectory: async function* (path) {
        request.query = "no-longer-the-request";
        request.directory = "../outside";
        yield* base.iterateDirectory?.(path) ?? [];
      },
    };
    const result = await discoverWorkspacePaths(
      WORKSPACE,
      request,
      createStructuralExecutionControl(5_000),
      fs,
    );
    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["deep"]);
    expect(result.stats.filesDiscovered).toBe(0);
  });
});
