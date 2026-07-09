import {
  UPDATE_PORTABLE_TARGET_ASSET_NAMES,
  type UpdatePreflightBlocker,
  type UpdatePortableTarget,
} from "@oscharko-dev/keiko-contracts";
import { blocker } from "./update-preflight-impact.js";

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

const REQUIRED_TARGETS: readonly UpdatePortableTarget[] = [
  "windows-x64",
  "macos-arm64",
  "macos-x64",
];

export function requiredAssetName(target: UpdatePortableTarget): string {
  return UPDATE_PORTABLE_TARGET_ASSET_NAMES[target];
}

export function firstClassArchiveSetComplete(assets: readonly GitHubAsset[]): boolean {
  const expected = new Set(REQUIRED_TARGETS.map(requiredAssetName));
  const archiveNames = assets
    .map((asset) => asset.name)
    .filter((name) => /^keiko-[a-z0-9-]+\.zip$/u.test(name));
  return archiveNames.length === expected.size && archiveNames.every((name) => expected.has(name));
}

export function portableBlocker(
  code: UpdatePreflightBlocker["code"],
  message: string,
): UpdatePreflightBlocker {
  return blocker(code, message, "normal", true);
}
