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
  catalogForInventory,
  inventoriesMatch,
  inventoryPathsMatch,
  inventoryWindowsPortablePeFiles,
  main,
  rebindArchive,
} from "../windows-portable-signing.mjs";
import { assertWindowsProductionVerificationInput } from "../windows-portable-verification-input.mjs";
import { hashDirectoryTree } from "../portable-runtime.mjs";

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

function validPayload() {
  const payload = root();
  write(join(payload, "Keiko.exe"), portableExecutable(1));
  write(join(payload, "runtime", "node", "node.exe"), portableExecutable(2));
  write(join(payload, "runtime", "sidecars", "worker", "worker.node"), portableExecutable(3));
  write(join(payload, "app", "native-addon.bin"), portableExecutable(4));
  write(join(payload, "app", "README.md"), Buffer.from("not executable"));
  return payload;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("Windows portable PE signing inventory", () => {
  it("finds every PE by content, including non-exe runtime files, in deterministic order", () => {
    const inventory = inventoryWindowsPortablePeFiles(validPayload());

    expect(inventory.files.map((file) => file.relativePath)).toEqual([
      "app/native-addon.bin",
      "Keiko.exe",
      "runtime/node/node.exe",
      "runtime/sidecars/worker/worker.node",
    ]);
    expect(inventory.files.every((file) => /^[a-f0-9]{64}$/u.test(file.sha256))).toBe(true);
    expect(catalogForInventory(inventory)).toBe(
      [
        "payload/Keiko/app/native-addon.bin",
        "payload/Keiko/Keiko.exe",
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
      reasonCodes: [],
      verificationChecks: { publisherChainVerified: true, timestampVerified: true },
      sidecarRuntimes: [
        {
          name: "worker",
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
