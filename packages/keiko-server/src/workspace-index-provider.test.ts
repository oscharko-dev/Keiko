import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createServerWorkspaceIndexProvider,
  resolveServerWorkspaceIndexRuntimeDir,
} from "./workspace-index-provider.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";

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

  it("falls back when runtime state resolves into the workspace through a symlink", (ctx) => {
    if (process.platform === "win32") {
      ctx.skip();
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
      const provider = createServerWorkspaceIndexProvider({
        runtimeStateDir,
        env: { KEIKO_WORKSPACE_INDEX_KEY: Buffer.alloc(32, 19).toString("base64") },
      });

      expect(provider(workspaceRoot)).toBe(provider(workspaceRoot));
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
      rmSync(runtimeStateDir, { force: true, recursive: true });
    }
  });

  it("rebuilds the cached index when the encryption key changes", () => {
    const workspaceRoot = tempDir("keiko-index-workspace-");
    const runtimeStateDir = tempDir("keiko-index-state-");
    const env: Record<string, string | undefined> = {
      KEIKO_WORKSPACE_INDEX_KEY: Buffer.alloc(32, 19).toString("base64"),
    };
    try {
      const provider = createServerWorkspaceIndexProvider({ runtimeStateDir, env });
      const first = provider(workspaceRoot);

      env.KEIKO_WORKSPACE_INDEX_KEY = Buffer.alloc(32, 23).toString("base64");
      const rotated = provider(workspaceRoot);

      expect(rotated).toBeDefined();
      expect(rotated).not.toBe(first);
      expect(provider(workspaceRoot)).toBe(rotated);
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
      rmSync(runtimeStateDir, { force: true, recursive: true });
    }
  });

  it("emits a redacted diagnostic when key resolution fails", () => {
    const workspaceRoot = tempDir("keiko-index-workspace-");
    const runtimeStateDir = tempDir("keiko-index-state-");
    const records: ServerDiagnosticRecord[] = [];
    const invalidKey = Buffer.alloc(31, 29).toString("base64");
    try {
      const provider = createServerWorkspaceIndexProvider({
        runtimeStateDir,
        env: { KEIKO_WORKSPACE_INDEX_KEY: invalidKey },
        diagnostics: { record: (record) => records.push(record) },
      });

      expect(provider(workspaceRoot)).toBeUndefined();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        operation: "workspace.index.open",
        source: "workspace-index-provider",
        message: "Workspace index key resolution or initialization failed.",
      });
      expect(JSON.stringify(records)).not.toContain(invalidKey);
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
      rmSync(runtimeStateDir, { force: true, recursive: true });
    }
  });
});
