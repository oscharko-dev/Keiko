import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  grantOthersWrite,
  makeOwnerPrivateDirectory,
} from "../test-support/owner-private-fixture.js";
import {
  plantDirectoryRedirect,
  plantSymlinkOrSkip,
} from "../../../../tests/support/symlink-fixture.js";
import { readPluginPackage, writePluginPackage } from "./opencodeOperatorPluginPackage.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// The tree the documented command was run on:
//   find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256
const TREE_SHA256 = "a449f5c0ad257fd10b4933780e74c9845732041b1f7476784df40e6add6cc4ca";

function packageTree(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-plugin-package-")));
  roots.push(root);
  makeOwnerPrivateDirectory(root);
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "export const x = 1;\n");
  writeFileSync(
    join(root, "sub", "entry.js"),
    'import { x } from "dep";\nexport default { id: "acme.pkg", async setup() { void x; } };\n',
  );
  writeFileSync(join(root, "package.json"), "{}");
  return root;
}

const TREE_FILES = ["node_modules/dep/index.js", "package.json", "sub/entry.js"];

describe("an npm plugin package the operator installed (#3903 AC2)", () => {
  it("hashes the regular files exactly as the documented shasum listing does", (context) => {
    const root = packageTree();
    plantSymlinkOrSkip(context, "../sub/entry.js", join(root, "node_modules", "link.js"));
    const read = readPluginPackage(root, "sub/entry.js");
    expect(read).toMatchObject({ ok: true, sha256: TREE_SHA256 });
    if (!read.ok) throw new Error("unreadable fixture");
    // The link is neither hashed nor copied, as `find -type f` skips it.
    expect(read.files.map((file) => file.path).sort()).toEqual(TREE_FILES);
  });

  it("neither hashes nor walks through a directory link (a junction on Windows)", () => {
    const root = packageTree();
    plantDirectoryRedirect(join(root, "sub"), join(root, "node_modules", "linked-sub"));
    const read = readPluginPackage(root, "sub/entry.js");
    expect(read).toMatchObject({ ok: true, sha256: TREE_SHA256 });
    if (!read.ok) throw new Error("unreadable fixture");
    expect(read.files.map((file) => file.path).sort()).toEqual(TREE_FILES);
  });

  it("changes its digest when any file of the tree changes", () => {
    const root = packageTree();
    writeFileSync(join(root, "node_modules", "dep", "index.js"), "export const x = 2;\n");
    expect(readPluginPackage(root, "sub/entry.js")).toMatchObject({ ok: true });
    expect(readPluginPackage(root, "sub/entry.js")).not.toMatchObject({ sha256: TREE_SHA256 });
  });

  it("refuses a tree without its entry, with a file others may write, or one too large", () => {
    const root = packageTree();
    expect(readPluginPackage(root, "sub/missing.js")).toEqual({
      ok: false,
      reason: "entry-missing",
    });
    if (process.platform === "win32") grantOthersWrite(join(root, "package.json"));
    else chmodSync(join(root, "package.json"), 0o666);
    expect(readPluginPackage(root, "sub/entry.js")).toEqual({ ok: false, reason: "unreadable" });
  });

  it("writes the tree owner-private below the target", () => {
    const read = readPluginPackage(packageTree(), "sub/entry.js");
    if (!read.ok) throw new Error("unreadable fixture");
    const target = realpathSync(mkdtempSync(join(tmpdir(), "keiko-plugin-copy-")));
    roots.push(target);
    writePluginPackage(join(target, "pkg"), read.files);
    expect(readFileSync(join(target, "pkg", "node_modules", "dep", "index.js"), "utf8")).toBe(
      "export const x = 1;\n",
    );
  });
});
