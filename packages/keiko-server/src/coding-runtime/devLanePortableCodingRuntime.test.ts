import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  computePortableSidecarPayloadTreeDigest,
  DEV_LANE_MANIFEST_FILE,
  DEV_LANE_RUNTIME_SUPERVISOR_RELATIVE_PATH,
  discoverDevLaneOpenCode,
  devLaneEnvEnabled,
  KEIKO_CODING_RUNTIME_DEV_LANE_ENV,
  type DevLaneOpenCodeDiscovery,
  type DevLaneOpenCodeTarget,
} from "./devLanePortableCodingRuntime.js";
import { OPEN_CODE_V2_PINNED_PROTOCOL_SURFACE_SHA256 } from "./opencodeProtocolSurface.js";
import { stageDevLaneFixture, type DevLaneFixture } from "./devLaneFixture/_support.js";
import { inspectStagedSidecarPayload } from "../update-portable-sidecar-staging-verification.js";
import { attestPortableSidecarTree } from "@oscharko-dev/keiko-security/portable-tree-attestation";

const roots: string[] = [];
const discoveryIo = vi.hoisted(() => ({
  selectedPath: "",
  evidencePath: "",
  evidenceDescriptor: undefined as number | undefined,
  onEvidenceRead: undefined as (() => void) | undefined,
  reversedDirectoryRoot: "",
  selectedDescriptor: undefined as number | undefined,
  selectedFullReads: 0,
  selectedReadBytes: 0,
  selectedReadCalls: 0,
  maximumReadBufferBytes: 0,
  onSelectedRead: undefined as (() => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    readdirSync: vi.fn((...args: Parameters<typeof original.readdirSync>) => {
      const entries = original.readdirSync(...args);
      return typeof args[0] === "string" &&
        discoveryIo.reversedDirectoryRoot !== "" &&
        args[0].startsWith(discoveryIo.reversedDirectoryRoot)
        ? entries.reverse()
        : entries;
    }),
    readFileSync: vi.fn((...args: Parameters<typeof original.readFileSync>) => {
      const result = original.readFileSync(...args);
      if (args[0] === discoveryIo.evidencePath) discoveryIo.onEvidenceRead?.();
      if (args[0] === discoveryIo.selectedPath) {
        discoveryIo.selectedFullReads += 1;
        if (discoveryIo.selectedFullReads === 2) discoveryIo.onSelectedRead?.();
      }
      return result;
    }),
    openSync: vi.fn((...args: Parameters<typeof original.openSync>) => {
      const descriptor = original.openSync(...args);
      if (args[0] === discoveryIo.evidencePath) discoveryIo.evidenceDescriptor = descriptor;
      if (args[0] === discoveryIo.selectedPath) discoveryIo.selectedDescriptor = descriptor;
      return descriptor;
    }),
    readSync: vi.fn((...args: Parameters<typeof original.readSync>) => {
      const result = original.readSync(...args);
      if (args[0] === discoveryIo.evidenceDescriptor) discoveryIo.onEvidenceRead?.();
      if (args[0] === discoveryIo.selectedDescriptor) {
        discoveryIo.selectedReadBytes += result;
        discoveryIo.selectedReadCalls += 1;
        discoveryIo.maximumReadBufferBytes = Math.max(
          discoveryIo.maximumReadBufferBytes,
          args[1].byteLength,
        );
        discoveryIo.onSelectedRead?.();
      }
      return result;
    }),
    closeSync: vi.fn((descriptor: number): void => {
      original.closeSync(descriptor);
      if (descriptor === discoveryIo.evidenceDescriptor) discoveryIo.evidenceDescriptor = undefined;
      if (descriptor === discoveryIo.selectedDescriptor) discoveryIo.selectedDescriptor = undefined;
    }),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readdir: async (
      ...args: Parameters<typeof original.readdir>
    ): Promise<Awaited<ReturnType<typeof original.readdir>>> => {
      const entries = await original.readdir(...args);
      return typeof args[0] === "string" &&
        discoveryIo.reversedDirectoryRoot !== "" &&
        args[0].startsWith(discoveryIo.reversedDirectoryRoot)
        ? entries.reverse()
        : entries;
    },
  };
});

function fixture(target: DevLaneOpenCodeTarget = "macos-arm64"): DevLaneFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-dev-lane-")));
  roots.push(root);
  return stageDevLaneFixture(root, target);
}

