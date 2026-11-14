import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  inspectPortableManagedInstall,
  portableManagedInstallHealth,
  removePortableManagedInstall,
  removePortableManagedInstallTolerant,
} from "./portable-maintenance.js";
import { layoutFor, type PortableLayout, type PortableTarget } from "./portable-shared.js";
import {
  realRootPackListing,
  realRootPackSample,
  realRootPackageJson,
  treesInListing,
  WHOLE_TREES,
  writePortableAppPayload,
} from "./test-support/portable-app-payload.js";
import { writePortableRuntimePayload } from "./test-support/portable-runtime-payload.js";

// #4358, Windows guest: `keiko uninstall` and the click upgrade of a first installation refused a
// real payload with "unknown entry: app/LICENSE". A real payload's `app/` is the extracted
// `npm pack` of the root package, so besides `dist` and the bundled packages it holds the files the
// package's `files` list names and the ones npm adds on its own. The earlier fixtures held fewer
// files than a real package, so the suite stayed green over the defect. These fixtures are built
// from the real listing, and the first test fails when the listing holds anything the inspection
// would call unknown.

const GENERATION = `.portable/generations/${"b".repeat(64)}`;
const FLAT_TARGETS = ["windows-x64", "linux-x64", "macos-arm64"] as const;
const roots: string[] = [];
const noopIo = { out: (_text: string): void => undefined, err: (_text: string): void => undefined };

interface Install {
  readonly layout: PortableLayout;
  readonly runtimeTarget: PortableTarget;
}

beforeAll(() => {
  // The first call runs `npm pack --dry-run`; later calls read its cached answer.
  realRootPackListing();
}, 120_000);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "fixture\n");
}

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-app-payload-"));
  roots.push(root);
  return root;
}

function flatInstall(target: PortableTarget): Install {
  const root = newRoot();
  const layout = layoutFor(target, target.startsWith("macos") ? join(root, "Keiko.app") : root);
  for (const path of [
    layout.primaryLauncherPath,
    layout.setupManifestPath,
    layout.runtimeNodePath,
  ]) {
    touch(path);
  }
  writePortableAppPayload(layout.resourceRoot);
  writePortableRuntimePayload(layout.resourceRoot, target);
  return { layout, runtimeTarget: target };
}

function generationInstall(): Install {
  const root = newRoot();
  const flat = layoutFor("windows-x64", root);
  const resourceRoot = join(root, ...GENERATION.split("/"));
  const layout = {
    ...flat,
    resourceRoot,
    appRoot: join(resourceRoot, "app"),
    packageJsonPath: join(resourceRoot, "app", "package.json"),
  };
  for (const path of [
    flat.primaryLauncherPath,
    flat.setupManifestPath,
    join(resourceRoot, "runtime", "node", "node.exe"),
  ]) {
    touch(path);
  }
  writePortableAppPayload(resourceRoot);
  writePortableRuntimePayload(resourceRoot, "windows-x64");
  return { layout, runtimeTarget: "windows-x64" };
}

const INSTALLS: readonly (readonly [string, () => Install])[] = [
  ...FLAT_TARGETS.map((target) => [`flat ${target}`, (): Install => flatInstall(target)] as const),
  ["Windows generation", generationInstall],
];

// The first entry the inspection cannot place: the file itself, or its folder when the folder is
// not part of the layout either (a macOS bundle has no `.portable` beside `Contents`).
function unknown(layout: PortableLayout, absPath: string): string {
  const rel = relative(layout.installRoot, absPath).replaceAll("\\", "/");
  const outsideLayout = layout.rootKind === "macos-app" && rel.startsWith(".portable/");
  return `portable managed install contains unknown entry: ${outsideLayout ? ".portable" : rel}`;
}

