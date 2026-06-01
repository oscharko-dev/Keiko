import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRedactor,
  createInMemoryUiStore,
  listFilesDirectories,
  readFilesPreview,
  readFilesTree,
} from "../../src/ui/index.js";
import type { UiStore } from "../../src/ui/store/index.js";

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
    await writeFile(join(root, "package.json"), "{\"name\":\"fixture\"}\n");
    await writeFile(join(root, "src", "app.ts"), "const value: string = \"ok\";\n");
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

  it("rejects files requests for unregistered roots", async () => {
    const unregistered = await realpath(await mkdtemp(join(tmpdir(), "keiko-files-unregistered-")));
    extraRoot = unregistered;

    await expect(listFilesDirectories(store, unregistered)).rejects.toMatchObject({
      status: 403,
      code: "WORKSPACE_NOT_REGISTERED",
    });
    await expect(readFilesTree(store, unregistered, "")).rejects.toMatchObject({
      status: 403,
      code: "WORKSPACE_NOT_REGISTERED",
    });
    await expect(readFilesPreview(store, unregistered, "x.txt", buildRedactor({}))).rejects.toMatchObject({
      status: 403,
      code: "WORKSPACE_NOT_REGISTERED",
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

  it("rejects path traversal outside the selected root", async () => {
    await expect(readFilesTree(store, root, "../")).rejects.toMatchObject({
      status: 400,
      code: "PATH_ESCAPE",
    });
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

    await expect(readFilesPreview(store, root, "config.txt", buildRedactor({}))).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
    await expect(readFilesTree(store, root, "git-cache")).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
  });

  it("returns redacted text previews", async () => {
    const secret = "super-secret-value-1234567890";
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

  it("refuses to preview .env.local (matches the .env.* deny pattern)", async () => {
    await writeFile(join(root, ".env.local"), "API_KEY=value\n");

    await expect(readFilesPreview(store, root, ".env.local", buildRedactor({}))).rejects.toMatchObject({
      status: 403,
      code: "DENIED",
    });
  });

  it("returns image previews below the image cap", async () => {
    const preview = await readFilesPreview(store, root, "assets/pixel.png", buildRedactor({}));

    expect(preview.kind).toBe("image");
    if (preview.kind === "image") {
      expect(preview.dataUrl).toMatch(/^data:image\/png;base64,/u);
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

    const listing = await readFilesTree(store, root, "");
    const names = listing.entries.map((entry) => entry.name);

    expect(names).toContain(".env.example");
    expect(names).not.toContain(".env");
    expect(names).not.toContain("id_rsa");
    expect(names).not.toContain("server.pem");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
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
    await expect(readFilesPreview(store, root, "node_modules/foo.js", buildRedactor({}))).rejects.toMatchObject({
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
    await expect(readFilesPreview(store, root, "node_modules/missing.js", buildRedactor({}))).rejects.toMatchObject({
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

  it("honors the project root's .gitignore in tree listings", async () => {
    await writeFile(join(root, ".gitignore"), "generated/\nartifact.txt\n");
    await mkdir(join(root, "generated"));
    await writeFile(join(root, "generated", "bundle.js"), "// bundle\n");
    await writeFile(join(root, "artifact.txt"), "artifact\n");
    await writeFile(join(root, "keep.txt"), "keep\n");

    const listing = await readFilesTree(store, root, "");
    const names = listing.entries.map((entry) => entry.name);

    expect(names).toContain("keep.txt");
    expect(names).not.toContain("generated");
    expect(names).not.toContain("artifact.txt");
  });

  it("still previews .gitignore-matched files (preview is not best-effort)", async () => {
    // .gitignore is tier-2 noise reduction for listings only. A user clicking
    // through a direct URL to an ignored (but not denied) file must still
    // receive a preview. The chosen name does NOT match any deny pattern.
    await writeFile(join(root, ".gitignore"), "artifact.txt\n");
    await writeFile(join(root, "artifact.txt"), "artifact content\n");

    const preview = await readFilesPreview(store, root, "artifact.txt", buildRedactor({}));

    expect(preview.kind).toBe("text");
    if (preview.kind === "text") {
      expect(preview.content).toContain("artifact content");
    }
  });

  it("treats a missing .gitignore as no filter (best-effort, no error)", async () => {
    // Verifies loadRootGitignore's silent fallback. No .gitignore in fixture.
    await writeFile(join(root, "ordinary.txt"), "kept\n");

    const listing = await readFilesTree(store, root, "");
    const names = listing.entries.map((entry) => entry.name);

    expect(names).toContain("ordinary.txt");
  });
});
