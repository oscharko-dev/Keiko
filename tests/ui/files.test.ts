import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRedactor,
  listFilesDirectories,
  readFilesPreview,
  readFilesTree,
} from "../../src/ui/index.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ax6XK0AAAAASUVORK5CYII=",
  "base64",
);

describe("desktop files browser", () => {
  let root: string;
  let extraRoot: string | null = null;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "keiko-files-")));
    await mkdir(join(root, "src"));
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "package.json"), "{\"name\":\"fixture\"}\n");
    await writeFile(join(root, "src", "app.ts"), "const value: string = \"ok\";\n");
    await writeFile(join(root, "assets", "pixel.png"), PNG_1X1);
    await writeFile(join(root, "archive.bin"), Buffer.from([0, 1, 2, 3, 4, 5]));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    if (extraRoot !== null) {
      await rm(extraRoot, { recursive: true, force: true });
      extraRoot = null;
    }
  });

  it("lists directories for the local folder picker", async () => {
    const listing = await listFilesDirectories(root);

    expect(listing.path).toBe(root);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["assets", "src"]);
    expect(listing.roots.some((entry) => entry.label === "Current workspace")).toBe(true);
  });

  it("lazy-loads directories with directories first and files second", async () => {
    const listing = await readFilesTree(root, "");

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
    await expect(readFilesTree(root, "../")).rejects.toMatchObject({
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

    const listing = await readFilesTree(root, "");
    expect(listing.entries.find((entry) => entry.name === "escape")).toMatchObject({
      kind: "directory",
      symlink: true,
      readable: false,
    });
    await expect(readFilesTree(root, "escape")).rejects.toMatchObject({
      status: 403,
      code: "PATH_ESCAPE",
    });
  });

  it("returns redacted text previews", async () => {
    const secret = "super-secret-value-1234567890";
    await writeFile(join(root, "src", "secret.ts"), `export const token = "${secret}";\n`);
    await writeFile(join(root, ".env.local"), `API_KEY=${secret}\n`);

    const preview = await readFilesPreview(
      root,
      "src/secret.ts",
      buildRedactor({ KEIKO_DEFAULT_API_KEY: secret }),
    );

    expect(preview.kind).toBe("text");
    if (preview.kind === "text") {
      expect(preview.content).not.toContain(secret);
      expect(preview.content).toContain("[REDACTED]");
    }

    const envPreview = await readFilesPreview(
      root,
      ".env.local",
      buildRedactor({ KEIKO_DEFAULT_API_KEY: secret }),
    );
    expect(envPreview).toMatchObject({ kind: "text", extension: "env" });
    if (envPreview.kind === "text") expect(envPreview.content).not.toContain(secret);
  });

  it("returns image previews below the image cap", async () => {
    const preview = await readFilesPreview(root, "assets/pixel.png", buildRedactor({}));

    expect(preview.kind).toBe("image");
    if (preview.kind === "image") {
      expect(preview.dataUrl).toMatch(/^data:image\/png;base64,/u);
      expect(preview.maxBytes).toBe(3_000_000);
    }
  });

  it("returns metadata for unsupported binary files", async () => {
    const preview = await readFilesPreview(root, "archive.bin", buildRedactor({}));

    expect(preview).toMatchObject({
      kind: "binary",
      reason: "unsupported",
      extension: "bin",
    });
  });

  it("caps large text previews", async () => {
    const content = `${"a".repeat(1_000_050)}tail`;
    await writeFile(join(root, "large.txt"), content);

    const preview = await readFilesPreview(root, "large.txt", buildRedactor({}));

    expect(preview.kind).toBe("text");
    if (preview.kind === "text") {
      expect(preview.truncated).toBe(true);
      expect(preview.content).toHaveLength(1_000_000);
      expect(preview.maxBytes).toBe(1_000_000);
    }
  });

  it("caps large image previews to metadata", async () => {
    await writeFile(join(root, "huge.png"), Buffer.alloc(3_000_001, 1));

    const preview = await readFilesPreview(root, "huge.png", buildRedactor({}));

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

    const listing = await readFilesTree(root, "many");

    expect(listing.entries).toHaveLength(1_000);
    expect(listing.truncated).toBe(true);
  });
});