describe("managed install inspection accepts the real package and nothing else", () => {
  it("is not vacuous: the real listing holds the entries a hand-written fixture left out", () => {
    const outside = realRootPackListing().filter(
      (path) => !WHOLE_TREES.some((tree) => path.startsWith(tree)),
    );
    // Today the package packs these seven entries outside its two whole trees. A floor, so a
    // listing that lost most of them fails here instead of passing over an empty fixture.
    expect(outside.length).toBeGreaterThanOrEqual(7);
    expect(outside).toEqual(expect.arrayContaining(["package.json", "LICENSE", "NOTICE"]));
    expect(realRootPackSample()).toEqual(expect.arrayContaining(outside));
  });

  it("states which whole trees every fixture covers and that the package packs both", () => {
    // `dist` is the package's own `files` entry; its content is in the listing only after the root
    // build, so the fixture writes the surface's required `dist/index.js` when it is not.
    expect(realRootPackageJson().files).toContain("dist");
    expect(WHOLE_TREES).toEqual(["dist/", "node_modules/"]);
    const sample = realRootPackSample();
    for (const tree of WHOLE_TREES) {
      expect(sample.filter((path) => path.startsWith(tree))).toHaveLength(1);
    }
    for (const tree of treesInListing()) {
      expect(realRootPackListing().some((path) => path.startsWith(tree))).toBe(true);
    }
  });

  it.each(INSTALLS)(
    "holds no entry of the real listing it would call unknown (%s)",
    (_name, make) => {
      const { layout } = make();
      expect(inspectPortableManagedInstall(layout).issues).toEqual([]);
      expect(portableManagedInstallHealth(layout).issueCount).toBe(0);
    },
  );

  it.each(INSTALLS)("removes such an installation completely (%s)", (_name, make) => {
    const { layout } = make();
    const generationRoot = layout.resourceRoot;
    removePortableManagedInstall(layout, noopIo, false);
    expect(existsSync(layout.installRoot)).toBe(false);
    expect(existsSync(generationRoot)).toBe(false);
  });

  it.each(INSTALLS)(
    "refuses a foreign file below app/, at the install root and in .portable/ (%s)",
    (_name, make) => {
      const { layout } = make();
      const foreign = [
        join(layout.resourceRoot, "app", "FOREIGN.txt"),
        join(layout.resourceRoot, "app", "scripts", "FOREIGN.mjs"),
        join(layout.installRoot, "FOREIGN-ROOT.txt"),
        join(layout.resourceRoot, ".portable", "FOREIGN.json"),
        join(layout.installRoot, ".portable", "FOREIGN-INSTALL.json"),
      ];
      for (const path of foreign) {
        touch(path);
        expect(inspectPortableManagedInstall(layout).issues).toEqual([unknown(layout, path)]);
        expect(() => {
          removePortableManagedInstall(layout, noopIo, false);
        }).toThrow(unknown(layout, path));
        expect(existsSync(path)).toBe(true);
        expect(portableManagedInstallHealth(layout).issueCount).toBe(1);
        rmSync(path);
      }
    },
  );

  it.each(INSTALLS)(
    "refuses a folder that only has the name of an always-packed file, and keeps it (%s)",
    (_name, make) => {
      const { layout } = make();
      for (const folder of ["LICENSE.d", "readme.x", "COPYING.txt"]) {
        const inside = join(layout.resourceRoot, "app", folder, "FOREIGN.txt");
        touch(inside);
        const entry = join(layout.resourceRoot, "app", folder);
        expect(inspectPortableManagedInstall(layout).issues).toEqual([unknown(layout, entry)]);
        expect(() => {
          removePortableManagedInstall(layout, noopIo, false);
        }).toThrow(unknown(layout, entry));
        expect(existsSync(inside)).toBe(true);
        rmSync(entry, { recursive: true });
      }
    },
  );
});

