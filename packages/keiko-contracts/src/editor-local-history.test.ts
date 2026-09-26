import { describe, expect, it } from "vitest";
import {
  isWorkspaceContentDigest,
  isWorkspaceHistoryEntryRef,
  isWorkspaceIsoInstant,
  isWorkspacePathDigest,
  isWorkspaceRootIdentityDigest,
  isWorkspaceRootRef,
  isWorkspaceVaultEntryRef,
} from "./workspace-contract-primitives.js";
import {
  EDITOR_LOCAL_HISTORY_ENCRYPTION,
  EDITOR_LOCAL_HISTORY_MAX_ENTRY_BYTES,
  EDITOR_LOCAL_HISTORY_MAX_ENTRIES,
  EDITOR_LOCAL_HISTORY_MAX_PINNED_BYTES,
  EDITOR_LOCAL_HISTORY_MAX_TOTAL_BYTES,
  EDITOR_LOCAL_HISTORY_MAX_VERSIONS_PER_FILE,
  EDITOR_LOCAL_HISTORY_SCHEMA_VERSION,
  planEditorLocalHistoryRetention,
  validateEditorLocalHistoryEntry,
  validateEditorLocalHistoryIndex,
} from "./editor-local-history.js";
import type { EditorLocalHistoryEntry, EditorLocalHistoryIndex } from "./editor-local-history.js";

function checked<Value>(value: string, guard: (input: unknown) => input is Value): Value {
  if (!guard(value)) throw new Error(`invalid fixture: ${value}`);
  return value;
}

const ROOT = checked("root-primary", isWorkspaceRootRef);
const ROOT_DIGEST = checked("a".repeat(64), isWorkspaceRootIdentityDigest);
const ENTRY = checked("history-primary", isWorkspaceHistoryEntryRef);
const VAULT = checked("vault-primary", isWorkspaceVaultEntryRef);
const CONTENT_DIGEST = checked("b".repeat(64), isWorkspaceContentDigest);
const PATH_DIGEST = checked("c".repeat(64), isWorkspacePathDigest);
const PAYLOAD_DIGEST = checked("d".repeat(64), isWorkspaceContentDigest);
const RECORDED_AT = checked("2026-07-18T12:00:00.000Z", isWorkspaceIsoInstant);

function entry(overrides: Partial<EditorLocalHistoryEntry> = {}): EditorLocalHistoryEntry {
  return {
    kind: "local-history-entry",
    schemaVersion: EDITOR_LOCAL_HISTORY_SCHEMA_VERSION,
    entryRef: ENTRY,
    workspaceId: "workspace-1",
    rootRef: ROOT,
    rootIdentityDigest: ROOT_DIGEST,
    relativePath: "src/main.ts",
    relativePathDigest: PATH_DIGEST,
    predecessor: { outcome: "absent" },
    sequence: 1,
    origin: "user-save",
    recordedAt: RECORDED_AT,
    lastAccessedAt: RECORDED_AT,
    plaintextContentDigest: CONTENT_DIGEST,
    plaintextByteLength: 128,
    payloadBindingDigest: PAYLOAD_DIGEST,
    encryptedContent: {
      kind: "vault-reference",
      vaultEntryRef: VAULT,
      encryption: EDITOR_LOCAL_HISTORY_ENCRYPTION,
    },
    pinned: false,
    pinnedAt: { outcome: "absent" },
    ...overrides,
  };
}

function index(entries: readonly EditorLocalHistoryEntry[]): EditorLocalHistoryIndex {
  return {
    kind: "local-history-index",
    schemaVersion: EDITOR_LOCAL_HISTORY_SCHEMA_VERSION,
    workspaceId: "workspace-1",
    revision: 1,
    maxEntries: EDITOR_LOCAL_HISTORY_MAX_ENTRIES,
    totalPlaintextBytes: entries.reduce((total, current) => total + current.plaintextByteLength, 0),
    entries,
  };
}

function indexedEntry(
  position: number,
  overrides: Partial<EditorLocalHistoryEntry> = {},
): EditorLocalHistoryEntry {
  return entry({
    entryRef: checked(`history-${String(position)}`, isWorkspaceHistoryEntryRef),
    sequence: position + 1,
    encryptedContent: {
      kind: "vault-reference",
      vaultEntryRef: checked(`vault-${String(position)}`, isWorkspaceVaultEntryRef),
      encryption: EDITOR_LOCAL_HISTORY_ENCRYPTION,
    },
    ...overrides,
  });
}

