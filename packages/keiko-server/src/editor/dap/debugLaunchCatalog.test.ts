import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type { CommandTask, CommandTaskCatalog } from "@oscharko-dev/keiko-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveCatalogDebugTarget,
  deriveFileDebugTarget,
  DebugLaunchTargetError,
  type DebugLaunchCatalogDeps,
} from "./debugLaunchCatalog.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-debug-launch-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), "{}", "utf8");
  return root;
}

function task(
  id: string,
  name: string,
  trustState: "trusted" | "approval-required" = "trusted",
): CommandTask {
  return {
    id,
    kind: "run" as const,
    label: `npm run ${name}`,
    executable: "npm",
    args: ["run", name],
    source: "package-json-script" as const,
    trustState,
    trustReason: "repository-authored-script" as const,
  };
}

function deps(root: string, discover: DebugLaunchCatalogDeps["discover"]): DebugLaunchCatalogDeps {
  return {
    discover,
    fs: nodeWorkspaceFs,
    workspaceRoot: root,
    projectId: "project_a",
    workspaceTrusted: true,
  };
}

function expectTargetError(run: () => unknown, code: DebugLaunchTargetError["code"]): void {
  try {
    run();
    throw new Error("expected target rejection");
  } catch (error: unknown) {
    expect(error).toMatchObject({ name: "DebugLaunchTargetError", message: code, code });
  }
}

