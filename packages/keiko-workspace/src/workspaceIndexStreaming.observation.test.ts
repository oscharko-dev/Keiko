import { describe, expect, it } from "vitest";
import { DEFAULT_SEARCH_LIMITS } from "./repoSearch.js";
import type { FileMatches, SearchTextRunner } from "./repoSearchScan.js";
import { createStructuralExecutionControl } from "./structuralExecution.js";
import {
  createInMemoryWorkspaceIndexStore,
  createWorkspaceIndex,
  workspaceIndexFileMetadata,
  type WorkspaceIndex,
  type WorkspaceIndexDiscoveredFile,
} from "./workspaceIndex.js";
import { StreamingWorkspaceIndex } from "./workspaceIndexStreaming.js";

const IDENTITY = "a".repeat(64);
const TEXT = "The Vesper furnace keeps its temperature at 73.5 C.\n";

function runner(): SearchTextRunner {
  return {
    fs: {} as SearchTextRunner["fs"],
    limits: { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: null, elapsedMsMax: null },
    nowMs: () => 0,
    startMs: 0,
    fingerprint: "fixture",
    contentLane: "evidence",
    literalTerms: ["vesper"],
    query: {
      kind: "natural-language",
      text: "vesper",
      caseSensitive: false,
      emittedAtMs: 0,
      maxResults: 10,
    },
    matcher: { match: (): number => 1 },
    policy: {
      mode: "explicit-scope",
      intent: "generic",
      applyGitignore: false,
      omitLowValueWorkspaceFiles: false,
      lowValuePathAllowlist: [],
      recentPaths: [],
    },
    scope: {
      scopeId: "fixture",
      relativePaths: [],
      workspace: {
        root: "/ws",
        selectedRoot: "/ws",
        name: "fixture",
        version: undefined,
        testFramework: "unknown",
        sourceDirs: [],
        testDirs: [],
        languages: [],
        ignoreLines: [],
      },
    },
  };
}

function file(path: string): WorkspaceIndexDiscoveredFile {
  return workspaceIndexFileMetadata(path, {
    size: Buffer.byteLength(TEXT),
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
    mtimeMs: 1,
  });
}

function matches(path: string): FileMatches {
  return {
    relativePath: path,
    order: 0,
    best: [{ line: 1, startLine: 1, endLine: 1, score: 1 }],
    maxScore: 1,
  };
}

interface Recorded {
  readonly loads: number;
  readonly saves: number;
}

function recording(): { index: WorkspaceIndex; recorded: () => Recorded } {
  const base = createWorkspaceIndex(createInMemoryWorkspaceIndexStore());
  let loads = 0;
  let saves = 0;
  return {
    index: {
      loadSnapshot: (key, isActive): ReturnType<WorkspaceIndex["loadSnapshot"]> => {
        loads += 1;
        return base.loadSnapshot(key, isActive);
      },
      saveSnapshot: (key, snapshot, isActive): ReturnType<WorkspaceIndex["saveSnapshot"]> => {
        saves += 1;
        return base.saveSnapshot(key, snapshot, isActive);
      },
    },
    recorded: () => ({ loads, saves }),
  };
}

function session(index: WorkspaceIndex): StreamingWorkspaceIndex {
  return new StreamingWorkspaceIndex(
    index,
    runner(),
    IDENTITY,
    createStructuralExecutionControl(null, () => 0),
  );
}

async function settleLiveRead(
  index: StreamingWorkspaceIndex,
  path: string,
  lookup: boolean,
): Promise<void> {
  if (lookup) expect(await index.lookup(file(path))).toBeUndefined();
  await index.observeRead(file(path), { kind: "text", text: TEXT });
  await index.observeMatch(path, matches(path), true);
}

describe("streaming index observations (#4457)", () => {
  // A file another phase of the request reads without a lookup must not load or settle a shard:
  // which shards a request touches would otherwise depend on that phase's timing, and a later
  // request could find a shard the earlier one never saved (flaky `indexLoadStatus: mixed`).
  it("settles nothing for a read that no lookup requested", async () => {
    const { index, recorded } = recording();
    const streaming = session(index);
    await settleLiveRead(streaming, "docs/vesper.md", false);
    await streaming.finalize();
    expect(recorded()).toEqual({ loads: 0, saves: 0 });
    expect(streaming.report()).toMatchObject({ indexedRecords: 0, retainedEntries: 0 });
  });

  it("indexes a looked-up read in both the match and the content shard", async () => {
    const { index, recorded } = recording();
    const streaming = session(index);
    await settleLiveRead(streaming, "docs/vesper.md", true);
    await streaming.finalize();
    expect(recorded()).toEqual({ loads: 2, saves: 2 });
    expect(streaming.report()).toMatchObject({ indexedRecords: 1, retainedEntries: 1 });
  });
});
