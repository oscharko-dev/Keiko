import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type {
  MemoryAuditEvent,
  MemoryId,
  MemoryRecord,
  MemoryUserId,
} from "@oscharko-dev/keiko-contracts";
import { runMemoryCli } from "./memory.js";
import type { CliIo } from "./runner.js";

function capture(): { io: CliIo; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    io: {
      out: (t: string): void => {
        out += t;
      },
      err: (t: string): void => {
        err += t;
      },
    },
    out: (): string => out,
    err: (): string => err,
  };
}

const tmpDirs: string[] = [];
const vaults: MemoryVaultStore[] = [];
// Resolve tmpdir's symlink once: the memory-vault path guard refuses any ancestor symlink, and
// on macOS `os.tmpdir()` sits under `/var/folders/...` which is a symlink to `/private/var/...`.
const REAL_TMPDIR = realpathSync(tmpdir());

afterEach(() => {
  for (const vault of vaults.splice(0)) {
    try {
      vault.close();
    } catch {
      // ignore
    }
  }
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeVault(): MemoryVaultStore {
  const dir = mkdtempSync(join(REAL_TMPDIR, "keiko-cli-mem-"));
  tmpDirs.push(dir);
  const vault = createMemoryVault({ memoryDir: dir, redactString: (s) => s });
  vaults.push(vault);
  return vault;
}

function mid(value: string): MemoryId {
  return value as unknown as MemoryId;
}

function insert(
  vault: MemoryVaultStore,
  options: {
    id: string;
    type?: MemoryRecord["type"];
    status?: MemoryRecord["status"];
    confidence?: number;
    createdAt?: number;
    validUntil?: number;
  },
): MemoryRecord {
  const createdAt = options.createdAt ?? Date.now();
  return vault.insertMemory({
    id: mid(options.id),
    schemaVersion: "1",
    scope: { kind: "user", userId: "u-1" as unknown as MemoryUserId },
    type: options.type ?? "preference",
    body: "prefers dark mode",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: createdAt,
      confidence: options.confidence ?? 0.9,
      sensitivity: "confidential",
    },
    validity:
      options.validUntil === undefined
        ? { validFrom: createdAt }
        : { validFrom: createdAt, validUntil: options.validUntil },
    status: options.status ?? "accepted",
    pinned: false,
    tags: [],
    createdAt,
    updatedAt: createdAt,
  });
}

describe("runMemoryCli — usage and dispatch", () => {
  it("prints usage and exits 2 with no subcommand", async () => {
    const cap = capture();
    expect(await runMemoryCli([], cap.io, {})).toBe(2);
    expect(cap.out()).toContain("keiko memory maintain");
  });

  it("prints usage and exits 0 for --help", async () => {
    const cap = capture();
    expect(await runMemoryCli(["--help"], cap.io, {})).toBe(0);
    expect(cap.out()).toContain("keiko memory stats");
    expect(cap.out()).toContain("keiko memory diagnostics");
  });

  it("exits 2 on an unknown subcommand", async () => {
    const cap = capture();
    expect(await runMemoryCli(["frobnicate"], cap.io, {})).toBe(2);
    expect(cap.err()).toContain("unknown subcommand");
  });
});

describe("runMemoryCli stats", () => {
  it("prints counts by status, scope, and total", async () => {
    const vault = makeVault();
    insert(vault, { id: "a", status: "accepted" });
    insert(vault, { id: "b", status: "accepted" });
    insert(vault, { id: "c", status: "proposed" });
    const cap = capture();
    expect(await runMemoryCli(["stats"], cap.io, {}, { vault })).toBe(0);
    const out = cap.out();
    expect(out).toContain("By status:");
    expect(out).toContain("accepted: 2");
    expect(out).toContain("proposed: 1");
    expect(out).toContain("user: 3");
    expect(out).toContain("Total: 3");
  });

  it("reports an empty vault cleanly", async () => {
    const vault = makeVault();
    const cap = capture();
    expect(await runMemoryCli(["stats"], cap.io, {}, { vault })).toBe(0);
    expect(cap.out()).toContain("Total: 0");
  });
});

describe("runMemoryCli diagnostics", () => {
  it("prints a redacted body-free diagnostics snapshot", async () => {
    const vault = makeVault();
    const fingerprint = "CLI-DIAGNOSTICS-BODY-FINGERPRINT";
    insert(vault, { id: "diag-a", status: "accepted" });
    vault.updateMemory(mid("diag-a"), { body: fingerprint }, Date.now());
    const cap = capture();
    expect(
      await runMemoryCli(
        ["diagnostics", "--last", "5"],
        cap.io,
        {},
        {
          vault,
          evidenceStore: createInMemoryEvidenceStore(),
          redactString: (s) => s,
        },
      ),
    ).toBe(0);
    const out = cap.out();
    const parsed = JSON.parse(out) as {
      schemaVersion: string;
      statusHistogram: { accepted: number };
      scopeCounts: readonly { count: number }[];
    };
    expect(parsed.schemaVersion).toBe("1");
    expect(parsed.statusHistogram.accepted).toBe(1);
    expect(parsed.scopeCounts[0]?.count).toBe(1);
    expect(out).not.toContain(fingerprint);
  }, 90_000);
});

describe("runMemoryCli maintain", () => {
  it("runs the in-process pass and prints the applied counts", async () => {
    const vault = makeVault();
    // An expired non-accepted memory is forgotten; accepted memories require explicit review.
    insert(vault, {
      id: "m",
      status: "proposed",
      createdAt: Date.now() - 864e5,
      validUntil: Date.now() - 1,
    });
    const cap = capture();
    expect(await runMemoryCli(["maintain"], cap.io, {}, { vault })).toBe(0);
    const out = cap.out();
    expect(out).toContain("Memory maintenance complete.");
    expect(out).toContain("forgotten:         1");
    expect(vault.getMemory(mid("m"))).toBeUndefined();
  });

  it("persists memory audit evidence for maintenance mutations", async () => {
    const vault = makeVault();
    const evidenceStore = createInMemoryEvidenceStore();
    insert(vault, {
      id: "m",
      status: "proposed",
      createdAt: Date.now() - 864e5,
      validUntil: Date.now() - 1,
    });
    const cap = capture();
    expect(await runMemoryCli(["maintain"], cap.io, {}, { vault, evidenceStore })).toBe(0);
    const runIds = evidenceStore.list();
    expect(runIds).toHaveLength(1);
    const runId = runIds[0];
    expect(runId).toBeDefined();
    if (runId === undefined) {
      throw new Error("expected a memory audit evidence manifest");
    }
    const events = JSON.parse(evidenceStore.get(runId) ?? "[]") as MemoryAuditEvent[];
    expect(events.map((event) => event.kind)).toContain("memory:forgotten");
  });

  it("honours KEIKO_MEMORY_SEMANTICIZATION so the CLI pass does not drift from the server", async () => {
    // Same aged episodic detail: flat half-life keeps it (strength 0.25 > archive floor 0.2), but
    // the episodic ×0.5 multiplier archives it (strength 0.125). The CLI must read the flag exactly
    // as the two server passes do — otherwise `keiko memory maintain` silently diverges from the UI.
    const createdAt = Date.now() - 45 * 864e5;
    const off = makeVault();
    insert(off, { id: "ep", type: "episodic", confidence: 0.5, createdAt });
    expect(await runMemoryCli(["maintain"], capture().io, {}, { vault: off })).toBe(0);
    expect(off.getMemory(mid("ep"))?.status).toBe("accepted");

    const on = makeVault();
    insert(on, { id: "ep", type: "episodic", confidence: 0.5, createdAt });
    expect(
      await runMemoryCli(
        ["maintain"],
        capture().io,
        { KEIKO_MEMORY_SEMANTICIZATION: "1" },
        { vault: on },
      ),
    ).toBe(0);
    expect(on.getMemory(mid("ep"))?.status).toBe("archived");
  });

  it("honours explicit retention policy in the shared CLI maintenance pass", async () => {
    const vault = makeVault();
    const evidenceStore = createInMemoryEvidenceStore();
    insert(vault, { id: "retention-old", createdAt: Date.now() - 2 * 864e5 });

    expect(
      await runMemoryCli(
        ["maintain"],
        capture().io,
        { KEIKO_MEMORY_RETENTION_MAX_AGE_DAYS: "1" },
        { vault, evidenceStore },
      ),
    ).toBe(0);
    expect(vault.getMemory(mid("retention-old"))).toBeUndefined();
    const events = evidenceStore
      .list()
      .flatMap((runId) => JSON.parse(evidenceStore.get(runId) ?? "[]") as MemoryAuditEvent[]);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "memory:forgotten",
        initiatorSurface: "retention",
        memoryId: "retention-old",
        tombstoned: true,
      }),
    );
  });

  it("reports destructive tombstone purges and their retention breakdown", async () => {
    const vault = makeVault();
    insert(vault, { id: "old-tombstone" });
    vault.deleteMemory(mid("old-tombstone"), {
      tombstone: true,
      forgetterSurface: "test",
      reason: "retention test seed",
      nowMs: Date.now() - 2 * 864e5,
    });
    const cap = capture();

    expect(
      await runMemoryCli(
        ["maintain"],
        cap.io,
        { KEIKO_MEMORY_RETENTION_PURGE_FORGOTTEN_AFTER_DAYS: "1" },
        { vault },
      ),
    ).toBe(0);

    expect(cap.out()).toContain("retentionForgotten:      0");
    expect(cap.out()).toContain("tombstonesPurged:        1");
    expect(vault.listTombstonesByScope({ kind: "user", userId: "u-1" as MemoryUserId })).toEqual(
      [],
    );
  });

  it("fails closed on invalid retention configuration without exposing its value", async () => {
    const vault = makeVault();
    const cap = capture();
    const invalid = "customer-secret-invalid-retention";

    expect(
      await runMemoryCli(
        ["maintain"],
        cap.io,
        { KEIKO_MEMORY_RETENTION_MAX_AGE_DAYS: invalid },
        { vault },
      ),
    ).toBe(1);
    expect(cap.err()).toContain("KEIKO_MEMORY_RETENTION_MAX_AGE_DAYS");
    expect(cap.err()).not.toContain(invalid);
  });
});

