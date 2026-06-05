// AC: selective forgetting. `selectMemoriesForForget(by-type)` selects exactly the target
// type; `vault.deleteMemory` removes the records; retrieval no longer surfaces them.
//
// Mutation-robustness controls:
//  1. POSITIVE: after the forget operation completes, retrieval does not include the two
//     forgotten preference ids.
//  2. NEGATIVE/CONTROL: a SECOND retrieval call against the kept decision id surfaces it,
//     proving the forget operation did not collateral-damage the unrelated record. The
//     selector's result list also asserts exactly 2 ids selected (not 1, not 3).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildForgetOperations,
  selectMemoriesForForget,
} from "@oscharko-dev/keiko-memory-governance";
import {
  createMemoryVault,
  type MemoryTombstone,
  type MemoryVaultStore,
} from "@oscharko-dev/keiko-memory-vault";
import {
  retrieveMemoryContext,
  type MemoryRetrievalRequest,
} from "@oscharko-dev/keiko-memory-retrieval";

import {
  FIXED_NOW_MS,
  counterIdSource,
  loadFixture,
  makeRecord,
  reviewerId,
  userScope,
  vaultPort,
} from "../_support.js";
import type { Scorecard } from "../scorecard.js";

const SCENARIO_NAME = "selective-forgetting";
const KEPT_ID = "keep-decision";

const cleanups: string[] = [];
afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "keiko-eval-forget-"));
  cleanups.push(dir);
  return dir;
}

function openVault(dir: string): MemoryVaultStore {
  const ids = counterIdSource("tomb");
  return createMemoryVault({
    memoryDir: dir,
    env: { KEIKO_MEMORY_DIR: dir },
    now: () => FIXED_NOW_MS,
    newTombstoneId: ids,
  });
}

function seedForgetTargets(vault: MemoryVaultStore): readonly { readonly id: string }[] {
  const fixture = loadFixture("forget-targets.json")[0];
  if (fixture === undefined) throw new Error("expected forget-targets fixture");
  return fixture.memories.map((m) => {
    vault.insertMemory(makeRecord(m));
    return { id: m.id };
  });
}

function retrievalRequest(): MemoryRetrievalRequest {
  return { scopes: [userScope("user-alice")], nowMs: FIXED_NOW_MS };
}

function includedIds(vault: MemoryVaultStore): readonly string[] {
  const port = vaultPort(vault);
  return retrieveMemoryContext(retrievalRequest(), port).included.map((m) => String(m.memoryId));
}

function runSelectiveForgetting(): { passed: boolean; evidence: string } {
  const vault = openVault(freshDir());
  try {
    seedForgetTargets(vault);
    const allRecords = vault.listMemoriesByScope(userScope("user-alice"));
    const selected = selectMemoriesForForget(
      allRecords,
      { kind: "by-type", scope: userScope("user-alice"), type: "preference" },
      { nowMs: FIXED_NOW_MS },
    );
    const envelopes = buildForgetOperations(
      selected,
      { reviewerId: reviewerId("rev-1"), nowMs: FIXED_NOW_MS },
      { writeTombstone: true, reason: "AC selective-forgetting" },
    );
    for (const env of envelopes) {
      vault.deleteMemory(env.memoryId, {
        tombstone: true,
        forgetterSurface: "eval-harness",
        nowMs: env.forgottenAt,
      });
    }
    const after = includedIds(vault);
    const tombstones: readonly MemoryTombstone[] = vault.listTombstonesByScope(
      userScope("user-alice"),
    );
    const tombstoneIds = tombstones.map((t) => String(t.memoryId));
    const selectedExactlyTwo = selected.length === 2;
    const forgottenAbsent =
      !after.includes("forget-pref-one") && !after.includes("forget-pref-two");
    const keptPresent = after.includes(KEPT_ID);
    const tombstonesPresent =
      tombstoneIds.includes("forget-pref-one") && tombstoneIds.includes("forget-pref-two");
    return {
      passed: selectedExactlyTwo && forgottenAbsent && keptPresent && tombstonesPresent,
      evidence: `selected=${String(selected.length)} after=[${after.join(",")}] tombstones=[${tombstoneIds.join(",")}]`,
    };
  } finally {
    vault.close();
  }
}

export async function run(scorecard: Scorecard): Promise<void> {
  const { passed, evidence } = runSelectiveForgetting();
  scorecard.recordResult(SCENARIO_NAME, passed, evidence);
  await Promise.resolve();
}

describe(SCENARIO_NAME, () => {
  it("selects exactly the two preferences; deletes them; kept decision survives", () => {
    const { passed, evidence } = runSelectiveForgetting();
    expect(passed, evidence).toBe(true);
  });
});
