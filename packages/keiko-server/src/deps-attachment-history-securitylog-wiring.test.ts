// Wiring test for `buildUiHandlerDeps`'s composition of the conversation-attachment store and the
// editor local-history store (Wave 4a, epic #3233 §8).
//
// WHAT THIS PINS
//
// Both stores' own `securityLogSink` → `createShardedLocalSecretVault` wiring is already pinned,
// with its own FAILS-BEFORE/PASSES-AFTER proof, in `conversation-attachment-store.test.ts` and
// `editor/localHistory/localHistoryStore.test.ts`. This file pins the ONE remaining link: that the
// real composition root (`deps.ts`'s `buildBaseUiHandlerDeps`) actually supplies
// `securityLogSink: processServerLogSink()` when building each store's production default — the
// same #3230-class regression (a port declared but never wired at composition) the other sites in
// this wave guard against.
//
// THE FAILURE THIS PINS: dropping either `securityLogSink: processServerLogSink()` line from
// `buildBaseUiHandlerDeps` (`deps.ts`) leaves the corresponding store silent on a forced
// shard-unreadable failure, and the matching assertion below fails.

import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildUiHandlerDeps } from "./deps.js";
import { inspectWorkspaceRootIdentity } from "./workspace-root-identity.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
} from "./observability/index.js";

const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

let sink: BufferedServerLogSink;

beforeEach(() => {
  sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
});

afterEach(() => {
  resetServerLogger();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Finds the ONE file under `root` whose name matches the sharded-vault filename shape
// (`entry-<hex>.sealed`) — avoids hard-coding either store's internal directory layout.
function findShardFile(root: string): string | undefined {
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && /^entry-[0-9a-f]+\.sealed$/u.test(entry.name)) {
      return join(entry.parentPath, entry.name);
    }
  }
  return undefined;
}

// Replaces a shard FILE with a DIRECTORY of the same name: the next read fails with EISDIR, a
// reason other than "absent" (ENOENT) — exactly what the sharded vault's own `readShardEnvelope`
// treats as "one unreadable entry" and reports on the sink, rather than treating it as never-set.
function corruptOneShard(root: string): void {
  const shardPath = findShardFile(root);
  if (shardPath === undefined) throw new Error("fixture wrote no shard file");
  rmSync(shardPath, { force: true });
  mkdirSync(shardPath);
}

describe("buildUiHandlerDeps — conversationAttachmentStore wires securityLogSink", () => {
  it("records shard-unreadable on server.log for a forced non-ENOENT shard failure", () => {
    const uiDir = tmp("deps-attach-secloG-");
    const evidenceDir = tmp("deps-attach-secloG-ev-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { KEIKO_UI_DATA_DIR: uiDir },
    });
    if (deps.conversationAttachmentStore === undefined) {
      throw new Error("production wiring did not build a conversationAttachmentStore");
    }
    try {
      const bytes = Buffer.from("PNGX");
      const binding = {
        sessionId: "session-1",
        sessionRotationCount: 0,
        projectPath: "/workspace/project",
        chatId: "chat-1",
        mimeType: "image/png",
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      const put = deps.conversationAttachmentStore.put({ ...binding, bytes });
      // The first write resolves the vault's key exactly once (memoized thereafter), so the
      // key-tier resolution's own `sink` wiring (gap g18, epic #3233 §8) is provable from the
      // same call that already proves the sharded vault's own sink above.
      expect(sink.events).toContainEqual(
        expect.objectContaining({ category: "security", op: "security.vault.key-resolved" }),
      );
      corruptOneShard(uiDir);

      expect(() => deps.conversationAttachmentStore?.resolve(put.ref, binding)).toThrow();
      expect(sink.events).toContainEqual(
        expect.objectContaining({ category: "security", op: "security.vault.shard-unreadable" }),
      );
    } finally {
      deps.store.close();
      deps.memoryVault?.close();
    }
  });
});

describe("buildUiHandlerDeps — editorLocalHistoryStore wires securityLogSink", () => {
  it("records shard-unreadable on server.log for a forced non-ENOENT shard failure", () => {
    const uiDir = tmp("deps-history-secloG-");
    const evidenceDir = tmp("deps-history-secloG-ev-");
    const workspaceRoot = tmp("deps-history-secloG-ws-");
    mkdirSync(join(workspaceRoot, "src"));
    writeFileSync(join(workspaceRoot, "src", "app.ts"), "initial\n", "utf8");
    const identity = inspectWorkspaceRootIdentity(workspaceRoot);
    if (identity.objectIdentityDigest === undefined) {
      throw new Error("fixture filesystem has no durable object identity");
    }

    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { KEIKO_UI_DATA_DIR: uiDir },
    });
    if (deps.editorLocalHistoryStore === undefined) {
      throw new Error("production wiring did not build an editorLocalHistoryStore");
    }
    try {
      const scope = {
        workspaceId: "workspace-deps-secloG-test",
        rootRef: identity.rootRef,
        rootIdentityDigest: identity.identityDigest,
        objectIdentityDigest: identity.objectIdentityDigest,
      };
      const absolutePath = join(workspaceRoot, "src", "app.ts");
      const captured = deps.editorLocalHistoryStore.capture({
        ...scope,
        realRoot: workspaceRoot,
        relativePath: "src/app.ts",
        absolutePath,
        content: "wired\n",
        origin: "user-save",
        nowMs: 1_000,
      }).entry;
      // The first capture resolves the vault's key exactly once (memoized thereafter), so the
      // key-tier resolution's own `sink` wiring (gap g18, epic #3233 §8) is provable from the same
      // call that already proves the sharded vault's own sink above.
      expect(sink.events).toContainEqual(
        expect.objectContaining({ category: "security", op: "security.vault.key-resolved" }),
      );
      corruptOneShard(uiDir);

      expect(() => deps.editorLocalHistoryStore?.read(scope, captured.entryRef, 2_000)).toThrow();
      expect(sink.events).toContainEqual(
        expect.objectContaining({ category: "security", op: "security.vault.shard-unreadable" }),
      );
    } finally {
      deps.store.close();
      deps.memoryVault?.close();
    }
  });
});
