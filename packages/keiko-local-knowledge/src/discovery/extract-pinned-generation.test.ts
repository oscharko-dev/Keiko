// Regression: a progressive extraction must be pinned to ONE file generation (#3347, PR #3367).
//
// The progressive path reads the same file many times — once per 4 MiB hash chunk, then once per
// parser window. When each read derived its own expected identity, a SAME-SIZE atomic A->B
// replacement mid-run passed every individual descriptor check, so the run could persist a hash
// computed over A (or over mixed chunks) beside parsed units decoded from B. A size check cannot
// see it: both generations are byte-for-byte the same length.
//
// The fake below models a workspace port that reports generations the way the Node port does: the
// per-file `WorkspaceStat` identity changes on replacement, `readFileRange` refuses a stale
// `expected`, and a reader opened through `openFileReader` refuses to serve once the pathname has
// been replaced under it. The staged swaps are (a) between the two hash chunks and (b) between
// hashing and parsing.

import { createHash } from "node:crypto";

import { DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-large-document";
import type {
  KnowledgeCapsuleId,
  KnowledgeSource,
  KnowledgeSourceId,
  LargeDocumentResourcePolicy,
} from "@oscharko-dev/keiko-contracts";
import type { WorkspaceDirEntry, WorkspaceFs, WorkspaceStat } from "@oscharko-dev/keiko-workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCapsule } from "../capsule-lifecycle.js";
import { addSourceToCapsule } from "../source-lifecycle.js";
import { freshStore, sampleCapsuleInput } from "../_support.js";
import { createDefaultParserRegistry, syntheticProgressiveExtractor } from "../parsers/index.js";
import type { KnowledgeStore } from "../store.js";
import { extractDocument } from "./extract.js";
import { folderScope } from "./test-support.js";
import { documentIdFor, type ExtractionResult } from "./types.js";

const ROOT = "/srv/docs";
const RELATIVE_PATH = "big.synthetic";
const ABSOLUTE_PATH = `${ROOT}/${RELATIVE_PATH}`;
const SOURCE_ID = "src-pin" as KnowledgeSourceId;
const capsuleId = "cap-pin" as KnowledgeCapsuleId;
// extract.ts hashes in 4 MiB chunks, so one extra byte forces exactly two chunks and gives the
// staged replacement a seam to land in.
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;
const FILE_BYTES = HASH_CHUNK_BYTES + 1;

type OpenFileReader = NonNullable<WorkspaceFs["openFileReader"]>;

interface Generation {
  readonly bytes: Uint8Array;
  readonly identity: string;
  readonly mtimeNs: string;
}

function generationOf(fill: string, index: number): Generation {
  return {
    bytes: new Uint8Array(FILE_BYTES).fill(fill.charCodeAt(0)),
    identity: `memory:${ABSOLUTE_PATH}#${String(index)}`,
    mtimeNs: String(1_700_000_000_000 + index),
  };
}

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function statOf(current: Generation): WorkspaceStat {
  return {
    size: current.bytes.byteLength,
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
    hardLinkCount: 1,
    fileIdentity: current.identity,
    mtimeNs: current.mtimeNs,
    ctimeNs: current.mtimeNs,
  };
}

const ROOT_STAT: WorkspaceStat = {
  size: 0,
  isFile: false,
  isDirectory: true,
  isSymbolicLink: false,
  fileIdentity: `memory:${ROOT}`,
};

const ROOT_ENTRIES: readonly WorkspaceDirEntry[] = [
  { name: RELATIVE_PATH, isDirectory: false, isFile: true, isSymbolicLink: false },
];

class ReplacedGenerationError extends Error {
  public constructor() {
    super("workspace-descriptor-read-changed");
    this.name = "ReplacedGenerationError";
  }
}

interface ReplacingFsOptions {
  // The replacement lands in the seam AFTER this many window reads have been served AND fully
  // revalidated by the caller — the instant no single-read check can observe, because the next
  // read derives everything it compares against from the already-replaced file. `undefined`
  // never replaces. The seam is located identically for every caller: the extraction revalidates
  // a read by resolving the requested pathname and then re-reading the canonical file's metadata,
  // so the replacement is applied after answering the metadata half of that pair.
  readonly replaceAfterRead?: number;
  readonly holdDescriptor: boolean;
  // Models a port that serves bytes without re-checking the caller's expected identity (the
  // in-memory fakes behave this way). The pin then has to be enforced by the extraction itself.
  readonly ignoresExpectedIdentity?: boolean;
}

interface ReplacingFs {
  readonly fs: WorkspaceFs;
  readonly generations: readonly [Generation, Generation];
  readonly servedReads: () => number;
  readonly openedReaders: () => number;
  readonly replaced: () => boolean;
}

function replacingFs(options: ReplacingFsOptions): ReplacingFs {
  const generations: readonly [Generation, Generation] = [
    generationOf("A", 0),
    generationOf("B", 1),
  ];
  let current: Generation = generations[0];
  let servedReads = 0;
  let openedReaders = 0;
  let replaced = false;
  let afterRealPath = false;
  const applyAtSeam = (): void => {
    if (replaced || servedReads !== options.replaceAfterRead) return;
    replaced = true;
    current = generations[1];
  };
  const serve = (from: Generation, startByte: number, length: number): Uint8Array => {
    afterRealPath = false;
    const start = Math.max(0, Math.floor(startByte));
    const cap = Math.max(0, Math.floor(length));
    servedReads += 1;
    return from.bytes.subarray(start, Math.min(from.bytes.byteLength, start + cap));
  };
  // Mirrors assertCurrentFileDescriptor: a held descriptor refuses to serve once the pathname
  // points at a different file.
  const openFileReader: OpenFileReader = (absolutePath, _hardLinkPolicy, expected) => {
    afterRealPath = false;
    if (absolutePath !== ABSOLUTE_PATH) return Promise.reject(new Error("ENOENT"));
    if (expected.fileIdentity !== current.identity) {
      return Promise.reject(new ReplacedGenerationError());
    }
    openedReaders += 1;
    const opened = current;
    return Promise.resolve({
      readRange: (startByte: number, length: number): Promise<Uint8Array> =>
        current === opened
          ? Promise.resolve(serve(opened, startByte, length))
          : Promise.reject(new ReplacedGenerationError()),
      close: (): Promise<void> => Promise.resolve(),
    });
  };
  const base: WorkspaceFs = {
    readFileUtf8: (): string => {
      throw new Error("unbounded reads are not part of this fixture");
    },
    stat: (absolutePath: string): WorkspaceStat => {
      const closesRevalidation = afterRealPath;
      afterRealPath = false;
      if (absolutePath === ROOT) return ROOT_STAT;
      if (absolutePath !== ABSOLUTE_PATH) throw new Error("ENOENT");
      const answer = statOf(current);
      if (closesRevalidation) applyAtSeam();
      return answer;
    },
    readDir: (absolutePath: string): readonly WorkspaceDirEntry[] =>
      absolutePath === ROOT ? ROOT_ENTRIES : [],
    realPath: (absolutePath: string): string => {
      afterRealPath = absolutePath === ABSOLUTE_PATH;
      return absolutePath;
    },
    exists: (absolutePath: string): boolean =>
      absolutePath === ABSOLUTE_PATH || absolutePath === ROOT,
    // Mirrors assertExpectedDescriptorSnapshot: the caller's expected identity must still be the
    // file behind the path.
    readFileRange: (absolutePath, startByte, length, _hardLinkPolicy, expected) => {
      afterRealPath = false;
      if (absolutePath !== ABSOLUTE_PATH) return Promise.reject(new Error("ENOENT"));
      if (options.ignoresExpectedIdentity !== true && expected.fileIdentity !== current.identity) {
        return Promise.reject(new ReplacedGenerationError());
      }
      return Promise.resolve(serve(current, startByte, length));
    },
  };
  return {
    fs: options.holdDescriptor ? { ...base, openFileReader } : base,
    generations,
    servedReads: (): number => servedReads,
    openedReaders: (): number => openedReaders,
    replaced: (): boolean => replaced,
  };
}

// A port with neither bounded reader: the progressive path has no way to pin a generation.
function withoutBoundedReaders(fs: WorkspaceFs): WorkspaceFs {
  return {
    readFileUtf8: fs.readFileUtf8,
    stat: fs.stat,
    readDir: fs.readDir,
    realPath: fs.realPath,
    exists: fs.exists,
  };
}

function withFailingStat(fs: WorkspaceFs): WorkspaceFs {
  return {
    ...fs,
    stat: (absolutePath: string): WorkspaceStat => {
      if (absolutePath === ABSOLUTE_PATH) throw new Error("EIO");
      return fs.stat(absolutePath);
    },
  };
}

function withDirectoryStat(fs: WorkspaceFs): WorkspaceFs {
  return {
    ...fs,
    stat: (absolutePath: string): WorkspaceStat =>
      absolutePath === ABSOLUTE_PATH
        ? { ...fs.stat(absolutePath), isFile: false, isDirectory: true }
        : fs.stat(absolutePath),
  };
}

function withFailingOpenReader(fs: WorkspaceFs): WorkspaceFs {
  return {
    ...fs,
    openFileReader: (): Promise<never> => Promise.reject(new Error("open refused")),
  };
}

// Holds a descriptor that reads fine but refuses to close, so the close failure cannot be
// confused with a read failure.
function withFailingClose(fs: WorkspaceFs): WorkspaceFs {
  const readFileRange = fs.readFileRange;
  if (readFileRange === undefined) throw new Error("fixture requires readFileRange");
  return {
    ...fs,
    openFileReader: (absolutePath, hardLinkPolicy, expected) =>
      Promise.resolve({
        readRange: (startByte: number, length: number): Promise<Uint8Array> =>
          readFileRange(absolutePath, startByte, length, hardLinkPolicy, expected),
        close: (): Promise<void> => Promise.reject(new Error("close refused")),
      }),
  };
}

let store: KnowledgeStore;
let cleanup: () => void;
let source: KnowledgeSource;

beforeEach(() => {
  const fresh = freshStore();
  store = fresh.store;
  cleanup = fresh.cleanup;
  createCapsule(store, sampleCapsuleInput({ id: capsuleId }));
  source = addSourceToCapsule(store, capsuleId, {
    id: SOURCE_ID,
    displayName: "docs",
    tags: [],
    scope: folderScope(ROOT),
  });
});

afterEach(() => {
  cleanup();
});

function policy(): LargeDocumentResourcePolicy {
  return { ...DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY, largeFileThresholdBytes: 16 };
}

function runExtraction(fs: WorkspaceFs): Promise<ExtractionResult> {
  return extractDocument(
    {
      fs,
      store,
      parserRegistry: createDefaultParserRegistry(),
      largeDocumentPolicy: policy(),
      progressiveExtractors: [
        syntheticProgressiveExtractor({ totalPages: 2, pageChars: 8, pagesPerWindow: 1 }),
      ],
      largeDocumentJobId: "job-pin",
    },
    { capsuleId, source, file: { relativePath: RELATIVE_PATH, sizeBytes: FILE_BYTES } },
  );
}

const documentId = documentIdFor({
  capsuleId,
  sourceId: SOURCE_ID,
  relativePath: RELATIVE_PATH,
});

interface DocumentRow {
  readonly content_hash: string;
  readonly status: string;
}

function documentRow(): DocumentRow | undefined {
  return store._internal.db
    .prepare("SELECT content_hash, status FROM documents WHERE capsule_id = :c AND id = :d")
    .get({ c: String(capsuleId), d: String(documentId) }) as DocumentRow | undefined;
}

function rowCount(table: "document_text_windows" | "pages" | "parsed_units"): number {
  const row = store._internal.db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE capsule_id = :c AND document_id = :d`)
    .get({ c: String(capsuleId), d: String(documentId) }) as { readonly n: number };
  return row.n;
}

describe("extractDocument — progressive extraction is pinned to one file generation", () => {
  it("persists the whole extraction from one generation when the file is never replaced", async () => {
    const harness = replacingFs({ holdDescriptor: false });
    const result = await runExtraction(harness.fs);

    expect(result.outcome.kind).toBe("persisted");
    if (result.outcome.kind !== "persisted") return;
    expect(result.outcome.document.contentHash).toBe(sha256Of(harness.generations[0].bytes));
    expect(rowCount("document_text_windows")).toBe(2);
    expect(rowCount("pages")).toBe(2);
  });

  it("holds a single descriptor for the whole run when the port offers openFileReader", async () => {
    const harness = replacingFs({ holdDescriptor: true });
    const result = await runExtraction(harness.fs);

    expect(result.outcome.kind).toBe("persisted");
    // One descriptor covers both hash chunks and both parser windows.
    expect(harness.openedReaders()).toBe(1);
    expect(harness.servedReads()).toBe(4);
  });

  it("rejects a same-size replacement staged between the two hash chunks", async () => {
    const harness = replacingFs({ replaceAfterRead: 1, holdDescriptor: false });
    const result = await runExtraction(harness.fs);

    expect(harness.replaced()).toBe(true);
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind !== "failed") return;
    expect(result.outcome.error.code).toBe("READ_FAILED");
    expect(result.outcome.error.message).toBe("readFileRange failed for selected file");
    // Nothing from either generation may survive: no content hash, no text, no units, no pages.
    expect(documentRow()?.status).toBe("failed");
    expect(documentRow()?.content_hash).toBe("");
    expect(rowCount("document_text_windows")).toBe(0);
    expect(rowCount("parsed_units")).toBe(0);
    expect(rowCount("pages")).toBe(0);
  });

  it("rejects a same-size replacement staged between hashing and parsing", async () => {
    const harness = replacingFs({ replaceAfterRead: 2, holdDescriptor: false });
    const result = await runExtraction(harness.fs);

    expect(harness.replaced()).toBe(true);
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind !== "failed") return;
    expect(result.outcome.error.code).toBe("READ_FAILED");
    // The pre-commit revalidation is the step that caught it, and says so.
    expect(result.outcome.error.message).toBe(
      "selected file changed before the extraction was committed",
    );
    // The unpinned defect persisted exactly this: hash(A) on the document row beside units decoded
    // from B. The row must never carry generation A's hash.
    expect(documentRow()?.content_hash).not.toBe(sha256Of(harness.generations[0].bytes));
    expect(documentRow()?.content_hash).toBe("");
    expect(rowCount("document_text_windows")).toBe(0);
    expect(rowCount("parsed_units")).toBe(0);
    expect(rowCount("pages")).toBe(0);
  });

  it("rejects a same-size replacement between the hash chunks under a held descriptor too", async () => {
    const harness = replacingFs({ replaceAfterRead: 1, holdDescriptor: true });
    const result = await runExtraction(harness.fs);

    expect(harness.replaced()).toBe(true);
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind !== "failed") return;
    expect(result.outcome.error.code).toBe("READ_FAILED");
    expect(documentRow()?.content_hash).toBe("");
    expect(rowCount("document_text_windows")).toBe(0);
  });

  it("rejects a same-size replacement between hashing and parsing under a held descriptor", async () => {
    const harness = replacingFs({ replaceAfterRead: 2, holdDescriptor: true });
    const result = await runExtraction(harness.fs);

    expect(harness.replaced()).toBe(true);
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind !== "failed") return;
    expect(result.outcome.error.code).toBe("READ_FAILED");
    expect(documentRow()?.content_hash).not.toBe(sha256Of(harness.generations[0].bytes));
    expect(documentRow()?.content_hash).toBe("");
    expect(rowCount("document_text_windows")).toBe(0);
  });

  // The port here happily serves the replaced bytes, so the rejection can only come from the
  // extraction revalidating its own pinned snapshot after each window read.
  it("rejects a replacement a permissive port would have served", async () => {
    const harness = replacingFs({
      replaceAfterRead: 1,
      holdDescriptor: false,
      ignoresExpectedIdentity: true,
    });
    const result = await runExtraction(harness.fs);

    expect(harness.replaced()).toBe(true);
    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind !== "failed") return;
    expect(result.outcome.error.code).toBe("READ_FAILED");
    // The pin, not the port, is what refused — and the persisted diagnostic names that.
    expect(result.outcome.error.message).toBe(
      "selected file changed while the extraction hashed it",
    );
    // Hashing stopped at the replaced chunk; the parser never got to read generation B.
    expect(harness.servedReads()).toBe(2);
    expect(documentRow()?.content_hash).toBe("");
    expect(rowCount("document_text_windows")).toBe(0);
  });

  it("fails closed when the requested path can no longer be stat'ed", async () => {
    const harness = replacingFs({ holdDescriptor: false });
    const result = await runExtraction(withFailingStat(harness.fs));

    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind !== "failed") return;
    expect(result.outcome.error.code).toBe("STAT_FAILED");
    expect(harness.servedReads()).toBe(0);
  });

  it("fails closed when the resolved target is no longer a regular file", async () => {
    const harness = replacingFs({ holdDescriptor: false });
    const result = await runExtraction(withDirectoryStat(harness.fs));

    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind !== "failed") return;
    expect(result.outcome.error.code).toBe("READ_FAILED");
    expect(harness.servedReads()).toBe(0);
  });

  it("fails closed when the port offers no reader that can be pinned", async () => {
    const harness = replacingFs({ holdDescriptor: false });
    const result = await runExtraction(withoutBoundedReaders(harness.fs));

    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind !== "failed") return;
    expect(result.outcome.error.code).toBe("READ_FAILED");
    expect(harness.servedReads()).toBe(0);
    expect(rowCount("document_text_windows")).toBe(0);
  });

  it("fails closed when the pinned descriptor cannot be opened", async () => {
    const harness = replacingFs({ holdDescriptor: false });
    const result = await runExtraction(withFailingOpenReader(harness.fs));

    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind !== "failed") return;
    expect(result.outcome.error.code).toBe("READ_FAILED");
    expect(harness.servedReads()).toBe(0);
  });

  it("keeps the extraction outcome when releasing the pin fails", async () => {
    const harness = replacingFs({ holdDescriptor: false });
    const result = await runExtraction(withFailingClose(harness.fs));

    expect(result.outcome.kind).toBe("persisted");
    if (result.outcome.kind !== "persisted") return;
    expect(result.outcome.document.contentHash).toBe(sha256Of(harness.generations[0].bytes));
    expect(rowCount("document_text_windows")).toBe(2);
  });
});
