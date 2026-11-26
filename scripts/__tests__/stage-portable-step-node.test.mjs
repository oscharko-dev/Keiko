import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WINDOWS_PORTABLE_RUNTIME_APPROVAL } from "../../packages/keiko-server/src/coding-runtime/npmLaneRuntimeApprovals.ts";
import { ACTIVATION_STEP_NODE_TOOL_NAME } from "../../packages/keiko-server/src/coding-runtime/ripgrepRuntime.ts";
import {
  STEP_NODE_DIRECTORY_NAME,
  STEP_NODE_FILE_NAME,
} from "../../packages/keiko-server/src/editor/windowsStepNode.ts";
import {
  STEP_NODE_LICENSE_SHA256,
  STEP_NODE_LICENSE_SOURCE_PATH,
  STEP_NODE_PACKAGE_ENTRY,
  STEP_NODE_PORTABLE_EXECUTABLE_PATH,
  STEP_NODE_PORTABLE_LICENSE_PATH,
  STEP_NODE_TOOL_NAME,
  isStepNodeExecutablePath,
  nativeToolSetIsValid,
  obtainPackageTarball,
  resolveStepNodeRuntime,
  selectStepNodePackage,
  stageStepNodeTool,
  stepNodePackageUrl,
} from "../lib/portable-step-node.mjs";
import {
  nativeToolProvenance,
  portableTargetByName,
  PORTABLE_TARGETS,
} from "../portable-runtime.mjs";
import { rebindSignedPayload } from "../portable-signed-archive.mjs";
import { sbomForManifest, thirdPartyNotices } from "../stage-portable-runtime.mjs";
import { fixtureStepNodeApproval, fixtureStepNodeRuntime } from "./support/step-node-fixture.mjs";

const roots = [];
const NODE_BYTES = "fixture patched node";
const WINDOWS = portableTargetByName("windows-x64");
const repoRoot = join(import.meta.dirname, "..", "..");

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "keiko-step-node-stage-"));
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

// A real gzip tarball with the package layout the Windows runtime package has, built by tar.
function buildPackage(files, { link, topLevel = ["package"] } = {}) {
  const root = temporaryRoot();
  const source = join(root, "source");
  for (const [name, content] of Object.entries(files)) {
    writeFixture(join(source, ...name.split("/")), content);
  }
  if (link !== undefined) {
    mkdirSync(dirname(join(source, link.name)), { recursive: true });
    symlinkSync(link.target, join(source, link.name));
  }
  const tarball = join(root, "runtime-package.tgz");
  const result = spawnSync("tar", ["-czf", tarball, "-C", source, ...topLevel]);
  if (result.status !== 0) throw new Error("fixture tar failed");
  return tarball;
}

function selectedFor(tarball, overrides = {}) {
  return {
    version: "1.1.9",
    target: "windows-x64",
    name: "@oscharko-dev/keiko-coding-runtime-win32-x64",
    opencodeVersion: WINDOWS_PORTABLE_RUNTIME_APPROVAL.upstreamVersion,
    tarball: basename(tarball),
    sizeBytes: lstatSync(tarball).size,
    sha256: sha256(readFileSync(tarball)),
    ...overrides,
  };
}

function catalogFor(selected) {
  const { name, opencodeVersion, tarball, sizeBytes, sha256: digest } = selected;
  return {
    schemaVersion: 1,
    releases: {
      "1.1.9": {
        "windows-x64": {
          name,
          opencodeVersion,
          tarball: `${name.slice(1).replace("/", "-")}-1.1.9.tgz`,
          sizeBytes,
          sha256: digest,
          integrity: `sha512-${"A".repeat(86)}==`,
        },
      },
    },
    tarballFixture: tarball,
  };
}

function goodPackage() {
  return buildPackage({
    "package/package.json": "{}",
    [STEP_NODE_PACKAGE_ENTRY]: NODE_BYTES,
  });
}

