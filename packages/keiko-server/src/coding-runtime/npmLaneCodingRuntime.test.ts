import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  discoverNpmLaneOpenCode,
  npmLanePackageRoot,
  type DevLaneOpenCodeDiscovery,
} from "./devLanePortableCodingRuntime.js";
import { resolveOpenCodeRipgrep } from "./opencodeRipgrepLaunch.js";
import type { RipgrepRuntimeManifest } from "./ripgrepRuntime.js";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import {
  plantDirectoryRedirect,
  plantSymlinkOrSkip,
} from "../../../../tests/support/symlink-fixture.js";
import {
  NPM_LANE_PREVIOUS_RUNTIME_APPROVALS,
  NPM_LANE_RUNTIME_APPROVALS,
  type NpmLaneRuntimeApproval,
} from "./npmLaneRuntimeApprovals.js";

// Field defect 1.1.1 (#3577). The customer installs Keiko from npm because a desktop package needs
// admin rights and an infrastructure approval they cannot get. The npm package carried no coding
// engine, so the Workbench listed its models and could never start a run. The npm lane activates the
// engine from a runtime package installed NEXT TO Keiko. These tests stage the exact directory shape
// `npm install -g` produces: <prefix>/lib/node_modules/@oscharko-dev/{keiko,keiko-coding-runtime-*}.

const PACKAGE_NAME = "@oscharko-dev/keiko-coding-runtime-darwin-arm64";
const roots: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function write(path: string, body: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, mode);
}

interface GlobalInstall {
  readonly env: NodeJS.ProcessEnv;
  readonly runtimeRoot: string;
  readonly approval: NpmLaneRuntimeApproval;
}

const EXECUTABLE = "#!/bin/sh\necho opencode\n";
const LICENSE = "MIT\n";
const SBOM = '{"bomFormat":"CycloneDX"}\n';
const HELPER = "helper-binary";

function approvalFor(): NpmLaneRuntimeApproval {
  return {
    packageName: PACKAGE_NAME,
    upstreamVersion: "2.0.10",
    adapterName: "keiko-coding-sidecar",
    adapterVersion: "2",
    executableTreeSha256: sha256(`bin/opencode\0${sha256(EXECUTABLE)}\0`),
    licenseSha256: sha256(LICENSE),
    // The approved version's own producer-derived schema digest (opencodeRuntimeVersions.ts).
    protocolSchemaSha256: "1362671d8cfdcb925b3a9fd61eaa20152e4c587746445a0b03504674b25c88ec",
    sbomSha256: sha256(SBOM),
    helperSha256: sha256(HELPER),
    helperSizeBytes: HELPER.length,
    helperSourceCommit: "b".repeat(40),
    helperSourceTreeSha256: "c".repeat(64),
  };
}

function globalInstall(
  options: { readonly withRuntimePackage?: boolean; readonly ripgrep?: string } = {},
): GlobalInstall {
  const prefix = realpathSync(mkdtempSync(join(tmpdir(), "keiko-npm-lane-")));
  roots.push(prefix);
  const scope = join(prefix, "lib", "node_modules", "@oscharko-dev");
  const keikoRoot = join(scope, "keiko");
  write(join(keikoRoot, "package.json"), JSON.stringify({ name: "@oscharko-dev/keiko" }));
  write(join(keikoRoot, "dist", "cli", "index.js"), "");
  const runtimeRoot = join(scope, "keiko-coding-runtime-darwin-arm64", "runtime");
  if (options.withRuntimePackage !== false) {
    write(join(runtimeRoot, "..", "package.json"), JSON.stringify({ name: PACKAGE_NAME }));
    const payload = join(runtimeRoot, "opencode-compatible", "payload");
    write(join(payload, "bin", "opencode"), EXECUTABLE, 0o755);
    write(join(payload, "evidence", "LICENSE"), LICENSE);
    write(join(payload, "evidence", "sbom.cdx.json"), SBOM);
    write(join(runtimeRoot, "native", "keiko-secure-workspace-read"), HELPER, 0o755);
    if (options.ripgrep !== undefined)
      write(join(runtimeRoot, "native", "rg"), options.ripgrep, 0o755);
  }
  return {
    approval: approvalFor(),
    env: { KEIKO_CLI_BIN_PATH: join(keikoRoot, "dist", "cli", "index.js") },
    runtimeRoot,
  };
}

