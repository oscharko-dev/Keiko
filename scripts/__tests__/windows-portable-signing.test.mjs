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
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bindRuntimeAttestation,
  catalogForInventory,
  inventoriesMatch,
  inventoryAddsOnlyRuntimeAttestation,
  inventoryPathsMatch,
  inventoryWindowsPortablePeFiles,
  main,
  rebindArchive,
} from "../windows-portable-signing.mjs";
import { assertWindowsProductionVerificationInput } from "../windows-portable-verification-input.mjs";
import { hashDirectoryTree } from "../portable-runtime.mjs";
import { qualificationReceiptFor } from "../qualify-windows-runtime-release.mjs";
import {
  USEARCH_RUNTIME_MANIFEST,
  usearchRuntimeTargetKey,
} from "../../packages/keiko-local-knowledge/src/retrieval/usearch-runtime-manifest.ts";

const roots = [];

function root() {
  const path = mkdtempSync(join(tmpdir(), "keiko-windows-signing-"));
  roots.push(path);
  return path;
}

function portableExecutable(marker = 0) {
  const bytes = Buffer.alloc(128, marker);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  bytes.writeUInt32LE(64, 0x3c);
  bytes.set([0x50, 0x45, 0x00, 0x00], 64);
  return bytes;
}

function write(path, bytes = portableExecutable()) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function contractManifest() {
  const contract = readFileSync("docs/release/portable-runtime-artifact-contract.md", "utf8");
  const match = /## Manifest Schema Draft[\s\S]*?```json\n([\s\S]*?)\n```/u.exec(contract);
  if (match?.[1] === undefined) throw new Error("manifest example missing");
  return JSON.parse(match[1]);
}

function validPayload() {
  const payload = root();
  write(join(payload, "Keiko.exe"), portableExecutable(1));
  write(join(payload, "runtime", "node", "node.exe"), portableExecutable(2));
  write(
    join(payload, "runtime", "native", "keiko-secure-workspace-read.exe"),
    portableExecutable(5),
  );
  write(join(payload, "runtime", "native", "keiko-runtime-supervisor.exe"), portableExecutable(6));
  write(join(payload, "runtime", "sidecars", "worker", "worker.node"), portableExecutable(3));
  write(join(payload, "app", "native-addon.bin"), portableExecutable(4));
  write(join(payload, "app", "README.md"), Buffer.from("not executable"));
  return payload;
}

function validStage() {
  const stage = root();
  const payload = join(stage, "payload", "Keiko");
  write(join(payload, "Keiko.exe"), portableExecutable(1));
  write(join(payload, "runtime", "node", "node.exe"), portableExecutable(2));
  write(
    join(payload, "runtime", "native", "keiko-secure-workspace-read.exe"),
    portableExecutable(5),
  );
  write(join(payload, "runtime", "native", "keiko-runtime-supervisor.exe"), portableExecutable(6));
  return { payload, stage };
}

function addWindowsUsearchFixture(payload, manifest) {
  const targetKey = usearchRuntimeTargetKey("win32", "x64");
  if (targetKey === undefined) throw new Error("missing Windows USearch fixture target");
  const approved = USEARCH_RUNTIME_MANIFEST.targets[targetKey];
  const executablePath = "runtime/native/usearch.node";
  const licensePath = "runtime/licenses/usearch/LICENSE";
  const addonBytes = portableExecutable(8);
  write(join(payload, ...executablePath.split("/")), addonBytes);
  write(join(payload, ...licensePath.split("/")), Buffer.from("Apache-2.0 fixture"));
  manifest.nativeAddons = [
    {
      name: "usearch",
      kind: "node-native-addon",
      version: USEARCH_RUNTIME_MANIFEST.version,
      platformTarget: "windows-x64",
      architecture: "x64",
      executablePath,
      licensePath,
      source: {
        commitSha: USEARCH_RUNTIME_MANIFEST.sourceCommit,
        tarballUrl: USEARCH_RUNTIME_MANIFEST.tarballUrl,
        tarballSha256: USEARCH_RUNTIME_MANIFEST.tarballSha256,
        binarySha256: approved.binarySha256,
        licenseSha256: USEARCH_RUNTIME_MANIFEST.licenseSha256,
      },
      unsignedSha256: approved.binarySha256,
      shippedSha256: sha256(addonBytes),
      sizeBytes: addonBytes.length,
      sbomBomRef: `pkg:npm/usearch@${USEARCH_RUNTIME_MANIFEST.version}?platform=windows-x64`,
      signing: {
        signatureKind: "authenticode",
        verificationStatus: "unverified-staging",
        signatureVerified: false,
        notarizationRequired: false,
        notarizationVerified: false,
      },
    },
  ];
  manifest.releaseImpact.reviewedBinding.nativeAddons = structuredClone(manifest.nativeAddons);
}