function resolveFrom(tarball, { catalogOverrides = {}, approval } = {}) {
  const selected = selectedFor(tarball, catalogOverrides);
  const catalog = catalogFor(selected);
  return resolveStepNodeRuntime({
    approval: approval ?? fixtureStepNodeApproval(NODE_BYTES),
    catalog,
    localTarball: tarball,
    cacheDir: join(temporaryRoot(), "cache"),
  });
}

function resourceRootFor() {
  return join(temporaryRoot(), "payload", "Keiko");
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("portable step Node.js staging", () => {
  it("stages the verified executable and the license at the literal payload paths", () => {
    const tarball = goodPackage();
    const resourceRoot = resourceRootFor();
    const [tool] = stageStepNodeTool(WINDOWS, resourceRoot, {
      resolveRuntime: () => resolveFrom(tarball),
    });

    expect(readFileSync(join(resourceRoot, "runtime", "step-node", "node.exe"), "utf8")).toBe(
      NODE_BYTES,
    );
    expect(readdirSync(join(resourceRoot, "runtime", "step-node"))).toEqual(["node.exe"]);
    expect(
      sha256(readFileSync(join(resourceRoot, ...STEP_NODE_PORTABLE_LICENSE_PATH.split("/")))),
    ).toBe(STEP_NODE_LICENSE_SHA256);
    expect(tool.shippedSha256).toBe(sha256(NODE_BYTES));
    expect(tool.sizeBytes).toBe(Buffer.byteLength(NODE_BYTES));
  });

  it("records a manifest entry that restates the server's pin, never a formula of its own", () => {
    const approval = fixtureStepNodeApproval(NODE_BYTES);
    const [tool] = stageStepNodeTool(WINDOWS, resourceRootFor(), {
      resolveRuntime: () => resolveFrom(goodPackage()),
    });

    expect(tool).toEqual({
      name: "step-node",
      kind: "native-tool",
      version: "26.13.1-keiko.5181",
      platformTarget: "windows-x64",
      architecture: "x64",
      executablePath: "runtime/step-node/node.exe",
      licensePath: "runtime/licenses/node-step/LICENSE",
      source: {
        sourceUrl: "https://nodejs.org/dist/v26.13.1/node-v26.13.1.tar.gz",
        sourceSha256: approval.stepNode.sourceSha256,
        patchSha256s: [...approval.stepNode.patchSha256s],
        binarySha256: approval.stepNode.sha256,
        licenseSha256: STEP_NODE_LICENSE_SHA256,
      },
      unsignedSha256: approval.stepNode.sha256,
      shippedSha256: approval.stepNode.sha256,
      sizeBytes: approval.stepNode.sizeBytes,
      sbomBomRef: "pkg:generic/nodejs@26.13.1-keiko.5181?platform=windows-x64",
      signing: {
        signatureKind: "authenticode",
        verificationStatus: "unsigned-non-production",
        signatureVerified: false,
        notarizationRequired: false,
        notarizationVerified: false,
      },
    });
    // The real pin supplies the source and patch digests of the real build.
    expect(approval.stepNode.sourceSha256).toBe(
      "60c6cdf11c3e9d5932fccd0eafae77f1152661584e129047684cb8646f228d3e",
    );
  });

  it("agrees with the server on where the file lives and what the entry is called", () => {
    expect(STEP_NODE_PORTABLE_EXECUTABLE_PATH).toBe(
      `runtime/${STEP_NODE_DIRECTORY_NAME}/${STEP_NODE_FILE_NAME}`,
    );
    expect(STEP_NODE_TOOL_NAME).toBe(ACTIVATION_STEP_NODE_TOOL_NAME);
    expect(STEP_NODE_PACKAGE_ENTRY).toBe(`package/${STEP_NODE_PORTABLE_EXECUTABLE_PATH}`);
  });

  it("ships the Node.js license text of the official source tarball", () => {
    const text = readFileSync(join(repoRoot, ...STEP_NODE_LICENSE_SOURCE_PATH.split("/")));
    expect(sha256(text)).toBe(STEP_NODE_LICENSE_SHA256);
    expect(text.toString("utf8")).toContain("Node.js is licensed for use as follows");
  });

  it.each(PORTABLE_TARGETS.filter((target) => target.platformTarget !== "windows-x64"))(
    "stages nothing and resolves nothing for $platformTarget",
    (target) => {
      let resolved = false;
      const tools = stageStepNodeTool(target, resourceRootFor(), {
        resolveRuntime: () => {
          resolved = true;
          return fixtureStepNodeRuntime();
        },
      });
      expect(tools).toEqual([]);
      expect(resolved).toBe(false);
    },
  );

  it("refuses a tarball whose digest differs from the catalog pin", () => {
    const tarball = goodPackage();
    expect(() => resolveFrom(tarball, { catalogOverrides: { sha256: "f".repeat(64) } })).toThrow(
      "runtime package tarball digest differs from its catalog pin",
    );
  });

  it("refuses a tarball whose size differs from the catalog pin", () => {
    const tarball = goodPackage();
    const size = lstatSync(tarball).size;
    expect(() => resolveFrom(tarball, { catalogOverrides: { sizeBytes: size + 1 } })).toThrow(
      "runtime package tarball size differs from its catalog pin",
    );
  });

  it("refuses a step Node.js whose bytes differ from the server's pin", () => {
    const tarball = goodPackage();
    const wrong = fixtureStepNodeApproval("other bytes");
    expect(() => resolveFrom(tarball, { approval: wrong })).toThrow(
      "differs from the server's pin",
    );
  });

  it("refuses a package that does not hold the step Node.js", () => {
    const tarball = buildPackage({ "package/package.json": "{}" });
    expect(() => resolveFrom(tarball)).toThrow("must hold the step Node.js exactly once");
  });

  it("refuses a package whose step Node.js folder holds another entry", () => {
    const tarball = buildPackage({
      [STEP_NODE_PACKAGE_ENTRY]: NODE_BYTES,
      "package/runtime/step-node/extra.dll": "x",
    });
    expect(() => resolveFrom(tarball)).toThrow("holds more than one entry");
  });

  it("refuses a package that holds an entry outside its package root", () => {
    const tarball = buildPackage(
      { [STEP_NODE_PACKAGE_ENTRY]: NODE_BYTES, "other/escape.txt": "x" },
      { topLevel: ["package", "other"] },
    );
    expect(() => resolveFrom(tarball)).toThrow("outside its package root");
  });

  it("refuses license text that differs from its pinned digest", () => {
    const tarball = goodPackage();
    const swapped = writeFixture(join(temporaryRoot(), "LICENSE"), "not the Node.js license");
    const approval = fixtureStepNodeApproval(NODE_BYTES);
    const catalog = catalogFor(selectedFor(tarball));
    expect(() =>
      resolveStepNodeRuntime({
        approval,
        catalog,
        localTarball: tarball,
        cacheDir: join(temporaryRoot(), "cache"),
        licenseSource: swapped,
      }),
    ).toThrow("license text differs from its pinned digest");
  });

  it("refuses a step Node.js entry that is a link", () => {
    const tarball = buildPackage(
      { "package/package.json": "{}" },
      { link: { name: "package/runtime/step-node/node.exe", target: "/etc/hosts" } },
    );
    expect(() => resolveFrom(tarball)).toThrow("is not a regular file");
  });

  it("aborts staging when the copied executable does not match the pin", () => {
    const failures = [];
    expect(() =>
      stageStepNodeTool(WINDOWS, resourceRootFor(), {
        copyFile: (source, destination) =>
          source.endsWith("node.exe")
            ? writeFixture(destination, "swapped bytes")
            : copyFileSync(source, destination),
        onFailure: (message) => failures.push(message),
        resolveRuntime: () => fixtureStepNodeRuntime(NODE_BYTES),
      }),
    ).toThrow("portable step Node.js staging aborted");
    expect(failures).toEqual(["step Node.js staged file is not the pinned size"]);
  });

  it("aborts staging when the copied executable has the right size but other bytes", () => {
    const failures = [];
    expect(() =>
      stageStepNodeTool(WINDOWS, resourceRootFor(), {
        copyFile: (source, destination) =>
          source.endsWith("node.exe")
            ? writeFixture(destination, "x".repeat(Buffer.byteLength(NODE_BYTES)))
            : copyFileSync(source, destination),
        onFailure: (message) => failures.push(message),
        resolveRuntime: () => fixtureStepNodeRuntime(NODE_BYTES),
      }),
    ).toThrow("portable step Node.js staging aborted");
    expect(failures).toEqual(["step Node.js staged runtime failed its pinned digest"]);
  });

  it("aborts staging when the copied license does not match its pin", () => {
    const failures = [];
    expect(() =>
      stageStepNodeTool(WINDOWS, resourceRootFor(), {
        copyFile: (source, destination) =>
          source.endsWith("node.exe")
            ? copyFileSync(source, destination)
            : writeFixture(destination, "swapped license"),
        onFailure: (message) => failures.push(message),
        resolveRuntime: () => fixtureStepNodeRuntime(NODE_BYTES),
      }),
    ).toThrow("portable step Node.js staging aborted");
    expect(failures).toEqual(["step Node.js staged license failed its pinned digest"]);
  });

  it("aborts staging when the folder holds anything but node.exe", () => {
    const failures = [];
    expect(() =>
      stageStepNodeTool(WINDOWS, resourceRootFor(), {
        copyFile: (source, destination) => {
          copyFileSync(source, destination);
          if (source.endsWith("node.exe")) writeFixture(join(dirname(destination), "stray"), "x");
        },
        onFailure: (message) => failures.push(message),
        resolveRuntime: () => fixtureStepNodeRuntime(NODE_BYTES),
      }),
    ).toThrow("portable step Node.js staging aborted");
    expect(failures).toEqual(["step Node.js folder must hold only node.exe"]);
  });
});

describe("the reviewed package the bytes come from", () => {
  const real = JSON.parse(
    readFileSync(join(repoRoot, "docs", "release", "coding-runtime-npm-packages.json"), "utf8"),
  );

  it("selects the newest reviewed Windows package that carries the approved OpenCode", () => {
    const selected = selectStepNodePackage(real, WINDOWS_PORTABLE_RUNTIME_APPROVAL.upstreamVersion);
    expect(selected).toMatchObject({
      target: "windows-x64",
      opencodeVersion: WINDOWS_PORTABLE_RUNTIME_APPROVAL.upstreamVersion,
    });
    expect(stepNodePackageUrl(selected)).toBe(
      `https://github.com/oscharko-dev/Keiko/releases/download/coding-runtime-${selected.version}/${selected.tarball}`,
    );
  });

  it("refuses an OpenCode version no reviewed Windows package carries", () => {
    expect(() => selectStepNodePackage(real, "0.0.0")).toThrow("no reviewed windows-x64 runtime");
  });

  it("prefers the newer of two reviewed packages that carry the same OpenCode", () => {
    const entry = (version) => ({
      name: "@oscharko-dev/keiko-coding-runtime-win32-x64",
      opencodeVersion: "9.9.9",
      tarball: `oscharko-dev-keiko-coding-runtime-win32-x64-${version}.tgz`,
      sizeBytes: 10,
      sha256: "a".repeat(64),
      integrity: `sha512-${"A".repeat(86)}==`,
    });
    const document = {
      schemaVersion: 1,
      releases: {
        "1.1.10": { "windows-x64": entry("1.1.10") },
        "1.1.9": { "windows-x64": entry("1.1.9") },
      },
    };
    expect(selectStepNodePackage(document, "9.9.9").version).toBe("1.1.10");
  });

  it("refuses a reviewed entry whose tarball name is a path, not a plain file name", () => {
    const name = "@oscharko-dev/keiko-coding-runtime-win32-x64/../escape";
    const document = {
      schemaVersion: 1,
      releases: {
        "1.1.10": {
          "windows-x64": {
            name,
            opencodeVersion: "9.9.9",
            tarball: `${name.slice(1).replace("/", "-")}-1.1.10.tgz`,
            sizeBytes: 10,
            sha256: "a".repeat(64),
            integrity: `sha512-${"A".repeat(86)}==`,
          },
        },
      },
    };
    expect(() => selectStepNodePackage(document, "9.9.9")).toThrow("names no plain file");
  });
});

describe("obtaining the package tarball", () => {
  function curlStub(source, calls) {
    return (command, args, options) => {
      const output = args.indexOf("--output");
      if (output === -1) return spawnSync(command, args, options);
      calls.push({ url: args.at(-1), destination: args[output + 1] });
      copyFileSync(source, args[output + 1]);
      return { status: 0 };
    };
  }

  it("prefers a local tarball and never downloads when one is given", () => {
    const tarball = goodPackage();
    const selected = selectedFor(tarball);
    const run = () => {
      throw new Error("the download must not run");
    };
    expect(
      obtainPackageTarball(selected, { localTarball: tarball, cacheDir: temporaryRoot(), run }),
    ).toBe(tarball);
  });

  it("verifies a local tarball like a downloaded one", () => {
    const tarball = goodPackage();
    expect(() =>
      obtainPackageTarball(selectedFor(tarball, { sha256: "e".repeat(64) }), {
        localTarball: tarball,
        cacheDir: temporaryRoot(),
      }),
    ).toThrow("digest differs");
  });

  it("downloads once from the reviewed transport release, verifies, and reuses the cache", () => {
    const source = goodPackage();
    const selected = selectedFor(source, { version: "1.1.9", tarball: "fixture-1.1.9.tgz" });
    const cacheDir = temporaryRoot();
    const calls = [];
    const first = obtainPackageTarball(selected, { cacheDir, run: curlStub(source, calls) });
    const second = obtainPackageTarball(selected, { cacheDir, run: curlStub(source, calls) });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://github.com/oscharko-dev/Keiko/releases/download/coding-runtime-1.1.9/fixture-1.1.9.tgz",
    );
    expect(second).toBe(first);
    expect(existsSync(first)).toBe(true);
  });

  it("refuses and discards a download whose bytes differ from the pin", () => {
    const source = goodPackage();
    const selected = selectedFor(source, { sha256: "d".repeat(64) });
    const cacheDir = temporaryRoot();
    expect(() => obtainPackageTarball(selected, { cacheDir, run: curlStub(source, []) })).toThrow(
      "digest differs",
    );
    expect(existsSync(join(cacheDir, selected.sha256, selected.tarball))).toBe(false);
  });

  it("verifies a cached tarball again before using it", () => {
    const source = goodPackage();
    const selected = selectedFor(source);
    const cacheDir = temporaryRoot();
    const cached = obtainPackageTarball(selected, { cacheDir, run: curlStub(source, []) });
    writeFileSync(cached, "tampered");
    expect(() => obtainPackageTarball(selected, { cacheDir, run: curlStub(source, []) })).toThrow(
      "runtime package tarball size differs",
    );
  });

  it("reports a failed transfer with the plain download reason", () => {
    const selected = selectedFor(goodPackage());
    expect(() =>
      obtainPackageTarball(selected, {
        cacheDir: temporaryRoot(),
        run: () => ({ status: 22 }),
      }),
    ).toThrow("download failed");
  });
});

