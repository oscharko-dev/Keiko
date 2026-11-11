import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { hashHelperSourceTree } from "./devLanePortableCodingRuntime.js";
import {
  NPM_LANE_PREVIOUS_RUNTIME_APPROVALS,
  NPM_LANE_RUNTIME_APPROVALS,
} from "./npmLaneRuntimeApprovals.js";
import {
  OPENCODE_PINNED_VERSION,
  OPENCODE_RUNTIME_VERSION_PINS,
} from "./opencodeRuntimeVersions.js";
import { SECURE_WORKSPACE_TEXT_READ_MAX_BYTES } from "./secureWorkspaceTextReadProtocol.js";

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

  it.each(Object.entries(NPM_LANE_RUNTIME_APPROVALS))(
    "%s approves the current and the published previous runtime and no other",
    (target, approval) => {
      const previous =
        NPM_LANE_PREVIOUS_RUNTIME_APPROVALS[target as keyof typeof NPM_LANE_RUNTIME_APPROVALS];
      expect(approval.upstreamVersion).toBe(OPENCODE_PINNED_VERSION);
      // No Windows package was ever published, so nothing earlier may be approved for it (#4068).
      if (target === "windows-x64") {
        expect(previous).toBeUndefined();
        return;
      }
      if (previous === undefined) throw new TypeError(`no previous approval for ${target}`);
      expect(previous.upstreamVersion).toBe(OPENCODE_RUNTIME_VERSION_PINS[1]?.version);
      expect(previous.executableTreeSha256).not.toBe(approval.executableTreeSha256);
      expect(previous.protocolSchemaSha256).not.toBe(approval.protocolSchemaSha256);
      expect(previous.helperMaxBytes).toBe(SECURE_WORKSPACE_TEXT_READ_MAX_BYTES);
      for (const entry of [approval, previous]) {
        expect(entry.helperSourceTreeSha256).not.toBe(RETIRED_HELPER_SOURCE_TREE_SHA256);
      }
    },
  );
});
