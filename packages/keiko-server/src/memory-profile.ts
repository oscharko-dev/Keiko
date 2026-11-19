// The person's standing profile for a Chat answer (MemoriaViva 1.5, #4228).
//
// The vault supplies metadata for the person's public-sensitivity standing and pinned facts
// independently of retrieval's newest-500 window. The metadata is filtered and ordered before
// the bounded body reads. The pure selectStandingProfile still checks each record it receives.

import type { MemoryId, MemoryRecord, UserId } from "@oscharko-dev/keiko-contracts/memory";
import type { ConversationStandingProfileWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  DEFAULT_STALE_CONFIDENCE_THRESHOLD,
  DEFAULT_STANDING_PROFILE_CAPS,
  STANDING_PROFILE_TYPES,
  selectStandingProfile,
  type StandingProfile,
  type StandingProfileCandidate,
  type StandingProfileCaps,
} from "@oscharko-dev/keiko-memory-retrieval";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";

// Bodies read per batch and at most per answer. Exclusions in sealed tags still cost a read, so
// the bound is a multiple of the entry cap.
const PROFILE_READ_BATCH = 16;
const PROFILE_READS_PER_ENTRY = 8;

export const EMPTY_STANDING_PROFILE: StandingProfile = Object.freeze({
  entries: [],
  tokens: 0,
  dropped: {},
});

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
  const ordered = vault.listStandingProfileCandidates(userId, {
    types: STANDING_PROFILE_TYPES,
    minConfidenceExclusive: DEFAULT_STALE_CONFIDENCE_THRESHOLD,
    nowMs,
    limit: Math.min(Number.MAX_SAFE_INTEGER, caps.maxEntries * PROFILE_READS_PER_ENTRY),
  });
  const candidates: StandingProfileCandidate[] = [];
  let profile = EMPTY_STANDING_PROFILE;
  for (let start = 0; start < ordered.length; start += PROFILE_READ_BATCH) {
    const end = Math.min(start + PROFILE_READ_BATCH, ordered.length);
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
