// Wave 4a (epic #3233 §6.2/§8): `collectStoreFingerprints` unit tests. Seeds real, on-disk
// instances of all three stores (ui, local-knowledge, memory-vault) under one temp state dir
// using each store package's own create/open helpers — never a hand-rolled fixture that
// re-derives a schema this test does not own — then calls `collectStoreFingerprints` directly
// and asserts the three-valid / missing / corrupt-and-untouched outcomes this function owns.
//
// RED (before this file existed): the CLI-side `keiko-cli` package imported
// `@oscharko-dev/keiko-local-knowledge` directly to compute this exact collection, which
// `arch:check`'s ADR-0019 direction rule 7 forbids (a leaf CLI consumer must reach domain
// packages only through their public surfaces it is actually allowed — local-knowledge was never
// on that allowlist). This suite pins the collection's behaviour at the layer that now owns it.

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isStoreFingerprint,
  type EmbeddingModelIdentity,
  type KnowledgeCapsuleId,
  type StoreFingerprint,
} from "@oscharko-dev/keiko-contracts";
import type { MemoryId, UserId } from "@oscharko-dev/keiko-contracts/memory";
import { createMemoryVault } from "@oscharko-dev/keiko-memory-vault";
import {
  createCapsule,
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  type CreateCapsuleInput,
} from "@oscharko-dev/keiko-local-knowledge";

import { createNodeUiStore, UI_DB_FILENAME } from "./store/index.js";
import { collectStoreFingerprints } from "./store-fingerprints.js";

const UI_PROJECT_MARKER = "unit-ui-project-marker-3233";
const CAPSULE_MARKER = "unit-local-knowledge-capsule-marker-3233";
const MEMORY_BODY_MARKER = "unit-memory-vault-body-marker-3233";

const EMBEDDING_IDENTITY: EmbeddingModelIdentity = {
  provider: "openai",
  modelId: "text-embedding-3-small",
  vectorDimensions: 1536,
  vectorMetric: "cosine",
  normalization: "l2",
  instructionVersion: "keiko-embedding-input-v1",
  embeddingSpaceFingerprint: "keiko-embedding-space-fingerprint-v1:3233-unit",
};

function seedUiStore(stateDir: string): void {
  const dbPath = join(stateDir, "ui", UI_DB_FILENAME);
  const store = createNodeUiStore(dbPath);
  const projectDir1 = mkdtempSync(join(stateDir, `${UI_PROJECT_MARKER}-1-`));
  const projectDir2 = mkdtempSync(join(stateDir, `${UI_PROJECT_MARKER}-2-`));
  store.createProject(projectDir1, UI_PROJECT_MARKER);
  store.createProject(projectDir2, UI_PROJECT_MARKER);
  store.close();
}

function capsuleInput(id: string): CreateCapsuleInput {
  return {
    id: id as KnowledgeCapsuleId,
    displayName: CAPSULE_MARKER,
    tags: [],
    retrievalEffort: "default",
    outputMode: "answers",
    answerGroundingPolicy: "require-citations",
    embeddingModelIdentity: EMBEDDING_IDENTITY,
    lifecycleState: "draft",
    storageReference: `${CAPSULE_MARKER}/${id}`,
  };
}

function seedLocalKnowledgeStore(stateDir: string): void {
  const dbPath = resolveKnowledgeStorePath({ runtimeStateDir: stateDir });
  const store = openKnowledgeStore({ dbPath });
  createCapsule(store, capsuleInput("cap-1"));
  createCapsule(store, capsuleInput("cap-2"));
  store.close();
}

function seedMemoryVault(stateDir: string, memoryKeyBase64: string): void {
  const memoryDir = join(stateDir, "memory");
  const vault = createMemoryVault({
    memoryDir,
    env: { KEIKO_MEMORY_DIR: memoryDir, KEIKO_MEMORY_KEY: memoryKeyBase64 },
  });
  const t = 1_700_000_000_000;
  const memory = (id: string): Parameters<typeof vault.insertMemory>[0] => ({
    id: id as MemoryId,
    schemaVersion: "1",
    scope: { kind: "user", userId: "u-1" as UserId },
    type: "preference",
    body: MEMORY_BODY_MARKER,
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: t,
      confidence: 0.9,
      sensitivity: "confidential",
    },
    validity: { validFrom: t },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: t,
    updatedAt: t,
  });
  vault.insertMemory(memory("m1"));
  vault.insertMemory(memory("m2"));
  vault.close();
}

