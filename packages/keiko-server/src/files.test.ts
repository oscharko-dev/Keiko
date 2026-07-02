import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EDITOR_SESSION_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";
import {
  buildRedactor,
  createFilesEntry,
  createInMemoryUiStore,
  copyFilesEntry,
  deleteFilesEntry,
  handleFilesContent,
  listFilesDirectories,
  readFilesContent,
  readFilesPreview,
  readFilesTree,
  renameFilesEntry,
  searchFiles,
  writeFilesContent,
} from "./index.js";
import type { RouteContext, UiHandlerDeps } from "./index.js";
import type { UiStore } from "./store/index.js";

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

  it("lists directories for the local folder picker", async () => {
    const listing = await listFilesDirectories(store, root);

    expect(listing.path).toBe(root);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["assets", "src"]);
    expect(listing.roots).toEqual([{ label: "Project root", path: root }]);
  });

  it("keeps the local folder picker inside the registered project and deny list", async () => {
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "node_modules"));
    await mkdir(join(root, "src", "nested"));

    const listing = await listFilesDirectories(store, root, root);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["assets", "src"]);

    const nested = await listFilesDirectories(store, root, join(root, "src"));
    expect(nested.parent).toBe(root);
    expect(nested.entries.map((entry) => entry.name)).toEqual(["nested"]);

    await expect(listFilesDirectories(store, root, join(root, ".git"))).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
    store.createProject(join(root, ".git"), "git-dir");
    await expect(listFilesDirectories(store, join(root, ".git"))).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
    await expect(listFilesDirectories(store, root, dirname(root))).rejects.toMatchObject({
      status: 403,
      code: "PATH_ESCAPE",
    });
    await expect(
      listFilesDirectories(store, root, join(dirname(root), "missing-outside-project")),
    ).rejects.toMatchObject({
      status: 403,
      code: "PATH_ESCAPE",
    });
  });

  it("browses an unregistered arbitrary absolute directory (Epic #532 — any machine folder)", async () => {
    const arbitrary = await realpath(await mkdtemp(join(tmpdir(), "keiko-files-arbitrary-")));
    extraRoot = arbitrary;
    await mkdir(join(arbitrary, "reports"));
    await writeFile(join(arbitrary, "notes.txt"), "hello world", "utf8");

    const listing = await listFilesDirectories(store, arbitrary);
    expect(listing.path).toBe(arbitrary);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["reports"]);
    expect(listing.roots).toEqual([{ label: "Project root", path: arbitrary }]);

    const tree = await readFilesTree(store, arbitrary, "");
    expect(tree.entries.map((entry) => entry.name)).toContain("notes.txt");

    const preview = await readFilesPreview(store, arbitrary, "notes.txt", buildRedactor({}));
    expect(preview.kind).toBe("text");
    if (preview.kind === "text") {
      expect(preview.content).toContain("hello world");
    }
  });

  it("rejects a relative (non-absolute) arbitrary root", async () => {
    await expect(listFilesDirectories(store, "relative/dir")).rejects.toMatchObject({
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

    await expect(listFilesDirectories(store, join(base, ".aws"))).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
    await expect(listFilesDirectories(store, join(base, ".aws", "sub"))).rejects.toMatchObject({
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

    await expect(listFilesDirectories(store, sensitiveRoot)).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
    const directories = await listFilesDirectories(store, root, root);
    expect(directories.entries.map((entry) => entry.name)).not.toContain(tokenSegment);

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

    await expect(listFilesDirectories(store, sensitiveProject)).rejects.toMatchObject({
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

    await expect(listFilesDirectories(store, nestedProject)).rejects.toMatchObject({
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
    expect(tree.entries.length).toBe(1_000);
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
    expect(listing.entries.find((entry) => entry.name === "escape")).toMatchObject({
      kind: "directory",
      symlink: true,
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
    expect(listing.entries.find((entry) => entry.name === "config.txt")).toMatchObject({
      symlink: true,
      readable: false,
    });
    expect(listing.entries.find((entry) => entry.name === "git-cache")).toMatchObject({
      kind: "directory",
      symlink: true,
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

  it("rejects saving when the file changed after the editor loaded it", async () => {
    const initial = await readFilesContent(store, root, "src/app.ts");
    await writeFile(join(root, "src", "app.ts"), 'export const value = "other";\n', "utf8");

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

  it("returns metadata for unsupported binary files", async () => {
    const preview = await readFilesPreview(store, root, "archive.bin", buildRedactor({}));

    expect(preview).toMatchObject({
      kind: "binary",
      reason: "unsupported",
      extension: "bin",
    });
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
