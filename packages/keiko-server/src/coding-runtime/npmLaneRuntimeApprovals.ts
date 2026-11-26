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

/**
 * The patched Node.js a Windows package carries for its confined verification steps (#4492,
 * ADR-0043 D21): the official 26.13.1 source plus libuv#5181, built by
 * `.github/workflows/windows-step-node.yml`. Official 26.13.1 bundles libuv 1.52.1, whose unique
 * child-pipe names hang `node --test`, forks and piped children inside an AppContainer. The pin
 * restates what that build's receipt records, so the binary can never vouch for itself.
 */
export interface NpmLaneStepNodeApproval {
  readonly sha256: string;
  readonly sizeBytes: number;
  /** SHA-256 of the official `node-v26.13.1.tar.gz` the binary was built from. */
  readonly sourceSha256: string;
  /** SHA-256 of each patch applied to that source, in the order they were applied. */
  readonly patchSha256s: readonly string[];
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
  /** Windows only; a step without a verified step Node.js runs as before (ADR-0043 D21). */
  readonly stepNode?: NpmLaneStepNodeApproval;
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
  sha256: "d45a4d8d6bcb51d8de1130fd002e28f2371701649b8dd89071cabff1261864c8",
  sizeBytes: 255_488,
  sourceTreeSha256: "57054c1e9614341b41b66146c4f2ba08b13bff0979f1db920c6d17e29f57060b",
});

// CI run 45777530612 of windows-step-node.yml (artifact keiko-step-node-windows-x64-26.13.1-libuv-5181).
// A newer build replaces it by re-pinning these constants and nothing else.
const STEP_NODE_WINDOWS_X64_SHA256 =
  "61547f93cc5f92870d7e67e8847c6b3da05d6978fb9d9713a0551ed358dd8fd7";
const STEP_NODE_WINDOWS_X64_SIZE_BYTES = 100_574_720;

const STEP_NODE_WINDOWS_X64: NpmLaneStepNodeApproval = Object.freeze({
  sha256: STEP_NODE_WINDOWS_X64_SHA256,
  sizeBytes: STEP_NODE_WINDOWS_X64_SIZE_BYTES,
  // node-v26.13.1.tar.gz, from https://nodejs.org/dist/v26.13.1/SHASUMS256.txt
  sourceSha256: "60c6cdf11c3e9d5932fccd0eafae77f1152661584e129047684cb8646f228d3e",
  patchSha256s: Object.freeze([
    // patches/node-26.13.1-libuv-5181.patch
    "8549a84f23e812688b12ab6de8cd5b6f2cb82aaa3d754ebbe3cd6527c67bd387",
    // patches/node-26.13.1-win-crates-synchronization.patch
    "4370d95801980482c98693d3ca0ba178b69897f89c7851c5b5c0ea5025e5eacc",
  ]),
});

const SHARED = {
  ...HELPER,
  upstreamVersion: "2.4.1",
  adapterName: "keiko-coding-sidecar",
  adapterVersion: "2",
  licenseSha256: "625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b",
  protocolSchemaSha256: "e5603c6115d74e3f47b5823187a3395aef013bcec3cf42db42bf30433550f92b",
} as const;

export const NPM_LANE_RUNTIME_APPROVALS: Readonly<
  Record<NpmLaneOpenCodeTarget, NpmLaneRuntimeApproval>
> = Object.freeze({
  "macos-arm64": Object.freeze({
    ...SHARED,
    ...HELPER_MACOS_ARM64,
    packageName: "@oscharko-dev/keiko-coding-runtime-darwin-arm64",
    executableTreeSha256: "dd29f79df0af9b1ce293465f2ff1e2dfb4e740872509d75b23c4948dd4d72131",
    sbomSha256: "900f6be50d4f1a9b4a7292d48bcce37dbda9314265dc78d997f9cda10df73e25",
  }),
  "macos-x64": Object.freeze({
    ...SHARED,
    ...HELPER_MACOS_X64,
    packageName: "@oscharko-dev/keiko-coding-runtime-darwin-x64",
    executableTreeSha256: "4c93d7ebdb8deee2805770c2682eb938fb1ab91c710d77c5b2bf703ebe1ad836",
    sbomSha256: "1f4174f86c396d95c2461f10a8dd871b5e8fbeacdfc269b76067982103cee497",
  }),
  "windows-x64": Object.freeze({
    ...SHARED,
    ...HELPER_WINDOWS_X64,
    packageName: "@oscharko-dev/keiko-coding-runtime-win32-x64",
    executableTreeSha256: "2849500e72a3a421e86fa2b07a0e72c98dd3358e05ae5c8522e1772083dc31c1",
    sbomSha256: "795f198efa475a69338173215605dd52609bb45b3a2bf470da6cbccffc52cbf0",
    runtimeSupervisor: RUNTIME_SUPERVISOR_WINDOWS_X64,
    stepNode: STEP_NODE_WINDOWS_X64,
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
  stepNode: STEP_NODE_WINDOWS_X64,
});

/**
 * The executable-tree digests of retired runtime packages: 1.1.4 (OpenCode 2.1.4) and the packages
 * that carry OpenCode 2.2.5 (darwin 1.1.5, win32 1.1.7). They approve nothing: Keiko runs exactly
 * one OpenCode, the current pin, so these packages are refused. The digests only let discovery tell
 * an installation that still holds one of them ("update Keiko") from a payload that was tampered
 * with (#4359, #4546).
 */
export const NPM_LANE_RETIRED_EXECUTABLE_TREES: ReadonlySet<string> = new Set([
  "2ebf820d99c5df9d9097268f763ae406aceff555322dbd1fcb66f1ff2b85cff8",
  "c29fb7e5a9593e8072f0694ca1156e761386901fb4f53ac527ca863d2d40eba0",
  // OpenCode 2.2.5: macos-arm64, macos-x64, windows-x64.
  "034b678cefefdf60a007550915d7521a5d0ed0848c613562140a08d3837c62c4",
  "d4792443ecee7527ba15c6a09a0799e68f9d6904bfe5022bdd1b15ac5eee7a87",
  "90c59877d8fd7b0d25279bb926194f6cc1a356421d380d54eeb29646ef32046e",
]);
