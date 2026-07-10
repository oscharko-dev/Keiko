import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
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
import { afterEach, describe, expect, it } from "vitest";

import {
  catalogForInventory,
  inventoriesMatch,
  inventoryPathsMatch,
  inventoryWindowsPortablePeFiles,
  main,
  rebindArchive,
} from "../windows-portable-signing.mjs";
import { assertWindowsProductionVerificationInput } from "../windows-portable-verification-input.mjs";

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

  it("rebinds the signed archive, provenance, application tree, sidecar tree, and checksum", async () => {
    const stage = root();
    const payload = join(stage, "payload", "Keiko");
    write(join(payload, "app", "index.js"), Buffer.from("signed app"));
    write(join(payload, "runtime", "sidecars", "worker", "worker.exe"), portableExecutable(8));
    mkdirSync(join(stage, "evidence"), { recursive: true });
    writeFileSync(
      join(stage, "evidence", "provenance.intoto.jsonl"),
      `${JSON.stringify({ artifact: "Keiko-windows-x64.zip", subjectDigest: "0".repeat(64) })}\n`,
    );
    const sidecar = {
      name: "worker",
      payloadRootPath: "runtime/sidecars/worker",
      payloadSha256: "0".repeat(64),
      sizeBytes: 0,
    };
    const manifest = {
      artifact: { assetName: "Keiko-windows-x64.zip", sha256: "0".repeat(64), sizeBytes: 0 },
      provenance: {
        packagedAppTreeSha256: "0".repeat(64),
        provenanceStatementSha256: "0".repeat(64),
      },
      sidecarRuntimes: [sidecar],
      releaseImpact: { reviewedBinding: { sidecarRuntimes: [] } },
    };

    await rebindArchive(stage, manifest);

    expect(manifest.artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(manifest.artifact.sha256).not.toBe("0".repeat(64));
    expect(manifest.provenance.packagedAppTreeSha256).not.toBe("0".repeat(64));
    expect(sidecar.payloadSha256).not.toBe("0".repeat(64));
    expect(manifest.releaseImpact.reviewedBinding.archiveSha256).toBe(manifest.artifact.sha256);
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
    ).rejects.toThrow(/unsupported verification input key/u);

    expect(paths.map((path) => readFileSync(path))).toEqual(before);
  });
});
