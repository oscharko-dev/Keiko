import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EDITOR_SESSION_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/editor-session";
import type { LocalSecretVault } from "@oscharko-dev/keiko-security/secret-vault";
import type { WorkspaceFs, WorkspaceStat } from "@oscharko-dev/keiko-workspace";
import {
  nodeWorkspaceFs,
  type WorkspaceHardLinkPolicy,
} from "@oscharko-dev/keiko-workspace/internal/fs";

// KEIKO-0192 regression: create/rename/delete must forward workspace/didChangeWatchedFiles to
// pooled host LSP processes, the same way writeFilesContentRoute already does for content saves.
// Spy on the real module (keeping every other export intact) so only this one call is observable.
vi.mock("./editor/lsp/hostLanguageOperation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./editor/lsp/hostLanguageOperation.js")>();
  return { ...actual, notifyHostLspWorkspaceFileChanged: vi.fn() };
});

import {
  buildRedactor,
  createFilesEntry,
  createInMemoryUiStore,
  copyFilesEntry,
  deleteFilesEntry,
  handleFilesContent,
  handleFilesRename,
  readFilesContent,
  readFilesPreview,
  readFilesTree,
  renameFilesEntry,
  searchFiles,
  writeFilesContent,
} from "./index.js";
import {
  handleFilesPreviewImage,
  normalizeRelativePath,
  resolveRoot,
  classifyInLockRefreshFailure,
  type ResolvedProjectRoot,
} from "./files.js";
import { STREAMING } from "./routes.js";
import { mockRequest, mockResponse, type MockResponse } from "./_support.js";
import type { RouteContext, UiHandlerDeps } from "./index.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import { createBreakpointStore } from "./editor/dap/breakpointStore.js";
import { createEditorLocalHistoryStore } from "./editor/localHistory/localHistoryStore.js";
import type {
  EditorLocalHistoryCaptureInput,
  EditorLocalHistoryStore,
} from "./editor/localHistory/localHistoryStore.js";
import { notifyHostLspWorkspaceFileChanged } from "./editor/lsp/hostLanguageOperation.js";
import type { UiStore } from "./store/index.js";

const notifyHostLspMock = vi.mocked(notifyHostLspWorkspaceFileChanged);

