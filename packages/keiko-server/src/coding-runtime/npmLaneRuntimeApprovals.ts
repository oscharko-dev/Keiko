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
}

const SHARED = {
  upstreamVersion: "2.0.10",
  adapterName: "keiko-coding-sidecar",
  adapterVersion: "2",
  licenseSha256: "625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b",
  protocolSchemaSha256: "1362671d8cfdcb925b3a9fd61eaa20152e4c587746445a0b03504674b25c88ec",
  helperSourceCommit: "98b77857ecb39e936269f875f8ade3688870629f",
  helperSourceTreeSha256: "97a7a11c6dc2e1512b976c846141e0459d26094097a77b822dc7b895ad3bb4aa",
} as const;

export const NPM_LANE_RUNTIME_APPROVALS: Readonly<
  Record<NpmLaneOpenCodeTarget, NpmLaneRuntimeApproval>
> = Object.freeze({
  "macos-arm64": Object.freeze({
    ...SHARED,
    packageName: "@oscharko-dev/keiko-coding-runtime-darwin-arm64",
    executableTreeSha256: "3b54ba4d809b06ddcbdd87862593c160ad5d96fffcea944000227a9e0785c8fe",
    sbomSha256: "99a6c65ad998b01362c9f2d1e2412643bf19df8e912a9fac8b31e05e38e0ece5",
    helperSha256: "d5640f16bfa39433905c9da81614c4256c972f6b0515f0c647dc7ae0946b8e39",
    helperSizeBytes: 34_504,
  }),
  "macos-x64": Object.freeze({
    ...SHARED,
    packageName: "@oscharko-dev/keiko-coding-runtime-darwin-x64",
    executableTreeSha256: "df5ade313d45afb848c6ce2f5634c62f47ad0fa8f7c889e9cbd58f6903632710",
    sbomSha256: "e6aec95fa10da6afc27f8116960c80f37ae6fb49be8d908f8fb12139c2795bbf",
    helperSha256: "65bbbd0af34e44969d17ec70cf0caedbef87de87fb676b4a8c8ef753556444fd",
    helperSizeBytes: 13_664,
  }),
});
