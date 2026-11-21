import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { hashHelperSourceTree } from "./devLanePortableCodingRuntime.js";
import {
  NPM_LANE_RETIRED_EXECUTABLE_TREES,
  NPM_LANE_RUNTIME_APPROVALS,
  WINDOWS_PORTABLE_RUNTIME_APPROVAL,
} from "./npmLaneRuntimeApprovals.js";
import {
  OPENCODE_PINNED_VERSION,
  OPENCODE_RUNTIME_VERSION_PINS,
} from "./opencodeRuntimeVersions.js";

/** The helper source of the retired 1.1.3 packages, which no table may approve again. */
const RETIRED_HELPER_SOURCE_TREE_SHA256 =
  "97a7a11c6dc2e1512b976c846141e0459d26094097a77b822dc7b895ad3bb4aa";

// The npm lane's trust anchor is compiled into the server because an npm installation carries
// neither the approvals catalog nor the helper source. That copy must never drift from the
// review-approved catalog: a digest that differs here would either refuse the approved runtime or,
// worse, approve one nobody reviewed.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

interface CatalogRuntime {
  readonly name: string;
  readonly upstream: { readonly version: string };
  readonly adapterCompatibility: { readonly adapterName: string; readonly adapterVersion: string };
  readonly license: { readonly sha256: string };
  readonly protocolSchema: { readonly sha256: string };
  readonly releaseApproval: { readonly redistribution: { readonly status: string } };
  readonly archives: Record<string, { executableTreeSha256: string; sbomSha256: string }>;
}

function approvedRuntime(): CatalogRuntime {
  const catalog = JSON.parse(
    readFileSync(join(repoRoot, "portable-runtime-approvals.json"), "utf8"),
  ) as { sidecarRuntimes: CatalogRuntime[] };
  const runtime = catalog.sidecarRuntimes.find((entry) => entry.name === "opencode-compatible");
  if (runtime === undefined) throw new TypeError("the approvals catalog lists no OpenCode runtime");
  return runtime;
}

