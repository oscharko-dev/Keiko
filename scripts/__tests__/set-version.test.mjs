import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applySetVersion,
  normalizedLockfileText,
  requireVersion,
  setVersionMain,
  versionedManifest,
  versionedSource,
} from "../lib/set-version.mjs";

// The 1.0.0 cut was written by hand and left package-lock.json's workspace entries at 0.3.17.
// This is the command that moves the version everywhere at once, so the pins here are the places
// it must reach and the formatting it must leave alone.

const WORKSPACES = ["@oscharko-dev/keiko-contracts", "@oscharko-dev/keiko-harness"];

describe("requireVersion", () => {
  it.each([
    "1.0.1",
    "0.3.17",
    "0.0.0",
    "1.2.3-beta.4",
    "1.0.0-0",
    "1.0.0-alpha-1",
    "1.0.0-rc.1.x-y",
  ])("accepts %s", (version) => {
    expect(requireVersion(version)).toBe(version);
  });

  it.each([
    "1.0",
    "1.0.0.0",
    "v1.0.1",
    "01.0.0",
    "1.00.0",
    "1.0.01",
    "1.0.0-",
    "1.0.0-01",
    "1.0.0-beta..4",
    "1.0.0-.beta",
    "1.0.0-beta.",
    "1.0.0-beta_4",
    "1.0.0+build.1",
    "1.0.1\n",
    " 1.0.1",
    "",
    undefined,
    101,
  ])("refuses %j", (version) => {
    expect(() => requireVersion(version)).toThrow("is not a semantic version");
  });
});

describe("versionedManifest", () => {
  const manifestFor = (version) =>
    `${JSON.stringify(
      {
        name: "@oscharko-dev/keiko",
        version,
        files: ["dist", "README.md"],
        dependencies: {
          "@oscharko-dev/keiko-contracts": version,
          "@oscharko-dev/keiko-harness": version,
          yaml: "2.8.1",
        },
        devDependencies: { "@oscharko-dev/keiko-contracts": version },
        bundleDependencies: ["@oscharko-dev/keiko-contracts"],
      },
      null,
      2,
    )}\n`;
  const manifest = manifestFor("1.0.0");

  it("moves the version and every workspace pin, and nothing else", () => {
    const result = versionedManifest(manifest, WORKSPACES, "1.0.1");

    expect(result).toBe(manifestFor("1.0.1"));
    expect(result).toContain('"yaml": "2.8.1"');
    expect(result).toContain('"bundleDependencies": [\n    "@oscharko-dev/keiko-contracts"\n  ]');
  });

  it("rewrites every manifest of this checkout byte for byte apart from the version", () => {
    // The rewrite is JSON.stringify(…, null, 2); prettier's json-stringify form of package.json is
    // exactly that, so a manifest that drifted from it would be reformatted by a version move.
    const root = resolve(import.meta.dirname, "../..");
    const manifests = [
      join(root, "package.json"),
      ...readdirSync(join(root, "packages"))
        .map((name) => join(root, "packages", name, "package.json"))
        .filter((path) => existsSync(path)),
    ];
    expect(manifests.length).toBeGreaterThan(20);
    for (const path of manifests) {
      const text = readFileSync(path, "utf8");
      const { version } = JSON.parse(text);
      expect(versionedManifest(text, [], version), path).toBe(text);
    }
  });

  it("leaves a pin on a package that is not a workspace alone", () => {
    const result = versionedManifest(manifest, ["@oscharko-dev/keiko-harness"], "1.0.1");

    expect(result).toContain('"@oscharko-dev/keiko-contracts": "1.0.0"');
    expect(result).toContain('"@oscharko-dev/keiko-harness": "1.0.1"');
  });

  it("fails closed on a manifest without a version field", () => {
    expect(() => versionedManifest('{\n  "name": "x"\n}\n', WORKSPACES, "1.0.1")).toThrow(
      "no version field",
    );
  });
});

