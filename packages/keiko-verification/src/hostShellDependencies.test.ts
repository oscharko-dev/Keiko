import { describe, expect, it } from "vitest";
import { hostShellRefusal, type HostShellProject } from "./hostShellDependencies.js";

type Manifest = Readonly<Record<string, unknown>>;

function project(
  manifests: Readonly<Record<string, Manifest>>,
  lockfile?: Manifest,
  treePresent = false,
  gypfiles: readonly string[] = [],
): HostShellProject {
  return {
    manifests: new Map(Object.entries(manifests)),
    lockfile,
    gypfiles: new Set(gypfiles),
    treePresent,
  };
}

const ROOT: Manifest = { name: "demo", dependencies: { "left-pad": "1.3.0" } };

function lockfileOf(packages: Readonly<Record<string, unknown>>): Manifest {
  return { name: "demo", lockfileVersion: 3, packages };
}

describe("hostShellRefusal (#4522)", () => {
  it("admits a project without install scripts or lockfile", () => {
    expect(hostShellRefusal(project({ "": ROOT }))).toBeUndefined();
  });

  it("refuses an install lifecycle script of the root or of a member while no tree exists", () => {
    for (const name of ["preinstall", "install", "postinstall"]) {
      const scripts = { [name]: "node build.js" };
      expect(hostShellRefusal(project({ "": { ...ROOT, scripts } }))).toBe(
        "install-scripts-required",
      );
      expect(hostShellRefusal(project({ "": ROOT, "packages/a": { scripts } }))).toBe(
        "install-scripts-required",
      );
      expect(
        hostShellRefusal(project({ "": { ...ROOT, scripts } }, undefined, true)),
      ).toBeUndefined();
    }
  });

  // npm runs `node-gyp rebuild` as the install script of a package that holds a `binding.gyp`.
  it("refuses a binding.gyp of the root or of a member, unless gypfile is false", () => {
    expect(hostShellRefusal(project({ "": ROOT }, undefined, false, [""]))).toBe(
      "install-scripts-required",
    );
    expect(
      hostShellRefusal(project({ "": ROOT, "packages/a": {} }, undefined, false, ["packages/a"])),
    ).toBe("install-scripts-required");
    expect(
      hostShellRefusal(project({ "": { ...ROOT, gypfile: false } }, undefined, false, [""])),
    ).toBeUndefined();
    expect(hostShellRefusal(project({ "": ROOT }, undefined, true, [""]))).toBeUndefined();
  });

  it("does not count prepare, other scripts or an empty install script", () => {
    const scripts = { prepare: "husky", test: "vitest run", postinstall: "  " };
    expect(hostShellRefusal(project({ "": { ...ROOT, scripts } }))).toBeUndefined();
  });

  it("admits a lockfile that records every declared section, absent and empty alike", () => {
    const manifest = { ...ROOT, devDependencies: {} };
    const lockfile = lockfileOf({ "": { name: "demo", dependencies: { "left-pad": "1.3.0" } } });
    expect(hostShellRefusal(project({ "": manifest }, lockfile))).toBeUndefined();
  });

  it("refuses a lockfile whose root entry differs from the manifest in any section", () => {
    const recorded = { "left-pad": "1.3.0" };
    const cases: readonly Manifest[] = [
      { dependencies: { "left-pad": "1.2.0" } },
      { dependencies: recorded, devDependencies: { vitest: "4.1.12" } },
      { dependencies: { ...recorded, extra: "1.0.0" } },
      { dependencies: recorded, peerDependencies: { react: "19.0.0" } },
    ];
    for (const manifest of cases) {
      const lockfile = lockfileOf({ "": { dependencies: recorded } });
      expect(hostShellRefusal(project({ "": manifest }, lockfile))).toBe("lockfile-mismatch");
    }
  });

  it("refuses a lockfile without packages or without a root entry", () => {
    expect(hostShellRefusal(project({ "": ROOT }, { lockfileVersion: 3 }))).toBe(
      "lockfile-mismatch",
    );
    expect(hostShellRefusal(project({ "": ROOT }, lockfileOf({})))).toBe("lockfile-mismatch");
  });

  it("compares a member where the lockfile records it and skips one it never recorded", () => {
    const member = { dependencies: { ms: "2.1.3" } };
    const root = { "": { dependencies: ROOT.dependencies } };
    expect(
      hostShellRefusal(
        project({ "": ROOT, "packages/a": member }, lockfileOf({ ...root, "packages/a": member })),
      ),
    ).toBeUndefined();
    expect(
      hostShellRefusal(
        project(
          { "": ROOT, "packages/a": member },
          lockfileOf({ ...root, "packages/a": { dependencies: { ms: "2.0.0" } } }),
        ),
      ),
    ).toBe("lockfile-mismatch");
    expect(
      hostShellRefusal(project({ "": ROOT, "packages/removed": member }, lockfileOf(root))),
    ).toBeUndefined();
  });

  it("names a mismatch before an install script, and even when a tree exists", () => {
    const manifest = { ...ROOT, scripts: { postinstall: "node build.js" } };
    const lockfile = lockfileOf({ "": { dependencies: { "left-pad": "1.0.0" } } });
    expect(hostShellRefusal(project({ "": manifest }, lockfile))).toBe("lockfile-mismatch");
    expect(hostShellRefusal(project({ "": manifest }, lockfile, true))).toBe("lockfile-mismatch");
  });
});
