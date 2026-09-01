import { afterEach, describe, expect, it, vi } from "vitest";
import { CancelledError } from "@oscharko-dev/keiko-model-gateway";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  SelectedScope,
  RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { SearchScope, WorkspaceFs, WorkspaceStat } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

import {
  collectConnectedDocumentEvidence,
  isConnectedDocumentPath,
  MAX_DOCUMENT_INPUT_BYTES,
  type DocumentEvidenceInputs,
} from "./grounded-document-evidence.js";

// A minimal valid DOCX (one paragraph containing "Policy …"), shared with the Local Knowledge
// parser fixtures. Embedded here so this server-side test does not reach into another package's
// internal test fixtures.
const DOCX_SIMPLE_BASE64 =
  "UEsDBBQAAAAIAC28xFzXeYTq8QAAALgBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QzU7DMBCE730Ky9cqccoBIZSkB36OwKE8wMreJFb9J69b2rdn00KREOVozXwz62nXB+/EHjPZGDq5qhspMOhobBg7+b55ru6koALBgIsBO3lEkut+0W6OCUkwHKiTUynpXinSE3qgOiYMrAwxeyj8zKNKoLcworppmlulYygYSlXmDNkvhGgfcYCdK+LpwMr5loyOpHg4e+e6TkJKzmoorKt9ML+Kqq+SmsmThyabaMkGqa6VzOL1jh/0lSfK1qB4g1xewLNRfcRslIl65xmu/0/649o4DFbjhZ/TUo4aiXh77+qL4sGG71+06jR8/wlQSwMEFAAAAAgALbzEXCAbhuqyAAAALgEAAAsAAABfcmVscy8ucmVsc43Puw6CMBQG4J2naM4uBQdjDIXFmLAafICmPZRGeklbL7y9HRzEODie23fyN93TzOSOIWpnGdRlBQStcFJbxeAynDZ7IDFxK/nsLDJYMELXFs0ZZ57yTZy0jyQjNjKYUvIHSqOY0PBYOo82T0YXDE+5DIp6Lq5cId1W1Y6GTwPagpAVS3rJIPSyBjIsHv/h3ThqgUcnbgZt+vHlayPLPChMDB4uSCrf7TKzQHNKuorZvgBQSwMEFAAAAAgALbzEXGJ/vc/pAAAA5wEAABEAAAB3b3JkL2RvY3VtZW50LnhtbJWRwU7DMAyG73uKKPc13Q4IVU2mgTRxnAQ8QEjNWimxoySs9O1JWtAmDhOc8lv+f/uT0+4+nWVnCHEglHxT1ZwBGuoGPEn++nJY33MWk8ZOW0KQfILId2rVjk1H5sMBJpYnYGxGyfuUfCNEND04HSvygLn3TsHplMtwEiOFzgcyEGNe4KzY1vWdcHpArlaM5alv1E1FzoVf1KKPQZXnOU0W2NictZX8CXQh3XChWrF4LonZn9SR7GCm0k6z6dsy+682XQJ763vNCkh1nfod+Bva9hbaI2EKZOM/4B4g3WIrYjlhUT9fpL4AUEsBAhQDFAAAAAgALbzEXNd5hOrxAAAAuAEAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAACAAtvMRcIBuG6rIAAAAuAQAACwAAAAAAAAAAAAAAgAEiAQAAX3JlbHMvLnJlbHNQSwECFAMUAAAACAAtvMRcYn+9z+kAAADnAQAAEQAAAAAAAAAAAAAAgAH9AQAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAMAAwC5AAAAFQMAAAAA";
const DOCX_SIMPLE = Uint8Array.from(Buffer.from(DOCX_SIMPLE_BASE64, "base64"));
const CFB_HEADER = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);

const WORKSPACE_ROOT = "/ws";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

interface FsEntry {
  readonly bytes: Uint8Array;
  readonly sizeOverride?: number;
}