describe("encrypted editor local history contracts", () => {
  it("accepts metadata self-bound to encrypted vault content", () => {
    expect(validateEditorLocalHistoryEntry(entry())).toEqual({ ok: true });
    expect(validateEditorLocalHistoryEntry(entry({ plaintextByteLength: 0 }))).toEqual({
      ok: true,
    });
    expect(validateEditorLocalHistoryIndex(index([entry()]))).toEqual({ ok: true });
  });

  it("rejects transcript/raw content, unsafe paths, and inconsistent indexes", () => {
    expect(validateEditorLocalHistoryEntry({ ...entry(), rawContent: "source" }).ok).toBe(false);
    expect(validateEditorLocalHistoryEntry({ ...entry(), origin: "transcript" }).ok).toBe(false);
    expect(validateEditorLocalHistoryEntry({ ...entry(), relativePath: "../escape" }).ok).toBe(
      false,
    );
    expect(validateEditorLocalHistoryIndex(index([entry(), entry()])).ok).toBe(false);
    expect(
      validateEditorLocalHistoryIndex({ ...index([entry()]), totalPlaintextBytes: 127 }).ok,
    ).toBe(false);
    expect(
      validateEditorLocalHistoryIndex(index([entry({ workspaceId: "workspace-other" })])).ok,
    ).toBe(false);
    expect(
      validateEditorLocalHistoryEntry({
        ...entry(),
        encryptedContent: { ...entry().encryptedContent, ciphertext: "forbidden" },
      }).ok,
    ).toBe(false);
    expect(
      validateEditorLocalHistoryEntry({ ...entry(), lastAccessedAt: "2026-07-18T11:00:00.000Z" })
        .ok,
    ).toBe(false);
  });

  it("enforces consistent pin metadata", () => {
    expect(
      validateEditorLocalHistoryEntry(
        entry({ pinned: true, pinnedAt: { outcome: "known", value: RECORDED_AT } }),
      ),
    ).toEqual({ ok: true });
    expect(
      validateEditorLocalHistoryEntry(entry({ pinned: true, pinnedAt: { outcome: "absent" } })).ok,
    ).toBe(false);
  });

  it("enforces entry, workspace, pinned, and per-file version bounds", () => {
    expect(
      validateEditorLocalHistoryEntry(
        entry({ plaintextByteLength: EDITOR_LOCAL_HISTORY_MAX_ENTRY_BYTES + 1 }),
      ).ok,
    ).toBe(false);
    const tooManyForFile = Array.from(
      { length: EDITOR_LOCAL_HISTORY_MAX_VERSIONS_PER_FILE + 1 },
      (_, position) => indexedEntry(position),
    );
    expect(validateEditorLocalHistoryIndex(index(tooManyForFile.slice(1))).ok).toBe(true);
    expect(validateEditorLocalHistoryIndex(index(tooManyForFile)).ok).toBe(false);

    const overTotal = Array.from(
      {
        length:
          Math.floor(EDITOR_LOCAL_HISTORY_MAX_TOTAL_BYTES / EDITOR_LOCAL_HISTORY_MAX_ENTRY_BYTES) +
          1,
      },
      (_, position) =>
        indexedEntry(position, {
          plaintextByteLength: EDITOR_LOCAL_HISTORY_MAX_ENTRY_BYTES,
          relativePath: `src/file-${String(position)}.ts`,
          relativePathDigest: checked(
            position.toString(16).padStart(64, "0"),
            isWorkspacePathDigest,
          ),
        }),
    );
    expect(validateEditorLocalHistoryIndex(index(overTotal)).ok).toBe(false);

    const overPinned = Array.from(
      {
        length:
          Math.floor(EDITOR_LOCAL_HISTORY_MAX_PINNED_BYTES / EDITOR_LOCAL_HISTORY_MAX_ENTRY_BYTES) +
          1,
      },
      (_, position) =>
        indexedEntry(position, {
          plaintextByteLength: EDITOR_LOCAL_HISTORY_MAX_ENTRY_BYTES,
          pinned: true,
          pinnedAt: { outcome: "known", value: RECORDED_AT },
          relativePath: `src/pinned-${String(position)}.ts`,
          relativePathDigest: checked(
            (position + 100).toString(16).padStart(64, "0"),
            isWorkspacePathDigest,
          ),
        }),
    );
    expect(validateEditorLocalHistoryIndex(index(overPinned)).ok).toBe(false);

    const tooManyEntries = Array.from(
      { length: EDITOR_LOCAL_HISTORY_MAX_ENTRIES + 1 },
      (_, position) =>
        indexedEntry(position, {
          relativePath: `src/count-${String(position)}.ts`,
          relativePathDigest: checked(
            (position + 500).toString(16).padStart(64, "0"),
            isWorkspacePathDigest,
          ),
        }),
    );
    expect(validateEditorLocalHistoryIndex(index(tooManyEntries)).ok).toBe(false);
  });

  it("rejects checkpoint identity replay even when entry and vault refs differ", () => {
    const first = indexedEntry(0, { sequence: 7 });
    const replay = indexedEntry(1, { sequence: 7 });
    expect(validateEditorLocalHistoryIndex(index([first, replay])).ok).toBe(false);
    expect(
      validateEditorLocalHistoryIndex(
        index([first, indexedEntry(2, { encryptedContent: first.encryptedContent, sequence: 8 })]),
      ).ok,
    ).toBe(false);
  });

  it("retention is deterministic, count/byte bounded, and never evicts pins", () => {
    const pinnedRef = checked("history-pinned", isWorkspaceHistoryEntryRef);
    const olderRef = checked("history-older", isWorkspaceHistoryEntryRef);
    const later = checked("2026-07-18T13:00:00.000Z", isWorkspaceIsoInstant);
    const pinned = entry({
      entryRef: pinnedRef,
      pinned: true,
      pinnedAt: { outcome: "known", value: RECORDED_AT },
    });
    const older = entry({ entryRef: olderRef });
    const newer = entry({ entryRef: ENTRY, lastAccessedAt: later });
    const plan = planEditorLocalHistoryRetention([pinned, older, newer], {
      requiredEntryCount: 2,
      requiredByteCount: 256,
    });
    expect(plan).toEqual({ ok: true, entryRefs: [olderRef, ENTRY] });
    expect(plan.entryRefs).not.toContain(pinnedRef);
  });

  it("returns typed pressure instead of deleting pins", () => {
    const pinned = entry({
      pinned: true,
      pinnedAt: { outcome: "known", value: RECORDED_AT },
    });
    expect(
      planEditorLocalHistoryRetention([pinned], {
        requiredEntryCount: 1,
        requiredByteCount: 1,
      }),
    ).toEqual({ ok: false, entryRefs: [], reason: "PINNED_CAPACITY_EXHAUSTED" });
  });

  it("distinguishes malformed retention pressure from exhausted pin capacity", () => {
    expect(
      planEditorLocalHistoryRetention([], {
        requiredEntryCount: -1,
        requiredByteCount: 0,
      }),
    ).toEqual({ ok: false, entryRefs: [], reason: "INVALID_REQUIREMENT" });
  });

  it("keeps validators total for hostile metadata", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error("hostile keys");
        },
      },
    );
    expect(() => validateEditorLocalHistoryEntry(hostile)).not.toThrow();
    expect(() => validateEditorLocalHistoryIndex(hostile)).not.toThrow();
    expect(validateEditorLocalHistoryEntry(hostile).ok).toBe(false);
    expect(validateEditorLocalHistoryIndex(hostile).ok).toBe(false);
  });

  // KEIKO-0940: the pre-fix validator ran `entries.every(isHistoryEntry)` up to four times per
  // validation call. Prove the fix keeps it at ONCE with a Proxy that counts entry access.
  it("validates each index entry only once per validateEditorLocalHistoryIndex call (KEIKO-0940)", () => {
    const entries = Array.from({ length: 32 }, (_, i) => indexedEntry(i + 1));
    let accessCount = 0;
    const observed = entries.map((raw): EditorLocalHistoryEntry => {
      return new Proxy(raw, {
        get(target: EditorLocalHistoryEntry, key: string | symbol, receiver: unknown): unknown {
          if (key === "kind") accessCount += 1;
          return Reflect.get(target, key, receiver);
        },
      });
    });
    const result = validateEditorLocalHistoryIndex({
      ...index(entries),
      entries: observed as unknown as readonly EditorLocalHistoryEntry[],
    });
    expect(result.ok).toBe(true);
    // The `kind` field is the very first thing isHistoryEntry reads (via isWorkspaceRecord →
    // exactKeys). Pre-fix ran that four times per entry (128 total for 32 entries); post-fix
    // runs it once each (32). A ratio ≤2×entries is a comfortable guard against silent
    // regression to the O(4·n) shape.
    expect(accessCount).toBeLessThanOrEqual(entries.length * 2);
  });
});
