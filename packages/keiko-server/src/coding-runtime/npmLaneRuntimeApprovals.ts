import { SECURE_WORKSPACE_TEXT_READ_MAX_BYTES } from "./secureWorkspaceTextReadProtocol.js";

// Trust anchor of the npm coding-runtime lane (#3577). An npm installation carries neither
// portable-runtime-approvals.json nor the helper source tree, so the digests the lane verifies
// against are compiled into the server: the runtime package can then never vouch for itself.
//
// The sidecar fields restate the review-approved catalog entry for the same target, and
// npmLaneRuntimeApprovals.test.ts fails when they stop agreeing with
// portable-runtime-approvals.json. The helper digests are the binaries
// scripts/build-coding-runtime-npm-package.mjs produced from `helperSourceTreeSha256`; the same test
// pins that source digest to native/secure-workspace-read, so a helper source change forces a rebuild
// and a new pin instead of silently shipping a stale helper.

export type NpmLaneOpenCodeTarget = "macos-arm64" | "macos-x64";

export interface NpmLaneRuntimeApproval {
  readonly packageName: string;
  readonly upstreamVersion: string;
  readonly adapterName: string;
  readonly adapterVersion: string;
  readonly executableTreeSha256: string;
  readonly licenseSha256: string;
  readonly protocolSchemaSha256: string;
  readonly sbomSha256: string;
  readonly helperSha256: string;
  readonly helperSizeBytes: number;
  readonly helperSourceCommit: string;
  readonly helperSourceTreeSha256: string;
  readonly helperMaxBytes?: number;
}

/** The helper both tables carry: an OpenCode upgrade leaves its source and binaries unchanged. */
const HELPER = {
  helperSourceCommit: "330a71436d0d739bac2cfe7f8dd4c577f6344cf9",
  helperMaxBytes: SECURE_WORKSPACE_TEXT_READ_MAX_BYTES,
  helperSourceTreeSha256: "88fb376091f406c3fa63c05d0f963d7ba038f650c0824f893ac77089bb30b28b",
} as const;

const HELPER_MACOS_ARM64 = {
  helperSha256: "1c758e0c05e90daac97ed6615ed4f6cc0a324c0304b5ea0d40417fdeb759b6a7",
  helperSizeBytes: 34_888,
} as const;

const HELPER_MACOS_X64 = {
  helperSha256: "2b722685dc1059a9eec75164e8f5157602a7802cf6a5b27da6f2a9fd78e07ac6",
  helperSizeBytes: 18_160,
} as const;

const SHARED = {
  ...HELPER,
  upstreamVersion: "2.2.5",
  adapterName: "keiko-coding-sidecar",
  adapterVersion: "2",
  licenseSha256: "625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b",
  protocolSchemaSha256: "92cc33ef9a107c8af6295e6fcbdf6d339d4374955910924456bd91a76844a5db",
} as const;

export const NPM_LANE_RUNTIME_APPROVALS: Readonly<
  Record<NpmLaneOpenCodeTarget, NpmLaneRuntimeApproval>
> = Object.freeze({
  "macos-arm64": Object.freeze({
    ...SHARED,
    ...HELPER_MACOS_ARM64,
    packageName: "@oscharko-dev/keiko-coding-runtime-darwin-arm64",
    executableTreeSha256: "034b678cefefdf60a007550915d7521a5d0ed0848c613562140a08d3837c62c4",
    sbomSha256: "ad9c8c0e1ae594a9cf84133c48fa131b05ec429b14fe6187a06a0127018cb2cf",
  }),
  "macos-x64": Object.freeze({
    ...SHARED,
    ...HELPER_MACOS_X64,
    packageName: "@oscharko-dev/keiko-coding-runtime-darwin-x64",
    executableTreeSha256: "d4792443ecee7527ba15c6a09a0799e68f9d6904bfe5022bdd1b15ac5eee7a87",
    sbomSha256: "1213a19896a2ce21f96a3510dee01bfce87ac93964430e5a2188654294794e1b",
  }),
});

/**
 * The immutable, already published 1.1.4 runtime packages remain usable during this upgrade: they
 * carry OpenCode 2.1.4, and ONLY those exact bytes are accepted for them, with their own
 * producer-derived protocol identity (`opencodeRuntimeVersions.ts`). Unknown or modified payloads
 * and helpers still fail closed. The table above describes the packages built from the current pin;
 * this one moves on when those are published and selected. Replacing it retired the 1.1.3 packages
 * and their OpenCode 2.0.10 (#3898, #3908, #4271).
 */
const PREVIOUS_SHARED = {
  ...HELPER,
  upstreamVersion: "2.1.4",
  adapterName: "keiko-coding-sidecar",
  adapterVersion: "2",
  licenseSha256: "625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b",
  protocolSchemaSha256: "4a01890f5810d71dca59ee39d9fb101c95f3bdf46332986a0bab0fa3885b68b9",
} as const;

export const NPM_LANE_PREVIOUS_RUNTIME_APPROVALS: Readonly<
  Record<NpmLaneOpenCodeTarget, NpmLaneRuntimeApproval>
> = Object.freeze({
  "macos-arm64": Object.freeze({
    ...PREVIOUS_SHARED,
    ...HELPER_MACOS_ARM64,
    packageName: "@oscharko-dev/keiko-coding-runtime-darwin-arm64",
    executableTreeSha256: "2ebf820d99c5df9d9097268f763ae406aceff555322dbd1fcb66f1ff2b85cff8",
    sbomSha256: "46af90a2e624a02324054671423799f4f2764909406072076e6fcada577f07e8",
  }),
  "macos-x64": Object.freeze({
    ...PREVIOUS_SHARED,
    ...HELPER_MACOS_X64,
    packageName: "@oscharko-dev/keiko-coding-runtime-darwin-x64",
    executableTreeSha256: "c29fb7e5a9593e8072f0694ca1156e761386901fb4f53ac527ca863d2d40eba0",
    sbomSha256: "a7e2315d8267eee066d7a5754d9332f1cd58ac1b9f4851fe29f0cc0116ce4e46",
  }),
});
