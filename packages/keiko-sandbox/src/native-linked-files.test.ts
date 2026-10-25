import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { scanNativeLinkedFiles } from "./native-linked-files.js";

describe("scanNativeLinkedFiles", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const directory of created.splice(0).reverse()) {
      chmodSync(directory, 0o700);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function tree(): { readonly root: string; readonly workspace: string; readonly outside: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-linked-files-")));
    created.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(join(workspace, "src", "deep"), { recursive: true });
    writeFileSync(join(workspace, "src", "ordinary.ts"), "export const ordinary = 1;\n");
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "OUTSIDE\n");
    return { root, workspace, outside };
  }

  it("names every regular file with a second link, sorted, and nothing else", () => {
    const { workspace, outside } = tree();
    linkSync(outside, join(workspace, "src", "deep", "b.txt"));
    linkSync(outside, join(workspace, "a.txt"));
    // A symbolic link is not a second name of a file; the kernel resolves it to its target.
    symlinkSync(outside, join(workspace, "symlink.txt"));
    const scan = scanNativeLinkedFiles([workspace]);
    expect(scan).toEqual({
      outcome: "complete",
      linkedFiles: [join(workspace, "a.txt"), join(workspace, "src", "deep", "b.txt")],
      scannedFileCount: 3,
      gitObjectLinkCount: 0,
    });
  });

  it("finds none in an ordinary tree and scans every root it is given", () => {
    const { root, workspace, outside } = tree();
    const reference = join(root, "reference");
    mkdirSync(reference);
    expect(scanNativeLinkedFiles([workspace])).toMatchObject({
      outcome: "complete",
      linkedFiles: [],
    });
    linkSync(outside, join(reference, "aliased.txt"));
    expect(scanNativeLinkedFiles([workspace, reference])).toMatchObject({
      outcome: "complete",
      linkedFiles: [join(reference, "aliased.txt")],
    });
  });

  it("keeps a local clone's read-only Git objects readable, but not a writable file under that name", () => {
    const { workspace, outside } = tree();
    const objects = join(workspace, ".git", "objects");
    const object = join(objects, "ab", "c".repeat(38));
    const pack = join(objects, "pack", `pack-${"d".repeat(40)}.pack`);
    const writable = join(objects, "ef", "0".repeat(38));
    for (const [index, path] of [object, pack, writable].entries()) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "object\n");
      linkSync(path, `${outside}-${String(index)}`);
    }
    chmodSync(object, 0o444);
    chmodSync(pack, 0o444);
    const scan = scanNativeLinkedFiles([workspace]);
    expect(scan).toMatchObject({
      outcome: "complete",
      linkedFiles: [writable],
      gitObjectLinkCount: 2,
    });
  });

  it("refuses an excessive set and an unfinished walk instead of returning a partial list", () => {
    const { workspace, outside } = tree();
    for (const name of ["one.txt", "two.txt", "three.txt"])
      linkSync(outside, join(workspace, name));
    expect(scanNativeLinkedFiles([workspace], { linkedFilesMax: 2 })).toEqual({
      outcome: "excessive",
      scannedFileCount: 4,
      gitObjectLinkCount: 0,
    });
    expect(scanNativeLinkedFiles([workspace], { entriesMax: 2 })).toMatchObject({
      outcome: "incomplete",
    });
  });

  it("skips a directory the user cannot open, which the run cannot open either", () => {
    const { workspace, outside } = tree();
    const closed = join(workspace, "closed");
    mkdirSync(closed);
    linkSync(outside, join(closed, "hidden.txt"));
    chmodSync(closed, 0o000);
    created.push(closed);
    expect(scanNativeLinkedFiles([workspace])).toMatchObject({
      outcome: "complete",
      linkedFiles: [],
    });
  });
});
