import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";

import { describe, expect, it } from "vitest";

import {
  pathIsContained,
  resolveContained,
  safeRealDirectory,
  safeRealFile,
  validateRuntimeGatewayFilesystemRoots,
} from "./nativeRuntimeProcessPaths.js";
import type { RuntimeGatewayFilesystem } from "@oscharko-dev/keiko-sandbox";

// KEIKO-0357: safeRealFile / safeRealDirectory grew symlink and hard-link rejection guards but
// had zero co-located negative-test coverage, unlike every comparable path-containment check in
// the runtime. These tests pin the rejection: a symlinked file (even one pointing inside the
// workspace), a hard-linked file (nlink !== 1), and a symlinked directory each fail closed.
describe("safeRealFile symlink and hard-link rejection", () => {
  function workspace(): string {
    return realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-paths-")));
  }

  it("returns the realpath of a plain governed file", () => {
    const root = workspace();
    try {
      const target = join(root, "governed.bin");
      writeFileSync(target, "content", "utf8");
      expect(safeRealFile(target)).toBe(target);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Symlink creation on Windows without SeCreateSymbolicLinkPrivilege throws EPERM, which
  // would fail this pin for the wrong reason on hosted Windows CI (no Developer Mode). The
  // symlink-rejection guard is Linux+macOS-relevant only; safeRealFile still exercises the
  // other bad-shape branches on Windows via the neighbouring tests.
  const itOnPosix = platform === "win32" ? it.skip : it;
  itOnPosix("rejects a symlinked file even when the target is inside the workspace", () => {
    const root = workspace();
    try {
      const target = join(root, "governed.bin");
      const link = join(root, "aliased.bin");
      writeFileSync(target, "content", "utf8");
      symlinkSync(target, link, "file");
      expect(() => safeRealFile(link)).toThrow(/native-runtime-request-invalid/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a hard-linked file (nlink !== 1)", () => {
    const root = workspace();
    try {
      const target = join(root, "governed.bin");
      const alias = join(root, "alias.bin");
      writeFileSync(target, "content", "utf8");
      linkSync(target, alias);
      expect(() => safeRealFile(target)).toThrow(/native-runtime-request-invalid/u);
      expect(() => safeRealFile(alias)).toThrow(/native-runtime-request-invalid/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a relative path, a NUL-embedded path, and a non-existent path", () => {
    expect(() => safeRealFile("relative/path")).toThrow(/native-runtime-request-invalid/u);
    expect(() => safeRealFile("/absolute/with\0nul")).toThrow(/native-runtime-request-invalid/u);
    expect(() => safeRealFile(join(tmpdir(), "definitely-missing-file"))).toThrow(
      /native-runtime-request-invalid/u,
    );
  });

  it("rejects a directory passed to safeRealFile", () => {
    const root = workspace();
    try {
      expect(() => safeRealFile(root)).toThrow(/native-runtime-request-invalid/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("safeRealDirectory symlink rejection", () => {
  it("returns the realpath of a governed directory", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-paths-dir-")));
    try {
      expect(safeRealDirectory(root)).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const itOnPosixDir = platform === "win32" ? it.skip : it;
  itOnPosixDir("rejects a symlinked directory", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-paths-dir-")));
    try {
      const target = join(root, "governed");
      const link = join(root, "aliased");
      mkdirSync(target);
      symlinkSync(target, link, "dir");
      expect(() => safeRealDirectory(link)).toThrow(/native-runtime-request-invalid/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a relative path or a file", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-paths-dir-")));
    try {
      const file = join(root, "governed.bin");
      writeFileSync(file, "content", "utf8");
      expect(() => safeRealDirectory(file)).toThrow(/native-runtime-request-invalid/u);
      expect(() => safeRealDirectory("relative/path")).toThrow(/native-runtime-request-invalid/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pathIsContained and resolveContained", () => {
  it("rejects a candidate outside the root and admits a candidate inside", () => {
    const root = platform === "win32" ? "C:\\\\workspace" : "/workspace";
    const inside = platform === "win32" ? "C:\\\\workspace\\src\\a.ts" : "/workspace/src/a.ts";
    const outside = platform === "win32" ? "C:\\\\other\\a.ts" : "/other/a.ts";
    expect(pathIsContained(root, inside)).toBe(true);
    expect(pathIsContained(root, outside)).toBe(false);
    expect(pathIsContained(root, root)).toBe(true);
  });

  it("resolves an in-workspace relative path and rejects an escaping traversal", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-paths-resolve-")));
    try {
      expect(resolveContained(root, "src/a.ts")).toBe(join(root, "src/a.ts"));
      expect(() => resolveContained(root, "../escape.ts")).toThrow(
        /native-runtime-request-invalid/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(platform === "win32")("native gateway filesystem root qualification", () => {
  function roots(): { readonly root: string; readonly filesystem: RuntimeGatewayFilesystem } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-roots-")));
    const filesystem: RuntimeGatewayFilesystem = {
      workspaceRoot: join(root, "workspace"),
      workspaceAccess: "read-only",
      privateStateRoot: join(root, "state"),
      runtimeReadRoot: join(root, "runtime"),
    };
    for (const path of [
      filesystem.workspaceRoot,
      filesystem.privateStateRoot,
      filesystem.runtimeReadRoot,
    ])
      mkdirSync(path, { mode: 0o700 });
    return { root, filesystem };
  }

  it("retains the exact accepted cwd and configured immutable runtime root", () => {
    const fixture = roots();
    const { filesystem } = fixture;
    try {
      expect(() => {
        validateRuntimeGatewayFilesystemRoots(
          filesystem,
          [filesystem.runtimeReadRoot],
          filesystem.workspaceRoot,
        );
      }).not.toThrow();
      expect(() => {
        validateRuntimeGatewayFilesystemRoots(
          filesystem,
          [filesystem.runtimeReadRoot],
          fixture.root,
        );
      }).toThrow("native-runtime-request-invalid");
      expect(() => {
        validateRuntimeGatewayFilesystemRoots(filesystem, [fixture.root], filesystem.workspaceRoot);
      }).toThrow("native-runtime-request-invalid");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses private state writable or readable by another user", () => {
    const fixture = roots();
    try {
      chmodSync(fixture.filesystem.privateStateRoot, 0o755);
      expect(() => {
        validateRuntimeGatewayFilesystemRoots(
          fixture.filesystem,
          [fixture.filesystem.runtimeReadRoot],
          fixture.filesystem.workspaceRoot,
        );
      }).toThrow("native-runtime-request-invalid");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses a substituted private-state symlink immediately before launch", () => {
    const fixture = roots();
    try {
      rmSync(fixture.filesystem.privateStateRoot, { recursive: true });
      symlinkSync(fixture.filesystem.workspaceRoot, fixture.filesystem.privateStateRoot, "dir");
      expect(() => {
        validateRuntimeGatewayFilesystemRoots(
          fixture.filesystem,
          [fixture.filesystem.runtimeReadRoot],
          fixture.filesystem.workspaceRoot,
        );
      }).toThrow("native-runtime-request-invalid");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
