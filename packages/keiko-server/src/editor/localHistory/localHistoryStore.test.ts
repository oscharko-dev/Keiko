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
  createLocalSecretVault,
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

    const historyRoot = join(fx.stateDir, "editor-local-history");
    const workspaceDir = join(historyRoot, readdirSync(historyRoot)[0] ?? "missing");
    const vaultBytes = readFileSync(join(workspaceDir, "checkpoints.vault"), "utf8");
    for (const content of contents) expect(vaultBytes).not.toContain(content.trim());
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
        vault = createLocalSecretVault({
          key: Buffer.alloc(32, 0x44),
          storePath: join(workspaceDir, "checkpoints.vault"),
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
});
