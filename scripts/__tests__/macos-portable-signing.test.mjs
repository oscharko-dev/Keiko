import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertAcceptedNotaryResult,
  inventoryMacPortableCode,
  main,
  validateAppleSigningConfig,
} from "../macos-portable-signing.mjs";
import {
  hashDirectoryTree,
  portableVerificationSummaryForManifest,
  sha256File,
  validatePortableCandidateManifest,
} from "../portable-runtime.mjs";
import { prepareIsolatedMacSmoke } from "../isolated-macos-production-smoke.mjs";

const roots = [];
function root() {
  const path = mkdtempSync(join(tmpdir(), "keiko-macos-signing-"));
  roots.push(path);
  return path;
}
function write(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}
function macho(magic = 0xfeedfacf, marker = 0) {
  const bytes = Buffer.alloc(64, marker);
  bytes.writeUInt32BE(magic, 0);
  return bytes;
}
function payload() {
  const path = root();
  write(join(path, "Keiko.app", "Contents", "MacOS", "Keiko"), macho());
  write(
    join(path, "Keiko.app", "Contents", "Resources", "runtime", "node", "bin", "node"),
    macho(0xcafebabf, 1),
  );
  write(
    join(
      path,
      "Keiko.app",
      "Contents",
      "Resources",
      "runtime",
      "sidecars",
      "opencode",
      "bin",
      "opencode",
    ),
    macho(0xcafebabe, 2),
  );
  write(
    join(path, "Keiko.app", "Contents", "Resources", "app", "addon.node"),
    macho(0xfeedface, 3),
  );
  write(join(path, "support", "keiko-support.sh"), Buffer.from("#!/bin/sh\n"));
  return path;
}

const macChecks = Object.freeze({
  assessmentVerified: true,
  developerIdVerified: true,
  notarizationVerified: true,
  stapleVerified: true,
});

