import type { ConnectedContextPack } from "@oscharko-dev/keiko-contracts/connected-context";

const DEFAULT_TTL_MS = 15 * 60_000;
const DEFAULT_MAX_ENTRIES = 256;

export interface GroundedTurnRecord {
  readonly assistantMessageId: string;
  readonly chatId: string;
  readonly workspaceRoot: string;
  readonly evidenceRunId?: string | undefined;
  readonly packs: readonly ConnectedContextPack[];
}

interface MutableEntry extends GroundedTurnRecord {
  expiresAtMs: number;
  touchedAtMs: number;
}

function packForHandoffRegistry(pack: ConnectedContextPack): ConnectedContextPack {
  return {
    ...pack,
    files: pack.files.map((file) => ({
      ...file,
      excerpts: file.excerpts.map((excerpt) => ({
        ...excerpt,
        content: "",
        contentBytes: 0,
      })),
    })),
  };
}

function recordForHandoffRegistry(record: GroundedTurnRecord): GroundedTurnRecord {
  return {
    ...record,
    packs: record.packs.map(packForHandoffRegistry),
  };
}

export interface GroundedTurnRegistry {
  remember: (record: GroundedTurnRecord, nowMs?: () => number) => void;
  lookup: (assistantMessageId: string, nowMs?: () => number) => GroundedTurnRecord | undefined;
  clearConversation: (chatId: string) => void;
  clearWorkspace: (workspaceRoot: string) => void;
  clearAll: () => void;
}

function sweepExpired(entries: Map<string, MutableEntry>, now: number): void {
  for (const [key, entry] of entries) {
    if (entry.expiresAtMs <= now) {
      entries.delete(key);
    }
  }
}

function evictOldest(entries: Map<string, MutableEntry>, maxEntries: number): void {
  while (entries.size >= maxEntries) {
    let oldest: MutableEntry | undefined;
    for (const entry of entries.values()) {
      if (oldest === undefined || entry.touchedAtMs < oldest.touchedAtMs) {
        oldest = entry;
      }
    }
    if (oldest === undefined) {
      return;
    }
    entries.delete(oldest.assistantMessageId);
  }
}

export function createGroundedTurnRegistry(
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
): GroundedTurnRegistry {
  const entries = new Map<string, MutableEntry>();
  return {
    remember(record, nowMs = Date.now): void {
      const now = nowMs();
      sweepExpired(entries, now);
      evictOldest(entries, maxEntries);
      const safeRecord = recordForHandoffRegistry(record);
      entries.set(record.assistantMessageId, {
        ...safeRecord,
        touchedAtMs: now,
        expiresAtMs: now + ttlMs,
      });
    },
    lookup(assistantMessageId, nowMs = Date.now): GroundedTurnRecord | undefined {
      const now = nowMs();
      sweepExpired(entries, now);
      const entry = entries.get(assistantMessageId);
      if (entry === undefined) {
        return undefined;
      }
      entry.touchedAtMs = now;
      entry.expiresAtMs = now + ttlMs;
      return entry;
    },
    clearConversation(chatId): void {
      for (const [key, entry] of entries) {
        if (entry.chatId === chatId) {
          entries.delete(key);
        }
      }
    },
    clearWorkspace(workspaceRoot): void {
      for (const [key, entry] of entries) {
        if (entry.workspaceRoot === workspaceRoot) {
          entries.delete(key);
        }
      }
    },
    clearAll(): void {
      entries.clear();
    },
  };
}

export const groundedTurnRegistry = createGroundedTurnRegistry();

export function rememberGroundedTurn(record: GroundedTurnRecord, nowMs?: () => number): void {
  groundedTurnRegistry.remember(record, nowMs);
}

export function lookupGroundedTurn(
  assistantMessageId: string,
  nowMs?: () => number,
): GroundedTurnRecord | undefined {
  return groundedTurnRegistry.lookup(assistantMessageId, nowMs);
}

export function clearGroundedTurnsForConversation(chatId: string): void {
  groundedTurnRegistry.clearConversation(chatId);
}

export function clearGroundedTurnsForWorkspace(workspaceRoot: string): void {
  groundedTurnRegistry.clearWorkspace(workspaceRoot);
}

export function clearAllGroundedTurns(): void {
  groundedTurnRegistry.clearAll();
}