describe("the step Node.js in the manifest's evidence", () => {
  function manifestWithTools() {
    const resolved = fixtureStepNodeRuntime(NODE_BYTES);
    const [stepNode] = stageStepNodeTool(WINDOWS, resourceRootFor(), {
      resolveRuntime: () => resolved,
    });
    return { stepNode };
  }

  it("is a CycloneDX component bound to the shipped digest and the pinned source", () => {
    const { stepNode } = manifestWithTools();
    const sbom = sbomForManifest({ nativeHelpers: [], nativeAddons: [], nativeTools: [stepNode] });
    const [component] = sbom.components;
    expect(component).toMatchObject({
      "bom-ref": stepNode.sbomBomRef,
      licenses: [{ expression: "MIT" }],
      hashes: [{ alg: "SHA-256", content: stepNode.shippedSha256 }],
      externalReferences: [
        {
          url: stepNode.source.sourceUrl,
          hashes: [{ alg: "SHA-256", content: stepNode.source.sourceSha256 }],
        },
      ],
    });
    expect(component.properties.filter((p) => p.name === "keiko:patch-sha256")).toHaveLength(
      stepNode.source.patchSha256s.length,
    );
  });

  it("is named in the third-party notices with its license path", () => {
    const { stepNode } = manifestWithTools();
    const notices = thirdPartyNotices({
      nativeAddons: [{ version: "1", source: { tarballUrl: "https://example.test/u.tgz" } }],
      nativeTools: [stepNode],
    });
    expect(notices).toContain("Node.js 26.13.1-keiko.5181");
    expect(notices).toContain(`included at ${STEP_NODE_PORTABLE_LICENSE_PATH}`);
  });
});