function contractManifest() {
  const contract = readFileSync("docs/release/portable-runtime-artifact-contract.md", "utf8");
  const match = /## Manifest Schema Draft[\s\S]*?```json\n([\s\S]*?)\n```/u.exec(contract);
  if (match?.[1] === undefined) throw new Error("manifest example missing");
  return JSON.parse(match[1]);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function macManifest(executableBytes, licenseBytes) {
  const manifest = contractManifest();
  const sidecar = manifest.sidecarRuntimes[0];
  const binding = manifest.releaseImpact.reviewedBinding;
  manifest.release.releaseId = 0;
  manifest.artifact.assetId = 0;
  binding.releaseId = 0;
  binding.assetId = 0;
  manifest.artifact.platformTarget = "macos-arm64";
  manifest.artifact.assetName = "keiko-macos-arm64.zip";
  manifest.runtime.nodePlatform = "darwin";
  manifest.runtime.nodeArchitecture = "arm64";
  manifest.runtime.nodeArchiveSha256 = "a".repeat(64);
  manifest.provenance.rootPackageTarballSha256 = "b".repeat(64);
  sidecar.platformTarget = "macos-arm64";
  sidecar.archive = {
    platformTarget: "macos-arm64",
    url: "https://github.com/anomalyco/opencode/releases/download/v1.17.17/opencode-darwin-arm64.zip",
    sizeBytes: 55159915,
    sha256: "cec03cf8b1119053d583e9afa14a987ca4ffa9dcd76cb79a7cd66774de6411f7",
  };
  sidecar.executablePath = "runtime/sidecars/opencode-compatible/bin/opencode";
  sidecar.executableSha256 = sha256(executableBytes);
  sidecar.executableTreeSha256 = createHash("sha256")
    .update(`bin/opencode\0${sidecar.executableSha256}\0`)
    .digest("hex");
  sidecar.license = {
    spdxId: "MIT",
    url: "https://raw.githubusercontent.com/anomalyco/opencode/474abdd7ee60f4b67476cfcef7e5311beff4a824/LICENSE",
    sha256: sha256(licenseBytes),
  };
  sidecar.licenseEvidence.sha256 = sidecar.license.sha256;
  sidecar.sbomEvidence.sha256 = "d".repeat(64);
  manifest.entrypoints.primaryLauncher = "Keiko.app";
  manifest.entrypoints.supportLaunchers = ["support/keiko-support.sh"];
  Object.assign(sidecar.signing, {
    notarizationRequired: true,
    notarizationVerified: true,
    signatureKind: "developer-id-notarized",
    verificationChecks: macChecks,
  });
  Object.assign(manifest.security, {
    notarizationRequired: true,
    notarizationVerified: true,
    signatureKind: "developer-id-notarized",
    verificationChecks: macChecks,
  });
  Object.assign(binding, {
    assetName: manifest.artifact.assetName,
    nodeRuntimeIdentity: "node-v24.0.0-darwin-arm64",
    notarizationRequired: true,
    notarizationVerified: true,
    platformTarget: "macos-arm64",
    signatureKind: "developer-id-notarized",
    verificationChecks: macChecks,
  });
  binding.sidecarRuntimes = JSON.parse(JSON.stringify(manifest.sidecarRuntimes));
  return manifest;
}

function verifiedInput(manifest, checks = macChecks) {
  return {
    reasonCodes: [],
    sidecarRuntimes: manifest.sidecarRuntimes.map((sidecar) => ({
      name: sidecar.name,
      reasonCodes: [],
      verificationChecks: checks,
    })),
    verificationChecks: checks,
  };
}

function macFinalizeStage() {
  const stage = root();
  const payloadRoot = join(stage, "payload", "Keiko");
  const resources = join(payloadRoot, "Keiko.app", "Contents", "Resources");
  write(join(payloadRoot, "Keiko.app", "Contents", "MacOS", "Keiko"), macho());
  write(join(resources, "runtime", "node", "bin", "node"), macho(0xfeedfacf, 1));
  const sidecarExecutable = macho(0xfeedfacf, 2);
  const sidecarLicense = Buffer.from("license", "utf8");
  write(
    join(resources, "runtime", "sidecars", "opencode-compatible", "bin", "opencode"),
    sidecarExecutable,
  );
  write(
    join(resources, "runtime", "sidecars", "opencode-compatible", "LICENSE.txt"),
    sidecarLicense,
  );
  write(join(resources, "app", "index.js"), "signed app");
  write(join(resources, "app", "package.json"), '{"name":"@oscharko-dev/keiko"}\n');
  write(
    join(resources, ".portable", "setup-manifest.json"),
    `${JSON.stringify({
      bootstrapUpdateEligible: false,
      platformTarget: "macos-arm64",
      primaryLauncher: "Keiko.app",
      runtime: { nodeArchitecture: "arm64", nodePlatform: "darwin" },
      stable: true,
    })}\n`,
  );
  write(join(payloadRoot, "support", "keiko-support.sh"), "#!/bin/sh\n");
  const manifest = macManifest(sidecarExecutable, sidecarLicense);
  const manifestPath = join(stage, "manifest", "portable-manifest.json");
  const provenancePath = join(stage, "evidence", "provenance.intoto.jsonl");
  const checksumPath = join(stage, "evidence", "SHA256SUMS.txt");
  const summaryPath = join(stage, "evidence", "signing-verification.json");
  write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  write(provenancePath, `${JSON.stringify({ subjectDigest: "0".repeat(64) })}\n`);
  write(checksumPath, "before\n");
  write(summaryPath, "before\n");
  const archivePath = join(stage, manifest.artifact.assetName);
  const zipped = spawnSync("zip", ["-qr", archivePath, "Keiko"], {
    cwd: join(stage, "payload"),
  });
  if (zipped.status !== 0) throw new Error("fixture zip failed");
  const inventoryPath = join(stage, "inventory.json");
  writeFileSync(
    inventoryPath,
    JSON.stringify(inventoryMacPortableCode(payloadRoot, "macos-arm64")),
  );
  const inputPath = join(stage, "verification-input.json");
  writeFileSync(inputPath, JSON.stringify(verifiedInput(manifest)));
  return {
    archivePath,
    checksumPath,
    inputPath,
    inventoryPath,
    manifestPath,
    provenancePath,
    resources,
    stage,
    summaryPath,
  };
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("macOS portable signing inventory", () => {
  it("detects thin/fat Mach-O content and assigns only Node the JIT role", () => {
    const path = payload();
    write(
      join(path, "Keiko.app", "Contents", "Resources", "runtime", "node", "lib", "helper"),
      macho(0xfeedfacf, 4),
    );
    const inventory = inventoryMacPortableCode(path, "macos-arm64");
    expect(inventory.codeObjects.map((entry) => [entry.relativePath, entry.role])).toEqual([
      ["Keiko.app/Contents/MacOS/Keiko", "default"],
      ["Keiko.app/Contents/Resources/app/addon.node", "default"],
      ["Keiko.app/Contents/Resources/runtime/node/bin/node", "node-runtime"],
      ["Keiko.app/Contents/Resources/runtime/node/lib/helper", "default"],
      ["Keiko.app/Contents/Resources/runtime/sidecars/opencode/bin/opencode", "sidecar-runtime"],
    ]);
  });

  it("includes nested bundles and malformed Mach-O candidates in the native verification set", () => {
    const path = payload();
    write(
      join(path, "Keiko.app", "Contents", "PlugIns", "Bank.bundle", "Contents", "MacOS", "Bank"),
      Buffer.from([0xfe, 0xed, 0xfa, 0xcf]),
    );
    const inventory = inventoryMacPortableCode(path, "macos-arm64");
    expect(inventory.nestedBundles).toEqual(["Keiko.app/Contents/PlugIns/Bank.bundle"]);
    expect(inventory.codeObjects.map((entry) => entry.relativePath)).toContain(
      "Keiko.app/Contents/PlugIns/Bank.bundle/Contents/MacOS/Bank",
    );
  });

  it("fails closed for missing required code and aliased payload entries", () => {
    const missing = root();
    write(join(missing, "Keiko.app", "Contents", "MacOS", "Keiko"), macho());
    expect(() => inventoryMacPortableCode(missing, "macos-x64")).toThrow(
      /Node executable is missing/u,
    );
    const linked = payload();
    symlinkSync(join(linked, "Keiko.app", "Contents", "MacOS", "Keiko"), join(linked, "alias"));
    expect(() => inventoryMacPortableCode(linked, "macos-arm64")).toThrow(/contains a link/u);
    const hardlinked = payload();
    linkSync(
      join(hardlinked, "Keiko.app", "Contents", "MacOS", "Keiko"),
      join(hardlinked, "alias"),
    );
    expect(() => inventoryMacPortableCode(hardlinked, "macos-arm64")).toThrow(/hard-linked/u);
  });

  it("rejects mutated inventory authority before comparison", async () => {
    const stage = root();
    const original = inventoryMacPortableCode(payload(), "macos-arm64");
    const expected = join(stage, "expected.json");
    writeFileSync(expected, JSON.stringify(original));
    const mutate = (change) => {
      const value = JSON.parse(JSON.stringify(original));
      change(value);
      return value;
    };
    const mutations = [
      mutate((value) => {
        value.target = "macos-x64";
      }),
      mutate((value) => {
        value.codeObjects.reverse();
      }),
      mutate((value) => {
        value.codeObjects[0].role = "node-runtime";
      }),
      mutate((value) => {
        value.codeObjects = value.codeObjects.filter(
          (entry) => !entry.relativePath.endsWith("/node/bin/node"),
        );
      }),
      mutate((value) => {
        value.unreviewed = true;
      }),
      mutate((value) => {
        value.nestedBundles = ["Keiko.app/Contents/PlugIns/not-a-bundle"];
      }),
      mutate((value) => {
        value.nestedBundles = [
          "Keiko.app/Contents/A.bundle",
          "Keiko.app/Contents/A.bundle/Contents/B.framework",
        ];
      }),
    ];
    for (const [index, mutation] of mutations.entries()) {
      const actual = join(stage, `actual-${String(index)}.json`);
      writeFileSync(actual, JSON.stringify(mutation));
      await expect(
        main(["compare-paths", "--expected-inventory", expected, "--actual-inventory", actual]),
      ).rejects.toThrow(/inventory|changed unexpectedly|executable is missing/u);
    }
  });

  it("finalizes a real macOS layout against app resources and canonical evidence", async () => {
    const fixture = macFinalizeStage();
    await expect(
      main([
        "finalize",
        "--stage-root",
        fixture.stage,
        "--expected-inventory",
        fixture.inventoryPath,
        "--verification-input",
        fixture.inputPath,
      ]),
    ).resolves.toBeUndefined();

    const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8"));
    const archiveSha256 = await sha256File(fixture.archivePath);
    const sidecarRoot = join(fixture.resources, "runtime", "sidecars", "opencode-compatible");
    const provenance = JSON.parse(readFileSync(fixture.provenancePath, "utf8"));
    const summary = JSON.parse(readFileSync(fixture.summaryPath, "utf8"));
    expect(validatePortableCandidateManifest(manifest)).toEqual([]);
    expect(manifest.artifact.sha256).toBe(archiveSha256);
    expect(manifest.provenance.packagedAppTreeSha256).toBe(
      hashDirectoryTree(join(fixture.resources, "app")),
    );
    expect(manifest.sidecarRuntimes[0].payloadSha256).toBe(hashDirectoryTree(sidecarRoot));
    expect(manifest.sidecarRuntimes[0].sizeBytes).toBeGreaterThan(0);
    expect(provenance.subjectDigest).toBe(archiveSha256);
    expect(readFileSync(fixture.checksumPath, "utf8")).toBe(
      `${archiveSha256}  keiko-macos-arm64.zip\n`,
    );
    expect(manifest.releaseImpact.reviewedBinding.archiveSha256).toBe(archiveSha256);
    expect(manifest.releaseImpact.reviewedBinding.sidecarRuntimes).toEqual(
      manifest.sidecarRuntimes,
    );
    expect(summary).toEqual(portableVerificationSummaryForManifest(manifest));
    expect(summary.status).toBe("verified-production");
  });

  it("leaves finalizer-owned bytes unchanged for false or malformed native input", async () => {
    for (const kind of ["false", "malformed"]) {
      const fixture = macFinalizeStage();
      const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8"));
      const input =
        kind === "false"
          ? verifiedInput(manifest, { ...macChecks, stapleVerified: false })
          : { ...verifiedInput(manifest), rawProviderResponse: "secret-bearing" };
      writeFileSync(fixture.inputPath, JSON.stringify(input));
      const paths = [
        fixture.archivePath,
        fixture.manifestPath,
        fixture.provenancePath,
        fixture.checksumPath,
        fixture.summaryPath,
      ];
      const before = paths.map((path) => readFileSync(path));
      await expect(
        main([
          "finalize",
          "--stage-root",
          fixture.stage,
          "--expected-inventory",
          fixture.inventoryPath,
          "--verification-input",
          fixture.inputPath,
        ]),
      ).rejects.toThrow();
      expect(paths.map((path) => readFileSync(path))).toEqual(before);
    }
  });

  it("isolates payload mutation from the uploaded artifact and source archive", async () => {
    const fixture = macFinalizeStage();
    await main([
      "finalize",
      "--stage-root",
      fixture.stage,
      "--expected-inventory",
      fixture.inventoryPath,
      "--verification-input",
      fixture.inputPath,
    ]);
    const archiveBefore = readFileSync(fixture.archivePath);
    const sourceNode = join(fixture.resources, "runtime", "node", "bin", "node");
    const sourceNodeBefore = readFileSync(sourceNode);
    const disposable = join(
      dirname(fixture.stage),
      `keiko-isolated-macos-smoke-${Date.now().toString(36)}`,
    );
    roots.push(disposable);
    await prepareIsolatedMacSmoke({
      "artifact-root": fixture.stage,
      "disposable-root": disposable,
      "runner-temp": dirname(fixture.stage),
      extractor: (archive, destination) => {
        const result = spawnSync("unzip", ["-q", archive, "-d", destination], {
          stdio: "ignore",
        });
        if (result.status !== 0) throw new Error("fixture extraction failed");
      },
      target: "macos-arm64",
    });
    writeFileSync(
      join(
        disposable,
        "Keiko",
        "Keiko.app",
        "Contents",
        "Resources",
        "runtime",
        "node",
        "bin",
        "node",
      ),
      "poisoned disposable payload",
    );
    expect(readFileSync(fixture.archivePath)).toEqual(archiveBefore);
    expect(readFileSync(sourceNode)).toEqual(sourceNodeBefore);
  });

  it("rejects every mutated signed-candidate setup field before extraction", async () => {
    const setupMutations = [
      ["wrong-platform", (setup) => (setup.platformTarget = "macos-x64")],
      ["wrong-launcher", (setup) => (setup.primaryLauncher = "Other.app")],
      ["bootstrap-true", (setup) => (setup.bootstrapUpdateEligible = true)],
      ["bootstrap-missing", (setup) => Reflect.deleteProperty(setup, "bootstrapUpdateEligible")],
      ["wrong-node-platform", (setup) => (setup.runtime.nodePlatform = "win32")],
      ["wrong-node-architecture", (setup) => (setup.runtime.nodeArchitecture = "x64")],
      ["stable-false", (setup) => (setup.stable = false)],
      ["stable-missing", (setup) => Reflect.deleteProperty(setup, "stable")],
    ];
    const mutations = [
      [
        "missing-support",
        (fixture) => rmSync(join(fixture.stage, "payload", "Keiko", "support", "keiko-support.sh")),
      ],
      [
        "missing-setup",
        (fixture) => rmSync(join(fixture.resources, ".portable", "setup-manifest.json")),
      ],
      ...setupMutations.map(([name, mutate]) => [
        name,
        (fixture) => {
          const path = join(fixture.resources, ".portable", "setup-manifest.json");
          const setup = JSON.parse(readFileSync(path, "utf8"));
          mutate(setup);
          writeFileSync(path, JSON.stringify(setup));
        },
      ]),
      [
        "symlink-package",
        (fixture) => {
          const path = join(fixture.resources, "app", "package.json");
          rmSync(path);
          symlinkSync(join(fixture.resources, "app", "index.js"), path);
        },
      ],
      [
        "hardlink-support",
        (fixture) => {
          const path = join(fixture.stage, "payload", "Keiko", "support", "keiko-support.sh");
          rmSync(path);
          linkSync(join(fixture.resources, "app", "index.js"), path);
        },
      ],
    ];
    if (process.platform !== "win32") {
      mutations.push([
        "special-package",
        (fixture) => {
          const path = join(fixture.resources, "app", "package.json");
          rmSync(path);
          if (spawnSync("mkfifo", [path], { stdio: "ignore" }).status !== 0)
            throw new Error("mkfifo fixture failed");
        },
      ]);
    }
    for (const [name, mutate] of mutations) {
      const fixture = macFinalizeStage();
      await main([
        "finalize",
        "--stage-root",
        fixture.stage,
        "--expected-inventory",
        fixture.inventoryPath,
        "--verification-input",
        fixture.inputPath,
      ]);
      mutate(fixture);
      const disposable = join(dirname(fixture.stage), `keiko-isolated-macos-smoke-${name}`);
      roots.push(disposable);
      let extracted = false;
      await expect(
        prepareIsolatedMacSmoke({
          "artifact-root": fixture.stage,
          "disposable-root": disposable,
          "runner-temp": dirname(fixture.stage),
          extractor: () => {
            extracted = true;
          },
          target: "macos-arm64",
        }),
        name,
      ).rejects.toThrow(/portable launch\/setup smoke failed/u);
      expect(extracted, name).toBe(false);
    }
  });
});

describe("macOS protected configuration and native result", () => {
  function config() {
    return {
      APPLE_DEVELOPER_ID_IDENTITY: "Developer ID Application: Keiko Bank (AB12CD34EF)",
      APPLE_TEAM_ID: "AB12CD34EF",
      APPLE_NOTARY_KEY_ID: "ZX98YU76TR",
      APPLE_NOTARY_ISSUER_ID: "11111111-2222-3333-4444-555555555555",
      APPLE_DEVELOPER_ID_CERT_P12_BASE64: Buffer.concat([
        Buffer.from([0x30]),
        Buffer.alloc(255, 1),
      ]).toString("base64"),
      APPLE_DEVELOPER_ID_CERT_PASSWORD: "protected",
      APPLE_NOTARY_KEY_P8_BASE64: Buffer.from(
        `-----BEGIN PRIVATE KEY-----\n${"A".repeat(80)}\n-----END PRIVATE KEY-----\n`,
      ).toString("base64"),
    };
  }
  it("accepts the exact team-bound identity and rejects missing or mismatched values", () => {
    expect(() => validateAppleSigningConfig(config())).not.toThrow();
    expect(() => validateAppleSigningConfig({ ...config(), APPLE_TEAM_ID: "WRONG" })).toThrow();
    expect(() =>
      validateAppleSigningConfig({ ...config(), APPLE_NOTARY_KEY_P8_BASE64: "" }),
    ).toThrow();
  });

  it("rejects unbounded, malformed, or control-bearing credential references", () => {
    expect(() =>
      validateAppleSigningConfig({
        ...config(),
        APPLE_DEVELOPER_ID_CERT_PASSWORD: "bad\npassword",
      }),
    ).toThrow(/configuration is invalid/u);
    expect(() =>
      validateAppleSigningConfig({ ...config(), APPLE_DEVELOPER_ID_CERT_P12_BASE64: "AAAA" }),
    ).toThrow(/credential size/u);
    expect(() =>
      validateAppleSigningConfig({
        ...config(),
        APPLE_NOTARY_KEY_P8_BASE64: Buffer.alloc(65, 1).toString("base64"),
      }),
    ).toThrow(/notary key encoding/u);
  });

  it("rejects malformed or secret-bearing notary responses with one bounded message", () => {
    for (const content of [
      "not json /private/secret",
      JSON.stringify({ status: "Rejected", log: "token=secret" }),
    ]) {
      const path = join(root(), "notary.json");
      writeFileSync(path, content);
      expect(() => assertAcceptedNotaryResult(path)).toThrow(
        "macos-portable-signing: notarization result was not accepted",
      );
      const result = spawnSync(
        process.execPath,
        ["scripts/macos-portable-signing.mjs", "notary-result", "--result", path],
        { encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toBe("macos-portable-signing: notarization result was not accepted\n");
      expect(result.stderr).not.toContain(path);
      expect(result.stderr).not.toContain("token=secret");
    }
  });

  it("keeps key material non-extractable, sign-only, and scoped to one identity", () => {
    const helper = readFileSync(
      new URL("../../native/portable-launcher/macos-keychain-helper.c", import.meta.url),
      "utf8",
    );
    expect(helper).toContain("kSecAttrCanSign");
    expect(helper).toContain("kSecAttrIsPermanent, kSecAttrIsSensitive");
    expect(helper).not.toContain("kSecAttrIsExtractable");
    expect(helper).toContain("count == 1");
    expect(helper).toContain("/usr/bin/codesign");
    const cleanup = readFileSync(
      new URL("../cleanup-macos-portable-signing.sh", import.meta.url),
      "utf8",
    );
    expect(cleanup).toContain("KEIKO_KEYCHAIN_PASSWORD=\\n");
    expect(cleanup).toContain('rm -rf "$root"');
  });
});
