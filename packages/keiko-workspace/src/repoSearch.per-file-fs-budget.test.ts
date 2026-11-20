// #4438 (epic #4429): every metadata call on Windows opens a handle that Defender intercepts. A
// streamed repository search proved each file four times before its content read: the walk, the
// scan's own containment re-check, the read lane's pre-read resolution and its post-read check.
// The walk's proof is now handed to the scan and the pre-read once; the pre-read confirms it with one
// fresh stat instead of a realpath. A text file larger than the binary probe hands the head read's
// post-read proof to its full read the same way, and a stored workspace-index result is confirmed
// with one stat instead of a second full proof.
//
// This file is the regression gate for that budget. It measures the exact number of port calls each
// additional file costs, through the production port, by searching the same directory layout with
// two file counts: directories and the root add a constant that cancels out, so the per-file slope
// is deterministic and independent of the platform, the disk and the machine load. A change that
// adds one realpath or stat per walked file fails here, not in a latency measurement. The pins below
// it prove that every cheaper confirmation still falls back to the full containment proof.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { PathDeniedError, PathEscapeError } from "./errors.js";
import { nodeWorkspaceFs, type WorkspaceFs, type WorkspaceStat } from "./fs.js";
import { DEFAULT_SEARCH_LIMITS, searchText, type SearchLimits } from "./repoSearch.js";
import type { WorkspaceInfo } from "./types.js";
import { createWorkspaceIndex, type WorkspaceIndex } from "./workspaceIndex.js";

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

type PortMethod = "realPath" | "stat" | "readFileBytes";

interface PortHooks {
  /** Replaces the result of a no-follow stat; runs after the real call. */
  readonly stat?: (path: string, real: WorkspaceStat) => WorkspaceStat;
  /** Replaces the result of a realpath; runs after the real call. */
  readonly realPath?: (path: string, real: string) => string;
  readonly beforeRead?: (path: string) => void;
}

interface Counted {
  readonly fs: WorkspaceFs;
  readonly calls: Map<PortMethod, number>;
}

function counting(base: WorkspaceFs, hooks: PortHooks = {}): Counted {
  const calls = new Map<PortMethod, number>();
  const bump = (name: PortMethod): void => {
    calls.set(name, (calls.get(name) ?? 0) + 1);
  };
  const readFileBytes = base.readFileBytes;
  return {
    calls,
    fs: {
      ...base,
      realPath: (path): string => {
        bump("realPath");
        const real = base.realPath(path);
        return hooks.realPath === undefined ? real : hooks.realPath(path, real);
      },
      stat: (path): WorkspaceStat => {
        bump("stat");
        const real = base.stat(path);
        return hooks.stat === undefined ? real : hooks.stat(path, real);
      },
      ...(readFileBytes === undefined
        ? {}
        : {
            readFileBytes: (path, maxBytes, policy, expected): Promise<Uint8Array> => {
              bump("readFileBytes");
              hooks.beforeRead?.(path);
              return readFileBytes(path, maxBytes, policy, expected);
            },
          }),
    },
  };
}

// Larger than the 4 KiB binary probe, so text inspection reads a head and then the whole file.
const LARGE_FILE_PADDING = `// ${"padding ".repeat(700)}\n`;

