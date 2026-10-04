import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { executeCodingRepositoryRequest } from "./codingRepositorySearch.js";
import { detectWorkspaceAt } from "./detect.js";
import { createWorkspaceIndex } from "./workspaceIndex.js";
import { nodeWorkspaceFs, type WorkspaceDirEntry } from "./fs.js";
import {
  DEFAULT_SEARCH_LIMITS,
  findFiles,
  readExcerpt,
  searchText,
  type SearchScope,
} from "./repoSearch.js";

let root: string;

function put(path: string, text: string | Uint8Array): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, text);
}

function scope(): SearchScope {
  return {
    workspace: detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false }),
    scopeId: "ordinary-folder",
    relativePaths: [],
  };
}

function query(text: string): RetrievalQuery {
  return { kind: "exact-symbol", text, maxResults: 50, caseSensitive: false, emittedAtMs: 0 };
}

function exactSizeText(bytes: number): string {
  const tail = "\nmanualNeedle\n";
  const row = "ordinary handbook text\n";
  const prefixBytes = bytes - Buffer.byteLength(tail);
  const rows = Math.floor(prefixBytes / row.length);
  return `${row.repeat(rows)}${"x".repeat(prefixBytes - rows * row.length)}${tail}`;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-plain-handbook-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("recursive text search in ordinary folders", () => {
  it.each([["x".repeat(4097)], ["x".repeat(2048), "y".repeat(2048)]])(
    "rejects oversized trusted literal targets before accessing the filesystem port",
    async (...terms) => {
      const selected = scope();
      let filesystemAccesses = 0;
      const fs = new Proxy(nodeWorkspaceFs, {
        get: (): never => {
          filesystemAccesses += 1;
          throw new Error("filesystem accessed before query admission");
        },
      });
      await expect(
        searchText(selected, { ...query("target"), kind: "natural-language" }, undefined, {
          fs,
          queryInterpretation: { kind: "literal", terms },
        }),
      ).rejects.toThrow("literal targets too long");
      expect(filesystemAccesses).toBe(0);
    },
  );
  it("closes an open directory iterator when traversal is cancelled", async () => {
    put("chapter.html", "<p>manualNeedle</p>");
    const controller = new AbortController();
    const iterator = nodeWorkspaceFs.iterateDirectory;
    if (iterator === undefined) throw new Error("missing production directory iterator");
    let activeDirectories = 0;
    const fs = {
      ...nodeWorkspaceFs,
      iterateDirectory: async function* (path: string): AsyncIterable<WorkspaceDirEntry> {
        activeDirectories += 1;
        try {
          for await (const entry of iterator(path)) {
            controller.abort();
            yield entry;
          }
        } finally {
          activeDirectories -= 1;
        }
      },
    };
    const result = await searchText(scope(), query("manualNeedle"), undefined, {
      fs,
      signal: controller.signal,
    });
    expect(activeDirectories).toBe(0);
    expect(result.coverage.incomplete).toBe(true);
    expect(result.coverage.reasons).toContain("aborted");
  });

  it("closes directory iterators and fails explicitly when traversal exhausts descriptors", async () => {
    put("d/d/d/d/target.html", "<p>manualNeedle</p>");
    let activeDirectories = 0;
    const iterator = nodeWorkspaceFs.iterateDirectory;
    if (iterator === undefined) throw new Error("missing production directory iterator");
    const fs = {
      ...nodeWorkspaceFs,
      iterateDirectory: async function* (path: string): AsyncIterable<WorkspaceDirEntry> {
        if (path.endsWith("/d/d/d")) {
          throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
        }
        activeDirectories += 1;
        try {
          yield* iterator(path);
        } finally {
          activeDirectories -= 1;
        }
      },
    };
    const selected = scope();
    await expect(
      searchText(selected, query("manualNeedle"), undefined, { fs }),
    ).rejects.toMatchObject({ code: "WORKSPACE_READ_FAILED" });
    expect(activeDirectories).toBe(0);
    const recovery = await searchText(selected, query("manualNeedle"));
    expect(recovery.atoms.map((atom) => atom.scopePath)).toEqual(["d/d/d/d/target.html"]);
    expect(recovery.coverage.incomplete).toBe(false);
  });

  it.each([
    "binaryNeedle\n" + "\x01".repeat(5_000),
    "binaryNeedle\n" + "ordinary text\n".repeat(400) + "\x01".repeat(10_000),
    Buffer.from("\uFEFFbinaryNeedle\n" + "\u0001".repeat(5_000)),
    Buffer.from("\uFEFFbinaryNeedle\n" + "\u0001".repeat(5_000), "utf16le"),
  ])("rejects control-heavy binary data consistently across search and reads", async (bytes) => {
    put("blob.data", bytes);
    const selected = scope();
    const result = await searchText(selected, query("binaryNeedle"));
    expect(result.atoms).toEqual([]);
    await expect(
      executeCodingRepositoryRequest(selected.workspace, {
        kind: "read",
        path: "blob.data",
        startLine: 1,
        endLine: 1,
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ reason: "file-unreadable" });
    await expect(
      readExcerpt(selected, { scopePath: "blob.data", startLine: 1, endLine: 1, maxBytes: 1024 }),
    ).rejects.toMatchObject({ reason: "binary" });
  });

  it.each(["utf8", "utf16le"] as const)(
    "rejects a %s BOM binary before serving an anchored excerpt",
    async (encoding) => {
      put("blob.data", Buffer.from("\uFEFFbinaryNeedle\n" + "\u0001".repeat(5_000), encoding));
      await expect(
        readExcerpt(scope(), {
          scopePath: "blob.data",
          startLine: 1,
          endLine: 1,
          maxBytes: 1024,
          anchors: ["binaryNeedle"],
        }),
      ).rejects.toMatchObject({ reason: "binary" });
    },
  );

  it("does not reuse fuzzy cached lexical matches for trusted literal targets", async () => {
    put("manual.html", "foo\nbar\n");
    const selected = scope();
    const workspaceIndex = createWorkspaceIndex();
    const limits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 32 };
    const warm = await searchText(selected, query("foo"), limits, { workspaceIndex });
    expect(warm.atoms).toHaveLength(1);
    const absent = "foo bar";
    const result = await searchText(
      selected,
      { ...query(absent), kind: "natural-language" },
      limits,
      {
        workspaceIndex,
        queryInterpretation: { kind: "literal", terms: [absent] },
      },
    );
    expect(result.atoms).toEqual([]);
    expect(result.coverage.incomplete).toBe(false);
  });

  it("returns lexical evidence for deeply nested sources outside inferred source directories", async () => {
    const path = `${Array.from({ length: 45 }, (_, index) => `depth-${String(index)}`).join("/")}/deep.ts`;
    put(path, "export const DepthProbe = 'hidden';\n");
    put("src/top.ts", "export const DepthProbe = 'visible';\n");
    const selected = scope();
    const result = await searchText(
      { ...selected, workspace: { ...selected.workspace, sourceDirs: ["src", "tests"] } },
      query("DepthProbe"),
    );
    expect(result.coverage.incomplete).toBe(false);
    expect(result.coverage.filesScanned).toBe(2);
    const atom = result.atoms.find((candidate) => candidate.scopePath === path);
    expect(atom?.provenance.kind).toBe("lexical-search");
    expect(atom?.lineRange).toEqual({ startLine: 1, endLine: 1 });
    expect(atom?.score).toBeGreaterThan(0);
  });

  it("counts overlapping and duplicate selected folders once", async () => {
    put("chapters/a.html", "<p>manualNeedle</p>");
    put("chapters/b.html", "<p>manualNeedle</p>");
    const selected = { ...scope(), relativePaths: ["chapters", "chapters", "chapters/a.html"] };
    const result = await searchText(selected, query("manualNeedle"));
    expect(result.coverage.filesScanned).toBe(2);
    expect(result.coverage.filesDiscovered).toBe(2);
    expect(result.atoms.map((atom) => atom.scopePath)).toEqual([
      "chapters/a.html",
      "chapters/b.html",
    ]);
  });

  it("does not drop a flat HTML directory beyond the former 10,000-entry cap", async () => {
    for (let index = 0; index < 10_001; index += 1) {
      put(`flat/page-${String(index).padStart(5, "0")}.html`, "<p>ordinary page</p>");
    }
    put("flat/zzzz-target.html", "<p>manualNeedle</p>");
    const selected = scope();
    const result = await searchText(selected, query("manualNeedle"));
    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["flat/zzzz-target.html"]);
    expect(result.coverage.filesScanned).toBe(10_002);
    expect(result.coverage.incomplete).toBe(false);
    expect(result.coverage.limits).toMatchObject({ maxFilesScanned: null, elapsedMsMax: null });
    const listing = await findFiles(selected, {
      ...query("**/zzzz-target.html"),
      kind: "file-pattern",
    });
    expect(listing.atoms.map((atom) => atom.scopePath)).toEqual(["flat/zzzz-target.html"]);
    expect(listing.coverage.filesScanned).toBe(10_002);
    expect(listing.coverage.incomplete).toBe(false);
  }, 30_000);

  it("finds the beginning, middle and end of a 3,201-page HTML handbook without Git", async () => {
    const targets = new Set([0, 1_600, 3_200]);
    for (let index = 0; index <= 3_200; index += 1) {
      const path = `chapters/page-${String(index).padStart(5, "0")}.html`;
      put(path, targets.has(index) ? "<p>manualNeedle procedure</p>\n" : "<p>ordinary page</p>\n");
    }
    expect(existsSync(join(root, ".git"))).toBe(false);
    const selected = scope();
    const chat = await searchText(selected, query("manualNeedle"));
    const coding = await executeCodingRepositoryRequest(selected.workspace, {
      kind: "search",
      query: "manualNeedle",
      mode: "literal",
      caseSensitive: false,
      maxResults: 50,
      includeGlobs: [],
      excludeGlobs: [],
    });
    const expected = [
      "chapters/page-00000.html",
      "chapters/page-01600.html",
      "chapters/page-03200.html",
    ];
    expect(chat.atoms.map((atom) => atom.scopePath).sort()).toEqual(expected);
    expect(chat.coverage.incomplete).toBe(false);
    expect(
      coding.ok && coding.kind === "search" && coding.hits.map((hit) => hit.path).sort(),
    ).toEqual(expected);
    expect(coding.ok && coding.truncationReasons).toEqual([]);
  }, 30_000);

  it("searches valid manual directories and unfamiliar text extensions without code-noise omissions", async () => {
    const paths = [
      "build/chapter.html",
      "dist/chapter.html",
      "generated/chapter.html",
      "out/chapter.html",
      "tmp/chapter.html",
      "nested/page.handbook",
    ];
    for (const path of paths) put(path, "manualNeedle content\n");
    const selected = scope();
    const result = await searchText(selected, query("manualNeedle"));
    expect(result.atoms.map((atom) => atom.scopePath).sort()).toEqual(paths.sort());
    expect(result.coverage.ignoredByDiscovery).toBe(0);
  });

  it("fully searches eligible files through the inclusive 2 MiB boundary", async () => {
    const paths = ["half-plus.html", "under.handbook", "exact.html"];
    for (const [index, bytes] of [524_289, 2_097_151, 2_097_152].entries()) {
      const path = paths[index];
      if (path === undefined) throw new Error("boundary fixture missing");
      put(path, exactSizeText(bytes));
    }
    const selected = scope();
    const chat = await searchText(selected, query("manualNeedle"));
    const coding = await executeCodingRepositoryRequest(selected.workspace, {
      kind: "search",
      query: "manualNeedle",
      mode: "literal",
      caseSensitive: false,
      maxResults: 50,
      includeGlobs: [],
      excludeGlobs: [],
    });
    expect(chat.atoms.map((atom) => atom.scopePath).sort()).toEqual(paths.sort());
    expect(chat.coverage.incomplete).toBe(false);
    expect(
      coding.ok && coding.kind === "search" && coding.hits.map((hit) => hit.path).sort(),
    ).toEqual(paths.sort());
  }, 30_000);

  it("decodes declared legacy HTML charsets for search and excerpts", async () => {
    put(
      "legacy.html",
      Buffer.from('<meta charset="windows-1252"><p>caf\u00e9 r\u00e9paration</p>\n', "latin1"),
    );
    put(
      "legacy-http.html",
      Buffer.from(
        '<meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1"><p>caf\u00e9</p>\n',
        "latin1",
      ),
    );
    const selected = scope();
    const found = await searchText(selected, query("café"));
    expect(found.atoms.map((atom) => atom.scopePath).sort()).toEqual([
      "legacy-http.html",
      "legacy.html",
    ]);
    const excerpt = await readExcerpt(selected, {
      scopePath: "legacy.html",
      startLine: 1,
      endLine: 1,
      maxBytes: 512,
    });
    expect(excerpt.content).toContain("café réparation");
  });

  it.each([
    '<META CONTENT="text/html; CHARSET=ISO-8859-1" HTTP-EQUIV="Content-Type">',
    '<meta charset="iso_8859-1">',
  ])(
    "decodes supported legacy HTML declaration variants through search and both reads: %s",
    async (header) => {
      put("legacy.html", Buffer.from(`${header}\n<p>Ölwechsel 750 Stunden</p>\n`, "latin1"));
      const selected = scope();
      const result = await searchText(selected, query("Ölwechsel"));
      expect(result.atoms).toHaveLength(1);
      expect(result.atoms[0]?.lineRange).toEqual({ startLine: 2, endLine: 2 });
      expect(result.coverage.incomplete).toBe(false);
      const read = { scopePath: "legacy.html", startLine: 2, endLine: 2, maxBytes: 512 };
      expect((await readExcerpt(selected, read)).content).toContain("Ölwechsel 750 Stunden");
      const coding = await executeCodingRepositoryRequest(selected.workspace, {
        kind: "read",
        path: "legacy.html",
        startLine: 2,
        endLine: 2,
        maxBytes: 512,
      });
      expect(coding.ok && coding.kind === "read" && coding.excerpt.snippet).toContain(
        "Ölwechsel 750 Stunden",
      );
    },
  );

  it("keeps unsupported declared codecs outside the accepted text scope without guessing", async () => {
    put("unsupported.html", '<meta charset="shift-jis">\n<p>UnsupportedProbe</p>\n');
    const selected = scope();
    const result = await searchText(selected, query("UnsupportedProbe"));
    expect(result.atoms).toEqual([]);
    expect(result.coverage.filesSkipped).toBe(1);
    expect(result.coverage.incomplete).toBe(false);
    expect(result.candidates.find((file) => file.scopePath === "unsupported.html")?.omitted).toBe(
      "binary",
    );
    await expect(
      readExcerpt(selected, {
        scopePath: "unsupported.html",
        startLine: 2,
        endLine: 2,
        maxBytes: 512,
      }),
    ).rejects.toMatchObject({ reason: "binary" });
    await expect(
      executeCodingRepositoryRequest(selected.workspace, {
        kind: "read",
        path: "unsupported.html",
        startLine: 2,
        endLine: 2,
        maxBytes: 512,
      }),
    ).rejects.toMatchObject({ reason: "file-unreadable" });
  });

  it.each(["\0", "\u0001".repeat(1000)])(
    "rejects binary payloads behind supported legacy HTML declarations",
    async (payload) => {
      const header = '<META CONTENT="text/html; CHARSET=iso_8859-1" HTTP-EQUIV="Content-Type">';
      put("legacy.html", Buffer.from(`${header}\n<p>Ölwechsel</p>${payload}`, "latin1"));
      const selected = scope();
      expect((await searchText(selected, query("Ölwechsel"))).atoms).toEqual([]);
      await expect(
        readExcerpt(selected, {
          scopePath: "legacy.html",
          startLine: 2,
          endLine: 2,
          maxBytes: 512,
        }),
      ).rejects.toMatchObject({ reason: "binary" });
      await expect(
        executeCodingRepositoryRequest(selected.workspace, {
          kind: "read",
          path: "legacy.html",
          startLine: 2,
          endLine: 2,
          maxBytes: 512,
        }),
      ).rejects.toMatchObject({ reason: "file-unreadable" });
    },
  );

  it("omits files above 2 MiB even when a match exists in their prefix", async () => {
    put("too-large.html", `manualNeedle\n${"x".repeat(2_097_152)}`);
    const selected = scope();
    const result = await searchText(selected, query("manualNeedle"));
    expect(result.atoms).toEqual([]);
    expect(result.candidates).toContainEqual(
      expect.objectContaining({ scopePath: "too-large.html", omitted: "size-exceeded" }),
    );
    expect(result.coverage.incomplete).toBe(false);
    expect(result.coverage.reasons).toEqual([]);
    expect(result.coverage.filesSkipped).toBe(1);
    const listing = await findFiles(selected, { ...query("**/*"), kind: "file-pattern" });
    expect(listing.coverage.incomplete).toBe(false);
    expect(listing.atoms).toEqual([]);
    await expect(
      readExcerpt(selected, {
        scopePath: "too-large.html",
        startLine: 1,
        endLine: 1,
        maxBytes: 512,
      }),
    ).rejects.toMatchObject({ sizeBytes: 2_097_165, limitBytes: 2_097_152 });
  });

  it("omits binaries and images while still searching UTF-16 handbook pages", async () => {
    put("valid.html", Buffer.from("\uFEFFmanualNeedle document\n", "utf16le"));
    put("renamed.html", new Uint8Array([0, 1, 2, 0, 3, 4]));
    put("tail-binary.html", `manualNeedle\n${"plain text\n".repeat(500)}\0`);
    put("picture.png", "manualNeedle");
    put("diagram.svg", "<svg><text>manualNeedle</text></svg>");
    const selected = scope();
    const result = await searchText(selected, query("manualNeedle"), DEFAULT_SEARCH_LIMITS);
    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["valid.html"]);
    const excerpt = await readExcerpt(selected, {
      scopePath: "valid.html",
      startLine: 1,
      endLine: 1,
      maxBytes: 512,
    });
    expect(excerpt.content).toBe("manualNeedle document");
    await expect(
      readExcerpt(selected, {
        scopePath: "tail-binary.html",
        startLine: 1,
        endLine: 1,
        maxBytes: 512,
      }),
    ).rejects.toMatchObject({ reason: "binary" });
    const coding = await executeCodingRepositoryRequest(selected.workspace, {
      kind: "search",
      query: "manualNeedle",
      mode: "literal",
      caseSensitive: false,
      maxResults: 50,
      includeGlobs: [],
      excludeGlobs: [],
    });
    expect(coding.ok && coding.kind === "search" && coding.hits.map((hit) => hit.path)).toEqual([
      "valid.html",
    ]);
  });
});
