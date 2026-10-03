"use client";

import { useEffect } from "react";
import { postEditorBufferSafetyRequest } from "@/lib/api";
import { reportClientDiagnostic, type ClientDiagnosticMeta } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
import type { EditorAgentSessionSnapshot, EditorAgentSnapshotResponse } from "@/lib/types";

export interface EditorBufferCleanSettlement {
  readonly sequence: number;
  readonly paths: readonly string[];
}

interface BufferOwner {
  readonly sessionId: string;
  references: number;
  capability: string | undefined;
  latest: EditorAgentSessionSnapshot | null;
  acknowledged: EditorAgentSessionSnapshot | null;
  inFlight: EditorAgentSessionSnapshot | null;
  running: boolean;
  failed: boolean;
  materialKey: string | undefined;
  readonly unresolved: Set<string>;
  readonly pendingClean: Map<string, number>;
  settlementSerial: number;
  cleanSequence: number;
}

const owners = new Map<string, BufferOwner>();
const STORAGE_PREFIX = "keiko.editor.buffer-safety.v1:";

function failureDiagnostic(error: unknown): readonly [string, ClientDiagnosticMeta] {
  return [
    `Editor buffer protection failed: ${clientErrorSummary(error)}`,
    {
      correlationId: correlationIdOf(error),
      errorEvidence: clientErrorEvidence(error),
    },
  ];
}

function storedOwnership(sessionId: string): { capability?: string; dirtyFiles: string[] } {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_PREFIX + sessionId);
    if (raw === null) return { dirtyFiles: [] };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { dirtyFiles: [] };
    const record = parsed as Record<string, unknown>;
    if (typeof record.capability !== "string" || !Array.isArray(record.dirtyFiles))
      return { dirtyFiles: [] };
    const paths = record.dirtyFiles.filter((path): path is string => typeof path === "string");
    return { capability: record.capability, dirtyFiles: paths };
  } catch (error) {
    reportClientDiagnostic(...failureDiagnostic(error));
    return { dirtyFiles: [] };
  }
}

function persistCapability(owner: BufferOwner): void {
  try {
    const key = STORAGE_PREFIX + owner.sessionId;
    if (owner.capability === undefined) window.sessionStorage.removeItem(key);
    else
      window.sessionStorage.setItem(
        key,
        JSON.stringify({ capability: owner.capability, dirtyFiles: [...owner.unresolved] }),
      );
  } catch (error) {
    reportClientDiagnostic(...failureDiagnostic(error));
  }
}

function ownerFor(sessionId: string): BufferOwner {
  const previous = owners.get(sessionId);
  if (previous !== undefined) return previous;
  const stored = storedOwnership(sessionId);
  const owner: BufferOwner = {
    sessionId,
    references: 0,
    capability: stored.capability,
    latest: null,
    acknowledged: null,
    inFlight: null,
    running: false,
    failed: false,
    materialKey: undefined,
    unresolved: new Set(stored.dirtyFiles),
    pendingClean: new Map(),
    settlementSerial: 0,
    cleanSequence: 0,
  };
  owners.set(sessionId, owner);
  return owner;
}

function protectedSnapshot(
  owner: BufferOwner,
  snapshot: EditorAgentSessionSnapshot,
): EditorAgentSessionSnapshot {
  const unresolved = new Set(owner.unresolved);
  for (const path of owner.pendingClean.keys()) {
    if (!snapshot.dirtyFiles.includes(path)) unresolved.delete(path);
  }
  return { ...snapshot, dirtyFiles: [...new Set([...unresolved, ...snapshot.dirtyFiles])] };
}

function applicableSettlements(
  owner: BufferOwner,
  snapshot: EditorAgentSessionSnapshot,
): ReadonlyMap<string, number> {
  return new Map([...owner.pendingClean].filter(([path]) => !snapshot.dirtyFiles.includes(path)));
}

function consumeCleanSettlement(
  owner: BufferOwner,
  settlements: ReadonlyMap<string, number>,
): void {
  for (const [path, serial] of settlements) {
    if (owner.pendingClean.get(path) === serial) owner.pendingClean.delete(path);
  }
}

function queueCleanSettlement(owner: BufferOwner, paths: readonly string[]): void {
  owner.settlementSerial += 1;
  for (const path of paths) owner.pendingClean.set(path, owner.settlementSerial);
}

