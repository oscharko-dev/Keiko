import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { portableTargetByName } from "../portable-runtime.mjs";
import {
  containedDigest,
  readContainedText,
  requiredContainedFile,
  requiredStageRoot,
  smokePortableUsearch,
} from "../smoke-portable-usearch.mjs";
import { stageUsearchAddon } from "../stage-portable-runtime.mjs";

const roots = [];

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "keiko-portable-usearch-"));
  roots.push(root);
  return root;
}

function hostPortableTarget() {
  const name =
    process.platform === "darwin"
      ? process.arch === "arm64"
        ? "macos-arm64"
        : "macos-x64"
      : "windows-x64";
  const target = portableTargetByName(name);
  if (target === undefined) throw new Error("expected a supported portable target");
  return target;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function provisionedRuntimeFixture() {
  const root = temporaryRoot();
  const sourceBinary = join(root, "usearch.node");
  const sourceLicense = join(root, "LICENSE");
  writeFileSync(sourceBinary, "fixture USearch runtime");
  writeFileSync(sourceLicense, "fixture USearch license");
  return {
    approved: { binarySha256: sha256(sourceBinary) },
    sourceBinary,
    sourceLicense,
  };
}

function portableSmokeFixture() {
  const stageRoot = temporaryRoot();
  const target = hostPortableTarget();
  const resources =
    target.nodePlatform === "darwin"
      ? join(stageRoot, "payload", "Keiko", "Keiko.app", "Contents", "Resources")
      : join(stageRoot, "payload", "Keiko");
  const binary = join(resources, "runtime", "native", "usearch.node");
  const license = join(resources, "runtime", "licenses", "usearch", "LICENSE");
  const binarySha256 = sha256Fixture(binary, "fixture native addon");
  const licenseSha256 = sha256Fixture(license, "fixture license");
  const targetKey = `${target.nodePlatform}-${target.nodeArchitecture}`;
  const runtimeManifest = {
    licenseSha256,
    targets: { [targetKey]: { binarySha256 } },
    version: "fixture-version",
  };
  const addon = {
    executablePath: "runtime/native/usearch.node",
    licensePath: "runtime/licenses/usearch/LICENSE",
    name: "usearch",
    platformTarget: target.platformTarget,
    sbomBomRef: "pkg:npm/usearch@fixture-version",
    shippedSha256: binarySha256,
    unsignedSha256: binarySha256,
    version: runtimeManifest.version,
  };
  const manifestPath = join(stageRoot, "manifest", "portable-manifest.json");
  const notices = join(stageRoot, "evidence", "third-party-notices.txt");
  const manifest = {
    artifact: { platformTarget: target.platformTarget },
    nativeAddons: [addon],
  };
  writeJson(manifestPath, manifest);
  writeJson(join(stageRoot, "evidence", "sbom.cdx.json"), {
    components: [
      {
        "bom-ref": addon.sbomBomRef,
        hashes: [{ alg: "SHA-256", content: binarySha256 }],
      },
    ],
  });
  writeFixture(notices, "USearch fixture-version\n");
  return {
    addon,
    binary,
    license,
    manifest,
    manifestPath,
    notices,
    runtimeManifest,
    stageRoot,
    target,
  };
}

function writeFixture(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeJson(path, value) {
  writeFixture(path, `${JSON.stringify(value)}\n`);
}

function sha256Fixture(path, content) {
  writeFixture(path, content);
  return sha256(path);
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("portable USearch staging", () => {
  it("validates a complete staged runtime before delegating its canonical binary", () => {
    const fixture = portableSmokeFixture();
    const loadRuntime = vi.fn();

    smokePortableUsearch(fixture.stageRoot, fixture.target.platformTarget, {
      loadRuntime,
      runtimeManifest: fixture.runtimeManifest,
    });

    expect(loadRuntime).toHaveBeenCalledWith(realpathSync(fixture.binary), "fixture-version");
  });

  it("fails closed before loading a staged runtime whose digest has drifted", () => {
    const fixture = portableSmokeFixture();
    writeFixture(fixture.binary, "drifted native addon");

    expect(() =>
      smokePortableUsearch(fixture.stageRoot, fixture.target.platformTarget, {
        loadRuntime: vi.fn(),
        runtimeManifest: fixture.runtimeManifest,
      }),
    ).toThrow("shipped native addon digest mismatch");
  });

  it("fails closed when SBOM evidence does not bind the staged runtime", () => {
    const fixture = portableSmokeFixture();
    writeJson(join(fixture.stageRoot, "evidence", "sbom.cdx.json"), { components: [] });

    expect(() =>
      smokePortableUsearch(fixture.stageRoot, fixture.target.platformTarget, {
        loadRuntime: vi.fn(),
        runtimeManifest: fixture.runtimeManifest,
      }),
    ).toThrow("SBOM does not bind the shipped native addon");
  });

  it("fails closed when the portable target or native-addon identity drifts", () => {
    const fixture = portableSmokeFixture();
    fixture.manifest.artifact.platformTarget = "wrong";
    writeJson(fixture.manifestPath, fixture.manifest);
    expect(() =>
      smokePortableUsearch(fixture.stageRoot, fixture.target.platformTarget, {
        loadRuntime: vi.fn(),
        runtimeManifest: fixture.runtimeManifest,
      }),
    ).toThrow("manifest target mismatch");

    fixture.manifest.artifact.platformTarget = fixture.target.platformTarget;
    fixture.manifest.nativeAddons = [];
    writeJson(fixture.manifestPath, fixture.manifest);
    expect(() =>
      smokePortableUsearch(fixture.stageRoot, fixture.target.platformTarget, {
        loadRuntime: vi.fn(),
        runtimeManifest: fixture.runtimeManifest,
      }),
    ).toThrow("manifest must bind exactly one native addon");
  });

  it("fails closed when runtime approval, license, or notice evidence drifts", () => {
    const missingApproval = portableSmokeFixture();
    expect(() =>
      smokePortableUsearch(missingApproval.stageRoot, missingApproval.target.platformTarget, {
        loadRuntime: vi.fn(),
        runtimeManifest: { ...missingApproval.runtimeManifest, targets: {} },
      }),
    ).toThrow("manifest upstream digest is not approved");

    const licenseDrift = portableSmokeFixture();
    writeFixture(licenseDrift.license, "drifted license");
    expect(() =>
      smokePortableUsearch(licenseDrift.stageRoot, licenseDrift.target.platformTarget, {
        loadRuntime: vi.fn(),
        runtimeManifest: licenseDrift.runtimeManifest,
      }),
    ).toThrow("shipped USearch license digest mismatch");

    const noticeDrift = portableSmokeFixture();
    writeFixture(noticeDrift.notices, "unrelated notice\n");
    expect(() =>
      smokePortableUsearch(noticeDrift.stageRoot, noticeDrift.target.platformTarget, {
        loadRuntime: vi.fn(),
        runtimeManifest: noticeDrift.runtimeManifest,
      }),
    ).toThrow("third-party notice does not identify USearch");
  });

  it("uses production defaults while rejecting an unsupported portable target", () => {
    const root = temporaryRoot();

    expect(() => smokePortableUsearch(root, "unsupported")).toThrow(
      "platform target is unsupported",
    );
  });

  it("canonicalizes a regular stage root and reads only bounded regular files", () => {
    const root = temporaryRoot();
    const canonicalRoot = requiredStageRoot(root);
    const file = join(canonicalRoot, "evidence.txt");
    writeFileSync(file, "bounded evidence");

    expect(canonicalRoot).toBe(realpathSync(root));
    expect(requiredContainedFile(canonicalRoot, file, "evidence", 64)).toBe(realpathSync(file));
    expect(readContainedText(canonicalRoot, file, "evidence")).toBe("bounded evidence");
    expect(containedDigest(canonicalRoot, file, "evidence", 64)).toEqual({
      path: realpathSync(file),
      sha256: sha256(file),
    });
  });

  it("rejects missing roots and unsafe regular-file shapes", () => {
    const root = temporaryRoot();
    const canonicalRoot = requiredStageRoot(root);
    const empty = join(canonicalRoot, "empty.txt");
    const directory = join(canonicalRoot, "directory");
    const original = join(canonicalRoot, "original.txt");
    const hardlink = join(canonicalRoot, "hardlink.txt");
    writeFileSync(empty, "");
    mkdirSync(directory);
    writeFileSync(original, "linked");
    linkSync(original, hardlink);

    expect(() => requiredStageRoot(join(root, "missing"))).toThrow("stage root is missing");
    expect(() =>
      requiredContainedFile(canonicalRoot, join(canonicalRoot, "missing"), "file", 64),
    ).toThrow("missing file");
    expect(() => requiredContainedFile(canonicalRoot, directory, "file", 64)).toThrow(
      "unsafe file",
    );
    expect(() => requiredContainedFile(canonicalRoot, hardlink, "file", 64)).toThrow("unsafe file");
    expect(() => requiredContainedFile(canonicalRoot, empty, "file", 64)).toThrow(
      "invalid bounded size",
    );
  });

  it("rejects files that exceed their declared size bound", () => {
    const root = temporaryRoot();
    const canonicalRoot = requiredStageRoot(root);
    const file = join(canonicalRoot, "oversized.txt");
    writeFileSync(file, "four");

    expect(() => requiredContainedFile(canonicalRoot, file, "file", 3)).toThrow(
      "invalid bounded size",
    );
  });

  it("rejects lexical escapes from a canonical stage root", () => {
    const stageRoot = temporaryRoot();
    const outsideRoot = temporaryRoot();
    const outsideFile = join(outsideRoot, "outside.txt");
    writeFileSync(outsideFile, "outside");

    expect(() =>
      requiredContainedFile(requiredStageRoot(stageRoot), outsideFile, "file", 64),
    ).toThrow("unsafe file");
  });

  it.skipIf(process.platform === "win32")(
    "rejects symlinked stage roots and canonical parent-directory escapes",
    () => {
      const stageRoot = temporaryRoot();
      const outsideRoot = temporaryRoot();
      const canonicalStageRoot = requiredStageRoot(stageRoot);
      const linkedRoot = join(temporaryRoot(), "linked-root");
      const linkedParent = join(canonicalStageRoot, "linked-parent");
      const outsideFile = join(outsideRoot, "outside.txt");
      writeFileSync(outsideFile, "outside");
      symlinkSync(stageRoot, linkedRoot, "dir");
      symlinkSync(outsideRoot, linkedParent, "dir");

      expect(() => requiredStageRoot(linkedRoot)).toThrow("stage root is unsafe");
      expect(() =>
        requiredContainedFile(canonicalStageRoot, join(linkedParent, "outside.txt"), "file", 64),
      ).toThrow("unsafe file");
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a portable manifest reached through a stage-root symlink escape",
    () => {
      const stageRoot = temporaryRoot();
      const outsideRoot = temporaryRoot();
      const outsideManifest = join(outsideRoot, "portable-manifest.json");
      mkdirSync(join(stageRoot, "manifest"), { recursive: true });
      writeFileSync(outsideManifest, '{"artifact":{"platformTarget":"wrong"}}\n');
      symlinkSync(outsideManifest, join(stageRoot, "manifest", "portable-manifest.json"));

      const result = spawnSync(
        process.execPath,
        [
          resolve("scripts/smoke-portable-usearch.mjs"),
          stageRoot,
          hostPortableTarget().platformTarget,
        ],
        { encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unsafe portable manifest");
      expect(result.stderr).not.toContain("manifest target mismatch");
    },
  );

  it("binds shippedSha256 to the bytes copied into the staged payload", () => {
    const resourceRoot = temporaryRoot();
    const runtime = provisionedRuntimeFixture();
    const [addon] = stageUsearchAddon(hostPortableTarget(), resourceRoot, {
      resolveRuntime: () => runtime,
    });
    if (addon === undefined) throw new Error("expected staged USearch manifest entry");
    const destination = join(resourceRoot, "runtime", "native", "usearch.node");

    expect(addon.shippedSha256).toBe(sha256(destination));
  });

  it("fails closed when copied payload bytes differ from the approved runtime", () => {
    const resourceRoot = temporaryRoot();
    const runtime = provisionedRuntimeFixture();
    expect(() =>
      stageUsearchAddon(hostPortableTarget(), resourceRoot, {
        copyFile: (source, destination) => {
          mkdirSync(dirname(destination), { recursive: true });
          copyFileSync(source, destination);
          if (basename(destination) === "usearch.node") {
            writeFileSync(
              destination,
              Buffer.concat([readFileSync(destination), Buffer.from("drift")]),
            );
          }
        },
        onFailure: (message) => {
          throw new Error(message);
        },
        resolveRuntime: () => runtime,
      }),
    ).toThrow("platform-pinned digest");
  });
});
