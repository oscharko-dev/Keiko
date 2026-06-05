// AC: error propagation. Corrupt input must surface as a typed error, never a crash or a
// silent pass.
//
// Two assertions, each a different boundary:
//  (a) Vault validator: insertMemory with NaN confidence must throw
//      MemoryStorageValidationError (code "invalid-input") and leave the vault state
//      untouched (a follow-up list call returns []).
//  (b) Retrieval orchestrator: a MemoryQueryPort that throws must surface as
//      RetrievalError("port-failure") with the original error preserved on `.cause`.
//
// Mutation-robustness controls:
//  1. POSITIVE: each assertion is met (typed error class + code + downstream state).
//  2. NEGATIVE/CONTROL: same paths with VALID input do NOT throw — proves the test would
//     pass-then-fail-silently if the validator/orchestrator stopped throwing.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MemoryStorageValidationError,
  createMemoryVault,
  type MemoryVaultStore,
} from "@oscharko-dev/keiko-memory-vault";
import {
  RetrievalError,
  retrieveMemoryContext,
  type MemoryQueryPort,
  type MemoryRetrievalRequest,
} from "@oscharko-dev/keiko-memory-retrieval";
import type { MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";

import { FIXED_NOW_MS, counterIdSource, makeRecord, userScope } from "../_support.js";
import type { Scorecard } from "../scorecard.js";

const SCENARIO_NAME = "error-propagation";

const cleanups: string[] = [];
afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "keiko-eval-err-"));
  cleanups.push(dir);
  return dir;
}

function openVault(dir: string): MemoryVaultStore {
  return createMemoryVault({
    memoryDir: dir,
    env: { KEIKO_MEMORY_DIR: dir },
    now: () => FIXED_NOW_MS,
    newTombstoneId: counterIdSource("tomb"),
  });
}

function buildNaNConfidenceRecord(): MemoryRecord {
  const valid = makeRecord({
    id: "corrupt-record",
    scope: { kind: "user", userId: "user-alice" },
    type: "preference",
    body: "this should never persist",
  });
  // Deliberately replace confidence with NaN — the contract validator (#205) rejects this
  // and surfaces a typed MemoryStorageValidationError at the vault boundary.
  return {
    ...valid,
    provenance: { ...valid.provenance, confidence: Number.NaN },
  };
}

function assertVaultRejectsCorrupt(): { passed: boolean; detail: string } {
  const vault = openVault(freshDir());
  try {
    let caught: unknown = null;
    try {
      vault.insertMemory(buildNaNConfidenceRecord());
    } catch (e) {
      caught = e;
    }
    const typed = caught instanceof MemoryStorageValidationError && caught.code === "invalid-input";
    // Control: a valid record DOES insert without throwing — proves the validator path
    // is gated on the bad shape, not always-firing.
    let controlCaught: unknown = null;
    try {
      vault.insertMemory(
        makeRecord({
          id: "valid-record",
          scope: { kind: "user", userId: "user-alice" },
          type: "preference",
          body: "this one is valid",
        }),
      );
    } catch (e) {
      controlCaught = e;
    }
    const controlPass = controlCaught === null;
    // State cleanliness: the bad record must NOT be in storage.
    const stored = vault.listMemoriesByScope(userScope("user-alice"));
    const cleanState = !stored.some((r) => String(r.id) === "corrupt-record");
    return {
      passed: typed && controlPass && cleanState,
      detail: `typed=${String(typed)} control=${String(controlPass)} clean=${String(cleanState)}`,
    };
  } finally {
    vault.close();
  }
}

function assertRetrievalWrapsPortFailure(): { passed: boolean; detail: string } {
  const root = new Error("synthetic port failure");
  const failingPort: MemoryQueryPort = {
    listByScope: (): readonly MemoryRecord[] => {
      throw root;
    },
  };
  const request: MemoryRetrievalRequest = {
    scopes: [userScope("user-alice")],
    nowMs: FIXED_NOW_MS,
  };
  let caught: unknown = null;
  try {
    retrieveMemoryContext(request, failingPort);
  } catch (e) {
    caught = e;
  }
  const typed =
    caught instanceof RetrievalError && caught.code === "port-failure" && caught.cause === root;
  // Control: same retrieval against a non-throwing port returns without throwing.
  const okPort: MemoryQueryPort = {
    listByScope: (): readonly MemoryRecord[] => [],
  };
  let controlCaught: unknown = null;
  try {
    retrieveMemoryContext(request, okPort);
  } catch (e) {
    controlCaught = e;
  }
  return {
    passed: typed && controlCaught === null,
    detail: `typed=${String(typed)} control=${String(controlCaught === null)}`,
  };
}

function runErrorPropagation(): { passed: boolean; evidence: string } {
  const vaultCheck = assertVaultRejectsCorrupt();
  const retrievalCheck = assertRetrievalWrapsPortFailure();
  return {
    passed: vaultCheck.passed && retrievalCheck.passed,
    evidence: `vault(${vaultCheck.detail}) retrieval(${retrievalCheck.detail})`,
  };
}

export async function run(scorecard: Scorecard): Promise<void> {
  const { passed, evidence } = runErrorPropagation();
  scorecard.recordResult(SCENARIO_NAME, passed, evidence);
  await Promise.resolve();
}

describe(SCENARIO_NAME, () => {
  it("vault rejects NaN confidence; retrieval wraps port failure with cause preserved", () => {
    const { passed, evidence } = runErrorPropagation();
    expect(passed, evidence).toBe(true);
  });
});
