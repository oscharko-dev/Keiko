import { describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import {
  CODING_REPOSITORY_LIMITS,
  type CodingRepositorySearchMode,
  type CodingRepositorySearchRequest,
} from "@oscharko-dev/keiko-contracts/runtime/coding-repository-search";
import { memFs } from "./_memfs.js";
import type { WorkspaceDirEntry, WorkspaceFs } from "./fs.js";
import { executeCodingRepositoryRequest } from "./codingRepositorySearch.js";

function workspace(): WorkspaceInfo {
  return {
    root: "/ws",
    selectedRoot: "/ws",
    name: "bounded",
    version: "1",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

function request(
  query: string,
  mode: CodingRepositorySearchMode = "literal",
): CodingRepositorySearchRequest {
  return {
    kind: "search",
    query,
    mode,
    caseSensitive: false,
    includeGlobs: [],
    excludeGlobs: [],
    maxResults: 50,
  };
}

// Private-key-shaped fixture assembled at runtime: the redaction lane must strip this exact shape,
// but the source tree must not carry a literal that secret scanners flag as a credential.
const keyMarker = (edge: string): string => `-----${edge} PRIVATE KEY-----`;
const secret = [
  keyMarker("BEGIN"),
  "AAAAB3NzaC1yc2EAAAADAQABAAABgQ",
  "CqGKukO1De7zhZj6H0qtjTkVxwTCpv",
  keyMarker("END"),
];
const source = [
  ...secret,
  "export function parseConfig(): string {",
  '  return "useful multi word value";',
  "}",
  "",
].join("\n");

function broadInventoryFs(): WorkspaceFs {
  const base = memFs("/ws", { "seed.ts": "marker" });
  const file = base.stat("/ws/seed.ts");
  const directory = base.stat("/ws");
  return {
    ...base,
    exists: (): boolean => false,
    stat: (path) =>
      path.endsWith(".ts")
        ? { ...file, size: CODING_REPOSITORY_LIMITS.fileBytes + 1, fileIdentity: path }
        : directory,
    readDir: (path, cap): readonly WorkspaceDirEntry[] => {
      const isDirectory = path === "/ws";
      const count = isDirectory ? 6 : path.endsWith("/5") ? 1 : 10_000;
      return Array.from({ length: Math.min(count, cap ?? count) }, (_, index) => ({
        name: isDirectory ? String(index) : `${String(index).padStart(5, "0")}.ts`,
        isDirectory,
        isFile: !isDirectory,
        isSymbolicLink: false,
      }));
    },
  };
}

describe("workspace-owned coding repository handler", () => {
  it.each([
    ["literal", "useful multi word value"],
    ["regex", "parseConfig"],
    ["symbol", "parseConfig"],
    ["lexical", "where parse config"],
  ] as const)("returns actual results for %s", async (mode, query) => {
    const result = await executeCodingRepositoryRequest(workspace(), request(query, mode), {
      fs: memFs("/ws", { "src/example.ts": source }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "search") throw new Error("search result missing");
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]?.path).toBe("src/example.ts");
    expect(JSON.stringify(result)).not.toContain(secret[1]);
  });
  it("keeps raw source coordinates after multiline-secret redaction", async () => {
    const result = await executeCodingRepositoryRequest(workspace(), request("parseConfig"), {
      fs: memFs("/ws", { "src/example.ts": source }),
    });
    expect(result.ok && result.kind === "search" && result.hits[0]?.startLine).toBe(5);
    expect(result.ok && result.kind === "search" && result.hits[0]?.snippet).toContain(
      "parseConfig",
    );
  });
  it("accepts the full literal query ceiling without expanding it into regex", async () => {
    const literal = "( ".repeat(100);
    const result = await executeCodingRepositoryRequest(workspace(), request(literal), {
      fs: memFs("/ws", { "src/punctuation.ts": literal }),
    });
    expect(result.ok && result.kind === "search" && result.hits[0]?.snippet).toBe(literal);
  });
  it("redacts a read starting inside a multiline secret using full-source context", async () => {
    const result = await executeCodingRepositoryRequest(
      workspace(),
      { kind: "read", path: "src/example.ts", startLine: 2, endLine: 3, maxBytes: 512 },
      { fs: memFs("/ws", { "src/example.ts": source }) },
    );
    expect(result.ok && result.kind === "read" && result.excerpt).toMatchObject({
      startLine: 2,
      endLine: 3,
      redacted: true,
      snippet: "[REDACTED]",
    });
  });
  it("clamps a redacted read at a UTF-8 boundary using the shared byte-clamp reader", async () => {
    const multibyteSource = [...secret, "界界"].join("\n");
    const result = await executeCodingRepositoryRequest(
      workspace(),
      { kind: "read", path: "src/example.ts", startLine: 4, endLine: 5, maxBytes: 15 },
      { fs: memFs("/ws", { "src/example.ts": multibyteSource }) },
    );
    expect(result.ok && result.kind === "read" && result.excerpt).toMatchObject({
      startLine: 4,
      endLine: 5,
      redacted: true,
      snippetTruncated: true,
      snippet: "[REDACTED]\n界",
    });
    expect(result.ok && result.kind === "read" && result.excerpt.snippet).not.toContain("\uFFFD");
  });
  it("applies include/exclude globs through existing candidate ranking", async () => {
    const result = await executeCodingRepositoryRequest(
      workspace(),
      { ...request("marker"), includeGlobs: ["src/**"], excludeGlobs: ["**/ignored.ts"] },
      {
        fs: memFs("/ws", {
          "src/kept.ts": "marker",
          "src/ignored.ts": "marker",
          "tests/example.ts": "marker",
        }),
      },
    );
    expect(result.ok && result.kind === "search" && result.hits.map((hit) => hit.path)).toEqual([
      "src/kept.ts",
    ]);
  });
  it("omits oversized sources before scanning and reports the bound", async () => {
    const result = await executeCodingRepositoryRequest(workspace(), request("marker"), {
      fs: memFs("/ws", { "src/large.ts": "marker".repeat(100_000), "src/small.ts": "marker" }),
    });
    expect(result.ok && result.kind === "search" && result.hits.map((hit) => hit.path)).toEqual([
      "src/small.ts",
    ]);
    expect(result.ok && result.truncationReasons).toContain("file-too-large");
  });
  it("preserves the result cap alongside an oversized-file omission", async () => {
    const result = await executeCodingRepositoryRequest(
      workspace(),
      { ...request("marker"), maxResults: 1 },
      {
        fs: memFs("/ws", {
          "src/large.ts": "marker".repeat(100_000),
          "src/a.ts": "marker",
          "src/b.ts": "marker",
        }),
      },
    );
    expect(result.ok && result.truncationReasons).toContain("file-too-large");
    expect(result.ok && result.truncationReasons).toContain("result-limit");
  });
  it("captures validated request data before the first asynchronous boundary", async () => {
    const mutable = { ...request("marker"), includeGlobs: ["src/approved.ts"], maxResults: 1 };
    const pending = executeCodingRepositoryRequest(workspace(), mutable, {
      fs: memFs("/ws", { "src/approved.ts": "marker", "src/other.ts": "marker" }),
    });
    mutable.includeGlobs[0] = "src/other.ts";
    mutable.maxResults = 50;
    mutable.query = "other";
    const result = await pending;
    expect(result.ok && result.kind === "search" && result.hits.map((hit) => hit.path)).toEqual([
      "src/approved.ts",
    ]);
  });
  it("returns at most 50 hits and 512 UTF-8 snippet bytes", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 75 }, (_, index) => [
        `src/${String(index)}.ts`,
        `marker ${"界".repeat(400)}`,
      ]),
    );
    const result = await executeCodingRepositoryRequest(workspace(), request("marker"), {
      fs: memFs("/ws", files),
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "search") throw new Error("search result missing");
    expect(result.hits).toHaveLength(50);
    expect(
      result.hits.every(
        (hit) => Buffer.byteLength(hit.snippet) <= CODING_REPOSITORY_LIMITS.snippetBytes,
      ),
    ).toBe(true);
    expect(result.truncationReasons).toContain("result-limit");
  });
  it("caps the complete serialized read result, including JSON escaping", async () => {
    const result = await executeCodingRepositoryRequest(
      workspace(),
      { kind: "read", path: "src/quotes.ts", startLine: 1, endLine: 1, maxBytes: 65_536 },
      { fs: memFs("/ws", { "src/quotes.ts": '"'.repeat(65_536) }) },
    );
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(65_536);
    expect(result.ok && result.truncationReasons).toContain("output-limit");
  });
  it("caps serialized search metadata and snippets together", async () => {
    const directory = Array.from({ length: 6 }, () => "a".repeat(200)).join("/");
    const files = Object.fromEntries(
      Array.from({ length: 50 }, (_, index) => [
        `${directory}/${String(index)}.ts`,
        `marker ${"x".repeat(500)}`,
      ]),
    );
    const result = await executeCodingRepositoryRequest(workspace(), request("marker"), {
      fs: memFs("/ws", files),
    });
    expect(result.ok && result.kind === "search" && result.hits.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(65_536);
    expect(result.ok && result.truncationReasons).toContain("output-limit");
  });
  it("cooperatively observes an abort during the existing inventory walk", async () => {
    const controller = new AbortController();
    const files = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`src/${String(index)}.ts`, "marker"]),
    );
    setImmediate(() => {
      controller.abort();
    });
    await expect(
      executeCodingRepositoryRequest(workspace(), request("marker"), {
        fs: memFs("/ws", files),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ reason: "cancelled" });
  });
  it("honors one deterministic parent deadline for inventory and scan", async () => {
    let now = 0;
    await expect(
      executeCodingRepositoryRequest(workspace(), request("marker"), {
        fs: memFs("/ws", { "src/example.ts": "marker" }),
        nowMs: () => {
          now += 1000;
          return now;
        },
        deadlineAtMs: 2500,
      }),
    ).rejects.toMatchObject({ reason: "timeout" });
  });
});

