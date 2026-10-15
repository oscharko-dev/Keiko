import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWorkspaceIndexScopeKey,
  buildWorkspaceIndexSnapshot,
  type WorkspaceIndex,
  type WorkspaceIndexScopeKey,
  type WorkspaceIndexSnapshot,
} from "@oscharko-dev/keiko-workspace";
import { createServerWorkspaceIndexProvider } from "./workspace-index-provider.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const POLICY = {
  policyMode: "workspace-root-default",
  applyGitignore: true,
  omitLowValueWorkspaceFiles: true,
} as const;

function scopeKey(root: string): WorkspaceIndexScopeKey {
  return buildWorkspaceIndexScopeKey(
    {
      workspace: {
        root,
        selectedRoot: root,
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
    POLICY,
    1024,
    100,
  );
}

function snapshot(): WorkspaceIndexSnapshot {
  return buildWorkspaceIndexSnapshot({
    scope: { relativePaths: [] },
    policy: POLICY,
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

function fixture(): { readonly index: WorkspaceIndex; readonly key: WorkspaceIndexScopeKey } {
  const root = mkdtempSync(join(tmpdir(), "keiko-index-request-workspace-"));
  const state = mkdtempSync(join(tmpdir(), "keiko-index-request-state-"));
  roots.push(root, state);
  const provider = createServerWorkspaceIndexProvider({
    runtimeStateDir: state,
    env: { KEIKO_WORKSPACE_INDEX_KEY: Buffer.alloc(32, 19).toString("base64") },
  });
  const index = provider(root);
  if (index === undefined) throw new Error("Expected encrypted workspace index provider");
  return { index, key: scopeKey(root) };
}

describe("encrypted workspace index request guards", () => {
  it("does not return a real encrypted snapshot to an inactive request", async () => {
    const { index, key } = fixture();
    await index.saveSnapshot(key, snapshot());
    expect(await index.loadSnapshot(key)).toBeDefined();
    expect(await index.loadSnapshot(key, () => false)).toBeUndefined();
    expect(await index.loadSnapshot(key, () => true)).toBeDefined();
  });

  it("does not persist a real encrypted snapshot for an inactive request", async () => {
    const { index, key } = fixture();
    await index.saveSnapshot(key, snapshot(), () => false);
    expect(await index.loadSnapshot(key)).toBeUndefined();
    await index.saveSnapshot(key, snapshot(), () => true);
    expect(await index.loadSnapshot(key)).toBeDefined();
  });
});
