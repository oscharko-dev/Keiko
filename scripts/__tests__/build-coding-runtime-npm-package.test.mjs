import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildCodingRuntimeNpmPackage,
  codingRuntimePackageManifest,
  codingRuntimePackageName,
  main,
  NPM_RUNTIME_PACKAGE_TARGETS,
} from "../build-coding-runtime-npm-package.mjs";

// #3577. The runtime packages are what lets an npm-installed Keiko run the Coding Workbench. The
// server verifies their content against digests compiled into it, so the builder's two promises are
// what these tests pin: the package carries exactly the approved payload plus the built helper in
// the layout the npm lane reads, and its manifest is one the main package's supply-chain gates and
// npm's platform selection accept.

const roots = [];

function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-package-")));
  roots.push(root);
  return root;
}

function write(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

const HELPER = "built-helper";

function fakeDeps(overrides = {}) {
  const calls = { prepare: [], build: [] };
  return {
    calls,
    deps: {
      prepareSidecars: async (argv) => {
        calls.prepare.push(argv);
        const target = argv[1];
        const payload = join(argv[3], target, "opencode-compatible", "payload");
        write(join(payload, "bin", "opencode"), "approved-executable");
        write(join(payload, "evidence", "LICENSE"), "MIT");
        write(join(payload, "evidence", "sbom.cdx.json"), "{}");
        // The staging root also holds the downloaded archive and a spec; neither may ship.
        write(join(argv[3], target, "opencode-compatible", "opencode-darwin-arm64.zip"), "zip");
      },
      runBuild: async ({ argv }) => {
        calls.build.push(argv);
        write(argv[3], HELPER);
        return overrides.buildStatus ?? 0;
      },
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("coding runtime npm package", () => {
  it.each(Object.entries(NPM_RUNTIME_PACKAGE_TARGETS))(
    "%s declares the platform npm selects it by, a valid SPDX license and no install hook",
    (target, { cpu, os, suffix }) => {
      const manifest = codingRuntimePackageManifest(target, "1.2.3");
      expect(manifest).toMatchObject({
        name: `@oscharko-dev/keiko-coding-runtime-${suffix}`,
        version: "1.2.3",
        license: "Apache-2.0 AND MIT",
        os: [os],
        cpu: [cpu],
        files: ["runtime", "LICENSE.md"],
        publishConfig: { access: "public" },
      });
      expect(manifest.scripts).toBeUndefined();
      expect(manifest.dependencies).toBeUndefined();
      expect(codingRuntimePackageName(target)).toBe(manifest.name);
    },
  );

  it("refuses a target it has no platform mapping for", () => {
    expect(() => codingRuntimePackageName("linux-x64")).toThrow("unsupported npm runtime package");
  });

  it("stages exactly the approved payload and the built helper in the npm lane's layout", async () => {
    const outDir = join(scratch(), "package");
    const { calls, deps } = fakeDeps();

    const result = await buildCodingRuntimeNpmPackage({
      target: "macos-arm64",
      version: "1.2.3",
      outDir,
      deps,
    });

    expect(calls.prepare[0].slice(0, 3)).toStrictEqual([
      "--target",
      "macos-arm64",
      "--output-root",
    ]);
    expect(calls.build[0][2]).toBe("macos-arm64");
    const runtime = join(outDir, "runtime");
    expect(readFileSync(join(runtime, "opencode-compatible/payload/bin/opencode"), "utf8")).toBe(
      "approved-executable",
    );
    expect(existsSync(join(runtime, "opencode-compatible/payload/evidence/LICENSE"))).toBe(true);
    expect(existsSync(join(runtime, "opencode-compatible/payload/evidence/sbom.cdx.json"))).toBe(
      true,
    );
    expect(existsSync(join(runtime, "opencode-compatible/opencode-darwin-arm64.zip"))).toBe(false);
    expect(readFileSync(join(runtime, "native/keiko-secure-workspace-read"), "utf8")).toBe(HELPER);
    expect(JSON.parse(readFileSync(join(outDir, "package.json"), "utf8")).version).toBe("1.2.3");
    expect(readFileSync(join(outDir, "LICENSE.md"), "utf8")).toContain("MIT License");
    // The digests the server pins are the digests of what was staged.
    expect(result).toStrictEqual({
      helperSha256: createHash("sha256").update(HELPER).digest("hex"),
      helperSizeBytes: HELPER.length,
      name: "@oscharko-dev/keiko-coding-runtime-darwin-arm64",
      outDir,
      target: "macos-arm64",
    });
    // The staging directory with the downloaded archive is gone.
    expect(existsSync(calls.prepare[0][3])).toBe(false);
  });

  it("refuses a relative output directory", async () => {
    await expect(
      buildCodingRuntimeNpmPackage({
        target: "macos-arm64",
        version: "1.2.3",
        outDir: "relative/out",
        deps: fakeDeps().deps,
      }),
    ).rejects.toThrow("absolute path");
  });

  it("never deletes an output directory that already holds something", async () => {
    const outDir = join(scratch(), "package");
    write(join(outDir, "keep.txt"), "operator data");
    const { calls, deps } = fakeDeps();

    await expect(
      buildCodingRuntimeNpmPackage({ target: "macos-arm64", version: "1.2.3", outDir, deps }),
    ).rejects.toThrow("must not exist or must be empty");
    expect(readFileSync(join(outDir, "keep.txt"), "utf8")).toBe("operator data");
    expect(calls.prepare).toHaveLength(0);
  });

  it("fails when the helper build fails, and still removes its staging directory", async () => {
    const outDir = join(scratch(), "package");
    const { calls, deps } = fakeDeps({ buildStatus: 1 });

    await expect(
      buildCodingRuntimeNpmPackage({ target: "macos-x64", version: "1.2.3", outDir, deps }),
    ).rejects.toThrow("secure-workspace-read build failed with status 1");
    expect(existsSync(calls.prepare[0][3])).toBe(false);
  });

  it("prints the digests the server pins, and a usage line for a wrong argument count", async () => {
    const lines = { log: [], error: [] };
    const write = { log: (text) => lines.log.push(text), error: (text) => lines.error.push(text) };
    const built = [];
    const build = async (input) => {
      built.push(input);
      return { helperSha256: "a".repeat(64), target: input.target };
    };

    await expect(main(["macos-arm64", "1.2.3"], { build, write })).resolves.toBe(2);
    expect(lines.error[0]).toContain("usage:");
    expect(built).toHaveLength(0);

    await expect(main(["macos-arm64", "1.2.3", "/abs/out"], { build, write })).resolves.toBe(0);
    expect(built).toStrictEqual([{ target: "macos-arm64", version: "1.2.3", outDir: "/abs/out" }]);
    expect(JSON.parse(lines.log[0])).toMatchObject({ target: "macos-arm64" });
  });
});
