export const SAFE_ARTIFACT_DIRECTORY_MUTATION_OPERATIONS = ["link", "rename", "unlink"] as const;

export type SafeArtifactDirectoryMutationOperation =
  (typeof SAFE_ARTIFACT_DIRECTORY_MUTATION_OPERATIONS)[number];

export const MAX_SAFE_ARTIFACT_DIRECTORY_MUTATION_PROTOCOL_BYTES = 4_096;

export interface SafeArtifactDirectoryMutationRequest {
  readonly operation: SafeArtifactDirectoryMutationOperation;
  readonly expectedDev: string;
  readonly expectedIno: string;
  readonly source: string;
  readonly target?: string;
  /** Required for unlink: the entry is removed only while its name still has this identity. */
  readonly expectedEntryDev?: string;
  readonly expectedEntryIno?: string;
}

export const SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT = {
  success: 0,
  invalidInput: 20,
  directoryMismatch: 21,
  targetExists: 22,
  unsupported: 23,
  failed: 24,
  entryMismatch: 25,
} as const;
