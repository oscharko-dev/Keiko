import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts";
import type { RuntimeQualificationReceipt } from "@oscharko-dev/keiko-sandbox";

import { verifyPortableAttestedSidecars } from "../update-portable-sidecar-verification.js";
import { inspectStagedSidecarPayload } from "../update-portable-sidecar-staging-verification.js";
import {
  discoverQualifiedPortableOpenCode,
  portableInstallCarriesReleaseSignature,
} from "./productionPortableCodingRuntime.js";

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

  it.each([
    "activation-missing",
    "setup-manifest-corrupt",
    "setup-manifest-unreadable",
    // #2843 review: a marker holding valid JSON that is not an object, and a `.portable` path that
    // exists but is a regular file (ENOTDIR), are MALFORMED installations — not absences.
    "setup-manifest-null",
    "setup-manifest-array",
    "portable-dir-is-a-file",
  ] as const)(
    "still emits the corruption diagnostic for a present installation with %s",
    (scenario) => {
      const records: unknown[] = [];
      const root = portableInstall();
      const marker = join(root, ".portable", "setup-manifest.json");
      if (scenario === "activation-missing") {
        rmSync(join(root, ".portable", "runtime-activation.json"));
      } else if (scenario === "setup-manifest-corrupt") {
        writeFileSync(marker, "{", "utf8");
      } else if (scenario === "setup-manifest-unreadable") {
        rmSync(marker);
        mkdirSync(marker);
      } else if (scenario === "setup-manifest-null") {
        writeFileSync(marker, "null", "utf8");
      } else if (scenario === "setup-manifest-array") {
        writeFileSync(marker, "[]", "utf8");
      } else {
        rmSync(join(root, ".portable"), { recursive: true, force: true });
        writeFileSync(join(root, ".portable"), "not a directory", "utf8");
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

/**
 * ADR-0163 D9. The declared evaluation lane activates WITHOUT any platform attestation, and the
 * attestation port is never consulted — `refusingAttestation` throws if it is reached, so this is
 * a structural-skip proof, not a tolerate-the-failure one. Every other integrity predicate stays
 * exactly as strict, which the adversarial suite below asserts one mutation at a time.
 */
describe("packaged evaluation lane", () => {
  it("refuses the evaluation lane on an install that carries a release signature", () => {
    // The lane downgrade this guards: the declaration lives in .portable/runtime-activation.json,
    // inside the resource root, and honouring it is what turns the platform seal off. Without this
    // refusal, anyone able to rewrite that one file on a SIGNED install could switch off the very
    // codesign/Authenticode check that would have detected the rewrite, and every surviving
    // predicate would still pass because they are all recomputed against that same manifest.
    const root = portableInstall("evaluation");
    // A real install always ships the launcher; the fixture does not, and without signable code
    // there is nothing to downgrade FROM.
    writeFileSync(join(root, "Keiko.exe"), "launcher");

    const runtime = discoverQualifiedPortableOpenCode({
      env: {},
      installRoot: root,
      platform: "win32",
      arch: "x64",
      // Stands for a release-signed launcher: the Authenticode probe yields a signer thumbprint.
      // An unsigned one yields none, which is why an evaluation build is unaffected. (The macOS
      // half of the same guard reads `codesign -d`, where a signed bundle reports a real
      // TeamIdentifier and the shipped unsigned artifact reports "not set" — measured.)
      commandRunner: () => ({ status: 0, stdout: `${"A".repeat(40)}\n`, stderr: "" }),
      attestation: {
        readReceipt: (): never => {
          throw new Error("discovery must refuse before reaching platform attestation");
        },
      },
    });

    expect(runtime).toBeUndefined();
  });

  it("answers the public release-signature probe with the launch surface's fail-closed contract", () => {
    // The portable launcher waives macOS containment activation only on this probe's "false" —
    // an install the platform reports as unsigned. Its fail-closed direction must match the lane
    // guard exactly: a probe that cannot answer counts as signed.
    const root = portableInstall("evaluation");
    expect(
      portableInstallCarriesReleaseSignature(root, TARGET, () => ({
        status: 0,
        stdout: `${"A".repeat(40)}\n`,
        stderr: "",
      })),
    ).toBe(false); // no launcher on disk: nothing to downgrade from

    writeFileSync(join(root, "Keiko.exe"), "launcher");
    expect(
      portableInstallCarriesReleaseSignature(root, TARGET, () => ({
        status: 0,
        stdout: `${"A".repeat(40)}\n`,
        stderr: "",
      })),
    ).toBe(true); // signer thumbprint present: release-signed
    expect(
      portableInstallCarriesReleaseSignature(root, TARGET, () => ({
        status: 0,
        stdout: "",
        stderr: "",
      })),
    ).toBe(false); // platform reports no signer: unsigned
    expect(
      portableInstallCarriesReleaseSignature(root, TARGET, () => {
        throw new Error("probe unavailable");
      }),
    ).toBe(true); // probe failure on present code: fail closed toward "signed"
  });

  it("still activates the evaluation lane when the install carries no release signature", () => {
    const root = portableInstall("evaluation");
    writeFileSync(join(root, "Keiko.exe"), "launcher");

    const runtime = discoverQualifiedPortableOpenCode({
      env: {},
      installRoot: root,
      platform: "win32",
      arch: "x64",
      commandRunner: () => ({ status: 0, stdout: "", stderr: "" }),
      attestation: {
        readReceipt: (): never => {
          throw new Error("platform attestation must not run on the evaluation lane");
        },
      },
    });

    expect(runtime).toMatchObject({ platformAssurance: "evaluation-unqualified" });
  });

  it("activates a declared evaluation artifact without any platform attestation", () => {
    const root = portableInstall("evaluation");

    const runtime = discoverEvaluation(root);

    expect(runtime).toMatchObject({
      installRoot: realpathSync(root),
      target: TARGET,
      platformAssurance: "evaluation-unqualified",
      sidecar: { summary: { name: "opencode-compatible" } },
      qualification: { platform: "win32", arch: "x64", backend: "windows-job-object" },
    });
    expect(runtime?.qualification.releaseReceipt).toMatch(/^sha256:[a-f0-9]{64}$/u);
    // The honest availability record travels with the verification to every downstream consumer.
    expect(runtime?.sidecar.availability).toMatchObject({
      signatureVerified: false,
      qualificationVerified: false,
      archiveDigestVerified: true,
      executableTreeDigestVerified: true,
    });
  });

  it("still reports release-qualified for a production artifact", () => {
    expect(discover(portableInstall())).toMatchObject({
      platformAssurance: "release-qualified",
    });
  });

  // A plain staging artifact is the default output of `stage-portable-runtime.mjs`. It must stay
  // refused, before and after the lane exists — nothing is promoted by accident.
  it.each(["staging"] as const)("refuses a plain %s artifact", (lane) => {
    const root = portableInstall(lane);
    expect(discoverEvaluation(root)).toBeUndefined();
    expect(discover(root)).toBeUndefined();
  });

  // The lane is ONE coherent artifact-wide declaration, never a per-block waiver.
  it.each([
    [
      "security declares evaluation while the sidecar declares production",
      (activation: FixtureActivation): void => {
        activation.security = laneSecurity("evaluation");
        activation.sidecarRuntimes[0].signing = {
          ...activation.sidecarRuntimes[0].signing,
          ...laneSecurity("production"),
        };
      },
    ],
    [
      "security declares production while the sidecar declares evaluation",
      (activation: FixtureActivation): void => {
        activation.security = laneSecurity("production");
        activation.sidecarRuntimes[0].signing = {
          ...activation.sidecarRuntimes[0].signing,
          ...laneSecurity("evaluation"),
        };
      },
    ],
    [
      "a native helper declares the other lane",
      (activation: FixtureActivation): void => {
        activation.nativeHelpers[0].signing = laneHelperSigning("production");
      },
    ],
    [
      "a native helper carries no signing block at all",
      (activation: FixtureActivation): void => {
        delete activation.nativeHelpers[1].signing;
      },
    ],
    [
      "the security block is absent",
      (activation: FixtureActivation): void => {
        delete activation.security;
      },
    ],
  ])("refuses a mixed declaration: %s", (_name, mutate) => {
    const root = portableInstall("evaluation");
    mutateActivation(root, mutate);
    expect(discoverEvaluation(root)).toBeUndefined();
  });

  // EVERY integrity check the owner listed as NOT waived, one mutation at a time.
  it.each([
    [
      "one byte flipped in the sidecar executable",
      (root: string): void => {
        writeFileSync(join(root, SIDECAR_ROOT, "opencode.cmd"), "@echo off\r\r");
      },
    ],
    [
      "an extra file added under the sidecar payload root",
      (root: string): void => {
        writeFileSync(join(root, SIDECAR_ROOT, "smuggled.txt"), "extra");
      },
    ],
    [
      "the license evidence mutated",
      (root: string): void => {
        writeFileSync(join(root, SIDECAR_ROOT, "LICENSE.txt"), "tampered license");
      },
    ],
    [
      "the SBOM evidence mutated",
      (root: string): void => {
        writeFileSync(join(root, SIDECAR_ROOT, "evidence", "sbom.cdx.json"), "{}");
      },
    ],
    [
      "the supervisor helper bytes drifted",
      (root: string): void => {
        writeFileSync(join(root, "runtime", "native", "keiko-runtime-supervisor.exe"), "drifted");
      },
    ],
    [
      "the secure-read helper bytes drifted",
      (root: string): void => {
        writeFileSync(
          join(root, "runtime", "native", "keiko-secure-workspace-read.exe"),
          "drifted!!",
        );
      },
    ],
  ])("refuses an evaluation artifact with %s", (_name, tamper) => {
    const root = portableInstall("evaluation");
    tamper(root);
    expect(discoverEvaluation(root)).toBeUndefined();
  });

  it.each([
    // Discovery rejects a malformed sizeBytes; it does NOT recompute the declared byte count from
    // disk, because the payload tree digest already binds the bytes exactly (an off-by-one payload
    // is caught by the "one byte flipped" and "extra file" cases above). The declared value's own
    // correctness is a producer-schema obligation (validateSidecarPayload), pinned in
    // scripts/__tests__/portable-runtime.test.mjs.
    [
      "a zero sizeBytes",
      (activation: FixtureActivation): void => {
        activation.sidecarRuntimes[0].sizeBytes = 0;
      },
    ],
    [
      "a negative sizeBytes",
      (activation: FixtureActivation): void => {
        activation.sidecarRuntimes[0].sizeBytes = -1;
      },
    ],
    [
      "a non-integer sizeBytes",
      (activation: FixtureActivation): void => {
        activation.sidecarRuntimes[0].sizeBytes = 12.5;
      },
    ],
    [
      "a payloadRootPath that is not the sidecar's own root",
      (activation: FixtureActivation): void => {
        activation.sidecarRuntimes[0].payloadRootPath = "runtime/sidecars/other";
      },
    ],
    [
      "an executablePath resolved outside the payload root",
      (activation: FixtureActivation): void => {
        activation.sidecarRuntimes[0].executablePath = "runtime/native/opencode.cmd";
      },
    ],
    [
      "a foreign shipped executable tree algorithm",
      (activation: FixtureActivation): void => {
        activation.sidecarRuntimes[0].signing = {
          ...activation.sidecarRuntimes[0].signing,
          shippedExecutableTreeAlgorithm: "sha256",
        };
      },
    ],
    [
      "an absent shipped executable digest",
      (activation: FixtureActivation): void => {
        const signing = { ...activation.sidecarRuntimes[0].signing };
        delete signing.shippedExecutableSha256;
        activation.sidecarRuntimes[0].signing = signing;
      },
    ],
    [
      "a non-hex shipped executable digest",
      (activation: FixtureActivation): void => {
        activation.sidecarRuntimes[0].signing = {
          ...activation.sidecarRuntimes[0].signing,
          shippedExecutableSha256: "not-a-digest",
        };
      },
    ],
    [
      "a drifted payloadSha256",
      (activation: FixtureActivation): void => {
        activation.sidecarRuntimes[0].payloadSha256 = "1".repeat(64);
      },
    ],
    [
      "a native-helper sizeBytes that disagrees with disk",
      (activation: FixtureActivation): void => {
        activation.nativeHelpers[0].sizeBytes = Number(activation.nativeHelpers[0].sizeBytes) + 1;
      },
    ],
    [
      "a native-helper shippedSha256 that disagrees with disk",
      (activation: FixtureActivation): void => {
        activation.nativeHelpers[1].shippedSha256 = "2".repeat(64);
      },
    ],
    [
      "a sourceCommitSha that is not 40 hex characters",
      (activation: FixtureActivation): void => {
        activation.sourceCommitSha = "not-a-commit";
      },
    ],
    [
      "a broken redistribution approval",
      (activation: FixtureActivation): void => {
        activation.sidecarRuntimes[0].releaseApproval = {
          redistribution: { status: "withdrawn" },
        };
      },
    ],
  ])("refuses an evaluation artifact declaring %s", (_name, mutate) => {
    const root = portableInstall("evaluation");
    mutateActivation(root, mutate);
    expect(discoverEvaluation(root)).toBeUndefined();
  });

  /**
   * The synthesized receipt is computed over the COMPLETE qualification binding, so the activation
   * digest and both native-helper digests remain load-bearing for the runtime identity: a swapped
   * supervisor binary still changes the receipt.
   */
  it("binds the synthesized receipt to the artifact rather than to a constant", () => {
    const first = discoverEvaluation(portableInstall("evaluation"))?.qualification.releaseReceipt;
    const second = discoverEvaluation(portableInstall("evaluation"))?.qualification.releaseReceipt;
    expect(first).toBeDefined();
    // Two byte-identical artifacts agree: the receipt is deterministic, not random.
    expect(second).toBe(first);

    const drifted = portableInstall("evaluation");
    mutateActivation(drifted, (activation) => {
      // The drift injects the CURRENT product identity over the fixture's archived 0.2.15 one.
      // Derived from the exported constant so a version bump cannot silently turn this into a
      // no-op mutation (review findings on #3054).
      activation.product = {
        packageName: "@oscharko-dev/keiko",
        packageVersion: KEIKO_PRODUCT_VERSION,
      };
    });
    expect(discoverEvaluation(drifted)?.qualification.releaseReceipt).not.toBe(first);
  });
});

type FixtureRecord = Record<string, unknown>;

interface FixtureSidecar extends FixtureRecord {
  signing: FixtureRecord;
}

interface FixtureHelper extends FixtureRecord {
  signing?: FixtureRecord;
}

// Tuple shapes, not arrays: the fixture always carries exactly one sidecar and exactly two native
// helpers, so the mutators below index them without an undefined narrowing at every call.
interface FixtureActivation extends FixtureRecord {
  sidecarRuntimes: [FixtureSidecar, ...FixtureSidecar[]];
  nativeHelpers: [FixtureHelper, FixtureHelper, ...FixtureHelper[]];
}

function mutateActivation(root: string, mutate: (activation: FixtureActivation) => void): void {
  const path = join(root, ".portable", "runtime-activation.json");
  const activation = JSON.parse(readFileSync(path, "utf8")) as FixtureActivation;
  mutate(activation);
  writeFileSync(path, JSON.stringify(activation));
}

/** Discovery with an attestation port that FAILS if the platform chain is ever reached. */
function discoverEvaluation(root: string): ReturnType<typeof discoverQualifiedPortableOpenCode> {
  return discoverQualifiedPortableOpenCode({
    env: {},
    installRoot: root,
    platform: "win32",
    arch: "x64",
    attestation: {
      readReceipt: (): never => {
        throw new Error("platform attestation must not run on the evaluation lane");
      },
    },
  });
}

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

function portableInstall(lane: FixtureLane = "production"): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-portable-runtime-"));
  const sidecar = sidecarFixture(lane);
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
    JSON.stringify(runtimeActivation(sidecar.runtime, lane)),
  );
  return root;
}

function sidecarFixture(lane: FixtureLane = "production"): {
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
        ...laneSecurity(lane),
        shippedExecutableSha256: executableSha256,
        shippedExecutableTreeAlgorithm: "keiko-directory-tree-sha256-v1",
        shippedExecutableTreeSha256: sha256(`opencode.cmd\0${executableSha256}\0`),
      },
    },
  };
}

