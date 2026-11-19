// #4438 (epic #4429): every metadata call on Windows opens a handle that Defender intercepts. A
// streamed repository search proved each file four times before its content read: the walk, the
// scan's own containment re-check, the read lane's pre-read resolution and its post-read check.
// The walk's proof is now handed to the scan and the pre-read once; the pre-read confirms it with one
// fresh stat instead of a realpath. This pins that budget per file through the production port, and
// pins that the read lane still compares the opened file with the proof and re-resolves it after.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { PathDeniedError } from "./errors.js";
import { nodeWorkspaceFs, type WorkspaceFs, type WorkspaceStat } from "./fs.js";
import { DEFAULT_SEARCH_LIMITS, searchText, type SearchLimits } from "./repoSearch.js";
import type { WorkspaceInfo } from "./types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(root: string): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: "per-file-fs-budget",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: [],
    testDirs: [],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

interface Counted {
  readonly fs: WorkspaceFs;
  readonly calls: Map<string, number>;
}

function counting(base: WorkspaceFs, onRead?: (path: string) => void): Counted {
  const calls = new Map<string, number>();
  const bump = (name: string): void => {
    calls.set(name, (calls.get(name) ?? 0) + 1);
  };
  const readFileBytes = base.readFileBytes;
  return {
    calls,
    fs: {
      ...base,
      realPath: (path): string => {
        bump("realPath");
        return base.realPath(path);
      },
      stat: (path): WorkspaceStat => {
        bump("stat");
        return base.stat(path);
      },
      ...(readFileBytes === undefined
        ? {}
        : {
            readFileBytes: (path, maxBytes, policy, expected): Promise<Uint8Array> => {
              bump("readFileBytes");
              onRead?.(path);
              return readFileBytes(path, maxBytes, policy, expected);
            },
          }),
    },
  };
}

function repository(fileCount: number): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "keiko-fs-budget-")));
  roots.push(root);
  for (let index = 0; index < fileCount; index += 1) {
    const dir = join(root, "src", `d${String(index % 4)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `m${String(index)}.ts`), `export const v${String(index)} = 1;\n`);
  }
  return root;
}

function refusedByReadLane(error: unknown): boolean {
  if (error instanceof PathDeniedError) return true;
  if (error instanceof AggregateError && error.errors.some(refusedByReadLane)) return true;
  return error instanceof Error && error.cause !== undefined && refusedByReadLane(error.cause);
}

const query: RetrievalQuery = {
  kind: "exact-symbol",
  text: "zzqqNoSuchToken",
  caseSensitive: false,
  maxResults: 50,
  emittedAtMs: 0,
};

const STREAMED: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: null };

async function search(root: string, fs: WorkspaceFs): Promise<number> {
  const result = await searchText(
    { workspace: workspace(root), scopeId: "fs-budget", relativePaths: [] },
    query,
    STREAMED,
    { fs },
  );
  return result.filesScanned;
}

describe("streamed repository search per-file filesystem budget (#4438)", () => {
  it("proves each file with at most two realpath and three stat calls", async () => {
    const fileCount = 40;
    const root = repository(fileCount);
    const { fs, calls } = counting(nodeWorkspaceFs);
    expect(await search(root, fs)).toBe(fileCount);
    expect(calls.get("readFileBytes")).toBe(fileCount);
    // The walk proof, a fresh pre-read stat and the post-read check per file; directories and the root add a
    // bounded constant. Before #4438 each file cost four realpath and four stat calls.
    const directoryAllowance = 4 * 6; // root, src and four leaf directories
    expect(calls.get("realPath") ?? 0).toBeLessThanOrEqual(2 * fileCount + directoryAllowance);
    expect(calls.get("stat") ?? 0).toBeLessThanOrEqual(3 * fileCount + directoryAllowance);
  });

  it("still refuses a file replaced by an outside symlink after the walk proved it", async () => {
    const root = repository(2);
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "keiko-fs-budget-outside-")));
    roots.push(outside);
    writeFileSync(join(outside, "secret.ts"), "export const zzqqNoSuchToken = 1;\n");
    const victim = join(root, "src", "d0", "m0.ts");
    let swapped = false;
    const { fs } = counting(nodeWorkspaceFs, (path) => {
      if (swapped || path !== victim) return;
      swapped = true;
      rmSync(victim);
      symlinkSync(join(outside, "secret.ts"), victim);
    });
    // The read lane fails closed: the search either refuses the swapped path or omits it, and never
    // returns content from outside the workspace.
    const outcome = await searchText(
      { workspace: workspace(root), scopeId: "fs-budget", relativePaths: [] },
      query,
      STREAMED,
      { fs },
    ).then(
      (result) => result.atoms.map((atom) => atom.scopePath),
      (error: unknown) => (refusedByReadLane(error) ? "refused" : error),
    );
    expect(swapped).toBe(true);
    expect(outcome === "refused" || (Array.isArray(outcome) && outcome.length === 0)).toBe(true);
  });
});