function discover(
  staged: DevLaneFixture,
  overrides: Partial<{ env: NodeJS.ProcessEnv; platform: NodeJS.Platform; arch: string }> = {},
): DevLaneOpenCodeDiscovery {
  return discoverDevLaneOpenCode({
    env: overrides.env ?? staged.env,
    platform: overrides.platform ?? "darwin",
    arch: overrides.arch ?? "arm64",
  });
}

function expectRefusal(discovery: DevLaneOpenCodeDiscovery, reason: string): void {
  expect(discovery).toEqual({ outcome: "refused", reason });
}

afterEach(() => {
  discoveryIo.selectedPath = "";
  discoveryIo.evidencePath = "";
  discoveryIo.evidenceDescriptor = undefined;
  discoveryIo.onEvidenceRead = undefined;
  discoveryIo.reversedDirectoryRoot = "";
  discoveryIo.selectedDescriptor = undefined;
  discoveryIo.selectedFullReads = 0;
  discoveryIo.selectedReadBytes = 0;
  discoveryIo.selectedReadCalls = 0;
  discoveryIo.maximumReadBufferBytes = 0;
  discoveryIo.onSelectedRead = undefined;
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function largeExecutableFixture(): DevLaneFixture {
  const staged = fixture();
  const executable = Buffer.alloc(1024 * 1024, 0x78);
  writeFileSync(staged.paths.executable, executable);
  const catalog = JSON.parse(readFileSync(staged.paths.catalog, "utf8")) as {
    sidecarRuntimes: { archives: Record<string, { executableTreeSha256: string }> }[];
  };
  const archive = catalog.sidecarRuntimes[0]?.archives["macos-arm64"];
  if (archive === undefined) throw new Error("expected fixture archive");
  archive.executableTreeSha256 = computePortableSidecarPayloadTreeDigest([
    { relativePath: "bin/opencode", sha256: createHash("sha256").update(executable).digest("hex") },
  ]);
  writeFileSync(staged.paths.catalog, JSON.stringify(catalog));
  vi.clearAllMocks();
  discoveryIo.selectedPath = staged.paths.executable;
  return staged;
}

describe("discovery's single stable executable read", () => {
  it("derives the executable and complete tree digests with one bounded body read", () => {
    const staged = largeExecutableFixture();
    const result = discover(staged);
    expect(result.outcome).toBe("activated");
    const selectedOpens = vi
      .mocked(openSync)
      .mock.calls.filter(([path]) => path === staged.paths.executable);
    expect(selectedOpens.length + discoveryIo.selectedFullReads).toBe(1);
    expect(discoveryIo.selectedFullReads).toBe(0);
    expect(discoveryIo.selectedReadCalls).toBeGreaterThan(1);
    expect(discoveryIo.selectedReadBytes).toBe(1024 * 1024);
    expect(discoveryIo.maximumReadBufferBytes).toBeLessThanOrEqual(64 * 1024);
    expect(discoveryIo.selectedDescriptor).toBeUndefined();
    if (result.outcome !== "activated") throw new Error("expected approved fixture");
    expect(result.runtime.sidecar.shippedExecutableSha256).toBe(
      createHash("sha256")
        .update(Buffer.alloc(1024 * 1024, 0x78))
        .digest("hex"),
    );
  });

  it.each(["license", "sbom"] as const)(
    "refuses %s replaced after approved bytes are returned before later discovery reads",
    (evidence) => {
      const staged = largeExecutableFixture();
      discoveryIo.evidencePath = staged.paths[evidence];
      let replaced = false;
      discoveryIo.onEvidenceRead = (): void => {
        discoveryIo.onEvidenceRead = undefined;
        replaced = true;
        writeFileSync(staged.paths[evidence], "replaced immediately after approved evidence read");
      };
      expectRefusal(discover(staged), "payload-tampered");
      expect(replaced).toBe(true);
    },
  );

  it("refuses approved provenance changed during the complete discovery content pass", () => {
    const staged = largeExecutableFixture();
    discoveryIo.onSelectedRead = (): void => {
      discoveryIo.onSelectedRead = undefined;
      writeFileSync(staged.paths.license, "changed during complete discovery pass");
    };
    expectRefusal(discover(staged), "payload-tampered");
  });
});

describe("discovery's historical recursive tuple ordering", () => {
  it.each([false, true])(
    "matches the existing recursive producer with nested collation ties and reversed owner order %s",
    async (reversed) => {
      const staged = fixture();
      const payload = join(staged.paths.stagedTargetRoot, "opencode-compatible", "payload");
      const first = ["branch\u200d", "é", "tool"];
      const second = ["branch", "e\u0301", "tool"];
      expect(first[1]?.normalize("NFC")).toBe(second[1]?.normalize("NFC"));
      expect(first.join("/").localeCompare(second.join("/"))).toBe(0);
      mkdirSync(join(payload, ...first.slice(0, -1)), { recursive: true });
      mkdirSync(join(payload, ...second.slice(0, -1)), { recursive: true });
      writeFileSync(join(payload, ...first), "first nested body");
      writeFileSync(join(payload, ...second), "second nested body");
      writeFileSync(join(payload, "native\u200d"), "first sibling body");
      writeFileSync(join(payload, "native"), "second sibling body");
      if (reversed) discoveryIo.reversedDirectoryRoot = payload;
      const result = discover(staged);
      expect(result.outcome).toBe("activated");
      if (result.outcome !== "activated") throw new Error("expected approved fixture");
      expect(
        inspectStagedSidecarPayload(result.runtime.installRoot, result.runtime.sidecar),
      ).toEqual({
        payloadPresent: true,
        archiveDigestVerified: true,
        executableTreeDigestVerified: true,
      });
      const asynchronous = await attestPortableSidecarTree(payload, "bin/opencode", {
        deadline: Date.now() + 5_000,
        now: Date.now,
        yieldControl: () => Promise.resolve(),
      });
      expect(asynchronous.treeSha256).toBe(result.runtime.sidecar.summary.payloadSha256);
    },
  );
});

describe("dev-lane OpenCode discovery", () => {
  it("stays inactive unless the lane flag carries an explicit enable token", () => {
    const staged = fixture();
    const withoutFlag: NodeJS.ProcessEnv = { KEIKO_CLI_BIN_PATH: staged.env.KEIKO_CLI_BIN_PATH };
    expect(discover(staged, { env: withoutFlag })).toEqual({ outcome: "inactive" });
    for (const value of ["", "0", "false", "maybe", "TRUE_ISH"]) {
      const env = { ...staged.env, [KEIKO_CODING_RUNTIME_DEV_LANE_ENV]: value };
      expect(discover(staged, { env })).toEqual({ outcome: "inactive" });
    }
    expect(devLaneEnvEnabled("1")).toBe(true);
    expect(devLaneEnvEnabled(" true ")).toBe(true);
  });

  it("activates a fully staged, catalog-verified payload on a dev checkout", () => {
    const staged = fixture();
    const discovery = discover(staged);
    expect(discovery.outcome).toBe("activated");
    if (discovery.outcome !== "activated") return;
    const runtime = discovery.runtime;
    expect(runtime.evidenceClass).toBe("functional-not-platform-qualified");
    expect(runtime.lane).toBe("dev-checkout");
    expect(runtime.target).toBe("macos-arm64");
    expect(runtime.installRoot).toBe(join(staged.paths.stagedTargetRoot, "opencode-compatible"));
    expect(runtime.sidecar.summary).toMatchObject({
      name: "opencode-compatible",
      upstreamVersion: "2.0.10",
      platformTarget: "macos-arm64",
      status: "verified",
    });
    // Honest availability: only checks the lane actually performs are recorded as verified.
    expect(runtime.sidecar.availability).toMatchObject({
      signatureVerified: false,
      qualificationVerified: false,
      executableTreeDigestVerified: true,
    });
    expect(runtime.sidecar.protocolHandshakeDigest).toBe(
      OPEN_CODE_V2_PINNED_PROTOCOL_SURFACE_SHA256,
    );
    expect(runtime.qualification).toMatchObject({
      platform: "darwin",
      arch: "arm64",
      backend: "macos-app-sandbox",
    });
    expect(runtime.qualification.releaseReceipt).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(runtime.secureRead.artifact).toMatchObject({
      target: "darwin-arm64",
      installRelativePath: "runtime/native/keiko-secure-workspace-read",
      protocol: "KSR1/KSS1",
      signed: true,
    });
  });

  it("activates Windows-x64 through the same verified dev lane", () => {
    const staged = fixture("windows-x64");
    const discovery = discover(staged, { platform: "win32", arch: "x64" });
    expect(discovery.outcome).toBe("activated");
    if (discovery.outcome !== "activated") return;
    expect(discovery.runtime).toMatchObject({
      target: "windows-x64",
      qualification: { platform: "win32", arch: "x64", backend: "windows-job-object" },
      secureRead: {
        artifact: {
          target: "win32-x64",
          installRelativePath: "runtime/native/keiko-secure-workspace-read.exe",
        },
      },
    });
    expect(discovery.runtime.nativeHelperPath).toContain("keiko-runtime-supervisor.exe");
    expect(discovery.runtime.nativeHelperSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("refuses an unexpected DLL beside a staged Windows helper", () => {
    const staged = fixture("windows-x64");
    writeFileSync(join(staged.paths.stagedTargetRoot, "native", "plantable.dll"), "malicious");

    expectRefusal(
      discover(staged, { platform: "win32", arch: "x64" }),
      "native-helper-directory-untrusted",
    );
  });

  it("fails closed on a malformed Windows supervisor binding", () => {
    const staged = fixture("windows-x64");
    const manifest = JSON.parse(readFileSync(staged.paths.helperManifest, "utf8")) as {
      runtimeSupervisor: { sha256: string };
    };
    manifest.runtimeSupervisor.sha256 = "not-a-digest";
    writeFileSync(staged.paths.helperManifest, JSON.stringify(manifest));

    expectRefusal(discover(staged, { platform: "win32", arch: "x64" }), "payload-missing");
  });

  it("refuses a replacement Windows supervisor even when its staged manifest is rewritten", () => {
    const staged = fixture("windows-x64");
    const first = discover(staged, { platform: "win32", arch: "x64" });
    expect(first.outcome).toBe("activated");
    if (first.outcome !== "activated") return;

    const supervisor = join(
      staged.paths.stagedTargetRoot,
      `${DEV_LANE_RUNTIME_SUPERVISOR_RELATIVE_PATH}.exe`,
    );
    writeFileSync(supervisor, "rebuilt supervisor");
    const manifestPath = join(staged.paths.stagedTargetRoot, DEV_LANE_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      runtimeSupervisor: { sha256: string; sizeBytes: number };
    };
    manifest.runtimeSupervisor.sha256 = createHash("sha256")
      .update(readFileSync(supervisor))
      .digest("hex");
    manifest.runtimeSupervisor.sizeBytes = readFileSync(supervisor).length;
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const second = discover(staged, { platform: "win32", arch: "x64" });
    expectRefusal(second, "payload-missing");
  });

  it("refuses unsupported platforms and unknown architectures", () => {
    const staged = fixture();
    expectRefusal(discover(staged, { platform: "linux" }), "platform-unsupported");
    expectRefusal(discover(staged, { platform: "win32", arch: "arm64" }), "platform-unsupported");
    expectRefusal(discover(staged, { arch: "ppc64" }), "platform-unsupported");
    expect(discover(staged, { arch: "x64" })).toMatchObject({ outcome: "refused" });
  });

  it("refuses when a packaged-install manifest is present, before any payload trust", () => {
    for (const manifest of ["update-portable-manifest.json", "setup-manifest.json"]) {
      const staged = fixture();
      const manifestPath = join(staged.root, ".portable", manifest);
      mkdirSync(join(staged.root, ".portable"), { recursive: true });
      writeFileSync(manifestPath, "{}");
      expectRefusal(discover(staged), "packaged-install-present");
    }
  });

  it("refuses outside a repository checkout", () => {
    const staged = fixture();
    unlinkSync(join(staged.root, "tsconfig.packages.json"));
    expectRefusal(discover(staged), "not-a-dev-checkout");
    expectRefusal(
      discover(staged, { env: { ...staged.env, KEIKO_CLI_BIN_PATH: "/nonexistent/entry.js" } }),
      "not-a-dev-checkout",
    );
  });

  it("refuses an absent, tampered, or unapproved payload with the precise reason", () => {
    const missing = fixture();
    unlinkSync(missing.paths.executable);
    expectRefusal(discover(missing), "payload-missing");

    const tampered = fixture();
    writeFileSync(tampered.paths.executable, "#!/bin/sh\nexit 1\n");
    expectRefusal(discover(tampered), "payload-tampered");

    const licenseTampered = fixture();
    writeFileSync(licenseTampered.paths.license, "forged license\n");
    expectRefusal(discover(licenseTampered), "payload-tampered");

    // Round-3 KEIKO-0763-r3: a modified SBOM (identical binary, mutated/forged provenance) must be
    // caught the same way a tampered LICENSE or executable is -- this exercises the fixture's own
    // matching sbomSha256 anchor, proving the comparison actually runs (not merely present).
    const sbomTampered = fixture();
    writeFileSync(sbomTampered.paths.sbom, '{"bomFormat":"CycloneDX","components":["forged"]}\n');
    expectRefusal(discover(sbomTampered), "payload-tampered");

    const unapproved = fixture();
    unlinkSync(unapproved.paths.catalog);
    expectRefusal(discover(unapproved), "payload-unapproved");

    const revoked = fixture();
    const catalog = JSON.parse(readFileSync(revoked.paths.catalog, "utf8")) as {
      sidecarRuntimes: { releaseApproval: unknown }[];
    };
    const runtime = catalog.sidecarRuntimes[0];
    if (runtime === undefined) throw new Error("fixture-catalog-missing-runtime");
    runtime.releaseApproval = { redistribution: { status: "revoked" } };
    writeFileSync(revoked.paths.catalog, JSON.stringify(catalog));
    expectRefusal(discover(revoked), "payload-unapproved");
  });

  // Round-3 finding (KEIKO-0763-r3): the CHECKED-IN portable-runtime-approvals.json carries no
  // sbomSha256 entries for either macOS target -- this is the shape production actually ships
  // today, not a hypothetical. Before this fix, an archive entry with no sbomSha256 made
  // verifiedPayload SKIP the SBOM comparison entirely (treated as "nothing to compare against"),
  // so a modified SBOM was silently accepted on the real dev lane and its freshly-computed digest
  // reported back as if it had been verified. sbomSha256 is now a REQUIRED field: a catalog archive
  // entry that omits it fails approvedSidecarShape exactly like an entry missing
  // executableTreeSha256 always did, and is refused "payload-unapproved" before any file comparison
  // happens -- fail closed instead of silently downgrading to a partial check.
  it("refuses the payload when the catalog's archive entry has no sbomSha256 anchor, matching the real checked-in catalog", () => {
    const noSbomAnchor = fixture();
    const catalog = JSON.parse(readFileSync(noSbomAnchor.paths.catalog, "utf8")) as {
      sidecarRuntimes: { archives: Record<string, { sbomSha256?: string }> }[];
    };
    const runtime = catalog.sidecarRuntimes[0];
    if (runtime === undefined) throw new Error("fixture-catalog-missing-runtime");
    const archive = runtime.archives["macos-arm64"];
    if (archive === undefined) throw new Error("fixture-catalog-missing-archive-entry");
    delete archive.sbomSha256;
    writeFileSync(noSbomAnchor.paths.catalog, JSON.stringify(catalog));

    // A genuinely valid, untampered payload on disk -- the refusal must come purely from the
    // catalog omitting the anchor, not from any file mismatch.
    expectRefusal(discover(noSbomAnchor), "payload-unapproved");
  });

  // Gitar finding (#2475 review): the helper source-tree digest crosses a process boundary
  // (staging writes it, discovery re-derives it), so its file ordering must be plain code-unit
  // comparison — never locale collation. "B.c" and "a.c" order differently under ICU collation
  // ("a.c" < "B.c") than by code units ("B.c" < "a.c"), so a locale-ordered digest is refused.
  it("derives the helper source digest with locale-independent ordering", () => {
    const staged = fixture();
    const first = join(staged.paths.helperSourceDir, "B.c");
    const second = join(staged.paths.helperSourceDir, "a.c");
    writeFileSync(first, "/* B */\n");
    writeFileSync(second, "/* a */\n");
    const entries = ["B.c", "a.c", "secure_workspace_read.c"].map(
      (name) =>
        [
          name,
          createHash("sha256")
            .update(readFileSync(join(staged.paths.helperSourceDir, name)))
            .digest("hex"),
        ] as const,
    );
    const digestFor = (order: readonly string[]): string => {
      const hash = createHash("sha256");
      for (const name of order) {
        const digest = entries.find(([entry]) => entry === name)?.[1] ?? "";
        hash.update(`${name}\0${digest}\0`);
      }
      return hash.digest("hex");
    };
    const manifest = JSON.parse(readFileSync(staged.paths.helperManifest, "utf8")) as {
      helper: { sourceTreeSha256: string };
    };
    manifest.helper.sourceTreeSha256 = digestFor(["B.c", "a.c", "secure_workspace_read.c"]);
    writeFileSync(staged.paths.helperManifest, JSON.stringify(manifest));
    expect(discover(staged).outcome).toBe("activated");

    manifest.helper.sourceTreeSha256 = digestFor(["a.c", "B.c", "secure_workspace_read.c"]);
    writeFileSync(staged.paths.helperManifest, JSON.stringify(manifest));
    expectRefusal(discover(staged), "secure-read-helper-stale");
  });

  it("refuses a missing or stale secure-read helper with the precise reason", () => {
    const missingHelper = fixture();
    unlinkSync(missingHelper.paths.helper);
    expectRefusal(discover(missingHelper), "secure-read-helper-missing");

    const missingManifest = fixture();
    unlinkSync(missingManifest.paths.helperManifest);
    expectRefusal(discover(missingManifest), "secure-read-helper-missing");

    const swapped = fixture();
    writeFileSync(swapped.paths.helper, "#!/bin/sh\nexit 9\n");
    expectRefusal(discover(swapped), "secure-read-helper-stale");

    const drifted = fixture();
    writeFileSync(
      join(drifted.paths.helperSourceDir, "secure_workspace_read.c"),
      "/* drifted source */\n",
    );
    expectRefusal(discover(drifted), "secure-read-helper-stale");
  });
});

// PR #3099 follow-up (KfQ Major + Codex P2): the manager test fixture derives its expected
// values from this very function, so a bug HERE would move both the production hash and the
// fixture in lockstep and no downstream test would catch it. This standalone pin computes the
// tree digest for a hand-hashed pair with a known relative path and asserts the exact 64-char
// hex string — a formula change (order, separator, digest algorithm, sort collation) fails this
// pin loudly.
describe("computePortableSidecarPayloadTreeDigest (KEIKO-0180)", () => {
  it("produces a stable hex digest for a known single-entry input", () => {
    const contentSha = createHash("sha256").update("payload\n", "utf8").digest("hex");
    const expected = createHash("sha256")
      .update(`bin/opencode\0${contentSha}\0`, "utf8")
      .digest("hex");
    expect(
      computePortableSidecarPayloadTreeDigest([
        { relativePath: "bin/opencode", sha256: contentSha },
      ]),
    ).toBe(expected);
  });

  it("locale-sorts entries by relativePath before hashing (order-independent input, deterministic digest)", () => {
    const bin = createHash("sha256").update("x", "utf8").digest("hex");
    const lic = createHash("sha256").update("y", "utf8").digest("hex");
    const forward = computePortableSidecarPayloadTreeDigest([
      { relativePath: "LICENSE", sha256: lic },
      { relativePath: "bin/opencode", sha256: bin },
    ]);
    const reversed = computePortableSidecarPayloadTreeDigest([
      { relativePath: "bin/opencode", sha256: bin },
      { relativePath: "LICENSE", sha256: lic },
    ]);
    expect(forward).toBe(reversed);
    const sortedKeys = ["LICENSE", "bin/opencode"].sort((a, b) => a.localeCompare(b));
    const shas: Record<string, string> = { LICENSE: lic, "bin/opencode": bin };
    const hash = createHash("sha256");
    for (const key of sortedKeys) hash.update(`${key}\0${shas[key] ?? ""}\0`, "utf8");
    expect(forward).toBe(hash.digest("hex"));
  });

  it("empty entry set produces the sha256 of the empty string", () => {
    expect(computePortableSidecarPayloadTreeDigest([])).toBe(
      createHash("sha256").update("", "utf8").digest("hex"),
    );
  });
});
