"use client";

import { useEffect } from "react";
import { postEditorBufferSafetyRequest } from "@/lib/api";
import { reportClientDiagnostic, type ClientDiagnosticMeta } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
import type { EditorAgentSessionSnapshot, EditorAgentSnapshotResponse } from "@/lib/types";
import {
  claimEditorBufferOwnership,
  forgetEditorBufferOwnership,
  persistEditorBufferOwnership,
  type EditorBufferOwnership,
} from "./editor-buffer-ownership";

export interface EditorBufferCleanSettlement {
  readonly sequence: number;
  readonly paths: readonly string[];
}

interface BufferOwner {
  readonly sessionId: string;
  ownership: EditorBufferOwnership | null;
  disposed: boolean;
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
function failureDiagnostic(error: unknown): readonly [string, ClientDiagnosticMeta] {
  return [
    `Editor buffer protection failed: ${clientErrorSummary(error)}`,
    {
      correlationId: correlationIdOf(error),
      errorEvidence: clientErrorEvidence(error),
    },
  ];
}

function ownerFor(sessionId: string): BufferOwner {
  const previous = owners.get(sessionId);
  if (previous !== undefined) return previous;
  const owner: BufferOwner = {
    sessionId,
    references: 0,
    capability: undefined,
    ownership: null,
    disposed: false,
    latest: null,
    acknowledged: null,
    inFlight: null,
    running: false,
    failed: false,
    materialKey: undefined,
    unresolved: new Set(),
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
  return {
    ...snapshot,
    sessionId: owner.ownership?.sessionId ?? snapshot.sessionId,
    dirtyFiles: [...new Set([...unresolved, ...snapshot.dirtyFiles])],
  };
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
  const ownership = owner.ownership;
  if (
    ownership === null ||
    response.snapshot === null ||
    capability !== ownership.capability ||
    response.snapshot.sessionId !== ownership.sessionId
  ) {
    throw new TypeError("Buffer protection response is incomplete");
  }
  owner.capability = capability;
  owner.failed = false;
  owner.materialKey = materialKey;
  owner.acknowledged = response.snapshot;
  consumeCleanSettlement(owner, cleanFiles);
  const pendingDirty = owner.latest?.dirtyFiles ?? [];
  owner.unresolved.clear();
  for (const path of [...response.snapshot.dirtyFiles, ...pendingDirty]) owner.unresolved.add(path);
  persistEditorBufferOwnership(ownership, [...owner.unresolved]);
}

async function acknowledge(
  owner: BufferOwner,
  snapshot: EditorAgentSessionSnapshot,
): Promise<void> {
  owner.inFlight = snapshot;
  if (owner.ownership === null) {
    const ownership = await claimEditorBufferOwnership(snapshot);
    if (owner.disposed) {
      ownership.release();
      return;
    }
    owner.ownership = ownership;
    owner.capability = ownership.capability;
    for (const path of ownership.dirtyFiles) owner.unresolved.add(path);
  }
  const cleanFiles = applicableSettlements(owner, snapshot);
  const protectedState = protectedSnapshot(owner, snapshot);
  const materialKey = JSON.stringify({ ...protectedState, updatedAt: 0 });
  if (owner.materialKey === materialKey && !owner.failed) {
    consumeCleanSettlement(owner, cleanFiles);
    return;
  }
  for (const path of protectedState.dirtyFiles) owner.unresolved.add(path);
  owner.ownership.updatedAt = Math.max(Date.now(), owner.ownership.updatedAt + 1);
  persistEditorBufferOwnership(owner.ownership, [...owner.unresolved]);
  owner.inFlight = { ...protectedState, updatedAt: owner.ownership.updatedAt };
  const response = await postEditorBufferSafetyRequest({
    schemaVersion: "1",
    kind: "buffer-snapshot",
    snapshot: owner.inFlight,
    ...(owner.capability === undefined ? {} : { bufferSnapshotCapability: owner.capability }),
  });
  if (!owner.disposed) acceptAcknowledgement(owner, response, materialKey, cleanFiles);
}

function finishCleanRelease(owner: BufferOwner): void {
  if (owner.disposed) return;
  owner.materialKey = undefined;
  owner.acknowledged = null;
  if (owner.references > 0 || owner.latest !== null || owner.unresolved.size > 0) return;
  owner.capability = undefined;
  if (owner.ownership !== null) {
    forgetEditorBufferOwnership(owner.ownership);
    owner.ownership.release();
    owner.ownership = null;
  }
  if (owner.references === 0 && owner.latest === null) owners.delete(owner.sessionId);
}

async function releaseCleanOwner(owner: BufferOwner): Promise<void> {
  if (owner.failed || owner.references !== 0 || owner.capability === undefined) return;
  if (owner.acknowledged === null || owner.acknowledged.dirtyFiles.length > 0) return;
  const response = await postEditorBufferSafetyRequest({
    schemaVersion: "1",
    kind: "buffer-release",
    sessionId: owner.ownership?.sessionId ?? owner.sessionId,
    bufferSnapshotCapability: owner.capability,
  });
  if (response.snapshot !== null) throw new TypeError("Buffer protection release is incomplete");
  finishCleanRelease(owner);
}

async function flush(owner: BufferOwner): Promise<void> {
  if (owner.running || owner.disposed) return;
  owner.running = true;
  try {
    while (owner.latest !== null && !owner.disposed) {
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
    else if (owner.references === 0) {
      owner.ownership?.release();
      owner.ownership = null;
      owners.delete(owner.sessionId);
    }
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
    for (const path of snapshot.dirtyFiles) {
      owner.pendingClean.delete(path);
      owner.unresolved.add(path);
    }
    if (owner.ownership !== null) {
      try {
        persistEditorBufferOwnership(owner.ownership, [...owner.unresolved]);
      } catch (error) {
        owner.failed = true;
        reportClientDiagnostic(...failureDiagnostic(error));
      }
    }
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
    if (snapshot?.workspaceRoot !== root || !matchingWindows.has(snapshot.windowId)) continue;
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
  for (const owner of owners.values()) {
    owner.disposed = true;
    owner.ownership?.release();
  }
  owners.clear();
}
