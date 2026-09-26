import type { UpdatePreflightReleaseSource } from "./update-preflight.js";
import type {
  UpdateInstallModeKind,
  UpdateInstallPackageManager,
  UpdatePortableSidecarSummary,
  UpdatePortableTarget,
} from "./update-session.js";

export const UPDATE_CANDIDATE_SCHEMA_VERSION = "1" as const;

export interface UpdateCandidateClaim {
  readonly schemaVersion: typeof UPDATE_CANDIDATE_SCHEMA_VERSION;
  readonly candidateId: string;
  readonly targetVersion: string;
  readonly confirmationDigest: string;
  readonly executionToken: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface UpdateCandidateInstallIdentity {
  readonly packageName: string;
  readonly installKind: UpdateInstallModeKind;
  readonly packageManager?: UpdateInstallPackageManager | undefined;
  readonly portableTarget?: UpdatePortableTarget | undefined;
  readonly installIdentitySha256: string;
}

export interface UpdateCandidateReleaseIdentity {
  readonly source: UpdatePreflightReleaseSource;
  readonly tag: string;
}

export interface UpdateCandidatePortableIdentity {
  readonly target: UpdatePortableTarget;
  readonly releaseId: number;
  readonly assetId: number;
  readonly assetName: string;
  readonly sizeBytes: number;
  readonly uncompressedSizeBytes: number;
  readonly sha256: string;
  readonly manifestAssetName: string;
  readonly manifestAssetId: number;
  readonly manifestSizeBytes: number;
  readonly manifestSha256: string;
  readonly checksumAssetName: string;
  readonly checksumAssetId: number;
  readonly checksumSizeBytes: number;
  readonly checksumSha256: string;
  readonly checksumVerified: boolean;
  readonly sidecarRuntimes?: readonly UpdatePortableSidecarSummary[] | undefined;
}

export interface UpdateCandidateSnapshot {
  readonly schemaVersion: typeof UPDATE_CANDIDATE_SCHEMA_VERSION;
  readonly candidateId: string;
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly channel: "stable";
  readonly install: UpdateCandidateInstallIdentity;
  readonly release: UpdateCandidateReleaseIdentity;
  readonly releaseImpactDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly portable?: UpdateCandidatePortableIdentity | undefined;
}