describe("versionedSource", () => {
  it("moves every exported KEIKO_*_VERSION constant and leaves other strings alone", () => {
    const source = [
      'export const KEIKO_CONTRACTS_VERSION = "1.0.0" as const;',
      'export const KEIKO_PRODUCT_VERSION = "1.0.0" as const;',
      'export const SCHEMA_VERSION = "1.0.0" as const;',
      'const note = "1.0.0";',
      "",
    ].join("\n");

    expect(versionedSource(source, "1.0.1")).toBe(
      [
        'export const KEIKO_CONTRACTS_VERSION = "1.0.1" as const;',
        'export const KEIKO_PRODUCT_VERSION = "1.0.1" as const;',
        'export const SCHEMA_VERSION = "1.0.0" as const;',
        'const note = "1.0.0";',
        "",
      ].join("\n"),
    );
  });
});

describe("applySetVersion", () => {
  const ROOT = "/repo";

  function repo(version = "1.0.0") {
    const files = new Map([
      [
        join(ROOT, "package.json"),
        `{\n  "name": "@oscharko-dev/keiko",\n  "version": "${version}",\n  "dependencies": {\n    "@oscharko-dev/keiko-contracts": "${version}"\n  }\n}\n`,
      ],
      [
        join(ROOT, "packages/keiko-contracts/package.json"),
        `{\n  "name": "@oscharko-dev/keiko-contracts",\n  "version": "${version}"\n}\n`,
      ],
      [
        join(ROOT, "packages/keiko-contracts/src/version.ts"),
        `export const KEIKO_PRODUCT_VERSION = "${version}" as const;\n`,
      ],
      [
        join(ROOT, "packages/keiko-harness/package.json"),
        `{\n  "name": "@oscharko-dev/keiko-harness",\n  "version": "${version}",\n  "dependencies": {\n    "@oscharko-dev/keiko-contracts": "${version}"\n  }\n}\n`,
      ],
    ]);
    const spawned = [];
    const seams = {
      listWorkspaceDirs: (packagesDir) => [
        join(packagesDir, "keiko-contracts"),
        join(packagesDir, "keiko-harness"),
      ],
      readOptionalText: (path) => files.get(path),
      readText: (path) => {
        if (!files.has(path)) throw new Error(`missing ${path}`);
        return files.get(path);
      },
      root: ROOT,
      spawn: (executable, args, cwd) => {
        spawned.push([executable, ...args, `@${cwd}`]);
        return { status: 0, stdout: "", stderr: "" };
      },
      writeText: (path, text) => files.set(path, text),
    };
    return { files, seams, spawned };
  }

  it("writes every manifest, pin and constant, then refreshes the lockfile and proves it", () => {
    const { files, seams, spawned } = repo();

    const changed = applySetVersion({ ...seams, version: "1.0.1" });

    expect(changed).toStrictEqual([
      join(ROOT, "package.json"),
      join(ROOT, "packages/keiko-contracts/package.json"),
      join(ROOT, "packages/keiko-harness/package.json"),
      join(ROOT, "packages/keiko-contracts/src/version.ts"),
    ]);
    for (const text of files.values()) expect(text).not.toContain("1.0.0");
    expect(spawned).toStrictEqual([
      ["npm", "install", "--package-lock-only", "--ignore-scripts", `@${ROOT}`],
      ["node", "scripts/check-version-consistency.mjs", `@${ROOT}`],
    ]);
  });

  it("changes nothing when the version is already in place, and still proves it", () => {
    const { seams, spawned } = repo("1.0.1");

    expect(applySetVersion({ ...seams, version: "1.0.1" })).toStrictEqual([]);
    expect(spawned).toHaveLength(2);
  });

  it("fails when the lockfile refresh fails, and names it", () => {
    const { seams } = repo();
    const spawn = (executable) =>
      executable === "npm" ? { status: 1, stdout: "", stderr: "E401" } : { status: 0 };

    expect(() => applySetVersion({ ...seams, spawn, version: "1.0.1" })).toThrow(
      "the lockfile refresh failed: E401",
    );
  });

  it("fails when the consistency check refuses the result", () => {
    const { seams } = repo();
    const spawn = (executable) =>
      executable === "node" ? { status: 1, stdout: "", stderr: "" } : { status: 0 };

    expect(() => applySetVersion({ ...seams, spawn, version: "1.0.1" })).toThrow(
      "the version consistency check failed.",
    );
  });

  it("refuses a malformed version before touching any file", () => {
    const { files, seams } = repo();
    const before = new Map(files);

    expect(() => applySetVersion({ ...seams, version: "1.0" })).toThrow("not a semantic version");
    expect(files).toStrictEqual(before);
  });
});

