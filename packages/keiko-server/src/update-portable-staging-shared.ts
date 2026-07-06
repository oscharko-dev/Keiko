import { createHash } from "node:crypto";
import type { EnvSource, GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import {
  type UpdateInstallMode,
  type UpdatePortableSidecarSummary,
  type UpdatePortableStagingSummary,
  type UpdatePortableTarget,
  type UpdateSessionFailureReason,
} from "@oscharko-dev/keiko-contracts";
import { isRecord } from "./update-preflight-registry.js";
import type { UpdateRuntimeFacts } from "./update-install-mode.js";
import type { UpdateLocalStateManager } from "./update-local-state.js";

export type GatewayEgressConfig = NonNullable<GatewayConfig["egress"]>;

export const RELEASE_URL = "https://api.github.com/repos/oscharko-dev/keiko/releases/latest";
export const PACKAGE_NAME = "@oscharko-dev/keiko";
export const PORTABLE_STAGE_DIR_PREFIX = ".keiko-portable-updates";
export const PORTABLE_PAYLOAD_ROOT = "Keiko";
export const MAX_RELEASE_METADATA_BYTES = 256_000;
export const MAX_PORTABLE_MANIFEST_BYTES = 256_000;
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
export const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 60_000;
export const MAX_INFLATE_RATIO = 100;
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
export const HEX_SHA256 = /^[a-f0-9]{64}$/u;
export const COMMIT_SHA = /^[a-f0-9]{40}$/u;

export interface GitHubAsset {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly downloadUrl: string;
}

export interface PortableRelease {
  readonly id: number;
  readonly targetVersion: string;
  readonly assets: readonly GitHubAsset[];
}

export interface TextAsset {
  readonly text: string;
  readonly sha256: string;
}

export interface PortableUpdateStageInput {
  readonly sessionId: string;
  readonly targetVersion: string;
  readonly installMode: UpdateInstallMode;
  readonly runtimeFacts?: UpdateRuntimeFacts | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface PortableUpdateStager {
  readonly stage: (input: PortableUpdateStageInput) => Promise<UpdatePortableStagingSummary>;
}

export interface PortableUpdateStagerOptions {
  readonly env: EnvSource;
  readonly localState?: UpdateLocalStateManager | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly egress?: (() => GatewayEgressConfig | undefined) | undefined;
}

export class PortableUpdateStagingError extends Error {
  public constructor(
    public readonly reason: UpdateSessionFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "PortableUpdateStagingError";
  }
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function stageIdFor(sessionId: string, targetVersion: string, sha256: string): string {
  return createHash("sha256")
    .update(`${sessionId}:${targetVersion}:${sha256}`)
    .digest("hex")
    .slice(0, 32);
}

export function runtimeFor(target: UpdatePortableTarget): {
  readonly platform: string;
  readonly arch: string;
} {
  if (target === "windows-x64") return { platform: "win32", arch: "x64" };
  if (target === "macos-arm64") return { platform: "darwin", arch: "arm64" };
  return { platform: "darwin", arch: "x64" };
}

export function primaryLauncher(target: UpdatePortableTarget): string {
  return target === "windows-x64" ? "Keiko.exe" : "Keiko.app";
}

export function signatureKind(target: UpdatePortableTarget): string {
  return target === "windows-x64" ? "authenticode" : "developer-id-notarized";
}

export function recordAt(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
}

export function fieldEquals(
  record: Record<string, unknown> | undefined,
  key: string,
  expected: unknown,
): boolean {
  return record?.[key] === expected;
}

export function digestField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && HEX_SHA256.test(value) ? value : undefined;
}

export function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function manifestArchiveSha(manifest: Record<string, unknown>): string | undefined {
  return digestField(recordAt(manifest, "artifact"), "sha256");
}

export function assertAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new PortableUpdateStagingError("cancelled", "cancelled");
}

export function portableStageSummary(input: {
  readonly stageId: string;
  readonly release: PortableRelease;
  readonly archive: GitHubAsset;
  readonly target: UpdatePortableTarget;
  readonly sha256: string;
  readonly manifestSha256: string;
  readonly sidecarRuntimes: readonly UpdatePortableSidecarSummary[];
}): UpdatePortableStagingSummary {
  return {
    stageId: input.stageId,
    status: "staged",
    target: input.target,
    packageVersion: input.release.targetVersion,
    assetName: input.archive.name,
    assetId: input.archive.id,
    releaseId: input.release.id,
    sizeBytes: input.archive.size,
    sha256: input.sha256,
    manifestSha256: input.manifestSha256,
    ...(input.sidecarRuntimes.length > 0 ? { sidecarRuntimes: input.sidecarRuntimes } : {}),
  };
}