describe("closed debug launch catalog", () => {
  it("rejects every invalid catalog manifest state with a closed error", () => {
    const root = workspace();
    const manifestPath = join(root, "package.json");
    const discover = (): CommandTaskCatalog => ({
      schemaVersion: "1",
      projectId: "project_a",
      tasks: [task("npm-script:x", "x")],
    });
    const base = deps(root, discover);

    const sizeDrift = {
      ...base,
      fs: {
        ...nodeWorkspaceFs,
        stat: (path: string): ReturnType<typeof nodeWorkspaceFs.stat> => {
          const current = nodeWorkspaceFs.stat(path);
          return { ...current, size: current.size + 1 };
        },
      },
    };
    expectTargetError(() => deriveCatalogDebugTarget("npm-script:x", sizeDrift), "INVALID_TARGET");

    const failedStat = {
      ...base,
      fs: {
        ...nodeWorkspaceFs,
        stat: (): never => {
          throw new Error("private");
        },
      },
    };
    expectTargetError(() => deriveCatalogDebugTarget("npm-script:x", failedStat), "INVALID_TARGET");

    writeFileSync(manifestPath, Buffer.alloc(4_194_304));
    expect(deriveCatalogDebugTarget("npm-script:x", base).targetIdentityDigest).toMatch(
      /^[a-f0-9]{64}$/u,
    );

    writeFileSync(manifestPath, Buffer.alloc(4_194_305));
    expectTargetError(() => deriveCatalogDebugTarget("npm-script:x", base), "INVALID_TARGET");

    rmSync(manifestPath);
    mkdirSync(manifestPath);
    expectTargetError(() => deriveCatalogDebugTarget("npm-script:x", base), "INVALID_TARGET");
  });

  it("re-derives the live trusted task on every call", () => {
    const root = workspace();
    let name = "start";
    const discover = vi.fn(() => ({
      schemaVersion: "1" as const,
      projectId: "project_a",
      tasks: [task(`npm-script:${name}`, name)],
    }));
    const first = deriveCatalogDebugTarget("npm-script:start", deps(root, discover));
    expect(first).toMatchObject({
      kind: "catalog",
      targetId: "npm-script:start",
      scriptName: "start",
    });
    expect(first.targetIdentityDigest).toMatch(/^[a-f0-9]{64}$/u);
    const manifestDigest = createHash("sha256").update("{}").digest("hex");
    expect(first.targetIdentityDigest).toBe(
      createHash("sha256")
        .update(JSON.stringify(["project_a", task("npm-script:start", "start"), manifestDigest]))
        .digest("hex"),
    );
    writeFileSync(join(root, "package.json"), '{"scripts":{"start":"changed"}}', "utf8");
    const changedManifest = deriveCatalogDebugTarget("npm-script:start", deps(root, discover));
    expect(changedManifest.targetIdentityDigest).not.toBe(first.targetIdentityDigest);
    name = "serve";
    expect(() => deriveCatalogDebugTarget("npm-script:start", deps(root, discover))).toThrow(
      DebugLaunchTargetError,
    );
    expect(deriveCatalogDebugTarget("npm-script:serve", deps(root, discover))).toMatchObject({
      scriptName: "serve",
    });
    expect(discover).toHaveBeenCalledTimes(4);
    const invalidTasks = [
      task("npm-script:x", "x", "approval-required"),
      { ...task("npm-script:x", "x"), executable: "node" },
      { ...task("npm-script:x", "x"), args: ["test", "x"] },
      { ...task("npm-script:x", "x"), args: ["run"] },
      { ...task("npm-script:x", "x"), args: ["run", "x", "extra"] },
      task("forged", "x"),
      task("npm-script:-bad", "-bad"),
    ];
    for (const entry of invalidTasks) {
      const invalidDiscover = (): CommandTaskCatalog => ({
        schemaVersion: "1",
        projectId: "project_a",
        tasks: [entry],
      });
      expectTargetError(
        () => deriveCatalogDebugTarget(entry.id, deps(root, invalidDiscover)),
        entry.trustState === "approval-required" ? "WORKSPACE_UNTRUSTED" : "INVALID_TARGET",
      );
    }
    const validDiscover = (): CommandTaskCatalog => ({
      schemaVersion: "1",
      projectId: "project_a",
      tasks: [task("npm-script:x", "x")],
    });
    expectTargetError(
      () => deriveCatalogDebugTarget("missing", deps(root, validDiscover)),
      "INVALID_TARGET",
    );
    const duplicate = task("npm-script:x", "x");
    const duplicateDiscover = (): CommandTaskCatalog => ({
      schemaVersion: "1",
      projectId: "project_a",
      tasks: [duplicate, duplicate],
    });
    expectTargetError(
      () => deriveCatalogDebugTarget(duplicate.id, deps(root, duplicateDiscover)),
      "INVALID_TARGET",
    );
  });

  it.each([
    task("npm-script:x", "x", "approval-required"),
    { ...task("npm-script:x", "x"), executable: "node" },
    { ...task("npm-script:x", "x"), args: ["run", "x", "extra"] },
    { ...task("npm-script:x", "x"), args: ["test", "x"] },
    { ...task("npm-script:x", "x"), args: ["run"] },
    { ...task("npm-script:x", "x"), id: "forged" },
    { ...task("npm-script:-x", "-x") },
  ])("rejects untrusted or forged catalog entries", (entry) => {
    const discover = (): CommandTaskCatalog => ({
      schemaVersion: "1" as const,
      projectId: "project_a",
      tasks: [entry],
    });
    expect(() => deriveCatalogDebugTarget("npm-script:x", deps(workspace(), discover))).toThrow(
      DebugLaunchTargetError,
    );
  });

  it("rejects catalog project drift, duplicate ids, and missing workspace trust", () => {
    const root = workspace();
    const duplicate = task("npm-script:x", "x");
    const discover = (): CommandTaskCatalog => ({
      schemaVersion: "1" as const,
      projectId: "other",
      tasks: [duplicate, duplicate],
    });
    expect(() => deriveCatalogDebugTarget("npm-script:x", deps(root, discover))).toThrow(
      DebugLaunchTargetError,
    );
    expect(() =>
      deriveCatalogDebugTarget("npm-script:x", {
        ...deps(root, () => ({ schemaVersion: "1", projectId: "project_a", tasks: [duplicate] })),
        workspaceTrusted: false,
      }),
    ).toThrow(expect.objectContaining({ code: "WORKSPACE_UNTRUSTED" }));
  });

  it("uses closed content-free target errors", () => {
    for (const code of ["INVALID_TARGET", "WORKSPACE_ESCAPE", "WORKSPACE_UNTRUSTED"] as const) {
      expect(new DebugLaunchTargetError(code)).toMatchObject({
        name: "DebugLaunchTargetError",
        message: code,
        code,
      });
    }
  });

  it("rejects duplicate ids even for the canonical project", () => {
    const duplicate = task("npm-script:x", "x");
    const discover = (): CommandTaskCatalog => ({
      schemaVersion: "1",
      projectId: "project_a",
      tasks: [duplicate, duplicate],
    });
    expect(() => deriveCatalogDebugTarget("npm-script:x", deps(workspace(), discover))).toThrow(
      DebugLaunchTargetError,
    );
  });

  it("accepts a requested task when another unique task is present", () => {
    const discover = (): CommandTaskCatalog => ({
      schemaVersion: "1",
      projectId: "project_a",
      tasks: [task("npm-script:x", "x"), task("npm-script:y", "y")],
    });
    expect(deriveCatalogDebugTarget("npm-script:x", deps(workspace(), discover))).toMatchObject({
      targetId: "npm-script:x",
      scriptName: "x",
    });
  });

  it.each(["app.js", "app.mjs", "app.cjs", "app.ts", "app.mts", "app.cts"])(
    "accepts a contained %s target",
    (name) => {
      const root = workspace();
      writeFileSync(join(root, name), "export {};", "utf8");
      const target = deriveFileDebugTarget(name, deps(root, vi.fn()));
      expect(target).toMatchObject({
        kind: "file",
        fileId: name,
        hostPath: realpathSync(join(root, name)),
        capsulePath: `/keiko-execution-root/${name}`,
      });
      expect(target.targetIdentityDigest).toMatch(/^[a-f0-9]{64}$/u);
      const stat = nodeWorkspaceFs.stat(target.hostPath);
      const contentDigest = createHash("sha256")
        .update(readFileSync(target.hostPath))
        .digest("hex");
      const expectedDigest = createHash("sha256")
        .update(
          JSON.stringify([target.hostPath, stat.size, stat.mtimeMs, stat.ctimeMs, contentDigest]),
        )
        .digest("hex");
      expect(target.targetIdentityDigest).toBe(expectedDigest);
      expectTargetError(
        () => deriveFileDebugTarget(name, { ...deps(root, vi.fn()), workspaceTrusted: false }),
        "WORKSPACE_UNTRUSTED",
      );
      writeFileSync(join(root, "README.md"), "x", "utf8");
      for (const fileId of ["../escape.js", "/outside.js", "README.md", "", "app.js\u0000evil"]) {
        const code = fileId === "../escape.js" ? "WORKSPACE_ESCAPE" : "INVALID_TARGET";
        expectTargetError(() => deriveFileDebugTarget(fileId, deps(root, vi.fn())), code);
      }
    },
  );

  it("preserves nested path components in the capsule projection", () => {
    const root = workspace();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.js"), "export {};", "utf8");
    expect(deriveFileDebugTarget("src/app.js", deps(root, vi.fn())).capsulePath).toBe(
      "/keiko-execution-root/src/app.js",
    );
  });

  it("enforces the exact file-size boundary and rejects read/stat drift", () => {
    const root = workspace();
    const boundaryPath = join(root, "boundary.js");
    writeFileSync(boundaryPath, "a".repeat(4_194_304), "utf8");
    expect(deriveFileDebugTarget("boundary.js", deps(root, vi.fn()))).toMatchObject({
      fileId: "boundary.js",
    });

    const oversizedPath = join(root, "oversized.js");
    writeFileSync(oversizedPath, "a".repeat(4_194_305), "utf8");
    expectTargetError(
      () => deriveFileDebugTarget("oversized.js", deps(root, vi.fn())),
      "INVALID_TARGET",
    );

    const driftPath = join(root, "drift.js");
    writeFileSync(driftPath, "alpha", "utf8");
    const base = deps(root, vi.fn());
    const drifted = {
      ...base,
      fs: {
        ...base.fs,
        stat: (path: string): ReturnType<DebugLaunchCatalogDeps["fs"]["stat"]> => ({
          ...base.fs.stat(path),
          size: 6,
        }),
      },
    };
    expectTargetError(() => deriveFileDebugTarget("drift.js", drifted), "INVALID_TARGET");
  });

  it("rejects an empty file id before filesystem inspection", () => {
    const stat = vi.spyOn(nodeWorkspaceFs, "stat");
    expectTargetError(
      () => deriveFileDebugTarget("", deps(workspace(), vi.fn())),
      "INVALID_TARGET",
    );
    expect(stat).not.toHaveBeenCalled();
    stat.mockRestore();
  });

  it("rejects a real on-disk symlink escape with a content-free error", () => {
    const root = workspace();
    const outside = workspace();
    writeFileSync(join(outside, "escape.js"), "secret", "utf8");
    symlinkSync(join(outside, "escape.js"), join(root, "inside.js"));
    expect(() => deriveFileDebugTarget("inside.js", deps(root, vi.fn()))).toThrow(
      expect.objectContaining({ code: "WORKSPACE_ESCAPE", message: "WORKSPACE_ESCAPE" }),
    );
  });

  it.each(["../escape.js", "/outside.js", "README.md", "", "app.js\u0000evil"])(
    "rejects invalid file input %s",
    (fileId) => {
      const root = workspace();
      mkdirSync(join(root, "sub"), { recursive: true });
      writeFileSync(join(root, "README.md"), "x", "utf8");
      expect(() => deriveFileDebugTarget(fileId, deps(root, vi.fn()))).toThrow(
        DebugLaunchTargetError,
      );
    },
  );

  it("runs every independent catalog and file denial in one mutation-complete test", () => {
    const root = workspace();
    writeFileSync(join(root, "README.md"), "x", "utf8");
    const invalidTasks: readonly CommandTask[] = [
      task("npm-script:x", "x", "approval-required"),
      { ...task("npm-script:x", "x"), executable: "node" },
      { ...task("npm-script:x", "x"), args: ["test", "x"] },
      { ...task("npm-script:x", "x"), args: ["run"] },
      { ...task("npm-script:x", "x"), args: ["run", "x", "extra"] },
      { ...task("forged", "x") },
      task("npm-script:-bad", "-bad"),
      task("npm-script:bad!", "bad!"),
    ];
    for (const entry of invalidTasks) {
      const discover = (): CommandTaskCatalog => ({
        schemaVersion: "1",
        projectId: "project_a",
        tasks: [entry],
      });
      expect(() => deriveCatalogDebugTarget(entry.id, deps(root, discover))).toThrow(
        DebugLaunchTargetError,
      );
    }
    for (const fileId of ["../escape.js", "/outside.js", "README.md", "", "app.js\u0000evil"]) {
      expect(() => deriveFileDebugTarget(fileId, deps(root, vi.fn()))).toThrow(
        DebugLaunchTargetError,
      );
    }
    const valid = task("npm-script:x", "x");
    const wrongProject = (): CommandTaskCatalog => ({
      schemaVersion: "1",
      projectId: "other",
      tasks: [valid],
    });
    const duplicate = (): CommandTaskCatalog => ({
      schemaVersion: "1",
      projectId: "project_a",
      tasks: [valid, valid],
    });
    expect(() => deriveCatalogDebugTarget(valid.id, deps(root, wrongProject))).toThrow(
      DebugLaunchTargetError,
    );
    expect(() => deriveCatalogDebugTarget(valid.id, deps(root, duplicate))).toThrow(
      DebugLaunchTargetError,
    );
    expect(() =>
      deriveCatalogDebugTarget(valid.id, {
        ...deps(root, () => ({ schemaVersion: "1", projectId: "project_a", tasks: [valid] })),
        workspaceTrusted: false,
      }),
    ).toThrow(DebugLaunchTargetError);
  });
});