function buildFs(entries: ReadonlyMap<string, FsEntry>): WorkspaceFs {
  return {
    readFileUtf8: (absolutePath): string => {
      const entry = entries.get(absolutePath);
      if (entry === undefined) {
        throw new Error("ENOENT");
      }
      return Buffer.from(entry.bytes).toString("utf8");
    },
    stat: (absolutePath): WorkspaceStat => {
      const entry = entries.get(absolutePath);
      if (entry === undefined) {
        throw new Error("ENOENT");
      }
      return {
        size: entry.sizeOverride ?? entry.bytes.byteLength,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        hardLinkCount: 1,
        mtimeMs: 1,
      };
    },
    readDir: (): readonly never[] => [],
    realPath: (absolutePath): string => absolutePath,
    exists: (absolutePath): boolean => entries.has(absolutePath),
    readFileBytes: (absolutePath, maxBytes): Promise<Uint8Array> => {
      const entry = entries.get(absolutePath);
      if (entry === undefined) {
        return Promise.reject(new Error("ENOENT"));
      }
      return Promise.resolve(entry.bytes.subarray(0, Math.min(maxBytes, entry.bytes.byteLength)));
    },
  };
}

function filesScope(relativePaths: readonly string[], explicit = true): SelectedScope {
  return {
    schemaVersion: "1",
    scopeId: "scope-docs",
    workspaceRoot: WORKSPACE_ROOT,
    kind: "files",
    relativePaths,
    conversationId: undefined,
    connectedAtMs: 1,
    explicitConnection: explicit,
  };
}

function query(): RetrievalQuery {
  return {
    kind: "natural-language",
    text: "what does the policy say",
    caseSensitive: false,
    maxResults: 10,
    emittedAtMs: 1,
  };
}

function inputs(
  scope: SelectedScope,
  entries: ReadonlyMap<string, FsEntry>,
  overrides: Partial<DocumentEvidenceInputs> = {},
): DocumentEvidenceInputs {
  const fs = buildFs(entries);
  const searchScope: SearchScope = {
    workspace: { root: WORKSPACE_ROOT },
    scopeId: scope.scopeId,
    relativePaths: scope.relativePaths,
  } as SearchScope;
  return { scope, query: query(), searchScope, fs, nowMs: () => 1_000, ...overrides };
}

function entriesFor(map: Record<string, FsEntry>): ReadonlyMap<string, FsEntry> {
  return new Map(Object.entries(map));
}

describe("isConnectedDocumentPath", () => {
  it("recognizes supported and known-unsupported document formats", () => {
    expect(isConnectedDocumentPath("a/report.docx")).toBe(true);
    expect(isConnectedDocumentPath("a/sheet.xlsx")).toBe(true);
    expect(isConnectedDocumentPath("a/manual.pdf")).toBe(true);
    expect(isConnectedDocumentPath("a/legacy.doc")).toBe(true);
    expect(isConnectedDocumentPath("a/deck.pptx")).toBe(true);
    expect(isConnectedDocumentPath("src/index.ts")).toBe(false);
    expect(isConnectedDocumentPath("README.md")).toBe(false);
  });
});

