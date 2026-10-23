import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nativeToolchainReadRoots } from "./native-toolchain-roots.js";

describe("nativeToolchainReadRoots", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function tree(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-toolchain-roots-")));
    created.push(root);
    return root;
  }

  it("maps bin directories to their install prefix and resolves symlinks", () => {
    const root = tree();
    mkdirSync(join(root, "nvm", "v24", "bin"), { recursive: true });
    mkdirSync(join(root, "tools", "bin"), { recursive: true });
    symlinkSync(join(root, "nvm", "v24", "bin"), join(root, "current-bin"));
    const path = [join(root, "current-bin"), join(root, "tools", "bin")].join(delimiter);
    expect(nativeToolchainReadRoots(path, join(root, "home"))).toEqual([
      join(root, "nvm", "v24"),
      join(root, "tools"),
    ]);
  });

  const brewPrefix = /^(\/opt\/homebrew|\/usr\/local)\/Cellar\//u.exec(process.execPath)?.[1];

  it.skipIf(brewPrefix === undefined)(
    "uses the Homebrew prefix for a Cellar keg so sibling libraries stay readable",
    () => {
      expect(nativeToolchainReadRoots(dirname(process.execPath), "/Users/nobody")).toEqual([
        brewPrefix,
      ]);
    },
  );

  it("never returns the home directory, one of its ancestors or a system prefix", () => {
    const root = tree();
    mkdirSync(join(root, "home", "bin"), { recursive: true });
    const home = join(root, "home");
    // `~/bin` -> `~` would open the whole home; the directory itself is kept instead.
    expect(nativeToolchainReadRoots(join(home, "bin"), home)).toEqual([join(home, "bin")]);
    expect(nativeToolchainReadRoots(home, home)).toEqual([]);
    expect(
      nativeToolchainReadRoots(["/usr/bin", "/bin", "/usr/local/bin"].join(delimiter), home),
    ).toEqual([]);
    expect(nativeToolchainReadRoots(root, join(root, "home"))).toEqual([]);
  });

  it("ignores relative, missing and empty entries and removes nested duplicates", () => {
    const root = tree();
    mkdirSync(join(root, "a", "bin"), { recursive: true });
    mkdirSync(join(root, "a", "extra", "bin"), { recursive: true });
    const path = ["", "relative/bin", join(root, "missing", "bin"), join(root, "a", "bin")]
      .concat(join(root, "a", "extra", "bin"))
      .join(delimiter);
    expect(nativeToolchainReadRoots(path, "/Users/nobody")).toEqual([join(root, "a")]);
    expect(nativeToolchainReadRoots(undefined, "/Users/nobody")).toEqual([]);
  });
});
