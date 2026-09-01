// Branch-coverage tests for the editor-epic branches in repoSearchScan.ts that remained
// uncovered after the feat/keiko-editor → release/0.2.0 merge. Each test asserts observable
// side-effects so that a single-line mutation in the covered branch breaks the test.

import { describe, expect, it } from "vitest";
import type { CandidateFile, EvidenceAtom } from "@oscharko-dev/keiko-contracts/connected-context";
import { PathDeniedError, PathEscapeError, WORKSPACE_CODES } from "./errors.js";
import type { WorkspaceFs } from "./fs.js";
import { memFs } from "./_memfs.js";
import {
  buildCandidate,
  hitLimit,
  isIoError,
  probeBinary,
  scanFile,
  type LimitsShape,
  type RunState,
  type SearchTextRunner,
} from "./repoSearchScan.js";
import { resolveSearchPolicy } from "./repoSearchPolicy.js";
import { buildMatcher, fingerprintFor } from "./repoSearchMatchers.js";
import type { DiscoveredFile, WorkspaceInfo } from "./types.js";
import {
  buildWorkspaceIndexLexicalRecord,
  workspaceIndexFileMetadata,
  type PreparedWorkspaceIndexEntry,
  type WorkspaceIndexRecord,
} from "./workspaceIndex.js";

// ─── Test fixtures ────────────────────────────────────────────────────────────

const MEM_ROOT = "/ws";

