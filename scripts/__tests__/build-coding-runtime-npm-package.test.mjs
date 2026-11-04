import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import * as builder from "../build-coding-runtime-npm-package.mjs";

import {
  buildCodingRuntimeNpmPackage,
  codingRuntimePackageManifest,
  codingRuntimePackageName,
  main,
  NPM_RUNTIME_PACKAGE_TARGETS,
  packCodingRuntimeNpmCandidate,
  packRuntimeCandidate,
  verifyCodingRuntimeNpmCandidate,
} from "../build-coding-runtime-npm-package.mjs";
import { computePortableSidecarPayloadTreeDigest } from "../../packages/keiko-server/dist/coding-runtime/devLanePortableCodingRuntime.js";
import { ripgrepRuntimeApproval } from "../../packages/keiko-server/src/coding-runtime/ripgrepRuntime.ts";
import { portableTargetByName } from "../portable-runtime.mjs";
import { stageRipgrepTool } from "../stage-portable-runtime.mjs";
import { hashHelperSourceTree } from "../stage-dev-coding-runtime.mjs";
import { resolveHostExecutable } from "../lib/host-executable.mjs";

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
const RIPGREP = "pinned-upstream-ripgrep";
const RIPGREP_MIT = "MIT license text shipped with ripgrep";
const sha256Of = (value) => createHash("sha256").update(value).digest("hex");

it("packs a local candidate with literal host paths and without executing package scripts", () => {
  const root = scratch();
  const packageDir = join(root, "package space & %PATH% ü");
  const artifacts = join(root, "artifacts space & %PATH% ü");
  mkdirSync(artifacts);
  write(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: "keiko-windows-pack-fixture",
      version: "1.0.0",
      files: ["index.js"],
      scripts: { prepack: 'node -e "process.exit(99)"' },
    }),
  );
  write(join(packageDir, "index.js"), "export const fixture = true;\n");

  const packed = packRuntimeCandidate(packageDir, artifacts);

  expect(packed.filename).toBe("keiko-windows-pack-fixture-1.0.0.tgz");
  expect(packed.files.map(({ path }) => path).sort()).toEqual(["index.js", "package.json"]);
  expect(statSync(join(artifacts, packed.filename)).size).toBe(packed.size);
  expect(packed.integrity).toBe(
    `sha512-${createHash("sha512")
      .update(readFileSync(join(artifacts, packed.filename)))
      .digest("base64")}`,
  );
});

// The pinned ripgrep release is data the server owns (ripgrepRuntime.ts); the builder stages and
// verifies against it. These tests substitute a manifest whose digests bind their own fixture bytes.
function fixtureRipgrepApproval() {
  return ripgrepRuntimeApproval("darwin-arm64", {
    version: "0.0.0-test",
    sourceCommit: "a".repeat(40),
    licenseExpression: "Unlicense OR MIT",
    licenseFileName: "LICENSE-MIT",
    targets: {
      "darwin-arm64": {
        archiveKind: "tar.gz",
        archiveUrl: "https://example.test/ripgrep-0.0.0-test.tar.gz",
        archiveSha256: "b".repeat(64),
        archiveSizeBytes: 10,
        binaryMember: "ripgrep/rg",
        binarySha256: sha256Of(RIPGREP),
        binarySizeBytes: RIPGREP.length,
        licenseMember: "ripgrep/LICENSE-MIT",
        licenseSha256: sha256Of(RIPGREP_MIT),
      },
    },
  });
}

function catalogUpstreamVersion() {
  const catalog = JSON.parse(
    readFileSync(join(process.cwd(), "portable-runtime-approvals.json"), "utf8"),
  );
  return catalog.sidecarRuntimes.find((runtime) => runtime.name === "opencode-compatible").upstream
    .version;
}