type FixtureLane = "production" | "evaluation" | "staging";

/**
 * The declared verification lane a real activation document carries at the top level, in each
 * sidecar signing block, and (in its 5-key shape) in each native-helper signing block.
 */
function laneSecurity(lane: FixtureLane): Record<string, unknown> {
  if (lane === "production") {
    return {
      verificationPolicy: "production",
      verificationStatus: "verified-production",
      verificationReasonCodes: [],
      signatureKind: "authenticode",
      signatureVerified: true,
      notarizationRequired: false,
      notarizationVerified: false,
      verificationChecks: { publisherChainVerified: true, timestampVerified: true },
    };
  }
  if (lane === "evaluation") {
    return {
      verificationPolicy: "evaluation",
      verificationStatus: "evaluation-unqualified",
      verificationReasonCodes: ["evaluation-artifact", "evaluation-unsigned-allowed"],
      signatureKind: "authenticode",
      signatureVerified: false,
      notarizationRequired: false,
      notarizationVerified: false,
      verificationChecks: { publisherChainVerified: false, timestampVerified: false },
    };
  }
  return {
    verificationPolicy: "staging",
    verificationStatus: "unverified-staging",
    verificationReasonCodes: ["staging-unverified"],
    signatureKind: "authenticode",
    signatureVerified: false,
    notarizationRequired: false,
    notarizationVerified: false,
    verificationChecks: { publisherChainVerified: false, timestampVerified: false },
  };
}

