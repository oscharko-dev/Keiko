import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createShardedLocalSecretVault,
  type LocalSecretVault,
} from "@oscharko-dev/keiko-security/secret-vault";
import type { EditorLocalHistoryOrigin } from "@oscharko-dev/keiko-contracts";
import { inspectWorkspaceRootIdentity } from "../../workspace-root-identity.js";
import {
  createEditorLocalHistoryStore,
  type EditorLocalHistoryCaptureInput,
  type EditorLocalHistoryRootScope,
} from "./localHistoryStore.js";

const VAULT_KEY = Buffer.alloc(32, 0x63).toString("base64");
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readAllFiles(dir: string): readonly string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));
}

function bodyFiles(stateDir: string): readonly string[] {
  const historyRoot = join(stateDir, "editor-local-history");
  const workspaceDir = join(historyRoot, readdirSync(historyRoot)[0] ?? "missing");
  return readdirSync(join(workspaceDir, "checkpoints"));
}

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
  tmpDirs.push(dir);
  return dir;
}

function fixture(): {
  readonly root: string;
  readonly stateDir: string;
  readonly scope: EditorLocalHistoryRootScope;
} {
  const root = tempDir("keiko-local-history-root-");
  const stateDir = tempDir("keiko-local-history-state-");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "app.ts"), "initial\n", "utf8");
  const identity = inspectWorkspaceRootIdentity(root);
  return {
    root,
    stateDir,
    scope: {
      workspaceId: "workspace-local-history-test",
      rootRef: identity.rootRef,
      rootIdentityDigest: identity.identityDigest,
    },
  };
}

function captureInput(
  fx: ReturnType<typeof fixture>,
  content: string,
  origin: EditorLocalHistoryOrigin,
  nowMs: number,
  relativePath = "src/app.ts",
): EditorLocalHistoryCaptureInput {
  const absolutePath = join(fx.root, ...relativePath.split("/"));
  writeFileSync(absolutePath, content, "utf8");
  return {
    ...fx.scope,
    realRoot: fx.root,
    relativePath,
    absolutePath,
    content,
    origin,
    nowMs,
  };
}

function storeOptions(fx: ReturnType<typeof fixture>): {
  readonly stateDir: string;
  readonly env: { readonly KEIKO_EDITOR_LOCAL_HISTORY_KEY: string };
} {
  return { stateDir: fx.stateDir, env: { KEIKO_EDITOR_LOCAL_HISTORY_KEY: VAULT_KEY } };
}