function acceptAcknowledgement(
  owner: BufferOwner,
  response: EditorAgentSnapshotResponse,
  materialKey: string,
  cleanFiles: ReadonlyMap<string, number>,
): void {
  const capability = response.bufferSnapshotCapability ?? owner.capability;
  if (
    capability === undefined ||
    response.snapshot === null ||
    response.snapshot.sessionId !== owner.sessionId
  ) {
    throw new TypeError("Buffer protection response is incomplete");
  }
  owner.capability = capability;
  owner.failed = false;
  owner.materialKey = materialKey;
  owner.acknowledged = response.snapshot;
  consumeCleanSettlement(owner, cleanFiles);
  owner.unresolved.clear();
  for (const path of response.snapshot.dirtyFiles) owner.unresolved.add(path);
  persistCapability(owner);
}

async function acknowledge(
  owner: BufferOwner,
  snapshot: EditorAgentSessionSnapshot,
): Promise<void> {
  const cleanFiles = applicableSettlements(owner, snapshot);
  const protectedState = protectedSnapshot(owner, snapshot);
  const materialKey = JSON.stringify({ ...protectedState, updatedAt: 0 });
  if (owner.materialKey === materialKey && !owner.failed) {
    consumeCleanSettlement(owner, cleanFiles);
    return;
  }
  owner.inFlight = protectedState;
  const response = await postEditorBufferSafetyRequest({
    schemaVersion: "1",
    kind: "buffer-snapshot",
    snapshot: protectedState,
    ...(owner.capability === undefined ? {} : { bufferSnapshotCapability: owner.capability }),
  });
  acceptAcknowledgement(owner, response, materialKey, cleanFiles);
}

async function releaseCleanOwner(owner: BufferOwner): Promise<void> {
  if (owner.failed || owner.references !== 0 || owner.capability === undefined) return;
  if (owner.acknowledged === null || owner.acknowledged.dirtyFiles.length > 0) return;
  const response = await postEditorBufferSafetyRequest({
    schemaVersion: "1",
    kind: "buffer-release",
    sessionId: owner.sessionId,
    bufferSnapshotCapability: owner.capability,
  });
  if (response.snapshot !== null) throw new TypeError("Buffer protection release is incomplete");
  owner.materialKey = undefined;
  owner.capability = undefined;
  owner.acknowledged = null;
  persistCapability(owner);
  if (owner.references === 0 && owner.latest === null) owners.delete(owner.sessionId);
}

async function flush(owner: BufferOwner): Promise<void> {
  if (owner.running) return;
  owner.running = true;
  try {
    while (owner.latest !== null) {
      const snapshot = owner.latest;
      owner.latest = null;
      await acknowledge(owner, snapshot);
    }
    await releaseCleanOwner(owner);
  } catch (error) {
    owner.failed = true;
    reportClientDiagnostic(...failureDiagnostic(error));
  } finally {
    owner.running = false;
    owner.inFlight = null;
    if (owner.latest !== null) void flush(owner);
    else if (owner.references === 0) owners.delete(owner.sessionId);
  }
}

/** Serializes passive snapshots and retains dirty records across unmounts and reloads. */
export function useEditorBufferSafety(
  snapshot: EditorAgentSessionSnapshot | null,
  cleanSettlement?: EditorBufferCleanSettlement,
): void {
  const sessionId = snapshot?.sessionId;
  useEffect(() => {
    if (sessionId === undefined) return;
    const owner = ownerFor(sessionId);
    owner.references += 1;
    return (): void => {
      owner.references -= 1;
      queueMicrotask(() => void flush(owner));
    };
  }, [sessionId]);
  useEffect(() => {
    if (snapshot === null) return;
    const owner = ownerFor(snapshot.sessionId);
    owner.latest = snapshot;
    for (const path of snapshot.dirtyFiles) owner.pendingClean.delete(path);
    if (cleanSettlement !== undefined && cleanSettlement.sequence !== owner.cleanSequence) {
      queueCleanSettlement(owner, cleanSettlement.paths);
      owner.cleanSequence = cleanSettlement.sequence;
    }
    void flush(owner);
  }, [snapshot, cleanSettlement]);
}

/** A host-owned dirty-close Discard must settle before that pane is unmounted. */
export function discardEditorBufferSafetyFiles(
  windowIds: readonly string[],
  root: string,
  paths: readonly string[],
): void {
  const matchingWindows = new Set(windowIds);
  const discardedPaths = new Set(paths);
  for (const owner of owners.values()) {
    const snapshot = owner.latest ?? owner.inFlight ?? owner.acknowledged;
    if (
      snapshot === null ||
      snapshot.workspaceRoot !== root ||
      !matchingWindows.has(snapshot.windowId)
    )
      continue;
    queueCleanSettlement(owner, paths);
    owner.latest = {
      ...snapshot,
      dirtyFiles: snapshot.dirtyFiles.filter((path) => !discardedPaths.has(path)),
      updatedAt: Date.now(),
    };
    void flush(owner);
  }
}

export function resetEditorBufferSafetyForTests(): void {
  owners.clear();
}