function workspace(): WorkspaceInfo {
  return {
    root: MEM_ROOT,
    name: "demo",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

function limits(): LimitsShape {
  return {
    maxFilesScanned: 100,
    maxMatchesReturned: 50,
    maxBytesPerFileScanned: 524_288,
    elapsedMsMax: 5_000,
  };
}

function nlQuery(): SearchTextRunner["query"] {
  return {
    kind: "natural-language" as const,
    text: "needle",
    caseSensitive: false,
    maxResults: 100,
    emittedAtMs: 0,
  };
}

function buildRunner(
  fs: WorkspaceFs,
  overrides: Partial<Pick<SearchTextRunner, "signal" | "limits" | "nowMs">> = {},
): SearchTextRunner {
  const query = nlQuery();
  const policy = resolveSearchPolicy(false, undefined);
  return {
    scope: {
      workspace: workspace(),
      scopeId: "scope-test",
      relativePaths: [],
    },
    limits: overrides.limits ?? limits(),
    fs,
    nowMs: overrides.nowMs ?? ((): number => 0),
    startMs: 0,
    signal: overrides.signal,
    matcher: buildMatcher(query),
    fingerprint: fingerprintFor(query),
    policy,
    query,
    contentLane: "evidence",
  };
}

function discoveredFile(relativePath: string, sizeBytes = 10): DiscoveredFile {
  return { relativePath, sizeBytes };
}

function cachedIndexEntry(content: string, includeMtime = true): PreparedWorkspaceIndexEntry {
  return {
    scopePath: "src/a.ts",
    absolutePath: `${MEM_ROOT}/src/a.ts`,
    file: discoveredFile("src/a.ts", content.length),
    ...(includeMtime ? { mtimeMs: 1 } : {}),
    record: {
      scopePath: "src/a.ts",
      sizeBytes: content.length,
      ...(includeMtime ? { mtimeMs: 1 } : {}),
      kind: "text",
      lexical: buildWorkspaceIndexLexicalRecord(content),
    },
    stale: false,
  };
}

function cachedRunner(
  fs: WorkspaceFs,
  entry: PreparedWorkspaceIndexEntry,
  stalePaths: string[],
): SearchTextRunner {
  return {
    ...buildRunner(fs),
    workspaceIndex: {
      entries: new Map([[entry.scopePath, entry]]),
      onRecord: () => undefined,
      onStale: (scopePath) => stalePaths.push(scopePath),
    },
  };
}

function freshState(): RunState {
  return { filesScanned: 0, matchesReturned: 0, truncated: false };
}

function makeErrnoError(code: string): Error & { code: string } {
  const err = new Error(`${code}: permission denied`) as Error & { code: string };
  err.code = code;
  return err;
}

// ─── probeBinary ─────────────────────────────────────────────────────────────

describe("probeBinary – zero-size file", () => {
  it("returns false without reading any bytes when size is 0", async () => {
    let readCalls = 0;
    const fs: WorkspaceFs = {
      ...memFs(MEM_ROOT, {}),
      readFileBytes: (): Promise<Uint8Array> => {
        readCalls += 1;
        return Promise.resolve(new Uint8Array());
      },
    };
    const result = await probeBinary(fs, `${MEM_ROOT}/empty.ts`, 0);
    expect(result).toBe(false);
    expect(readCalls).toBe(0);
  });
});

describe("probeBinary – no readFileBytes on fs", () => {
  it("falls back to readFileUtf8 when readFileBytes is absent", async () => {
    const plainText = "hello world\n";
    const base = memFs(MEM_ROOT, { "src/a.ts": plainText });
    const fs: WorkspaceFs = {
      readFileUtf8: base.readFileUtf8,
      stat: base.stat,
      readDir: base.readDir,
      realPath: base.realPath,
      exists: base.exists,
      // Deliberately omit readFileBytes to trigger the utf8 fallback branch.
    };
    const result = await probeBinary(fs, `${MEM_ROOT}/src/a.ts`, plainText.length);
    expect(result).toBe(false);
  });

  it("detects binary content via readFileUtf8 fallback when readFileBytes is absent", async () => {
    // A NUL byte makes looksBinary return true.
    const binaryContent = String.fromCharCode(0x00) + "PNG data";
    const base = memFs(MEM_ROOT, { "img.png": binaryContent });
    const fs: WorkspaceFs = {
      readFileUtf8: base.readFileUtf8,
      stat: base.stat,
      readDir: base.readDir,
      realPath: base.realPath,
      exists: base.exists,
    };
    const result = await probeBinary(fs, `${MEM_ROOT}/img.png`, binaryContent.length);
    expect(result).toBe(true);
  });
});

// ─── hitLimit – abort-signal branch ──────────────────────────────────────────

describe("hitLimit – AbortSignal", () => {
  it("returns true and marks truncated when runner.signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    const runner = buildRunner(memFs(MEM_ROOT, {}), { signal: controller.signal });
    const state = freshState();

    const result = hitLimit(runner, state);

    expect(result).toBe(true);
    expect(state.truncated).toBe(true);
  });

  it("does not mark truncated when signal is defined but not yet aborted", () => {
    const controller = new AbortController();
    const runner = buildRunner(memFs(MEM_ROOT, {}), { signal: controller.signal });
    const state = freshState();

    const result = hitLimit(runner, state);

    expect(result).toBe(false);
    expect(state.truncated).toBe(false);
  });
});

// ─── scanFile – abort before policy check ────────────────────────────────────

describe("scanFile – aborted at entry", () => {
  it("sets truncated and returns immediately when runner is aborted before policy check", async () => {
    const controller = new AbortController();
    controller.abort();
    const fs = memFs(MEM_ROOT, { "src/a.ts": "needle\n" });
    const runner = buildRunner(fs, { signal: controller.signal });
    const state = freshState();
    const atoms: EvidenceAtom[] = [];
    const candidates: CandidateFile[] = [];

    await scanFile(runner, discoveredFile("src/a.ts"), state, atoms, candidates);

    expect(state.truncated).toBe(true);
    expect(atoms).toHaveLength(0);
    expect(candidates).toHaveLength(0);
    expect(state.filesScanned).toBe(0);
  });
});

describe("scanFile – aborted after binary check", () => {
  it("sets truncated after binary probe completes when signal is aborted mid-probe", async () => {
    const controller = new AbortController();
    const fs = memFs(MEM_ROOT, { "src/a.ts": "needle\n" });

    // Abort the signal inside readFileBytes so the second isRunnerAborted guard fires.
    const baseReadFileBytes = fs.readFileBytes;
    if (baseReadFileBytes === undefined) throw new Error("memFs always provides readFileBytes");
    const interceptedFs: WorkspaceFs = {
      ...fs,
      readFileBytes: async (abs, max, hardLinkPolicy): Promise<Uint8Array> => {
        controller.abort();
        return await baseReadFileBytes(abs, max, hardLinkPolicy);
      },
    };

    const runner = buildRunner(interceptedFs, { signal: controller.signal });
    const state = freshState();
    const atoms: EvidenceAtom[] = [];
    const candidates: CandidateFile[] = [];

    await scanFile(runner, discoveredFile("src/a.ts", 7), state, atoms, candidates);

    expect(state.truncated).toBe(true);
    expect(atoms).toHaveLength(0);
    expect(state.filesScanned).toBe(0);
  });
});

// ─── scanFile – binaryOmission non-IO re-throw ───────────────────────────────

describe("scanFile – binaryOmission re-throws non-IO errors", () => {
  it("re-throws a TypeError from readFileBytes without swallowing it", async () => {
    const fs = memFs(MEM_ROOT, { "src/a.ts": "needle\n" });
    const badFs: WorkspaceFs = {
      ...fs,
      readFileBytes: (): Promise<Uint8Array> =>
        Promise.reject(new TypeError("unexpected non-io shape")),
    };
    const runner = buildRunner(badFs);
    const state = freshState();
    const atoms: EvidenceAtom[] = [];
    const candidates: CandidateFile[] = [];

    await expect(
      scanFile(runner, discoveredFile("src/a.ts", 7), state, atoms, candidates),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("scanFile – cached metadata validation", () => {
  it("does not silently downgrade a programmer error from cached-entry stat", async () => {
    const content = "needle\n";
    const base = memFs(MEM_ROOT, { "src/a.ts": content });
    let statCalls = 0;
    const fs: WorkspaceFs = {
      ...base,
      stat: (absolutePath) => {
        statCalls += 1;
        if (statCalls === 1) throw new TypeError("unexpected cached stat shape");
        return base.stat(absolutePath);
      },
    };
    const entry: PreparedWorkspaceIndexEntry = {
      scopePath: "src/a.ts",
      absolutePath: `${MEM_ROOT}/src/a.ts`,
      file: discoveredFile("src/a.ts", content.length),
      record: {
        scopePath: "src/a.ts",
        sizeBytes: content.length,
        kind: "text",
        lexical: buildWorkspaceIndexLexicalRecord(content),
      },
      stale: false,
    };
    const runner: SearchTextRunner = {
      ...buildRunner(fs),
      workspaceIndex: {
        entries: new Map([[entry.scopePath, entry]]),
        onRecord: () => undefined,
        onStale: () => undefined,
      },
    };

    await expect(
      scanFile(runner, discoveredFile("src/a.ts", content.length), freshState(), [], []),
    ).rejects.toThrow("unexpected cached stat shape");
  });

  it("bypasses a same-size cached record when no modification timestamp is available", async () => {
    const cachedContent = "needle\n";
    const liveContent = "actual\n";
    const base = memFs(MEM_ROOT, { "src/a.ts": liveContent });
    const readFileBytes = base.readFileBytes;
    if (readFileBytes === undefined) throw new Error("memFs always provides readFileBytes");
    let contentReads = 0;
    const fs: WorkspaceFs = {
      ...base,
      readFileBytes: async (absolutePath, maxBytes, hardLinkPolicy): Promise<Uint8Array> => {
        contentReads += 1;
        return await readFileBytes(absolutePath, maxBytes, hardLinkPolicy);
      },
    };
    const stalePaths: string[] = [];
    const atoms: EvidenceAtom[] = [];

    await scanFile(
      cachedRunner(fs, cachedIndexEntry(cachedContent, false), stalePaths),
      discoveredFile("src/a.ts", liveContent.length),
      freshState(),
      atoms,
      [],
    );

    expect(atoms).toHaveLength(0);
    expect(stalePaths).toEqual(["src/a.ts"]);
    expect(contentReads).toBe(2);
  });

  it("invalidates a cached record when its current path becomes a hard link", async () => {
    const content = "needle\n";
    const base = memFs(MEM_ROOT, { "src/a.ts": content });
    let contentReads = 0;
    const fs: WorkspaceFs = {
      ...base,
      stat: (absolutePath) => {
        const stat = base.stat(absolutePath);
        return stat.isFile ? { ...stat, hardLinkCount: 2, mtimeMs: 1 } : stat;
      },
      readFileUtf8: (absolutePath) => {
        contentReads += 1;
        return base.readFileUtf8(absolutePath);
      },
      readFileBytes: async (): Promise<Uint8Array> => {
        contentReads += 1;
        return await Promise.resolve(new Uint8Array());
      },
    };
    const stalePaths: string[] = [];
    const atoms: EvidenceAtom[] = [];
    const candidates: CandidateFile[] = [];

    await scanFile(
      cachedRunner(fs, cachedIndexEntry(content), stalePaths),
      discoveredFile("src/a.ts", content.length),
      freshState(),
      atoms,
      candidates,
    );

    expect(atoms).toHaveLength(0);
    expect(candidates.map(({ scopePath, omitted }) => ({ scopePath, omitted }))).toEqual([
      { scopePath: "src/a.ts", omitted: "ignored" },
    ]);
    expect(stalePaths).toEqual(["src/a.ts"]);
    expect(contentReads).toBe(0);
  });

  it("invalidates and rejects a cached record whose real path escapes the workspace", async () => {
    const content = "needle\n";
    const base = memFs(MEM_ROOT, { "src/a.ts": content });
    let contentReads = 0;
    const fs: WorkspaceFs = {
      ...base,
      realPath: (absolutePath) =>
        absolutePath === `${MEM_ROOT}/src/a.ts` ? "/outside/a.ts" : base.realPath(absolutePath),
      readFileUtf8: (absolutePath) => {
        contentReads += 1;
        return base.readFileUtf8(absolutePath);
      },
      readFileBytes: async (): Promise<Uint8Array> => {
        contentReads += 1;
        return await Promise.resolve(new Uint8Array());
      },
    };
    const stalePaths: string[] = [];

    await expect(
      scanFile(
        cachedRunner(fs, cachedIndexEntry(content), stalePaths),
        discoveredFile("src/a.ts", content.length),
        freshState(),
        [],
        [],
      ),
    ).rejects.toBeInstanceOf(PathEscapeError);

    expect(stalePaths).toEqual(["src/a.ts"]);
    expect(contentReads).toBe(0);
  });

  it("invalidates matching cached metadata beneath a denied real workspace root", async () => {
    const content = "needle\n";
    const scopePath = "src/a.ts";
    const realRoot = "/private/.git/retargeted-root";
    const realPath = `${realRoot}/${scopePath}`;
    const base = memFs(MEM_ROOT, { [scopePath]: content });
    const currentStat = base.stat(`${MEM_ROOT}/${scopePath}`);
    const metadata = workspaceIndexFileMetadata(scopePath, currentStat);
    let contentReads = 0;
    const fs: WorkspaceFs = {
      ...base,
      realPath: (absolutePath): string => {
        if (absolutePath === MEM_ROOT) return realRoot;
        if (absolutePath === `${MEM_ROOT}/${scopePath}` || absolutePath === realPath)
          return realPath;
        return base.realPath(absolutePath);
      },
      stat: (absolutePath) => (absolutePath === realPath ? currentStat : base.stat(absolutePath)),
      readFileUtf8: (): string => {
        contentReads += 1;
        return content;
      },
      readFileBytes: (): Promise<Uint8Array> => {
        contentReads += 1;
        return Promise.resolve(new TextEncoder().encode(content));
      },
    };
    const entry: PreparedWorkspaceIndexEntry = {
      scopePath,
      absolutePath: realPath,
      file: discoveredFile(scopePath, content.length),
      ...(metadata.mtimeMs === undefined ? {} : { mtimeMs: metadata.mtimeMs }),
      ...(metadata.fileIdentityHash === undefined
        ? {}
        : { fileIdentityHash: metadata.fileIdentityHash }),
      ...(metadata.mtimeNs === undefined ? {} : { mtimeNs: metadata.mtimeNs }),
      ...(metadata.ctimeNs === undefined ? {} : { ctimeNs: metadata.ctimeNs }),
      ...(metadata.hardLinkCount === undefined ? {} : { hardLinkCount: metadata.hardLinkCount }),
      record: {
        ...metadata,
        kind: "text",
        lexical: buildWorkspaceIndexLexicalRecord(content),
      },
      stale: false,
    };
    const stalePaths: string[] = [];

    await expect(
      scanFile(
        cachedRunner(fs, entry, stalePaths),
        discoveredFile(scopePath, content.length),
        freshState(),
        [],
        [],
      ),
    ).rejects.toBeInstanceOf(PathDeniedError);

    expect(stalePaths).toEqual([scopePath]);
    expect(contentReads).toBe(0);
  });
});

describe("scanFile – live candidate retargeting", () => {
  it.each([
    { retargetedPath: "/outside/a.ts", errorType: PathEscapeError },
    { retargetedPath: `${MEM_ROOT}/.env`, errorType: PathDeniedError },
  ])(
    "rethrows a candidate retargeted to $retargetedPath instead of masking the denial",
    async ({ retargetedPath, errorType }) => {
      const content = "needle\n";
      const base = memFs(MEM_ROOT, { "src/a.ts": content });
      let candidateRealPathCalls = 0;
      let contentReads = 0;
      const fs: WorkspaceFs = {
        ...base,
        realPath: (absolutePath): string => {
          if (absolutePath !== `${MEM_ROOT}/src/a.ts`) return base.realPath(absolutePath);
          candidateRealPathCalls += 1;
          return candidateRealPathCalls === 1 ? absolutePath : retargetedPath;
        },
        readFileBytes: async (absolutePath, maxBytes, hardLinkPolicy): Promise<Uint8Array> => {
          contentReads += 1;
          return await (base.readFileBytes?.(absolutePath, maxBytes, hardLinkPolicy) ??
            Promise.resolve(new Uint8Array()));
        },
      };
      const candidates: CandidateFile[] = [];

      await expect(
        scanFile(
          buildRunner(fs),
          discoveredFile("src/a.ts", content.length),
          freshState(),
          [],
          candidates,
        ),
      ).rejects.toBeInstanceOf(errorType);
      expect(candidates).toEqual([]);
      expect(contentReads).toBe(0);
    },
  );
});

describe("scanFile – stable persistence metadata", () => {
  it("does not bind descriptor bytes to replacement metadata", async () => {
    const files = { "src/a.ts": "needle\n" };
    const base = memFs(MEM_ROOT, files);
    const baseReadFileBytes = base.readFileBytes;
    if (baseReadFileBytes === undefined) throw new Error("memFs always provides readFileBytes");
    let version = 1;
    let scheduleReplacement = false;
    let replacementScheduled = false;
    const fs: WorkspaceFs = {
      ...base,
      readFileBytes: async (absolutePath, maxBytes, hardLinkPolicy): Promise<Uint8Array> => {
        const bytes = await baseReadFileBytes(absolutePath, maxBytes, hardLinkPolicy);
        if (maxBytes === limits().maxBytesPerFileScanned) scheduleReplacement = true;
        return bytes;
      },
      stat: (absolutePath) => {
        const stat = base.stat(absolutePath);
        const snapshot = stat.isFile
          ? {
              ...stat,
              fileIdentity: `1:${String(version)}`,
              mtimeMs: version,
              ctimeMs: version,
              mtimeNs: `${String(version)}000000`,
              ctimeNs: `${String(version)}000000`,
            }
          : stat;
        if (scheduleReplacement && !replacementScheduled && stat.isFile) {
          replacementScheduled = true;
          queueMicrotask(() => {
            files["src/a.ts"] = "actual\n";
            version = 2;
          });
        }
        return snapshot;
      },
    };
    const records: WorkspaceIndexRecord[] = [];
    const runner: SearchTextRunner = {
      ...buildRunner(fs),
      workspaceIndex: {
        entries: new Map(),
        onRecord: (record) => records.push(record),
        onStale: () => undefined,
      },
    };

    await scanFile(runner, discoveredFile("src/a.ts", 7), freshState(), [], []);

    expect(version).toBe(2);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "text", scopePath: "src/a.ts", mtimeMs: 1 });
  });

  it("does not bind UTF-8 fallback text to replacement metadata", async () => {
    const files = { "src/a.ts": "needle\n" };
    const base = memFs(MEM_ROOT, files);
    const { readFileBytes: removedReadFileBytes, ...baseWithoutBytes } = base;
    if (removedReadFileBytes === undefined) throw new Error("memFs always provides readFileBytes");
    let version = 1;
    let utf8Reads = 0;
    let scheduleReplacement = false;
    let replacementScheduled = false;
    const fs: WorkspaceFs = {
      ...baseWithoutBytes,
      readFileUtf8: (absolutePath) => {
        const text = base.readFileUtf8(absolutePath);
        utf8Reads += 1;
        if (utf8Reads === 2) scheduleReplacement = true;
        return text;
      },
      stat: (absolutePath) => {
        const stat = base.stat(absolutePath);
        const snapshot = stat.isFile
          ? {
              ...stat,
              fileIdentity: `1:${String(version)}`,
              mtimeMs: version,
              ctimeMs: version,
              mtimeNs: `${String(version)}000000`,
              ctimeNs: `${String(version)}000000`,
            }
          : stat;
        if (scheduleReplacement && !replacementScheduled && stat.isFile) {
          replacementScheduled = true;
          queueMicrotask(() => {
            files["src/a.ts"] = "actual\n";
            version = 2;
          });
        }
        return snapshot;
      },
    };
    const records: WorkspaceIndexRecord[] = [];
    const runner: SearchTextRunner = {
      ...buildRunner(fs),
      workspaceIndex: {
        entries: new Map(),
        onRecord: (record) => records.push(record),
        onStale: () => undefined,
      },
    };

    await scanFile(runner, discoveredFile("src/a.ts", 7), freshState(), [], []);

    expect(version).toBe(2);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "text", scopePath: "src/a.ts", mtimeMs: 1 });
  });
});

// ─── hitEmissionLimit – AbortSignal during emission (lines 316-317) ─────────

describe("hitEmissionLimit – AbortSignal fires during emission loop", () => {
  it("stops emitting atoms and marks truncated when signal is aborted during full byte read", async () => {
    // The controller is not aborted at scanFile entry (first guard at line 447 passes).
    // It aborts inside the full-file raw-byte read, which executes after the binary probe and
    // after the second isRunnerAborted check. After readForScan returns the text,
    // scanLines/emitBestLines runs and the first hitEmissionLimit call sees the aborted signal,
    // so truncated=true and emission stops.
    const controller = new AbortController();
    const manyLines = Array.from({ length: 10 }, (_, i) => `needle match${i.toString()}`).join(
      "\n",
    );
    const base = memFs(MEM_ROOT, { "src/a.ts": manyLines + "\n" });
    const baseReadFileBytes = base.readFileBytes;
    if (baseReadFileBytes === undefined) throw new Error("memFs always provides readFileBytes");
    let byteReads = 0;
    const interceptedFs: WorkspaceFs = {
      ...base,
      readFileBytes: async (abs, max, hardLinkPolicy): Promise<Uint8Array> => {
        byteReads += 1;
        const result = await baseReadFileBytes(abs, max, hardLinkPolicy);
        if (byteReads === 2) {
          controller.abort();
        }
        return result;
      },
    };
    const runner = buildRunner(interceptedFs, {
      signal: controller.signal,
      limits: { ...limits(), maxMatchesReturned: 200 },
    });
    const state = freshState();
    const atoms: EvidenceAtom[] = [];
    const candidates: CandidateFile[] = [];

    await scanFile(runner, discoveredFile("src/a.ts", manyLines.length), state, atoms, candidates);

    expect(state.truncated).toBe(true);
    // No atoms emitted because hitEmissionLimit fires on the very first loop iteration.
    expect(atoms).toHaveLength(0);
  });
});

// ─── scanFile – filePolicyOmission: denied via real path ─────────────────────

describe("scanFile – filePolicyOmission denied via resolved real path", () => {
  it("emits an ignored candidate when realPath maps to a denied directory", async () => {
    const fs = memFs(MEM_ROOT, { "src/safe.ts": "needle\n" });
    // Return a node_modules path from realPath so isDenied(realRel) fires.
    const trappedFs: WorkspaceFs = {
      ...fs,
      realPath: (abs: string): string =>
        abs.replace(`${MEM_ROOT}/src/safe.ts`, `${MEM_ROOT}/node_modules/evil.ts`),
    };
    const runner = buildRunner(trappedFs);
    const state = freshState();
    const atoms: EvidenceAtom[] = [];
    const candidates: CandidateFile[] = [];

    await scanFile(runner, discoveredFile("src/safe.ts", 7), state, atoms, candidates);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.omitted).toBe("ignored");
    expect(atoms).toHaveLength(0);
  });
});

// ─── isIoError ───────────────────────────────────────────────────────────────

describe("isIoError", () => {
  it("returns true for an Error with a string code property", () => {
    expect(isIoError(makeErrnoError("EACCES"))).toBe(true);
  });

  it("returns false for a TypeError (no code property)", () => {
    expect(isIoError(new TypeError("not an IO error"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isIoError(null)).toBe(false);
  });

  it("returns false for a plain string", () => {
    expect(isIoError("ENOENT")).toBe(false);
  });

  it("returns false when code property exists but is not a string", () => {
    expect(isIoError({ code: 42 })).toBe(false);
  });

  it("returns false for path trust denials, including code-equivalent errors", () => {
    expect(isIoError(new PathEscapeError("escape", "../outside"))).toBe(false);
    expect(isIoError(new PathDeniedError("denied", ".env"))).toBe(false);
    expect(isIoError({ code: WORKSPACE_CODES.PATH_ESCAPE })).toBe(false);
    expect(isIoError({ code: WORKSPACE_CODES.PATH_DENIED })).toBe(false);
  });
});

// ─── hitLimit – matchesReturned ceiling ──────────────────────────────────────

describe("hitLimit – matchesReturned ceiling", () => {
  it("returns true and marks truncated when matchesReturned equals maxMatchesReturned", () => {
    const runner = buildRunner(memFs(MEM_ROOT, {}), {
      limits: { ...limits(), maxMatchesReturned: 3 },
    });
    const state: RunState = { filesScanned: 0, matchesReturned: 3, truncated: false };

    const result = hitLimit(runner, state);

    expect(result).toBe(true);
    expect(state.truncated).toBe(true);
  });

  it("returns false when matchesReturned is below maxMatchesReturned", () => {
    const runner = buildRunner(memFs(MEM_ROOT, {}), {
      limits: { ...limits(), maxMatchesReturned: 3 },
    });
    const state: RunState = { filesScanned: 0, matchesReturned: 2, truncated: false };

    expect(hitLimit(runner, state)).toBe(false);
  });
});

// ─── hitLimit – elapsed timeout branch ───────────────────────────────────────

describe("hitLimit – elapsed timeout", () => {
  it("returns true and marks truncated when elapsed time exceeds elapsedMsMax", () => {
    let tick = 0;
    const nowMs = (): number => {
      tick += 1;
      return tick * 1000;
    };
    const runner = buildRunner(memFs(MEM_ROOT, {}), {
      nowMs,
      limits: { ...limits(), elapsedMsMax: 0 },
    });
    const state = freshState();

    const result = hitLimit(runner, state);

    expect(result).toBe(true);
    expect(state.truncated).toBe(true);
  });
});

// ─── buildCandidate helper ────────────────────────────────────────────────────

describe("buildCandidate", () => {
  it("constructs a CandidateFile with the given omission reason", () => {
    const candidate = buildCandidate("src/a.ts", "binary");
    expect(candidate.scopePath).toBe("src/a.ts");
    expect(candidate.omitted).toBe("binary");
    expect(candidate.score).toBe(0);
    expect(candidate.signals).toEqual([]);
  });

  it("constructs a CandidateFile with undefined omission when file is not omitted", () => {
    const candidate = buildCandidate("src/a.ts", undefined);
    expect(candidate.omitted).toBeUndefined();
  });
});
