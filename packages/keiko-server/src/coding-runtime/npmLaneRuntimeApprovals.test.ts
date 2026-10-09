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
  SECURE_WORKSPACE_TEXT_READ_LEGACY_MAX_BYTES,
  SECURE_WORKSPACE_TEXT_READ_MAX_BYTES,
} from "./secureWorkspaceTextReadProtocol.js";

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

  it.each(Object.entries(NPM_LANE_RUNTIME_APPROVALS))(
    "%s keeps the previously approved helper's narrower capability and source identity",
    (target, approval) => {
      const previous =
        NPM_LANE_PREVIOUS_RUNTIME_APPROVALS[target as keyof typeof NPM_LANE_RUNTIME_APPROVALS];
      expect(approval.helperMaxBytes).toBe(SECURE_WORKSPACE_TEXT_READ_MAX_BYTES);
      expect(previous.helperMaxBytes).toBe(SECURE_WORKSPACE_TEXT_READ_LEGACY_MAX_BYTES);
      expect(previous.helperSourceCommit).toBe("98b77857ecb39e936269f875f8ade3688870629f");
      expect(previous.helperSourceTreeSha256).toBe(
        "97a7a11c6dc2e1512b976c846141e0459d26094097a77b822dc7b895ad3bb4aa",
      );
      expect(previous.helperSha256).not.toBe(approval.helperSha256);
      expect(previous.helperSourceTreeSha256).not.toBe(approval.helperSourceTreeSha256);
    },
  );
});
