/**
 * Cross-package wire contracts for binding a shipped runtime to its qualification evidence.
 * Validation and launch policy remain owned by keiko-sandbox; these data shapes are shared by
 * the release producer, sandbox verifier, and server consumer.
 */
export type LongLivedRuntimePlatform = "darwin" | "linux" | "win32";
export type LongLivedRuntimeArchitecture = "arm64" | "x64";
export type LongLivedRuntimeBackend =
  | "linux-namespace-gateway"
  | "macos-app-sandbox"
  | "macos-endpoint-security"
  | "windows-job-object";

export interface LongLivedRuntimeQualification {
  readonly platform: LongLivedRuntimePlatform;
  readonly arch: LongLivedRuntimeArchitecture;
  readonly backend: LongLivedRuntimeBackend;
  readonly releaseReceipt: string;
}

export type RuntimeQualificationTarget = "linux-x64" | "windows-x64" | "macos-arm64" | "macos-x64";

export interface RuntimeQualificationSidecarDigest {
  readonly name: string;
  readonly sha256: string;
}

export interface RuntimeQualificationComponentDigest {
  readonly name: "node-runtime" | "primary-launcher" | "usearch";
  readonly sha256: string;
}

export interface RuntimeQualificationReceipt {
  readonly schemaVersion: 1 | 2;
  readonly suiteVersion: "runtime-tree-qualification-v1";
  readonly platformTarget: RuntimeQualificationTarget;
  readonly sourceCommitSha: string;
  readonly activationManifestSha256: string;
  readonly supervisorSha256: string;
  readonly secureReadSha256: string;
  readonly sidecars: readonly RuntimeQualificationSidecarDigest[];
  readonly runtimeComponents?: readonly RuntimeQualificationComponentDigest[];
  readonly backend: LongLivedRuntimeBackend;
  readonly result: "passed" | "failed";
}

export interface RuntimeQualificationReceiptBinding {
  readonly platformTarget: RuntimeQualificationTarget;
  readonly sourceCommitSha: string;
  readonly activationManifestSha256: string;
  readonly supervisorSha256: string;
  readonly secureReadSha256: string;
  readonly sidecars: readonly RuntimeQualificationSidecarDigest[];
  readonly runtimeComponents?: readonly RuntimeQualificationComponentDigest[];
}

export type RuntimeQualificationReceiptResult =
  | { readonly ok: true; readonly qualification: LongLivedRuntimeQualification }
  | { readonly ok: false; readonly reason: "runtime-unqualified" };
