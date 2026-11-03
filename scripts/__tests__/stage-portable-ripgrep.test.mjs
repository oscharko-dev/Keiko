import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RIPGREP_PORTABLE_LICENSE_PATH,
  ripgrepPortableExecutablePath,
  ripgrepRuntimeApproval,
  ripgrepRuntimeTargetKey,
  ripgrepTargetKeyForPortableTarget,
} from "../../packages/keiko-server/src/coding-runtime/ripgrepRuntime.ts";
import {
  PORTABLE_TARGETS,
  nativeToolProvenance,
  nativeToolSbomBomRef,
  portableTargetByName,
  ripgrepApprovalForPortableTarget,
} from "../portable-runtime.mjs";
import { rebindExistingSignedArchive, rebindSignedPayload } from "../portable-signed-archive.mjs";
import { runtimeActivationManifest } from "../runtime-activation-manifest.mjs";
import {
  ripgrepToolManifestEntry,
  sbomForManifest,
  stageRipgrepTool,
  thirdPartyNotices,
} from "../stage-portable-runtime.mjs";
import { writeZipArchiveFromDirectory } from "../lib/zip-archive.mjs";

const roots = [];
const CYCLONEDX = { bomFormat: "CycloneDX", specVersion: "1.6" };
const POSIX = process.platform !== "win32";

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "keiko-portable-ripgrep-"));
  roots.push(root);
  return root;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeFixture(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function resourceRootFor(stageRoot, target) {
  return target.nodePlatform === "darwin"
    ? join(stageRoot, "payload", "Keiko", "Keiko.app", "Contents", "Resources")
    : join(stageRoot, "payload", "Keiko");
}

// The real approval supplies every identity field (version, commit, URLs, archive digest, paths);
// only the two digests that bind the fixture bytes are replaced, because the real executable is not
// available to a hermetic test.
function fixtureRuntime(target, { binary = "fixture ripgrep", license = "fixture MIT" } = {}) {
  const real = ripgrepApprovalForPortableTarget(target);
  const root = temporaryRoot();
  return {
    approved: { ...real, binarySha256: sha256(binary), licenseSha256: sha256(license) },
    sourceBinary: writeFixture(join(root, "rg-source"), binary),
    sourceLicense: writeFixture(join(root, "license-source"), license),
  };
}

function stageFixture(target, options = {}) {
  const resourceRoot = resourceRootFor(temporaryRoot(), target);
  const runtime = fixtureRuntime(target, options.content);
  const [tool] = stageRipgrepTool(target, resourceRoot, {
    resolveRuntime: () => runtime,
    ...options.stage,
  });
  return { resourceRoot, runtime, tool };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("portable ripgrep staging", () => {
  // The product resolves the shipped binary from the portable target name; the stager resolves the
  // approval from the Node platform/architecture. Two tables that must agree on every shipped target.
  it.each(PORTABLE_TARGETS.map((target) => [target.platformTarget, target]))(
    "resolves the same approved runtime for %s from the portable target name and from the Node host",
    (_name, target) => {
      expect(ripgrepTargetKeyForPortableTarget(target.platformTarget)).toBe(
        ripgrepRuntimeTargetKey(target.nodePlatform, target.nodeArchitecture),
      );
    },
  );

  it.each(PORTABLE_TARGETS.map((target) => [target.platformTarget, target]))(
    "stages the executable and its license at the literal payload paths for %s",
    (_name, target) => {
      const { resourceRoot, runtime, tool } = stageFixture(target);
      const executable =
        target.nodePlatform === "win32" ? "runtime/native/rg.exe" : "runtime/native/rg";

      expect(tool).toMatchObject({
        name: "ripgrep",
        kind: "native-tool",
        version: "15.1.0",
        platformTarget: target.platformTarget,
        architecture: target.nodeArchitecture,
        executablePath: executable,
        licensePath: "runtime/licenses/ripgrep/LICENSE-MIT",
        sbomBomRef: `pkg:github/burntsushi/ripgrep@15.1.0?platform=${target.platformTarget}`,
        unsignedSha256: runtime.approved.binarySha256,
        shippedSha256: runtime.approved.binarySha256,
        source: {
          commitSha: "af60c2de9d85e7f3d81c78601669468cf02dabab",
          archiveUrl: runtime.approved.archiveUrl,
          archiveSha256: runtime.approved.archiveSha256,
          binarySha256: runtime.approved.binarySha256,
          licenseSha256: runtime.approved.licenseSha256,
        },
        signing: {
          signatureKind: target.signatureKind,
          verificationStatus: "unverified-staging",
          signatureVerified: false,
          notarizationRequired: target.nodePlatform === "darwin",
          notarizationVerified: false,
        },
      });
      expect(readFileSync(join(resourceRoot, ...executable.split("/")), "utf8")).toBe(
        "fixture ripgrep",
      );
      expect(
        readFileSync(join(resourceRoot, "runtime", "licenses", "ripgrep", "LICENSE-MIT"), "utf8"),
      ).toBe("fixture MIT");
      expect(tool.sizeBytes).toBe("fixture ripgrep".length);
    },
  );

  it("takes every path from the producer of the approval, never from a restated formula", () => {
    const target = portableTargetByName("macos-arm64");
    const { tool } = stageFixture(target);
    const approval = ripgrepRuntimeApproval(ripgrepRuntimeTargetKey("darwin", "arm64"));

    expect(tool.executablePath).toBe(ripgrepPortableExecutablePath(approval.targetKey));
    expect(tool.licensePath).toBe(RIPGREP_PORTABLE_LICENSE_PATH);
    expect(tool.sbomBomRef).toBe(nativeToolSbomBomRef(approval, "macos-arm64"));
  });

  it("marks the evaluation lane exactly as the other staged native components do", () => {
    const { tool } = stageFixture(portableTargetByName("linux-x64"), {
      stage: { evaluation: true },
    });
    expect(tool.signing.verificationStatus).toBe("evaluation-unqualified");
  });

  it.skipIf(!POSIX)("ships the executable with execute permission", () => {
    const target = portableTargetByName("linux-x64");
    const { resourceRoot } = stageFixture(target);
    expect(statSync(join(resourceRoot, "runtime", "native", "rg")).mode & 0o111).not.toBe(0);
  });

  it("aborts staging when the copied executable does not match the platform pin", () => {
    const target = portableTargetByName("linux-x64");
    const failures = [];
    const runtime = fixtureRuntime(target);
    expect(() =>
      stageRipgrepTool(target, resourceRootFor(temporaryRoot(), target), {
        copyFile: (_source, destination) => writeFixture(destination, "swapped bytes"),
        onFailure: (message) => failures.push(message),
        resolveRuntime: () => runtime,
      }),
    ).toThrow("portable ripgrep staging aborted");
    expect(failures).toEqual(["ripgrep staged runtime failed its platform-pinned digest"]);
  });

  it("aborts staging when the copied license does not match the platform pin", () => {
    const target = portableTargetByName("windows-x64");
    const failures = [];
    const runtime = fixtureRuntime(target);
    expect(() =>
      stageRipgrepTool(target, resourceRootFor(temporaryRoot(), target), {
        copyFile: (source, destination) =>
          writeFixture(
            destination,
            source === runtime.sourceLicense ? "swapped license" : readFileSync(source),
          ),
        onFailure: (message) => failures.push(message),
        resolveRuntime: () => runtime,
      }),
    ).toThrow("portable ripgrep staging aborted");
    expect(failures).toEqual(["ripgrep staged license failed its platform-pinned digest"]);
  });
});

describe("portable ripgrep evidence", () => {
  function manifestWithTool(platformTarget) {
    const { tool } = stageFixture(portableTargetByName(platformTarget));
    return {
      nativeHelpers: [],
      nativeAddons: [
        {
          name: "usearch",
          version: "2.26.0",
          platformTarget,
          architecture: "arm64",
          sbomBomRef: "pkg:npm/usearch@2.26.0?platform=x",
          shippedSha256: "a".repeat(64),
          unsignedSha256: "a".repeat(64),
          executablePath: "runtime/native/usearch.node",
          licensePath: "runtime/licenses/usearch/LICENSE",
          source: {
            commitSha: "b".repeat(40),
            tarballUrl: "https://registry.npmjs.org/usearch/-/usearch-2.26.0.tgz",
            tarballSha256: "c".repeat(64),
          },
        },
      ],
      nativeTools: [tool],
    };
  }

  it("lists the shipped executable in the SBOM with its archive provenance", () => {
    const manifest = manifestWithTool("macos-arm64");
    const component = sbomForManifest(manifest).components.find(
      (entry) => entry.name === "ripgrep",
    );

    expect(component).toMatchObject({
      type: "application",
      "bom-ref": manifest.nativeTools[0].sbomBomRef,
      version: "15.1.0",
      purl: "pkg:github/burntsushi/ripgrep@15.1.0",
      licenses: [{ expression: "Unlicense OR MIT" }],
      hashes: [{ alg: "SHA-256", content: manifest.nativeTools[0].shippedSha256 }],
      externalReferences: [
        {
          type: "distribution",
          url: manifest.nativeTools[0].source.archiveUrl,
          hashes: [{ alg: "SHA-256", content: manifest.nativeTools[0].source.archiveSha256 }],
        },
      ],
    });
    expect(component.properties).toContainEqual({
      name: "keiko:executable-path",
      value: "runtime/native/rg",
    });
  });

  it("keeps the SBOM of a manifest without tools exactly as it was", () => {
    const manifest = manifestWithTool("macos-arm64");
    delete manifest.nativeTools;
    expect(sbomForManifest(manifest).components.map((entry) => entry.name)).toEqual(["usearch"]);
  });

  it("names ripgrep, its license option and the shipped MIT text in the third-party notices", () => {
    const manifest = manifestWithTool("linux-x64");
    const notices = thirdPartyNotices(manifest);

    expect(notices).toContain("ripgrep 15.1.0");
    expect(notices).toContain("Copyright (c) 2015 Andrew Gallant.");
    expect(notices).toContain("Unlicense or the MIT license");
    expect(notices).toContain("runtime/licenses/ripgrep/LICENSE-MIT");
    expect(notices).toContain(manifest.nativeTools[0].source.archiveUrl);
    delete manifest.nativeTools;
    expect(thirdPartyNotices(manifest)).not.toContain("ripgrep");
  });

  it("projects the provenance of a tool the same way for staging and for rebinding", () => {
    const { tool } = stageFixture(portableTargetByName("windows-x64"));
    expect(nativeToolProvenance(tool)).toEqual({
      architecture: "x64",
      executablePath: "runtime/native/rg.exe",
      name: "ripgrep",
      shippedSha256: tool.shippedSha256,
      signatureKind: "authenticode",
      signatureVerified: false,
      notarizationVerified: false,
      sourceCommitSha: "af60c2de9d85e7f3d81c78601669468cf02dabab",
      archiveSha256: tool.source.archiveSha256,
      unsignedSha256: tool.unsignedSha256,
      version: "15.1.0",
    });
  });

  it("carries tools into the activation manifest and its reviewed binding only when present", () => {
    const { tool } = stageFixture(portableTargetByName("macos-arm64"));
    const base = {
      security: { verificationReasonCodes: [], verificationChecks: {} },
      product: { packageName: "keiko", packageVersion: "1.0.0" },
      release: { commitSha: "a".repeat(40) },
      artifact: { platformTarget: "macos-arm64" },
      runtime: { nodePlatform: "darwin", nodeArchitecture: "arm64" },
      nativeHelpers: [],
      releaseImpact: { reviewedBinding: {} },
    };

    const without = runtimeActivationManifest(base);
    expect(Object.keys(without)).not.toContain("nativeTools");
    expect(Object.keys(without.releaseImpact.reviewedBinding)).not.toContain("nativeTools");

    const withTools = runtimeActivationManifest({ ...base, nativeTools: [tool] });
    expect(withTools.nativeTools).toEqual([tool]);
    expect(withTools.releaseImpact.reviewedBinding.nativeTools).toEqual([tool]);
    expect(Object.keys(withTools).filter((key) => key !== "nativeTools")).toEqual(
      Object.keys(without),
    );
  });
});

describe("portable ripgrep after platform signing", () => {
  function signedFixture(platformTarget = "macos-arm64") {
    const target = portableTargetByName(platformTarget);
    const stageRoot = temporaryRoot();
    const { resourceRoot, tool } = stageFixtureAt(stageRoot, target);
    writeFixture(join(resourceRoot, "app", "package.json"), "{}\n");
    const sbomPath = join(stageRoot, "evidence", "sbom.cdx.json");
    writeFixture(
      sbomPath,
      `${JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        components: [
          { "bom-ref": tool.sbomBomRef, hashes: [{ alg: "SHA-256", content: tool.shippedSha256 }] },
        ],
      })}\n`,
    );
    const manifest = {
      artifact: { platformTarget, assetName: target.assetName },
      nativeTools: [tool],
      provenance: {},
      releaseImpact: { reviewedBinding: {} },
    };
    return { manifest, resourceRoot, sbomPath, stageRoot, target, tool };
  }

  function stageFixtureAt(stageRoot, target) {
    const resourceRoot = resourceRootFor(stageRoot, target);
    const runtime = fixtureRuntime(target);
    const [tool] = stageRipgrepTool(target, resourceRoot, { resolveRuntime: () => runtime });
    return { resourceRoot, tool };
  }

  function sbomHash(sbomPath, tool) {
    const component = JSON.parse(readFileSync(sbomPath, "utf8")).components.find(
      (entry) => entry["bom-ref"] === tool.sbomBomRef,
    );
    return component.hashes[0].content;
  }

  it("rebinds the shipped bytes and the SBOM hash while the upstream identity stays pinned", () => {
    const { manifest, resourceRoot, sbomPath, stageRoot, tool } = signedFixture();
    const unsigned = tool.unsignedSha256;
    const executable = join(resourceRoot, "runtime", "native", "rg");
    writeFileSync(executable, "fixture ripgrep with a platform signature appended");

    rebindSignedPayload(stageRoot, manifest, "macos-arm64");

    const rebound = manifest.nativeTools[0];
    expect(rebound.shippedSha256).toBe(
      sha256("fixture ripgrep with a platform signature appended"),
    );
    expect(rebound.sizeBytes).toBe("fixture ripgrep with a platform signature appended".length);
    expect(rebound.unsignedSha256).toBe(unsigned);
    expect(rebound.shippedSha256).not.toBe(unsigned);
    expect(sbomHash(sbomPath, rebound)).toBe(rebound.shippedSha256);
  });

  it("leaves a manifest without tools alone", () => {
    const { manifest, stageRoot } = signedFixture();
    delete manifest.nativeTools;
    expect(() => rebindSignedPayload(stageRoot, manifest, "macos-arm64")).not.toThrow();
    expect(manifest.nativeTools).toBeUndefined();
  });

  it("refuses a manifest that binds more than one tool", () => {
    const { manifest, stageRoot, tool } = signedFixture();
    manifest.nativeTools = [tool, tool];
    expect(() => rebindSignedPayload(stageRoot, manifest, "macos-arm64")).toThrow(
      "exactly one native tool",
    );
  });

  it("refuses an SBOM that lacks, or doubles, the tool component", () => {
    const { manifest, sbomPath, stageRoot, tool } = signedFixture();
    const component = { "bom-ref": tool.sbomBomRef, hashes: [] };
    writeFileSync(sbomPath, JSON.stringify({ ...CYCLONEDX, components: [] }));
    expect(() => rebindSignedPayload(stageRoot, manifest, "macos-arm64")).toThrow(
      "missing or ambiguous",
    );
    writeFileSync(sbomPath, JSON.stringify({ ...CYCLONEDX, components: [component, component] }));
    expect(() => rebindSignedPayload(stageRoot, manifest, "macos-arm64")).toThrow(
      "missing or ambiguous",
    );
  });

  it.skipIf(!POSIX)("refuses a symlinked or multiply linked executable", () => {
    const { manifest, resourceRoot, stageRoot } = signedFixture();
    const executable = join(resourceRoot, "runtime", "native", "rg");
    const elsewhere = writeFixture(join(temporaryRoot(), "real-rg"), "fixture ripgrep");
    rmSync(executable);
    symlinkSync(elsewhere, executable);
    expect(() => rebindSignedPayload(stageRoot, manifest, "macos-arm64")).toThrow(
      "not a regular single-link file",
    );
    rmSync(executable);
    writeFixture(executable, "fixture ripgrep");
    linkSync(executable, join(resourceRoot, "runtime", "native", "rg-hardlink"));
    expect(() => rebindSignedPayload(stageRoot, manifest, "macos-arm64")).toThrow(
      "not a regular single-link file",
    );
  });

  it("refuses a manifest path that escapes the resource root", () => {
    const { manifest, stageRoot } = signedFixture();
    manifest.nativeTools[0].executablePath = "../outside";
    expect(() => rebindSignedPayload(stageRoot, manifest, "macos-arm64")).toThrow(
      "native tool path is not canonical",
    );
  });

  it("binds the tool into the reviewed binding and the provenance statement of a signed archive", async () => {
    const { manifest, stageRoot, target, tool } = signedFixture("linux-x64");
    const payloadContainer = join(stageRoot, "payload");
    const archivePath = join(stageRoot, target.assetName);
    writeZipArchiveFromDirectory(join(payloadContainer, "Keiko"), archivePath, {
      followSymlinks: true,
      rootName: "Keiko",
    });
    writeFixture(
      join(stageRoot, "evidence", "provenance.intoto.jsonl"),
      `${JSON.stringify({ subjectDigest: "0".repeat(64), nativeTools: [] })}\n`,
    );
    manifest.artifact = { platformTarget: "linux-x64", assetName: target.assetName };
    manifest.provenance = { provenanceStatementPath: "evidence/provenance.intoto.jsonl" };

    await rebindExistingSignedArchive(stageRoot, manifest, archivePath, "linux-x64", {
      payloadAlreadyRebound: true,
    });

    expect(manifest.releaseImpact.reviewedBinding.nativeTools).toEqual([tool]);
    const provenance = JSON.parse(
      readFileSync(join(stageRoot, "evidence", "provenance.intoto.jsonl"), "utf8"),
    );
    expect(provenance.nativeTools).toEqual([nativeToolProvenance(tool)]);
    expect(provenance.subjectDigest).toBe(manifest.artifact.sha256);
  });
});

describe("portable ripgrep in the Windows generation allowlist", () => {
  it("allows exactly the paths the payload ships, taken from the same definition", () => {
    const source = readFileSync("packages/keiko-cli/src/portable-maintenance.ts", "utf8");
    expect(source).toContain(`"${ripgrepPortableExecutablePath("win32-x64")}"`);
    expect(source).toContain(`"${RIPGREP_PORTABLE_LICENSE_PATH}"`);
  });

  it("describes the same entry the validator pins for a staged tool", () => {
    const target = portableTargetByName("windows-x64");
    const approval = ripgrepApprovalForPortableTarget(target);
    const staged = {
      destination: writeFixture(join(temporaryRoot(), "rg.exe"), "fixture ripgrep"),
      executablePath: ripgrepPortableExecutablePath(approval.targetKey),
      licensePath: RIPGREP_PORTABLE_LICENSE_PATH,
    };
    chmodSync(staged.destination, 0o755);
    expect(ripgrepToolManifestEntry(target, approval, staged, false)).toMatchObject({
      executablePath: "runtime/native/rg.exe",
      unsignedSha256: approval.binarySha256,
      shippedSha256: sha256("fixture ripgrep"),
    });
  });
});
