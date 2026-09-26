import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { InstrumentationSnapshot } from "@oscharko-dev/keiko-contracts";
import { DAP_DEBUG_CONTRACT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/dap-debug";

import type { ServerDiagnosticRecord } from "../../diagnostics-log.js";
import { savePrivateJson } from "../../private-json.js";
import { inspectDebugWorkspaceIdentity } from "./debugLaunchContext.js";
import {
  BREAKPOINT_STORE_LIMITS,
  breakpointStoreRecordPath,
  breakpointStoreWorkspaceFingerprint,
  createBreakpointStore,
  type BreakpointStore,
  type BreakpointStoreMutationResult,
  type RequestedExceptionBreakpointFilter,
  type RequestedSourceBreakpoint,
  type RequestedWatchExpression,
} from "./breakpointStore.js";

const roots: string[] = [];
const DEFAULT_NODE_EXCEPTION_FILTERS = [
  { filterId: "uncaught", enabled: false },
  { filterId: "caught", enabled: false },
] as const;

function temporaryDirectory(label: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), `keiko-${label}-`)));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function currentSnapshot(store: BreakpointStore, root: string): InstrumentationSnapshot {
  const result = store.snapshot(root);
  if (!result.ok) throw new Error(`expected available state, received ${result.reason}`);
  return result.snapshot;
}

function breakpoint(line: number, extras = {}): RequestedSourceBreakpoint {
  return { line, enabled: true, ...extras };
}

function watch(index: number): RequestedWatchExpression {
  return { expression: `state.value${String(index)}`, enabled: true };
}

function exceptionFilter(index: number): RequestedExceptionBreakpointFilter {
  return { filterId: `exception_${String(index)}`, enabled: true };
}

function setBreakpoints(
  store: BreakpointStore,
  root: string,
  fileId: string,
  requested: readonly RequestedSourceBreakpoint[],
): BreakpointStoreMutationResult {
  const before = currentSnapshot(store, root);
  return store.setBreakpointsForFile(root, before.revision, before.etag, fileId, requested);
}

function setWatches(
  store: BreakpointStore,
  root: string,
  requested: readonly RequestedWatchExpression[],
): BreakpointStoreMutationResult {
  const before = currentSnapshot(store, root);
  return store.setWatches(root, before.revision, before.etag, requested);
}

function setExceptionBreakpoints(
  store: BreakpointStore,
  root: string,
  requested: readonly RequestedExceptionBreakpointFilter[],
): BreakpointStoreMutationResult {
  const before = currentSnapshot(store, root);
  return store.setExceptionBreakpoints(root, before.revision, before.etag, requested);
}

function validRecord(root: string): Record<string, unknown> {
  return {
    schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
    workspaceFingerprint: breakpointStoreWorkspaceFingerprint(root),
    rootObjectIdentityDigest: inspectDebugWorkspaceIdentity(root).objectIdentityDigest,
    revision: 0,
    breakpoints: [],
    exceptionFilters: DEFAULT_NODE_EXCEPTION_FILTERS,
    watches: [],
  };
}

function writeRecord(stateDir: string, root: string, value: unknown): void {
  writeFileSync(breakpointStoreRecordPath(stateDir, root), JSON.stringify(value), "utf8");
}

function expectUnavailable(store: BreakpointStore, root: string): void {
  const result = store.snapshot(root);
  expect(result).toMatchObject({ ok: false, reason: "state_unavailable" });
  expect(result.snapshot).toMatchObject({
    revision: 0,
    breakpoints: [],
    exceptionFilters: DEFAULT_NODE_EXCEPTION_FILTERS,
    watches: [],
  });
}

/**
 * Replace the directory at `path` with a genuinely different filesystem object. The replacement is
 * created BEFORE the original is removed, so its inode was allocated while the old one was still in
 * use and can never be the recycled one — deleting and re-creating in place is not deterministic,
 * since Linux commonly hands the freed inode straight back (mirrors editorSettingsStore.test.ts's
 * identical helper, the reference implementation for this exact "root replaced at the same path"
 * scenario).
 */
function replaceDirectory(path: string): void {
  const staged = `${path}.replacement`;
  mkdirSync(staged);
  rmSync(path, { recursive: true, force: true });
  renameSync(staged, path);
}

function parseJsonRecord(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a JSON record");
  }
  return value as Record<string, unknown>;
}

function collectJsonKeys(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(collectJsonKeys);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) => [key, ...collectJsonKeys(entry)]);
}