function discover(
  install: GlobalInstall,
  overrides: Partial<{ platform: NodeJS.Platform; arch: string }> = {},
): DevLaneOpenCodeDiscovery {
  return discoverNpmLaneOpenCode({
    env: install.env,
    platform: overrides.platform ?? "darwin",
    arch: overrides.arch ?? "arm64",
    npmLaneApprovals: { "macos-arm64": install.approval },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("npm-lane OpenCode discovery", () => {
  it("keeps a previously approved helper usable with its narrower wire capability", () => {
    const install = globalInstall();
    const previous = { ...install.approval, helperMaxBytes: 65_536 };
    const current = { ...install.approval, helperSha256: sha256("new-helper-binary") };
    const discovery = discoverNpmLaneOpenCode({
      env: install.env,
      platform: "darwin",
      arch: "arm64",
      npmLaneApprovals: { "macos-arm64": current },
      npmLanePreviousApprovals: { "macos-arm64": previous },
    });
    expect(discovery.outcome).toBe("activated");
    if (discovery.outcome !== "activated") return;
    expect(discovery.runtime.secureRead.artifact).toMatchObject({
      sha256: previous.helperSha256,
      sourceTreeSha256: previous.helperSourceTreeSha256,
      byteCap: 65_536,
    });
    write(
      join(install.runtimeRoot, "native", "keiko-secure-workspace-read"),
      "unknown-helper",
      0o755,
    );
    expect(
      discoverNpmLaneOpenCode({
        env: install.env,
        platform: "darwin",
        arch: "arm64",
        npmLaneApprovals: { "macos-arm64": current },
        npmLanePreviousApprovals: { "macos-arm64": previous },
      }),
    ).toEqual({ outcome: "refused", reason: "secure-read-helper-stale" });
  });

  it("activates the runtime package installed next to a globally installed Keiko", () => {
    const install = globalInstall();
    const discovery = discover(install);
    expect(discovery.outcome).toBe("activated");
    if (discovery.outcome !== "activated") return;
    expect(discovery.runtime).toMatchObject({
      evidenceClass: "functional-not-platform-qualified",
      lane: "npm-runtime-package",
      installRoot: join(install.runtimeRoot, "opencode-compatible"),
      target: "macos-arm64",
    });
    expect(discovery.runtime.secureRead).toMatchObject({
      helperPath: join(install.runtimeRoot, "native", "keiko-secure-workspace-read"),
      artifact: { sha256: install.approval.helperSha256, target: "darwin-arm64" },
    });
    // Honest posture: digest-verified, never signature- or platform-qualified.
    expect(discovery.runtime.sidecar.availability).toMatchObject({
      executableTreeDigestVerified: true,
      signatureVerified: false,
      qualificationVerified: false,
    });
  });

  // #3897 review (P1): the helper of every current runtime approval implements the native
  // KSR3/KSS3 protocol, so its verified binding declares it and repository items can be listed;
  // a helper of any other source, the published 1.1.3 one included, keeps text IO only.
  it("declares the native protocol for a helper of the current approved source and no other", () => {
    const install = globalInstall();
    const currentSource = NPM_LANE_RUNTIME_APPROVALS["macos-arm64"].helperSourceTreeSha256;
    const previousSource =
      NPM_LANE_PREVIOUS_RUNTIME_APPROVALS["macos-arm64"].helperSourceTreeSha256;
    for (const [sourceTreeSha256, expected] of [
      [currentSource, "KSR3/KSS3"],
      [previousSource, undefined],
      ["c".repeat(64), undefined],
    ] as const) {
      const discovery = discoverNpmLaneOpenCode({
        env: install.env,
        platform: "darwin",
        arch: "arm64",
        npmLaneApprovals: {
          "macos-arm64": { ...install.approval, helperSourceTreeSha256: sourceTreeSha256 },
        },
      });
      expect(discovery.outcome).toBe("activated");
      if (discovery.outcome !== "activated") continue;
      expect(discovery.runtime.secureRead.artifact.nativeProtocol).toBe(expected);
    }
  });

  it("stays inactive while no runtime package is installed, so other lanes still decide", () => {
    expect(discover(globalInstall({ withRuntimePackage: false }))).toEqual({
      outcome: "inactive",
    });
  });

  it.each([
    ["Windows, which needs the native supervisor this lane does not ship", "win32", "x64"],
    ["Linux, where the engine runs only inside the sandbox isolation", "linux", "x64"],
  ] as const)("stays inactive on %s", (_label, platform, arch) => {
    expect(discover(globalInstall(), { platform, arch })).toEqual({ outcome: "inactive" });
  });

  it("refuses an OpenCode executable that is not the approved one", () => {
    const install = globalInstall();
    write(
      join(install.runtimeRoot, "opencode-compatible", "payload", "bin", "opencode"),
      "#!/bin/sh\necho evil\n",
      0o755,
    );
    expect(discover(install)).toEqual({ outcome: "refused", reason: "payload-tampered" });
  });

  it.each(["LICENSE", "sbom.cdx.json"])("refuses tampered evidence %s", (file) => {
    const install = globalInstall();
    write(join(install.runtimeRoot, "opencode-compatible", "payload", "evidence", file), "x");
    expect(discover(install)).toEqual({ outcome: "refused", reason: "payload-tampered" });
  });

  it("refuses a helper that is not the binary Keiko built, even at the same size", () => {
    const install = globalInstall();
    write(
      join(install.runtimeRoot, "native", "keiko-secure-workspace-read"),
      "HELPER-BINARY",
      0o755,
    );
    expect(discover(install)).toEqual({ outcome: "refused", reason: "secure-read-helper-stale" });
  });

  it("refuses a missing helper and a hard-linked helper", () => {
    const missing = globalInstall();
    rmSync(join(missing.runtimeRoot, "native", "keiko-secure-workspace-read"));
    expect(discover(missing)).toEqual({ outcome: "refused", reason: "secure-read-helper-missing" });
    const linked = globalInstall();
    const helper = join(linked.runtimeRoot, "native", "keiko-secure-workspace-read");
    linkSync(helper, join(linked.runtimeRoot, "..", "second-name"));
    expect(discover(linked)).toEqual({ outcome: "refused", reason: "secure-read-helper-missing" });
  });

  it("refuses a native directory that carries anything beside the helper", () => {
    const install = globalInstall();
    write(join(install.runtimeRoot, "native", "extra"), "x", 0o755);
    expect(discover(install)).toEqual({
      outcome: "refused",
      reason: "native-helper-directory-untrusted",
    });
  });

  // The pinned ripgrep (#3897) ships in the runtime package beside the helper. The directory check
  // admits that one name; the executable's bytes are judged at launch by the ripgrep verifier, which
  // degrades search instead of refusing the engine, so a bad `rg` must not take the lane away.
  describe("pinned ripgrep in the native directory", () => {
    const RG = "pinned ripgrep bytes";
    const manifest: RipgrepRuntimeManifest = {
      version: "0.0.0-test",
      sourceCommit: "a".repeat(40),
      licenseExpression: "MIT",
      licenseFileName: "LICENSE-MIT",
      targets: {
        "darwin-arm64": {
          archiveKind: "tar.gz",
          archiveUrl: "https://example.test/ripgrep.tar.gz",
          archiveSha256: "b".repeat(64),
          archiveSizeBytes: 10,
          binaryMember: "ripgrep/rg",
          binarySha256: sha256(RG),
          binarySizeBytes: RG.length,
          licenseMember: "ripgrep/LICENSE-MIT",
          licenseSha256: "c".repeat(64),
        },
      },
    };

    it("activates a package that carries the pinned ripgrep beside the helper", () => {
      const install = globalInstall({ ripgrep: RG });
      const discovery = discover(install);
      expect(discovery.outcome).toBe("activated");
      if (discovery.outcome !== "activated") return;
      const packageRoot = npmLanePackageRoot(discovery.runtime);
      expect(packageRoot).toBe(dirname(install.runtimeRoot));
      expect(
        resolveOpenCodeRipgrep({
          target: discovery.runtime.target,
          location: { kind: "npm-package", packageRoot: packageRoot ?? "" },
          env: {},
          manifest,
        }),
      ).toMatchObject({
        outcome: "verified",
        layout: "npm-package",
        directory: join(install.runtimeRoot, "native"),
      });
    });

    it("still refuses any other entry beside the helper and the pinned ripgrep", () => {
      const install = globalInstall({ ripgrep: RG });
      write(join(install.runtimeRoot, "native", "extra"), "x", 0o755);
      expect(discover(install)).toEqual({
        outcome: "refused",
        reason: "native-helper-directory-untrusted",
      });
      const renamed = globalInstall();
      write(join(renamed.runtimeRoot, "native", "rg.exe"), RG, 0o755);
      expect(discover(renamed)).toEqual({
        outcome: "refused",
        reason: "native-helper-directory-untrusted",
      });
    });

    it("keeps an earlier published package without ripgrep active, with search degraded", () => {
      const install = globalInstall();
      const discovery = discover(install);
      expect(discovery.outcome).toBe("activated");
      if (discovery.outcome !== "activated") return;
      expect(
        resolveOpenCodeRipgrep({
          target: discovery.runtime.target,
          location: {
            kind: "npm-package",
            packageRoot: npmLanePackageRoot(discovery.runtime) ?? "",
          },
          env: {},
          manifest,
        }),
      ).toEqual({
        outcome: "unverified",
        targetKey: "darwin-arm64",
        layout: "npm-package",
        reason: "missing",
      });
    });

    // `redirected` is the directory form of the link: a junction on Windows (no privilege needed),
    // a directory symlink elsewhere.
    it.for([
      ["tampered", "digest-mismatch"],
      ["linked", "not-regular-file"],
      ["redirected", "not-regular-file"],
    ] as const)(
      "keeps the engine active and degrades search for a %s ripgrep (%s)",
      ([kind, reason], context) => {
        const install = globalInstall({ ripgrep: kind === "tampered" ? "other bytes" : RG });
        const executable = join(install.runtimeRoot, "native", "rg");
        if (kind === "linked") {
          const elsewhere = join(dirname(install.runtimeRoot), "real-rg");
          write(elsewhere, RG, 0o755);
          rmSync(executable);
          plantSymlinkOrSkip(context, elsewhere, executable);
        }
        if (kind === "redirected") {
          const elsewhere = join(dirname(install.runtimeRoot), "real-rg-directory");
          write(join(elsewhere, "rg"), RG, 0o755);
          rmSync(executable);
          plantDirectoryRedirect(elsewhere, executable);
        }
        const discovery = discover(install);
        expect(discovery.outcome).toBe("activated");
        if (discovery.outcome !== "activated") return;
        expect(
          resolveOpenCodeRipgrep({
            target: discovery.runtime.target,
            location: {
              kind: "npm-package",
              packageRoot: npmLanePackageRoot(discovery.runtime) ?? "",
            },
            env: {},
            manifest,
          }),
        ).toMatchObject({ outcome: "unverified", layout: "npm-package", reason });
      },
    );

    it("derives a package root for the npm lane only", () => {
      const install = globalInstall();
      const installRoot = join(install.runtimeRoot, "opencode-compatible");
      expect(npmLanePackageRoot({ lane: "npm-runtime-package", installRoot })).toBe(
        dirname(install.runtimeRoot),
      );
      expect(npmLanePackageRoot({ lane: "dev-checkout", installRoot })).toBeUndefined();
      expect(
        npmLanePackageRoot({
          lane: "npm-runtime-package",
          installRoot: join(dirname(install.runtimeRoot), "elsewhere", "opencode-compatible"),
        }),
      ).toBeUndefined();
    });
  });

  // An unreadable executable is not "tampered" evidence anyone can act on by itself: the refusal
  // stays fail-closed, and why the verification could not be completed is recorded, not swallowed.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "records a diagnostic when the verification cannot be completed",
    () => {
      const install = globalInstall();
      chmodSync(join(install.runtimeRoot, "opencode-compatible", "payload", "bin", "opencode"), 0);
      const records: ServerDiagnosticRecord[] = [];
      const discovery = discoverNpmLaneOpenCode({
        env: install.env,
        platform: "darwin",
        arch: "arm64",
        npmLaneApprovals: { "macos-arm64": install.approval },
        diagnostics: { record: (record) => records.push(record) },
      });
      expect(discovery).toEqual({ outcome: "refused", reason: "payload-tampered" });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ operation: "coding.runtime.discover" });
    },
  );

  it("never trusts a digest the runtime package supplies about itself", () => {
    const install = globalInstall();
    write(
      join(install.runtimeRoot, "opencode-compatible", "payload", "bin", "opencode"),
      "#!/bin/sh\necho evil\n",
      0o755,
    );
    write(
      join(install.runtimeRoot, "..", "approvals.json"),
      JSON.stringify({ executableTreeSha256: "whatever the attacker likes" }),
    );
    expect(discover(install)).toEqual({ outcome: "refused", reason: "payload-tampered" });
  });
});
