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

export function requiredAssetName(target: UpdatePortableTarget): string {
  return UPDATE_PORTABLE_TARGET_ASSET_NAMES[target];
}

export function portableBlocker(
  code: UpdatePreflightBlocker["code"],
  message: string,
): UpdatePreflightBlocker {
  return blocker(code, message, "normal", true);
}
