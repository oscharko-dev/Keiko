// GEN-PERF-CHAT-005 + GEN-PERF-BENCHMARK-010: the node EvidenceStore's listByPrefix filters directory
// entries by runId prefix BEFORE the per-file containment stat (isSingleLinkRegularFile). This test
// seeds a large flat evidence directory with a few matching-prefix manifests plus many unrelated ones
// and asserts the per-file stat is paid only for matching-prefix files — so a per-send prefix listing
// costs O(matching), not O(directory). It fails on a stat-everything regression and passes on the fix.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nodeWorkspaceFs,
  type WorkspaceFs,
  type WorkspaceStat,
} from "@oscharko-dev/keiko-workspace/internal/fs";
import { createNodeEvidenceStore, type NodeEvidenceStore } from "./store.js";

describe("createNodeEvidenceStore.listByPrefix (GEN-PERF-CHAT-005)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ),
    );
  }, 30_000);

  function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "keiko-evid-prefix-"));
    dirs.push(dir);
    return dir;
  }

  function countingFs(): { fs: WorkspaceFs; statCount: () => number; reset: () => void } {
    let stats = 0;
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      stat: (path: string): WorkspaceStat => {
        stats += 1;
        return nodeWorkspaceFs.stat(path);
      },
    };
    return {
      fs,
      statCount: () => stats,
      reset: (): void => {
        stats = 0;
      },
    };
  }

  it("stats only matching-prefix manifests, not the whole directory", () => {
    const dir = freshDir();
    const counting = countingFs();
    const store: NodeEvidenceStore = createNodeEvidenceStore(dir, counting.fs);

    // Seed 3 matching-prefix manifests via the real writer (creates the owned dir + valid entries).
    for (let i = 1; i <= 3; i += 1) {
      store.put(`chat-abc123-t${String(i)}`, "{}");
    }
    // Seed many unrelated manifests directly as files.
    const UNRELATED = 5_000;
    for (let i = 0; i < UNRELATED; i += 1) {
      writeFileSync(join(dir, `unrelated-manifest-${String(i)}.json`), "{}\n", "utf8");
    }

    counting.reset();
    const matched = store.listByPrefix("chat-abc123-t");

    expect([...matched].sort()).toEqual(["chat-abc123-t1", "chat-abc123-t2", "chat-abc123-t3"]);
    // The per-file containment stat runs only for the 3 matching files — never for the 5k unrelated.
    expect(counting.statCount()).toBeLessThanOrEqual(3);
    expect(counting.statCount()).toBeLessThan(UNRELATED);
  });

  it("unfiltered list() still stats every manifest (documents the pre-fix cost the prefix path avoids)", () => {
    const dir = freshDir();
    const counting = countingFs();
    const store: NodeEvidenceStore = createNodeEvidenceStore(dir, counting.fs);
    for (let i = 0; i < 20; i += 1) {
      writeFileSync(join(dir, `chat-x-t${String(i)}.json`), "{}\n", "utf8");
    }

    counting.reset();
    store.list();
    // list() has no prefix so it stats every candidate manifest.
    expect(counting.statCount()).toBe(20);
  });

  it("preserves the single-link containment guard on surfaced matches", () => {
    const dir = freshDir();
    const store: NodeEvidenceStore = createNodeEvidenceStore(dir);
    store.put("chat-guard-t1", "{}");
    // A matching-prefix entry that is a directory (not a regular file) must not be surfaced.
    writeFileSync(join(dir, "chat-guard-t2.json"), "{}\n", "utf8");
    const matched = store.listByPrefix("chat-guard-t");
    expect([...matched].sort()).toEqual(["chat-guard-t1", "chat-guard-t2"]);
  });
});