// The mechanism, with small hand-built packages: what the inspection may never take from a
// package.json it reads. The positive proof above runs on the real listing.
describe("the app entries come from the installed package and admit nothing it does not name", () => {
  function appWith(
    packageJson: unknown,
    extraFiles: readonly string[],
  ): { layout: PortableLayout; resourceRoot: string } {
    const root = newRoot();
    const layout = layoutFor("linux-x64", root);
    for (const path of [
      layout.primaryLauncherPath,
      layout.setupManifestPath,
      layout.runtimeNodePath,
    ]) {
      touch(path);
    }
    mkdirSync(dirname(layout.packageJsonPath), { recursive: true });
    writeFileSync(
      layout.packageJsonPath,
      typeof packageJson === "string" ? packageJson : JSON.stringify(packageJson),
    );
    for (const file of extraFiles) touch(join(layout.resourceRoot, "app", ...file.split("/")));
    return { layout, resourceRoot: layout.resourceRoot };
  }

  function issuesOf(layout: PortableLayout): readonly string[] {
    return inspectPortableManagedInstall(layout).issues;
  }

  it("admits a file and a folder the package names, and the entries npm always packs", () => {
    const { layout } = appWith({ files: ["./docs/", "NOTICE", "tools/check.mjs"] }, [
      "docs/guide/a.md",
      "NOTICE",
      "tools/check.mjs",
      "readme.TXT",
      "LICENCE",
      "Copying.md",
    ]);
    expect(issuesOf(layout)).toEqual([]);
  });

  it("refuses an entry the package does not name", () => {
    const { layout } = appWith({ files: ["NOTICE"] }, ["NOTICE", "OTHER", "tools/check.mjs"]);
    expect([...issuesOf(layout)].sort()).toEqual([
      "portable managed install contains unknown entry: app/OTHER",
      "portable managed install contains unknown entry: app/tools",
    ]);
  });

  it("refuses names that only look like the always-packed entries", () => {
    const { layout } = appWith({}, ["README~", "LICENSE$", "readme-extra.md", "licenses/x"]);
    expect([...issuesOf(layout)].sort()).toEqual([
      "portable managed install contains unknown entry: app/LICENSE$",
      "portable managed install contains unknown entry: app/README~",
      "portable managed install contains unknown entry: app/licenses",
      "portable managed install contains unknown entry: app/readme-extra.md",
    ]);
  });

  it("never reads a pattern, a negation or a parent segment as a name", () => {
    const { layout } = appWith(
      {
        files: ["*", "**/*.js", "!dist", "../escape", "a/../b", "/abs", "x\\\\y", 7, null, "keep"],
      },
      ["anything.js", "b", "escape", "abs", "keep"],
    );
    expect([...issuesOf(layout)].sort()).toEqual([
      "portable managed install contains unknown entry: app/abs",
      "portable managed install contains unknown entry: app/anything.js",
      "portable managed install contains unknown entry: app/b",
      "portable managed install contains unknown entry: app/escape",
    ]);
  });

  it("takes bin, main and browser paths as packed files", () => {
    const { layout } = appWith(
      { bin: { keiko: "cli/run.js" }, main: "lib/main.js", browser: "web.js" },
      ["cli/run.js", "lib/main.js", "web.js", "lib/other.js"],
    );
    expect(issuesOf(layout)).toEqual([
      "portable managed install contains unknown entry: app/lib/other.js",
    ]);
  });

  it("names nothing when the package.json is not valid JSON or is not an object", () => {
    for (const content of ["{not json", "[]", "null"]) {
      const { layout } = appWith(content, ["NOTICE", "LICENSE"]);
      expect([...issuesOf(layout)].sort()).toEqual([
        "portable managed install contains unknown entry: app/LICENSE",
        "portable managed install contains unknown entry: app/NOTICE",
      ]);
    }
  });
});

