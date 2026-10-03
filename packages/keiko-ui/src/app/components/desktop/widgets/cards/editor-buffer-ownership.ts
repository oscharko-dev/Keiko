import {
  isEditorAgentBridgeDecisionCapability,
  isEditorBufferSafetySnapshot,
  isContainedAgentPath,
} from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import type { EditorAgentSessionSnapshot } from "@/lib/types";

const PREFIX = "keiko.editor.buffer-safety.v1:";

export interface EditorBufferOwnership {
  readonly key: string;
  readonly sessionId: string;
  capability: string;
  updatedAt: number;
  readonly dirtyFiles: readonly string[];
  readonly release: () => void;
}

function mintCapability(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .slice(0, -1);
}

function readTimestamp(updatedAt: unknown = 0): number {
  if (typeof updatedAt !== "number" || !Number.isSafeInteger(updatedAt) || updatedAt < 0)
    throw new TypeError("Invalid buffer ownership");
  return updatedAt;
}

function readOwnership(
  key: string,
  snapshot: EditorAgentSessionSnapshot,
): Omit<EditorBufferOwnership, "key" | "release"> {
  const raw = window.localStorage.getItem(key) ?? window.sessionStorage.getItem(key);
  if (raw === null)
    return {
      sessionId: snapshot.sessionId,
      capability: mintCapability(),
      dirtyFiles: [],
      updatedAt: 0,
    };
  const record: unknown = JSON.parse(raw);
  if (typeof record !== "object" || record === null)
    throw new TypeError("Invalid buffer ownership");
  const fields = record as Record<string, unknown>;
  const sessionId = fields.sessionId ?? snapshot.sessionId;
  const value = { ...snapshot, sessionId, dirtyFiles: fields.dirtyFiles };
  if (
    !isEditorAgentBridgeDecisionCapability(fields.capability) ||
    !isEditorBufferSafetySnapshot(value)
  ) {
    throw new TypeError("Invalid buffer ownership");
  }
  if (!value.dirtyFiles.every(isContainedAgentPath))
    throw new TypeError("Invalid buffer ownership");
  const updatedAt = readTimestamp(fields.updatedAt);
  return {
    sessionId: value.sessionId,
    capability: fields.capability,
    dirtyFiles: value.dirtyFiles,
    updatedAt,
  };
}

function candidateKeys(sessionId: string): readonly string[] {
  const key = PREFIX + sessionId;
  const siblings: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const candidate = window.localStorage.key(index);
    if (candidate?.startsWith(key + ":publisher:") === true) siblings.push(candidate);
  }
  return [key, ...siblings.sort((left, right) => left.localeCompare(right))];
}

function acquireLock(key: string): Promise<(() => void) | null> {
  if (navigator.locks === undefined)
    return Promise.reject(new TypeError("Buffer ownership requires origin locks"));
  return new Promise((resolve, reject): void => {
    void navigator.locks
      .request(
        "keiko.editor.buffer-owner:" + key,
        { ifAvailable: true },
        async (lock): Promise<void> => {
          if (lock === null) {
            resolve(null);
            return;
          }
          await new Promise<void>((release): void => {
            resolve(release);
          });
        },
      )
      .catch(reject);
  });
}

async function claimKey(
  key: string,
  snapshot: EditorAgentSessionSnapshot,
): Promise<EditorBufferOwnership | null> {
  const release = await acquireLock(key);
  if (release === null) return null;
  try {
    return { ...readOwnership(key, snapshot), key, release };
  } catch (error) {
    release();
    throw error;
  }
}

async function claimCandidates(
  keys: readonly string[],
  snapshot: EditorAgentSessionSnapshot,
  index: number,
): Promise<EditorBufferOwnership | null> {
  const key = keys[index];
  if (key === undefined) return null;
  const ownership = await claimKey(key, snapshot);
  return ownership ?? claimCandidates(keys, snapshot, index + 1);
}

/** A live publisher exclusively owns a durable record; duplicate tabs use independent records. */
export async function claimEditorBufferOwnership(
  snapshot: EditorAgentSessionSnapshot,
): Promise<EditorBufferOwnership> {
  const previous = await claimCandidates(candidateKeys(snapshot.sessionId), snapshot, 0);
  if (previous !== null) return previous;
  const capability = mintCapability();
  const sessionId = "buffer-owner:" + capability;
  const ownership = await claimKey(PREFIX + snapshot.sessionId + ":publisher:" + capability, {
    ...snapshot,
    sessionId,
  });
  if (ownership === null) throw new TypeError("Buffer ownership is unavailable");
  return ownership;
}

/** Must succeed before a snapshot POST; dirty paths include pending, unacknowledged edits. */
export function persistEditorBufferOwnership(
  ownership: EditorBufferOwnership,
  dirtyFiles: readonly string[],
): void {
  window.localStorage.setItem(
    ownership.key,
    JSON.stringify({
      sessionId: ownership.sessionId,
      capability: ownership.capability,
      dirtyFiles,
      updatedAt: ownership.updatedAt,
    }),
  );
  window.sessionStorage.removeItem(ownership.key);
}

export function forgetEditorBufferOwnership(ownership: EditorBufferOwnership): void {
  window.localStorage.removeItem(ownership.key);
  window.sessionStorage.removeItem(ownership.key);
}
