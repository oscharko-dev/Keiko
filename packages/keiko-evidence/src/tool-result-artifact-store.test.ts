import {
  linkSync,
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

import {
  createNodeToolResultArtifactStore,
  TOOL_RESULT_ARTIFACT_SUFFIX,
} from "./tool-result-artifact-store.js";

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

  it("rejects an artifact id containing a supplementary-plane character", () => {
    // "😀" (U+1F600) is a 2-code-unit surrogate pair in UTF-16, so this keeps artifactId.length at
    // exactly 64 while the last two code units are the lone surrogate halves — neither of which is
    // ASCII lower-hex. Regression guard for the charCodeAt -> codePointAt rename: both surrogate
    // halves must still be rejected as disallowed characters, same as before the rename.
    const store = createNodeToolResultArtifactStore(join(tempRoot(), ".keiko", "evidence"));
    const artifactIdWithEmoji = `${"a".repeat(62)}😀`;
    expect(artifactIdWithEmoji).toHaveLength(64);
    expect(() => {
      store.read(artifactIdWithEmoji);
    }).toThrow(/disallowed/);
  });

  it("refuses a symlinked tool-results sub-store directory", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const root = tempRoot();
    const baseDir = join(root, ".keiko", "evidence");
    const outside = join(root, "outside");
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "marker"), "outside", "utf8");
    try {
      symlinkSync(outside, join(baseDir, "tool-results"), "dir");
      const store = createNodeToolResultArtifactStore(baseDir);
      expect(() => {
        store.write(ARTIFACT_ID, "clean");
      }).toThrow(/symlink/);
      expect(() =>
        readFileSync(join(outside, `${ARTIFACT_ID}${TOOL_RESULT_ARTIFACT_SUFFIX}`)),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // KEIKO-0272: the single-hard-link guard (isSingleLinkRegularFile via fs-safety) is present in
  // production. The sibling side-file store has a hardlink test; this one did not. If a future
  // refactor drops the guard here — or the shared helper's hard-link check ever regresses — a
  // hardlinked outside file would be silently clobbered by a write, and the read path would happily
  // return its contents. Both paths must fail closed.
  it("refuses to write or read through a hardlink at the artifact target (KEIKO-0272)", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const root = tempRoot();
    const baseDir = join(root, ".keiko", "evidence");
    const outside = join(root, "outside");
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const victimPath = join(outside, "victim");
    const victimContent = "victim-original-content";
    writeFileSync(victimPath, victimContent, "utf8");
    try {
      const store = createNodeToolResultArtifactStore(baseDir, {
        randomSuffix: (): string => "fixed-token",
      });
      // Force the artifact directory to exist so we can plant a hardlink inside it.
      store.write(ARTIFACT_ID, "seed-content");
      // Overwrite the freshly-written artifact with a hardlink to the victim file. Now the target
      // path has nlink === 2 and points at content the ledger did NOT write.
      const artifactPath = store.location(ARTIFACT_ID);
      rmSync(artifactPath, { force: true });
      linkSync(victimPath, artifactPath);
      expect(statSync(artifactPath).nlink).toBeGreaterThan(1);

      expect(() => {
        store.write(ARTIFACT_ID, "attempted-overwrite");
      }).toThrow(/non-ledger tool-result artifact/);
      expect(() => {
        store.read(ARTIFACT_ID);
      }).toThrow(/non-ledger tool-result artifact/);
      // Victim content stayed untouched.
      expect(readFileSync(victimPath, "utf8")).toBe(victimContent);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
