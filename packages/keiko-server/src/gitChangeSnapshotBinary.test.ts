import { describe, expect, it } from "vitest";
import type { GitProcessResult, GitProcessRunner } from "@oscharko-dev/keiko-git";
import { resolveSnapshotBinaryFiles } from "./gitChangeSnapshotBinary.js";
import type { GitSnapshotReader, SnapshotRevisions } from "./gitChangeSnapshotReader.js";
import type { SnapshotFileMetadata } from "./gitChangeSnapshotMetadata.js";

const OLD_OBJECT = "a".repeat(40);
const NEW_OBJECT = "b".repeat(40);
const ZERO_OBJECT = "0".repeat(40);
const REVISIONS: SnapshotRevisions = {
  baseSha: "1".repeat(40),
  headSha: "2".repeat(40),
  mergeBaseSha: "3".repeat(40),
};

function meta(overrides: Partial<SnapshotFileMetadata> = {}): SnapshotFileMetadata {
  return {
    path: "file.bin",
    change: "modify",
    oldMode: "100644",
    newMode: "100644",
    oldObjectId: OLD_OBJECT,
    newObjectId: NEW_OBJECT,
    additions: 0,
    deletions: 0,
    binary: false,
    ...overrides,
  };
}

function ok(stdout: string): GitProcessResult {
  return { exitCode: 0, signal: null, stdout, stderr: "", truncated: false };
}

function reader(runner: GitProcessRunner): GitSnapshotReader {
  return { cwd: "/repo", runner, signal: new AbortController().signal, timeoutMs: 5_000 };
}

describe("resolveSnapshotBinaryFiles: empty input", () => {
  it("never invokes the runner for an empty metadata list", async () => {
    const runner: GitProcessRunner = () => {
      throw new Error("must not be called");
    };
    expect(await resolveSnapshotBinaryFiles(reader(runner), [], 10, REVISIONS)).toEqual([]);
  });
});

describe("resolveSnapshotBinaryFiles: boundary — maxFiles", () => {
  it("checks only the first maxFiles entries, passing the remainder through untouched", async () => {
    const runner: GitProcessRunner = async (args) => {
      if (args[0] === "cat-file" && args[2] === OLD_OBJECT) return ok("text content\n");
      if (args[0] === "cat-file" && args[2] === NEW_OBJECT) return ok("text content\n");
      throw new Error(`unexpected invocation past the cap: ${args.join(" ")}`);
    };
    const checked = meta({ path: "checked.txt" });
    const untouched = meta({ path: "untouched.bin", binary: true });
    const result = await resolveSnapshotBinaryFiles(reader(runner), [checked, untouched], 1, REVISIONS);
    expect(result[0]?.binary).toBe(false);
    expect(result[1]).toBe(untouched);
  });

  it("never probes an empty-object (add) or gitlink side, whatever its object id", async () => {
    const calls: string[] = [];
    const runner: GitProcessRunner = async (args) => {
      if (args[0] !== "cat-file") throw new Error(`unexpected non-cat-file call: ${args.join(" ")}`);
      const objectId = args[2] ?? "";
      if (objectId === ZERO_OBJECT) throw new Error("must not probe the empty object");
      calls.push(objectId);
      return ok("plain text\n");
    };
    const added = meta({ path: "new.txt", oldObjectId: ZERO_OBJECT, additions: 1 });
    // Both sides carry a real (non-zero) object id here — the gitlink mode alone must skip them.
    const submodule = meta({ path: "vendor", oldMode: "160000", newMode: "160000" });
    const result = await resolveSnapshotBinaryFiles(
      reader(runner),
      [added, submodule],
      2,
      REVISIONS,
    );
    expect(result[0]?.binary).toBe(false);
    expect(result[1]?.binary).toBe(false);
    expect(calls).toEqual([NEW_OBJECT]);
  });
});

describe("resolveSnapshotBinaryFiles: hostile — binary masquerading as text", () => {
  it("reclassifies a NUL-bearing blob as binary and zeroes its numstat statistics", async () => {
    const runner: GitProcessRunner = async (args) => {
      if (args[2] === OLD_OBJECT) return ok("plain text\n");
      if (args[2] === NEW_OBJECT) return ok("binary\0payload");
      throw new Error(`unexpected invocation: ${args.join(" ")}`);
    };
    const entry = meta({ additions: 4, deletions: 1, binary: false });
    const [result] = await resolveSnapshotBinaryFiles(reader(runner), [entry], 10, REVISIONS);
    expect(result?.binary).toBe(true);
    expect(result?.additions).toBe(0);
    expect(result?.deletions).toBe(0);
  });

  it("recovers true statistics for content force-marked binary by .gitattributes", async () => {
    const patch = ["diff --git a/file.bin b/file.bin", "@@ -0,0 +1,2 @@", "+line one", "+line two"].join(
      "\n",
    );
    const runner: GitProcessRunner = async (args) => {
      if (args[0] === "cat-file") return ok("plain text, no NUL byte here\n");
      if (args.includes("diff")) return ok(patch);
      throw new Error(`unexpected invocation: ${args.join(" ")}`);
    };
    const entry = meta({ additions: 0, deletions: 0, binary: true });
    const [result] = await resolveSnapshotBinaryFiles(reader(runner), [entry], 10, REVISIONS);
    expect(result?.binary).toBe(false);
    expect(result?.additions).toBe(2);
    expect(result?.deletions).toBe(0);
  });
});

describe("resolveSnapshotBinaryFiles: malformed statistics-repair lane", () => {
  it("fails closed when the repair patch has no section for a reclassified entry", async () => {
    const runner: GitProcessRunner = async (args) => {
      if (args[0] === "cat-file") return ok("plain text, no NUL byte here\n");
      if (args.includes("diff")) return ok("");
      throw new Error(`unexpected invocation: ${args.join(" ")}`);
    };
    const entry = meta({ binary: true });
    await expect(resolveSnapshotBinaryFiles(reader(runner), [entry], 10, REVISIONS)).rejects.toThrow(
      "Git snapshot read failed",
    );
  });

  it("fails closed when the repair patch's own header cannot be parsed", async () => {
    const runner: GitProcessRunner = async (args) => {
      if (args[0] === "cat-file") return ok("plain text, no NUL byte here\n");
      if (args.includes("diff")) return ok("diff --git badheader\n@@ -0,0 +1,1 @@\n+x");
      throw new Error(`unexpected invocation: ${args.join(" ")}`);
    };
    const entry = meta({ binary: true });
    await expect(resolveSnapshotBinaryFiles(reader(runner), [entry], 10, REVISIONS)).rejects.toThrow(
      "Git snapshot read failed",
    );
  });
});
