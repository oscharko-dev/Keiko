import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_BINARY_PROBE } from "./binaryDetect.js";
import { executeCodingRepositoryRequest } from "./codingRepositorySearch.js";
import { detectWorkspaceAt } from "./detect.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import { readExcerpt, searchText, type SearchScope } from "./repoSearch.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-binary-probe-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function scope(): SearchScope {
  return {
    scopeId: "binary-probe",
    relativePaths: [],
    workspace: detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false }),
  };
}

function observedReads(): { readonly fs: WorkspaceFs; readonly reads: number[] } {
  const read = nodeWorkspaceFs.readFileBytes;
  if (read === undefined) throw new TypeError("Expected the native bounded byte reader");
  const reads: number[] = [];
  return {
    reads,
    fs: {
      ...nodeWorkspaceFs,
      readFileBytes: async (...args): Promise<Uint8Array> => {
        const bytes = await read(...args);
        reads.push(bytes.byteLength);
        return bytes;
      },
    },
  };
}

function binaryFile(name: string, header: string): void {
  const bytes = Buffer.alloc(1024 * 1024);
  bytes.write(header);
  writeFileSync(join(root, name), bytes);
}

const QUERY = {
  kind: "exact-symbol",
  text: "BinaryProbeNeedle",
  maxResults: 50,
  caseSensitive: true,
  emittedAtMs: 1,
} as const;

