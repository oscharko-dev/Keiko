// #4492: the lock of the acceptance task's Maven cache covers every .pom and .jar, and a cache that
// differs from it in any way is reported.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cachedArtifacts, lockFor, lockMismatches } from "../provision-acceptance-maven.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cacheWith(files) {
  const root = mkdtempSync(join(tmpdir(), "keiko-provision-maven-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe("provision-acceptance-maven lock", () => {
  it("covers every pom and jar, and nothing else, in a stable order", () => {
    const cache = cacheWith({
      "b/b-1.jar": "jar",
      "a/a-1.pom": "pom",
      "a/a-1.pom.sha1": "ignored",
      "a/_remote.repositories": "ignored",
    });
    expect(cachedArtifacts(cache)).toEqual(["a/a-1.pom", "b/b-1.jar"]);
    expect(lockFor(cache)).toEqual({
      schemaVersion: 1,
      files: {
        "a/a-1.pom": createHash("sha256").update("pom").digest("hex"),
        "b/b-1.jar": createHash("sha256").update("jar").digest("hex"),
      },
    });
  });

  it("reports a missing, altered and unlisted file, and nothing for a matching cache", () => {
    const cache = cacheWith({ "a/a-1.pom": "pom", "b/b-1.jar": "jar" });
    const lock = lockFor(cache);
    expect(lockMismatches(cache, lock)).toEqual([]);
    writeFileSync(join(cache, "a/a-1.pom"), "altered");
    writeFileSync(join(cache, "c-1.jar"), "extra");
    const missing = { ...lock, files: { ...lock.files, "gone-1.jar": "00" } };
    expect(lockMismatches(cache, missing)).toEqual([
      "digest differs: a/a-1.pom",
      "missing: gone-1.jar",
      "not in the lock: c-1.jar",
    ]);
  });
});
