import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWorkspaceIndexScopeKey,
  buildWorkspaceIndexSnapshot,
  type WorkspaceIndexScopeKey,
  type WorkspaceIndexSnapshot,
} from "@oscharko-dev/keiko-workspace";
import {
  createServerWorkspaceIndexProvider,
  resolveServerWorkspaceIndexRuntimeDir,
} from "./workspace-index-provider.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function scopeKey(workspaceRoot: string): WorkspaceIndexScopeKey {
  return buildWorkspaceIndexScopeKey(
    {
      workspace: {
        root: workspaceRoot,
        selectedRoot: workspaceRoot,
        name: undefined,
        version: undefined,
        testFramework: "unknown",
        sourceDirs: [],
        testDirs: [],
        languages: [],
        ignoreLines: [],
      },
      relativePaths: [],
    },
    {
      policyMode: "workspace-root-default",
      applyGitignore: true,
      omitLowValueWorkspaceFiles: true,
    },
    1024,
    100,
  );
}

function emptySnapshot(): WorkspaceIndexSnapshot {
  return buildWorkspaceIndexSnapshot({
    scope: { relativePaths: [] },
    policy: {
      policyMode: "workspace-root-default",
      applyGitignore: true,
      omitLowValueWorkspaceFiles: true,
    },
    maxBytesPerFileScanned: 1024,
    maxFilesScanned: 100,
    discovery: {
      files: [],
      directories: [],
      filesDiscovered: 0,
      ignoredByDiscovery: 0,
      deniedByDiscovery: 0,
      depthPrunedByDiscovery: 0,
      truncated: false,
    },
    records: [],
  });
}

