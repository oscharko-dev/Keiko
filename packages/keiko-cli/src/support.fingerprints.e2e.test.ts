// Preserve the store-fingerprint real-store and corruption pins at their owning production entry
// point. #3534 reports never open stores for snapshots; collectStoreFingerprints still must report
// counts without bodies, and must not quarantine, repair or falsely bless corrupt databases.

import { randomBytes } from "node:crypto";

import {
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

import type {
  EmbeddingModelIdentity,
  KnowledgeCapsuleId,
  StoreFingerprint,
} from "@oscharko-dev/keiko-contracts";

import { isStoreFingerprint } from "@oscharko-dev/keiko-contracts/runtime/store-fingerprint";

import type { MemoryId, UserId } from "@oscharko-dev/keiko-contracts/memory";

import { createMemoryVault, MEMORY_DB_FILENAME } from "@oscharko-dev/keiko-memory-vault";

import {
  createCapsule,
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  type CreateCapsuleInput,
} from "@oscharko-dev/keiko-local-knowledge";

import {
  collectStoreFingerprints,
  createNodeUiStore,
  UI_DB_FILENAME,
} from "@oscharko-dev/keiko-server";

// Distinctive, never-otherwise-present markers for each store's seeded row content — the test's
// proof that fingerprints carry counts, never bodies.
const UI_PROJECT_MARKER = "e2e-ui-project-marker-3233";

const CAPSULE_MARKER = "e2e-local-knowledge-capsule-marker-3233";

const MEMORY_BODY_MARKER = "e2e-memory-vault-body-marker-3233";

const EMBEDDING_IDENTITY: EmbeddingModelIdentity = {
  provider: "openai",
  modelId: "text-embedding-3-small",
  vectorDimensions: 1536,
  vectorMetric: "cosine",
  normalization: "l2",
  instructionVersion: "keiko-embedding-input-v1",
  embeddingSpaceFingerprint: "keiko-embedding-space-fingerprint-v1:3233-e2e",
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

describe("collectStoreFingerprints — real-store acceptance (Wave 4a)", () => {
  let stateDir: string;
  let outDir: string;
  let memoryKeyBase64: string;

  beforeEach(() => {
    // Realpath the tmpdir root: on macOS both /tmp and /var are symlinks, and the memory vault's
    // own path guard (mirrored from keiko-server's UI-db guard) refuses a path with a symlinked
    // ancestor — the same reason this package's own vault.test.ts realpaths its tmp root.
    const root = realpathSync(tmpdir());
    stateDir = mkdtempSync(join(root, "keiko-support-fp-e2e-state-"));
    outDir = mkdtempSync(join(root, "keiko-support-fp-e2e-out-"));
    memoryKeyBase64 = randomBytes(32).toString("base64");
    seedUiStore(stateDir);
    seedLocalKnowledgeStore(stateDir);
    seedMemoryVault(stateDir, memoryKeyBase64);
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  it("reports three valid fingerprints with the seeded row counts, and leaks no row content", async () => {
    const stores = await collectStoreFingerprints({
      stateDir,
      env: { KEIKO_MEMORY_KEY: memoryKeyBase64 },
    });
    const manifest = {
      storeFingerprints: stores.fingerprints,
      storesUnavailable: stores.unavailable,
    };
    const written = JSON.stringify(manifest);

    expect(manifest.storesUnavailable).toEqual([]);
    expect(manifest.storeFingerprints).toHaveLength(3);
    expect(manifest.storeFingerprints.every((entry) => isStoreFingerprint(entry))).toBe(true);

    const byStore = new Map<string, StoreFingerprint>(
      manifest.storeFingerprints.map((entry) => [entry.store, entry]),
    );
    expect(byStore.get("ui")?.tableRowCounts.projects).toBe(2);
    expect(byStore.get("local-knowledge")?.tableRowCounts.capsules).toBe(2);
    expect(byStore.get("memory-vault")?.tableRowCounts.memories).toBe(2);
    for (const store of ["ui", "local-knowledge", "memory-vault"]) {
      expect(byStore.get(store)?.quickCheckOk).toBe(true);
    }

    // The fingerprint is counts and closed-vocabulary labels only — never the row content that
    // produced them.
    expect(written).not.toContain(UI_PROJECT_MARKER);
    expect(written).not.toContain(CAPSULE_MARKER);
    expect(written).not.toContain(MEMORY_BODY_MARKER);
    expect(written).not.toContain(memoryKeyBase64);
  });

  // RED (before fix): computing a store's fingerprint went through that store package's mutating
  // production open path, which quarantines confirmed SQLite corruption as an ordinary part of
  // opening — renaming the corrupt file aside and silently creating an empty replacement. A
  // diagnostic export must never destroy the very corruption evidence an operator ran it to
  // capture. Genuinely SQLite-corrupt bytes (not just an EISDIR, which the "open-failed" test in
  // support.test.ts already covers and which never reaches the quarantine path at all) for all
  // three stores.
  it("never quarantines a genuinely SQLite-corrupt store file while computing its fingerprint", async () => {
    const uiDbPath = join(stateDir, "ui", UI_DB_FILENAME);
    const localKnowledgeDbPath = resolveKnowledgeStorePath({ runtimeStateDir: stateDir });
    const memoryDbPath = join(stateDir, "memory", MEMORY_DB_FILENAME);
    const corruptBytes = "garbage that is not a sqlite header";
    for (const dbPath of [uiDbPath, localKnowledgeDbPath, memoryDbPath]) {
      mkdirSync(dirname(dbPath), { recursive: true });
      writeFileSync(dbPath, corruptBytes);
    }

    const stores = await collectStoreFingerprints({
      stateDir,
      env: { KEIKO_MEMORY_KEY: memoryKeyBase64 },
    });
    // The corrupt files are untouched: same bytes, and no quarantine sidecar (`.corrupt.<ts>`)
    // appeared next to any of them.
    for (const dbPath of [uiDbPath, localKnowledgeDbPath, memoryDbPath]) {
      expect(readFileSync(dbPath, "utf8")).toBe(corruptBytes);
      const siblingNames = readdirSync(dirname(dbPath));
      expect(siblingNames.some((name) => name.includes(".corrupt."))).toBe(false);
    }

    // Every store must land on the "unhealthy" side of the manifest for genuinely corrupt bytes:
    // either an entry in `storesUnavailable` (the read-only open itself failed) or a present
    // fingerprint whose `quickCheckOk` is `false` (the open succeeded but every read degraded) —
    // never a fingerprint that reads as healthy, and never a thrown error out of the CLI either
    // way (`code` is 0 above).
    const manifest = {
      storeFingerprints: stores.fingerprints,
      storesUnavailable: stores.unavailable,
    };
    const unavailableStores = new Set(manifest.storesUnavailable.map((entry) => entry.store));
    for (const store of ["ui", "local-knowledge", "memory-vault"] as const) {
      const fingerprint = manifest.storeFingerprints.find((entry) => entry.store === store);
      if (fingerprint === undefined) {
        expect(unavailableStores.has(store)).toBe(true);
      } else {
        expect(fingerprint.quickCheckOk).toBe(false);
      }
    }
  });
});