describe("editor local-history store", () => {
  it("persists origin-labeled encrypted checkpoints and reopens exact content", () => {
    const fx = fixture();
    const store = createEditorLocalHistoryStore(storeOptions(fx));
    const contents = ["save one\n", "save two\n", "save three\n", "agent result\n"];
    const origins: readonly EditorLocalHistoryOrigin[] = [
      "user-save",
      "user-save",
      "user-save",
      "agent-apply",
    ];
    const refs = contents.map(
      (content, index) =>
        store.capture(
          captureInput(fx, content, origins[index] ?? "user-save", 1_000 + index * 2_000),
        ).entry.entryRef,
    );

    const reopened = createEditorLocalHistoryStore(storeOptions(fx));
    expect(reopened.list(fx.scope, "src/app.ts", 10_000).map((entry) => entry.origin)).toEqual([
      "agent-apply",
      "user-save",
      "user-save",
      "user-save",
    ]);
    expect(refs.map((ref) => reopened.read(fx.scope, ref, 10_000).content)).toEqual(contents);

    // Encryption-at-rest pin, widened from the single vault file to EVERY file the store writes:
    // sharding checkpoint bodies (#2616) multiplied the places a plaintext leak could hide, so the
    // pin now walks the whole history tree instead of naming one path.
    const stored = readAllFiles(join(fx.stateDir, "editor-local-history"));
    expect(stored.length).toBeGreaterThan(contents.length);
    for (const bytes of stored) {
      for (const content of contents) expect(bytes).not.toContain(content.trim());
    }
  });

  it("coalesces only rapid identical saves", () => {
    const fx = fixture();
    const store = createEditorLocalHistoryStore(storeOptions(fx));
    const first = store.capture(captureInput(fx, "same\n", "user-save", 1_000));
    const duplicate = store.capture(captureInput(fx, "same\n", "user-save", 1_500));
    const differentOrigin = store.capture(captureInput(fx, "same\n", "agent-apply", 1_600));

    expect(duplicate).toMatchObject({ coalesced: true, entry: { entryRef: first.entry.entryRef } });
    expect(differentOrigin.coalesced).toBe(false);
    expect(store.list(fx.scope, "src/app.ts", 1_700)).toHaveLength(2);
  });

  it("prunes oldest-first for byte and per-file limits while protecting pins and TTL", () => {
    const fx = fixture();
    for (const path of ["a.ts", "b.ts", "c.ts", "d.ts"]) writeFileSync(join(fx.root, path), "x");
    const store = createEditorLocalHistoryStore({
      ...storeOptions(fx),
      limits: { maxTotalBytes: 9, maxVersionsPerFile: 2, ttlMs: 100, coalesceMs: 0 },
    });
    const first = store.capture(captureInput(fx, "aaa", "user-save", 1_000, "a.ts")).entry;
    const second = store.capture(captureInput(fx, "bbb", "user-save", 1_010, "b.ts")).entry;
    const third = store.capture(captureInput(fx, "ccc", "user-save", 1_020, "c.ts")).entry;
    store.setPinned(fx.scope, first.entryRef, true, 1_030);
    store.read(fx.scope, third.entryRef, 1_040);
    store.capture(captureInput(fx, "ddd", "user-save", 1_050, "d.ts"));

    const retained = store.list(fx.scope, undefined, 1_060);
    expect(retained.map((entry) => entry.entryRef)).not.toContain(second.entryRef);
    expect(retained.map((entry) => entry.entryRef)).toContain(first.entryRef);
    expect(store.list(fx.scope, undefined, 1_200)).toEqual([
      expect.objectContaining({ entryRef: first.entryRef, pinned: true }),
    ]);

    const perFile = createEditorLocalHistoryStore({
      ...storeOptions(fx),
      limits: { maxVersionsPerFile: 2, coalesceMs: 0 },
    });
    perFile.capture(captureInput(fx, "v1", "user-save", 2_000));
    perFile.capture(captureInput(fx, "v2", "user-save", 3_000));
    perFile.capture(captureInput(fx, "v3", "user-save", 4_000));
    expect(perFile.list(fx.scope, "src/app.ts", 4_001).map((entry) => entry.sequence)).toEqual([
      3, 2,
    ]);
  });

  it("reclaims ciphertext bodies a failed eviction stranded once the store is past its bound", () => {
    const fx = fixture();
    for (const path of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"]) {
      writeFileSync(join(fx.root, path), "x");
    }
    let refuseDeletes = true;
    const store = createEditorLocalHistoryStore({
      ...storeOptions(fx),
      limits: { maxEntries: 3, coalesceMs: 0 },
      vaultFactory: (workspaceDir) => {
        const inner = createShardedLocalSecretVault({
          key: Buffer.from(VAULT_KEY, "base64"),
          storeDir: join(workspaceDir, "checkpoints"),
        });
        return {
          ...inner,
          delete: (reference): void => {
            if (refuseDeletes) throw new Error("transient vault failure");
            inner.delete(reference);
          },
        };
      },
    });

    const paths = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
    paths.forEach((path, index) => {
      store.capture(captureInput(fx, `v${String(index)}`, "user-save", 1_000 + index * 10, path));
    });
    // The index is bounded the whole time; the vault is not, because every eviction's delete threw.
    expect(store.list(fx.scope, undefined, 2_000)).toHaveLength(3);
    expect(bodyFiles(fx.stateDir).length).toBeGreaterThan(3);

    refuseDeletes = false;
    store.capture(captureInput(fx, "v5", "user-save", 1_060, "f.ts"));

    // Retention now reconciles bodies against the index, so one pruning pass reclaims everything
    // the earlier failures stranded — not just the entry it evicted this time.
    expect(bodyFiles(fx.stateDir)).toHaveLength(3);
    expect(store.list(fx.scope, undefined, 2_000)).toHaveLength(3);
  });

  it("reclaims a body stranded between the encrypted write and the index commit", () => {
    const fx = fixture();
    writeFileSync(join(fx.root, "b.ts"), "x");
    const store = createEditorLocalHistoryStore({ ...storeOptions(fx), limits: { coalesceMs: 0 } });
    store.capture(captureInput(fx, "first\n", "user-save", 1_000));

    // A capture that wrote its sealed body and then died before persisting the index leaves exactly
    // this: ciphertext no index entry references, and no eviction will ever name it.
    const historyRoot = join(fx.stateDir, "editor-local-history");
    const workspaceDir = join(historyRoot, readdirSync(historyRoot)[0] ?? "missing");
    createShardedLocalSecretVault({
      key: Buffer.from(VAULT_KEY, "base64"),
      storeDir: join(workspaceDir, "checkpoints"),
    }).set("vault-orphaned-body", "{}");
    expect(bodyFiles(fx.stateDir)).toHaveLength(2);

    store.capture(captureInput(fx, "second\n", "user-save", 2_000, "b.ts"));

    expect(bodyFiles(fx.stateDir)).toHaveLength(2);
    expect(store.list(fx.scope, undefined, 2_001)).toHaveLength(2);
  });

  it("refuses a checkpoint whose resolved file escapes the workspace root", () => {
    const fx = fixture();
    const outside = tempDir("keiko-local-history-outside-");
    writeFileSync(join(outside, "secret.ts"), "outside marker\n", "utf8");
    symlinkSync(join(outside, "secret.ts"), join(fx.root, "src", "escape.ts"));
    const store = createEditorLocalHistoryStore(storeOptions(fx));

    expect(() =>
      store.capture({
        ...captureInput(fx, "outside marker\n", "user-save", 1_000),
        relativePath: "src/escape.ts",
        absolutePath: join(fx.root, "src", "escape.ts"),
      }),
    ).toThrow(expect.objectContaining({ code: "PATH_OUTSIDE_WORKSPACE" }));
  });

  it("fails closed when encrypted payload content no longer matches its self-binding", () => {
    const fx = fixture();
    let vault: LocalSecretVault | undefined;
    const store = createEditorLocalHistoryStore({
      ...storeOptions(fx),
      vaultFactory: (workspaceDir) => {
        vault = createShardedLocalSecretVault({
          key: Buffer.alloc(32, 0x44),
          storeDir: join(workspaceDir, "checkpoints"),
        });
        return vault;
      },
    });
    const entry = store.capture(captureInput(fx, "trusted\n", "user-save", 1_000)).entry;
    const ref = entry.encryptedContent.vaultEntryRef;
    const payload = JSON.parse(vault?.get(ref) ?? "{}") as Record<string, unknown>;
    vault?.set(ref, JSON.stringify({ ...payload, content: "swapped\n" }));

    expect(() => store.read(fx.scope, entry.entryRef, 1_001)).toThrow(
      expect.objectContaining({ code: "CONTENT_UNAVAILABLE" }),
    );
  });

  it("walks the closed error ladder: oversized entry, invalid path, unknown ref, foreign scope", () => {
    const fx = fixture();
    const store = createEditorLocalHistoryStore({
      ...storeOptions(fx),
      limits: { maxEntryBytes: 16 },
    });

    expect(() => store.capture(captureInput(fx, "x".repeat(64), "user-save", 1_000))).toThrow(
      expect.objectContaining({ code: "ENTRY_TOO_LARGE" }),
    );

    expect(() =>
      store.capture({
        ...captureInput(fx, "ok\n", "user-save", 1_001),
        relativePath: "../escape.ts",
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_CAPTURE" }));

    expect(() => store.capture({ ...captureInput(fx, "ok\n", "user-save", Number.NaN) })).toThrow(
      expect.objectContaining({ code: "INVALID_CAPTURE" }),
    );

    const entry = store.capture(captureInput(fx, "ok\n", "user-save", 1_002)).entry;
    expect(() => store.entry(fx.scope, "entry-does-not-exist", 1_003)).toThrow(
      expect.objectContaining({ code: "ENTRY_NOT_FOUND" }),
    );
    const foreignScope = {
      ...fx.scope,
      rootIdentityDigest: "f".repeat(64) as typeof fx.scope.rootIdentityDigest,
    };
    expect(() => store.read(foreignScope, entry.entryRef, 1_004)).toThrow(
      expect.objectContaining({ code: "ENTRY_NOT_FOUND" }),
    );
    expect(() => {
      store.delete(foreignScope, entry.entryRef);
    }).toThrow(expect.objectContaining({ code: "ENTRY_NOT_FOUND" }));
    expect(store.list(foreignScope, undefined, 1_005)).toEqual([]);
  });

  it("rejects a tampered on-disk index as INDEX_UNAVAILABLE for both corruption shapes", () => {
    const fx = fixture();
    const store = createEditorLocalHistoryStore(storeOptions(fx));
    store.capture(captureInput(fx, "persisted\n", "user-save", 1_000));

    const workspaceDirs = readdirSync(join(fx.stateDir, "editor-local-history"));
    const indexPath = join(
      fx.stateDir,
      "editor-local-history",
      workspaceDirs[0] ?? "",
      "index.json",
    );

    writeFileSync(indexPath, "{not json", "utf8");
    const reopenedCorrupt = createEditorLocalHistoryStore(storeOptions(fx));
    expect(() => reopenedCorrupt.list(fx.scope, undefined, 1_001)).toThrow(
      expect.objectContaining({ code: "INDEX_UNAVAILABLE" }),
    );

    const foreign = { schemaVersion: 1, workspaceId: "someone-else", entries: [] };
    writeFileSync(indexPath, JSON.stringify(foreign), "utf8");
    const reopenedForeign = createEditorLocalHistoryStore(storeOptions(fx));
    expect(() => reopenedForeign.list(fx.scope, undefined, 1_002)).toThrow(
      expect.objectContaining({ code: "INDEX_UNAVAILABLE" }),
    );
  });

  it("guards pinned capacity: pinning beyond the byte budget and capture blocked by pins", () => {
    const fx = fixture();
    const store = createEditorLocalHistoryStore({
      ...storeOptions(fx),
      limits: { maxEntries: 2, maxPinnedBytes: 8 },
    });
    const first = store.capture(captureInput(fx, "AAAA\n", "user-save", 1_000)).entry;
    const second = store.capture(captureInput(fx, "BBBBBBBB\n", "user-save", 2_000)).entry;

    store.setPinned(fx.scope, first.entryRef, true, 2_001);
    expect(() => store.setPinned(fx.scope, second.entryRef, true, 2_002)).toThrow(
      expect.objectContaining({ code: "PINNED_BYTE_LIMIT" }),
    );

    const roomy = fixture();
    const roomyStore = createEditorLocalHistoryStore({
      ...storeOptions(roomy),
      limits: { maxEntries: 2, maxPinnedBytes: 64 },
    });
    const pinnedFirst = roomyStore.capture(captureInput(roomy, "AAAA\n", "user-save", 1_000)).entry;
    const pinnedSecond = roomyStore.capture(
      captureInput(roomy, "CCCC\n", "user-save", 2_000),
    ).entry;
    roomyStore.setPinned(roomy.scope, pinnedFirst.entryRef, true, 2_001);
    roomyStore.setPinned(roomy.scope, pinnedSecond.entryRef, true, 2_002);
    expect(() => roomyStore.capture(captureInput(roomy, "DDDD\n", "user-save", 3_000))).toThrow(
      expect.objectContaining({ code: "PINNED_CAPACITY_EXHAUSTED" }),
    );
  });
});