// #4358, Windows window on build cb59ec31f: a removal that stopped at the first held-open file left
// the installation half removed. The removal keeps going, leaves the files a second run needs to
// find the installation, and what it left is still an installation the inspection accepts.
describe("removal that meets a held-open entry", () => {
  const lock = (code: string): Error => Object.assign(new Error("held open"), { code });
  const recordPath = (layout: PortableLayout): string =>
    join(layout.resourceRoot, ".portable", "runtime-activation.json");

  it.each(INSTALLS)("removes the identity files last, in a fixed order (%s)", (_name, make) => {
    const { layout } = make();
    const order: string[] = [];
    const outcome = removePortableManagedInstallTolerant(layout, noopIo, {
      deferIdentity: false,
      unlink: (path) => {
        order.push(path);
        unlinkSync(path);
      },
    });
    expect(outcome.residueFiles).toEqual([]);
    expect(outcome.residueDirectories).toEqual([]);
    expect(order.slice(-4)).toEqual([
      recordPath(layout),
      layout.packageJsonPath,
      layout.primaryLauncherPath,
      layout.setupManifestPath,
    ]);
    expect(existsSync(layout.installRoot)).toBe(false);
  });

  it.each(INSTALLS)(
    "goes on past a held-open file, keeps the identity files and accepts what is left (%s)",
    (_name, make) => {
      const { layout } = make();
      const total = inspectPortableManagedInstall(layout).files.length;
      let calls = 0;
      let held: string | undefined;
      const outcome = removePortableManagedInstallTolerant(layout, noopIo, {
        deferIdentity: false,
        unlink: (path) => {
          calls += 1;
          if (calls === 3) {
            held = path;
            throw lock("EPERM");
          }
          unlinkSync(path);
        },
      });
      expect(held).toBeDefined();
      // the held file and the four identity files stay; everything else went
      expect(outcome.residueFiles).toEqual([
        held,
        recordPath(layout),
        layout.packageJsonPath,
        layout.primaryLauncherPath,
        layout.setupManifestPath,
      ]);
      expect(outcome.removedCount).toBe(total - 5);
      expect(outcome.residueDirectories.at(-1)).toBe(layout.installRoot);
      // the partly removed installation is still one the inspection accepts ...
      expect(inspectPortableManagedInstall(layout).issues).toEqual([]);
      // ... and a foreign entry in it is still refused
      const foreign = join(layout.installRoot, "FOREIGN-ROOT.txt");
      touch(foreign);
      expect(inspectPortableManagedInstall(layout).issues).toEqual([unknown(layout, foreign)]);
      expect(() => {
        removePortableManagedInstallTolerant(layout, noopIo, { deferIdentity: false });
      }).toThrow(unknown(layout, foreign));
      expect(existsSync(foreign)).toBe(true);
    },
  );

  it.each(INSTALLS)(
    "leaves the identity files to the caller when it defers them (%s)",
    (_name, make) => {
      const { layout } = make();
      const touched: string[] = [];
      const outcome = removePortableManagedInstallTolerant(layout, noopIo, {
        deferIdentity: true,
        unlink: (path) => {
          touched.push(path);
          unlinkSync(path);
        },
      });
      expect(outcome.residueFiles).toEqual([
        recordPath(layout),
        layout.packageJsonPath,
        layout.primaryLauncherPath,
        layout.setupManifestPath,
      ]);
      expect(touched).not.toContain(layout.setupManifestPath);
      expect(outcome.residueDirectories.at(-1)).toBe(layout.installRoot);
      expect(inspectPortableManagedInstall(layout).issues).toEqual([]);
    },
  );

  it.each(["EBUSY", "EACCES"])("treats %s on a folder as a remaining folder", (code) => {
    const { layout } = flatInstall("linux-x64");
    const outcome = removePortableManagedInstallTolerant(layout, noopIo, {
      deferIdentity: false,
      rmdir: (path) => {
        if (path === layout.installRoot) throw lock(code);
        rmdirSync(path);
      },
    });
    expect(outcome.residueFiles).toEqual([]);
    expect(outcome.residueDirectories).toEqual([layout.installRoot]);
  });

  it("does not hide an error that is not a held-open entry", () => {
    const { layout } = flatInstall("linux-x64");
    expect(() => {
      removePortableManagedInstallTolerant(layout, noopIo, {
        deferIdentity: false,
        unlink: () => {
          throw lock("EIO");
        },
      });
    }).toThrow("held open");
  });

  it("does nothing for an installation root that is already gone", () => {
    const { layout } = flatInstall("linux-x64");
    rmSync(layout.installRoot, { recursive: true });
    expect(removePortableManagedInstallTolerant(layout, noopIo, { deferIdentity: false })).toEqual({
      removedCount: 0,
      residueFiles: [],
      residueDirectories: [],
    });
  });
});
