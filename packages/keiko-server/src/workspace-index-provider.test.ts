import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createServerWorkspaceIndexProvider,
  resolveServerWorkspaceIndexRuntimeDir,
} from "./workspace-index-provider.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("workspace index provider", () => {
  it("uses runtime state when it is outside the workspace root", () => {
    const workspaceRoot = tempDir("keiko-index-workspace-");
    const runtimeStateDir = tempDir("keiko-index-state-");
    try {
      expect(resolveServerWorkspaceIndexRuntimeDir(workspaceRoot, { runtimeStateDir })).toBe(
        join(runtimeStateDir, "workspace-index"),
      );
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
      rmSync(runtimeStateDir, { force: true, recursive: true });
    }
  });

  it("falls back away from workspace-local runtime state", () => {
    const workspaceRoot = tempDir("keiko-index-workspace-");
    try {
      const runtimeStateDir = join(workspaceRoot, ".keiko");
      const resolved = resolveServerWorkspaceIndexRuntimeDir(workspaceRoot, { runtimeStateDir });

      expect(resolved).toBeDefined();
      expect(resolved?.startsWith(workspaceRoot)).toBe(false);
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("disables an explicitly workspace-local index directory", () => {
    const workspaceRoot = tempDir("keiko-index-workspace-");
    const runtimeStateDir = tempDir("keiko-index-state-");
    try {
      expect(
        resolveServerWorkspaceIndexRuntimeDir(workspaceRoot, {
          runtimeStateDir,
          env: { KEIKO_WORKSPACE_INDEX_DIR: join(workspaceRoot, ".keiko", "index") },
        }),
      ).toBeUndefined();
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
      rmSync(runtimeStateDir, { force: true, recursive: true });
    }
  });

  it("falls back when runtime state resolves into the workspace through a symlink", () => {
    if (process.platform === "win32") {
      return;
    }
    const workspaceRoot = tempDir("keiko-index-workspace-");
    const outsideRoot = tempDir("keiko-index-state-");
    try {
      symlinkSync(workspaceRoot, join(outsideRoot, "workspace-link"), "dir");
      const resolved = resolveServerWorkspaceIndexRuntimeDir(workspaceRoot, {
        runtimeStateDir: join(outsideRoot, "workspace-link"),
      });

      expect(resolved).toBeDefined();
      expect(resolved?.startsWith(workspaceRoot)).toBe(false);
      expect(resolved?.startsWith(outsideRoot)).toBe(false);
    } finally {
      rmSync(outsideRoot, { force: true, recursive: true });
      rmSync(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("returns one cached index per workspace/runtime pair", () => {
    const workspaceRoot = tempDir("keiko-index-workspace-");
    const runtimeStateDir = tempDir("keiko-index-state-");
    try {
      const provider = createServerWorkspaceIndexProvider({ runtimeStateDir });

      expect(provider(workspaceRoot)).toBe(provider(workspaceRoot));
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
      rmSync(runtimeStateDir, { force: true, recursive: true });
    }
  });
});
