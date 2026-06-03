// ADR-0017 D5 — side-file writer tests. Covers atomic O_EXCL, realpath containment, SHA-256, and
// the disallowed-name guard. The "pre-planted symlink at temp path" scenario is exercised by
// pointing the random suffix at a known location and pre-planting an absolute symlink there: the
// O_EXCL open must refuse rather than follow.

import { mkdtemp, mkdir, realpath, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSideFile } from "./side-file.js";
import { EvidenceWriteError, InvalidRunIdError } from "./errors.js";

let baseDir: string;
let outsideDir: string;

beforeEach(async () => {
  baseDir = await realpath(await mkdtemp(join(tmpdir(), "keiko-side-")));
  outsideDir = await realpath(await mkdtemp(join(tmpdir(), "keiko-side-out-")));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

describe("writeSideFile success", () => {
  it("writes the bytes, returns the relative path and a correct SHA-256", async () => {
    const data = Buffer.from("hello-screenshot-bytes");
    const result = writeSideFile(baseDir, "run123", "browser-1.png", data);
    expect(result.relativePath).toBe("browser-1.png");
    expect(result.bytes).toBe(data.length);
    expect(result.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    const onDisk = await readFile(join(baseDir, "run123", "browser-1.png"));
    expect(onDisk.equals(data)).toBe(true);
  });

  it("creates the per-run subdirectory if it does not exist", () => {
    const result = writeSideFile(baseDir, "run-fresh", "browser-1.png", Buffer.from("x"));
    expect(result.absolutePath).toContain("run-fresh");
  });

  it("multiple side-files for the same run live under the same subdir", async () => {
    writeSideFile(baseDir, "run-multi", "browser-1.png", Buffer.from("a"));
    writeSideFile(baseDir, "run-multi", "browser-2.png", Buffer.from("bb"));
    const one = await readFile(join(baseDir, "run-multi", "browser-1.png"));
    const two = await readFile(join(baseDir, "run-multi", "browser-2.png"));
    expect(one.toString()).toBe("a");
    expect(two.toString()).toBe("bb");
  });
});

describe("writeSideFile name and runId guards", () => {
  it.each([
    "",
    ".hidden",
    "../escape",
    "subdir/file.png",
    "back\\slash",
    "name with space",
    "evil\0",
  ])("rejects invalid name %s", (badName) => {
    expect(() => writeSideFile(baseDir, "run123", badName, Buffer.from("x"))).toThrow(
      EvidenceWriteError,
    );
  });

  it("rejects an invalid runId", () => {
    expect(() => writeSideFile(baseDir, "../escape", "browser-1.png", Buffer.from("x"))).toThrow(
      InvalidRunIdError,
    );
  });

  it("rejects a name that is too long", () => {
    const long = `${"a".repeat(200)}.png`;
    expect(() => writeSideFile(baseDir, "run123", long, Buffer.from("x"))).toThrow(
      EvidenceWriteError,
    );
  });
});

describe("writeSideFile containment", () => {
  it("refuses to follow a symlink whose target escapes the per-run subdir", async () => {
    const runDir = join(baseDir, "run-sym");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(outsideDir, "victim.png"), Buffer.from("OWNED"));
    try {
      await symlink(join(outsideDir, "victim.png"), join(runDir, "browser-1.png"));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    // The pre-planted target is a symlink to outside; the O_EXCL "wx" temp write would refuse if
    // someone pre-planted a symlink at the TEMP path. Here we exercise the realpath check on the
    // FINAL target: the final basename "browser-1.png" already exists as a symlink, so realpath of
    // the final basename resolves outside. assertContainedRealPath must throw.
    expect(() =>
      writeSideFile(baseDir, "run-sym", "browser-1.png", Buffer.from("clean")),
    ).toThrow();
    // The outside victim must remain unchanged.
    const after = await readFile(join(outsideDir, "victim.png"));
    expect(after.toString()).toBe("OWNED");
  });

  it("O_EXCL refuses a pre-planted symlink at the temp path", async () => {
    const runDir = join(baseDir, "run-temp");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(outsideDir, "victim.png"), Buffer.from("OWNED"));
    const fixedSuffix = "ATTACKER";
    const tempPath = join(runDir, `browser-1.png.${fixedSuffix}.tmp`);
    try {
      await symlink(join(outsideDir, "victim.png"), tempPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    expect(() =>
      writeSideFile(baseDir, "run-temp", "browser-1.png", Buffer.from("clean"), {
        randomSuffix: () => fixedSuffix,
      }),
    ).toThrow(EvidenceWriteError);
    const after = await readFile(join(outsideDir, "victim.png"));
    expect(after.toString()).toBe("OWNED");
  });

  it("refuses a path that lexically escapes via concatenation (name is a single segment)", () => {
    expect(() => writeSideFile(baseDir, "run-x", "../escape.png", Buffer.from("x"))).toThrow(
      EvidenceWriteError,
    );
  });
});

describe("writeSideFile evidenceSchemaVersion contract", () => {
  it("never imports or mutates the manifest schema (sanity: side-file module is self-contained)", () => {
    // Surface-level check: result fields are the additive manifest payload only; no schema version
    // is exposed by this module.
    const result = writeSideFile(baseDir, "run-v", "browser-1.png", Buffer.from("x"));
    expect(Object.keys(result).sort()).toEqual(
      ["absolutePath", "bytes", "relativePath", "sha256"].sort(),
    );
  });
});