async function releaseFixture() {
  const root = scratch();
  const packageDir = join(root, "package");
  const artifactDir = join(root, "artifacts");
  const target = "macos-arm64";
  const built = await buildCodingRuntimeNpmPackage({
    target,
    version: "1.2.3",
    outDir: packageDir,
    deps: fakeDeps().deps,
  });
  const payload = join(packageDir, "runtime/opencode-compatible/payload");
  chmodSync(join(payload, "bin/opencode"), 0o755);
  chmodSync(join(packageDir, "runtime/native/keiko-secure-workspace-read"), 0o755);
  chmodSync(join(packageDir, "runtime/native/rg"), 0o755);
  const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const approval = {
    packageName: built.name,
    // The receipt binds the approval to the OpenCode version the repository's portable catalog
    // currently approves; a restated version would drift from the producer on every upgrade.
    upstreamVersion: catalogUpstreamVersion(),
    helperSha256: built.helperSha256,
    helperSizeBytes: built.helperSizeBytes,
    helperSourceCommit: "a".repeat(40),
    helperSourceTreeSha256: hashHelperSourceTree(
      join(process.cwd(), "native/secure-workspace-read"),
    ),
    helperMaxBytes: 1_048_576,
    executableTreeSha256: computePortableSidecarPayloadTreeDigest([
      { relativePath: "bin/opencode", sha256: digest(join(payload, "bin/opencode")) },
    ]),
    licenseSha256: digest(join(payload, "evidence/LICENSE")),
    sbomSha256: digest(join(payload, "evidence/sbom.cdx.json")),
    ripgrep: fixtureRipgrepApproval(),
  };
  const calls = [];
  const deps = {
    loadApproval: async () => approval,
    verifySourceCommit: (commit) => calls.push(commit),
    verifyPackedContents: () => calls.push("packed-content-verification"),
    pack: (packageDir, output) => {
      const filename = "fixture-runtime-1.2.3.tgz";
      write(join(output, filename), "immutable packed candidate");
      const files = readdirSync(packageDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const full = join(entry.parentPath, entry.name);
          const status = statSync(full);
          return {
            path: relative(packageDir, full).split("\\").join("/"),
            size: status.size,
            mode: status.mode & 0o777,
          };
        })
        .sort((left, right) => left.path.localeCompare(right.path));
      return { name: built.name, version: "1.2.3", filename, files };
    },
  };
  return { packageDir, artifactDir, target, approval, calls, deps };
}

function releaseInput(fixture) {
  return {
    target: fixture.target,
    version: "1.2.3",
    packageDir: fixture.packageDir,
    artifactDir: fixture.artifactDir,
  };
}

