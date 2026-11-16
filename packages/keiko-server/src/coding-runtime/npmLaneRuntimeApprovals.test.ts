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
  it("adds the authenticated public Windows artifact without changing the npm image", () => {
    expect(WINDOWS_PORTABLE_RUNTIME_APPROVAL).toMatchObject({
      helperSha256: "65cc98c377f0e82494c54a1dd68a5be85fcd7b80272679638579aff23f4ab9e6",
      helperSizeBytes: 129_024,
      helperSourceCommit: "1906b6a5f28a4ec51fa93a18a3affade7194a126",
      helperSourceTreeSha256: "88fb376091f406c3fa63c05d0f963d7ba038f650c0824f893ac77089bb30b28b",
      upstreamVersion: "2.2.5",
      adapterName: "keiko-coding-sidecar",
      adapterVersion: "2",
      executableTreeSha256: "90c59877d8fd7b0d25279bb926194f6cc1a356421d380d54eeb29646ef32046e",
      licenseSha256: "625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b",
      protocolSchemaSha256: "92cc33ef9a107c8af6295e6fcbdf6d339d4374955910924456bd91a76844a5db",
      sbomSha256: "320b03dca2e27a8d9afc6a6bf2d1b4b903f6c5340f25202f20aa7dd104573493",
      runtimeSupervisor: {
        sha256: "888130331e49b71d3c29f81cdb0dbae97f4c062d9eea4914a576ee06a8bada52",
        sizeBytes: 237_056,
        sourceTreeSha256: "ab0ad9d08504dc28eb81acdf6e4869bd69200eeebc83771df60085330ca27748",
      },
    });
    expect(NPM_LANE_RUNTIME_APPROVALS["windows-x64"].helperSha256).toBe(
      "1318171b0544702ef5f0f9f201084767b3182279c99012278812a5dfe27ede4d",
    );
    expect(WINDOWS_PORTABLE_RUNTIME_APPROVAL.runtimeSupervisor).toBe(
      NPM_LANE_RUNTIME_APPROVALS["windows-x64"].runtimeSupervisor,
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
