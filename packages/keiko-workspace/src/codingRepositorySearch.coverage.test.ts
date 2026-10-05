import { afterEach, describe, expect, it, vi } from "vitest";
import { CODING_REPOSITORY_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/coding-repository-search";
import { memFs } from "./_memfs.js";
import { executeCodingRepositoryRequest } from "./codingRepositorySearch.js";
import type { WorkspaceDirEntry, WorkspaceFs } from "./fs.js";
import type { WorkspaceInfo } from "./types.js";

const ROOT = "/coding-coverage";
afterEach(() => {
  vi.useRealTimers();
});
const workspace: WorkspaceInfo = {
  root: ROOT,
  selectedRoot: ROOT,
  name: "coding-coverage",
  version: "1",
  testFramework: "unknown",
  sourceDirs: [],
  testDirs: [],
  languages: [],
  ignoreLines: [],
};
const request = {
  kind: "search" as const,
  mode: "literal" as const,
  query: "CodingCoverageProbe",
  caseSensitive: true,
  includeGlobs: [],
  excludeGlobs: [],
  maxResults: 50,
};

function unavailableFs(code: string, matchingFile: boolean): WorkspaceFs {
  const base = memFs(ROOT, {
    "unreadable.html": "CodingCoverageProbe unreadable",
    ...(matchingFile ? { "valid.html": "CodingCoverageProbe valid" } : {}),
  });
  const read = base.readFileBytes;
  if (read === undefined) throw new Error("fixture bounded reader missing");
  return {
    ...base,
    readFileBytes: (path, maximum, hardLinkPolicy, expected): Promise<Uint8Array> => {
      if (path.endsWith("/unreadable.html"))
        return Promise.reject(Object.assign(new Error("fixture read unavailable"), { code }));
      return read(path, maximum, hardLinkPolicy, expected);
    },
  };
}

describe("coding repository search completeness", () => {
  it("settles a blocked projection at its soft timer without waiting for the physical read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let release!: (bytes: Uint8Array) => void;
    const blocked = new Promise<Uint8Array>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const base = memFs(ROOT, {
      "a.html": "CodingCoverageProbe first",
      "b.html": "CodingCoverageProbe second",
    });
    const read = base.readFileBytes;
    if (read === undefined) throw new Error("fixture bounded reader missing");
    let bReads = 0;
    const pending = executeCodingRepositoryRequest(workspace, request, {
      fs: {
        ...base,
        readFileBytes: (path, ...args): Promise<Uint8Array> => {
          if (path.endsWith("/b.html") && ++bReads === 2) {
            entered();
            return blocked;
          }
          return read(path, ...args);
        },
      },
      deadlineAtMs: 100,
      scanDeadlineAtMs: 50,
      projectionDeadlineAtMs: 75,
    });
    try {
      await started;
      await vi.advanceTimersByTimeAsync(75);
      expect(await pending).toMatchObject({
        ok: true,
        hits: [{ path: "a.html" }],
        truncationReasons: ["time-limit"],
      });
    } finally {
      release(new TextEncoder().encode("CodingCoverageProbe second"));
      await pending;
    }
  });

  it("returns a validated early hit when the soft scan deadline precedes hard settlement", async () => {
    let now = 0;
    let byteReads = 0;
    const base = memFs(ROOT, {
      "early.html": "CodingCoverageProbe early",
      "late.html": "CodingCoverageProbe late",
    });
    const read = base.readFileBytes;
    if (read === undefined) throw new Error("fixture bounded reader missing");
    const result = await executeCodingRepositoryRequest(workspace, request, {
      fs: {
        ...base,
        iterateDirectory: async function* (path): AsyncGenerator<WorkspaceDirEntry> {
          const entries = base.readDir(path);
          for (const entry of entries) {
            yield entry;
            await new Promise<void>((resolve) => setImmediate(resolve));
            now = 60;
          }
        },
        readFileBytes: async (...args): Promise<Uint8Array> => {
          byteReads += 1;
          return read(...args);
        },
      },
      nowMs: () => now,
      deadlineAtMs: 100,
      scanDeadlineAtMs: 50,
      projectionDeadlineAtMs: 75,
    });
    expect(result).toMatchObject({
      ok: true,
      kind: "search",
      hits: [{ path: "early.html", snippet: "CodingCoverageProbe early" }],
      truncationReasons: ["time-limit"],
      diagnostics: { coverageIncomplete: true, coverageReasons: ["timeout"] },
    });
    expect(byteReads).toBeGreaterThanOrEqual(2);
  });

  it.each(["soft", "hard", "cancelled"] as const)(
    "settles interrupted projection according to the actual %s boundary",
    async (boundary) => {
      let now = 0;
      const controller = new AbortController();
      const reads = new Map<string, number>();
      const base = memFs(ROOT, {
        "a.html": "CodingCoverageProbe first",
        "b.html": "CodingCoverageProbe second",
      });
      const read = base.readFileBytes;
      if (read === undefined) throw new Error("fixture bounded reader missing");
      const pending = executeCodingRepositoryRequest(workspace, request, {
        fs: {
          ...base,
          readFileBytes: async (path, ...args): Promise<Uint8Array> => {
            const count = (reads.get(path) ?? 0) + 1;
            reads.set(path, count);
            if (path.endsWith("/b.html") && count === 2) {
              now = boundary === "hard" ? 100 : 80;
              if (boundary === "cancelled") controller.abort();
            }
            return read(path, ...args);
          },
        },
        nowMs: () => now,
        deadlineAtMs: 100,
        scanDeadlineAtMs: 50,
        projectionDeadlineAtMs: 75,
        signal: controller.signal,
      });
      if (boundary !== "soft") {
        await expect(pending).rejects.toMatchObject({
          reason: boundary === "hard" ? "timeout" : "cancelled",
        });
        return;
      }
      expect(await pending).toMatchObject({
        ok: true,
        kind: "search",
        hits: [{ path: "a.html", snippet: "CodingCoverageProbe first" }],
        truncationReasons: ["time-limit"],
      });
    },
  );

  it.each(["EACCES", "EIO", "ENOENT"])(
    "does not certify an empty search when eligible text cannot be read: %s",
    async (code) => {
      const result = await executeCodingRepositoryRequest(workspace, request, {
        fs: unavailableFs(code, false),
      });
      expect(result.ok).toBe(true);
      if (!result.ok || result.kind !== "search") throw new Error("search result unavailable");
      expect(result.hits).toEqual([]);
      expect(result.truncationReasons).toContain("io-error");
    },
  );

  it("retains a valid hit while disclosing the unreadable part of the same scope", async () => {
    const result = await executeCodingRepositoryRequest(workspace, request, {
      fs: unavailableFs("EACCES", true),
    });
    if (!result.ok || result.kind !== "search") throw new Error("search result unavailable");
    expect(result.hits.map((hit) => hit.path)).toEqual(["valid.html"]);
    expect(result.truncationReasons).toContain("io-error");
  });

  it("reports size eligibility independently of the bounded omitted-path sample", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`a-${String(index)}.png`, "image"]),
    );
    const base = memFs(ROOT, { ...files, "z-large.ts": "CodingCoverageProbe" });
    const fs: WorkspaceFs = {
      ...base,
      stat: (path) => ({
        ...base.stat(path),
        ...(path.endsWith("/z-large.ts") ? { size: CODING_REPOSITORY_LIMITS.fileBytes + 1 } : {}),
      }),
    };
    const result = await executeCodingRepositoryRequest(workspace, request, { fs });
    if (!result.ok || result.kind !== "search") throw new Error("search result unavailable");
    expect(result.hits).toEqual([]);
    expect(result.metrics.skippedFiles).toBe(61);
    expect(result.truncationReasons).toContain("file-too-large");
  });
});