function fakeDeps(overrides = {}) {
  const calls = { prepare: [], build: [], ripgrep: [] };
  return {
    calls,
    deps: {
      stageRipgrep: async (target, packageRoot) => {
        calls.ripgrep.push({ target, packageRoot });
        write(join(packageRoot, "runtime/native/rg"), RIPGREP);
        chmodSync(join(packageRoot, "runtime/native/rg"), 0o755);
        write(join(packageRoot, "runtime/licenses/ripgrep/LICENSE-MIT"), RIPGREP_MIT);
        return fixtureRipgrepApproval();
      },
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
  it("packs the existing candidate and records its approved source rather than today's HEAD", async () => {
    const fixture = await releaseFixture();
    const lines = [];
    const errors = [];
    const result = await main(
      ["--pack", fixture.target, "1.2.3", fixture.packageDir, fixture.artifactDir],
      {
        releaseDeps: fixture.deps,
        write: { log: (line) => lines.push(line), error: (line) => errors.push(line) },
      },
    );
    expect(result).toBe(0);
    const receipt = JSON.parse(readFileSync(join(fixture.artifactDir, "receipt.json"), "utf8"));
    expect(receipt.helper.sourceCommit).toBe(fixture.approval.helperSourceCommit);
    expect(receipt.helper.sourceTreeSha256).toBe(fixture.approval.helperSourceTreeSha256);
    expect(receipt.tarball.integrity).toMatch(/^sha512-/u);
    expect(existsSync(join(fixture.artifactDir, receipt.tarball.filename))).toBe(true);
    expect(JSON.parse(lines[0]).receipt).toStrictEqual(receipt);
    expect(fixture.calls).toContain(fixture.approval.helperSourceCommit);
    expect(errors).toHaveLength(0);
  });

  it.skipIf(process.platform === "win32")(
    "produces and rechecks an actual npm tarball without lifecycle scripts",
    async () => {
      const fixture = await releaseFixture();
      const deps = {
        loadApproval: fixture.deps.loadApproval,
        verifySourceCommit: fixture.deps.verifySourceCommit,
      };
      const prepared = await packCodingRuntimeNpmCandidate(releaseInput(fixture), deps);
      expect(
        (await verifyCodingRuntimeNpmCandidate(releaseInput(fixture), deps)).receipt,
      ).toStrictEqual(prepared.receipt);
      expect(readFileSync(prepared.tarballPath).subarray(0, 2)).toStrictEqual(
        Buffer.from([0x1f, 0x8b]),
      );
      expect(prepared.receipt.files).toHaveLength(9);
      expect(statSync(prepared.tarballPath).mode & 0o222).toBe(0);
      expect(statSync(prepared.receiptPath).mode & 0o222).toBe(0);
    },
  );

  it.each([
    ["version", { version: "1.1.3" }],
    ["architecture", { cpu: ["x64"] }],
    ["platform", { os: ["linux"] }],
    ["install hook", { scripts: { postinstall: "unapproved-hook" } }],
  ])("refuses a candidate with a mismatched %s before packing", async (_label, change) => {
    const fixture = await releaseFixture();
    const path = join(fixture.packageDir, "package.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    write(path, JSON.stringify({ ...manifest, ...change }));
    await expect(
      packCodingRuntimeNpmCandidate(releaseInput(fixture), fixture.deps),
    ).rejects.toThrow("manifest, version or architecture mismatch");
    expect(existsSync(fixture.artifactDir)).toBe(false);
  });

  it.each([
    ["native helper", "runtime/native/keiko-secure-workspace-read", "BUILT-helper"],
    ["OpenCode", "runtime/opencode-compatible/payload/bin/opencode", "different-executable"],
    ["license", "runtime/opencode-compatible/payload/evidence/LICENSE", "different-license"],
    ["SBOM", "runtime/opencode-compatible/payload/evidence/sbom.cdx.json", "different-sbom"],
    ["ripgrep executable", "runtime/native/rg", "different-ripgrep"],
    ["ripgrep license", "runtime/licenses/ripgrep/LICENSE-MIT", "different-ripgrep-license"],
    ["ripgrep SBOM", "runtime/licenses/ripgrep/sbom.cdx.json", "different-ripgrep-sbom"],
  ])("refuses a stale %s against the independently approved pins", async (_label, path, body) => {
    const fixture = await releaseFixture();
    writeFileSync(join(fixture.packageDir, path), body);
    await expect(
      packCodingRuntimeNpmCandidate(releaseInput(fixture), fixture.deps),
    ).rejects.toThrow("digest mismatch");
    expect(existsSync(fixture.artifactDir)).toBe(false);
  });

  it("refuses a stale helper source binding and a commit that cannot bind that source", async () => {
    const fixture = await releaseFixture();
    const stale = { ...fixture.approval, helperSourceTreeSha256: "f".repeat(64) };
    await expect(
      packCodingRuntimeNpmCandidate(releaseInput(fixture), {
        ...fixture.deps,
        loadApproval: async () => stale,
      }),
    ).rejects.toThrow("helper source is stale");
    await expect(
      packCodingRuntimeNpmCandidate(releaseInput(fixture), {
        ...fixture.deps,
        verifySourceCommit: () => {
          throw new Error("source commit does not match");
        },
      }),
    ).rejects.toThrow("source commit does not match");
    expect(existsSync(fixture.artifactDir)).toBe(false);
  });

  it("requires the actual packed tarball and checks npm's returned integrity", async () => {
    const fixture = await releaseFixture();
    await expect(
      packCodingRuntimeNpmCandidate(releaseInput(fixture), {
        ...fixture.deps,
        pack: (...args) => {
          const result = fixture.deps.pack(...args);
          rmSync(join(args[1], result.filename));
          return result;
        },
      }),
    ).rejects.toThrow("ENOENT");
    await expect(
      packCodingRuntimeNpmCandidate(releaseInput(fixture), {
        ...fixture.deps,
        pack: (...args) => ({ ...fixture.deps.pack(...args), integrity: "sha512-wrong" }),
      }),
    ).rejects.toThrow("tarball integrity mismatch");
    expect(existsSync(join(fixture.artifactDir, "receipt.json"))).toBe(false);
  });

  it("does not certify package bytes that change during npm pack", async () => {
    const fixture = await releaseFixture();
    await expect(
      packCodingRuntimeNpmCandidate(releaseInput(fixture), {
        ...fixture.deps,
        pack: (...args) => {
          const packed = fixture.deps.pack(...args);
          writeFileSync(join(fixture.packageDir, "LICENSE.md"), "changed after packing");
          return packed;
        },
      }),
    ).rejects.toThrow("changed during packing");
    expect(existsSync(join(fixture.artifactDir, "receipt.json"))).toBe(false);
  });

  it.each(["receipt", "tarball", "missing-tarball"])(
    "rejects a changed %s on independent verification",
    async (changed) => {
      const fixture = await releaseFixture();
      const prepared = await packCodingRuntimeNpmCandidate(releaseInput(fixture), fixture.deps);
      if (changed === "receipt") {
        chmodSync(prepared.receiptPath, 0o644);
        writeFileSync(
          prepared.receiptPath,
          JSON.stringify({
            ...prepared.receipt,
            helper: { ...prepared.receipt.helper, sourceCommit: "b".repeat(40) },
          }),
        );
      } else if (changed === "tarball") {
        chmodSync(prepared.tarballPath, 0o644);
        writeFileSync(prepared.tarballPath, "different packed bytes");
      } else {
        rmSync(prepared.tarballPath);
      }
      await expect(
        verifyCodingRuntimeNpmCandidate(releaseInput(fixture), fixture.deps),
      ).rejects.toThrow(changed === "missing-tarball" ? "ENOENT" : "receipt mismatch");
    },
  );

  it("does not overwrite an existing candidate receipt", async () => {
    const fixture = await releaseFixture();
    const prepared = await packCodingRuntimeNpmCandidate(releaseInput(fixture), fixture.deps);
    const receiptBytes = readFileSync(prepared.receiptPath);
    await expect(
      packCodingRuntimeNpmCandidate(releaseInput(fixture), fixture.deps),
    ).rejects.toThrow("artifactDir must not exist");
    expect(readFileSync(prepared.receiptPath)).toStrictEqual(receiptBytes);
  });

  it.skipIf(process.platform === "win32")(
    "refuses unapproved packed bytes even when their receipt integrity was recomputed",
    async () => {
      const fixture = await releaseFixture();
      const deps = {
        loadApproval: fixture.deps.loadApproval,
        verifySourceCommit: fixture.deps.verifySourceCommit,
      };
      const prepared = await packCodingRuntimeNpmCandidate(releaseInput(fixture), deps);
      const changedDir = join(scratch(), "changed-package");
      cpSync(fixture.packageDir, changedDir, { recursive: true });
      writeFileSync(join(changedDir, "runtime/native/keiko-secure-workspace-read"), "evil!-helper");
      const packed = JSON.parse(
        execFileSync(
          resolveHostExecutable("npm"),
          [
            "pack",
            changedDir,
            "--ignore-scripts",
            "--json",
            "--pack-destination",
            dirname(changedDir),
          ],
          { encoding: "utf8" },
        ),
      ).at(0);
      const changedBytes = readFileSync(join(dirname(changedDir), packed.filename));
      chmodSync(prepared.tarballPath, 0o644);
      writeFileSync(prepared.tarballPath, changedBytes);
      chmodSync(prepared.receiptPath, 0o644);
      writeFileSync(
        prepared.receiptPath,
        JSON.stringify({
          ...prepared.receipt,
          tarball: {
            ...prepared.receipt.tarball,
            sizeBytes: changedBytes.length,
            sha256: createHash("sha256").update(changedBytes).digest("hex"),
            integrity: packed.integrity,
          },
        }),
      );
      await expect(verifyCodingRuntimeNpmCandidate(releaseInput(fixture), deps)).rejects.toThrow(
        "packed contents",
      );
    },
  );

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

  describe("pinned ripgrep (#4064)", () => {
    const RG = "runtime/native/rg";
    const RG_LICENSE = "runtime/licenses/ripgrep/LICENSE-MIT";
    const RG_SBOM = "runtime/licenses/ripgrep/sbom.cdx.json";

    it("stages the pinned executable, its MIT text and a component SBOM in the portable layout", async () => {
      const outDir = join(scratch(), "package");
      const { calls, deps } = fakeDeps();

      await buildCodingRuntimeNpmPackage({ target: "macos-arm64", version: "1.2.3", outDir, deps });

      expect(calls.ripgrep).toStrictEqual([{ target: "macos-arm64", packageRoot: outDir }]);
      expect(readFileSync(join(outDir, RG), "utf8")).toBe(RIPGREP);
      expect(readFileSync(join(outDir, RG_LICENSE), "utf8")).toBe(RIPGREP_MIT);
      const sbom = JSON.parse(readFileSync(join(outDir, RG_SBOM), "utf8"));
      expect(sbom.bomFormat).toBe("CycloneDX");
      expect(sbom.components).toHaveLength(1);
      expect(sbom.components[0]).toMatchObject({
        name: "ripgrep",
        version: "0.0.0-test",
        hashes: [{ alg: "SHA-256", content: sha256Of(RIPGREP) }],
        externalReferences: [
          {
            url: "https://example.test/ripgrep-0.0.0-test.tar.gz",
            hashes: [{ alg: "SHA-256", content: "b".repeat(64) }],
          },
        ],
      });
      // The component describes the bytes in the package, so a reproducible build is byte-identical.
      const again = join(scratch(), "package");
      await buildCodingRuntimeNpmPackage({
        target: "macos-arm64",
        version: "1.2.3",
        outDir: again,
        deps: fakeDeps().deps,
      });
      expect(readFileSync(join(again, RG_SBOM), "utf8")).toBe(
        readFileSync(join(outDir, RG_SBOM), "utf8"),
      );
    });

    it("names ripgrep, its license choice and its source in the shipped notice", async () => {
      const outDir = join(scratch(), "package");
      await buildCodingRuntimeNpmPackage({
        target: "macos-arm64",
        version: "1.2.3",
        outDir,
        deps: fakeDeps().deps,
      });
      const notice = readFileSync(join(outDir, "LICENSE.md"), "utf8");
      expect(notice).toContain("three components");
      expect(notice).toContain("`runtime/native/rg`");
      expect(notice).toContain("ripgrep 0.0.0-test");
      expect(notice).toContain("Unlicense OR MIT");
      expect(notice).toContain("`runtime/licenses/ripgrep/LICENSE-MIT`");
      expect(notice).toContain("https://example.test/ripgrep-0.0.0-test.tar.gz");
    });

    it("lists the three ripgrep files in the candidate and binds the pinned release in the receipt", async () => {
      const fixture = await releaseFixture();
      const { receipt } = await packCodingRuntimeNpmCandidate(releaseInput(fixture), fixture.deps);
      expect(receipt.files.map(({ path }) => path)).toStrictEqual(
        expect.arrayContaining([RG, RG_LICENSE, RG_SBOM]),
      );
      expect(receipt.files.find(({ path }) => path === RG)).toMatchObject({
        sha256: sha256Of(RIPGREP),
        sizeBytes: RIPGREP.length,
        mode: 0o755,
      });
      expect(receipt.ripgrep).toStrictEqual({
        version: "0.0.0-test",
        sourceCommit: "a".repeat(40),
        archiveSha256: "b".repeat(64),
        binarySha256: sha256Of(RIPGREP),
        licenseSha256: sha256Of(RIPGREP_MIT),
      });
    });

    it("refuses a package that does not carry ripgrep instead of sealing it", async () => {
      const fixture = await releaseFixture();
      rmSync(join(fixture.packageDir, RG));
      await expect(
        packCodingRuntimeNpmCandidate(releaseInput(fixture), fixture.deps),
      ).rejects.toThrow("exactly the nine approved package files");
      expect(existsSync(fixture.artifactDir)).toBe(false);
    });

    it.skipIf(process.platform === "win32")(
      "refuses a ripgrep executable that lost its executable permission",
      async () => {
        const fixture = await releaseFixture();
        chmodSync(join(fixture.packageDir, RG), 0o644);
        await expect(
          packCodingRuntimeNpmCandidate(releaseInput(fixture), fixture.deps),
        ).rejects.toThrow("executable permissions");
        expect(existsSync(fixture.artifactDir)).toBe(false);
      },
    );

    it("provisions and stages the target's own release through the shared portable staging", () => {
      const calls = [];
      const approval = builder.stagePinnedNpmRipgrep("macos-x64", "/package", {
        provision: (options) => calls.push(["provision", options]),
        stage: (target, root, options) => calls.push(["stage", target, root, options]),
      });
      // The target's release, never the build host's: one Mac builds both architectures.
      expect(approval).toStrictEqual(ripgrepRuntimeApproval("darwin-x64"));
      expect(calls.map(([kind]) => kind)).toStrictEqual(["provision", "stage"]);
      expect(calls[0][1]).toMatchObject({ hostPlatform: "darwin", hostArchitecture: "x64" });
      expect(calls[1].slice(1, 3)).toStrictEqual([portableTargetByName("macos-x64"), "/package"]);
      // Both stages fail closed by throwing: neither may exit the process mid-build.
      expect(() => calls[0][1].failWith("boom")).toThrow("boom");
      expect(() => calls[1][3].onFailure("boom")).toThrow("boom");
      expect(() => builder.stagePinnedNpmRipgrep("linux-x64", "/package")).toThrow(
        "unsupported npm runtime package target",
      );
    });

    it("stages the real shared function's output into the package layout with its executable bit", () => {
      const root = scratch();
      const sourceBinary = join(root, "source", "rg");
      const sourceLicense = join(root, "source", "LICENSE-MIT");
      write(sourceBinary, RIPGREP);
      write(sourceLicense, RIPGREP_MIT);
      const packageRoot = join(root, "package");
      builder.stagePinnedNpmRipgrep("macos-arm64", packageRoot, {
        provision: () => undefined,
        stage: (target, destination, options) =>
          stageRipgrepTool(target, destination, {
            ...options,
            resolveRuntime: () => ({
              approved: fixtureRipgrepApproval(),
              sourceBinary,
              sourceLicense,
            }),
          }),
      });
      expect(readFileSync(join(packageRoot, RG), "utf8")).toBe(RIPGREP);
      expect(readFileSync(join(packageRoot, RG_LICENSE), "utf8")).toBe(RIPGREP_MIT);
      if (process.platform !== "win32") {
        expect(statSync(join(packageRoot, RG)).mode & 0o111).not.toBe(0);
      }
    });
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

    const outDir = resolve("/abs/out");
    await expect(main(["macos-arm64", "1.2.3", outDir], { build, write })).resolves.toBe(0);
    expect(built).toStrictEqual([{ target: "macos-arm64", version: "1.2.3", outDir }]);
    expect(JSON.parse(lines.log[0])).toMatchObject({ target: "macos-arm64" });
  });
});

function shellQuotedPath(path) {
  return "'" + path.replaceAll("'", "'\"'\"'") + "'";
}

describe("trusted archive tool in actual npm candidate verification", () => {
  it.skipIf(process.platform === "win32")(
    "ignores a workspace tar canary during real npm pack and default content verification",
    async () => {
      const fixture = await releaseFixture();
      const workspace = mkdtempSync(join(process.cwd(), ".keiko-tar-canary-"));
      const marker = join(workspace, "invocations");
      const tar = resolveHostExecutable("tar");
      writeFileSync(
        join(workspace, "tar"),
        `#!/bin/sh\nprintf 'called\n' >> ${shellQuotedPath(marker)}\nexec ${shellQuotedPath(tar)} "$@"\n`,
        { mode: 0o755 },
      );
      const previousPath = process.env.PATH;
      process.env.PATH = workspace + delimiter + (previousPath ?? "");
      try {
        expect(resolveHostExecutable("tar")).toBe(tar);
        const deps = {
          loadApproval: fixture.deps.loadApproval,
          verifySourceCommit: fixture.deps.verifySourceCommit,
        };
        const prepared = await packCodingRuntimeNpmCandidate(releaseInput(fixture), deps);
        const verified = await verifyCodingRuntimeNpmCandidate(releaseInput(fixture), deps);
        expect(prepared.receipt.files).toHaveLength(9);
        expect(verified.receipt).toStrictEqual(prepared.receipt);
        expect(existsSync(marker)).toBe(false);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  );
});
