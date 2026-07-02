// Branch-coverage tests for the editor-epic branches in repoSearchScan.ts that remained
// uncovered after the feat/keiko-editor → release/0.2.0 merge. Each test asserts observable
// side-effects so that a single-line mutation in the covered branch breaks the test.

import { describe, expect, it } from "vitest";
import type { CandidateFile, EvidenceAtom } from "@oscharko-dev/keiko-contracts/connected-context";
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
  };
}

function discoveredFile(relativePath: string, sizeBytes = 10): DiscoveredFile {
  return { relativePath, sizeBytes };
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
      readFileBytes: async (abs, max): Promise<Uint8Array> => {
        controller.abort();
        return await baseReadFileBytes(abs, max);
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
      readFileBytes: async (abs, max): Promise<Uint8Array> => {
        byteReads += 1;
        const result = await baseReadFileBytes(abs, max);
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