// Mirrors the (non-exported) editable size limit in files.ts; used for boundary tests.
const MAX_TEXT_PREVIEW_BYTES = 1_000_000;

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// Minimal RouteContext for a PATCH /api/files/content call. handleFilesContent only reads
// `req.method`, the request body stream, and (on GET) `url.searchParams`; `res`/`params` are unused.
function patchContentContext(body: unknown): RouteContext {
  const req = Readable.from([
    Buffer.from(JSON.stringify(body), "utf8"),
  ]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "PATCH";
  return {
    correlationId: undefined,
    req,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL("http://localhost/api/files/content"),
  };
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ax6XK0AAAAASUVORK5CYII=",
  "base64",
);

interface ImagePreviewCall {
  readonly ctx: RouteContext;
  readonly response: MockResponse;
  // Raw response bytes. MockResponse.body() decodes as UTF-8, which cannot round-trip PNG bytes.
  readonly bytes: () => Buffer;
  readonly finished: Promise<unknown>;
}

// GET /api/files/preview/image writes to `res` itself and returns STREAMING instead of a
// RouteResult, so its body has to be captured off the response. `mockResponse` is a real
// PassThrough, which keeps working whether the handler pipes into it or ends it with one buffer.
// `onWriteHead` runs at the instant the handler commits its status line — the boundary the
// regression below stages its swap at.
function imagePreviewCall(
  rootInput: string,
  relativePath: string,
  onWriteHead: () => void,
): ImagePreviewCall {
  const response = mockResponse();
  const chunks: Buffer[] = [];
  const stream = response.res as unknown as Readable;
  stream.on("data", (chunk: Buffer) => {
    chunks.push(Buffer.from(chunk));
  });
  const commit = response.res.writeHead.bind(response.res);
  response.res.writeHead = ((status: number, headers?: Record<string, string>): ServerResponse => {
    onWriteHead();
    return commit(status, headers);
  }) as ServerResponse["writeHead"];
  const query = new URLSearchParams({ root: rootInput, path: relativePath });
  const url = `/api/files/preview/image?${query.toString()}`;
  return {
    ctx: {
      correlationId: undefined,
      req: mockRequest({ url }),
      res: response.res,
      params: {},
      url: new URL(`http://localhost${url}`),
    },
    response,
    bytes: (): Buffer => Buffer.concat(chunks),
    // Attached eagerly: "end" can fire while the caller is still awaiting the handler.
    finished: once(stream, "end"),
  };
}

// Drives real filesystem round-trips on `path`, draining the event loop between them. A stat()
// submitted before the first of these has certainly completed by the last — used to give an
// unserialized contender every chance to reach its conflict check, so that the serialization
// assertion below fails loudly when the lock is removed. Bounded work, no wall-clock threshold.
async function settleFileSystemTurns(path: string, rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await stat(path);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("desktop files browser", () => {
  let root: string;
  let extraRoot: string | null = null;
  let store: UiStore;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "keiko-files-")));
    await mkdir(join(root, "src"));
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "package.json"), '{"name":"fixture"}\n');
    await writeFile(join(root, "src", "app.ts"), 'const value: string = "ok";\n');
    await writeFile(join(root, "assets", "pixel.png"), PNG_1X1);
    await writeFile(join(root, "archive.bin"), Buffer.from([0, 1, 2, 3, 4, 5]));
    store = createInMemoryUiStore();
    store.createProject(root, "fixture");
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
    if (extraRoot !== null) {
      await rm(extraRoot, { recursive: true, force: true });
      extraRoot = null;
    }
  });

  it("resolves a registered project root and keeps deny-listed roots out", async () => {
    await mkdir(join(root, ".git"), { recursive: true });

    await expect(resolveRoot(store, root, buildRedactor({}))).resolves.toMatchObject({
      root,
      realRoot: root,
    });

    store.createProject(join(root, ".git"), "git-dir");
    await expect(resolveRoot(store, join(root, ".git"), buildRedactor({}))).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
  });

  it("browses an unregistered arbitrary absolute directory (Epic #532 — any machine folder)", async () => {
    const arbitrary = await realpath(await mkdtemp(join(tmpdir(), "keiko-files-arbitrary-")));
    extraRoot = arbitrary;
    await mkdir(join(arbitrary, "reports"));
    await writeFile(join(arbitrary, "notes.txt"), "hello world", "utf8");

    await expect(resolveRoot(store, arbitrary, buildRedactor({}))).resolves.toMatchObject({
      root: arbitrary,
      realRoot: arbitrary,
    });

    const tree = await readFilesTree(store, arbitrary, "");
    expect(tree.entries.map((entry) => entry.name)).toContain("notes.txt");

    const preview = await readFilesPreview(store, arbitrary, "notes.txt", buildRedactor({}));
    expect(preview.kind).toBe("text");
    if (preview.kind === "text") {
      expect(preview.content).toContain("hello world");
    }
  });

  it("rejects a relative (non-absolute) arbitrary root", async () => {
    await expect(resolveRoot(store, "relative/dir", buildRedactor({}))).rejects.toMatchObject({
      status: 400,
      code: "BAD_ROOT",
    });
  });

  it("denies an unregistered root that passes through a credential location", async () => {
    // The deny list matches on EVERY path segment of the realpath, so a root literally named like a
    // credential dir — or nested under one — is rejected even though its basename is innocuous. This
    // keeps full-machine browse from ever exposing ~/.aws, ~/.ssh, and friends (Epic #532 security).
    const base = await realpath(await mkdtemp(join(tmpdir(), "keiko-files-cred-")));
    extraRoot = base;
    await mkdir(join(base, ".aws"));
    await mkdir(join(base, ".aws", "sub"));

    await expect(resolveRoot(store, join(base, ".aws"), buildRedactor({}))).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
    await expect(
      resolveRoot(store, join(base, ".aws", "sub"), buildRedactor({})),
    ).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
  });

  it("refuses credential-shaped roots and entry metadata before returning Files-window labels", async () => {
    const tokenSegment = `sk-${"a".repeat(20)}`;
    const sensitiveRoot = join(root, tokenSegment);
    await mkdir(sensitiveRoot);
    await mkdir(join(root, "safe-dir"));
    await mkdir(join(root, "safe-dir", tokenSegment));
    await writeFile(join(root, "safe-dir", `${tokenSegment}.txt`), "hidden\n", "utf8");
    await writeFile(join(root, "safe-dir", "visible.txt"), "hello\n", "utf8");

    await expect(resolveRoot(store, sensitiveRoot, buildRedactor({}))).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
    const treeRoot = await readFilesTree(store, root, "");
    expect(treeRoot.entries.map((entry) => entry.name)).not.toContain(tokenSegment);

    const tree = await readFilesTree(store, root, "safe-dir");
    expect(tree.entries.map((entry) => entry.name)).toEqual(["visible.txt"]);

    await expect(
      readFilesPreview(store, root, `safe-dir/${tokenSegment}.txt`, buildRedactor({})),
    ).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
    await expect(
      readFilesContent(store, root, `safe-dir/${tokenSegment}.txt`, buildRedactor({})),
    ).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
    await expect(
      writeFilesContent({
        store,
        rootInput: root,
        pathInput: `safe-dir/${tokenSegment}.txt`,
        content: "updated\n",
        redactor: buildRedactor({}),
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
  });

  it("refuses a registered project whose root path contains credential-shaped metadata", async () => {
    const sensitiveProject = join(root, `sk-${"c".repeat(20)}`, "project");
    await mkdir(sensitiveProject, { recursive: true });
    store.createProject(sensitiveProject, "sensitive-project");

    await expect(resolveRoot(store, sensitiveProject, buildRedactor({}))).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
    await expect(readFilesTree(store, sensitiveProject, "")).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
  });

  it("denies a registered project nested under a credential location", async () => {
    const nestedProject = join(root, ".aws", "sub");
    await mkdir(nestedProject, { recursive: true });
    store.createProject(nestedProject, "nested-project");

    await expect(resolveRoot(store, nestedProject, buildRedactor({}))).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
  });

  it("lazy-loads directories with directories first and files second", async () => {
    const listing = await readFilesTree(store, root, "");

    expect(listing.root).toBe(root);
    expect(listing.path).toBe("");
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      "assets",
      "src",
      "archive.bin",
      "package.json",
    ]);
    expect(listing.entries.find((entry) => entry.name === "src")).toMatchObject({
      kind: "directory",
      readable: true,
    });
  });

  it("KEIKO-0633: does not emit a fabricated 0 sentinel for a directory's sizeBytes/modifiedAt", async () => {
    const listing = await readFilesTree(store, root, "");
    const srcDir = listing.entries.find((entry) => entry.name === "src");
    expect(srcDir?.kind).toBe("directory");
    // Directories are not stat'd per-entry (perf shortcut), so the wire must say "not measured"
    // (undefined) rather than surfacing a `0` that looks like a real measurement.
    expect(srcDir?.sizeBytes).toBeUndefined();
    expect(srcDir?.modifiedAt).toBeUndefined();
    // File entries continue to carry the real lstat-derived values.
    const pkgFile = listing.entries.find((entry) => entry.name === "package.json");
    expect(pkgFile?.kind).toBe("file");
    expect(typeof pkgFile?.sizeBytes).toBe("number");
    expect(pkgFile?.sizeBytes ?? 0).toBeGreaterThan(0);
    expect(typeof pkgFile?.modifiedAt).toBe("number");
  });

  it("searches repository file paths without reading file contents", async () => {
    await mkdir(join(root, "src", "context"));
    await writeFile(join(root, "src", "context", "coding-context.ts"), "export const x = 1;\n");
    await writeFile(join(root, "src", "context", "coding-notes.md"), "notes\n");

    const result = await searchFiles(store, root, "coding-context", 10, buildRedactor({}));

    expect(result.root).toBe(root);
    expect(result.query).toBe("coding-context");
    expect(result.results.map((entry) => entry.path)).toEqual(["src/context/coding-context.ts"]);
    expect(result.results[0]).toMatchObject({
      name: "coding-context.ts",
      directory: "src/context",
      extension: "ts",
      fileRole: "source",
      matchQuality: "exact",
      rootKind: "selected-root",
    });
    expect(result.scannedFileCount).toBeGreaterThan(0);
  });

  it("rebases file search results to nested Git repository roots", async () => {
    extraRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-files-parent-")));
    const repo = join(extraRoot, "Keiko");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, "packages", "keiko-editor", "src"), { recursive: true });
    await writeFile(join(repo, "package.json"), '{"name":"keiko"}\n');
    await writeFile(
      join(repo, "packages", "keiko-editor", "src", "range.ts"),
      "export const range = 1;\n",
    );

    const result = await searchFiles(store, extraRoot, "range", 10, buildRedactor({}));

    expect(result.root).toBe(extraRoot);
    expect(result.results[0]).toMatchObject({
      root: repo,
      path: "packages/keiko-editor/src/range.ts",
      name: "range.ts",
      directory: "packages/keiko-editor/src",
      extension: "ts",
      fileRole: "source",
      matchQuality: "exact",
      rootKind: "nested-git-root",
    });
  });

  it("prefers source repository files over generated parent-folder assets", async () => {
    extraRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-files-ranking-")));
    const repo = join(extraRoot, "Keiko");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, "packages", "keiko-editor", "src"), { recursive: true });
    await mkdir(join(extraRoot, "StorybookStatic", "assets"), { recursive: true });
    await writeFile(
      join(repo, "packages", "keiko-editor", "src", "range.ts"),
      "export const sourceRange = 1;\n",
    );
    await writeFile(join(extraRoot, "StorybookStatic", "assets", "range.ts"), "generated\n");

    const result = await searchFiles(store, extraRoot, "range", 10, buildRedactor({}));

    expect(result.results[0]).toMatchObject({
      root: repo,
      path: "packages/keiko-editor/src/range.ts",
      name: "range.ts",
      directory: "packages/keiko-editor/src",
      fileRole: "source",
      rootKind: "nested-git-root",
    });
    expect(result.results).toContainEqual(
      expect.objectContaining({
        path: "StorybookStatic/assets/range.ts",
        fileRole: "generated",
        rootKind: "selected-root",
      }),
    );
  });

  it("classifies docs, config, and test search results", async () => {
    await mkdir(join(root, "docs"), { recursive: true });
    await mkdir(join(root, "tests"), { recursive: true });
    await writeFile(join(root, "docs", "usage.md"), "# Usage\n");
    await writeFile(join(root, "vitest.config.ts"), "export default {};\n");
    await writeFile(join(root, "tests", "range.test.ts"), "import { it } from 'vitest';\n");

    const docs = await searchFiles(store, root, "usage", 10, buildRedactor({}));
    const config = await searchFiles(store, root, "vitest", 10, buildRedactor({}));
    const test = await searchFiles(store, root, "range.test", 10, buildRedactor({}));

    expect(docs.results[0]).toMatchObject({
      path: "docs/usage.md",
      fileRole: "docs",
      matchQuality: "exact",
      rootKind: "selected-root",
    });
    expect(config.results[0]).toMatchObject({
      path: "vitest.config.ts",
      fileRole: "config",
      matchQuality: "strong",
      rootKind: "selected-root",
    });
    expect(test.results[0]).toMatchObject({
      path: "tests/range.test.ts",
      fileRole: "test",
      matchQuality: "exact",
      rootKind: "selected-root",
    });
  });

  it("does not rebase file search results to Git roots outside the selected root", async () => {
    extraRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-files-subroot-")));
    const repo = join(extraRoot, "repo");
    const selectedRoot = join(repo, "src");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(selectedRoot, { recursive: true });
    await writeFile(join(selectedRoot, "app.ts"), "export const app = true;\n");

    const result = await searchFiles(store, selectedRoot, "app", 10, buildRedactor({}));

    expect(result.root).toBe(selectedRoot);
    expect(result.results[0]).toMatchObject({
      root: selectedRoot,
      path: "app.ts",
      name: "app.ts",
      directory: "",
    });
  });

  it("keeps repository file search inside the selected root and deny list", async () => {
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "coding-context.ts"), "secret\n");
    await mkdir(join(root, "src", "visible"));
    await writeFile(join(root, "src", "visible", "coding-context.ts"), "safe\n");

    const result = await searchFiles(store, root, "coding", 10, buildRedactor({}));

    expect(result.results.map((entry) => entry.path)).toEqual(["src/visible/coding-context.ts"]);
    await expect(searchFiles(store, join(root, ".git"), "coding")).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
  });

  it("does not scan the repository for an empty file search query", async () => {
    const result = await searchFiles(store, root, "   ", 10, buildRedactor({}));

    expect(result.results).toEqual([]);
    expect(result.scannedFileCount).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("rejects path traversal outside the selected root", async () => {
    await expect(readFilesTree(store, root, "../")).rejects.toMatchObject({
      status: 400,
      code: "PATH_ESCAPE",
    });
  });

  it("rejects a non-string relative path at the runtime boundary", () => {
    expect(() => Reflect.apply(normalizeRelativePath, undefined, [42])).toThrow(
      "The path must be a string or null.",
    );
  });

  it("rejects an absolute file identifier on the content and tree endpoints (#1374 AC1)", async () => {
    // The editor must hand the BFF a ROOT-RELATIVE path; an absolute identifier (the historic
    // "absolute-path editor load failure") is rejected before any file is touched. The client-side
    // root-relative file-identifier contract (keiko-contracts) guarantees this never happens, and
    // this test pins the server half of that contract.
    await expect(
      readFilesContent(store, root, join(root, "src", "app.ts"), buildRedactor({})),
    ).rejects.toMatchObject({ status: 400, code: "BAD_PATH" });
    await expect(readFilesTree(store, root, join(root, "src"))).rejects.toMatchObject({
      status: 400,
      code: "BAD_PATH",
    });
  });

  it("bounds a large directory tree to a truncated, capped entry set (#1374 performance)", async () => {
    const wideDir = join(root, "wide");
    await mkdir(wideDir);
    // One more than the server's MAX_DIRECTORY_ENTRIES (1000) cap so truncation is forced.
    const entryCount = 1_001;
    await Promise.all(
      Array.from({ length: entryCount }, (_unused, index) =>
        writeFile(join(wideDir, `f${String(index).padStart(4, "0")}.txt`), "x\n"),
      ),
    );

    const tree = await readFilesTree(store, root, "wide");

    expect(tree.truncated).toBe(true);
    expect(tree.entries).toHaveLength(1_000);
    expect(tree.entries.every((entry) => entry.path.startsWith("wide/"))).toBe(true);
  });

  it("marks symlink escapes unreadable and rejects traversal through them", async () => {
    extraRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-files-outside-")));
    await writeFile(join(extraRoot, "secret.txt"), "outside\n");
    try {
      await symlink(extraRoot, join(root, "escape"), "dir");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    const listing = await readFilesTree(store, root, "");
    // #2906 review (comment 3863185718): a symlink-to-directory is `kind: "symlink"` (with
    // symlinkTargetKind: "directory"), never `kind: "directory"` -- it is not a real directory and
    // carries real lstat metadata, unlike the metadata-free "directory" variant FilesTreeEntry now
    // enforces at the type level. `readable` stays the security invariant this test pins; there is
    // no separate `symlink` field to assert on since PR #3289 review (comment 3865167775) removed
    // it from the wire type -- `kind` alone is the discriminant.
    // KEIKO-0873 (#3331): an out-of-root symlink target must NOT disclose whether the escaped path
    // is a file or a directory -- `symlinkTargetKind` collapses to "unknown" whenever `contained`
    // is false, mirroring how `readable` already collapses to `false` for the same case. Reporting
    // the real kind here was a one-bit filesystem-enumeration oracle for paths the workspace
    // boundary is otherwise supposed to hide entirely.
    expect(listing.entries.find((entry) => entry.name === "escape")).toMatchObject({
      kind: "symlink",
      symlinkTargetKind: "unknown",
      readable: false,
    });
    await expect(readFilesTree(store, root, "escape")).rejects.toMatchObject({
      status: 403,
      code: "PATH_ESCAPE",
    });
  });

  it("marks symlink aliases to deny-listed targets unreadable and denies access through them", async () => {
    await writeFile(join(root, ".env"), "SECRET=1\n");
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    try {
      await symlink(".env", join(root, "config.txt"));
      await symlink(".git", join(root, "git-cache"), "dir");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    const listing = await readFilesTree(store, root, "");
    // PR #3289 review (comment 3865167775): config.txt is a symlink whose target (.env) is a FILE
    // -- the mirror-image case of the directory-target collapse bug below. It must stay
    // `kind: "symlink"` too, never collapsed into `kind: "file"` just because its target is one.
    // KEIKO-0873 (#3331, hardened in final review): a deny-listed but in-root target's real kind
    // must not be disclosed either -- it is the same filesystem-enumeration oracle the out-of-root
    // case closes, just reachable through a symlink aliasing a denied path instead of an absolute
    // escape. symlinkTargetKind collapses to "unknown" here exactly as it does for an out-of-root
    // target, while `readable: false` (already correct) is unchanged.
    expect(listing.entries.find((entry) => entry.name === "config.txt")).toMatchObject({
      kind: "symlink",
      symlinkTargetKind: "unknown",
      readable: false,
    });
    // Same symlink-to-directory relabeling as the escape case above.
    expect(listing.entries.find((entry) => entry.name === "git-cache")).toMatchObject({
      kind: "symlink",
      symlinkTargetKind: "unknown",
      readable: false,
    });

    await expect(
      readFilesPreview(store, root, "config.txt", buildRedactor({})),
    ).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
    await expect(readFilesTree(store, root, "git-cache")).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
  });

  // #3348 audit (P3): closing the target-KIND oracle above still left the target-PATH-LENGTH one.
  // On POSIX, `lstat().size` for a symbolic link is the exact byte length of its target path, and
  // that value rode out on the entry as `sizeBytes`, so a caller could still distinguish two
  // hidden targets (e.g. `.env` from a long secrets path) purely by their reported size. An
  // unreadable symlink must be indistinguishable from every other unreadable symlink.
  it("does not leak an unreadable symlink's target-path length through sizeBytes", async () => {
    await writeFile(join(root, ".env"), "SECRET=1\n");
    await mkdir(join(root, ".git"));
    // Two deny-listed targets whose path lengths differ substantially. Under the pre-fix behaviour
    // the entries reported sizeBytes 4 and 42 respectively; they must now be identical.
    const longDeniedTarget = ".git/a-deliberately-long-inner-path-name.txt";
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, longDeniedTarget), "x\n");
    try {
      await symlink(".env", join(root, "short-alias"));
      await symlink(longDeniedTarget, join(root, "long-alias"));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    const listing = await readFilesTree(store, root, "");
    const shortAlias = listing.entries.find((entry) => entry.name === "short-alias");
    const longAlias = listing.entries.find((entry) => entry.name === "long-alias");
    expect(shortAlias).toBeDefined();
    expect(longAlias).toBeDefined();
    expect(shortAlias).toMatchObject({ kind: "symlink", readable: false });
    expect(longAlias).toMatchObject({ kind: "symlink", readable: false });

    // The oracle itself is the subject: two hidden targets of very different path length must be
    // byte-for-byte indistinguishable on the wire, not merely "both unreadable".
    expect(longAlias?.sizeBytes).toBe(shortAlias?.sizeBytes);
    expect(shortAlias?.sizeBytes).toBe(0);
    expect(shortAlias?.modifiedAt).toBe(0);
    expect(longAlias?.modifiedAt).toBe(0);
  });

  // #2906 review (comment 3863185718): the positive case the two symlink-to-directory tests above
  // don't cover -- a READABLE symlink whose target is a directory. Before the fix this reported
  // `kind: "directory"` while ALSO carrying the symlink's own real lstat sizeBytes/modifiedAt,
  // contradicting the "a directory entry is metadata-free" invariant the wire TYPE now enforces
  // (KEIKO-0633). It must report `kind: "symlink"` with `symlinkTargetKind: "directory"` instead,
  // still carrying real (not undefined) metadata.
  it("reports a readable symlink-to-directory as kind symlink with symlinkTargetKind directory, never as a metadata-free directory", async () => {
    await symlink(join(root, "src"), join(root, "link-to-src"), "dir");

    const listing = await readFilesTree(store, root, "");
    const entry = listing.entries.find((candidate) => candidate.name === "link-to-src");
    expect(entry).toMatchObject({
      kind: "symlink",
      symlinkTargetKind: "directory",
      readable: true,
    });
    expect(typeof entry?.sizeBytes).toBe("number");
    expect(typeof entry?.modifiedAt).toBe("number");

    // Genuinely readable: the tree can be listed through it, unlike the denied/escaped cases above.
    const throughLink = await readFilesTree(store, root, "link-to-src");
    expect(throughLink.entries.map((candidate) => candidate.name)).toContain("app.ts");
  });

  // PR #3289 review (comment 3865167775): the mirror-image positive case -- a READABLE symlink
  // whose target is a FILE. Before this fix, classifySymlinkEntry special-cased this to report
  // `kind: "file"` while STILL attaching `symlinkTargetKind: "file"`, a field the wire type now
  // declares only on the "symlink" variant. It must report `kind: "symlink"` uniformly, exactly
  // like the symlink-to-directory case above, regardless of what the target turns out to be.
  it("reports a readable symlink-to-file as kind symlink with symlinkTargetKind file, never collapsed into kind file", async () => {
    await symlink(join(root, "src", "app.ts"), join(root, "link-to-file.ts"));

    const listing = await readFilesTree(store, root, "");
    const entry = listing.entries.find((candidate) => candidate.name === "link-to-file.ts");
    expect(entry).toMatchObject({
      kind: "symlink",
      symlinkTargetKind: "file",
      readable: true,
    });
    expect(typeof entry?.sizeBytes).toBe("number");
    expect(typeof entry?.modifiedAt).toBe("number");
  });

  it("returns redacted text previews", async () => {
    const secret = ["super-secret-value-", "1234567890"].join("");
    await writeFile(join(root, "src", "secret.ts"), `export const token = "${secret}";\n`);

    const preview = await readFilesPreview(
      store,
      root,
      "src/secret.ts",
      buildRedactor({ KEIKO_DEFAULT_API_KEY: secret }),
    );

    expect(preview.kind).toBe("text");
    if (preview.kind === "text") {
      expect(preview.content).not.toContain(secret);
      expect(preview.content).toContain("[REDACTED]");
    }
  });

  it("loads editable text content for a workspace file", async () => {
    const content = await readFilesContent(store, root, "src/app.ts");

    expect(content.path).toBe("src/app.ts");
    expect(content.content).toContain('const value: string = "ok";');
    expect(content.maxBytes).toBe(1_000_000);
  });

  it("writes editable text content back to the selected root", async () => {
    const initial = await readFilesContent(store, root, "src/app.ts");

    const saved = await writeFilesContent({
      store,
      rootInput: root,
      pathInput: "src/app.ts",
      content: 'export const value = "changed";\n',
      expectedModifiedAt: initial.modifiedAt,
    });

    expect(saved.content).toBe('export const value = "changed";\n');
    const roundTrip = await readFilesContent(store, root, "src/app.ts");
    expect(roundTrip.content).toBe('export const value = "changed";\n');
  });

  it("rejects a symlink swap between save validation and the write effect", async () => {
    extraRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-files-outside-")));
    const victim = join(extraRoot, "victim.ts");
    await writeFile(victim, "outside\n", "utf8");
    let seenTargetMetadata = 0;
    const redactor: UiHandlerDeps["redactor"] = (value: unknown): unknown => {
      if (value === "src/app.ts") {
        seenTargetMetadata += 1;
        if (seenTargetMetadata === 2) {
          rmSync(join(root, "src", "app.ts"), { force: true });
          symlinkSync(victim, join(root, "src", "app.ts"));
        }
      }
      return value;
    };

    await expect(
      writeFilesContent({
        store,
        rootInput: root,
        pathInput: "src/app.ts",
        content: 'export const value = "swapped";\n',
        redactor,
      }),
    ).rejects.toMatchObject({ status: 409, code: "STALE_PATH" });
    expect(await readFile(victim, "utf8")).toBe("outside\n");
  });

  // #3347 consumer-boundary hardening: readContainedBytes re-proves the WorkspaceStat snapshot
  // captured at admission before it returns bytes, so a substitute crafted with the EXACT same byte
  // length and mtime as the admitted file is still rejected.
  //
  // What this does NOT prove is the device+inode term specifically, and it used to claim it did
  // ("only the inode differs"). It cannot: staging a substitute requires creating a file, creating a
  // file moves `ctime`, and userland cannot set `ctime` back — so the read is refused on the ctime
  // term regardless of what the inode term does. Deleting
  // `expected.fileIdentity === observed.fileIdentity` from the comparator leaves this test green.
  // The device+inode guarantee lives in fs.test.ts, which varies one snapshot field at a time and
  // pins the producer's inode semantics directly.
  it("rejects a same-size, same-mtime substitute on the full admitted snapshot", async () => {
    const targetPath = join(root, "src", "app.ts");
    const original = await readFile(targetPath);
    const originalStat = await stat(targetPath);
    const substitute = "y".repeat(original.byteLength);
    let swapped = false;
    const boundedRead = nodeWorkspaceFs.readFileBytes;
    if (boundedRead === undefined) throw new Error("expected a bounded byte reader");
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      // The race, staged at exactly the boundary under test: admission has already captured the
      // original's identity by the time this runs, and the substitute lands immediately before the
      // bounded read opens its descriptor. Hooking the read (rather than counting stat calls) keeps
      // the test bound to that ordering rather than to how many times admission happens to stat.
      readFileBytes: async (
        path: string,
        maxBytes: number,
        policy: WorkspaceHardLinkPolicy,
        expected: WorkspaceStat,
      ): Promise<Uint8Array> => {
        if (path === targetPath && !swapped) {
          swapped = true;
          rmSync(path, { force: true });
          writeFileSync(path, substitute, "utf8");
          utimesSync(path, originalStat.mtime, originalStat.mtime);
        }
        return boundedRead.call(nodeWorkspaceFs, path, maxBytes, policy, expected);
      },
    };
    const resolvedRoot: ResolvedProjectRoot = {
      root,
      realRoot: root,
      access: { kind: "ordinary", canonicalRoot: root, fs },
    };

    await expect(
      readFilesContent(store, root, "src/app.ts", buildRedactor({}), resolvedRoot),
    ).rejects.toMatchObject({ status: 409, code: "STALE_PATH" });
    expect(swapped).toBe(true);
    // Same byte length and mtime as the admitted file, so the older size/mtime-only comparison
    // would have served these bytes.
    const onDisk = await readFile(targetPath, "utf8");
    expect(onDisk).toBe(substitute);
    expect(onDisk).toHaveLength(original.byteLength);
  });

  // #3367 review (Cursor): WorkspaceFs.readFileBytes compares the FULL admission-time snapshot --
  // fileIdentity AND size/mtime/ctime/nlink -- so an ordinary in-place edit (same inode) fails the
  // descriptor check just as hard as an inode swap. readStableEditableContent used to fold that
  // failure into its retry budget, which could never recover: every remaining attempt compares
  // against the same fixed snapshot and fails identically, so a legitimate concurrent save cost the
  // full budget and two 25ms sleeps before reporting the STALE_SESSION it reports on the first
  // attempt now. The retry loop still exists for reads that SUCCEED and then fail statsMatch.
  it("reports an in-place edit between admission and the editable read as a stale session on the first attempt", async () => {
    const targetPath = join(root, "src", "app.ts");
    const before = await stat(targetPath);
    const boundedRead = nodeWorkspaceFs.readFileBytes;
    if (boundedRead === undefined) throw new Error("expected a bounded byte reader");
    let reads = 0;
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      readFileBytes: async (
        path: string,
        maxBytes: number,
        policy: WorkspaceHardLinkPolicy,
        expected: WorkspaceStat,
      ): Promise<Uint8Array> => {
        reads += 1;
        const bytes = await boundedRead.call(nodeWorkspaceFs, path, maxBytes, policy, expected);
        // Staged AFTER the editability probe completes, so the stable-content read below is the
        // one that meets the edited file. An ordinary truncating rewrite: same inode, no swap.
        if (reads === 1 && path === targetPath) {
          writeFileSync(
            path,
            'const value: string = "edited in place by another editor";\n',
            "utf8",
          );
        }
        return bytes;
      },
    };
    const resolvedRoot: ResolvedProjectRoot = {
      root,
      realRoot: root,
      access: { kind: "ordinary", canonicalRoot: root, fs },
    };

    await expect(
      readFilesContent(store, root, "src/app.ts", buildRedactor({}), resolvedRoot),
    ).rejects.toMatchObject({ status: 409, code: "STALE_SESSION" });
    // Two bounded reads: the editability probe, then ONE stable-content attempt. Retrying the
    // descriptor mismatch would make this 4 without changing the outcome.
    expect(reads).toBe(2);
    // The edit really was in place -- the same inode admission bound to, not a replacement.
    expect((await stat(targetPath)).ino).toBe(before.ino);
  });

  // #3367 owner P1, reproduced on the current head: admit a root, replace that root directory with
  // a symlink pointing OUTSIDE it before the next filesystem call, then delete. The admitted
  // pathname never moves, so `isContained(realRoot, target.path)` -- a string comparison -- keeps
  // answering "contained", and every stat taken after the swap sees the outside file on BOTH sides
  // of the identity comparison. The delete then landed on the outside target while the original
  // file survived. The re-canonicalization through the admitted capability is what refuses it.
  it("refuses to delete through a root swapped to an outside symlink after admission", async () => {
    extraRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-files-rootswap-")));
    const workspace = join(extraRoot, "workspace");
    const displaced = join(extraRoot, "displaced");
    const outside = join(extraRoot, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(workspace, "note.txt"), "inside\n", "utf8");
    await writeFile(join(outside, "note.txt"), "outside\n", "utf8");
    let swapped = false;
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      realPath: (path: string): string => {
        const canonical = nodeWorkspaceFs.realPath(path);
        // The race made deterministic: admission has resolved the canonical, contained pathname,
        // and the root underneath it is replaced before anything stats that pathname.
        if (!swapped) {
          swapped = true;
          renameSync(workspace, displaced);
          symlinkSync(outside, workspace);
        }
        return canonical;
      },
    };
    const resolvedRoot: ResolvedProjectRoot = {
      root: workspace,
      realRoot: workspace,
      access: { kind: "ordinary", canonicalRoot: workspace, fs },
    };

    await expect(
      deleteFilesEntry({
        store,
        rootInput: workspace,
        pathInput: "note.txt",
        redactor: buildRedactor({}),
        resolvedRoot,
      }),
    ).rejects.toMatchObject({ status: 403, code: "PATH_ESCAPE" });
    expect(swapped).toBe(true);
    expect(await readFile(join(outside, "note.txt"), "utf8")).toBe("outside\n");
    expect(await readFile(join(displaced, "note.txt"), "utf8")).toBe("inside\n");
  });

  // The read half of the same admission hole, and the reason the re-proof lives in
  // resolveInsideRoot rather than only in the mutation guard: with the root swapped during
  // admission, `identity` and `stats` BOTH describe the outside file, so the identity-bound bounded
  // read agreed with itself and handed the caller content from outside the workspace.
  it("refuses to read through a root swapped to an outside symlink during admission", async () => {
    extraRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-files-readswap-")));
    const workspace = join(extraRoot, "workspace");
    const displaced = join(extraRoot, "displaced");
    const outside = join(extraRoot, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(workspace, "note.txt"), "inside\n", "utf8");
    await writeFile(join(outside, "note.txt"), "outside secret\n", "utf8");
    let swapped = false;
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      realPath: (path: string): string => {
        const canonical = nodeWorkspaceFs.realPath(path);
        if (!swapped) {
          swapped = true;
          renameSync(workspace, displaced);
          symlinkSync(outside, workspace);
        }
        return canonical;
      },
    };

    await expect(
      readFilesPreview(store, workspace, "note.txt", buildRedactor({}), {
        root: workspace,
        realRoot: workspace,
        access: { kind: "ordinary", canonicalRoot: workspace, fs },
      }),
    ).rejects.toMatchObject({ status: 403, code: "PATH_ESCAPE" });
    expect(swapped).toBe(true);
  });

  // The same escape, staged at the MUTATION boundary instead of at admission, through the product's
  // own afterConflictCheck hook (no injected WorkspaceFs at all -- the real node port answers every
  // call). The outside file is a HARD LINK to the admitted one, so `sameFileIdentity` compares equal
  // device+inode and waves the swap through; only re-canonicalizing the pathname sees it. Before the
  // fix the atomic save wrote its temp file into the outside directory and renamed it over the
  // outside entry, leaving the workspace copy untouched.
  it("refuses to write through a root swapped to an outside symlink after the conflict check", async () => {
    extraRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-files-writeswap-")));
    const workspace = join(extraRoot, "workspace");
    const displaced = join(extraRoot, "displaced");
    const outside = join(extraRoot, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(workspace, "note.txt"), "inside\n", "utf8");
    await link(join(workspace, "note.txt"), join(outside, "note.txt"));
    let swapped = false;

    await expect(
      writeFilesContent({
        store,
        rootInput: workspace,
        pathInput: "note.txt",
        content: "escaped\n",
        redactor: buildRedactor({}),
        resolvedRoot: {
          root: workspace,
          realRoot: workspace,
          access: { kind: "ordinary", canonicalRoot: workspace, fs: nodeWorkspaceFs },
        },
        testControl: {
          afterConflictCheck: (): void => {
            swapped = true;
            renameSync(workspace, displaced);
            symlinkSync(outside, workspace);
          },
        },
      }),
    ).rejects.toMatchObject({ status: 403, code: "PATH_ESCAPE" });
    expect(swapped).toBe(true);
    expect(await readFile(join(outside, "note.txt"), "utf8")).toBe("inside\n");
    expect(await readFile(join(displaced, "note.txt"), "utf8")).toBe("inside\n");
  });

  it("rejects saving when the file changed after the editor loaded it", async () => {
    const initial = await readFilesContent(store, root, "src/app.ts");
    const filePath = join(root, "src", "app.ts");
    await writeFile(filePath, 'export const value = "other";\n', "utf8");
    const changedAt = new Date(initial.modifiedAt + 10_000);
    await utimes(filePath, changedAt, changedAt);

    await expect(
      writeFilesContent({
        store,
        rootInput: root,
        pathInput: "src/app.ts",
        content: 'export const value = "stale";\n',
        expectedModifiedAt: initial.modifiedAt,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "WRITE_CONFLICT",
    });
  });

  // ─── Editor session metadata (Issue #1197) ──────────────────────────────────────
  it("returns content-free editor-session version metadata on read", async () => {
    const content = await readFilesContent(store, root, "src/app.ts");

    expect(content.session.schemaVersion).toBe(EDITOR_SESSION_SCHEMA_VERSION);
    expect(content.session.version.sizeBytes).toBe(content.sizeBytes);
    expect(content.session.version.modifiedAt).toBe(content.modifiedAt);
    expect(content.session.version.contentHash).toBe(sha256Hex(content.content));
    expect(content.session.version.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    // The hash is a digest, never the content itself.
    expect(content.session.version.contentHash).not.toContain("const value");
  });

  it("returns a fresh version on write whose hash reflects the saved content", async () => {
    const initial = await readFilesContent(store, root, "src/app.ts");
    const next = 'export const value = "changed";\n';

    const saved = await writeFilesContent({
      store,
      rootInput: root,
      pathInput: "src/app.ts",
      content: next,
      baseVersion: initial.session.version,
    });

    expect(saved.session.version.contentHash).toBe(sha256Hex(next));
    expect(saved.session.version.contentHash).not.toBe(initial.session.version.contentHash);
    expect(saved.session.version.sizeBytes).toBe(Buffer.byteLength(next, "utf8"));
  });

  it("rejects a save with STALE_SESSION when the document changed since it was opened", async () => {
    const initial = await readFilesContent(store, root, "src/app.ts");
    await writeFile(join(root, "src", "app.ts"), 'export const value = "other";\n', "utf8");

    await expect(
      writeFilesContent({
        store,
        rootInput: root,
        pathInput: "src/app.ts",
        content: 'export const value = "stale";\n',
        baseVersion: initial.session.version,
      }),
    ).rejects.toMatchObject({ status: 409, code: "STALE_SESSION" });
  });

  it("detects a stale session by content hash even when size and mtime are unchanged", async () => {
    const initial = await readFilesContent(store, root, "src/app.ts");
    // A different contentHash with the live size/mtime simulates a same-length on-disk change.
    const forged = {
      ...initial.session.version,
      contentHash: sha256Hex("different but same length"),
    };

    await expect(
      writeFilesContent({
        store,
        rootInput: root,
        pathInput: "src/app.ts",
        content: "anything\n",
        baseVersion: forged,
      }),
    ).rejects.toMatchObject({ status: 409, code: "STALE_SESSION" });
  });

  it("saves when the supplied baseVersion still matches the document on disk", async () => {
    const initial = await readFilesContent(store, root, "src/app.ts");

    const saved = await writeFilesContent({
      store,
      rootInput: root,
      pathInput: "src/app.ts",
      content: 'export const value = "fresh";\n',
      baseVersion: initial.session.version,
    });

    expect(saved.content).toBe('export const value = "fresh";\n');
  });

  // KEIKO-0495: the optimistic-concurrency check was a check-then-act. Two saves carrying the SAME
  // baseVersion could both clear assertNoWriteConflict before either wrote, and the second silently
  // overwrote the first with no STALE_SESSION for the loser — a lost update with no signal.
  //
  // The assertion is serialization itself, not just its outcome: the first writer is parked AFTER its
  // conflict check and BEFORE its write, and the contender must not be able to pass its own conflict
  // check while that hold lasts. `runExclusive` installs its release gate synchronously, before its
  // first await, so once `onQueued` has fired the contender is provably queued on the key — nothing
  // here depends on the scheduler. `settleFileSystemTurns` then drives real filesystem round-trips on
  // the same path so the contender's own earlier-submitted stat() has certainly completed; an
  // unserialized contender would have reached its conflict check by then and tripped the flag.
  //
  // The outcome assertions below are a second, independent detector: with serialization removed both
  // saves clear their checks against the pre-write snapshot and both succeed, which is the lost update.
  it("holds a contending save out of the critical section until the holder's write completes", async () => {
    const initial = await readFilesContent(store, root, "src/app.ts");
    let releaseHolder!: () => void;
    const held = new Promise<void>((releaseIt) => {
      releaseHolder = (): void => {
        releaseIt();
      };
    });
    let holderParked!: () => void;
    const holderInside = new Promise<void>((parked) => {
      holderParked = parked;
    });

    const first = writeFilesContent({
      store,
      rootInput: root,
      pathInput: "src/app.ts",
      content: 'export const value = "first";\n',
      baseVersion: initial.session.version,
      testControl: {
        afterConflictCheck: async (): Promise<void> => {
          holderParked();
          await held;
        },
      },
    });
    await holderInside;

    let contenderQueued!: () => void;
    const queued = new Promise<void>((resolveQueued) => {
      contenderQueued = resolveQueued;
    });
    let contenderPassedCheckWhileHeld = false;
    let holderStillParked = true;
    const second = writeFilesContent({
      store,
      rootInput: root,
      pathInput: "src/app.ts",
      content: 'export const value = "second";\n',
      baseVersion: initial.session.version,
      testControl: {
        onQueued: contenderQueued,
        afterConflictCheck: (): void => {
          if (holderStillParked) contenderPassedCheckWhileHeld = true;
        },
      },
    });
    await queued;
    await settleFileSystemTurns(join(root, "src/app.ts"));

    expect(contenderPassedCheckWhileHeld).toBe(false);

    holderStillParked = false;
    releaseHolder();

    const results = await Promise.allSettled([first, second]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { status: 409, code: "STALE_SESSION" } });

    const onDisk = await readFilesContent(store, root, "src/app.ts");
    expect(['export const value = "first";\n', 'export const value = "second";\n']).toContain(
      onDisk.content,
    );
  });

  // The in-lock re-stat can fail for reasons that are NOT a concurrent rename. Mapping all of them
  // to 409 STALE_PATH would hide a 403 DENIED or a 500 IO_ERROR behind a retryable-looking status.
  it.each([
    { code: "ENOENT", status: 409, label: "vanished" },
    { code: "ENOTDIR", status: 409, label: "parent replaced by a file" },
  ])("maps $label to STALE_PATH", ({ code, status }) => {
    const mapped = classifyInLockRefreshFailure(Object.assign(new Error("x"), { code }));
    expect(mapped.status).toBe(status);
    expect(mapped.code).toBe("STALE_PATH");
  });

  it("preserves permission and I/O failures from the in-lock refresh", () => {
    const denied = classifyInLockRefreshFailure(Object.assign(new Error("x"), { code: "EACCES" }));
    expect(denied.status).not.toBe(409);
    expect(denied.code).not.toBe("STALE_PATH");

    const io = classifyInLockRefreshFailure(Object.assign(new Error("x"), { code: "EIO" }));
    expect(io.status).toBe(500);
    expect(io.code).toBe("IO_ERROR");

    // A thrown non-Error carries no errno and must not masquerade as staleness either.
    expect(classifyInLockRefreshFailure("boom").code).not.toBe("STALE_PATH");
  });

  it("prefers baseVersion over expectedModifiedAt for conflict detection", async () => {
    const initial = await readFilesContent(store, root, "src/app.ts");

    // A matching baseVersion plus a deliberately stale expectedModifiedAt must still succeed,
    // proving baseVersion takes precedence over the legacy mtime-only check.
    const saved = await writeFilesContent({
      store,
      rootInput: root,
      pathInput: "src/app.ts",
      content: 'export const value = "precedence";\n',
      baseVersion: initial.session.version,
      expectedModifiedAt: initial.session.version.modifiedAt - 10_000,
    });

    expect(saved.content).toBe('export const value = "precedence";\n');
  });

  it("accepts a baseVersion modifiedAt within the 1ms tolerance but rejects beyond it", async () => {
    const initial = await readFilesContent(store, root, "src/app.ts");
    // Same content+size, mtime nudged +1ms: inside the tolerance, so the save succeeds.
    const within = {
      ...initial.session.version,
      modifiedAt: initial.session.version.modifiedAt + 1,
    };
    const saved = await writeFilesContent({
      store,
      rootInput: root,
      pathInput: "src/app.ts",
      content: 'export const value = "within";\n',
      baseVersion: within,
    });
    expect(saved.content).toBe('export const value = "within";\n');

    // Re-read the now-current revision, then nudge mtime +2ms: outside the tolerance → STALE_SESSION.
    const reread = await readFilesContent(store, root, "src/app.ts");
    const beyond = {
      ...reread.session.version,
      modifiedAt: reread.session.version.modifiedAt + 2,
    };
    await expect(
      writeFilesContent({
        store,
        rootInput: root,
        pathInput: "src/app.ts",
        content: 'export const value = "beyond";\n',
        baseVersion: beyond,
      }),
    ).rejects.toMatchObject({ status: 409, code: "STALE_SESSION" });
  });

  it("computes a content-free session for a 0-byte file and round-trips a save", async () => {
    await writeFile(join(root, "empty.ts"), "", "utf8");
    const initial = await readFilesContent(store, root, "empty.ts");

    expect(initial.content).toBe("");
    expect(initial.session.version.sizeBytes).toBe(0);
    expect(initial.session.version.contentHash).toBe(sha256Hex(""));

    const saved = await writeFilesContent({
      store,
      rootInput: root,
      pathInput: "empty.ts",
      content: "const filled = 1;\n",
      baseVersion: initial.session.version,
    });
    expect(saved.session.version.sizeBytes).toBe(Buffer.byteLength("const filled = 1;\n", "utf8"));
  });

  it("handles the editable surface exactly at the size limit and rejects one byte over", async () => {
    const atLimit = "a".repeat(MAX_TEXT_PREVIEW_BYTES);
    await writeFile(join(root, "atlimit.ts"), atLimit, "utf8");
    const initial = await readFilesContent(store, root, "atlimit.ts");
    expect(initial.session.version.sizeBytes).toBe(MAX_TEXT_PREVIEW_BYTES);
    expect(initial.session.version.contentHash).toBe(sha256Hex(atLimit));

    const saved = await writeFilesContent({
      store,
      rootInput: root,
      pathInput: "atlimit.ts",
      content: "shrunk\n",
      baseVersion: initial.session.version,
    });
    expect(saved.content).toBe("shrunk\n");

    await writeFile(join(root, "over.ts"), "a".repeat(MAX_TEXT_PREVIEW_BYTES + 1), "utf8");
    await expect(readFilesContent(store, root, "over.ts")).rejects.toMatchObject({
      status: 413,
      code: "FILE_TOO_LARGE",
    });
  });

  it("never echoes file content or secrets in the STALE_SESSION error", async () => {
    await writeFile(
      join(root, "secret.ts"),
      'const token = "sk-do-not-leak-1234567890";\n',
      "utf8",
    );
    const initial = await readFilesContent(store, root, "secret.ts");
    await writeFile(join(root, "secret.ts"), 'const token = "sk-rotated-0987654321";\n', "utf8");

    const error = await writeFilesContent({
      store,
      rootInput: root,
      pathInput: "secret.ts",
      content: 'const token = "sk-newvalue";\n',
      baseVersion: initial.session.version,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 409, code: "STALE_SESSION" });
    const message = (error as { message: string }).message;
    expect(message).not.toContain("sk-");
    expect(message).not.toContain("token");
    expect(message).not.toContain(root);
  });

  it("rejects a malformed baseVersion at the route with a content-free 400", async () => {
    const result = await handleFilesContent(
      patchContentContext({
        root,
        path: "src/app.ts",
        content: "export const value = 1;\n",
        baseVersion: { sizeBytes: 1, modifiedAt: 1, contentHash: "not-a-valid-hash" },
      }),
      { store, redactor: buildRedactor({}) } as unknown as UiHandlerDeps,
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("KEIKO-0799: rejects a non-number expectedModifiedAt with a 400 instead of silently coercing to undefined", async () => {
    const result = await handleFilesContent(
      patchContentContext({
        root,
        path: "src/app.ts",
        content: "export const value = 1;\n",
        expectedModifiedAt: "not-a-number",
      }),
      { store, redactor: buildRedactor({}) } as unknown as UiHandlerDeps,
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    // The file on disk must be unchanged when the concurrency check was skipped for a malformed value.
    await expect(readFile(join(root, "src", "app.ts"), "utf8")).resolves.toBe(
      'const value: string = "ok";\n',
    );
  });

  it("KEIKO-0799: rejects a null expectedModifiedAt with a 400 (the JSON coerce of NaN via JSON.stringify)", async () => {
    // JSON.stringify(NaN) emits `null`, and a naive `typeof body.expectedModifiedAt === "number"`
    // check would treat that as undefined and skip the concurrency check silently. Fail closed.
    const result = await handleFilesContent(
      patchContentContext({
        root,
        path: "src/app.ts",
        content: "x",
        expectedModifiedAt: null,
      }),
      { store, redactor: buildRedactor({}) } as unknown as UiHandlerDeps,
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("reports a connected user save as protected after capturing the persisted revision", async () => {
    const captures: EditorLocalHistoryCaptureInput[] = [];
    const history = {
      capture: (input: EditorLocalHistoryCaptureInput) => {
        captures.push(input);
        return {};
      },
    } as unknown as EditorLocalHistoryStore;
    const content = "saved with local history\n";

    const result = await handleFilesContent(
      patchContentContext({ root, path: "src/app.ts", content }),
      {
        store,
        redactor: buildRedactor({}),
        editorLocalHistoryStore: history,
      } as unknown as UiHandlerDeps,
    );

    expect(result).toMatchObject({
      status: 200,
      body: { content, localHistoryProtection: { status: "protected" } },
    });
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      content,
      origin: "user-save",
      realRoot: root,
      relativePath: "src/app.ts",
    });
  });

  it("keeps a user save successful when local-history capture fails", async () => {
    const diagnostics: ServerDiagnosticRecord[] = [];
    const secret = "capture-secret-marker";
    const failingVault: LocalSecretVault = {
      get: () => undefined,
      set: (): never => {
        throw new Error(secret);
      },
      setMany: (): never => {
        throw new Error(secret);
      },
      replaceAll: () => undefined,
      delete: () => undefined,
      deleteMany: () => undefined,
      has: () => false,
      list: () => [],
    };
    const failingHistory = createEditorLocalHistoryStore({
      stateDir: join(root, ".history-test-state"),
      env: {},
      vaultFactory: () => failingVault,
    });
    const result = await handleFilesContent(
      patchContentContext({ root, path: "src/app.ts", content: "saved despite history failure\n" }),
      {
        store,
        redactor: buildRedactor({}),
        editorLocalHistoryStore: failingHistory,
        diagnostics: {
          record: (record: ServerDiagnosticRecord): void => {
            diagnostics.push(record);
          },
        },
      } as unknown as UiHandlerDeps,
    );

    expect(result).toMatchObject({
      status: 200,
      body: {
        content: "saved despite history failure\n",
        localHistoryProtection: {
          status: "degraded",
          reason: "history-unavailable",
        },
      },
    });
    await expect(readFile(join(root, "src", "app.ts"), "utf8")).resolves.toBe(
      "saved despite history failure\n",
    );
    expect(diagnostics).toHaveLength(1);
    const diagnostic = diagnostics[0];
    expect(diagnostic).toMatchObject({
      operation: "user-save",
      source: "editor.local-history.capture",
      code: "LOCAL_HISTORY_VAULT_WRITE_FAILED",
    });
    expect(result.body).toMatchObject({
      localHistoryProtection: { correlationId: diagnostic?.correlationId },
    });
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
    expect(JSON.stringify(diagnostics)).not.toContain("saved despite history failure");
  });

  it("threads the request's own correlation id into a local-history capture failure instead of minting one", async () => {
    // ADR-0173 D5 / g12: ctx.correlationId is minted at request entry (server.ts) and is already
    // in scope in writeFilesContentRoute — the capture failure must reuse it, not a disconnected
    // one. Before the fix the diagnostic and response always carried a fresh mint regardless of
    // ctx.correlationId.
    const diagnostics: ServerDiagnosticRecord[] = [];
    const failingVault: LocalSecretVault = {
      get: () => undefined,
      set: (): never => {
        throw new Error("capture-secret-marker-2");
      },
      setMany: (): never => {
        throw new Error("capture-secret-marker-2");
      },
      replaceAll: () => undefined,
      delete: () => undefined,
      deleteMany: () => undefined,
      has: () => false,
      list: () => [],
    };
    const failingHistory = createEditorLocalHistoryStore({
      stateDir: join(root, ".history-test-state-correlation"),
      env: {},
      vaultFactory: () => failingVault,
    });
    const ctx = {
      ...patchContentContext({ root, path: "src/app.ts", content: "threaded id\n" }),
      correlationId: "req-files-save-thread-01",
    };

    const result = await handleFilesContent(ctx, {
      store,
      redactor: buildRedactor({}),
      editorLocalHistoryStore: failingHistory,
      diagnostics: {
        record: (record: ServerDiagnosticRecord): void => {
          diagnostics.push(record);
        },
      },
    } as unknown as UiHandlerDeps);

    expect(result.status).toBe(200);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.correlationId).toBe("req-files-save-thread-01");
    expect(result.body).toMatchObject({
      localHistoryProtection: { correlationId: "req-files-save-thread-01" },
    });
  });

  it("fails closed for an unregistered root while preserving the save and original diagnostic", async () => {
    const arbitrary = await realpath(await mkdtemp(join(tmpdir(), "keiko-files-unregistered-")));
    extraRoot = arbitrary;
    await mkdir(join(arbitrary, "src"));
    await writeFile(join(arbitrary, "src", "app.ts"), "before\n", "utf8");
    const diagnostics: ServerDiagnosticRecord[] = [];
    let captureCount = 0;
    const history = {
      capture: () => {
        captureCount += 1;
        return {};
      },
    } as unknown as EditorLocalHistoryStore;

    const result = await handleFilesContent(
      patchContentContext({ root: arbitrary, path: "src/app.ts", content: "after\n" }),
      {
        store,
        redactor: buildRedactor({}),
        editorLocalHistoryStore: history,
        diagnostics: { record: (record: ServerDiagnosticRecord) => diagnostics.push(record) },
      } as unknown as UiHandlerDeps,
    );

    expect(result).toMatchObject({
      status: 200,
      body: {
        content: "after\n",
        localHistoryProtection: {
          status: "degraded",
          reason: "workspace-unavailable",
          correlationId: diagnostics[0]?.correlationId,
        },
      },
    });
    expect(captureCount).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      source: "editor.local-history.capture",
      code: "LOCAL_HISTORY_INVALID_CAPTURE_NOT_A_MEMBER",
    });
    await expect(readFile(join(arbitrary, "src", "app.ts"), "utf8")).resolves.toBe("after\n");
  });

  it("captures the pre-restore bytes before a conflict-aware restore save", async () => {
    const initial = await readFilesContent(store, root, "src/app.ts");
    const captures: EditorLocalHistoryCaptureInput[] = [];
    const history = {
      capture: (input: EditorLocalHistoryCaptureInput) => {
        captures.push(input);
        return {};
      },
    } as unknown as EditorLocalHistoryStore;
    const restoredContent = 'const value: string = "restored";\n';

    const result = await handleFilesContent(
      patchContentContext({
        root,
        path: "src/app.ts",
        content: restoredContent,
        baseVersion: initial.session.version,
        historyOrigin: "pre-restore",
      }),
      {
        store,
        redactor: buildRedactor({}),
        editorLocalHistoryStore: history,
      } as unknown as UiHandlerDeps,
    );

    expect(result).toMatchObject({ status: 200, body: { content: restoredContent } });
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      content: 'const value: string = "ok";\n',
      origin: "pre-restore",
    });
    await expect(readFile(join(root, "src", "app.ts"), "utf8")).resolves.toBe(restoredContent);
  });

  it("keeps denied-path precedence before malformed baseVersion validation at the route", async () => {
    await writeFile(join(root, ".env.local"), "API_KEY=value\n");

    const result = await handleFilesContent(
      patchContentContext({
        root,
        path: ".env.local",
        content: "API_KEY=changed\n",
        baseVersion: { sizeBytes: 1, modifiedAt: 1, contentHash: "not-a-valid-hash" },
      }),
      { store, redactor: buildRedactor({}) } as unknown as UiHandlerDeps,
    );

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: "DENIED" } });
  });

  it("threads a valid stale baseVersion through the route to STALE_SESSION", async () => {
    const initial = await readFilesContent(store, root, "src/app.ts");
    await writeFile(join(root, "src", "app.ts"), 'const value = "moved";\n', "utf8");

    const result = await handleFilesContent(
      patchContentContext({
        root,
        path: "src/app.ts",
        content: 'const value = "save";\n',
        baseVersion: initial.session.version,
      }),
      { store, redactor: buildRedactor({}) } as unknown as UiHandlerDeps,
    );

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: { code: "STALE_SESSION" } });
  });

  it("never echoes file content, secrets, or roots in the route STALE_SESSION response", async () => {
    await writeFile(
      join(root, "secret.ts"),
      'const token = "sk-do-not-leak-1234567890";\n',
      "utf8",
    );
    const initial = await readFilesContent(store, root, "secret.ts");
    await writeFile(join(root, "secret.ts"), 'const token = "sk-rotated-0987654321";\n', "utf8");

    const result = await handleFilesContent(
      patchContentContext({
        root,
        path: "secret.ts",
        content: 'const token = "sk-newvalue";\n',
        baseVersion: initial.session.version,
      }),
      { store, redactor: buildRedactor({}) } as unknown as UiHandlerDeps,
    );

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: { code: "STALE_SESSION" } });
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain(root);
  });

  it("refuses to preview .env.local (matches the .env.* deny pattern)", async () => {
    await writeFile(join(root, ".env.local"), "API_KEY=value\n");

    await expect(
      readFilesPreview(store, root, ".env.local", buildRedactor({})),
    ).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
  });

  it("refuses to read or write denied editor content", async () => {
    await writeFile(join(root, ".env.local"), "API_KEY=value\n");

    await expect(readFilesContent(store, root, ".env.local")).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
    await expect(
      writeFilesContent({
        store,
        rootInput: root,
        pathInput: ".env.local",
        content: "API_KEY=changed\n",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
  });

  it("returns image previews below the image cap", async () => {
    const preview = await readFilesPreview(store, root, "assets/pixel.png", buildRedactor({}));

    expect(preview.kind).toBe("image");
    if (preview.kind === "image") {
      expect(preview.url).toMatch(/^\/api\/files\/preview\/image\?/u);
      expect(preview.url).toContain("path=assets%2Fpixel.png");
      expect(preview.maxBytes).toBe(3_000_000);
    }
  });

  it("serves the admitted image bytes under a Content-Length that describes them", async () => {
    const call = imagePreviewCall(root, "assets/pixel.png", () => undefined);

    const outcome = await handleFilesPreviewImage(call.ctx, {
      store,
      redactor: buildRedactor({}),
    } as unknown as UiHandlerDeps);
    await call.finished;

    expect(outcome).toBe(STREAMING);
    expect(call.response.writeHeadCalls).toEqual([
      {
        statusCode: 200,
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(PNG_1X1.byteLength),
          "Cache-Control": "private, max-age=60",
        },
      },
    ]);
    expect(call.bytes()).toEqual(PNG_1X1);
  });

  // #3367 owner P1, reproduced on the current head: this route wrote its 200 headers from the
  // admission-time size and only THEN opened `target.path` with a bare createReadStream, so a
  // parent replaced in that gap redirected the open — the response carried bytes from a different
  // inode OUTSIDE the admitted root, under a Content-Length taken from the admitted file. The
  // substitute here is deliberately the same LENGTH as the admitted image, so neither the header
  // nor a downstream byte count could have noticed. Staged at writeHead: the exact instant the old
  // code committed its headers, and the last moment before the old read began.
  it("never streams a same-size parent swap staged at the image route's header commit", async () => {
    extraRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-files-outside-")));
    const outsideAssets = join(extraRoot, "assets");
    await mkdir(outsideAssets);
    const outsideBytes = Buffer.alloc(PNG_1X1.byteLength, 0x41);
    await writeFile(join(outsideAssets, "pixel.png"), outsideBytes);
    const deps = { store, redactor: buildRedactor({}) } as unknown as UiHandlerDeps;
    let swapped = false;
    const call = imagePreviewCall(root, "assets/pixel.png", () => {
      swapped = true;
      rmSync(join(root, "assets"), { recursive: true, force: true });
      symlinkSync(outsideAssets, join(root, "assets"), "dir");
    });

    const outcome = await handleFilesPreviewImage(call.ctx, deps);
    await call.finished;

    expect(swapped).toBe(true);
    expect(outcome).toBe(STREAMING);
    expect(call.bytes()).toEqual(PNG_1X1);
    expect(call.bytes()).not.toEqual(outsideBytes);
    // The swap really landed, and really was indistinguishable by size from the admitted image.
    expect(await readFile(join(root, "assets", "pixel.png"))).toEqual(outsideBytes);
    expect(outsideBytes.byteLength).toBe(PNG_1X1.byteLength);
    // A fresh request through the swapped parent is refused outright: the outside bytes are not
    // reachable through this route at all, in the gap or after it.
    const second = imagePreviewCall(root, "assets/pixel.png", () => undefined);
    await expect(handleFilesPreviewImage(second.ctx, deps)).resolves.toMatchObject({
      status: 403,
    });
  });

  it("returns metadata for unsupported binary files", async () => {
    const preview = await readFilesPreview(store, root, "archive.bin", buildRedactor({}));

    expect(preview).toMatchObject({
      kind: "binary",
      reason: "unsupported",
      extension: "bin",
    });
  });

  it("refuses invalid UTF-8 even for known text extensions and preserves bytes on save", async () => {
    const badBytes = Buffer.from([0xff, 0xfe, 0x61, 0x0a]);
    await writeFile(join(root, "bad.txt"), badBytes);

    const preview = await readFilesPreview(store, root, "bad.txt", buildRedactor({}));
    expect(preview).toMatchObject({ kind: "binary", reason: "unsupported", extension: "txt" });

    await expect(readFilesContent(store, root, "bad.txt")).rejects.toMatchObject({
      status: 400,
      code: "UNSUPPORTED_FILE",
    });
    await expect(
      writeFilesContent({
        store,
        rootInput: root,
        pathInput: "bad.txt",
        content: "replacement\n",
      }),
    ).rejects.toMatchObject({ status: 400, code: "UNSUPPORTED_FILE" });

    expect(await readFile(join(root, "bad.txt"))).toEqual(badBytes);
  });

  it("treats a mostly-printable file containing a supplementary-plane character as editable text", async () => {
    // "😀" (U+1F600) is a 2-UTF-16-code-unit surrogate pair. The printable-ratio scan iterates by
    // Unicode code point and must not misclassify it as a non-printable control character (which
    // would push the ratio below the 0.85 editable threshold and reject the file as binary).
    const content = "Hello 😀 world, this is plain UTF-8 text with an emoji in it.\n";
    await writeFile(join(root, "greeting"), content, "utf8");

    const preview = await readFilesPreview(store, root, "greeting", buildRedactor({}));
    expect(preview.kind).toBe("text");

    const opened = await readFilesContent(store, root, "greeting");
    expect(opened.content).toBe(content);
  });

  it("caps large text previews", async () => {
    const content = `${"a".repeat(1_000_050)}tail`;
    await writeFile(join(root, "large.txt"), content);

    const preview = await readFilesPreview(store, root, "large.txt", buildRedactor({}));

    expect(preview.kind).toBe("text");
    if (preview.kind === "text") {
      expect(preview.truncated).toBe(true);
      expect(preview.content).toHaveLength(1_000_000);
      expect(preview.maxBytes).toBe(1_000_000);
    }
  });

  it("caps large image previews to metadata", async () => {
    await writeFile(join(root, "huge.png"), Buffer.alloc(3_000_001, 1));

    const preview = await readFilesPreview(store, root, "huge.png", buildRedactor({}));

    expect(preview).toMatchObject({
      kind: "binary",
      reason: "too_large",
      maxBytes: 3_000_000,
    });
  });

  it("caps directory listings at 1000 entries", async () => {
    const many = join(root, "many");
    await mkdir(many);
    await Promise.all(
      Array.from({ length: 1_005 }, (_, index) =>
        writeFile(join(many, `file-${String(index).padStart(4, "0")}.txt`), "\n"),
      ),
    );

    const listing = await readFilesTree(store, root, "many");

    expect(listing.entries).toHaveLength(1_000);
    expect(listing.truncated).toBe(true);
  });

  it("filters deny-listed entries from the tree (including the .env.example exception)", async () => {
    await writeFile(join(root, ".env"), "SECRET=1\n");
    await writeFile(join(root, ".env.example"), "SECRET=example\n");
    await writeFile(join(root, "id_rsa"), "-----BEGIN PRIVATE KEY-----\n");
    await writeFile(join(root, "server.pem"), "-----BEGIN CERTIFICATE-----\n");
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "foo.js"), "module.exports = 1;\n");
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await mkdir(join(root, ".keiko"));
    await writeFile(join(root, ".keiko", "state.json"), "{}\n");
    await mkdir(join(root, ".codex"));
    await writeFile(join(root, ".codex", "history.jsonl"), "{}\n");
    await mkdir(join(root, ".claude"));
    await writeFile(join(root, ".claude", "transcript.jsonl"), "{}\n");
    await mkdir(join(root, ".playwright-mcp"));
    await writeFile(join(root, ".playwright-mcp", "session.json"), "{}\n");
    await mkdir(join(root, ".idea"));
    await writeFile(join(root, ".idea", "workspace.xml"), "<workspace />\n");
    await writeFile(join(root, "keiko.config.json"), "{}\n");

    const listing = await readFilesTree(store, root, "");
    const names = listing.entries.map((entry) => entry.name);

    expect(names).toContain(".env.example");
    expect(names).not.toContain(".env");
    expect(names).not.toContain("id_rsa");
    expect(names).not.toContain("server.pem");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    expect(names).not.toContain(".keiko");
    expect(names).not.toContain(".codex");
    expect(names).not.toContain(".claude");
    expect(names).not.toContain(".playwright-mcp");
    expect(names).not.toContain(".idea");
    expect(names).not.toContain("keiko.config.json");
  });

  it("rejects navigation into a denied subtree with 403 DENIED", async () => {
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");

    await expect(readFilesTree(store, root, ".git")).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
  });

  it("returns 403 DENIED when previewing deny-listed files", async () => {
    await writeFile(join(root, ".env"), "SECRET=1\n");
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "foo.js"), "module.exports = 1;\n");

    await expect(readFilesPreview(store, root, ".env", buildRedactor({}))).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
    await expect(
      readFilesPreview(store, root, "node_modules/foo.js", buildRedactor({})),
    ).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
  });

  it("returns 403 DENIED for non-existent denied paths (no existence probing)", async () => {
    // No file is created. A denied path that does not exist must still return
    // 403 DENIED — never 404 — so callers cannot tell whether a deny-listed
    // file exists under the selected root.
    await expect(readFilesPreview(store, root, ".env", buildRedactor({}))).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
    await expect(readFilesTree(store, root, ".git")).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
    await expect(
      readFilesPreview(store, root, "node_modules/missing.js", buildRedactor({})),
    ).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
  });

  it("allows previewing .env.example as text", async () => {
    await writeFile(join(root, ".env.example"), "# example env template\n");

    const preview = await readFilesPreview(store, root, ".env.example", buildRedactor({}));

    expect(preview.kind).toBe("text");
    if (preview.kind === "text") {
      expect(preview.content).toContain("example env template");
      expect(preview.extension).toBe("env");
    }
  });

  it("excludes denied entries from the truncation budget", async () => {
    const many = join(root, "many");
    await mkdir(many);
    // 1_005 deny-listed *.pem files plus a handful of real files. The truncation
    // counter must skip the *.pem entries entirely; otherwise the real files
    // would be hidden behind `truncated: true`.
    await Promise.all(
      Array.from({ length: 1_005 }, (_, index) =>
        writeFile(join(many, `cert-${String(index).padStart(4, "0")}.pem`), "\n"),
      ),
    );
    await writeFile(join(many, "real-a.txt"), "a\n");
    await writeFile(join(many, "real-b.txt"), "b\n");
    await writeFile(join(many, "real-c.txt"), "c\n");

    const listing = await readFilesTree(store, root, "many");
    const names = listing.entries.map((entry) => entry.name);

    expect(listing.truncated).toBe(false);
    expect(names).toEqual(["real-a.txt", "real-b.txt", "real-c.txt"]);
  });

  it("shows safe hidden and .gitignore-matched entries in tree listings", async () => {
    await writeFile(join(root, ".gitignore"), "generated/\nartifact.txt\n");
    await writeFile(join(root, ".toolrc"), "tool config\n");
    await mkdir(join(root, ".safe-hidden"));
    await writeFile(join(root, ".safe-hidden", "note.txt"), "hidden note\n");
    await mkdir(join(root, "generated"));
    await writeFile(join(root, "generated", "bundle.js"), "// bundle\n");
    await writeFile(join(root, "artifact.txt"), "artifact\n");
    await writeFile(join(root, "keep.txt"), "keep\n");

    const listing = await readFilesTree(store, root, "");
    const names = listing.entries.map((entry) => entry.name);

    expect(names).toContain("keep.txt");
    expect(names).toContain(".gitignore");
    expect(names).toContain(".toolrc");
    expect(names).toContain(".safe-hidden");
    expect(names).toContain("generated");
    expect(names).toContain("artifact.txt");
  });

  it("still previews .gitignore-matched files (preview is not best-effort)", async () => {
    // .gitignore is not a Files visibility or preview policy boundary. A user clicking through a
    // direct URL to an ignored (but not denied) file must receive a preview.
    await writeFile(join(root, ".gitignore"), "artifact.txt\n");
    await writeFile(join(root, "artifact.txt"), "artifact content\n");

    const preview = await readFilesPreview(store, root, "artifact.txt", buildRedactor({}));

    expect(preview.kind).toBe("text");
    if (preview.kind === "text") {
      expect(preview.content).toContain("artifact content");
    }
  });

  it("lists ordinary files without requiring .gitignore", async () => {
    await writeFile(join(root, "ordinary.txt"), "kept\n");

    const listing = await readFilesTree(store, root, "");
    const names = listing.entries.map((entry) => entry.name);

    expect(names).toContain("ordinary.txt");
  });
});