describe("bounded candidate inventory and cooperative scan", () => {
  it("never scans beyond 2,000 files", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 2_001 }, (_, index) => [`src/${String(index)}.ts`, "marker"]),
    );
    const result = await executeCodingRepositoryRequest(workspace(), request("marker"), {
      fs: memFs("/ws", files),
      nowMs: () => 0,
    });
    expect(result.ok && result.metrics.filesScanned).toBe(2_000);
    expect(result.ok && result.truncationReasons).toContain("file-limit");
  });
  it("never inventories beyond 50,000 candidates", async () => {
    const result = await executeCodingRepositoryRequest(workspace(), request("marker"), {
      fs: broadInventoryFs(),
      nowMs: () => 0,
    });
    expect(result.ok && result.metrics.candidatesDiscovered).toBe(50_000);
    expect(result.ok && result.truncationReasons).toContain("inventory-limit");
  });
  it("observes cancellation by the thirty-second scan candidate", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`src/${String(index)}.ts`, "marker"]),
    );
    const fs = memFs("/ws", files);
    const read = fs.readFileBytes;
    if (read === undefined) throw new Error("bounded read fixture unavailable");
    const seen = new Set<string>();
    const controller = new AbortController();
    const controlled: WorkspaceFs = {
      ...fs,
      readFileBytes: (...args): Promise<Uint8Array> => {
        if (seen.size === 0)
          setImmediate(() => {
            controller.abort();
          });
        seen.add(args[0]);
        return read(...args);
      },
    };
    await expect(
      executeCodingRepositoryRequest(workspace(), request("marker"), {
        fs: controlled,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(seen.size).toBeGreaterThan(0);
    expect(seen.size).toBeLessThanOrEqual(32);
  });
  it("rejects binary ranged reads", async () => {
    await expect(
      executeCodingRepositoryRequest(
        workspace(),
        { kind: "read", path: "src/binary.ts", startLine: 1, endLine: 1, maxBytes: 512 },
        { fs: memFs("/ws", { "src/binary.ts": "\u0000\u0001\u0002binary\u0000body" }) },
      ),
    ).rejects.toMatchObject({ reason: "file-unreadable" });
  });
  it.each([
    ["large", "marker".repeat(100_000), 1, "file-too-large"],
    ["range", "marker", 2, "invalid-request"],
  ] as const)(
    "rejects %s reads through the owning failure taxonomy",
    async (_, text, startLine, reason) => {
      await expect(
        executeCodingRepositoryRequest(
          workspace(),
          { kind: "read", path: "src/example.ts", startLine, endLine: startLine, maxBytes: 512 },
          { fs: memFs("/ws", { "src/example.ts": text }) },
        ),
      ).rejects.toMatchObject({ reason });
    },
  );
  it("refuses an unavailable bounded backend and invalid typed requests", async () => {
    const { readFileBytes, ...legacy } = memFs("/ws", {});
    expect(readFileBytes).toBeTypeOf("function");
    await expect(
      executeCodingRepositoryRequest(workspace(), request("marker"), { fs: legacy }),
    ).rejects.toMatchObject({ reason: "backend-unavailable" });
    await expect(
      executeCodingRepositoryRequest(workspace(), { ...request("marker"), maxResults: 51 }),
    ).rejects.toMatchObject({ reason: "invalid-request" });
  });
});