describe("bounded native binary prefilter", () => {
  it.each([
    ["archive.jar", "PK\x03\x04"],
    ["manual.pdf", "%PDF-1.7\n"],
    ["font.woff", "wOFF"],
    ["index.sqlite", "SQLite format 3\0"],
    ["module.wasm", "\0asm"],
  ])("rejects %s after the bounded head in uncapped search", async (name, header) => {
    binaryFile(name, header);
    const observed = observedReads();
    const result = await searchText(scope(), QUERY, undefined, { fs: observed.fs });
    expect(result.atoms).toEqual([]);
    expect(result.coverage).toMatchObject({ incomplete: false, reasons: [] });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ scopePath: name, omitted: "binary" });
    expect(observed.reads).toEqual([DEFAULT_BINARY_PROBE.maxProbeBytes]);
  });

  it("already rejects a binary Chat excerpt through the existing bounded probe", async () => {
    binaryFile("manual.pdf", "%PDF-1.7\n");
    const observed = observedReads();
    await expect(
      readExcerpt(
        scope(),
        { scopePath: "manual.pdf", startLine: 1, endLine: 1, maxBytes: 8192 },
        { fs: observed.fs },
      ),
    ).rejects.toMatchObject({ reason: "binary" });
    expect(observed.reads).toEqual([DEFAULT_BINARY_PROBE.maxProbeBytes]);
  });

  it("rejects a binary direct coding read without materializing the full file", async () => {
    binaryFile("manual.pdf", "%PDF-1.7\n");
    const observed = observedReads();
    await expect(
      executeCodingRepositoryRequest(
        scope().workspace,
        { kind: "read", path: "manual.pdf", startLine: 1, endLine: 1, maxBytes: 8192 },
        { fs: observed.fs },
      ),
    ).rejects.toMatchObject({ reason: "file-unreadable" });
    expect(observed.reads).toEqual([DEFAULT_BINARY_PROBE.maxProbeBytes]);
  });

  it.each([
    { name: "small.txt", bytes: Buffer.from("BinaryProbeNeedle\n") },
    { name: "disguised.jar", bytes: Buffer.from("Plain text BinaryProbeNeedle\n") },
    { name: "large.txt", bytes: Buffer.from("ordinary row\n".repeat(600) + "BinaryProbeNeedle\n") },
    {
      name: "utf16.txt",
      bytes: Buffer.from(
        "\uFEFF" + "ordinary row\n".repeat(600) + "BinaryProbeNeedle\n",
        "utf16le",
      ),
    },
    {
      name: "legacy.html",
      bytes: Buffer.from(
        '<meta charset="windows-1252">\n' + "<p>Änderung</p>\n".repeat(600) + "BinaryProbeNeedle\n",
        "latin1",
      ),
    },
  ])("retains eligible text and reuses a complete head: $name", async ({ name, bytes }) => {
    writeFileSync(join(root, name), bytes);
    const observed = observedReads();
    const result = await searchText(scope(), QUERY, undefined, { fs: observed.fs });
    expect(result.atoms.map((atom) => atom.scopePath)).toEqual([name]);
    expect(result.coverage).toMatchObject({ filesScanned: 1, incomplete: false, reasons: [] });
    const expectedReads =
      bytes.length > DEFAULT_BINARY_PROBE.maxProbeBytes
        ? [DEFAULT_BINARY_PROBE.maxProbeBytes, bytes.length]
        : [bytes.length];
    expect(observed.reads).toEqual(expectedReads);
  });

  it("still rejects a binary tail after an apparently text-only head", async () => {
    const bytes = Buffer.from("BinaryProbeNeedle\n" + "ordinary row\n".repeat(600) + "\0");
    writeFileSync(join(root, "tail.txt"), bytes);
    const observed = observedReads();
    const result = await searchText(scope(), QUERY, undefined, { fs: observed.fs });
    expect(result.atoms).toEqual([]);
    expect(result.candidates[0]).toMatchObject({ scopePath: "tail.txt", omitted: "binary" });
    expect(observed.reads).toEqual([DEFAULT_BINARY_PROBE.maxProbeBytes, bytes.length]);
  });

  it("keeps valid siblings but reports I/O loss when a file changes before the follow-up read", async () => {
    writeFileSync(join(root, "mutable.txt"), "ordinary row\n".repeat(600) + "BinaryProbeNeedle\n");
    writeFileSync(join(root, "valid.txt"), "BinaryProbeNeedle\n");
    const read = nodeWorkspaceFs.readFileBytes;
    if (read === undefined) throw new TypeError("Expected the native bounded byte reader");
    let sawPrefix = false;
    let changed = false;
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      readFileBytes: async (...args): Promise<Uint8Array> => {
        if (args[0].endsWith("/mutable.txt")) {
          if (args[1] <= DEFAULT_BINARY_PROBE.maxProbeBytes) sawPrefix = true;
          else if (sawPrefix) {
            writeFileSync(args[0], "changed file\n");
            changed = true;
          }
        }
        return read(...args);
      },
    };
    const result = await searchText(scope(), QUERY, undefined, { fs });
    expect(changed).toBe(true);
    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["valid.txt"]);
    expect(result.candidates.find((entry) => entry.scopePath === "mutable.txt")).toMatchObject({
      omitted: "tool-unavailable",
    });
    expect(result.coverage).toMatchObject({
      incomplete: true,
      reasons: ["io-error"],
      filesSkipped: 1,
    });
  });

  it("rejects individually stable reads from different file snapshots", async () => {
    writeFileSync(join(root, "mutable.txt"), "ordinary row\n".repeat(600) + "BinaryProbeNeedle\n");
    const read = nodeWorkspaceFs.readFileBytes;
    if (read === undefined) throw new TypeError("Expected the native bounded byte reader");
    let prefixFinished = false;
    let changed = false;
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      readFileBytes: async (...args): Promise<Uint8Array> => {
        const bytes = await read(...args);
        if (args[1] <= DEFAULT_BINARY_PROBE.maxProbeBytes) prefixFinished = true;
        return bytes;
      },
      stat: (path) => {
        const snapshot = nodeWorkspaceFs.stat(path);
        if (prefixFinished && !changed && path.endsWith("/mutable.txt")) {
          // The head's post-read snapshot is stable; the later full read sees a new stable file.
          writeFileSync(path, "BinaryProbeNeedle changed file\n");
          changed = true;
        }
        return snapshot;
      },
    };
    const result = await searchText(scope(), QUERY, undefined, { fs });
    expect(changed).toBe(true);
    expect(result.atoms).toEqual([]);
    expect(result.candidates[0]).toMatchObject({ omitted: "tool-unavailable" });
    expect(result.coverage).toMatchObject({
      incomplete: true,
      reasons: ["io-error"],
      filesSkipped: 1,
    });
  });
});
