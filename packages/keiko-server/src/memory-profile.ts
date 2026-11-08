// The person's standing profile for a Chat answer (MemoriaViva 1.5, #4228).
//
// The vault is asked for the metadata of the person's private standing facts and pinned facts,
// which needs no body reads and is not limited by the retrieval layer's newest-500 window, so the
// profile holds at any vault size. The metadata is ordered exactly as the profile orders facts, and
// bodies are read in that order only until the profile is full. The selection itself is the pure
// selectStandingProfile; this module only feeds it.

import type { MemoryId, MemoryRecord, UserId } from "@oscharko-dev/keiko-contracts/memory";
import type { ConversationStandingProfileWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  DEFAULT_STANDING_PROFILE_CAPS,
  STANDING_PROFILE_TYPES,
  compareStandingProfileOrder,
  selectStandingProfile,
  type StandingProfile,
  type StandingProfileCandidate,
  type StandingProfileCaps,
} from "@oscharko-dev/keiko-memory-retrieval";
import type { MemoryMetadata, MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";

// Bodies read per batch and at most per answer. Ineligible facts (excluded, suppressed) cost a read
// each, so the bound is a multiple of the entry cap rather than the cap itself.
const PROFILE_READ_BATCH = 16;
const PROFILE_READS_PER_ENTRY = 8;

export const EMPTY_STANDING_PROFILE: StandingProfile = Object.freeze({
  entries: [],
  tokens: 0,
  dropped: {},
});

function profileMetadata(
  vault: MemoryVaultStore,
  userId: UserId,
  nowMs: number,
): readonly MemoryMetadata[] {
  const scope = { kind: "user", userId } as const;
  const standing = vault.listMemoryMetadataByScope(scope, {
    type: STANDING_PROFILE_TYPES,
    status: ["accepted"],
    nowMs,
  });
  const pinned = vault.listMemoryMetadataByScope(scope, {
    pinned: true,
    status: ["accepted"],
    nowMs,
  });
  const byId = new Map<MemoryId, MemoryMetadata>();
  for (const meta of [...standing, ...pinned]) byId.set(meta.id, meta);
  return [...byId.values()];
}

function orderedCandidateIds(
  vault: MemoryVaultStore,
  metadata: readonly MemoryMetadata[],
): readonly { readonly id: MemoryId; readonly confirmations: number }[] {
  const stats = vault.getAccessStats(metadata.map((meta) => meta.id));
  return metadata
    .map((meta) => ({
      id: meta.id,
      pinned: meta.pinned,
      createdAt: meta.createdAt,
      confirmations: stats.get(meta.id)?.accessCount ?? 0,
    }))
    .sort(compareStandingProfileOrder)
    .map(({ id, confirmations }) => ({ id, confirmations }));
}

function readCandidates(
  vault: MemoryVaultStore,
  ids: readonly { readonly id: MemoryId; readonly confirmations: number }[],
): StandingProfileCandidate[] {
  const candidates: StandingProfileCandidate[] = [];
  for (const { id, confirmations } of ids) {
    const record: MemoryRecord | undefined = vault.getMemory(id);
    if (record !== undefined) candidates.push({ record, confirmations });
  }
  return candidates;
}

/** Selects the person's standing profile, reading only as many bodies as the profile needs. */
export function standingProfileForUser(
  vault: MemoryVaultStore,
  userId: UserId,
  nowMs: number,
  caps: StandingProfileCaps = DEFAULT_STANDING_PROFILE_CAPS,
): StandingProfile {
  if (caps.maxEntries === 0 || caps.maxTokens === 0) return EMPTY_STANDING_PROFILE;
  const ordered = orderedCandidateIds(vault, profileMetadata(vault, userId, nowMs));
  const readBound = Math.min(ordered.length, caps.maxEntries * PROFILE_READS_PER_ENTRY);
  const candidates: StandingProfileCandidate[] = [];
  let profile = EMPTY_STANDING_PROFILE;
  for (let start = 0; start < readBound; start += PROFILE_READ_BATCH) {
    const end = Math.min(start + PROFILE_READ_BATCH, readBound);
    candidates.push(...readCandidates(vault, ordered.slice(start, end)));
    profile = selectStandingProfile(candidates, nowMs, caps);
    if (profile.entries.length >= caps.maxEntries) break;
  }
  return profile;
}

export function standingProfileWire(profile: StandingProfile): ConversationStandingProfileWire {
  return {
    entries: profile.entries.map((entry) => ({ memoryId: String(entry.id), text: entry.text })),
    tokens: profile.tokens,
    droppedCount: (profile.dropped["entry-cap"] ?? 0) + (profile.dropped["token-cap"] ?? 0),
  };
}