describe("collectConnectedDocumentEvidence", () => {
  it("does not touch a connected document after the request deadline", async () => {
    const scope = filesScope(["docs/report.docx"]);
    const baseInputs = inputs(
      scope,
      entriesFor({ "/ws/docs/report.docx": { bytes: DOCX_SIMPLE } }),
    );
    let fsAccesses = 0;
    const result = await collectConnectedDocumentEvidence({
      ...baseInputs,
      deadlineAtMs: 1_000,
      fs: {
        ...baseInputs.fs,
        realPath: (path): string => {
          fsAccesses += 1;
          return baseInputs.fs.realPath(path);
        },
      },
    });

    expect(fsAccesses).toBe(0);
    expect(result.atoms).toEqual([]);
    expect(result.omitted).toEqual([
      { scopePath: "docs/report.docx", reason: "budget-exhausted", omittedAtMs: 1_000 },
    ]);
  });

  it("does not stat or read a document after containment consumes the remaining time", async () => {
    const scope = filesScope(["docs/report.docx"]);
    const baseInputs = inputs(
      scope,
      entriesFor({ "/ws/docs/report.docx": { bytes: DOCX_SIMPLE } }),
    );
    let nowMs = 1_000;
    const deadlineAtMs = 1_001;
    let statCalls = 0;
    let byteReads = 0;
    const result = await collectConnectedDocumentEvidence({
      ...baseInputs,
      nowMs: () => nowMs,
      deadlineAtMs,
      fs: {
        ...baseInputs.fs,
        realPath: (path): string => {
          if (path.endsWith("report.docx")) nowMs = deadlineAtMs;
          return baseInputs.fs.realPath(path);
        },
        stat: (path): WorkspaceStat => {
          statCalls += 1;
          return baseInputs.fs.stat(path);
        },
        readFileBytes: (path, maxBytes, hardLinkPolicy, expected): Promise<Uint8Array> => {
          byteReads += 1;
          return (
            baseInputs.fs.readFileBytes?.(path, maxBytes, hardLinkPolicy, expected) ??
            Promise.resolve(new Uint8Array())
          );
        },
      },
    });

    expect(statCalls).toBe(0);
    expect(byteReads).toBe(0);
    expect(result.atoms).toEqual([]);
    expect(result.omitted[0]?.reason).toBe("budget-exhausted");
  });

  it("bounds a never-settling byte read and observes its late rejection", async () => {
    vi.useFakeTimers();
    const pending = deferred<Uint8Array>();
    const scope = filesScope(["docs/report.docx"]);
    const baseInputs = inputs(
      scope,
      entriesFor({ "/ws/docs/report.docx": { bytes: DOCX_SIMPLE } }),
    );
    const outcome = collectConnectedDocumentEvidence({
      ...baseInputs,
      deadlineAtMs: 1_010,
      fs: { ...baseInputs.fs, readFileBytes: (): Promise<Uint8Array> => pending.promise },
    });
    const expectation = expect(outcome).resolves.toMatchObject({
      atoms: [],
      omitted: [{ scopePath: "docs/report.docx", reason: "budget-exhausted" }],
    });

    await vi.advanceTimersByTimeAsync(10);
    await expectation;
    pending.reject(new Error("late document read rejection"));
    await Promise.resolve();
  });

  it("propagates caller cancellation while a document byte read is pending", async () => {
    const pending = deferred<Uint8Array>();
    const controller = new AbortController();
    const scope = filesScope(["docs/report.docx"]);
    const baseInputs = inputs(
      scope,
      entriesFor({ "/ws/docs/report.docx": { bytes: DOCX_SIMPLE } }),
    );
    const outcome = collectConnectedDocumentEvidence({
      ...baseInputs,
      signal: controller.signal,
      fs: { ...baseInputs.fs, readFileBytes: (): Promise<Uint8Array> => pending.promise },
    });
    const expectation = expect(outcome).rejects.toBeInstanceOf(CancelledError);

    controller.abort();

    await expectation;
    pending.resolve(DOCX_SIMPLE);
  });

  it("returns empty evidence for a non-files scope", async () => {
    const scope: SelectedScope = { ...filesScope(["docs/report.docx"]), kind: "directory" };
    const result = await collectConnectedDocumentEvidence(
      inputs(scope, entriesFor({ "/ws/docs/report.docx": { bytes: DOCX_SIMPLE } })),
    );
    expect(result.atoms).toEqual([]);
    expect(result.candidates).toEqual([]);
    expect(result.omitted).toEqual([]);
  });

  it("returns empty evidence for an implicit (non-explicit) files scope", async () => {
    const result = await collectConnectedDocumentEvidence(
      inputs(
        filesScope(["docs/report.docx"], false),
        entriesFor({ "/ws/docs/report.docx": { bytes: DOCX_SIMPLE } }),
      ),
    );
    expect(result.atoms).toEqual([]);
  });

  it("extracts a connected DOCX into document-extract evidence", async () => {
    const result = await collectConnectedDocumentEvidence(
      inputs(
        filesScope(["docs/report.docx"]),
        entriesFor({ "/ws/docs/report.docx": { bytes: DOCX_SIMPLE } }),
      ),
    );
    expect(result.omitted).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.scopePath).toBe("docs/report.docx");
    expect(result.atoms.length).toBeGreaterThan(0);
    for (const atom of result.atoms) {
      expect(atom.provenance.kind).toBe("document-extract");
      expect(atom.scopePath).toBe("docs/report.docx");
      expect(atom.redactionState).toBe("redacted");
      expect(atom.lineRange).toBeDefined();
    }
    const windows = result.excerpts.get("docs/report.docx");
    expect(windows).toBeDefined();
    expect(windows?.map((w) => w.content).join("\n")).toContain("Policy");
    // One atom per excerpt window so each maps to its own bounded span.
    expect(result.atoms).toHaveLength(windows?.length ?? 0);
  });

  it("skips an oversized document before reading it (size diagnostic)", async () => {
    const result = await collectConnectedDocumentEvidence(
      inputs(
        filesScope(["docs/big.docx"]),
        entriesFor({
          "/ws/docs/big.docx": { bytes: DOCX_SIMPLE, sizeOverride: MAX_DOCUMENT_INPUT_BYTES + 1 },
        }),
      ),
    );
    expect(result.atoms).toEqual([]);
    expect(result.omitted).toEqual([
      { scopePath: "docs/big.docx", reason: "size-exceeded", omittedAtMs: 1_000 },
    ]);
    expect(result.uncertainty).toHaveLength(1);
    expect(result.uncertainty[0]?.kind).toBe("scope-incomplete");
  });

  it("reports a stable unsupported diagnostic for legacy .doc", async () => {
    const result = await collectConnectedDocumentEvidence(
      inputs(filesScope(["docs/legacy.doc"]), entriesFor({})),
    );
    expect(result.omitted).toEqual([
      { scopePath: "docs/legacy.doc", reason: "unsupported-format", omittedAtMs: 1_000 },
    ]);
  });

  it("reports an encrypted diagnostic for a password-protected DOCX", async () => {
    const result = await collectConnectedDocumentEvidence(
      inputs(
        filesScope(["docs/secret.docx"]),
        entriesFor({ "/ws/docs/secret.docx": { bytes: CFB_HEADER } }),
      ),
    );
    expect(result.omitted).toEqual([
      { scopePath: "docs/secret.docx", reason: "encrypted-document", omittedAtMs: 1_000 },
    ]);
  });

  it("reports a malformed diagnostic for corrupt DOCX bytes", async () => {
    const result = await collectConnectedDocumentEvidence(
      inputs(
        filesScope(["docs/broken.docx"]),
        entriesFor({ "/ws/docs/broken.docx": { bytes: new TextEncoder().encode("not a zip") } }),
      ),
    );
    expect(result.omitted).toEqual([
      { scopePath: "docs/broken.docx", reason: "malformed-document", omittedAtMs: 1_000 },
    ]);
  });

  it("reports outside-scope for a denied document path", async () => {
    const result = await collectConnectedDocumentEvidence(
      inputs(
        filesScope(["node_modules/pkg/readme.docx"]),
        entriesFor({ "/ws/node_modules/pkg/readme.docx": { bytes: DOCX_SIMPLE } }),
      ),
    );
    expect(result.omitted).toEqual([
      { scopePath: "node_modules/pkg/readme.docx", reason: "outside-scope", omittedAtMs: 1_000 },
    ]);
  });

  it("reports tool-unavailable when document metadata cannot be read", async () => {
    const scope = filesScope(["docs/report.docx"]);
    const baseInputs = inputs(
      scope,
      entriesFor({ "/ws/docs/report.docx": { bytes: DOCX_SIMPLE } }),
    );
    const result = await collectConnectedDocumentEvidence({
      ...baseInputs,
      fs: {
        ...baseInputs.fs,
        stat: () => {
          throw new Error("EACCES");
        },
      },
    });

    expect(result.atoms).toEqual([]);
    expect(result.omitted).toEqual([
      { scopePath: "docs/report.docx", reason: "tool-unavailable", omittedAtMs: 1_000 },
    ]);
    expect(result.uncertainty.some((marker) => marker.kind === "scope-incomplete")).toBe(true);
  });

  it("reports tool-unavailable when document bytes cannot be read", async () => {
    const scope = filesScope(["docs/report.docx"]);
    const baseInputs = inputs(
      scope,
      entriesFor({ "/ws/docs/report.docx": { bytes: DOCX_SIMPLE } }),
    );
    const result = await collectConnectedDocumentEvidence({
      ...baseInputs,
      fs: {
        ...baseInputs.fs,
        readFileBytes: () => Promise.reject(new Error("EACCES")),
      },
    });

    expect(result.atoms).toEqual([]);
    expect(result.omitted).toEqual([
      { scopePath: "docs/report.docx", reason: "tool-unavailable", omittedAtMs: 1_000 },
    ]);
    expect(result.uncertainty.some((marker) => marker.kind === "scope-incomplete")).toBe(true);
  });

  it("denies a connected document whose real path no longer matches the explicit file scope", async () => {
    const scope = filesScope(["docs/link.docx"]);
    const baseInputs = inputs(
      scope,
      entriesFor({ "/ws/private/secret.docx": { bytes: DOCX_SIMPLE } }),
    );
    let readFileBytesCalls = 0;
    const result = await collectConnectedDocumentEvidence({
      ...baseInputs,
      fs: {
        ...baseInputs.fs,
        realPath: (absolutePath): string =>
          absolutePath === "/ws/docs/link.docx" ? "/ws/private/secret.docx" : absolutePath,
        readFileBytes: async (
          absolutePath,
          maxBytes,
          hardLinkPolicy,
          expected,
        ): Promise<Uint8Array> => {
          readFileBytesCalls += 1;
          return (
            baseInputs.fs.readFileBytes?.(absolutePath, maxBytes, hardLinkPolicy, expected) ??
            new Uint8Array()
          );
        },
      },
    });

    expect(readFileBytesCalls).toBe(0);
    expect(result.atoms).toEqual([]);
    expect(result.omitted).toEqual([
      { scopePath: "docs/link.docx", reason: "outside-scope", omittedAtMs: 1_000 },
    ]);
  });

  it("denies a connected document when a safe workspace root aliases a denied root", async () => {
    const scope = filesScope(["docs/report.docx"]);
    const deniedPath = "/.aws/docs/report.docx";
    const baseInputs = inputs(scope, entriesFor({ [deniedPath]: { bytes: DOCX_SIMPLE } }));
    let deniedStats = 0;
    let deniedReads = 0;
    const result = await collectConnectedDocumentEvidence({
      ...baseInputs,
      fs: {
        ...baseInputs.fs,
        realPath: (absolutePath): string =>
          absolutePath === WORKSPACE_ROOT
            ? "/.aws"
            : absolutePath.startsWith(`${WORKSPACE_ROOT}/`)
              ? `/.aws/${absolutePath.slice(WORKSPACE_ROOT.length + 1)}`
              : absolutePath,
        stat: (absolutePath): WorkspaceStat => {
          if (absolutePath === deniedPath) deniedStats += 1;
          return baseInputs.fs.stat(absolutePath);
        },
        readFileBytes: async (
          absolutePath,
          maxBytes,
          hardLinkPolicy,
          expected,
        ): Promise<Uint8Array> => {
          if (absolutePath === deniedPath) deniedReads += 1;
          return (
            baseInputs.fs.readFileBytes?.(absolutePath, maxBytes, hardLinkPolicy, expected) ??
            new Uint8Array()
          );
        },
      },
    });

    expect(deniedStats).toBe(0);
    expect(deniedReads).toBe(0);
    expect(result.atoms).toEqual([]);
    expect(result.omitted).toEqual([
      { scopePath: "docs/report.docx", reason: "outside-scope", omittedAtMs: 1_000 },
    ]);
  });

  it("denies a document alias even when its target is another explicitly selected file", async () => {
    const scope = filesScope(["docs/link.docx", "docs/real.docx"]);
    const realPath = "/ws/docs/real.docx";
    const baseInputs = inputs(scope, entriesFor({ [realPath]: { bytes: DOCX_SIMPLE } }));
    let reads = 0;
    const result = await collectConnectedDocumentEvidence({
      ...baseInputs,
      fs: {
        ...baseInputs.fs,
        realPath: (absolutePath): string =>
          absolutePath === "/ws/docs/link.docx" ? realPath : absolutePath,
        readFileBytes: async (
          absolutePath,
          maxBytes,
          hardLinkPolicy,
          expected,
        ): Promise<Uint8Array> => {
          reads += 1;
          return (
            baseInputs.fs.readFileBytes?.(absolutePath, maxBytes, hardLinkPolicy, expected) ??
            new Uint8Array()
          );
        },
      },
    });

    expect(reads).toBe(1);
    expect(result.candidates.map((candidate) => candidate.scopePath)).toEqual(["docs/real.docx"]);
    expect(result.omitted).toContainEqual({
      scopePath: "docs/link.docx",
      reason: "outside-scope",
      omittedAtMs: 1_000,
    });
  });

  it("denies a hard-linked connected document before reading bytes", async () => {
    const scope = filesScope(["docs/report.docx"]);
    const baseInputs = inputs(
      scope,
      entriesFor({ "/ws/docs/report.docx": { bytes: DOCX_SIMPLE } }),
    );
    let readFileBytesCalls = 0;
    const result = await collectConnectedDocumentEvidence({
      ...baseInputs,
      fs: {
        ...baseInputs.fs,
        stat: (absolutePath): WorkspaceStat => ({
          ...baseInputs.fs.stat(absolutePath),
          hardLinkCount: 2,
        }),
        readFileBytes: async (
          absolutePath,
          maxBytes,
          hardLinkPolicy,
          expected,
        ): Promise<Uint8Array> => {
          readFileBytesCalls += 1;
          return (
            baseInputs.fs.readFileBytes?.(absolutePath, maxBytes, hardLinkPolicy, expected) ??
            new Uint8Array()
          );
        },
      },
    });

    expect(readFileBytesCalls).toBe(0);
    expect(result.atoms).toEqual([]);
    expect(result.omitted).toEqual([
      { scopePath: "docs/report.docx", reason: "outside-scope", omittedAtMs: 1_000 },
    ]);
  });

  it("denies a connected document replaced by a denied-file hard link after preflight stat", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-grounded-document-hardlink-race-"));
    try {
      const docs = join(root, "docs");
      mkdirSync(docs);
      const documentPath = join(docs, "report.docx");
      const deniedPath = join(root, ".env");
      writeFileSync(documentPath, DOCX_SIMPLE);
      writeFileSync(deniedPath, DOCX_SIMPLE);
      const documentRealPath = realpathSync(documentPath);
      let swapped = false;
      const fs: WorkspaceFs = {
        ...nodeWorkspaceFs,
        stat: (absolutePath): WorkspaceStat => {
          const stat = nodeWorkspaceFs.stat(absolutePath);
          if (absolutePath === documentRealPath && !swapped) {
            swapped = true;
            unlinkSync(documentPath);
            linkSync(deniedPath, documentPath);
          }
          return stat;
        },
      };
      const scope: SelectedScope = {
        ...filesScope(["docs/report.docx"]),
        workspaceRoot: root,
      };
      const searchScope: SearchScope = {
        workspace: { root },
        scopeId: scope.scopeId,
        relativePaths: scope.relativePaths,
      } as SearchScope;

      const result = await collectConnectedDocumentEvidence({
        scope,
        query: query(),
        searchScope,
        fs,
        nowMs: () => 1_000,
      });

      expect(swapped).toBe(true);
      expect(result.atoms).toEqual([]);
      expect(result.omitted).toEqual([
        { scopePath: "docs/report.docx", reason: "outside-scope", omittedAtMs: 1_000 },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extracts every connected document when the aggregate budget is not exhausted", async () => {
    const paths = ["docs/a.docx", "docs/b.docx", "docs/c.docx"];
    const entries: Record<string, FsEntry> = {};
    for (const path of paths) {
      entries[`/ws/${path}`] = { bytes: DOCX_SIMPLE };
    }
    const result = await collectConnectedDocumentEvidence(
      inputs(filesScope(paths), entriesFor(entries)),
    );
    expect(result.candidates).toHaveLength(3);
    expect(result.omitted).toEqual([]);
  });

  it("deduplicates and skips non-document connected files", async () => {
    const result = await collectConnectedDocumentEvidence(
      inputs(
        filesScope(["docs/report.docx", "docs/report.docx", "src/index.ts"]),
        entriesFor({ "/ws/docs/report.docx": { bytes: DOCX_SIMPLE } }),
      ),
    );
    // The code file is left to the code-first path; the duplicate document is processed once.
    expect(result.candidates).toHaveLength(1);
  });
});