describe("the tool-set shape and the signing inventory", () => {
  it.each([
    ["ripgrep alone", [{ name: "ripgrep" }], true],
    ["ripgrep then the step Node.js", [{ name: "ripgrep" }, { name: "step-node" }], true],
    ["no tools", [], false],
    ["the step Node.js alone", [{ name: "step-node" }], false],
    ["the step Node.js first", [{ name: "step-node" }, { name: "ripgrep" }], false],
    ["two ripgrep entries", [{ name: "ripgrep" }, { name: "ripgrep" }], false],
    ["an unknown second tool", [{ name: "ripgrep" }, { name: "other" }], false],
    ["three tools", [{ name: "ripgrep" }, { name: "step-node" }, { name: "step-node" }], false],
    ["a non-array", { name: "ripgrep" }, false],
    ["an unknown tool alone", [{ name: "other" }], false],
    ["an unknown first tool", [{ name: "other" }, { name: "step-node" }], false],
    ["an unnamed first tool", [{}], false],
  ])("accepts %s: %s", (_label, tools, expected) => {
    expect(nativeToolSetIsValid(tools)).toBe(expected);
  });

  it("keeps the step Node.js out of every signing inventory, whatever the root", () => {
    expect(isStepNodeExecutablePath("runtime/step-node/node.exe")).toBe(true);
    expect(isStepNodeExecutablePath("payload/Keiko/runtime/step-node/node.exe")).toBe(true);
    expect(isStepNodeExecutablePath("Runtime/Step-Node/Node.exe")).toBe(true);
    expect(
      isStepNodeExecutablePath(
        `.portable/generations/${"a".repeat(64)}/runtime/step-node/node.exe`,
      ),
    ).toBe(true);
    expect(isStepNodeExecutablePath("app/node_modules/x/runtime/step-node/node.exe")).toBe(false);
    expect(isStepNodeExecutablePath(".portable/generations/abc/runtime/step-node/node.exe")).toBe(
      false,
    );
    expect(isStepNodeExecutablePath("runtime/node/node.exe")).toBe(false);
    expect(isStepNodeExecutablePath("runtime/step-node/other.exe")).toBe(false);
  });
});

