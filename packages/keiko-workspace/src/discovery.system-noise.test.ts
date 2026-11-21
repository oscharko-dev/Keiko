// A connected Windows user profile: recursive discovery spends no time in operating-system folders,
// discloses what it pruned, and still reaches the person's nested documents and AppData (#4437).
// The fixture is synthetic; it never touches a real profile or a cloud-synced folder.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverWithStats, visitWorkspaceFiles } from "./discovery.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import { DEFAULT_SEARCH_LIMITS, searchText, type SearchScope } from "./repoSearch.js";
import { createStructuralExecutionControl } from "./structuralExecution.js";
import { DEFAULT_DISCOVERY_OPTIONS, type WorkspaceInfo } from "./types.js";

const PROBE = "NoiseProbe";
const DOCUMENTS = [
  "Documents/Projects/2026/plan.md",
  "Desktop/notes.txt",
  "AppData/Roaming/Tool/settings.txt",
] as const;
const NOISE = [
  "$Recycle.Bin/S-1-5-21-1/$RDELETED.txt",
  "System Volume Information/tracking.log",
  "Documents/desktop.ini",
  "Pictures/Thumbs.db",
  "NTUSER.DAT",
] as const;
// Top-level noise directories the walk must never open.
const NOISE_DIRECTORIES = ["$Recycle.Bin", "System Volume Information"] as const;

let root = "";

function put(path: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${PROBE}=present\n`);
}

function workspace(): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: "profile",
    version: "0",
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

function scope(relativePaths: readonly string[] = []): SearchScope {
  return { scopeId: "system-noise", relativePaths, workspace: workspace() };
}

const QUERY = {
  kind: "exact-symbol" as const,
  text: PROBE,
  maxResults: 50,
  caseSensitive: true,
  emittedAtMs: 0,
};

function openedDirectories(): { readonly fs: WorkspaceFs; readonly opened: string[] } {
  const opened: string[] = [];
  const iterate = nodeWorkspaceFs.iterateDirectory;
  if (iterate === undefined) throw new Error("directory streaming unavailable");
  const fs: WorkspaceFs = {
    ...nodeWorkspaceFs,
    readDir: (path, limit) => {
      opened.push(path);
      return nodeWorkspaceFs.readDir(path, limit);
    },
    iterateDirectory: (path) => {
      opened.push(path);
      return iterate(path);
    },
  };
  return { fs, opened };
}

function touchesNoise(paths: readonly string[]): readonly string[] {
  return paths.filter((path) => NOISE_DIRECTORIES.some((name) => path.includes(name)));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-system-noise-"));
  for (const path of [...DOCUMENTS, ...NOISE]) put(path);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("Windows system noise in a connected user profile (#4437)", () => {
  it.each([null, 100])(
    "finds nested documents and AppData, prunes system entries and discloses them (budget %s)",
    async (maxFilesScanned) => {
      const result = await searchText(scope(), QUERY, {
        ...DEFAULT_SEARCH_LIMITS,
        maxFilesScanned,
      });
      expect(result.atoms.map((atom) => atom.scopePath).sort()).toEqual([...DOCUMENTS].sort());
      expect(result.coverage.systemNoisePrunedByDiscovery).toBe(NOISE.length);
      expect(result.diagnostics?.systemNoisePrunedByDiscovery).toBe(NOISE.length);
      // Pruned noise is policy, not missing evidence: coverage stays complete and the low-value
      // rescue (triggered by any ignored entry) does not walk the root a second time.
      expect(result.coverage.incomplete).toBe(false);
      expect(result.coverage.ignoredByDiscovery).toBe(0);
      expect(result.coverage.filesSkipped).toBeGreaterThanOrEqual(NOISE.length);
    },
  );

  it("never opens a system folder during the complete streaming walk", async () => {
    const { fs, opened } = openedDirectories();
    const visited: string[] = [];
    const stats = await visitWorkspaceFiles(
      workspace(),
      [],
      false,
      fs,
      createStructuralExecutionControl(null),
      {
        onFile: (file) => {
          visited.push(file.relativePath);
          return Promise.resolve();
        },
      },
    );
    expect(visited.sort()).toEqual([...DOCUMENTS].sort());
    expect(stats.systemNoisePruned).toBe(NOISE.length);
    expect(touchesNoise(opened)).toEqual([]);
    expect(opened.length).toBeGreaterThan(0);
  });

  it("prunes system entries from the bounded inventory without opening them", () => {
    const { fs, opened } = openedDirectories();
    const result = discoverWithStats(workspace(), DEFAULT_DISCOVERY_OPTIONS, fs);
    expect(result.files.map((file) => file.relativePath).sort()).toEqual([...DOCUMENTS].sort());
    expect(result.stats.systemNoisePruned).toBe(NOISE.length);
    expect(result.stats.ignored).toBe(0);
    expect(touchesNoise(opened)).toEqual([]);
  });

  it("omits the count when nothing was pruned", () => {
    for (const path of NOISE) rmSync(join(root, path), { recursive: true, force: true });
    for (const name of NOISE_DIRECTORIES)
      rmSync(join(root, name), { recursive: true, force: true });
    const result = discoverWithStats(workspace(), DEFAULT_DISCOVERY_OPTIONS);
    expect(result.stats.systemNoisePruned).toBeUndefined();
  });

  it("walks a system folder the person selected explicitly", async () => {
    const result = await searchText(scope(["$Recycle.Bin"]), QUERY, {
      ...DEFAULT_SEARCH_LIMITS,
      maxFilesScanned: null,
    });
    expect(result.atoms.map((atom) => atom.scopePath)).toEqual([
      "$Recycle.Bin/S-1-5-21-1/$RDELETED.txt",
    ]);
    expect(result.coverage.systemNoisePrunedByDiscovery).toBeUndefined();
  });
});