describe("npm-lane runtime approvals", () => {
  // Owner decision 2026-11-17 ("Ja, umstellen"): the npm lane carries the portable release's Windows
  // helper instead of a separate local build, so both install kinds share one set of native bytes.
  it("pins one set of Windows native bytes for the npm and the desktop package", () => {
    expect(WINDOWS_PORTABLE_RUNTIME_APPROVAL).toMatchObject({
      // #4068: the bytes the 1.5.4 release build actually shipped (runner image windows-2025-vs2026
      // 20261116); the release build now refuses to stage helpers that differ from this pin.
      helperSha256: "8699612eabadc70f95ab969ed259edca8b18a5381c2c577acd2ca835c226ac64",
      helperSizeBytes: 128_512,
      helperSourceCommit: "d88ac1cb81652776af37590014afb8482d3cb764",
      helperSourceTreeSha256: "88fb376091f406c3fa63c05d0f963d7ba038f650c0824f893ac77089bb30b28b",
      upstreamVersion: "2.2.5",
      adapterName: "keiko-coding-sidecar",
      adapterVersion: "2",
      executableTreeSha256: "90c59877d8fd7b0d25279bb926194f6cc1a356421d380d54eeb29646ef32046e",
      licenseSha256: "625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b",
      protocolSchemaSha256: approvedRuntime().protocolSchema.sha256,
      sbomSha256: "320b03dca2e27a8d9afc6a6bf2d1b4b903f6c5340f25202f20aa7dd104573493",
      runtimeSupervisor: {
        // #4068: the pipe-relay supervisor (no installed service), built by MSVC 14.51 on
        // windows-latest exactly as the release builds it.
        sha256: "8966ba374943d8b0f7dce4bdee296084802783cda0e4a191666a0c4cd16616fb",
        sizeBytes: 252_416,
        sourceTreeSha256: "718efc73bdf3327c5db2eb9e294d10cfdc91a2afedeadab3db9560b535419f86",
      },
    });
    const npm = NPM_LANE_RUNTIME_APPROVALS["windows-x64"];
    for (const field of [
      "helperSha256",
      "helperSizeBytes",
      "helperSourceCommit",
      "helperSourceTreeSha256",
    ] as const) {
      expect(npm[field], field).toBe(WINDOWS_PORTABLE_RUNTIME_APPROVAL[field]);
    }
    expect(WINDOWS_PORTABLE_RUNTIME_APPROVAL.runtimeSupervisor).toBe(npm.runtimeSupervisor);
    // The retired local MSVC 14.44 build approves nothing any more, and neither does the earlier
    // runner image's build that no release can reproduce (#4068).
    for (const retired of [
      "1318171b0544702ef5f0f9f201084767b3182279c99012278812a5dfe27ede4d",
      "65cc98c377f0e82494c54a1dd68a5be85fcd7b80272679638579aff23f4ab9e6",
    ]) {
      expect(npm.helperSha256).not.toBe(retired);
    }
    // The service-brokered supervisor that needed an administrator approves nothing any more.
    expect(npm.runtimeSupervisor?.sha256).not.toBe(
      "888130331e49b71d3c29f81cdb0dbae97f4c062d9eea4914a576ee06a8bada52",
    );
  });
  it.each(Object.entries(NPM_LANE_RUNTIME_APPROVALS))(
    "%s restates the review-approved catalog entry exactly",
    (target, approval) => {
      const runtime = approvedRuntime();
      expect(runtime.releaseApproval.redistribution.status).toBe("approved");
      expect({
        upstreamVersion: approval.upstreamVersion,
        adapterName: approval.adapterName,
        adapterVersion: approval.adapterVersion,
        executableTreeSha256: approval.executableTreeSha256,
        licenseSha256: approval.licenseSha256,
        protocolSchemaSha256: approval.protocolSchemaSha256,
        sbomSha256: approval.sbomSha256,
      }).toStrictEqual({
        upstreamVersion: runtime.upstream.version,
        adapterName: runtime.adapterCompatibility.adapterName,
        adapterVersion: runtime.adapterCompatibility.adapterVersion,
        executableTreeSha256: runtime.archives[target]?.executableTreeSha256,
        licenseSha256: runtime.license.sha256,
        protocolSchemaSha256: runtime.protocolSchema.sha256,
        sbomSha256: runtime.archives[target]?.sbomSha256,
      });
    },
  );

  it("pins helpers built from the helper source this repository carries", () => {
    const current = hashHelperSourceTree(join(repoRoot, "native", "secure-workspace-read"));
    for (const approval of Object.values(NPM_LANE_RUNTIME_APPROVALS)) {
      // A helper source change must rebuild the runtime packages
      // (scripts/build-coding-runtime-npm-package.mjs) and re-pin their digests here.
      expect(approval.helperSourceTreeSha256).toBe(current);
    }
  });

  // #4068: Windows runs launch through the Job Object supervisor the package carries, and the
  // installed broker is pinned to its digest, so that digest must describe the source this
  // repository carries, and only Windows may name a supervisor at all.
  it("pins the Windows supervisor built from the supervisor source this repository carries", () => {
    const current = hashHelperSourceTree(join(repoRoot, "native", "runtime-supervisor", "windows"));
    expect(NPM_LANE_RUNTIME_APPROVALS["windows-x64"].runtimeSupervisor?.sourceTreeSha256).toBe(
      current,
    );
    expect(NPM_LANE_RUNTIME_APPROVALS["macos-arm64"].runtimeSupervisor).toBeUndefined();
    expect(NPM_LANE_RUNTIME_APPROVALS["macos-x64"].runtimeSupervisor).toBeUndefined();
  });

  // #4359: Keiko admits exactly one OpenCode. The retired 1.1.4 packages (2.1.4) approve nothing;
  // their executable trees are only recognised so the person is told to update.
  it.each(Object.entries(NPM_LANE_RUNTIME_APPROVALS))(
    "%s approves the current runtime only and refuses the retired helper source",
    (_target, approval) => {
      expect(approval.upstreamVersion).toBe(OPENCODE_PINNED_VERSION);
      expect(OPENCODE_RUNTIME_VERSION_PINS).toHaveLength(1);
      expect(NPM_LANE_RETIRED_EXECUTABLE_TREES.has(approval.executableTreeSha256)).toBe(false);
      expect(approval.helperSourceTreeSha256).not.toBe(RETIRED_HELPER_SOURCE_TREE_SHA256);
    },
  );

  it("names the two retired 1.1.4 executable trees and nothing else", () => {
    expect([...NPM_LANE_RETIRED_EXECUTABLE_TREES].sort()).toEqual([
      "2ebf820d99c5df9d9097268f763ae406aceff555322dbd1fcb66f1ff2b85cff8",
      "c29fb7e5a9593e8072f0694ca1156e761386901fb4f53ac527ca863d2d40eba0",
    ]);
  });
});
