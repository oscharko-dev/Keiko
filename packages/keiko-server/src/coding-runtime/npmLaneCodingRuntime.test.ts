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
  type DevLaneOpenCodeDiscovery,
} from "./devLanePortableCodingRuntime.js";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import type { NpmLaneRuntimeApproval } from "./npmLaneRuntimeApprovals.js";

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
    protocolSchemaSha256: "a".repeat(64),
    sbomSha256: sha256(SBOM),
    helperSha256: sha256(HELPER),
    helperSizeBytes: HELPER.length,
    helperSourceCommit: "b".repeat(40),
    helperSourceTreeSha256: "c".repeat(64),
  };
}

function globalInstall(options: { readonly withRuntimePackage?: boolean } = {}): GlobalInstall {
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