describe("canonical breakpoint and watch persistence", () => {
  it("treats a missing record as an available empty snapshot", () => {
    const stateDir = temporaryDirectory("debug-state-missing");
    const root = temporaryDirectory("debug-workspace-missing");
    const snapshot = currentSnapshot(createBreakpointStore({ stateDir }), root);

    expect(snapshot.etag).toMatch(/^"[a-f0-9]{64}"$/u);
    expect(snapshot).toEqual({
      schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
      workspaceId: breakpointStoreWorkspaceFingerprint(root),
      revision: 0,
      etag: snapshot.etag,
      breakpoints: [],
      exceptionFilters: DEFAULT_NODE_EXCEPTION_FILTERS,
      watches: [],
    });
  });

  it("round-trips through the fingerprint-only atomic private JSON path", () => {
    const stateDir = temporaryDirectory("debug-state-roundtrip");
    const root = temporaryDirectory("debug-workspace-roundtrip");
    const paths: string[] = [];
    const store = createBreakpointStore({
      stateDir,
      save: (path, value): void => {
        paths.push(path);
        savePrivateJson(path, value);
      },
      idFactory: (): string => "breakpoint_roundtrip",
    });

    const result = setBreakpoints(store, root, "src/example.ts", [
      breakpoint(7, { condition: "ready", hitCondition: "2" }),
    ]);

    expect(result.ok).toBe(true);
    expect(paths).toEqual([breakpointStoreRecordPath(stateDir, root)]);
    expect(basename(paths[0] ?? "")).toBe(
      `debug-instrumentation-${breakpointStoreWorkspaceFingerprint(root)}.json`,
    );
    expect(readdirSync(stateDir)).toEqual([basename(paths[0] ?? "")]);
    expect(createBreakpointStore({ stateDir }).snapshot(root)).toEqual({
      ok: true,
      snapshot: result.snapshot,
    });
  });

  it("returns unavailable and denies mutation through a symlinked state path", () => {
    const parent = temporaryDirectory("debug-state-symlink");
    const root = temporaryDirectory("debug-workspace-symlink");
    const realState = join(parent, "real-state");
    const linkedState = join(parent, "linked-state");
    mkdirSync(realState);
    symlinkSync(realState, linkedState);
    const store = createBreakpointStore({ stateDir: linkedState });

    expectUnavailable(store, root);
    expect(
      store.setBreakpointsForFile(root, 0, `"${"0".repeat(64)}"`, "a.ts", [breakpoint(1)]),
    ).toMatchObject({ ok: false, reason: "state_unavailable", snapshot: { revision: 0 } });
  });

  it("returns unavailable and denies mutation when state is inside the workspace", () => {
    const root = temporaryDirectory("debug-workspace-contained-state");
    const store = createBreakpointStore({ stateDir: join(root, ".private") });

    expectUnavailable(store, root);
    const unavailable = store.setWatches(root, 0, `"${"0".repeat(64)}"`, [watch(1)]);
    expect(unavailable).toMatchObject({ ok: false, reason: "state_unavailable" });
  });

  it("fails closed for corrupt JSON", () => {
    const stateDir = temporaryDirectory("debug-state-malformed");
    const root = temporaryDirectory("debug-workspace-malformed");
    writeFileSync(breakpointStoreRecordPath(stateDir, root), "{broken", "utf8");

    expectUnavailable(createBreakpointStore({ stateDir }), root);
  });

  it.each(["unknown record key", "sparse-equivalent persisted array"])(
    "fails closed for %s",
    (malformation) => {
      const stateDir = temporaryDirectory("debug-state-malformed-record");
      const root = temporaryDirectory("debug-workspace-malformed-record");
      const base = validRecord(root);
      const value =
        malformation === "unknown record key"
          ? { ...base, extra: true }
          : { ...base, breakpoints: [null] };
      writeRecord(stateDir, root, value);

      expectUnavailable(createBreakpointStore({ stateDir }), root);
    },
  );

  it("fails closed for an unknown nested key and duplicate persisted ids", () => {
    const stateDir = temporaryDirectory("debug-state-nested-invalid");
    const root = temporaryDirectory("debug-workspace-nested-invalid");
    const persisted = {
      id: "duplicate",
      fileId: "a.ts",
      line: 1,
      enabled: true,
      kind: "line",
      verification: "pending",
    };
    writeRecord(stateDir, root, {
      ...validRecord(root),
      breakpoints: [{ ...persisted, unknown: true }, persisted],
    });

    expectUnavailable(createBreakpointStore({ stateDir }), root);
  });

  it("fails closed for an oversized record without reading it", () => {
    const stateDir = temporaryDirectory("debug-state-oversized");
    const root = temporaryDirectory("debug-workspace-oversized");
    let reads = 0;
    const store = createBreakpointStore({
      stateDir,
      size: (): number => BREAKPOINT_STORE_LIMITS.maxRecordBytes + 1,
      read: (): string => {
        reads += 1;
        return JSON.stringify(validRecord(root));
      },
    });

    expectUnavailable(store, root);
    expect(reads).toBe(0);
  });

  it("fails closed for unreadable state and a wrong workspace fingerprint", () => {
    const stateDir = temporaryDirectory("debug-state-unreadable");
    const root = temporaryDirectory("debug-workspace-unreadable");
    const unreadable = createBreakpointStore({
      stateDir,
      read: (): string => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    });
    writeRecord(stateDir, root, { ...validRecord(root), workspaceFingerprint: "a".repeat(64) });

    expectUnavailable(unreadable, root);
    expectUnavailable(createBreakpointStore({ stateDir }), root);
  });

  it("rejects sparse and unknown-key mutation arrays without changing state", () => {
    const stateDir = temporaryDirectory("debug-state-sparse-input");
    const root = temporaryDirectory("debug-workspace-sparse-input");
    const store = createBreakpointStore({ stateDir });
    const before = currentSnapshot(store, root);
    const sparse = Array<RequestedSourceBreakpoint>(2);
    sparse[1] = breakpoint(2);

    const sparseResult = store.setBreakpointsForFile(
      root,
      before.revision,
      before.etag,
      "a.ts",
      sparse,
    );
    const hostileWatch = { ...watch(1), unexpected: true } as unknown as RequestedWatchExpression;
    const unknown = store.setWatches(root, before.revision, before.etag, [hostileWatch]);
    expect(sparseResult).toMatchObject({ ok: false, reason: "invalid", snapshot: before });
    expect(unknown).toMatchObject({ ok: false, reason: "invalid", snapshot: before });
  });

  it("rejects stale revisions and stale ETags with an unchanged snapshot", () => {
    const stateDir = temporaryDirectory("debug-state-conflict");
    const root = temporaryDirectory("debug-workspace-conflict");
    const store = createBreakpointStore({ stateDir, idFactory: (): string => "conflict_id" });
    const initial = currentSnapshot(store, root);
    const accepted = setBreakpoints(store, root, "a.ts", [breakpoint(1)]);
    expect(accepted.ok).toBe(true);
    const current = currentSnapshot(store, root);

    const staleRevision = store.setWatches(root, initial.revision, current.etag, [watch(1)]);
    const staleEtag = store.setWatches(root, current.revision, initial.etag, [watch(1)]);
    expect(staleRevision).toMatchObject({ ok: false, reason: "conflict", snapshot: current });
    expect(staleEtag).toMatchObject({ ok: false, reason: "conflict", snapshot: current });
  });

  it("rejects the 65th per-file breakpoint without silently evicting existing entries", () => {
    const stateDir = temporaryDirectory("debug-state-file-cap");
    const root = temporaryDirectory("debug-workspace-file-cap");
    let id = 0;
    const store = createBreakpointStore({
      stateDir,
      idFactory: () => `file_cap_${String(id++)}`,
    });
    const accepted = setBreakpoints(
      store,
      root,
      "a.ts",
      Array.from({ length: 64 }, (_, index) => breakpoint(index + 1)),
    );
    expect(accepted.ok).toBe(true);
    const before = currentSnapshot(store, root);

    const rejected = setBreakpoints(
      store,
      root,
      "a.ts",
      Array.from({ length: 65 }, (_, index) => breakpoint(index + 1)),
    );
    expect(rejected).toMatchObject({
      ok: false,
      reason: "cap_exceeded",
      retainedCount: 64,
      rejectedCount: 65,
      snapshot: before,
    });
  });

  it("rejects the 201st workspace breakpoint and preserves all existing files", () => {
    const stateDir = temporaryDirectory("debug-state-total-cap");
    const root = temporaryDirectory("debug-workspace-total-cap");
    let id = 0;
    const store = createBreakpointStore({
      stateDir,
      idFactory: () => `total_cap_${String(id++)}`,
    });
    for (let file = 0; file < 4; file += 1) {
      const result = setBreakpoints(
        store,
        root,
        `src/file-${String(file)}.ts`,
        Array.from({ length: 50 }, (_, index) => breakpoint(index + 1)),
      );
      expect(result.ok).toBe(true);
    }
    const before = currentSnapshot(store, root);

    const rejected = setBreakpoints(store, root, "src/overflow.ts", [breakpoint(1)]);
    expect(rejected).toMatchObject({ ok: false, reason: "cap_exceeded", snapshot: before });
    expect(rejected.snapshot.breakpoints).toHaveLength(200);
  });

  it("rejects the 33rd watch and does not evict the prior watch list", () => {
    const stateDir = temporaryDirectory("debug-state-watch-cap");
    const root = temporaryDirectory("debug-workspace-watch-cap");
    let id = 0;
    const store = createBreakpointStore({
      stateDir,
      idFactory: () => `watch_cap_${String(id++)}`,
    });
    expect(
      setWatches(
        store,
        root,
        Array.from({ length: 32 }, (_, index) => watch(index)),
      ).ok,
    ).toBe(true);
    const before = currentSnapshot(store, root);

    const rejected = setWatches(
      store,
      root,
      Array.from({ length: 33 }, (_, index) => watch(index)),
    );
    expect(rejected).toMatchObject({
      ok: false,
      reason: "cap_exceeded",
      retainedCount: 32,
      rejectedCount: 33,
      snapshot: before,
    });
  });

  it("round-trips exception filters and rejects the 33rd without eviction", () => {
    const stateDir = temporaryDirectory("debug-state-exception-cap");
    const root = temporaryDirectory("debug-workspace-exception-cap");
    const store = createBreakpointStore({ stateDir });
    const accepted = setExceptionBreakpoints(
      store,
      root,
      Array.from({ length: 32 }, (_, index) => exceptionFilter(index)),
    );
    expect(accepted).toMatchObject({ ok: true, retainedCount: 32 });
    expect(createBreakpointStore({ stateDir }).snapshot(root)).toEqual({
      ok: true,
      snapshot: accepted.snapshot,
    });
    const before = currentSnapshot(store, root);

    const rejected = setExceptionBreakpoints(
      store,
      root,
      Array.from({ length: 33 }, (_, index) => exceptionFilter(index)),
    );
    expect(rejected).toMatchObject({
      ok: false,
      reason: "cap_exceeded",
      retainedCount: 32,
      rejectedCount: 33,
      snapshot: before,
    });
  });

  it("validates exception filter conditions, duplicates, and optimistic concurrency", () => {
    const stateDir = temporaryDirectory("debug-state-exception-validation");
    const root = temporaryDirectory("debug-workspace-exception-validation");
    const store = createBreakpointStore({ stateDir });
    const initial = currentSnapshot(store, root);
    expect(
      setExceptionBreakpoints(store, root, [{ ...exceptionFilter(1), condition: "a".repeat(1024) }])
        .ok,
    ).toBe(true);
    const current = currentSnapshot(store, root);

    const overflow = setExceptionBreakpoints(store, root, [
      { ...exceptionFilter(1), condition: "é".repeat(513) },
    ]);
    const duplicate = setExceptionBreakpoints(store, root, [
      exceptionFilter(1),
      exceptionFilter(1),
    ]);
    const stale = store.setExceptionBreakpoints(root, initial.revision, current.etag, [
      exceptionFilter(2),
    ]);
    expect(overflow).toMatchObject({ ok: false, reason: "invalid", snapshot: current });
    expect(duplicate).toMatchObject({ ok: false, reason: "invalid", snapshot: current });
    expect(stale).toMatchObject({ ok: false, reason: "conflict", snapshot: current });
  });

  it("allows replacement to reduce the canonical breakpoint and watch collections", () => {
    const stateDir = temporaryDirectory("debug-state-reduce");
    const root = temporaryDirectory("debug-workspace-reduce");
    let id = 0;
    const store = createBreakpointStore({
      stateDir,
      idFactory: () => `reduce_${String(id++)}`,
    });
    setBreakpoints(
      store,
      root,
      "a.ts",
      Array.from({ length: 64 }, (_, index) => breakpoint(index + 1)),
    );
    setWatches(
      store,
      root,
      Array.from({ length: 32 }, (_, index) => watch(index)),
    );

    expect(setBreakpoints(store, root, "a.ts", [breakpoint(4)])).toMatchObject({
      ok: true,
      retainedCount: 1,
      snapshot: { breakpoints: [{ line: 4 }] },
    });
    expect(setWatches(store, root, [watch(4)])).toMatchObject({
      ok: true,
      retainedCount: 1,
      snapshot: { watches: [{ expression: "state.value4" }] },
    });
  });

  it.each(["condition", "hitCondition", "logMessage"] as const)(
    "accepts exactly 1024 UTF-8 bytes for %s and rejects multibyte overflow",
    (field) => {
      const stateDir = temporaryDirectory(`debug-state-${field}`);
      const root = temporaryDirectory(`debug-workspace-${field}`);
      let id = 0;
      const store = createBreakpointStore({
        stateDir,
        idFactory: () => `${field}_${String(id++)}`,
      });
      const exact = setBreakpoints(store, root, "a.ts", [
        breakpoint(1, { [field]: "a".repeat(1024) }),
      ]);
      expect(exact.ok).toBe(true);
      const before = currentSnapshot(store, root);

      const overflow = setBreakpoints(store, root, "a.ts", [
        breakpoint(1, { [field]: "é".repeat(513) }),
      ]);
      expect(overflow).toMatchObject({ ok: false, reason: "invalid", snapshot: before });
    },
  );

  it("accepts a 1024-byte watch expression and rejects a multibyte overflow", () => {
    const stateDir = temporaryDirectory("debug-state-watch-bytes");
    const root = temporaryDirectory("debug-workspace-watch-bytes");
    let id = 0;
    const store = createBreakpointStore({
      stateDir,
      idFactory: () => `watch_bytes_${String(id++)}`,
    });
    expect(setWatches(store, root, [{ expression: "a".repeat(1024), enabled: true }]).ok).toBe(
      true,
    );
    const before = currentSnapshot(store, root);

    const overflow = setWatches(store, root, [{ expression: "é".repeat(513), enabled: true }]);
    expect(overflow).toMatchObject({ ok: false, reason: "invalid", snapshot: before });
  });

  it("preserves revision, ETag, and ids for semantic no-op replacements", () => {
    const stateDir = temporaryDirectory("debug-state-noop");
    const root = temporaryDirectory("debug-workspace-noop");
    let calls = 0;
    const store = createBreakpointStore({
      stateDir,
      idFactory: () => `noop_${String(calls++)}`,
    });
    setBreakpoints(store, root, "a.ts", [breakpoint(1)]);
    setWatches(store, root, [watch(1)]);
    setExceptionBreakpoints(store, root, [exceptionFilter(1)]);
    const before = currentSnapshot(store, root);

    const breakpoints = setBreakpoints(store, root, "a.ts", [breakpoint(1)]);
    const watches = setWatches(store, root, [watch(1)]);
    const filters = setExceptionBreakpoints(store, root, [exceptionFilter(1)]);
    expect(breakpoints).toMatchObject({ ok: true, snapshot: before });
    expect(watches).toMatchObject({ ok: true, snapshot: before });
    expect(filters).toMatchObject({ ok: true, snapshot: before });
    expect(calls).toBe(2);
  });

  it("reconciles exact adapter verification sets without trusting unknown ids", () => {
    const stateDir = temporaryDirectory("debug-state-verification");
    const root = temporaryDirectory("debug-workspace-verification");
    let id = 0;
    const store = createBreakpointStore({
      stateDir,
      idFactory: () => `verification_${String(id++)}`,
    });
    const armed = setBreakpoints(store, root, "a.ts", [breakpoint(1), breakpoint(2)]);
    expect(armed.ok).toBe(true);
    const updates = armed.snapshot.breakpoints.map((entry, index) => ({
      id: entry.id,
      verification: index === 0 ? ("verified" as const) : ("rejected" as const),
    }));
    const reconciled = store.setBreakpointVerifications(
      root,
      armed.snapshot.revision,
      armed.snapshot.etag,
      "a.ts",
      updates,
    );
    expect(reconciled).toMatchObject({
      ok: true,
      snapshot: {
        revision: armed.snapshot.revision + 1,
        breakpoints: [{ verification: "verified" }, { verification: "rejected" }],
      },
    });
    const before = currentSnapshot(store, root);
    const unknown = store.setBreakpointVerifications(root, before.revision, before.etag, "a.ts", [
      { id: "unknown", verification: "verified" },
      updates[1] ?? { id: "missing", verification: "rejected" },
    ]);
    expect(unknown).toMatchObject({ ok: false, reason: "invalid", snapshot: before });
  });

  it("mints unique opaque ids and rejects an exhausted duplicate factory", () => {
    const stateDir = temporaryDirectory("debug-state-ids");
    const root = temporaryDirectory("debug-workspace-ids");
    const candidates = ["same", "same", "unique"];
    const store = createBreakpointStore({
      stateDir,
      idFactory: () => candidates.shift() ?? "unique",
    });
    const accepted = setBreakpoints(store, root, "a.ts", [breakpoint(1), breakpoint(2)]);
    expect(accepted.ok).toBe(true);
    expect(new Set(accepted.snapshot.breakpoints.map((entry) => entry.id)).size).toBe(2);

    const stuck = createBreakpointStore({ stateDir, idFactory: (): string => "same" });
    const before = currentSnapshot(stuck, root);
    const rejected = setWatches(stuck, root, [watch(1), watch(2)]);
    expect(rejected).toMatchObject({ ok: false, reason: "invalid", snapshot: before });
  });

  it("deep-freezes copied snapshots so callers cannot mutate canonical state", () => {
    const stateDir = temporaryDirectory("debug-state-freeze");
    const root = temporaryDirectory("debug-workspace-freeze");
    const store = createBreakpointStore({ stateDir, idFactory: (): string => "frozen_id" });
    setBreakpoints(store, root, "a.ts", [breakpoint(1)]);
    const snapshot = currentSnapshot(store, root);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.breakpoints)).toBe(true);
    const first = snapshot.breakpoints[0];
    expect(first).toBeDefined();
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => Object.defineProperty(snapshot.breakpoints, "1", { value: first })).toThrow();
    expect(currentSnapshot(store, root)).toEqual(snapshot);
  });

  it("leaves the prior atomic record readable when an injected save fails", () => {
    const stateDir = temporaryDirectory("debug-state-save-failure");
    const root = temporaryDirectory("debug-workspace-save-failure");
    let fail = false;
    let id = 0;
    const store = createBreakpointStore({
      stateDir,
      idFactory: () => `save_${String(id++)}`,
      save: (path, value): void => {
        if (fail) throw new Error("injected save failure");
        savePrivateJson(path, value);
      },
    });
    expect(setBreakpoints(store, root, "a.ts", [breakpoint(1)]).ok).toBe(true);
    const before = currentSnapshot(store, root);
    fail = true;

    const rejected = setWatches(store, root, [watch(1)]);
    expect(rejected).toMatchObject({ ok: false, reason: "state_unavailable", snapshot: before });
    expect(currentSnapshot(createBreakpointStore({ stateDir }), root)).toEqual(before);
  });

  it("emits a redacted operator diagnostic when persisting instrumentation state throws", () => {
    const stateDir = temporaryDirectory("debug-state-save-diagnostic");
    const root = temporaryDirectory("debug-workspace-save-diagnostic");
    const secret = "SENTINEL_DISK_FAULT_ENOSPC";
    const records: ServerDiagnosticRecord[] = [];
    let fail = false;
    let id = 0;
    const store = createBreakpointStore({
      stateDir,
      idFactory: () => `diag_${String(id++)}`,
      save: (path, value): void => {
        if (fail) throw new Error(secret);
        savePrivateJson(path, value);
      },
      diagnosticSink: {
        record: (record): void => {
          records.push(record);
        },
      },
    });
    expect(setBreakpoints(store, root, "a.ts", [breakpoint(1)]).ok).toBe(true);
    fail = true;

    const rejected = setWatches(store, root, [watch(1)]);

    expect(rejected).toMatchObject({ ok: false, reason: "state_unavailable" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      correlationId: breakpointStoreWorkspaceFingerprint(root),
      operation: "dap.breakpoint-store.commit",
      source: "breakpointStore.commitRecord",
      message: "Persisting debug instrumentation state failed.",
    });
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(JSON.stringify(records)).not.toContain(root);
  });

  it("clears atomically and increments revision only when canonical state changes", () => {
    const stateDir = temporaryDirectory("debug-state-clear");
    const root = temporaryDirectory("debug-workspace-clear");
    const store = createBreakpointStore({ stateDir, idFactory: (): string => "clear_id" });
    const empty = currentSnapshot(store, root);
    expect(store.clearAll(root, empty.revision, empty.etag)).toMatchObject({
      ok: true,
      snapshot: empty,
    });
    setBreakpoints(store, root, "a.ts", [breakpoint(1)]);
    const populated = currentSnapshot(store, root);

    const cleared = store.clearAll(root, populated.revision, populated.etag);
    expect(cleared).toMatchObject({
      ok: true,
      snapshot: { revision: populated.revision + 1, breakpoints: [], watches: [] },
    });
  });

  it("persists instrumentation only, with no evaluation, output, value, evidence, or log fields", () => {
    const stateDir = temporaryDirectory("debug-state-content-boundary");
    const root = temporaryDirectory("debug-workspace-content-boundary");
    const store = createBreakpointStore({ stateDir, idFactory: (): string => "content_id" });
    setWatches(store, root, [watch(1)]);

    const raw = parseJsonRecord(readFileSync(breakpointStoreRecordPath(stateDir, root), "utf8"));
    expect(Object.keys(raw)).toEqual([
      "schemaVersion",
      "workspaceFingerprint",
      "rootObjectIdentityDigest",
      "revision",
      "breakpoints",
      "exceptionFilters",
      "watches",
    ]);
    const keys = collectJsonKeys(raw);
    for (const forbidden of [
      "evaluation",
      "output",
      "result",
      "value",
      "evidence",
      "diagnostic",
      "log",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("KEIKO-0190 — object-identity reconciliation on load", () => {
  it("treats a workspace root replaced at the same path as absent, never carrying forward the prior occupant's breakpoints, watches, or revision", () => {
    // The store was keyed by sha256(realRoot) alone, so breakpoints set for one directory were
    // silently resumed by whatever directory later occupied that path. The record now binds the
    // root's filesystem-object identity, mirroring editorSettingsStore's reconcileRootBinding.
    const stateDir = temporaryDirectory("debug-state-root-replaced");
    const parent = temporaryDirectory("debug-workspace-root-replaced");
    const root = join(parent, "root");
    mkdirSync(root);
    const store = createBreakpointStore({ stateDir, idFactory: (): string => "replaced_id" });
    const armed = setBreakpoints(store, root, "a.ts", [breakpoint(1)]);
    expect(armed.ok).toBe(true);
    setWatches(store, root, [watch(1)]);
    expect(currentSnapshot(store, root).breakpoints).toHaveLength(1);

    replaceDirectory(root);

    const reloaded = store.snapshot(root);
    expect(reloaded.ok).toBe(true);
    expect(reloaded.snapshot).toMatchObject({ revision: 0, breakpoints: [], watches: [] });
  });

  it("stamps the live object identity into every committed record", () => {
    const stateDir = temporaryDirectory("debug-state-root-stamp");
    const root = temporaryDirectory("debug-workspace-root-stamp");
    const store = createBreakpointStore({ stateDir, idFactory: (): string => "stamp_id" });

    expect(setBreakpoints(store, root, "a.ts", [breakpoint(1)]).ok).toBe(true);

    const persisted = parseJsonRecord(
      readFileSync(breakpointStoreRecordPath(stateDir, root), "utf8"),
    );
    expect(persisted.rootObjectIdentityDigest).toBe(
      inspectDebugWorkspaceIdentity(root).objectIdentityDigest,
    );
  });

  it("treats a legacy record with no rootObjectIdentityDigest key as absent, not unavailable, and accepts a subsequent mutation", () => {
    // A record persisted before this feature shipped has the pre-KEIKO-0190 shape: the key is
    // entirely absent, not present-and-empty. That must parse successfully (empty-string sentinel,
    // which can never match a live digest) and fall into the existing mismatch->absent path, rather
    // than permanently locking the workspace out of mutation as "unavailable".
    const stateDir = temporaryDirectory("debug-state-legacy-record");
    const root = temporaryDirectory("debug-workspace-legacy-record");
    const legacyRecord = {
      schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
      workspaceFingerprint: breakpointStoreWorkspaceFingerprint(root),
      revision: 7,
      breakpoints: [],
      exceptionFilters: DEFAULT_NODE_EXCEPTION_FILTERS,
      watches: [],
    };
    expect(Object.keys(legacyRecord)).not.toContain("rootObjectIdentityDigest");
    writeRecord(stateDir, root, legacyRecord);
    const store = createBreakpointStore({ stateDir, idFactory: (): string => "legacy_id" });

    const snapshot = store.snapshot(root);
    expect(snapshot).toMatchObject({
      ok: true,
      snapshot: { revision: 0, breakpoints: [], watches: [] },
    });

    const mutated = store.setBreakpointsForFile(
      root,
      snapshot.snapshot.revision,
      snapshot.snapshot.etag,
      "a.ts",
      [breakpoint(1)],
    );
    expect(mutated).toMatchObject({ ok: true, snapshot: { revision: 1 } });
  });

  it("treats a present but non-string rootObjectIdentityDigest as a schema violation (unavailable)", () => {
    const stateDir = temporaryDirectory("debug-state-bad-digest-type");
    const root = temporaryDirectory("debug-workspace-bad-digest-type");
    writeRecord(stateDir, root, {
      schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
      workspaceFingerprint: breakpointStoreWorkspaceFingerprint(root),
      rootObjectIdentityDigest: 12345,
      revision: 0,
      breakpoints: [],
      exceptionFilters: DEFAULT_NODE_EXCEPTION_FILTERS,
      watches: [],
    });
    const store = createBreakpointStore({ stateDir });

    expectUnavailable(store, root);
  });

  it("rejects a commit whose live root identity drifted after loadRecord validated it, never re-stamping the new identity onto content read from the old occupant", () => {
    // Codex P1: commitRecord used to stamp whatever identity was live AT COMMIT TIME unconditionally.
    // If the root is replaced by another filesystem object between loadRecord's validation (which
    // passed against identity A) and commitRecord's own inspectDebugWorkspaceIdentity call, the old
    // occupant's record content got re-stamped with the NEW identity B and persisted as if it were
    // B's own state -- defeating the KEIKO-0190 isolation under exactly this root-swap race. The
    // idFactory hook runs after loadRecord has already validated against A but before commitRecord
    // re-inspects, so it is the injection point that reproduces the race deterministically.
    const stateDir = temporaryDirectory("debug-state-identity-drift");
    const parent = temporaryDirectory("debug-workspace-identity-drift-parent");
    const root = join(parent, "root");
    mkdirSync(root);
    const seedStore = createBreakpointStore({ stateDir, idFactory: (): string => "drift_seed_id" });
    expect(setBreakpoints(seedStore, root, "a.ts", [breakpoint(1)]).ok).toBe(true);
    const before = currentSnapshot(seedStore, root);
    const digestBeforeSwap = inspectDebugWorkspaceIdentity(root).objectIdentityDigest;
    const seededOnDisk = parseJsonRecord(
      readFileSync(breakpointStoreRecordPath(stateDir, root), "utf8"),
    );
    expect(seededOnDisk.rootObjectIdentityDigest).toBe(digestBeforeSwap);

    const driftingStore = createBreakpointStore({
      stateDir,
      idFactory: (): string => {
        replaceDirectory(root);
        return "drift_new_id";
      },
    });

    const result = driftingStore.setBreakpointsForFile(root, before.revision, before.etag, "b.ts", [
      breakpoint(9),
    ]);

    expect(result).toMatchObject({ ok: false, reason: "state_unavailable" });
    const onDisk = parseJsonRecord(readFileSync(breakpointStoreRecordPath(stateDir, root), "utf8"));
    expect(onDisk.rootObjectIdentityDigest).toBe(digestBeforeSwap);
    expect(onDisk.rootObjectIdentityDigest).not.toBe(
      inspectDebugWorkspaceIdentity(root).objectIdentityDigest,
    );
    const rawBreakpoints = onDisk.breakpoints as readonly Record<string, unknown>[];
    expect(rawBreakpoints.map((entry) => entry.fileId)).toEqual(["a.ts"]);
  });

  it("rejects a mutation whose revision-0 etag was captured before any record existed, once the root at that path is replaced by another filesystem object", () => {
    // r8 Codex P1: the absent record returned by loadRecord (no persisted file yet) used to carry
    // the identity-free "" sentinel unconditionally, so its etag never varied with the live root
    // identity. A client that read revision 0 before any persistence therefore kept a CAS token
    // that still matched after the root at this exact path was replaced -- the first mutation would
    // then first-bind the REPLACEMENT's identity onto content authored against the PRIOR object,
    // defeating the very isolation KEIKO-0190 introduced. The absent snapshot's etag must bind to
    // the live root identity from the very first read, so a swap between the read and the write is
    // caught by the existing conflict/etag path, exactly like a swap between two committed reads.
    const stateDir = temporaryDirectory("debug-state-absent-identity-bind");
    const parent = temporaryDirectory("debug-workspace-absent-identity-bind-parent");
    const root = join(parent, "root");
    mkdirSync(root);
    const store = createBreakpointStore({ stateDir, idFactory: (): string => "absent_bind_id" });

    const initial = currentSnapshot(store, root);
    expect(initial.revision).toBe(0);

    replaceDirectory(root);

    const mutated = store.setBreakpointsForFile(root, initial.revision, initial.etag, "a.ts", [
      breakpoint(1),
    ]);

    expect(mutated).toMatchObject({ ok: false, reason: "conflict" });
    const onDisk = createBreakpointStore({ stateDir }).snapshot(root);
    expect(onDisk).toMatchObject({ ok: true, snapshot: { revision: 0, breakpoints: [] } });
  });
});

describe("KEIKO-0179 — breakpoint re-key on file rename", () => {
  it("re-keys breakpoints to the new fileId, bumping revision exactly once", () => {
    const stateDir = temporaryDirectory("debug-state-rename");
    const root = temporaryDirectory("debug-workspace-rename");
    let id = 0;
    const store = createBreakpointStore({ stateDir, idFactory: () => `rename_${String(id++)}` });
    const accepted = setBreakpoints(store, root, "a.ts", [breakpoint(1), breakpoint(2)]);
    expect(accepted.ok).toBe(true);
    const before = currentSnapshot(store, root);

    const renamed = store.renameFile(root, "a.ts", "b.ts");

    expect(renamed).toMatchObject({
      ok: true,
      snapshot: {
        revision: before.revision + 1,
        breakpoints: [
          { fileId: "b.ts", line: 1 },
          { fileId: "b.ts", line: 2 },
        ],
      },
    });
    const afterFileIds = currentSnapshot(store, root).breakpoints.map((entry) => entry.fileId);
    expect(afterFileIds).not.toContain("a.ts");
  });

  it("no-ops without bumping revision when no breakpoint is filed under the previous fileId", () => {
    const stateDir = temporaryDirectory("debug-state-rename-noop");
    const root = temporaryDirectory("debug-workspace-rename-noop");
    const store = createBreakpointStore({ stateDir });
    const before = currentSnapshot(store, root);

    const result = store.renameFile(root, "a.ts", "b.ts");

    expect(result).toMatchObject({ ok: true, snapshot: before });
  });

  it("keeps both breakpoint sets when the rename target already has breakpoints of its own", () => {
    const stateDir = temporaryDirectory("debug-state-rename-collision");
    const root = temporaryDirectory("debug-workspace-rename-collision");
    let id = 0;
    const store = createBreakpointStore({ stateDir, idFactory: () => `collide_${String(id++)}` });
    setBreakpoints(store, root, "a.ts", [breakpoint(1)]);
    setBreakpoints(store, root, "b.ts", [breakpoint(9)]);

    const renamed = store.renameFile(root, "a.ts", "b.ts");

    expect(renamed.ok).toBe(true);
    const lines = currentSnapshot(store, root)
      .breakpoints.filter((entry) => entry.fileId === "b.ts")
      .map((entry) => entry.line)
      .sort();
    expect(lines).toEqual([1, 9]);
  });

  it("rejects a rename whose merged destination would exceed the per-file breakpoint cap, leaving the record readable afterward", () => {
    // KEIKO-0179 collision policy keeps both breakpoint sets under the destination fileId. If the
    // merged count is not checked against the same per-file cap setBreakpointsForFile enforces, the
    // over-cap record still commits successfully here but then fails validBreakpointCollection on
    // every subsequent load, bricking the whole workspace instrumentation store as "unavailable"
    // until an operator manually deletes the file.
    const stateDir = temporaryDirectory("debug-state-rename-cap");
    const root = temporaryDirectory("debug-workspace-rename-cap");
    let id = 0;
    const store = createBreakpointStore({
      stateDir,
      idFactory: () => `rename_cap_${String(id++)}`,
    });
    const cap = BREAKPOINT_STORE_LIMITS.maxBreakpointsPerFile;
    const destinationCount = Math.floor(cap / 2);
    const matchingCount = cap - destinationCount + 1;
    setBreakpoints(
      store,
      root,
      "a.ts",
      Array.from({ length: matchingCount }, (_, index) => breakpoint(index + 1)),
    );
    setBreakpoints(
      store,
      root,
      "b.ts",
      Array.from({ length: destinationCount }, (_, index) => breakpoint(index + 1)),
    );
    const before = currentSnapshot(store, root);

    const renamed = store.renameFile(root, "a.ts", "b.ts");

    expect(renamed).toMatchObject({ ok: false, reason: "cap_exceeded", snapshot: before });
    const afterFileIds = currentSnapshot(store, root).breakpoints.map((entry) => entry.fileId);
    expect(afterFileIds).toContain("a.ts");

    const reopened = createBreakpointStore({ stateDir }).snapshot(root);
    expect(reopened).toMatchObject({ ok: true });
  });

  it("rejects an invalid destination fileId without mutating the record", () => {
    const stateDir = temporaryDirectory("debug-state-rename-invalid");
    const root = temporaryDirectory("debug-workspace-rename-invalid");
    const store = createBreakpointStore({ stateDir, idFactory: (): string => "invalid_id" });
    setBreakpoints(store, root, "a.ts", [breakpoint(1)]);
    const before = currentSnapshot(store, root);

    const rejected = store.renameFile(root, "a.ts", "/absolute/escape.ts");

    expect(rejected).toMatchObject({ ok: false, reason: "invalid", snapshot: before });
  });

  it("does not resurrect stale breakpoints when renaming against an identity-mismatched (absent) record", () => {
    // Co-tests KEIKO-0190 and KEIKO-0179: a rename that lands on a root whose persisted record was
    // just invalidated by an object-identity mismatch must observe the fresh absent record, never
    // the prior occupant's breakpoints — so nothing is re-keyed and no stale state is written back.
    const stateDir = temporaryDirectory("debug-state-rename-after-mismatch");
    const parent = temporaryDirectory("debug-workspace-rename-after-mismatch");
    const root = join(parent, "root");
    mkdirSync(root);
    const store = createBreakpointStore({ stateDir, idFactory: (): string => "stale_id" });
    setBreakpoints(store, root, "a.ts", [breakpoint(1)]);
    expect(currentSnapshot(store, root).breakpoints).toHaveLength(1);

    replaceDirectory(root);

    const renamed = store.renameFile(root, "a.ts", "b.ts");

    expect(renamed).toMatchObject({ ok: true, retainedCount: 0 });
    const snapshot = currentSnapshot(store, root);
    expect(snapshot.revision).toBe(0);
    expect(snapshot.breakpoints).toEqual([]);
  });
});
