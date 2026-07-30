import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeQualificationReceipt } from "@oscharko-dev/keiko-sandbox";

import { verifyPortableAttestedSidecars } from "../update-portable-sidecar-verification.js";
import { inspectStagedSidecarPayload } from "../update-portable-sidecar-staging-verification.js";
import { discoverQualifiedPortableOpenCode } from "./productionPortableCodingRuntime.js";

const TARGET = "windows-x64";
const COMMIT = "c".repeat(40);
const SIDECAR_ROOT = "runtime/sidecars/opencode-compatible";
const SUPERVISOR = "qualified native supervisor";
const SECURE_READ = "qualified secure read";

describe("production portable OpenCode discovery", () => {
  it("discovers only a disk-verified sidecar with a signed exact-byte attestation", () => {
    const root = portableInstall();
    const activation = JSON.parse(
      readFileSync(join(root, ".portable", "runtime-activation.json"), "utf8"),
    ) as Record<string, unknown>;
    const sidecar = verifyPortableAttestedSidecars(activation, TARGET).sidecars[0];
    expect(sidecar).toBeDefined();
    if (sidecar === undefined) return;
    expect(inspectStagedSidecarPayload(root, sidecar)).toEqual({
      payloadPresent: true,
      archiveDigestVerified: true,
      executableTreeDigestVerified: true,
    });
    expect(discover(root)).toMatchObject({
      installRoot: realpathSync(root),
      target: TARGET,
      sidecar: { summary: { name: "opencode-compatible" } },
      qualification: { backend: "windows-job-object" },
    });
  });

  it.each(["stale-attestation", "sidecar-drift", "helper-drift", "unsupported-host"] as const)(
    "fails closed for %s",
    (scenario) => {
      const root = portableInstall();
      if (scenario === "sidecar-drift") {
        writeFileSync(join(root, SIDECAR_ROOT, "opencode.cmd"), "drifted", "utf8");
      }
      if (scenario === "helper-drift") {
        writeFileSync(
          join(root, "runtime", "native", "keiko-runtime-supervisor.exe"),
          "drifted",
          "utf8",
        );
      }
      const result =
        scenario === "unsupported-host"
          ? discoverQualifiedPortableOpenCode({
              env: {},
              installRoot: root,
              platform: "linux",
              arch: "x64",
              attestation: attestation(root),
            })
          : discover(root, scenario === "stale-attestation");
      expect(result).toBeUndefined();
    },
  );

  it("does not treat ambient PATH or an arbitrary executable as an installed runtime", () => {
    expect(
      discoverQualifiedPortableOpenCode({
        env: { PATH: "/attacker/bin", OPENCODE_BIN: "/attacker/opencode" },
        platform: "win32",
        arch: "x64",
      }),
    ).toBeUndefined();
  });

  it.each(["missing-portable-marker", "missing-install-root"] as const)(
    "treats an absent portable installation (%s) as silent not-found without a diagnostic",
    (scenario) => {
      const records: unknown[] = [];
      const empty = mkdtempSync(join(tmpdir(), "keiko-portable-absent-"));
      const installRoot =
        scenario === "missing-install-root" ? join(empty, "never-installed") : empty;

      expect(
        discoverQualifiedPortableOpenCode({
          env: {},
          installRoot,
          platform: "win32",
          arch: "x64",
          diagnostics: { record: (record): void => void records.push(record) },
        }),
      ).toBeUndefined();
      expect(records).toEqual([]);
    },
  );

  it.each(["activation-missing", "setup-manifest-corrupt", "setup-manifest-unreadable"] as const)(
    "still emits the corruption diagnostic for a present installation with %s",
    (scenario) => {
      const records: unknown[] = [];
      const root = portableInstall();
      const marker = join(root, ".portable", "setup-manifest.json");
      if (scenario === "activation-missing") {
        rmSync(join(root, ".portable", "runtime-activation.json"));
      } else if (scenario === "setup-manifest-corrupt") {
        writeFileSync(marker, "{", "utf8");
      } else {
        rmSync(marker);
        mkdirSync(marker);
      }

      expect(
        discoverQualifiedPortableOpenCode({
          env: {},
          installRoot: root,
          platform: "win32",
          arch: "x64",
          diagnostics: { record: (record): void => void records.push(record) },
          attestation: attestation(root),
        }),
      ).toBeUndefined();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        operation: "coding.runtime.discover",
        source: "coding.runtime.discovery",
      });
    },
  );

  it("emits one body-free diagnostic when discovery fails unexpectedly", () => {
    const records: unknown[] = [];
    const root = portableInstall();

    expect(
      discoverQualifiedPortableOpenCode({
        env: {},
        installRoot: root,
        platform: "win32",
        arch: "x64",
        diagnostics: { record: (record): void => void records.push(record) },
        attestation: {
          readReceipt: () => {
            throw new Error("customer-secret-value");
          },
        },
      }),
    ).toBeUndefined();
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain("customer-secret-value");
    expect(records[0]).toMatchObject({
      operation: "coding.runtime.discover",
      source: "coding.runtime.discovery",
      errorClass: "Error",
    });
  });
});

function discover(
  root: string,
  stale = false,
): ReturnType<typeof discoverQualifiedPortableOpenCode> {
  return discoverQualifiedPortableOpenCode({
    env: {},
    installRoot: root,
    platform: "win32",
    arch: "x64",
    attestation: attestation(root, stale),
  });
}

