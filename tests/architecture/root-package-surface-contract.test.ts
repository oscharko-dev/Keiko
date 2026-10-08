import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as root from "../../src/index.js";
import * as workspace from "@oscharko-dev/keiko-workspace";
import { memFs } from "../../packages/keiko-workspace/src/_memfs.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
interface RootPackageSurfaceContract {
  packageExports: Record<string, unknown>;
  runtimeExports: string[];
  declarationExports: string[];
}

interface RootManifest {
  exports: Record<string, unknown>;
}

function readRootPackageSurfaceContract(path: string): RootPackageSurfaceContract {
  return JSON.parse(readFileSync(path, "utf8")) as RootPackageSurfaceContract;
}

function readRootManifest(path: string): RootManifest {
  return JSON.parse(readFileSync(path, "utf8")) as RootManifest;
}

const contract = readRootPackageSurfaceContract(
  resolve(repoRoot, "scripts", "root-package-surface.contract.json"),
);
const manifest = readRootManifest(resolve(repoRoot, "package.json"));

describe("root package surface contract", () => {
  it("records the canonical root SDK exports without additions or removals", () => {
    expect(Object.keys(root).sort()).toEqual(contract.runtimeExports);
  });
  it("keeps the root package monolithic-root only", () => {
    expect(manifest.exports).toEqual(contract.packageExports);
    expect(Object.keys(contract.packageExports)).toEqual(["."]);
  });

  it("records non-empty runtime and declaration export allowlists", () => {
    expect(Array.isArray(contract.runtimeExports)).toBe(true);
    expect(Array.isArray(contract.declarationExports)).toBe(true);
    expect(contract.runtimeExports.length).toBeGreaterThan(0);
    expect(contract.declarationExports.length).toBeGreaterThanOrEqual(
      contract.runtimeExports.length,
    );
  });

  it("keeps the root runtime allowlist sorted and duplicate-free", () => {
    const sorted = [...contract.runtimeExports].sort();
    expect(contract.runtimeExports).toEqual(sorted);
    expect(new Set(contract.runtimeExports).size).toBe(contract.runtimeExports.length);
  });
});

const WORKSPACE: root.WorkspaceInfo = {
  root: "/repo",
  selectedRoot: "/repo",
  name: "fixture",
  version: "1",
  testFramework: "vitest",
  sourceDirs: [],
  testDirs: [],
  languages: [],
  ignoreLines: [],
};

describe("reviewed root workspace and readiness additions", () => {
  it("retains the original path-discovery contract and bounded metadata-only executor", async () => {
    expect(root.discoverWorkspacePaths).toBe(workspace.discoverWorkspacePaths);
    expect(root.WORKSPACE_PATH_DISCOVERY_MODES).toBe(workspace.WORKSPACE_PATH_DISCOVERY_MODES);
    expect(root.WORKSPACE_PATH_DISCOVERY_LIMITS).toBe(workspace.WORKSPACE_PATH_DISCOVERY_LIMITS);
    expect(root.WORKSPACE_PATH_DISCOVERY_TRUNCATION_REASONS).toBe(
      workspace.WORKSPACE_PATH_DISCOVERY_TRUNCATION_REASONS,
    );
    const fs = memFs(WORKSPACE.root, { "a.ts": "a", "b.ts": "b", ".env": "denied" });
    const read = vi.spyOn(fs, "readFileUtf8");
    const result = await root.discoverWorkspacePaths(
      WORKSPACE,
      { mode: "directory", directory: "", query: "*", maxResults: 1 },
      { nowMs: () => 0, deadlineAtMs: 5_000 },
      fs,
    );
    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["a.ts"]);
    expect(result.matchedCount).toBe(2);
    expect(result.truncationReasons).toEqual(["result-limit"]);
    expect(result.byteCount).toBeLessThanOrEqual(root.WORKSPACE_PATH_DISCOVERY_LIMITS.outputBytes);
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses an escaped discovery scope before touching the filesystem", async () => {
    const fs = memFs(WORKSPACE.root, {});
    const stat = vi.spyOn(fs, "stat");
    await expect(
      root.discoverWorkspacePaths(
        WORKSPACE,
        { mode: "directory", directory: "../outside", query: "*", maxResults: 1 },
        { nowMs: () => 0, deadlineAtMs: 5_000 },
        fs,
      ),
    ).rejects.toBeInstanceOf(root.RepoSearchInvalidQueryError);
    expect(stat).not.toHaveBeenCalled();
  });

  it.each(["aborted", "timeout"] as const)(
    "preserves the original stopped error and prevents underlying reads on %s",
    (reason) => {
      expect(root.executionControlledWorkspaceFs).toBe(workspace.executionControlledWorkspaceFs);
      expect(root.StructuralExecutionStoppedError).toBe(workspace.StructuralExecutionStoppedError);
      const abort = new AbortController();
      if (reason === "aborted") abort.abort();
      const fs = memFs(WORKSPACE.root, { "a.ts": "a" });
      const read = vi.spyOn(fs, "readFileUtf8");
      const controlled = root.executionControlledWorkspaceFs(fs, {
        nowMs: () => 0,
        deadlineAtMs: reason === "timeout" ? 0 : 5_000,
        signal: abort.signal,
      });
      expect(() => controlled.readFileUtf8("/repo/a.ts")).toThrow(
        root.StructuralExecutionStoppedError,
      );
      expect(() => controlled.readFileUtf8("/repo/a.ts")).toThrow(`structural execution ${reason}`);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("retains the original capped readiness response reader", async () => {
    const payload = { choices: [{ message: { role: "assistant", content: "ready" } }] };
    const response = (): Response =>
      new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    await expect(
      root.readGatewayReadinessChatCompletionResponse(response(), 1_024),
    ).resolves.toEqual(payload);
    await expect(
      root.readGatewayReadinessChatCompletionResponse(response(), 1),
    ).rejects.toMatchObject({
      name: "GatewayResponseBodyValidationError",
      validation: "size-exceeded",
    });
  });
});