describe("runMemoryCli reembed", () => {
  function fakeEmbedder(dimensions = 8): (text: string) => Promise<{
    provider: string;
    modelId: string;
    metric: "cosine";
    vector: Float32Array;
  } | null> {
    return (text: string) =>
      Promise.resolve(
        text.length === 0
          ? null
          : {
              provider: "openai",
              modelId: "text-embedding-3-large",
              metric: "cosine" as const,
              vector: Float32Array.from({ length: dimensions }, (_, i) => (i + 1) / dimensions),
            },
      );
  }

  it("embeds accepted memories that lack an embedding", async () => {
    const vault = makeVault();
    insert(vault, { id: "a", status: "accepted" });
    insert(vault, { id: "b", status: "accepted" });
    const cap = capture();
    const code = await runMemoryCli(["reembed"], cap.io, {}, { vault, embedText: fakeEmbedder() });
    expect(code).toBe(0);
    expect(cap.out()).toContain("embedded: 2");
    expect(cap.out()).toContain("skipped:  0");
    expect(vault.getEmbedding(mid("a"))).toBeDefined();
    expect(vault.getEmbedding(mid("b"))).toBeDefined();
  });

  // Regression pin (KEIKO-0440): backfillEmbeddings must skip records that already carry an
  // embedding instead of re-embedding every accepted record. Without the skip, each `keiko memory
  // reembed` run cost O(all accepted memories) provider calls regardless of what was actually
  // missing, and the `skipped` counter was structurally unreachable from 0.
  it("skips already-embedded memories and only embeds those lacking one", async () => {
    const vault = makeVault();
    insert(vault, { id: "a", status: "accepted" });
    insert(vault, { id: "b", status: "accepted" });
    vault.upsertEmbedding(mid("a"), {
      provider: "openai",
      modelId: "text-embedding-3-large",
      metric: "cosine",
      vector: Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
    });
    let spyCalls = 0;
    const inner = fakeEmbedder();
    const spy: typeof inner = (text) => {
      spyCalls += 1;
      return inner(text);
    };
    const cap = capture();
    const code = await runMemoryCli(["reembed"], cap.io, {}, { vault, embedText: spy });
    expect(code).toBe(0);
    expect(cap.out()).toContain("embedded: 1");
    expect(cap.out()).toContain("skipped:  1");
    // Only the unembedded record hit the embedder — the pre-embedded one was skipped.
    expect(spyCalls).toBe(1);
    // `a`'s original embedding stayed intact (the fixture vector, not the fakeEmbedder pattern).
    expect(Array.from(vault.getEmbedding(mid("a"))?.vector ?? [])).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("does not embed non-accepted memories", async () => {
    const vault = makeVault();
    insert(vault, { id: "p", status: "proposed" });
    insert(vault, { id: "a", status: "accepted" });
    const cap = capture();
    const code = await runMemoryCli(["reembed"], cap.io, {}, { vault, embedText: fakeEmbedder() });
    expect(code).toBe(0);
    expect(cap.out()).toContain("embedded: 1");
    expect(vault.getEmbedding(mid("p"))).toBeUndefined();
    expect(vault.getEmbedding(mid("a"))).toBeDefined();
  });

  it("respects --limit", async () => {
    const vault = makeVault();
    insert(vault, { id: "a", status: "accepted" });
    insert(vault, { id: "b", status: "accepted" });
    insert(vault, { id: "c", status: "accepted" });
    const cap = capture();
    const code = await runMemoryCli(
      ["reembed", "--limit", "1"],
      cap.io,
      {},
      { vault, embedText: fakeEmbedder() },
    );
    expect(code).toBe(0);
    expect(cap.out()).toContain("embedded: 1");
  });

  it("reports and exits 0 when no embedding model is configured", async () => {
    const vault = makeVault();
    insert(vault, { id: "a", status: "accepted" });
    const cap = capture();
    // embedText: null models "no embedding model available".
    const code = await runMemoryCli(["reembed"], cap.io, {}, { vault, embedText: null });
    expect(code).toBe(0);
    expect(cap.out()).toContain("No embedding model is configured");
    expect(vault.getEmbedding(mid("a"))).toBeUndefined();
  });

  it("exits non-zero when an embed call fails during backfill (Codex thread 3771387251)", async () => {
    const vault = makeVault();
    insert(vault, { id: "a", status: "accepted" });
    const cap = capture();
    const failingEmbedder = (): Promise<null> => Promise.resolve(null);
    const code = await runMemoryCli(["reembed"], cap.io, {}, { vault, embedText: failingEmbedder });
    expect(code).toBe(1);
    expect(cap.out()).toContain("failed:   1");
    expect(vault.getEmbedding(mid("a"))).toBeUndefined();
  });

  // Coverage pin: --force with a null-returning embedder increments counts.failed and
  // exits non-zero through embedOneForForce's `input === null` branch.
  it("exits non-zero when --force provider returns null (embedOneForForce null branch)", async () => {
    const vault = makeVault();
    insert(vault, { id: "a", status: "accepted" });
    const cap = capture();
    const nullEmbedder = (): Promise<null> => Promise.resolve(null);
    const code = await runMemoryCli(
      ["reembed", "--force"],
      cap.io,
      {},
      { vault, embedText: nullEmbedder },
    );
    expect(code).toBe(1);
    expect(cap.out()).toContain("failed:");
    expect(vault.getEmbedding(mid("a"))).toBeUndefined();
  });

  // Coverage pin: runReembed's outer try/catch reports a thrown reembed() error as a
  // clean non-zero exit with the redacted message, not an unhandled rejection.
  it("reports a thrown reembed error as exit 1 with a redacted message", async () => {
    const vault: MemoryVaultStore = {
      ...makeVault(),
      countMemoriesByStatus: (): never => {
        throw new Error("vault countMemoriesByStatus crashed");
      },
    };
    const cap = capture();
    const code = await runMemoryCli(
      ["reembed"],
      cap.io,
      {},
      { vault, embedText: (): Promise<null> => Promise.resolve(null) },
    );
    expect(code).toBe(1);
    expect(cap.err()).toContain("keiko memory:");
    expect(cap.err()).toContain("vault countMemoriesByStatus crashed");
  });

  // Coverage pin (Codex thread 3771469031): `--limit` smaller than the unembedded set
  // reports non-zero `remaining` alongside embedded / skipped / failed. Operators can now
  // tell a bounded partial pass apart from a nearly-complete corpus.
  it("reports remaining when --limit does not cover every unembedded accepted memory", async () => {
    const vault = makeVault();
    insert(vault, { id: "a", status: "accepted" });
    insert(vault, { id: "b", status: "accepted" });
    insert(vault, { id: "c", status: "accepted" });
    const cap = capture();
    const code = await runMemoryCli(
      ["reembed", "--limit", "1"],
      cap.io,
      {},
      { vault, embedText: fakeEmbedder() },
    );
    expect(code).toBe(0);
    expect(cap.out()).toContain("embedded: 1");
    expect(cap.out()).toContain("remaining: 2");
  });

  // Regression pin (KEIKO-0440, Codex thread 3769557887): `--force` staged only accepted
  // memories but the vault-wide replace deleted every embedding row, so an archived memory
  // that retained its embedding was silently dropped and the report counted only the accepted
  // rebuild. After the fix, `--force` stages every currently-embedded memory (accepted OR
  // archived), so the archived vector survives the swap.
  it("preserves embeddings for archived memories through --force", async () => {
    const vault = makeVault();
    const a = insert(vault, { id: "a", status: "accepted" });
    const b = insert(vault, { id: "b", status: "accepted" });
    vault.upsertEmbedding(a.id, {
      provider: "openai",
      modelId: "text-embedding-3-large",
      metric: "cosine",
      vector: Float32Array.from({ length: 8 }, (_, i) => (i + 1) / 8),
    });
    vault.upsertEmbedding(b.id, {
      provider: "openai",
      modelId: "text-embedding-3-large",
      metric: "cosine",
      vector: Float32Array.from({ length: 8 }, (_, i) => (i + 1) / 8),
    });
    // Archive b — updateMemory intentionally does not delete embeddings on a status transition,
    // so b's vector is still in the vault and must survive `--force`.
    vault.updateMemory(b.id, { status: "archived" }, Date.now() + 1);
    const cap = capture();
    const code = await runMemoryCli(
      ["reembed", "--force"],
      cap.io,
      {},
      { vault, embedText: fakeEmbedder() },
    );
    expect(code).toBe(0);
    expect(cap.out()).toContain("embedded: 2");
    expect(vault.getEmbedding(a.id)).toBeDefined();
    expect(vault.getEmbedding(b.id)).toBeDefined();
  });

  // Regression pin (KEIKO-0440, Codex thread 3769711626): `--force` must also cover accepted
  // memories that do not yet carry an embedding. Enumerating only listEmbeddedMemoryIds()
  // would omit them and exit successfully while they stayed semantically unavailable; staging
  // the union of accepted-ids and existing-embedded-ids fixes it.
  it("embeds accepted memories without an existing embedding through --force", async () => {
    const vault = makeVault();
    const a = insert(vault, { id: "a", status: "accepted" });
    const b = insert(vault, { id: "b", status: "accepted" });
    // Only a has an existing embedding; b is a new accepted memory that has never been embedded.
    vault.upsertEmbedding(a.id, {
      provider: "openai",
      modelId: "text-embedding-3-large",
      metric: "cosine",
      vector: Float32Array.from({ length: 8 }, (_, i) => (i + 1) / 8),
    });
    const cap = capture();
    const code = await runMemoryCli(
      ["reembed", "--force"],
      cap.io,
      {},
      { vault, embedText: fakeEmbedder() },
    );
    expect(code).toBe(0);
    expect(cap.out()).toContain("embedded: 2");
    expect(vault.getEmbedding(a.id)).toBeDefined();
    expect(vault.getEmbedding(b.id)).toBeDefined();
  });

  // Regression pin (KEIKO-0440, Codex thread 3769903807): if another writer UPDATES an
  // already-embedded row between the snapshot and the swap (upsertEmbedding overwrites its
  // created_at with the fresh timestamp), the swap rejects with precondition-failed instead
  // of overwriting the newer row with our stale staged vector. Simulated by upserting a
  // fresh vector on `a` inside the wrapped replaceAllEmbeddings — the vault's snapshot
  // check catches the created_at drift.
  it("refuses --force when a concurrent update lands on an already-staged memory", async () => {
    const vault = makeVault();
    const a = insert(vault, { id: "a", status: "accepted" });
    vault.upsertEmbedding(a.id, {
      provider: "openai",
      modelId: "text-embedding-3-large",
      metric: "cosine",
      vector: Float32Array.from({ length: 8 }, (_, i) => (i + 1) / 8),
    });
    const originalCreatedAt = vault.getEmbedding(a.id)?.createdAt;
    expect(originalCreatedAt).toBeDefined();
    // Wait a beat so Date.now() advances before the second upsert stamps its created_at —
    // otherwise a fast system stamps both upserts with the same ms and the snapshot check
    // sees no drift. The real BFF/CLI race is separated by network latency, so this delay
    // is only a test-time deterministic substitute for that.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const wrappedVault: MemoryVaultStore = {
      ...vault,
      replaceAllEmbeddings: (pairs, expectedSnapshot): void => {
        // Simulate a concurrent writer replacing a's vector with a fresh one; the upsert
        // stamps a new created_at that will not match the snapshot the CLI captured.
        vault.upsertEmbedding(a.id, {
          provider: "openai",
          modelId: "text-embedding-3-large",
          metric: "cosine",
          vector: Float32Array.from({ length: 8 }, (_, i) => (8 - i) / 8),
        });
        vault.replaceAllEmbeddings(pairs, expectedSnapshot);
      },
    };
    const cap = capture();
    const code = await runMemoryCli(
      ["reembed", "--force"],
      cap.io,
      {},
      { vault: wrappedVault, embedText: fakeEmbedder() },
    );
    expect(code).toBe(1);
    expect(cap.out()).toContain("failed:");
    // The concurrent write's vector survives — --force did not overwrite it with a stale
    // staged vector (fakeEmbedder pattern would be (i+1)/8 = [0.125, ...], not (8-i)/8).
    const finalVector = Array.from(vault.getEmbedding(a.id)?.vector ?? []);
    expect(finalVector[0]).toBeCloseTo(1.0);
    expect(finalVector[7]).toBeCloseTo(0.125);
  });

  // Regression pin (KfQ thread 3769955302, Codex thread 3770110870): a vault where every
  // accepted memory is already embedded should return immediately with skipped=N and NOT
  // touch the embedder. The prior fast-path (break on observedEmbedded==embeddedSet.size)
  // was incorrect when embedded and unembedded pages interleaved; the fix enumerates ids
  // once and subtracts in memory. This pin exercises the "nothing to do" path.
  it("returns immediately without embedding when every accepted memory already has one", async () => {
    const vault = makeVault();
    const a = insert(vault, { id: "a", status: "accepted" });
    const b = insert(vault, { id: "b", status: "accepted" });
    vault.upsertEmbedding(a.id, {
      provider: "openai",
      modelId: "text-embedding-3-large",
      metric: "cosine",
      vector: Float32Array.from({ length: 8 }, (_, i) => (i + 1) / 8),
    });
    vault.upsertEmbedding(b.id, {
      provider: "openai",
      modelId: "text-embedding-3-large",
      metric: "cosine",
      vector: Float32Array.from({ length: 8 }, (_, i) => (i + 1) / 8),
    });
    let embedCalls = 0;
    const spy: ReturnType<typeof fakeEmbedder> = (text) => {
      embedCalls += 1;
      return fakeEmbedder()(text);
    };
    const cap = capture();
    const code = await runMemoryCli(["reembed"], cap.io, {}, { vault, embedText: spy });
    expect(code).toBe(0);
    expect(embedCalls).toBe(0);
    expect(cap.out()).toContain("embedded: 0");
    expect(cap.out()).toContain("skipped:  2");
  });

  // Regression pin (KEIKO-0440, Codex thread 3769711634): if another writer inserts an
  // embedding row between the CLI's snapshot enumeration and the vault-wide swap, the
  // atomic replace refuses (reporting failed=N) rather than silently deleting that row.
  // The concurrent write is simulated by upserting a new embedding on a NEW memory record
  // directly before replaceAllEmbeddings runs — the vault's staged-set check inside the
  // BEGIN IMMEDIATE transaction sees the extra id and rolls the whole swap back.
  it("refuses --force when a concurrent write lands after staging", async () => {
    const vault = makeVault();
    const a = insert(vault, { id: "a", status: "accepted" });
    vault.upsertEmbedding(a.id, {
      provider: "openai",
      modelId: "text-embedding-3-large",
      metric: "cosine",
      vector: Float32Array.from({ length: 8 }, (_, i) => (i + 1) / 8),
    });
    const wrappedVault: MemoryVaultStore = {
      ...vault,
      replaceAllEmbeddings: (pairs): void => {
        // Simulate a concurrent writer landing an embedding for a NEW accepted memory that
        // was created after --force enumerated its target ids.
        const late = insert(vault, { id: "late", status: "accepted" });
        vault.upsertEmbedding(late.id, {
          provider: "openai",
          modelId: "text-embedding-3-large",
          metric: "cosine",
          vector: Float32Array.from({ length: 8 }, (_, i) => (i + 1) / 8),
        });
        vault.replaceAllEmbeddings(pairs);
      },
    };
    const cap = capture();
    const code = await runMemoryCli(
      ["reembed", "--force"],
      cap.io,
      {},
      { vault: wrappedVault, embedText: fakeEmbedder() },
    );
    expect(code).toBe(1);
    expect(cap.out()).toContain("failed:");
    // The late-arriving embedding survived — --force did not silently delete it.
    expect(vault.getEmbedding(mid("late"))).toBeDefined();
    // a's embedding is likewise untouched (transaction rolled back before delete).
    expect(vault.getEmbedding(a.id)).toBeDefined();
  });
});

describe("runMemoryCli error handling", () => {
  it("exits 1 and prints the message when the vault factory throws", async () => {
    const cap = capture();
    const code = await runMemoryCli(
      ["stats"],
      cap.io,
      {},
      {
        openVault: () => {
          throw new Error("vault is locked");
        },
      },
    );
    expect(code).toBe(1);
    expect(cap.err()).toContain("vault is locked");
  });
});
