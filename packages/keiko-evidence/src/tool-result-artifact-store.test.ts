import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createNodeToolResultArtifactStore, TOOL_RESULT_ARTIFACT_SUFFIX } from "./tool-result-artifact-store.js";

const ARTIFACT_ID = "a".repeat(64);

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "keiko-tool-artifacts-"));
}

describe("createNodeToolResultArtifactStore", () => {
  it("writes and reads a private text artifact by sha256 id", () => {
    const baseDir = join(tempRoot(), ".keiko", "evidence");
    const store = createNodeToolResultArtifactStore(baseDir, {
      randomSuffix: (): string => "fixed-token",
    });

    store.write(ARTIFACT_ID, "stdout\nstderr\n");

    expect(store.read(ARTIFACT_ID)).toBe("stdout\nstderr\n");
    expect(store.location(ARTIFACT_ID)).toContain(`${ARTIFACT_ID}${TOOL_RESULT_ARTIFACT_SUFFIX}`);
    expect(statSync(join(baseDir, "tool-results")).mode & 0o777).toBe(0o700);
    expect(statSync(store.location(ARTIFACT_ID)).mode & 0o777).toBe(0o600);
  });

  it("returns undefined for a missing artifact", () => {
    const store = createNodeToolResultArtifactStore(join(tempRoot(), ".keiko", "evidence"));
    expect(store.read(ARTIFACT_ID)).toBeUndefined();
  });

  it("rejects path-like or non-hash artifact ids", () => {
    const store = createNodeToolResultArtifactStore(join(tempRoot(), ".keiko", "evidence"));
    expect(() => {
      store.write("../escape", "x");
    }).toThrow(/artifactId/);
    expect(() => {
      store.read("A".repeat(64));
    }).toThrow(/disallowed/);
  });

  it("refuses a symlinked tool-results sub-store directory", () => {
    if (process.platform === "win32") return;
    const root = tempRoot();
    const baseDir = join(root, ".keiko", "evidence");
    const outside = join(root, "outside");
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "marker"), "outside", "utf8");
    try {
      symlinkSync(outside, join(baseDir, "tool-results"), "dir");
      const store = createNodeToolResultArtifactStore(baseDir);
      expect(() => { store.write(ARTIFACT_ID, "clean"); }).toThrow(/symlink/);
      expect(() => readFileSync(join(outside, `${ARTIFACT_ID}${TOOL_RESULT_ARTIFACT_SUFFIX}`)))
        .toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