function attestation(
  root: string,
  stale = false,
): NonNullable<Parameters<typeof discoverQualifiedPortableOpenCode>[0]["attestation"]> {
  return {
    readReceipt: (): RuntimeQualificationReceipt => {
      const activationPath = join(root, ".portable", "runtime-activation.json");
      const activation = JSON.parse(readFileSync(activationPath, "utf8")) as {
        sidecarRuntimes: readonly { name: string; payloadSha256: string }[];
      };
      return {
        schemaVersion: 1,
        suiteVersion: "runtime-tree-qualification-v1",
        platformTarget: TARGET,
        sourceCommitSha: stale ? "e".repeat(40) : COMMIT,
        activationManifestSha256: sha256(readFileSync(activationPath)),
        supervisorSha256: sha256(SUPERVISOR),
        secureReadSha256: sha256(SECURE_READ),
        sidecars: activation.sidecarRuntimes.map((sidecar) => ({
          name: sidecar.name,
          sha256: sidecar.payloadSha256,
        })),
        backend: "windows-job-object",
        result: "passed",
      };
    },
  };
}

function portableInstall(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-portable-runtime-"));
  const sidecar = sidecarFixture();
  mkdirSync(join(root, ".portable"), { recursive: true });
  mkdirSync(join(root, "runtime", "native"), { recursive: true });
  writeFileSync(join(root, "runtime", "native", "keiko-runtime-supervisor.exe"), SUPERVISOR);
  writeFileSync(join(root, "runtime", "native", "keiko-secure-workspace-read.exe"), SECURE_READ);
  writeFileSync(
    join(root, ".portable", "setup-manifest.json"),
    JSON.stringify({ platformTarget: TARGET, stable: true }),
  );
  for (const [path, bytes] of Object.entries(sidecar.files)) {
    const destination = join(root, SIDECAR_ROOT, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
  writeFileSync(
    join(root, ".portable", "runtime-activation.json"),
    JSON.stringify(runtimeActivation(sidecar.runtime)),
  );
  return root;
}

function sidecarFixture(): {
  readonly runtime: Record<string, unknown>;
  readonly files: Readonly<Record<string, string>>;
  readonly payloadSha256: string;
} {
  const files = {
    "LICENSE.txt": "sidecar license",
    "evidence/sbom.cdx.json": '{"bomFormat":"CycloneDX"}',
    "opencode.cmd": "@echo off\r\n",
  } as const;
  const payload = createHash("sha256");
  for (const [path, bytes] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    payload.update(`${path}\0${sha256(bytes)}\0`);
  }
  const payloadSha256 = payload.digest("hex");
  const executableSha256 = sha256(files["opencode.cmd"]);
  return {
    files,
    payloadSha256,
    runtime: {
      approvalSchemaVersion: 2,
      name: "opencode-compatible",
      kind: "coding-runtime",
      upstream: {
        owner: "anomalyco",
        repository: "opencode",
        name: "opencode",
        version: "1.17.17",
        tag: "v1.17.17",
        commit: "474abdd7ee60f4b67476cfcef7e5311beff4a824",
      },
      adapterCompatibility: {
        adapterName: "keiko-coding-sidecar",
        adapterVersion: "1",
        transport: "http-sse",
      },
      protocolSchema: {
        path: "packages/sdk/openapi.json",
        sha256: "7db5cc3bb494b4757655110f2f285b1e70fa586fb5ae2327ffb31d4f0254c7de",
        hashAlgorithm: "sha256",
        hashEncoding: "lowercase-hex",
        digestInput: "upstream-raw-bytes",
        transport: "http-sse",
      },
      releaseApproval: { redistribution: { status: "approved" } },
      archive: { platformTarget: TARGET, sha256: "d".repeat(64) },
      executableTreeAlgorithm: "keiko-directory-tree-sha256-v1",
      executableTreeSha256: "f".repeat(64),
      platformTarget: TARGET,
      payloadRootPath: SIDECAR_ROOT,
      executablePath: `${SIDECAR_ROOT}/opencode.cmd`,
      payloadSha256,
      sizeBytes: Object.values(files).reduce((sum, bytes) => sum + Buffer.byteLength(bytes), 0),
      licenseEvidence: {
        path: `${SIDECAR_ROOT}/LICENSE.txt`,
        sha256: sha256(files["LICENSE.txt"]),
      },
      sbomEvidence: {
        path: `${SIDECAR_ROOT}/evidence/sbom.cdx.json`,
        sha256: sha256(files["evidence/sbom.cdx.json"]),
      },
      signing: {
        verificationPolicy: "production",
        verificationStatus: "verified-production",
        verificationReasonCodes: [],
        signatureKind: "authenticode",
        signatureVerified: true,
        notarizationRequired: false,
        notarizationVerified: false,
        verificationChecks: { publisherChainVerified: true, timestampVerified: true },
        shippedExecutableSha256: executableSha256,
        shippedExecutableTreeAlgorithm: "keiko-directory-tree-sha256-v1",
        shippedExecutableTreeSha256: sha256(`opencode.cmd\0${executableSha256}\0`),
      },
    },
  };
}

function runtimeActivation(runtime: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    suiteVersion: "runtime-tree-qualification-v1",
    product: { packageName: "@oscharko-dev/keiko", packageVersion: "0.2.15" },
    sourceCommitSha: COMMIT,
    platformTarget: TARGET,
    runtime: { nodePlatform: "win32", nodeArchitecture: "x64" },
    nativeHelpers: [
      nativeHelper("keiko-secure-workspace-read", SECURE_READ),
      nativeHelper("keiko-runtime-supervisor", SUPERVISOR),
    ],
    sidecarRuntimes: [runtime],
  };
}

function nativeHelper(name: string, bytes: string): Record<string, unknown> {
  return {
    name,
    platformTarget: TARGET,
    executablePath: `runtime/native/${name}.exe`,
    shippedSha256: sha256(bytes),
    sizeBytes: Buffer.byteLength(bytes),
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