function snapshotWithFile(scopePath: string): WorkspaceIndexSnapshot {
  const snapshot = emptySnapshot();
  return {
    ...snapshot,
    discovery: {
      ...snapshot.discovery,
      files: [{ scopePath, sizeBytes: 1 }],
      filesDiscovered: 1,
    },
    records: [{ scopePath, sizeBytes: 1, kind: "text" }],
  };
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

  it("rebuilds the cached index when the encryption key changes", (): void => {
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

  it("fences a stale cached index writer after encryption-key rotation", async () => {
    const workspaceRoot = tempDir("keiko-index-workspace-");
    const runtimeStateDir = tempDir("keiko-index-state-");
    const records: ServerDiagnosticRecord[] = [];
    const env: Record<string, string | undefined> = {
      KEIKO_WORKSPACE_INDEX_KEY: Buffer.alloc(32, 19).toString("base64"),
    };
    try {
      const provider = createServerWorkspaceIndexProvider({
        runtimeStateDir,
        env,
        diagnostics: { record: (record): void => void records.push(record) },
      });
      const stale = provider(workspaceRoot);
      if (stale === undefined) throw new Error("expected initial workspace index");
      const keyShape = scopeKey(workspaceRoot);
      await stale.saveSnapshot(keyShape, snapshotWithFile("src/old.ts"));

      env.KEIKO_WORKSPACE_INDEX_KEY = Buffer.alloc(32, 23).toString("base64");
      const rotated = provider(workspaceRoot);
      if (rotated === undefined) throw new Error("expected rotated workspace index");
      await rotated.saveSnapshot(keyShape, snapshotWithFile("src/new.ts"));
      await expect(
        stale.saveSnapshot(keyShape, snapshotWithFile("src/stale-late.ts")),
      ).rejects.toThrow("after key rotation");

      await expect(rotated.loadSnapshot(keyShape)).resolves.toMatchObject({
        discovery: { files: [{ scopePath: "src/new.ts" }] },
      });
      await expect(stale.loadSnapshot(keyShape)).resolves.toBeUndefined();
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "WORKSPACE_INDEX_KEY_ROTATED",
            message: "Stale workspace index generation was rejected after key rotation.",
          }),
        ]),
      );
      const snapshotDir = join(runtimeStateDir, "workspace-index");
      expect(readdirSync(snapshotDir).filter((name) => name.endsWith(".json"))).toHaveLength(2);
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
      rmSync(runtimeStateDir, { force: true, recursive: true });
    }
  });

  it("fences every workspace sharing a runtime generation after key rotation", async () => {
    const firstWorkspaceRoot = tempDir("keiko-index-first-workspace-");
    const secondWorkspaceRoot = tempDir("keiko-index-second-workspace-");
    const runtimeStateDir = tempDir("keiko-index-shared-state-");
    const records: ServerDiagnosticRecord[] = [];
    const env: Record<string, string | undefined> = {
      KEIKO_WORKSPACE_INDEX_KEY: Buffer.alloc(32, 19).toString("base64"),
    };
    try {
      const provider = createServerWorkspaceIndexProvider({
        runtimeStateDir,
        env,
        diagnostics: { record: (record): void => void records.push(record) },
      });
      const first = provider(firstWorkspaceRoot);
      const second = provider(secondWorkspaceRoot);
      if (first === undefined || second === undefined) {
        throw new Error("expected both workspace indexes");
      }
      await second.saveSnapshot(
        scopeKey(secondWorkspaceRoot),
        snapshotWithFile("src/before-rotation.ts"),
      );

      env.KEIKO_WORKSPACE_INDEX_KEY = Buffer.alloc(32, 23).toString("base64");
      expect(provider(firstWorkspaceRoot)).toBeDefined();

      await expect(
        second.saveSnapshot(
          scopeKey(secondWorkspaceRoot),
          snapshotWithFile("src/after-rotation.ts"),
        ),
      ).rejects.toThrow("after key rotation");
      await expect(second.loadSnapshot(scopeKey(secondWorkspaceRoot))).resolves.toBeUndefined();
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "WORKSPACE_INDEX_KEY_ROTATED",
            message: "Stale workspace index generation was rejected after key rotation.",
          }),
        ]),
      );
    } finally {
      rmSync(firstWorkspaceRoot, { force: true, recursive: true });
      rmSync(secondWorkspaceRoot, { force: true, recursive: true });
      rmSync(runtimeStateDir, { force: true, recursive: true });
    }
  });

  it("emits a redacted diagnostic when key resolution fails", (): void => {
    const workspaceRoot = tempDir("keiko-index-workspace-");
    const runtimeStateDir = tempDir("keiko-index-state-");
    const records: ServerDiagnosticRecord[] = [];
    const invalidKey = Buffer.alloc(31, 29).toString("base64");
    try {
      const provider = createServerWorkspaceIndexProvider({
        runtimeStateDir,
        env: { KEIKO_WORKSPACE_INDEX_KEY: invalidKey },
        diagnostics: {
          record: (record): void => {
            records.push(record);
          },
        },
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

  it("fails closed for cached indexes when a replacement key cannot resolve", async () => {
    const workspaceRoot = tempDir("keiko-index-workspace-");
    const runtimeStateDir = tempDir("keiko-index-state-");
    const records: ServerDiagnosticRecord[] = [];
    const invalidKey = Buffer.alloc(31, 29).toString("base64");
    const validKey = Buffer.alloc(32, 19).toString("base64");
    const env: Record<string, string | undefined> = {
      KEIKO_WORKSPACE_INDEX_KEY: validKey,
    };
    try {
      const provider = createServerWorkspaceIndexProvider({
        runtimeStateDir,
        env,
        diagnostics: { record: (record): void => void records.push(record) },
      });
      const cached = provider(workspaceRoot);
      if (cached === undefined) throw new Error("expected initial workspace index");
      const keyShape = scopeKey(workspaceRoot);
      await cached.saveSnapshot(keyShape, snapshotWithFile("src/before-failure.ts"));

      env.KEIKO_WORKSPACE_INDEX_KEY = invalidKey;
      expect(provider(workspaceRoot)).toBeUndefined();

      await expect(
        cached.saveSnapshot(keyShape, snapshotWithFile("src/after-failure.ts")),
      ).rejects.toThrow("after key rotation");
      await expect(cached.loadSnapshot(keyShape)).resolves.toBeUndefined();
      env.KEIKO_WORKSPACE_INDEX_KEY = validKey;
      const recovered = provider(workspaceRoot);
      if (recovered === undefined) throw new Error("expected recovered workspace index");
      expect(recovered).not.toBe(cached);
      await recovered.saveSnapshot(keyShape, snapshotWithFile("src/recovered.ts"));
      await expect(recovered.loadSnapshot(keyShape)).resolves.toMatchObject({
        discovery: { files: [{ scopePath: "src/recovered.ts" }] },
      });
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: "workspace.index.open" }),
          expect.objectContaining({ code: "WORKSPACE_INDEX_KEY_ROTATED" }),
        ]),
      );
      expect(JSON.stringify(records)).not.toContain(invalidKey);
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
      rmSync(runtimeStateDir, { force: true, recursive: true });
    }
  });

  it("emits a redacted correlation-keyed diagnostic for a corrupt encrypted snapshot", async () => {
    const workspaceRoot = tempDir("keiko-index-workspace-private-");
    const runtimeStateDir = tempDir("keiko-index-state-");
    const records: ServerDiagnosticRecord[] = [];
    const key = Buffer.alloc(32, 19).toString("base64");
    try {
      const provider = createServerWorkspaceIndexProvider({
        runtimeStateDir,
        env: { KEIKO_WORKSPACE_INDEX_KEY: key },
        diagnostics: { record: (record): void => void records.push(record) },
      });
      const index = provider(workspaceRoot);
      if (index === undefined) throw new Error("expected workspace index");
      const keyShape = scopeKey(workspaceRoot);
      await index.saveSnapshot(keyShape, emptySnapshot());
      const snapshotDir = join(runtimeStateDir, "workspace-index");
      const snapshotName = readdirSync(snapshotDir).find((name) => name.endsWith(".json"));
      if (snapshotName === undefined) throw new Error("expected encrypted snapshot");
      writeFileSync(join(snapshotDir, snapshotName), "{corrupt", "utf8");

      await expect(index.loadSnapshot(keyShape)).resolves.toBeUndefined();

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        operation: "workspace.index.load",
        source: "workspace-index-provider",
        code: "WORKSPACE_INDEX_AUTH_OR_CORRUPTION",
        message: "Encrypted workspace index snapshot was rejected.",
      });
      expect(records[0]?.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(JSON.stringify(records)).not.toContain(workspaceRoot);
      expect(JSON.stringify(records)).not.toContain(key);
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
      rmSync(runtimeStateDir, { force: true, recursive: true });
    }
  });

  it("emits a redacted correlation-keyed diagnostic when an encrypted snapshot cannot commit", async () => {
    const workspaceRoot = tempDir("keiko-index-workspace-private-");
    const runtimeStateDir = tempDir("keiko-index-state-");
    const records: ServerDiagnosticRecord[] = [];
    const key = Buffer.alloc(32, 29).toString("base64");
    try {
      const provider = createServerWorkspaceIndexProvider({
        runtimeStateDir,
        env: { KEIKO_WORKSPACE_INDEX_KEY: key },
        diagnostics: { record: (record): void => void records.push(record) },
      });
      const index = provider(workspaceRoot);
      if (index === undefined) throw new Error("expected workspace index");
      const keyShape = scopeKey(workspaceRoot);
      await index.saveSnapshot(keyShape, emptySnapshot());
      const snapshotDir = join(runtimeStateDir, "workspace-index");
      const snapshotName = readdirSync(snapshotDir).find((name) => name.endsWith(".json"));
      if (snapshotName === undefined) throw new Error("expected encrypted snapshot");
      const snapshotPath = join(snapshotDir, snapshotName);
      unlinkSync(snapshotPath);
      mkdirSync(snapshotPath);

      await expect(index.saveSnapshot(keyShape, emptySnapshot())).rejects.toThrow();

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        operation: "workspace.index.save",
        source: "workspace-index-provider",
        code: "WORKSPACE_INDEX_WRITE_REJECTED",
        message: "Encrypted workspace index snapshot write was rejected.",
      });
      expect(records[0]?.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(JSON.stringify(records)).not.toContain(workspaceRoot);
      expect(JSON.stringify(records)).not.toContain(key);
      expect(readdirSync(snapshotDir).some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
      rmSync(runtimeStateDir, { force: true, recursive: true });
    }
  });

  // ADR-0173 D5 / g12: a load failure and a save failure reported for the SAME generation used to
  // each mint their own disconnected `randomUUID()`, so an operator (or an agent joining lines by
  // correlation id) could never tell they were evidence about the same underlying epoch. Fails
  // before the fix — two independent random UUIDs never match — and passes after, once both
  // reporters read the one id minted when the generation was created.
  it("keeps a generation's load and save failures joined under one correlation id", async () => {
    const workspaceRoot = tempDir("keiko-index-workspace-private-");
    const runtimeStateDir = tempDir("keiko-index-state-");
    const records: ServerDiagnosticRecord[] = [];
    const key = Buffer.alloc(32, 19).toString("base64");
    try {
      const provider = createServerWorkspaceIndexProvider({
        runtimeStateDir,
        env: { KEIKO_WORKSPACE_INDEX_KEY: key },
        diagnostics: { record: (record): void => void records.push(record) },
      });
      const index = provider(workspaceRoot);
      if (index === undefined) throw new Error("expected workspace index");
      const keyShape = scopeKey(workspaceRoot);
      await index.saveSnapshot(keyShape, emptySnapshot());
      const snapshotDir = join(runtimeStateDir, "workspace-index");
      const snapshotName = readdirSync(snapshotDir).find((name) => name.endsWith(".json"));
      if (snapshotName === undefined) throw new Error("expected encrypted snapshot");
      const snapshotPath = join(snapshotDir, snapshotName);

      writeFileSync(snapshotPath, "{corrupt", "utf8");
      await expect(index.loadSnapshot(keyShape)).resolves.toBeUndefined();

      unlinkSync(snapshotPath);
      mkdirSync(snapshotPath);
      await expect(index.saveSnapshot(keyShape, emptySnapshot())).rejects.toThrow();

      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({ operation: "workspace.index.load" });
      expect(records[1]).toMatchObject({ operation: "workspace.index.save" });
      expect(records[0]?.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(records[1]?.correlationId).toBe(records[0]?.correlationId);
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
      rmSync(runtimeStateDir, { force: true, recursive: true });
    }
  });
});
