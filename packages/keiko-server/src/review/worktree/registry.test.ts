// The review root registry (Issue #4133): serialized atomic updates, owner-private files, and a
// malformed file quarantined rather than parsed leniently.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewRegistry } from "./registry.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-review-registry-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const RECORD = { leaf: "r-0123456789abcdef01234567", repositoryRoot: "/repo", createdAtMs: 1 };

describe("review registry", () => {
  it("serializes concurrent updates without losing records", async () => {
    const registry = createReviewRegistry(root);
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        registry.update((snapshot) => ({
          ...snapshot,
          refs: [
            ...snapshot.refs,
            {
              ref: `refs/keiko-review/local/r-${String(index).padStart(24, "0")}`,
              repositoryRoot: "/repo",
              createdAtMs: index,
            },
          ],
        })),
      ),
    );
    expect((await registry.read()).refs).toHaveLength(10);
    if (process.platform !== "win32") {
      expect(statSync(join(root, "registry.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("quarantines a malformed or tampered registry and starts empty", async () => {
    for (const content of [
      "{not json",
      JSON.stringify({ version: 2, worktrees: [], refs: [] }),
      JSON.stringify({ version: 1, worktrees: [{ ...RECORD, leaf: "../escape" }], refs: [] }),
      JSON.stringify({
        version: 1,
        worktrees: [],
        refs: [{ ref: "refs/heads/main", repositoryRoot: "/r", createdAtMs: 0 }],
      }),
      JSON.stringify({
        version: 1,
        worktrees: [{ ...RECORD, repositoryRoot: "relative" }],
        refs: [],
      }),
    ]) {
      writeFileSync(join(root, "registry.json"), content);
      expect(await createReviewRegistry(root).read()).toEqual({ worktrees: [], refs: [] });
    }
    expect(
      readdirSync(root).filter((name) => name.startsWith("registry.json.invalid-")),
    ).toHaveLength(5);
  });

  it("round-trips valid records", async () => {
    const registry = createReviewRegistry(root);
    await registry.update(() => ({ worktrees: [RECORD], refs: [] }));
    expect(await registry.read()).toEqual({ worktrees: [RECORD], refs: [] });
  });
});