function windowsPrepareStage() {
  const { payload, stage } = validStage();
  const manifest = contractManifest();
  manifest.release.commitSha = "a".repeat(40);
  manifest.provenance.sourceCommitSha = manifest.release.commitSha;
  const appBytes = Buffer.from("signed application");
  write(join(payload, "app", "index.js"), appBytes);
  const helpers = new Map(manifest.nativeHelpers.map((helper) => [helper.name, helper]));
  for (const [name, marker] of [
    ["keiko-secure-workspace-read", 5],
    ["keiko-runtime-supervisor", 6],
  ]) {
    const bytes = portableExecutable(marker);
    const helper = helpers.get(name);
    helper.sizeBytes = bytes.length;
    helper.shippedSha256 = sha256(bytes);
    helper.unsignedSha256 = sha256(bytes);
  }
  manifest.releaseImpact.reviewedBinding.nativeHelpers = structuredClone(manifest.nativeHelpers);
  addWindowsUsearchFixture(payload, manifest);

  const sidecar = manifest.sidecarRuntimes[0];
  const sidecarBytes = portableExecutable(9);
  const sidecarLicense = Buffer.from("MIT license");
  sidecar.executableSha256 = sha256(sidecarBytes);
  sidecar.executableTreeSha256 = createHash("sha256")
    .update(`opencode.cmd\0${sidecar.executableSha256}\0`)
    .digest("hex");
  sidecar.license.sha256 = sha256(sidecarLicense);
  sidecar.licenseEvidence.sha256 = sidecar.license.sha256;
  write(join(payload, ...sidecar.executablePath.split("/")), sidecarBytes);
  write(join(payload, ...sidecar.licenseEvidence.path.split("/")), sidecarLicense);
  write(
    join(payload, ...sidecar.sbomEvidence.path.split("/")),
    `${JSON.stringify({
      bomFormat: "CycloneDX",
      metadata: { component: { name: sidecar.name, version: sidecar.upstream.version } },
      components: [
        {
          name: sidecar.upstream.name,
          version: sidecar.upstream.version,
          purl: `pkg:github/${sidecar.upstream.owner}/${sidecar.upstream.repository}@${sidecar.upstream.tag}`,
          licenses: [{ license: { id: sidecar.license.spdxId } }],
          hashes: [{ alg: "SHA-256", content: sidecar.executableSha256 }],
          externalReferences: [
            {
              type: "distribution",
              url: sidecar.archive.url,
              hashes: [{ alg: "SHA-256", content: sidecar.archive.sha256 }],
            },
          ],
        },
      ],
    })}\n`,
  );
  write(
    join(stage, "evidence", "sbom.cdx.json"),
    `${JSON.stringify({
      bomFormat: "CycloneDX",
      components: manifest.nativeHelpers
        .map((helper) => ({
          "bom-ref": helper.sbomBomRef,
          hashes: [{ alg: "SHA-256", content: helper.shippedSha256 }],
        }))
        .concat(
          manifest.nativeAddons.map((addon) => ({
            "bom-ref": addon.sbomBomRef,
            hashes: [{ alg: "SHA-256", content: addon.shippedSha256 }],
          })),
        ),
    })}\n`,
  );
  mkdirSync(join(payload, ".portable"), { recursive: true });
  const manifestPath = join(stage, "manifest", "portable-manifest.json");
  write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const inventoryPath = join(stage, "inventory.json");
  writeFileSync(inventoryPath, JSON.stringify(inventoryWindowsPortablePeFiles(payload)));
  const verificationInputPath = join(stage, "verification-input.json");
  writeFileSync(
    verificationInputPath,
    JSON.stringify({
      peInventorySha256: sha256(readFileSync(inventoryPath)),
      reasonCodes: [],
      verificationChecks: { publisherChainVerified: true, timestampVerified: true },
      sidecarRuntimes: [
        {
          name: sidecar.name,
          payloadSha256: hashDirectoryTree(join(payload, ...sidecar.payloadRootPath.split("/"))),
          verificationChecks: { publisherChainVerified: true, timestampVerified: true },
        },
      ],
    }),
  );
  return { inventoryPath, manifestPath, stage, verificationInputPath };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("Windows portable PE signing inventory", () => {
  it("binds qualification to the exact activation, helpers, OpenCode payload, and source", () => {
    const resourceRoot = root();
    const supervisorBytes = portableExecutable(6);
    const secureReadBytes = portableExecutable(7);
    const supervisorPath = join(resourceRoot, "runtime", "native", "keiko-runtime-supervisor.exe");
    const secureReadPath = join(
      resourceRoot,
      "runtime",
      "native",
      "keiko-secure-workspace-read.exe",
    );
    write(supervisorPath, supervisorBytes);
    write(secureReadPath, secureReadBytes);
    write(join(resourceRoot, "Keiko.exe"), portableExecutable(1));
    write(join(resourceRoot, "runtime", "node", "node.exe"), portableExecutable(2));
    const sidecarRoot = join(resourceRoot, "runtime", "sidecars", "opencode-compatible");
    write(join(sidecarRoot, "opencode.exe"), portableExecutable(9));
    write(join(sidecarRoot, "LICENSE.txt"), Buffer.from("MIT"));
    const sidecarDigest = hashDirectoryTree(sidecarRoot);
    const sourceCommitSha = "a".repeat(40);
    const activationPath = join(resourceRoot, ".portable", "runtime-activation.json");
    write(
      activationPath,
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          suiteVersion: "runtime-tree-qualification-v1",
          product: {},
          sourceCommitSha,
          platformTarget: "windows-x64",
          artifact: { platformTarget: "windows-x64" },
          runtime: { nodePlatform: "win32", nodeArchitecture: "x64" },
          security: { verificationStatus: "verified-production" },
          nativeHelpers: [
            {
              name: "keiko-runtime-supervisor",
              platformTarget: "windows-x64",
              executablePath: "runtime/native/keiko-runtime-supervisor.exe",
              sizeBytes: supervisorBytes.length,
              shippedSha256: sha256(supervisorBytes),
            },
            {
              name: "keiko-secure-workspace-read",
              platformTarget: "windows-x64",
              executablePath: "runtime/native/keiko-secure-workspace-read.exe",
              sizeBytes: secureReadBytes.length,
              shippedSha256: sha256(secureReadBytes),
            },
          ],
          sidecarRuntimes: [
            {
              name: "opencode-compatible",
              platformTarget: "windows-x64",
              payloadRootPath: "runtime/sidecars/opencode-compatible",
              payloadSha256: sidecarDigest,
            },
          ],
          releaseImpact: {},
        }),
      ),
    );
    const expectedInventoryPath = join(resourceRoot, "inventory.json");
    writeFileSync(
      expectedInventoryPath,
      JSON.stringify(inventoryWindowsPortablePeFiles(resourceRoot)),
    );
    const verificationInputPath = join(resourceRoot, "verification.json");
    writeFileSync(
      verificationInputPath,
      JSON.stringify({
        peInventorySha256: sha256(readFileSync(expectedInventoryPath)),
        reasonCodes: [],
        verificationChecks: { publisherChainVerified: true, timestampVerified: true },
        sidecarRuntimes: [
          {
            name: "opencode-compatible",
            payloadSha256: sidecarDigest,
            reasonCodes: [],
            verificationChecks: { publisherChainVerified: true, timestampVerified: true },
          },
        ],
      }),
    );
    const qualificationInput = {
      activationPath,
      expectedInventoryPath,
      resourceRoot,
      sourceCommitSha,
      verificationInputPath,
    };

    expect(qualificationReceiptFor(qualificationInput)).toMatchObject({
      platformTarget: "windows-x64",
      sourceCommitSha,
      supervisorSha256: sha256(supervisorBytes),
      secureReadSha256: sha256(secureReadBytes),
      sidecars: [{ name: "opencode-compatible", sha256: sidecarDigest }],
      backend: "windows-job-object",
      result: "passed",
    });
    write(supervisorPath, portableExecutable(8));
    expect(() => qualificationReceiptFor(qualificationInput)).toThrow(
      /authenticated PE inventory no longer matches/u,
    );
  });

  it("requalifies the extracted supervisor and executes the signed attestor on a fresh runner", () => {
    const verifier = readFileSync("scripts/verify-fresh-windows-portable-artifact.ps1", "utf8");
    expect(verifier).toContain("qualify-windows-runtime-release.mjs");
    expect(verifier).toContain("keiko-runtime-attestation.exe");
    expect(verifier).toContain("--emit");
    expect(verifier).toContain("runtime attestation binding mismatch");
  });

  it("finds every PE by content, including non-exe runtime files, in deterministic order", () => {
    const inventory = inventoryWindowsPortablePeFiles(validPayload());

    expect(inventory.files.map((file) => file.relativePath)).toEqual([
      "app/native-addon.bin",
      "Keiko.exe",
      "runtime/native/keiko-runtime-supervisor.exe",
      "runtime/native/keiko-secure-workspace-read.exe",
      "runtime/node/node.exe",
      "runtime/sidecars/worker/worker.node",
    ]);
    expect(inventory.files.every((file) => /^[a-f0-9]{64}$/u.test(file.sha256))).toBe(true);
    expect(catalogForInventory(inventory)).toBe(
      [
        "payload/Keiko/app/native-addon.bin",
        "payload/Keiko/Keiko.exe",
        "payload/Keiko/runtime/native/keiko-runtime-supervisor.exe",
        "payload/Keiko/runtime/native/keiko-secure-workspace-read.exe",
        "payload/Keiko/runtime/node/node.exe",
        "payload/Keiko/runtime/sidecars/worker/worker.node",
        "",
      ].join("\n"),
    );
  });

  it("fails closed when a required launcher is absent or an exe/dll is not PE", () => {
    const missingLauncher = root();
    write(join(missingLauncher, "runtime", "node", "node.exe"));
    expect(() => inventoryWindowsPortablePeFiles(missingLauncher)).toThrow(
      /Keiko\.exe is missing/u,
    );

    const malformed = validPayload();
    write(join(malformed, "app", "unsigned.dll"), Buffer.from("not PE"));
    expect(() => inventoryWindowsPortablePeFiles(malformed)).toThrow(/not valid PE/u);

    const missingSupervisor = validPayload();
    rmSync(join(missingSupervisor, "runtime", "native", "keiko-runtime-supervisor.exe"));
    expect(() => inventoryWindowsPortablePeFiles(missingSupervisor)).toThrow(
      /runtime supervisor is missing/u,
    );
  });

  it("rejects links and hard links so one catalog path cannot alias another file", () => {
    const linked = validPayload();
    symlinkSync(join(linked, "Keiko.exe"), join(linked, "alias.exe"));
    expect(() => inventoryWindowsPortablePeFiles(linked)).toThrow(/link or reparse/u);

    const hardLinked = validPayload();
    linkSync(join(hardLinked, "Keiko.exe"), join(hardLinked, "alias.exe"));
    expect(() => inventoryWindowsPortablePeFiles(hardLinked)).toThrow(/hard-linked/u);
  });

  it("distinguishes path-set changes from expected signature byte changes", () => {
    const before = inventoryWindowsPortablePeFiles(validPayload());
    const after = JSON.parse(JSON.stringify(before));
    after.files[0].sha256 = "f".repeat(64);

    expect(inventoryPathsMatch(before, after)).toBe(true);
    expect(inventoriesMatch(before, after)).toBe(false);
    after.files.pop();
    expect(inventoryPathsMatch(before, after)).toBe(false);
  });

  it("allows exactly one bounded runtime attestation carrier after core qualification", () => {
    const before = inventoryWindowsPortablePeFiles(validPayload());
    const after = JSON.parse(JSON.stringify(before));
    after.files.push({
      relativePath: "runtime/native/keiko-runtime-attestation.exe",
      sha256: "f".repeat(64),
    });
    after.files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

    expect(inventoryAddsOnlyRuntimeAttestation(before, after)).toBe(true);
    after.files.push({
      relativePath: "runtime/native/unreviewed.exe",
      sha256: "e".repeat(64),
    });
    expect(inventoryAddsOnlyRuntimeAttestation(before, after)).toBe(false);
  });

  it("runs every bounded inventory comparison command through the executable dispatcher", async () => {
    const { payload, stage } = validStage();
    const inventoryPath = join(stage, "inventory.json");
    const catalogPath = join(stage, "catalog.txt");
    await main([
      "inventory",
      "--stage-root",
      stage,
      "--inventory",
      inventoryPath,
      "--catalog",
      catalogPath,
    ]);
    const expected = JSON.parse(readFileSync(inventoryPath, "utf8"));
    expect(readFileSync(catalogPath, "utf8")).toBe(catalogForInventory(expected));

    await expect(
      main(["verify-inventory", "--stage-root", stage, "--expected-inventory", inventoryPath]),
    ).resolves.toBeUndefined();

    const signedInventoryPath = join(stage, "signed-inventory.json");
    const signed = structuredClone(expected);
    signed.files[0].sha256 = "e".repeat(64);
    writeFileSync(signedInventoryPath, JSON.stringify(signed));
    await expect(
      main([
        "compare-paths",
        "--expected-inventory",
        inventoryPath,
        "--actual-inventory",
        signedInventoryPath,
      ]),
    ).resolves.toBeUndefined();

    write(join(payload, "runtime", "native", "keiko-runtime-attestation.exe"));
    const attestedInventoryPath = join(stage, "attested-inventory.json");
    writeFileSync(attestedInventoryPath, JSON.stringify(inventoryWindowsPortablePeFiles(payload)));
    await expect(
      main([
        "compare-with-attestation",
        "--expected-inventory",
        inventoryPath,
        "--actual-inventory",
        attestedInventoryPath,
      ]),
    ).resolves.toBeUndefined();
  });

  it("promotes a complete signed Windows payload and binds its activation manifest", async () => {
    const fixture = windowsPrepareStage();
    await expect(
      main([
        "prepare-qualified-payload",
        "--stage-root",
        fixture.stage,
        "--expected-inventory",
        fixture.inventoryPath,
        "--verification-input",
        fixture.verificationInputPath,
      ]),
    ).resolves.toBeUndefined();

    const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8"));
    expect(manifest.runtimeActivation.trustAnchor).toBe("authenticode-attestor");
    expect(manifest.security).toMatchObject({
      verificationPolicy: "production",
      verificationStatus: "verified-production",
      signatureVerified: true,
    });
    expect(
      manifest.nativeHelpers.every(
        (helper) => helper.signing.verificationStatus === "verified-production",
      ),
    ).toBe(true);
    expect(manifest.releaseImpact.reviewedBinding.sidecarRuntimes).toEqual(
      manifest.sidecarRuntimes,
    );
  });

  it("rejects a Windows payload without the complete native helper set", async () => {
    const fixture = windowsPrepareStage();
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8"));
    manifest.nativeHelpers.pop();
    writeFileSync(fixture.manifestPath, JSON.stringify(manifest));

    await expect(
      main([
        "prepare-qualified-payload",
        "--stage-root",
        fixture.stage,
        "--expected-inventory",
        fixture.inventoryPath,
        "--verification-input",
        fixture.verificationInputPath,
      ]),
    ).rejects.toThrow(/complete native helper set/u);
  });

  it("binds the exact Authenticode runtime attestation carrier into SBOM and review impact", () => {
    const fixture = windowsPrepareStage();
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8"));
    const carrierPath = join(
      fixture.stage,
      "payload",
      "Keiko",
      "runtime",
      "native",
      "keiko-runtime-attestation.exe",
    );
    const carrierBytes = portableExecutable(10);
    write(carrierPath, carrierBytes);

    bindRuntimeAttestation(fixture.stage, manifest);

    expect(manifest.runtimeAttestation).toMatchObject({
      shippedSha256: sha256(carrierBytes),
      sizeBytes: carrierBytes.length,
      signing: {
        signatureKind: "authenticode",
        verificationStatus: "verified-production",
      },
    });
    expect(manifest.releaseImpact.reviewedBinding.runtimeAttestation).toEqual(
      manifest.runtimeAttestation,
    );
    const sbom = JSON.parse(readFileSync(join(fixture.stage, "evidence", "sbom.cdx.json"), "utf8"));
    expect(
      sbom.components.find((component) => component.name === "keiko-runtime-attestation")?.hashes,
    ).toEqual([{ alg: "SHA-256", content: sha256(carrierBytes) }]);
  });

  it("rejects a missing or aliased Windows runtime attestation carrier", () => {
    const fixture = windowsPrepareStage();
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8"));
    manifest.runtimeAttestation.executablePath = "runtime/native/unbounded.exe";
    expect(() => bindRuntimeAttestation(fixture.stage, manifest)).toThrow(
      /runtime attestation carrier is missing/u,
    );

    manifest.runtimeAttestation.executablePath = "runtime/native/keiko-runtime-attestation.exe";
    symlinkSync(
      join(fixture.stage, "payload", "Keiko", "Keiko.exe"),
      join(fixture.stage, "payload", "Keiko", "runtime", "native", "keiko-runtime-attestation.exe"),
    );
    expect(() => bindRuntimeAttestation(fixture.stage, manifest)).toThrow(
      /runtime attestation carrier is invalid/u,
    );
  });

  it("rejects malformed inventory dispatch arguments and unexpected inventory drift", async () => {
    const { payload, stage } = validStage();
    const inventoryPath = join(stage, "inventory.json");
    writeFileSync(inventoryPath, JSON.stringify(inventoryWindowsPortablePeFiles(payload)));
    const changedPath = join(stage, "changed.json");
    const changed = JSON.parse(readFileSync(inventoryPath, "utf8"));
    changed.files.pop();
    writeFileSync(changedPath, JSON.stringify(changed));

    await expect(
      main([
        "compare-paths",
        "--expected-inventory",
        inventoryPath,
        "--actual-inventory",
        changedPath,
      ]),
    ).rejects.toThrow(/inventory changed/u);
    await expect(
      main([
        "compare-with-attestation",
        "--expected-inventory",
        inventoryPath,
        "--actual-inventory",
        changedPath,
      ]),
    ).rejects.toThrow(/outside the runtime attestation carrier/u);
    await expect(main(["inventory", "--stage-root"])).rejects.toThrow(/invalid command arguments/u);
    await expect(main(["unknown"])).rejects.toThrow(/command must be/u);
  });

  it("rebinds the signed archive, provenance, application tree, and checksum", async () => {
    const stage = root();
    const payload = join(stage, "payload", "Keiko");
    write(join(payload, "app", "index.js"), Buffer.from("signed app"));
    mkdirSync(join(stage, "evidence"), { recursive: true });
    writeFileSync(
      join(stage, "evidence", "provenance.intoto.jsonl"),
      `${JSON.stringify({ artifact: "Keiko-windows-x64.zip", subjectDigest: "0".repeat(64) })}\n`,
    );
    const manifest = {
      artifact: { assetName: "Keiko-windows-x64.zip", sha256: "0".repeat(64), sizeBytes: 0 },
      provenance: {
        packagedAppTreeSha256: "0".repeat(64),
        provenanceStatementSha256: "0".repeat(64),
      },
      releaseImpact: { reviewedBinding: {} },
    };

    await rebindArchive(stage, manifest, {
      create(_sourceRoot, _entryName, archivePath) {
        writeFileSync(archivePath, "signed archive fixture");
      },
    });

    expect(manifest.artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(manifest.artifact.sha256).not.toBe("0".repeat(64));
    expect(manifest.provenance.packagedAppTreeSha256).not.toBe("0".repeat(64));
    expect(manifest.releaseImpact.reviewedBinding.archiveSha256).toBe(manifest.artifact.sha256);
  });

  it("rebinds signed sidecar bytes through SBOM, payload, archive, provenance, and review impact", async () => {
    const stage = root();
    const payload = join(stage, "payload", "Keiko");
    const sidecarRoot = join(payload, "runtime", "sidecars", "worker");
    const executablePath = join(sidecarRoot, "bin", "worker.exe");
    const sbomPath = join(sidecarRoot, "evidence", "sbom.cdx.json");
    const unsignedBytes = portableExecutable(3);
    const signedBytes = Buffer.concat([portableExecutable(9), Buffer.from("native-signature")]);
    write(join(payload, "app", "index.js"), Buffer.from("signed app"));
    write(executablePath, unsignedBytes);
    write(
      sbomPath,
      `${JSON.stringify({
        bomFormat: "CycloneDX",
        metadata: { component: { name: "worker", version: "1.2.3" } },
        components: [
          {
            name: "worker-upstream",
            version: "1.2.3",
            purl: "pkg:github/example/worker@v1.2.3",
            licenses: [{ license: { id: "MIT" } }],
            hashes: [{ alg: "SHA-256", content: sha256(unsignedBytes) }],
            externalReferences: [
              {
                type: "distribution",
                url: "https://github.com/example/worker/releases/download/v1.2.3/worker.zip",
                hashes: [{ alg: "SHA-256", content: "a".repeat(64) }],
              },
            ],
          },
        ],
      })}\n`,
    );
    const upstreamTreeSha256 = createHash("sha256")
      .update(`bin/worker.exe\0${sha256(unsignedBytes)}\0`)
      .digest("hex");
    const sidecar = {
      name: "worker",
      upstream: {
        owner: "example",
        repository: "worker",
        name: "worker-upstream",
        version: "1.2.3",
        tag: "v1.2.3",
      },
      license: { spdxId: "MIT" },
      archive: {
        url: "https://github.com/example/worker/releases/download/v1.2.3/worker.zip",
        sha256: "a".repeat(64),
      },
      executablePath: "runtime/sidecars/worker/bin/worker.exe",
      executableSha256: sha256(unsignedBytes),
      executableTreeAlgorithm: "keiko-directory-tree-sha256-v1",
      executableTreeSha256: upstreamTreeSha256,
      payloadRootPath: "runtime/sidecars/worker",
      payloadSha256: "0".repeat(64),
      sizeBytes: 0,
      sbomEvidence: {
        path: "runtime/sidecars/worker/evidence/sbom.cdx.json",
        sha256: "0".repeat(64),
      },
      signing: {},
    };
    const manifest = {
      artifact: { assetName: "keiko-windows-x64.zip", sha256: "0".repeat(64), sizeBytes: 0 },
      provenance: {
        packagedAppTreeSha256: "0".repeat(64),
        provenanceStatementSha256: "0".repeat(64),
      },
      sidecarRuntimes: [sidecar],
      releaseImpact: { reviewedBinding: { sidecarRuntimes: [] } },
    };
    mkdirSync(join(stage, "evidence"), { recursive: true });
    writeFileSync(
      join(stage, "evidence", "provenance.intoto.jsonl"),
      `${JSON.stringify({ subjectDigest: "0".repeat(64) })}\n`,
    );
    write(executablePath, signedBytes);
    const create = vi.fn((_sourceRoot, _entryName, archivePath) => {
      writeFileSync(
        archivePath,
        Buffer.concat([readFileSync(executablePath), readFileSync(sbomPath)]),
      );
    });

    await rebindArchive(stage, manifest, { create });

    const shippedSha256 = sha256(signedBytes);
    const sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
    expect(create).toHaveBeenCalledWith(
      join(stage, "payload"),
      "Keiko",
      join(stage, manifest.artifact.assetName),
    );
    expect(sidecar.executableSha256).toBe(sha256(unsignedBytes));
    expect(sidecar.executableTreeSha256).toBe(upstreamTreeSha256);
    expect(sidecar.signing.shippedExecutableSha256).toBe(shippedSha256);
    expect(sidecar.signing.shippedExecutableTreeSha256).toBe(
      createHash("sha256").update(`bin/worker.exe\0${shippedSha256}\0`).digest("hex"),
    );
    expect(sbom.components[0].hashes).toEqual([{ alg: "SHA-256", content: shippedSha256 }]);
    expect(sidecar.sbomEvidence.sha256).toBe(sha256(readFileSync(sbomPath)));
    expect(sidecar.payloadSha256).toBe(hashDirectoryTree(sidecarRoot));
    expect(manifest.releaseImpact.reviewedBinding.sidecarRuntimes).toEqual([sidecar]);
  });

  it("redacts unexpected filesystem failures at the executable boundary", () => {
    const privatePath = join(root(), "private-missing-stage");
    const result = spawnSync(
      process.execPath,
      [
        "scripts/windows-portable-signing.mjs",
        "inventory",
        "--stage-root",
        privatePath,
        "--inventory",
        join(root(), "inventory.json"),
        "--catalog",
        join(root(), "catalog.txt"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("windows-portable-signing: payload root is missing");
    expect(result.stderr).not.toContain(privatePath);
  });

  it("blocks false, missing, or incomplete finalizer inputs before production promotion", () => {
    const dir = root();
    const manifest = {
      artifact: { platformTarget: "windows-x64" },
      sidecarRuntimes: [{ name: "worker", platformTarget: "windows-x64" }],
    };
    const writeInput = (name, input) => {
      const path = join(dir, `${name}.json`);
      writeFileSync(path, JSON.stringify(input));
      return path;
    };
    const verified = {
      peInventorySha256: "a".repeat(64),
      reasonCodes: [],
      verificationChecks: { publisherChainVerified: true, timestampVerified: true },
      sidecarRuntimes: [
        {
          name: "worker",
          payloadSha256: "b".repeat(64),
          verificationChecks: { publisherChainVerified: true, timestampVerified: true },
        },
      ],
    };
    expect(() =>
      assertWindowsProductionVerificationInput(writeInput("verified", verified), manifest),
    ).not.toThrow();
    expect(() => assertWindowsProductionVerificationInput(undefined, manifest)).toThrow(
      /did not succeed/u,
    );
    expect(() =>
      assertWindowsProductionVerificationInput(
        writeInput("false", {
          ...verified,
          verificationChecks: { publisherChainVerified: false, timestampVerified: true },
        }),
        manifest,
      ),
    ).toThrow(/did not succeed/u);
    expect(() =>
      assertWindowsProductionVerificationInput(
        writeInput("incomplete", { ...verified, sidecarRuntimes: [] }),
        manifest,
      ),
    ).toThrow(/sidecar verification input is incomplete/u);
    const sidecar = verified.sidecarRuntimes[0];
    const malformed = [
      { ...verified, rawLog: "provider output" },
      { ...verified, reasonCodes: { length: 0 } },
      {
        ...verified,
        verificationChecks: { ...verified.verificationChecks, callerApproved: true },
      },
      { ...verified, verificationChecks: { publisherChainVerified: true } },
      { ...verified, sidecarRuntimes: [{ ...sidecar, rawPath: "private" }] },
      { ...verified, sidecarRuntimes: [sidecar, sidecar] },
      { ...verified, sidecarRuntimes: [{ ...sidecar, name: "unknown" }] },
      { ...verified, reasonCodes: ["token=ghp_abcdefghijklmnopqrstuvwxyz123456"] },
    ];
    for (const [index, input] of malformed.entries()) {
      expect(() =>
        assertWindowsProductionVerificationInput(
          writeInput(`malformed-${String(index)}`, input),
          manifest,
        ),
      ).toThrow();
    }
  });

  it("leaves every finalizer-owned byte unchanged when canonical input parsing rejects", async () => {
    const stage = root();
    const payload = join(stage, "payload", "Keiko");
    write(join(payload, "Keiko.exe"), portableExecutable(1));
    write(join(payload, "runtime", "node", "node.exe"), portableExecutable(2));
    write(
      join(payload, "runtime", "native", "keiko-secure-workspace-read.exe"),
      portableExecutable(3),
    );
    write(
      join(payload, "runtime", "native", "keiko-runtime-supervisor.exe"),
      portableExecutable(4),
    );
    const manifestPath = join(stage, "manifest", "portable-manifest.json");
    const archivePath = join(stage, "Keiko-windows-x64.zip");
    const provenancePath = join(stage, "evidence", "provenance.intoto.jsonl");
    const checksumPath = join(stage, "evidence", "SHA256SUMS.txt");
    const summaryPath = join(stage, "evidence", "signing-verification.json");
    mkdirSync(join(stage, "manifest"), { recursive: true });
    mkdirSync(join(stage, "evidence"), { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify({
        artifact: { platformTarget: "windows-x64", assetName: "Keiko-windows-x64.zip" },
      }),
    );
    writeFileSync(archivePath, "archive-before");
    writeFileSync(provenancePath, "provenance-before");
    writeFileSync(checksumPath, "checksums-before");
    writeFileSync(summaryPath, "summary-before");
    const inventoryPath = join(stage, "inventory.json");
    writeFileSync(inventoryPath, JSON.stringify(inventoryWindowsPortablePeFiles(payload)));
    const malformedPath = join(stage, "malformed.json");
    writeFileSync(
      malformedPath,
      JSON.stringify({
        rawLog: "/private/provider/output",
        reasonCodes: { length: 0 },
        verificationChecks: { publisherChainVerified: true, timestampVerified: true },
      }),
    );
    const paths = [archivePath, manifestPath, provenancePath, checksumPath, summaryPath];
    const before = paths.map((path) => readFileSync(path));

    await expect(
      main([
        "finalize",
        "--stage-root",
        stage,
        "--expected-inventory",
        inventoryPath,
        "--verification-input",
        malformedPath,
      ]),
    ).rejects.toThrow(/verification input contains unsupported keys/u);

    expect(paths.map((path) => readFileSync(path))).toEqual(before);
  });
});
