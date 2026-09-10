import { describe, expect, it } from "vitest";
import {
  firstClassArchiveSetComplete,
  type GitHubAsset,
} from "./update-preflight-portable-shared.js";

function asset(name: string, id: number): GitHubAsset {
  return {
    id,
    name,
    size: 1,
    downloadUrl: `https://github.com/oscharko-dev/Keiko/releases/download/v0.3.17/${name}`,
  };
}

const LEGACY_ARCHIVES = [
  "keiko-windows-x64.zip",
  "keiko-macos-arm64.zip",
  "keiko-macos-x64.zip",
] as const;

describe("portable release archive-set compatibility", () => {
  it("accepts historic three-target releases and the current four-target release", () => {
    const legacy = LEGACY_ARCHIVES.map(asset);
    const current = [asset("keiko-linux-x64.zip", 4), ...legacy];

    expect(firstClassArchiveSetComplete(legacy)).toBe(true);
    expect(firstClassArchiveSetComplete(current)).toBe(true);
  });

  it("rejects partial, duplicated, and unknown portable archive sets", () => {
    const partial = LEGACY_ARCHIVES.slice(1).map(asset);
    const duplicated = [...LEGACY_ARCHIVES, LEGACY_ARCHIVES[0]].map(asset);
    const unknown = [...LEGACY_ARCHIVES, "keiko-freebsd-x64.zip"].map(asset);

    expect(firstClassArchiveSetComplete([])).toBe(false);
    expect(firstClassArchiveSetComplete(partial)).toBe(false);
    expect(firstClassArchiveSetComplete(duplicated)).toBe(false);
    expect(firstClassArchiveSetComplete(unknown)).toBe(false);
  });
});