describe("the step Node.js after the Windows signing lane", () => {
  function signedFixture() {
    const stageRoot = temporaryRoot();
    const resourceRoot = join(stageRoot, "payload", "Keiko");
    writeFixture(join(resourceRoot, "app", "package.json"), "{}\n");
    writeFixture(join(resourceRoot, "runtime", "native", "rg.exe"), "ripgrep fixture");
    const [stepNode] = stageStepNodeTool(WINDOWS, resourceRoot, {
      resolveRuntime: () => fixtureStepNodeRuntime(NODE_BYTES),
    });
    const ripgrep = {
      name: "ripgrep",
      executablePath: "runtime/native/rg.exe",
      sbomBomRef: "pkg:github/burntsushi/ripgrep@0?platform=windows-x64",
      shippedSha256: "0".repeat(64),
      sizeBytes: 0,
    };
    writeFixture(
      join(stageRoot, "evidence", "sbom.cdx.json"),
      `${JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        components: [ripgrep, stepNode].map((tool) => ({
          "bom-ref": tool.sbomBomRef,
          hashes: [{ alg: "SHA-256", content: tool.shippedSha256 }],
        })),
      })}\n`,
    );
    const manifest = {
      artifact: { platformTarget: "windows-x64", assetName: WINDOWS.assetName },
      nativeTools: [ripgrep, stepNode],
      provenance: {},
      releaseImpact: { reviewedBinding: {} },
    };
    return { manifest, resourceRoot, stageRoot, stepNode };
  }

  it("rebinds both tools and leaves the unsigned step Node.js bytes and digest as staged", () => {
    const { manifest, stageRoot, stepNode } = signedFixture();
    rebindSignedPayload(stageRoot, manifest, "windows-x64");

    expect(manifest.nativeTools[0].shippedSha256).toBe(sha256("ripgrep fixture"));
    expect(manifest.nativeTools[1].shippedSha256).toBe(stepNode.unsignedSha256);
    expect(manifest.nativeTools[1].sizeBytes).toBe(stepNode.sizeBytes);
  });

  it("rebinds the digest of a changed step Node.js, which the manifest validator then refuses", () => {
    const { manifest, resourceRoot, stageRoot } = signedFixture();
    writeFileSync(join(resourceRoot, "runtime", "step-node", "node.exe"), "signed, so changed");
    rebindSignedPayload(stageRoot, manifest, "windows-x64");
    expect(manifest.nativeTools[1].shippedSha256).not.toBe(manifest.nativeTools[1].unsignedSha256);
  });

  it("projects the provenance of the step Node.js with its source and patch digests", () => {
    const { stepNode } = signedFixture();
    expect(nativeToolProvenance(stepNode)).toEqual({
      architecture: "x64",
      executablePath: "runtime/step-node/node.exe",
      name: "step-node",
      shippedSha256: stepNode.shippedSha256,
      signatureKind: "authenticode",
      signatureVerified: false,
      notarizationVerified: false,
      sourceSha256: stepNode.source.sourceSha256,
      patchSha256s: stepNode.source.patchSha256s,
      unsignedSha256: stepNode.unsignedSha256,
      version: "26.13.1-keiko.5181",
    });
  });
});

describe("the stage command line", () => {
  function stageArguments(target) {
    return [
      "scripts/stage-portable-runtime.mjs",
      "--target",
      target,
      "--node-version",
      "26.13.1",
      "--node-archive-url",
      "https://nodejs.org/dist/v26.13.1/node-v26.13.1-linux-x64.tar.gz",
      "--node-sha256",
      "a".repeat(64),
      "--commit-sha",
      "b".repeat(40),
      "--step-node-package",
      "/abs/runtime-package.tgz",
    ];
  }

  it.each(["linux-x64", "macos-arm64", "macos-x64"])(
    "refuses --step-node-package for %s before staging anything",
    (target) => {
      const result = spawnSync(process.execPath, stageArguments(target), {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--step-node-package is accepted only for the windows-x64");
    },
  );
});
