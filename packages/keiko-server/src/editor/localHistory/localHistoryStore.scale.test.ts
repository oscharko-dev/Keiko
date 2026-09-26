// GEN-PERF-PERSISTENCE-002 + GEN-PERF-BENCHMARK-010: capture() sits on the interactive save path,
// so what one capture writes must be a function of THAT checkpoint and not of everything already
// stored (#2616). Mechanism proof, not wall-clock: both durable writers in this store — the sharded
// vault and savePrivateJson — commit by renaming a temp file over its target, so intercepting
// renameSync and sizing the temp gives the exact byte count each capture commits, per file.
//
// The pre-fix layout held every checkpoint body in one `checkpoints.vault`, so a capture re-serialised
// and re-wrote the whole encrypted store; these assertions fail against it by construction.
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorLocalHistoryOrigin } from "@oscharko-dev/keiko-contracts";
import { inspectWorkspaceRootIdentity } from "../../workspace-root-identity.js";
import {
  createEditorLocalHistoryStore,
  editorLocalHistoryWorkspaceId,
  type EditorLocalHistoryRootScope,
} from "./localHistoryStore.js";

const commits = vi.hoisted(() => [] as { path: string; bytes: number }[]);

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    renameSync: (from: string, to: string): void => {
      let bytes: number;
      try {
        bytes = actual.statSync(from).size;
      } catch {
        bytes = 0;
      }
      commits.push({ path: to, bytes });
      actual.renameSync(from, to);
    },
  };
});

const VAULT_KEY = Buffer.alloc(32, 0x51).toString("base64");
const BODY_SEGMENT = `${sep}checkpoints${sep}`;
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  commits.length = 0;
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
  tmpDirs.push(dir);
  return dir;
}

interface Fixture {
  readonly root: string;
  readonly stateDir: string;
  readonly scope: EditorLocalHistoryRootScope;
}

function fixture(): Fixture {
  const root = tempDir("keiko-local-history-scale-root-");
  const stateDir = tempDir("keiko-local-history-scale-state-");
  mkdirSync(join(root, "src"));
  const identity = inspectWorkspaceRootIdentity(root);
  if (identity.objectIdentityDigest === undefined) {
    throw new Error("fixture filesystem has no durable object identity");
  }
  return {
    root,
    stateDir,
    scope: {
      workspaceId: editorLocalHistoryWorkspaceId(identity.rootRef),
      rootRef: identity.rootRef,
      rootIdentityDigest: identity.identityDigest,
      objectIdentityDigest: identity.objectIdentityDigest,
    },
  };
}

type Store = ReturnType<typeof createEditorLocalHistoryStore>;

function openStore(fx: Fixture): Store {
  return createEditorLocalHistoryStore({
    stateDir: fx.stateDir,
    env: { KEIKO_EDITOR_LOCAL_HISTORY_KEY: VAULT_KEY },
    limits: { coalesceMs: 0 },
  });
}

function capture(store: Store, fx: Fixture, name: string, content: string, nowMs: number): void {
  const absolutePath = join(fx.root, "src", name);
  writeFileSync(absolutePath, content, "utf8");
  store.capture({
    ...fx.scope,
    realRoot: fx.root,
    relativePath: `src/${name}`,
    absolutePath,
    content,
    origin: "user-save" satisfies EditorLocalHistoryOrigin,
    nowMs,
  });
}

function measure(work: () => void): { readonly body: number; readonly total: number } {
  commits.length = 0;
  work();
  const body = commits
    .filter((commit) => commit.path.includes(BODY_SEGMENT))
    .reduce((total, commit) => total + commit.bytes, 0);
  const total = commits.reduce((sum, commit) => sum + commit.bytes, 0);
  return { body, total };
}

describe("editor local-history capture write cost", () => {
  it("writes one checkpoint body regardless of how much history is already stored", () => {
    const small = fixture();
    const large = fixture();
    const smallStore = openStore(small);
    const largeStore = openStore(large);
    for (let index = 0; index < 8; index += 1) {
      capture(smallStore, small, `seed-${String(index)}.ts`, "s".repeat(64), 1_000 + index);
      capture(largeStore, large, `seed-${String(index)}.ts`, "L".repeat(64_000), 1_000 + index);
    }

    const newContent = "n".repeat(512);
    const smallCost = measure(() => {
      capture(smallStore, small, "fresh.ts", newContent, 9_000);
    });
    const largeCost = measure(() => {
      capture(largeStore, large, "fresh.ts", newContent, 9_000);
    });

    // The body commit is the sealed payload for THIS checkpoint alone, so a store holding 500 KiB
    // of history pays exactly what a store holding 512 bytes pays.
    expect(smallCost.body).toBeGreaterThan(newContent.length);
    expect(largeCost.body).toBe(smallCost.body);
    // Whole-store cost is dominated by the bounded metadata index, never by stored plaintext: the
    // 8 x 64 KiB store must not commit anything close to the 512 KiB it holds.
    expect(largeCost.total).toBeLessThan(64_000);
  });

  it("keeps the per-capture body commit flat as the store fills toward its entry bound", () => {
    const fx = fixture();
    const store = openStore(fx);
    const content = "c".repeat(1_024);

    const first = measure(() => {
      capture(store, fx, "first.ts", content, 1_000);
    });
    for (let index = 0; index < 60; index += 1) {
      capture(store, fx, `filler-${String(index)}.ts`, content, 2_000 + index);
    }
    const last = measure(() => {
      capture(store, fx, "last.ts", content, 9_000);
    });

    expect(last.body).toBe(first.body);
  });
});