function repository(fileCount: number, content: (index: number) => string): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "keiko-fs-budget-")));
  roots.push(root);
  for (let index = 0; index < fileCount; index += 1) {
    const dir = join(root, "src", `d${String(index % 4)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `m${String(index)}.ts`), content(index));
  }
  return root;
}

function smallFile(index: number): string {
  return `export const v${String(index)} = 1;\n`;
}

function largeFile(index: number): string {
  return `${smallFile(index)}${LARGE_FILE_PADDING}`;
}

function refusedByReadLane(error: unknown): boolean {
  if (error instanceof PathDeniedError || error instanceof PathEscapeError) return true;
  if (error instanceof AggregateError && error.errors.some(refusedByReadLane)) return true;
  return error instanceof Error && error.cause !== undefined && refusedByReadLane(error.cause);
}

function naturalLanguage(text: string): RetrievalQuery {
  return { kind: "natural-language", text, caseSensitive: false, maxResults: 50, emittedAtMs: 0 };
}

const NO_MATCH: RetrievalQuery = {
  kind: "exact-symbol",
  text: "zzqqNoSuchToken",
  caseSensitive: false,
  maxResults: 50,
  emittedAtMs: 0,
};

const STREAMED: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: null };

interface SearchRun {
  readonly filesScanned: number;
  readonly scopePaths: readonly string[];
}

async function search(
  root: string,
  fs: WorkspaceFs,
  query: RetrievalQuery = NO_MATCH,
  workspaceIndex?: WorkspaceIndex,
): Promise<SearchRun> {
  const result = await searchText(
    { workspace: workspace(root), scopeId: "fs-budget", relativePaths: [] },
    query,
    STREAMED,
    { fs, ...(workspaceIndex === undefined ? {} : { workspaceIndex, nowMs: (): number => 0 }) },
  );
  return { filesScanned: result.filesScanned, scopePaths: result.atoms.map((a) => a.scopePath) };
}

type Scenario = (fileCount: number) => Promise<Map<PortMethod, number>>;

// Two file counts over the same six directories: the slope is what one more walked file costs.
const SMALL = 8;
const LARGE = 16;

async function perFileCost(scenario: Scenario): Promise<Record<PortMethod, number>> {
  const small = await scenario(SMALL);
  const large = await scenario(LARGE);
  const slope = (method: PortMethod): number =>
    ((large.get(method) ?? 0) - (small.get(method) ?? 0)) / (LARGE - SMALL);
  return {
    realPath: slope("realPath"),
    stat: slope("stat"),
    readFileBytes: slope("readFileBytes"),
  };
}

async function coldSearchCalls(
  fileCount: number,
  content: (index: number) => string,
): Promise<Map<PortMethod, number>> {
  const root = repository(fileCount, content);
  const { fs, calls } = counting(nodeWorkspaceFs);
  expect((await search(root, fs)).filesScanned).toBe(fileCount);
  return calls;
}

async function warmSearchCalls(fileCount: number): Promise<Map<PortMethod, number>> {
  const root = repository(fileCount, smallFile);
  const workspaceIndex = createWorkspaceIndex();
  await search(root, nodeWorkspaceFs, naturalLanguage("exported constant value"), workspaceIndex);
  const { fs, calls } = counting(nodeWorkspaceFs);
  const differentlyWorded = naturalLanguage("where is the numeric setting declared");
  expect((await search(root, fs, differentlyWorded, workspaceIndex)).filesScanned).toBe(fileCount);
  return calls;
}

describe("streamed repository search per-file filesystem budget (#4438 regression gate)", () => {
  it("costs two realpath, three stat and one read per small file on a cold search", async () => {
    // Walk proof (realpath + stat), pre-read confirmation (stat), post-read check (realpath + stat).
    // Before #4438: four realpath and four stat calls per file.
    expect(await perFileCost((count) => coldSearchCalls(count, smallFile))).toEqual({
      realPath: 2,
      stat: 3,
      readFileBytes: 1,
    });
  });

  it("costs three realpath, five stat and two reads per file larger than the binary probe", async () => {
    // The head read as above; the full read confirms the head's post-read proof (stat) and keeps its
    // own post-read check (realpath + stat). Before: a full re-resolution (realpath + stat) instead.
    expect(await perFileCost((count) => coldSearchCalls(count, largeFile))).toEqual({
      realPath: 3,
      stat: 5,
      readFileBytes: 2,
    });
  });

  it("costs one realpath, two stat and no read per file answered from the warm index", async () => {
    // Walk proof (realpath + stat) and one stat confirming the stored record after the lookup.
    // Before: the confirmation re-ran the full containment proof (realpath + stat).
    expect(await perFileCost(warmSearchCalls)).toEqual({
      realPath: 1,
      stat: 2,
      readFileBytes: 0,
    });
  });
});

// A port-level redirection: from the moment `armed` is set, the victim reports a symbolic link and
// resolves outside the root. Simulated at the port so the pins run on every platform, including
// Windows hosts without the privilege to create file symlinks.
interface Redirection {
  armed: boolean;
  realPathCallsAfterArming: number;
}

function redirectingHooks(victim: string, outside: string, redirection: Redirection): PortHooks {
  return {
    stat: (path, real): WorkspaceStat =>
      redirection.armed && path === victim
        ? { ...real, isFile: false, isSymbolicLink: true }
        : real,
    realPath: (path, real): string => {
      if (!redirection.armed || path !== victim) return real;
      redirection.realPathCallsAfterArming += 1;
      return outside;
    },
  };
}

function outsideFile(): string {
  const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "keiko-fs-budget-outside-")));
  roots.push(outside);
  const secret = join(outside, "secret.ts");
  writeFileSync(secret, "export const zebraquartzOutside = 1;\n");
  return secret;
}

async function outcomeOf(run: Promise<SearchRun>): Promise<readonly string[] | "refused"> {
  return run.then(
    (result) => result.scopePaths,
    (error: unknown) => {
      if (refusedByReadLane(error)) return "refused";
      throw error;
    },
  );
}

describe("cheaper confirmations keep the full containment proof as their fallback (#4438)", () => {
  it("still refuses a file replaced by an outside symlink after the walk proved it", async () => {
    const root = repository(2, smallFile);
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "keiko-fs-budget-outside-")));
    roots.push(outside);
    writeFileSync(join(outside, "secret.ts"), "export const zzqqNoSuchToken = 1;\n");
    const victim = join(root, "src", "d0", "m0.ts");
    let swapped = false;
    const { fs } = counting(nodeWorkspaceFs, {
      beforeRead: (path) => {
        if (swapped || path !== victim) return;
        swapped = true;
        rmSync(victim);
        symlinkSync(join(outside, "secret.ts"), victim);
      },
    });
    // The read lane fails closed: the search either refuses the swapped path or omits it, and never
    // returns content from outside the workspace.
    const outcome = await outcomeOf(search(root, fs));
    expect(swapped).toBe(true);
    expect(outcome === "refused" || outcome.length === 0).toBe(true);
  });

  it("re-proves a warm-index file that turned into a link before its stored result is used", async () => {
    const root = repository(4, (index) =>
      index === 0 ? "export const zebraquartz = 1;\n" : smallFile(index),
    );
    const victim = join(root, "src", "d0", "m0.ts");
    const query = naturalLanguage("zebraquartz");
    const workspaceIndex = createWorkspaceIndex();
    // Positive control: the stored result names the victim while it is unchanged.
    expect((await search(root, nodeWorkspaceFs, query, workspaceIndex)).scopePaths).toContain(
      "src/d0/m0.ts",
    );
    const redirection: Redirection = { armed: false, realPathCallsAfterArming: 0 };
    let victimStats = 0;
    const hooks = redirectingHooks(victim, outsideFile(), redirection);
    const { fs } = counting(nodeWorkspaceFs, {
      ...hooks,
      // Arm after the walk's own stat of the victim: the next stat is the stored-result confirmation.
      stat: (path, real): WorkspaceStat => {
        if (path === victim) {
          victimStats += 1;
          if (victimStats === 2) redirection.armed = true;
        }
        return hooks.stat?.(path, real) ?? real;
      },
    });
    const outcome = await outcomeOf(search(root, fs, query, workspaceIndex));
    expect(redirection.armed).toBe(true);
    expect(redirection.realPathCallsAfterArming).toBeGreaterThan(0);
    expect(outcome === "refused" || !outcome.includes("src/d0/m0.ts")).toBe(true);
  });

  it("re-proves a large file that turned into a link between its head and its full read", async () => {
    const root = repository(4, (index) =>
      index === 0 ? `export const zebraquartz = 1;\n${LARGE_FILE_PADDING}` : smallFile(index),
    );
    const victim = join(root, "src", "d0", "m0.ts");
    const redirection: Redirection = { armed: false, realPathCallsAfterArming: 0 };
    let victimReads = 0;
    let victimStats = 0;
    const hooks = redirectingHooks(victim, outsideFile(), redirection);
    const { fs } = counting(nodeWorkspaceFs, {
      ...hooks,
      // Stats of the victim: walk, head confirmation, head post-read check, full-read confirmation.
      // Arm on the fourth, after the head read was proven and before the full read may start.
      stat: (path, real): WorkspaceStat => {
        if (path === victim) {
          victimStats += 1;
          if (victimStats === 4) redirection.armed = true;
        }
        return hooks.stat?.(path, real) ?? real;
      },
      beforeRead: (path) => {
        if (path === victim) victimReads += 1;
      },
    });
    const outcome = await outcomeOf(search(root, fs, naturalLanguage("zebraquartz")));
    expect(redirection.armed).toBe(true);
    expect(victimReads).toBe(1);
    expect(redirection.realPathCallsAfterArming).toBeGreaterThan(0);
    expect(outcome === "refused" || !outcome.includes("src/d0/m0.ts")).toBe(true);
  });
});
