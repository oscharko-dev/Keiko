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

export type NpmLaneOpenCodeTarget = "macos-arm64" | "macos-x64" | "windows-x64";

/**
 * The Job Object supervisor a Windows package carries (#4068). Windows runs are launched through it
 * and confined by the installed D18 broker, which is pinned to this digest (ADR-0043 D19).
 */
export interface NpmLaneRuntimeSupervisorApproval {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly sourceTreeSha256: string;
}

export interface CodingRuntimeArtifactApproval {
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
  /** Required on Windows, absent elsewhere; a Windows approval without it is refused. */
  readonly runtimeSupervisor?: NpmLaneRuntimeSupervisorApproval;
}

export interface NpmLaneRuntimeApproval extends CodingRuntimeArtifactApproval {
  readonly packageName: string;
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

// The Windows release build (owner decision 2026-11-17, "Ja, umstellen"): the portable release's
// secure-read image, built by the release workflow with `/Brepro` from the unchanged helper source
// tree. The npm package and the desktop package carry the same Windows helper and supervisor bytes.
// The 1.5.4 release build (`d88ac1cb8…`, runner image windows-2025-vs2026 20261116) produced these
// bytes; the earlier image's `65cc98c3…` (129,024 bytes, built at `1906b6a5f28a…`) no longer
// matched what a release ships, so 1.5.4's Windows Workbench refused to start (#4068). The release
// build now stops when its helpers differ from these pins (scripts/stage-portable-runtime.mjs).
// The local MSVC 14.44 build (`1318171b…`) and `65cc98c3…` approve nothing any more. `65cc98c3…` is
// the helper of the npm runtime package 1.1.6, which Keiko 1.5.4 approves and this version refuses.
const HELPER_WINDOWS_X64 = {
  helperSha256: "8699612eabadc70f95ab969ed259edca8b18a5381c2c577acd2ca835c226ac64",
  helperSizeBytes: 128_512,
  helperSourceCommit: "d88ac1cb81652776af37590014afb8482d3cb764",
} as const;

const RUNTIME_SUPERVISOR_WINDOWS_X64: NpmLaneRuntimeSupervisorApproval = Object.freeze({
  sha256: "8966ba374943d8b0f7dce4bdee296084802783cda0e4a191666a0c4cd16616fb",
  sizeBytes: 252_416,
  sourceTreeSha256: "718efc73bdf3327c5db2eb9e294d10cfdc91a2afedeadab3db9560b535419f86",
});

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
  "windows-x64": Object.freeze({
    ...SHARED,
    ...HELPER_WINDOWS_X64,
    packageName: "@oscharko-dev/keiko-coding-runtime-win32-x64",
    executableTreeSha256: "90c59877d8fd7b0d25279bb926194f6cc1a356421d380d54eeb29646ef32046e",
    sbomSha256: "320b03dca2e27a8d9afc6a6bf2d1b4b903f6c5340f25202f20aa7dd104573493",
    runtimeSupervisor: RUNTIME_SUPERVISOR_WINDOWS_X64,
  }),
});

/**
 * The Windows desktop artifact set (#4404), independently authenticated with the existing
 * portable-release key. Its supervisor, secure-read image and OpenCode are the same approved bytes
 * as the npm lane (one set of Windows native bytes for both install kinds, 2026-11-17).
 * Source: v1.5.4/windows-x64-portable-manifest.json, commit
 * d88ac1cb81652776af37590014afb8482d3cb764. The release build refuses to stage helpers that differ
 * from these pins. These pins permit the existing functional broker lane; they are not Authenticode
 * or platform-qualification evidence.
 */
export const WINDOWS_PORTABLE_RUNTIME_APPROVAL: CodingRuntimeArtifactApproval = Object.freeze({
  ...SHARED,
  ...HELPER_WINDOWS_X64,
  executableTreeSha256: NPM_LANE_RUNTIME_APPROVALS["windows-x64"].executableTreeSha256,
  sbomSha256: NPM_LANE_RUNTIME_APPROVALS["windows-x64"].sbomSha256,
  runtimeSupervisor: RUNTIME_SUPERVISOR_WINDOWS_X64,
});

/**
 * The executable-tree digests of the retired 1.1.4 runtime packages (OpenCode 2.1.4). They approve
 * nothing: Keiko runs exactly one OpenCode, the current pin, so these packages are refused. The
 * digests only let discovery tell an installation that still holds one of them ("update Keiko")
 * from a payload that was tampered with (#4359).
 */
export const NPM_LANE_RETIRED_EXECUTABLE_TREES: ReadonlySet<string> = new Set([
  "2ebf820d99c5df9d9097268f763ae406aceff555322dbd1fcb66f1ff2b85cff8",
  "c29fb7e5a9593e8072f0694ca1156e761386901fb4f53ac527ca863d2d40eba0",
]);
