import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  inspectPortableManagedInstall,
  portableManagedInstallHealth,
  removePortableManagedInstall,
} from "./portable-maintenance.js";
import { layoutFor, type PortableLayout, type PortableTarget } from "./portable-shared.js";
import {
  realRootPackListing,
  realRootPackSample,
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
  const layout = { ...flat, resourceRoot };
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
      (path) => !path.startsWith("dist/") && !path.startsWith("node_modules/"),
    );
    expect(outside).toEqual(expect.arrayContaining(["package.json", "LICENSE", "NOTICE"]));
    expect(realRootPackSample()).toEqual(expect.arrayContaining(outside));
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
