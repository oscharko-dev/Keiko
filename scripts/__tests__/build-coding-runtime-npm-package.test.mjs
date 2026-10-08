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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import * as builder from "../build-coding-runtime-npm-package.mjs";

import {
  buildCodingRuntimeNpmPackage,
  codingRuntimePackageManifest,
  codingRuntimePackageName,
  main,
  NPM_RUNTIME_PACKAGE_TARGETS,
  packCodingRuntimeNpmCandidate,
  verifyCodingRuntimeNpmCandidate,
} from "../build-coding-runtime-npm-package.mjs";
import { computePortableSidecarPayloadTreeDigest } from "../../packages/keiko-server/dist/coding-runtime/devLanePortableCodingRuntime.js";
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
  const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const approval = {
    packageName: built.name,
    upstreamVersion: "2.0.10",
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
      expect(prepared.receipt.files).toHaveLength(6);
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

describe.skipIf(process.platform === "win32")("inactive original service package candidate", () => {
  it("binds current static source/producer assets, npm metadata omissions, and full license refusal", async () => {
    const outDir = join(scratch(), "package");
    const result = await builder.buildCodingRuntimeNpmServiceHostCandidate({
      target: "macos-arm64",
      version: "1.2.3",
      outDir,
      deps: serviceFixtureDeps(),
    });
    const root = join(outDir, "runtime/opencode-compatible/service-host/payload");
    const adapter =
      await import("../../packages/keiko-server/dist/coding-runtime/opencodeRuntimeAdapter.js");
    const artifact =
      await import("../../packages/keiko-server/dist/coding-runtime/opencodeServiceHostArtifact.js");
    expect(readFileSync(join(root, "keiko-governed-tools.mjs"), "utf8")).toBe(
      adapter.createGeneratedOpenCodeV2HostFactory("direct"),
    );
    expect(readFileSync(join(root, "keiko-governed-tools-code-mode.mjs"), "utf8")).toBe(
      adapter.createGeneratedOpenCodeV2HostFactory("code-mode"),
    );
    expect(readFileSync(join(root, "keiko-host-packet-data.mjs"), "utf8")).toBe(
      artifact.createOpenCodeServiceHostPacketDataAsset(),
    );
    const manifest = JSON.parse(readFileSync(join(outDir, "package.json"), "utf8"));
    expect(manifest.private).toBe(true);
    expect(manifest.publishConfig).toBeUndefined();
    expect(result.license).toEqual({
      status: "blocked",
      offenders: [{ id: "spdx-exceptions@2.5.0", license: "CC-BY-3.0" }],
    });
    expect(result.excludedNpmMetadata).toContain(
      "runtime/opencode-compatible/service-host/payload/node_modules/spdx-exceptions/.npmignore",
    );
    expect(result.files.some(({ path }) => path.endsWith("/.npmignore"))).toBe(false);
    const sbom = JSON.parse(readFileSync(join(root, "evidence/sbom.cdx.json"), "utf8"));
    const refs = [
      sbom.metadata.component["bom-ref"],
      ...sbom.components.map((component) => component["bom-ref"]),
    ];
    expect(new Set(refs).size).toBe(refs.length);
    expect(
      sbom.dependencies.find((entry) => entry.ref === sbom.metadata.component["bom-ref"]).dependsOn,
    ).toContain("node@24.18.0");
    const provenance = JSON.parse(
      readFileSync(join(root, "evidence/build-provenance.json"), "utf8"),
    );
    expect(provenance.sourceBuildProvenance).toBe("reference-only");
    expect(
      provenance.lockedInputs.find(({ path }) => path === "node_modules/spdx-exceptions").integrity,
    ).toMatch(/^sha512-/u);
    expect(result.finalPayload.treeSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(readFileSync(join(root, "evidence/THIRD-PARTY-NOTICES.md"), "utf8")).toContain(
      "https://creativecommons.org/licenses/by/3.0/",
    );
    await expect(
      packCodingRuntimeNpmCandidate(
        {
          target: "macos-arm64",
          version: "1.2.3",
          packageDir: outDir,
          artifactDir: join(scratch(), "release"),
        },
        { loadApproval: async () => ({ packageName: result.name }) },
      ),
    ).rejects.toThrow("manifest, version or architecture mismatch");
  });

  it("refuses links in the installed module tree without issuing a private receipt", async () => {
    const outDir = join(scratch(), "package");
    const deps = serviceFixtureDeps();
    const install = deps.installHost;
    deps.installHost = async (root) => {
      await install(root);
      symlinkSync("README.md", join(root, "node_modules/spdx-exceptions/leak"));
    };
    await expect(
      builder.buildCodingRuntimeNpmServiceHostCandidate({
        target: "macos-arm64",
        version: "1.2.3",
        outDir,
        deps,
      }),
    ).rejects.toThrow("ordinary single-link files");
    expect(existsSync(join(dirname(outDir), "artifacts/service-host-private-receipt.json"))).toBe(
      false,
    );
  });

  it("retains the original six CLI members and adds the actual fixed original host", async () => {
    const outDir = join(scratch(), "package");
    const build = builder.buildCodingRuntimeNpmServiceHostCandidate ?? buildCodingRuntimeNpmPackage;
    const result = await build({
      target: "macos-arm64",
      version: "1.2.3",
      outDir,
      deps: serviceFixtureDeps(),
    });
    expect(existsSync(join(outDir, "runtime/opencode-compatible/payload/bin/opencode"))).toBe(true);
    expect(
      existsSync(join(outDir, "runtime/opencode-compatible/service-host/payload/host.mjs")),
    ).toBe(true);
    expect(
      existsSync(join(outDir, "runtime/opencode-compatible/service-host/payload/runtime/node")),
    ).toBe(true);
    const artifact =
      await import("../../packages/keiko-server/dist/coding-runtime/opencodeServiceHostArtifact.js");
    const codec = artifact.createOpenCodeServiceHostNativeCodecAsset();
    const payload = join(outDir, "runtime/opencode-compatible/service-host/payload");
    for (const asset of artifact.createOpenCodeServiceHostNativePolicyAssets()) {
      expect(readFileSync(join(payload, asset.filename))).toEqual(readFileSync(asset.source));
    }
    const policy = await import(
      pathToFileURL(join(payload, "keiko-workspace-path-policy/ignore.js")).href
    );
    expect(policy.isDenied("nested/.env")).toBe(true);
    expect(policy.isDenied("nested/AGENTS.md")).toBe(false);
    const stagedCodec = readFileSync(join(payload, codec.filename));
    expect(stagedCodec).toEqual(readFileSync(codec.source));
    const loaded = await import("data:text/javascript;base64," + stagedCodec.toString("base64"));
    const frame = loaded.encodeSecureWorkspaceNativeResponse({
      status: "ok",
      info: { type: "file", size: 3, mtimeMs: 0 },
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect([...loaded.decodeSecureWorkspaceNativeResponse(frame).bytes]).toEqual([1, 2, 3]);
    const provenance = JSON.parse(
      readFileSync(join(payload, "evidence/build-provenance.json"), "utf8"),
    );
    expect(provenance.generatedFiles).toContainEqual({
      path: codec.filename,
      sha256: createHash("sha256").update(stagedCodec).digest("hex"),
    });
    expect(result.qualification).toBe("private-functional-unapproved");
    expect(result.license.status).toBe("blocked");
  });
});

function serviceFixtureDeps() {
  return {
    ...fakeDeps().deps,
    installHost: async (root) => {
      write(
        join(root, "node_modules/spdx-exceptions/package.json"),
        JSON.stringify({ name: "spdx-exceptions", version: "2.5.0", license: "CC-BY-3.0" }),
      );
      write(join(root, "node_modules/spdx-exceptions/README.md"), "upstream notice");
      write(join(root, "node_modules/spdx-exceptions/index.json"), "[]");
      write(join(root, "node_modules/spdx-exceptions/.npmignore"), "ignored metadata");
    },
    stageNode: async (_options, _target, staging) => {
      write(join(staging, "runtime/node/bin/node"), "node executable");
      chmodSync(join(staging, "runtime/node/bin/node"), 0o755);
      write(join(staging, "runtime/node/LICENSE"), "Node license");
      write(join(staging, "runtime/node/NOTICE"), "Node notice");
      return "a".repeat(64);
    },
    hostSbom: () => ({
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      version: 1,
      metadata: {
        component: {
          name: "keiko-opencode-service-host",
          version: "0.0.0-private",
          "bom-ref": "keiko-opencode-service-host@0.0.0-private",
          licenses: [{ license: { id: "Apache-2.0" } }],
        },
      },
      dependencies: [
        { ref: "keiko-opencode-service-host@0.0.0-private", dependsOn: ["spdx-exceptions@2.5.0"] },
      ],
      components: [
        {
          type: "library",
          name: "spdx-exceptions",
          version: "2.5.0",
          "bom-ref": "spdx-exceptions@2.5.0",
          licenses: [{ license: { id: "CC-BY-3.0" } }],
        },
      ],
    }),
  };
}