describe("setVersionMain", () => {
  function main(argv, seams) {
    const written = [];
    const code = setVersionMain({
      argv,
      listWorkspaceDirs: () => [],
      readOptionalText: () => undefined,
      readText: () => '{\n  "name": "@oscharko-dev/keiko",\n  "version": "1.0.0"\n}\n',
      root: "/repo",
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
      write: (stream, text) => written.push([stream, text]),
      writeText: () => undefined,
      ...seams,
    });
    return { code, written };
  }

  it("reports the files written and what stays reviewed work", () => {
    const { code, written } = main(["1.0.1"]);

    expect(code).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0][0]).toBe("stdout");
    expect(written[0][1]).toContain("1.0.1 written to 1 file(s)");
    expect(written[0][1]).toContain("release-impact catalog entry");
  });

  it("prints a known refusal as it is and exits 1", () => {
    const { code, written } = main(["nope"]);

    expect(code).toBe(1);
    expect(written).toStrictEqual([["stderr", 'set-version: "nope" is not a semantic version.\n']]);
  });

  it("prefixes an unexpected failure", () => {
    const { code, written } = main(["1.0.1"], {
      readText: () => {
        throw new TypeError("disk gone");
      },
    });

    expect(code).toBe(1);
    expect(written).toStrictEqual([["stderr", "set-version: disk gone\n"]]);
  });
});

// A version bump rewrites every workspace package's own version and every dependency pin ON a
// workspace package -- 324 lines on the 1.0.5 to 1.0.6 lockfile alone. None of that is reachable
// from the compiled tool-catalog producer check:tool-catalog-performance measures, so it must never
// move that gate's subject hash; a real dependency change (added, removed, re-resolved, third-party
// bumped) must. It also underpins release-version-bump.mjs's content verification of a version-bump
// pull request: a lockfile that normalizes identically to its parent changed only the way a version
// bump changes it.
describe("normalizedLockfileText", () => {
  const baseLockfile = {
    version: "1.0.5",
    lockfileVersion: 3,
    packages: {
      "": { name: "@oscharko-dev/keiko", version: "1.0.5", dependencies: {} },
      "packages/keiko-contracts": { name: "@oscharko-dev/keiko-contracts", version: "1.0.5" },
      "packages/keiko-server": {
        name: "@oscharko-dev/keiko-server",
        version: "1.0.5",
        dependencies: { "@oscharko-dev/keiko-contracts": "1.0.5", zod: "^3.23.0" },
      },
      "node_modules/zod": { version: "3.23.0", resolved: "https://registry/zod", integrity: "x" },
    },
  };

  it("is unchanged by a version bump across every workspace field", () => {
    const bumped = structuredClone(baseLockfile);
    bumped.version = "1.0.6";
    bumped.packages[""].version = "1.0.6";
    bumped.packages["packages/keiko-contracts"].version = "1.0.6";
    bumped.packages["packages/keiko-server"].version = "1.0.6";
    bumped.packages["packages/keiko-server"].dependencies["@oscharko-dev/keiko-contracts"] =
      "1.0.6";
    expect(normalizedLockfileText(JSON.stringify(bumped))).toBe(
      normalizedLockfileText(JSON.stringify(baseLockfile)),
    );
  });

  it("still moves on a real third-party dependency change", () => {
    const changed = structuredClone(baseLockfile);
    changed.packages["node_modules/zod"].integrity = "y";
    expect(normalizedLockfileText(JSON.stringify(changed))).not.toBe(
      normalizedLockfileText(JSON.stringify(baseLockfile)),
    );
  });

  it("still moves when a workspace package's dependency set actually changes", () => {
    const changed = structuredClone(baseLockfile);
    changed.packages["packages/keiko-server"].dependencies.lodash = "^4.17.21";
    expect(normalizedLockfileText(JSON.stringify(changed))).not.toBe(
      normalizedLockfileText(JSON.stringify(baseLockfile)),
    );
  });

  it("leaves a non-workspace package's own version untouched", () => {
    const parsed = JSON.parse(normalizedLockfileText(JSON.stringify(baseLockfile)));
    expect(parsed.packages["node_modules/zod"].version).toBe("3.23.0");
  });
});