describe("collectStoreFingerprints", () => {
  let stateDir: string;
  let memoryKeyBase64: string;

  beforeEach(() => {
    // Realpath the tmpdir root: on macOS both /tmp and /var are symlinks, and the memory vault's
    // own path guard refuses a path with a symlinked ancestor (mirrors keiko-server's own
    // UI-db guard) — the same reason this package's own db.test.ts realpaths its tmp root.
    const root = realpathSync(tmpdir());
    stateDir = mkdtempSync(join(root, "keiko-store-fp-unit-state-"));
    memoryKeyBase64 = randomBytes(32).toString("base64");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("computes three valid fingerprints matching the seeded row counts, with nothing unavailable", async () => {
    seedUiStore(stateDir);
    seedLocalKnowledgeStore(stateDir);
    seedMemoryVault(stateDir, memoryKeyBase64);

    const result = await collectStoreFingerprints({
      stateDir,
      env: { KEIKO_MEMORY_KEY: memoryKeyBase64 },
    });

    expect(result.unavailable).toEqual([]);
    expect(result.fingerprints).toHaveLength(3);
    expect(result.fingerprints.every((entry) => isStoreFingerprint(entry))).toBe(true);

    const byStore = new Map<string, StoreFingerprint>(
      result.fingerprints.map((entry) => [entry.store, entry]),
    );
    expect(byStore.get("ui")?.tableRowCounts.projects).toBe(2);
    expect(byStore.get("local-knowledge")?.tableRowCounts.capsules).toBe(2);
    expect(byStore.get("memory-vault")?.tableRowCounts.memories).toBe(2);
    for (const store of ["ui", "local-knowledge", "memory-vault"]) {
      expect(byStore.get(store)?.quickCheckOk).toBe(true);
    }
  });

  it("reports every store as missing, and creates none of them, when none exist under stateDir", async () => {
    const result = await collectStoreFingerprints({ stateDir, env: {} });

    expect(result.fingerprints).toEqual([]);
    expect(result.unavailable).toEqual(
      expect.arrayContaining([
        { store: "ui", reasonKind: "missing" },
        { store: "local-knowledge", reasonKind: "missing" },
        { store: "memory-vault", reasonKind: "missing" },
      ]),
    );
    expect(result.unavailable).toHaveLength(3);
  });

  // RED (before fix): computing a store's fingerprint went through that store package's mutating
  // production open path, which quarantines confirmed SQLite corruption as an ordinary part of
  // opening — renaming the corrupt file aside and silently creating an empty replacement. A
  // diagnostic collection must never destroy the very corruption evidence an operator is trying
  // to capture; instead it degrades to `quickCheckOk: false` and leaves the bytes exactly as
  // found.
  it("degrades a genuinely SQLite-corrupt ui store file to quickCheckOk:false, leaving its bytes untouched", async () => {
    const uiDbPath = join(stateDir, "ui", UI_DB_FILENAME);
    const corruptBytes = "garbage that is not a sqlite header";
    mkdirSync(dirname(uiDbPath), { recursive: true });
    writeFileSync(uiDbPath, corruptBytes);

    const result = await collectStoreFingerprints({ stateDir, env: {} });

    expect(readFileSync(uiDbPath, "utf8")).toBe(corruptBytes);
    const siblingNames = readdirSync(dirname(uiDbPath));
    expect(siblingNames.some((name) => name.includes(".corrupt."))).toBe(false);

    const uiEntry = result.fingerprints.find((entry) => entry.store === "ui");
    expect(uiEntry).toBeDefined();
    expect(uiEntry?.quickCheckOk).toBe(false);
    expect(result.unavailable.some((entry) => entry.store === "ui")).toBe(false);
  });

  // Finding 0 (blocker): a memory-vault db that exists with KEIKO_MEMORY_KEY unset must never
  // mint and persist a brand-new `vault.key` into the state dir as a side effect of a read-only
  // diagnostic collection — regardless of what the OS keychain tier answers on the machine
  // running the test (it may legitimately hold a real "keiko-memory-vault" entry on a dev
  // machine that has run the product). RED (before fix): `memoryVaultStoreFingerprintOutcome`
  // called the mutating `resolveVaultKey`, which falls through to `keyFromKeyfile` whenever the
  // keychain tier misses and writes the keyfile; the deterministic, keychain-independent proof
  // that this can never happen again lives in cipher.test.ts's
  // "resolveVaultKeyReadOnly (Finding 0 …)" suite, which injects a fake keychain reader. This
  // test additionally pins the invariant at the layer `keiko support export` actually calls.
  it("never mints a vault.key as a side effect of fingerprinting a memory vault whose key is unresolved", async () => {
    seedMemoryVault(stateDir, memoryKeyBase64);

    const result = await collectStoreFingerprints({ stateDir, env: {} });

    expect(existsSync(join(stateDir, "memory", "vault.key"))).toBe(false);
    // The store is still fingerprinted, never reported open-failed just because the key could
    // not be resolved, and `keySource` is never "keyfile" — the one value that could only be
    // produced by minting and persisting a new key.
    const memoryEntry = result.fingerprints.find((entry) => entry.store === "memory-vault");
    expect(memoryEntry).toBeDefined();
    expect(memoryEntry?.keySource).not.toBe("keyfile");
  });
});