describe("desktop files mutations (create / rename / delete)", () => {
  let root: string;
  let store: UiStore;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "keiko-files-mut-")));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "app.ts"), "export const a = 1;\n");
    store = createInMemoryUiStore();
    store.createProject(root, "fixture");
    notifyHostLspMock.mockClear();
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("creates a file and a directory inside the root", async () => {
    const file = await createFilesEntry({
      store,
      rootInput: root,
      pathInput: "src/new.ts",
      kind: "file",
    });
    expect(file).toMatchObject({ path: "src/new.ts", kind: "file" });
    const content = await readFile(join(root, "src", "new.ts"), "utf8");
    expect(content).toBe("");

    const dir = await createFilesEntry({
      store,
      rootInput: root,
      pathInput: "lib",
      kind: "directory",
    });
    expect(dir).toMatchObject({ path: "lib", kind: "directory" });
    expect((await stat(join(root, "lib"))).isDirectory()).toBe(true);
  });

  it("never overwrites an existing entry on create (atomic O_EXCL)", async () => {
    await expect(
      createFilesEntry({ store, rootInput: root, pathInput: "src/app.ts", kind: "file" }),
    ).rejects.toMatchObject({ status: 409, code: "ALREADY_EXISTS" });
  });

  it("rejects creating outside the root, inside the deny list, or with a missing parent", async () => {
    await expect(
      createFilesEntry({ store, rootInput: root, pathInput: "../escape.ts", kind: "file" }),
    ).rejects.toMatchObject({ status: 400, code: "PATH_ESCAPE" });
    await expect(
      createFilesEntry({ store, rootInput: root, pathInput: ".git/hooks/evil", kind: "file" }),
    ).rejects.toMatchObject({ status: 403, code: "DENIED" });
    await expect(
      createFilesEntry({ store, rootInput: root, pathInput: "node_modules/x.ts", kind: "file" }),
    ).rejects.toMatchObject({ status: 403, code: "DENIED" });
    await expect(
      createFilesEntry({ store, rootInput: root, pathInput: "missing/deep/file.ts", kind: "file" }),
    ).rejects.toMatchObject({ status: 404, code: "PARENT_NOT_FOUND" });
    await expect(
      createFilesEntry({ store, rootInput: root, pathInput: "", kind: "file" }),
    ).rejects.toMatchObject({ status: 400, code: "BAD_PATH" });
  });

  it("renames a file and reports the previous path", async () => {
    const result = await renameFilesEntry({
      store,
      rootInput: root,
      pathInput: "src/app.ts",
      newPathInput: "src/renamed.ts",
    });
    expect(result).toMatchObject({
      path: "src/renamed.ts",
      previousPath: "src/app.ts",
      kind: "file",
    });
    await expect(stat(join(root, "src", "app.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "src", "renamed.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  // KEIKO-0179 follow-up (Codex P1, twice-raised on PR #3141): the actual store re-keying, adapter
  // re-arming, and single breakpoints-changed publish now live entirely in
  // dapDebugRoutes.ts's DapDebugRouteService.renameInstrumentation (see dapDebugRoutes.test.ts for
  // that behavior). These tests cover only files.ts's side of the seam: which affected fileIds it
  // computes from the live store and that it delegates them in exactly one call.
  it("delegates every affected fileId to the DAP service in one call on a file rename (KEIKO-0179)", async () => {
    const debugStateDir = await realpath(await mkdtemp(join(tmpdir(), "keiko-files-mut-dap-")));
    const breakpoints = createBreakpointStore({ stateDir: debugStateDir });
    const initial = breakpoints.snapshot(root);
    if (!initial.ok) throw new Error("expected an available breakpoint snapshot");
    const armed = breakpoints.setBreakpointsForFile(
      root,
      initial.snapshot.revision,
      initial.snapshot.etag,
      "src/app.ts",
      [{ line: 1, enabled: true }],
    );
    expect(armed.ok).toBe(true);
    const renameInstrumentation = vi.fn().mockResolvedValue(undefined);

    const result = await handleFilesRename(
      patchContentContext({ root, path: "src/app.ts", newPath: "src/renamed.ts" }),
      {
        store,
        redactor: buildRedactor({}),
        dapDebug: { breakpoints, renameInstrumentation },
      } as unknown as UiHandlerDeps,
    );

    expect(result).toMatchObject({
      status: 200,
      body: { path: "src/renamed.ts", previousPath: "src/app.ts" },
    });
    expect(renameInstrumentation).toHaveBeenCalledExactlyOnceWith(root, [
      { previousFileId: "src/app.ts", nextFileId: "src/renamed.ts" },
    ]);
    await rm(debugStateDir, { recursive: true, force: true });
  });

  // Codex review round 6 on PR #3141: an unavailable snapshot used to skip the migration silently,
  // bypassing every downstream diagnostic. The rename must still succeed, but the skip must leave a
  // redacted diagnostic behind.
  it("diagnoses a skipped breakpoint migration when the snapshot is unavailable", async () => {
    const renameInstrumentation = vi.fn().mockResolvedValue(undefined);
    const diagnostics: { operation: string }[] = [];
    const breakpoints = {
      snapshot: (): { readonly ok: false; readonly reason: string } => ({
        ok: false,
        reason: "state_unavailable",
      }),
    };

    const result = await handleFilesRename(
      patchContentContext({ root, path: "src/app.ts", newPath: "src/renamed.ts" }),
      {
        store,
        redactor: buildRedactor({}),
        dapDebug: {
          breakpoints,
          renameInstrumentation,
          diagnosticSink: {
            record: (record: { operation: string }): void => {
              diagnostics.push(record);
            },
          },
        },
      } as unknown as UiHandlerDeps,
    );

    expect(result).toMatchObject({ status: 200, body: { path: "src/renamed.ts" } });
    expect(renameInstrumentation).not.toHaveBeenCalled();
    expect(
      diagnostics.filter((record) => record.operation.endsWith("breakpoint-migration-skipped")),
    ).toHaveLength(1);
  });

  it("sets parentCorrelationId to the spawning rename request's own id on a skipped migration", async () => {
    // ADR-0173 D5 / g12: reKeyRenamedBreakpoints runs detached (never awaited by the rename
    // response), so it mints its own correlationId for this background operation — but the
    // rename request's own ctx.correlationId, when known, must still ride as parentCorrelationId
    // so an operator can join this diagnostic back to the request that spawned it. Before the fix
    // there was no parentCorrelationId field on the emitted record at all.
    const renameInstrumentation = vi.fn().mockResolvedValue(undefined);
    const diagnostics: ServerDiagnosticRecord[] = [];
    const breakpoints = {
      snapshot: (): { readonly ok: false; readonly reason: string } => ({
        ok: false,
        reason: "state_unavailable",
      }),
    };
    const ctx = {
      ...patchContentContext({ root, path: "src/app.ts", newPath: "src/renamed.ts" }),
      correlationId: "req-rename-thread-01",
    };

    const result = await handleFilesRename(ctx, {
      store,
      redactor: buildRedactor({}),
      dapDebug: {
        breakpoints,
        renameInstrumentation,
        diagnosticSink: {
          record: (record: ServerDiagnosticRecord): void => {
            diagnostics.push(record);
          },
        },
      },
    } as unknown as UiHandlerDeps);

    expect(result).toMatchObject({ status: 200, body: { path: "src/renamed.ts" } });
    const skipped = diagnostics.filter((record) =>
      record.operation.endsWith("breakpoint-migration-skipped"),
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.parentCorrelationId).toBe("req-rename-thread-01");
    // The operation's OWN correlationId stays a fresh, disconnected mint (it is not the request's
    // id) — only parentCorrelationId links it back.
    expect(skipped[0]?.correlationId).not.toBe("req-rename-thread-01");
  });

  it("delegates every fileId under a renamed directory in one call (KEIKO-0179)", async () => {
    await writeFile(join(root, "src", "lib.ts"), "export const b = 2;\n");
    const debugStateDir = await realpath(await mkdtemp(join(tmpdir(), "keiko-files-mut-dap-dir-")));
    const breakpoints = createBreakpointStore({ stateDir: debugStateDir });
    const initial = breakpoints.snapshot(root);
    if (!initial.ok) throw new Error("expected an available breakpoint snapshot");
    const armed = breakpoints.setBreakpointsForFile(
      root,
      initial.snapshot.revision,
      initial.snapshot.etag,
      "src/app.ts",
      [{ line: 1, enabled: true }],
    );
    expect(armed.ok).toBe(true);
    const rearmed = breakpoints.setBreakpointsForFile(
      root,
      armed.snapshot.revision,
      armed.snapshot.etag,
      "src/lib.ts",
      [{ line: 2, enabled: true }],
    );
    expect(rearmed.ok).toBe(true);
    const renameInstrumentation = vi.fn().mockResolvedValue(undefined);

    const result = await handleFilesRename(
      patchContentContext({ root, path: "src", newPath: "lib" }),
      {
        store,
        redactor: buildRedactor({}),
        dapDebug: { breakpoints, renameInstrumentation },
      } as unknown as UiHandlerDeps,
    );

    expect(result).toMatchObject({ status: 200, body: { path: "lib", previousPath: "src" } });
    expect(renameInstrumentation).toHaveBeenCalledExactlyOnceWith(root, [
      { previousFileId: "src/app.ts", nextFileId: "lib/app.ts" },
      { previousFileId: "src/lib.ts", nextFileId: "lib/lib.ts" },
    ]);
    await rm(debugStateDir, { recursive: true, force: true });
  });

  it("does not call the DAP service when no breakpoints are affected by a rename (KEIKO-0179)", async () => {
    const debugStateDir = await realpath(
      await mkdtemp(join(tmpdir(), "keiko-files-mut-dap-noevt-")),
    );
    const breakpoints = createBreakpointStore({ stateDir: debugStateDir });
    const initial = breakpoints.snapshot(root);
    if (!initial.ok) throw new Error("expected an available breakpoint snapshot");
    const armed = breakpoints.setBreakpointsForFile(
      root,
      initial.snapshot.revision,
      initial.snapshot.etag,
      "src/unrelated.ts",
      [{ line: 1, enabled: true }],
    );
    expect(armed.ok).toBe(true);
    const renameInstrumentation = vi.fn().mockResolvedValue(undefined);

    const result = await handleFilesRename(
      patchContentContext({ root, path: "src/app.ts", newPath: "src/renamed.ts" }),
      {
        store,
        redactor: buildRedactor({}),
        dapDebug: { breakpoints, renameInstrumentation },
      } as unknown as UiHandlerDeps,
    );

    expect(result).toMatchObject({ status: 200 });
    expect(renameInstrumentation).not.toHaveBeenCalled();
    await rm(debugStateDir, { recursive: true, force: true });
  });

  it("renames a folder and carries its contents", async () => {
    const result = await renameFilesEntry({
      store,
      rootInput: root,
      pathInput: "src",
      newPathInput: "lib",
    });
    expect(result).toMatchObject({ path: "lib", previousPath: "src", kind: "directory" });
    expect(await readFile(join(root, "lib", "app.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  it("refuses to clobber an existing destination on rename", async () => {
    await writeFile(join(root, "src", "other.ts"), "x\n");
    await expect(
      renameFilesEntry({
        store,
        rootInput: root,
        pathInput: "src/app.ts",
        newPathInput: "src/other.ts",
      }),
    ).rejects.toMatchObject({ status: 409, code: "ALREADY_EXISTS" });
  });

  it("deny-checks both ends of a rename and refuses moving a folder into itself", async () => {
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "[core]\n");
    // Source inside the deny list is invisible: it 403s before any move is attempted.
    await expect(
      renameFilesEntry({
        store,
        rootInput: root,
        pathInput: ".git/config",
        newPathInput: "src/config",
      }),
    ).rejects.toMatchObject({ status: 403, code: "DENIED" });
    // Destination inside the deny list is rejected too.
    await expect(
      renameFilesEntry({
        store,
        rootInput: root,
        pathInput: "src/app.ts",
        newPathInput: "node_modules/app.ts",
      }),
    ).rejects.toMatchObject({ status: 403, code: "DENIED" });
    // A folder cannot be moved into its own subtree.
    await expect(
      renameFilesEntry({ store, rootInput: root, pathInput: "src", newPathInput: "src/inner" }),
    ).rejects.toMatchObject({ status: 400, code: "BAD_PATH" });
  });

  it("refuses to rename a symbolic link", async () => {
    await symlink(join(root, "src"), join(root, "link"), "dir");
    await expect(
      renameFilesEntry({ store, rootInput: root, pathInput: "link", newPathInput: "renamed-link" }),
    ).rejects.toMatchObject({ status: 400, code: "UNSUPPORTED" });
  });

  it("deletes a file and a non-empty directory", async () => {
    const file = await deleteFilesEntry({ store, rootInput: root, pathInput: "src/app.ts" });
    expect(file).toMatchObject({ path: "src/app.ts", kind: "file" });
    await expect(stat(join(root, "src", "app.ts"))).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(join(root, "pkg"));
    await writeFile(join(root, "pkg", "index.ts"), "x\n");
    const dir = await deleteFilesEntry({ store, rootInput: root, pathInput: "pkg" });
    expect(dir).toMatchObject({ path: "pkg", kind: "directory" });
    await expect(stat(join(root, "pkg"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("notifies pooled host LSP processes of a Created watched-file event on create", async () => {
    await createFilesEntry({ store, rootInput: root, pathInput: "src/new.ts", kind: "file" });
    expect(notifyHostLspMock).toHaveBeenCalledExactlyOnceWith(root, join(root, "src", "new.ts"), 1);
  });

  it("notifies pooled host LSP processes of a Deleted+Created pair on rename", async () => {
    await renameFilesEntry({
      store,
      rootInput: root,
      pathInput: "src/app.ts",
      newPathInput: "src/renamed.ts",
    });
    expect(notifyHostLspMock).toHaveBeenCalledTimes(2);
    expect(notifyHostLspMock).toHaveBeenNthCalledWith(1, root, join(root, "src", "app.ts"), 3);
    expect(notifyHostLspMock).toHaveBeenNthCalledWith(2, root, join(root, "src", "renamed.ts"), 1);
  });

  it("notifies pooled host LSP processes of a Deleted watched-file event on delete", async () => {
    await deleteFilesEntry({ store, rootInput: root, pathInput: "src/app.ts" });
    expect(notifyHostLspMock).toHaveBeenCalledExactlyOnceWith(root, join(root, "src", "app.ts"), 3);
  });

  // Codex P2 on PR #3141: a copy creates a new watched file at the destination only -- the source is
  // untouched, so (unlike rename) there is no Deleted half of the pair.
  it("notifies pooled host LSP processes of a Created watched-file event on copy", async () => {
    await copyFilesEntry({
      store,
      rootInput: root,
      sourcePathInput: "src/app.ts",
      destPathInput: "src/app-copy.ts",
    });
    expect(notifyHostLspMock).toHaveBeenCalledExactlyOnceWith(
      root,
      join(root, "src", "app-copy.ts"),
      1,
    );
  });

  it("does not notify pooled host LSP processes when a mutation fails", async () => {
    await expect(
      createFilesEntry({ store, rootInput: root, pathInput: "src/app.ts", kind: "file" }),
    ).rejects.toMatchObject({ status: 409, code: "ALREADY_EXISTS" });
    expect(notifyHostLspMock).not.toHaveBeenCalled();
  });

  it("refuses to delete the root, denied paths, or symlinks", async () => {
    await expect(deleteFilesEntry({ store, rootInput: root, pathInput: "" })).rejects.toMatchObject(
      { status: 400, code: "BAD_PATH" },
    );
    await mkdir(join(root, ".git"));
    await expect(
      deleteFilesEntry({ store, rootInput: root, pathInput: ".git" }),
    ).rejects.toMatchObject({ status: 403, code: "DENIED" });
    await symlink(join(root, "src"), join(root, "link"), "dir");
    await expect(
      deleteFilesEntry({ store, rootInput: root, pathInput: "link" }),
    ).rejects.toMatchObject({ status: 400, code: "UNSUPPORTED" });
    // The link's target survives a rejected delete.
    expect((await stat(join(root, "src"))).isDirectory()).toBe(true);
  });

  it("returns 404 when deleting a missing entry", async () => {
    await expect(
      deleteFilesEntry({ store, rootInput: root, pathInput: "src/ghost.ts" }),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("copies a file and a directory, never overwriting", async () => {
    const file = await copyFilesEntry({
      store,
      rootInput: root,
      sourcePathInput: "src/app.ts",
      destPathInput: "src/app-copy.ts",
    });
    expect(file).toMatchObject({
      path: "src/app-copy.ts",
      previousPath: "src/app.ts",
      kind: "file",
    });
    expect(await readFile(join(root, "src", "app-copy.ts"), "utf8")).toBe("export const a = 1;\n");
    // Original is untouched.
    expect(await readFile(join(root, "src", "app.ts"), "utf8")).toBe("export const a = 1;\n");

    const dir = await copyFilesEntry({
      store,
      rootInput: root,
      sourcePathInput: "src",
      destPathInput: "src-copy",
    });
    expect(dir).toMatchObject({ path: "src-copy", kind: "directory" });
    expect(await readFile(join(root, "src-copy", "app.ts"), "utf8")).toBe("export const a = 1;\n");

    // No overwrite.
    await expect(
      copyFilesEntry({
        store,
        rootInput: root,
        sourcePathInput: "src/app.ts",
        destPathInput: "src/app-copy.ts",
      }),
    ).rejects.toMatchObject({ status: 409, code: "ALREADY_EXISTS" });
  });

  it("deny-checks both ends of a copy, rejects symlinks and copy-into-itself", async () => {
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "[core]\n");
    await expect(
      copyFilesEntry({
        store,
        rootInput: root,
        sourcePathInput: ".git/config",
        destPathInput: "src/config",
      }),
    ).rejects.toMatchObject({ status: 403, code: "DENIED" });
    await expect(
      copyFilesEntry({
        store,
        rootInput: root,
        sourcePathInput: "src/app.ts",
        destPathInput: "node_modules/app.ts",
      }),
    ).rejects.toMatchObject({ status: 403, code: "DENIED" });
    await symlink(join(root, "src"), join(root, "link"), "dir");
    await expect(
      copyFilesEntry({
        store,
        rootInput: root,
        sourcePathInput: "link",
        destPathInput: "link-copy",
      }),
    ).rejects.toMatchObject({ status: 400, code: "UNSUPPORTED" });
    await expect(
      copyFilesEntry({
        store,
        rootInput: root,
        sourcePathInput: "src",
        destPathInput: "src/inner",
      }),
    ).rejects.toMatchObject({ status: 400, code: "BAD_PATH" });
  });

  it("removes a copied directory if the post-copy audit finds a nested symlink", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "keiko-files-copy-outside-")));
    try {
      await symlink(outside, join(root, "src", "outside-link"), "dir");

      await expect(
        copyFilesEntry({
          store,
          rootInput: root,
          sourcePathInput: "src",
          destPathInput: "src-copy",
        }),
      ).rejects.toMatchObject({ status: 400, code: "UNSUPPORTED" });
      await expect(stat(join(root, "src-copy"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("enforces baseVersion on a file rename/delete (optimistic concurrency)", async () => {
    const opened = await readFilesContent(store, root, "src/app.ts");
    const version = opened.session.version;
    // Matching version → the rename proceeds.
    const renamed = await renameFilesEntry({
      store,
      rootInput: root,
      pathInput: "src/app.ts",
      newPathInput: "src/renamed.ts",
      baseVersion: version,
    });
    expect(renamed.path).toBe("src/renamed.ts");

    // The file then changes on disk; a delete carrying the now-stale version is rejected.
    await writeFile(join(root, "src", "renamed.ts"), "export const a = 999;\n");
    await expect(
      deleteFilesEntry({
        store,
        rootInput: root,
        pathInput: "src/renamed.ts",
        baseVersion: version,
      }),
    ).rejects.toMatchObject({ status: 409, code: "STALE_SESSION" });

    // Without a baseVersion the delete is unconditional (the metadata-only tree path).
    const deleted = await deleteFilesEntry({ store, rootInput: root, pathInput: "src/renamed.ts" });
    expect(deleted.path).toBe("src/renamed.ts");
  });
});