function laneHelperSigning(lane: FixtureLane): Record<string, unknown> {
  const security = laneSecurity(lane);
  return {
    signatureKind: "authenticode",
    verificationStatus: security.verificationStatus,
    signatureVerified: security.signatureVerified,
    notarizationRequired: false,
    notarizationVerified: false,
  };
}

function runtimeActivation(
  runtime: Record<string, unknown>,
  lane: FixtureLane = "production",
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    suiteVersion: "runtime-tree-qualification-v1",
    product: { packageName: "@oscharko-dev/keiko", packageVersion: "0.2.15" },
    sourceCommitSha: COMMIT,
    platformTarget: TARGET,
    runtime: { nodePlatform: "win32", nodeArchitecture: "x64" },
    // The activation document a production build actually ships: `runtimeActivationManifest`
    // clones `security` and `nativeHelpers` verbatim, and the release-assembly gate deep-equality
    // pins the on-disk bytes against that projection, so the declared lane is present artifact-wide.
    security: laneSecurity(lane),
    nativeHelpers: [
      nativeHelper("keiko-secure-workspace-read", SECURE_READ, lane),
      nativeHelper("keiko-runtime-supervisor", SUPERVISOR, lane),
    ],
    sidecarRuntimes: [runtime],
  };
}

function nativeHelper(
  name: string,
  bytes: string,
  lane: FixtureLane = "production",
): Record<string, unknown> {
  return {
    name,
    platformTarget: TARGET,
    executablePath: `runtime/native/${name}.exe`,
    shippedSha256: sha256(bytes),
    sizeBytes: Buffer.byteLength(bytes),
    signing: laneHelperSigning(lane),
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
