// StoreFingerprint collection (Wave 4a, epic #3233 §6.2/§8) — the `keiko support export`
// manifest's per-store schema/integrity snapshot. Lives in keiko-server, not keiko-cli, because
// this package already depends on all three store packages (its own ./store/, plus
// keiko-local-knowledge and keiko-memory-vault) per ADR-0019's Target Package Topology; keiko-cli
// is a leaf consumer of the domain packages through their public surfaces only and must not
// import keiko-local-knowledge directly (ADR-0019 direction rule 7, cli boundary). `keiko support
// export` reaches this function through keiko-server's own public package surface — the same
// `loadServer()` seam keiko-cli's support.ts already uses for the rest of the manifest.
//
// Each of the three per-store attempt functions below opens its store through that package's
// GENUINELY read-only open (`openNodeUiDatabaseReadOnly` / `openKnowledgeStoreReadOnly` /
// `openMemoryDatabaseReadOnly` — `node:sqlite`'s `readOnly: true`), never the mutating production
// open path (`openNodeUiDatabase` / `openKnowledgeStore` / `openMemoryDatabase`), which runs
// migrations, a client-turn recovery UPDATE, an encryption sweep, and a corruption-quarantine
// reopen as an ordinary part of opening. A diagnostic export must not perform any of those against
// the very store an operator is trying to inspect. It then calls that store package's own
// `computeStoreFingerprint(db)` — never a new redaction or key-resolution scheme. A store whose db
// file does not exist yet is never opened at all (the mutating open path can create one, or — for
// the memory vault's keyfile tier — mint a brand-new key, exactly the write this collection must
// not cause for a subsystem the operator never touched); every other failure (corruption, a vault
// key the operator has not supplied, an unreadable path) collapses to the same closed-vocabulary
// "open-failed" reason, one bucket wide by design so this diagnostic surface never has to carry a
// store-specific error.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { StoreFingerprint } from "@oscharko-dev/keiko-contracts";
import {
  computeStoreFingerprint as computeLocalKnowledgeStoreFingerprint,
  openKnowledgeStoreReadOnly,
  resolveKnowledgeStorePath,
} from "@oscharko-dev/keiko-local-knowledge";
import {
  computeStoreFingerprint as computeMemoryVaultStoreFingerprint,
  MEMORY_DB_FILENAME,
  openMemoryDatabaseReadOnly,
  resolveVaultKeyReadOnly,
} from "@oscharko-dev/keiko-memory-vault";
import {
  computeStoreFingerprint as computeUiStoreFingerprint,
  openNodeUiDatabaseReadOnly,
  UI_DB_FILENAME,
} from "./store/index.js";

export type StoreFingerprintUnavailableReasonKind = "missing" | "open-failed";

export interface StoreFingerprintUnavailableEntry {
  readonly store: StoreFingerprint["store"];
  readonly reasonKind: StoreFingerprintUnavailableReasonKind;
}

export interface CollectStoreFingerprintsInput {
  readonly stateDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface CollectStoreFingerprintsResult {
  readonly fingerprints: readonly StoreFingerprint[];
  readonly unavailable: readonly StoreFingerprintUnavailableEntry[];
}

type StoreFingerprintOutcome =
  | { readonly fingerprint: StoreFingerprint }
  | { readonly unavailable: StoreFingerprintUnavailableEntry };

function unavailableOutcome(
  store: StoreFingerprint["store"],
  reasonKind: StoreFingerprintUnavailableReasonKind,
): StoreFingerprintOutcome {
  return { unavailable: { store, reasonKind } };
}

// `keiko support export --state-dir` maps the ui store to `<stateDir>/ui/keiko-ui.db` and the
// memory vault to `<stateDir>/memory/keiko-memory.db` unless KEIKO_UI_DATA_DIR / KEIKO_MEMORY_DIR
// override them. The subdir names are duplicated here rather than imported from keiko-cli's
// state-paths.ts (`DEFAULT_UI_STATE_SUBDIR`): ADR-0019's dependency direction runs
// keiko-cli -> keiko-server, never the reverse, so this package cannot depend on keiko-cli for a
// constant — the same accepted, documented-duplication tradeoff state-paths.ts itself already
// applies in the other direction for these packages' own filenames.
const UI_STATE_SUBDIR = "ui";
const MEMORY_STATE_SUBDIR = "memory";

// `node:sqlite` is synchronous end to end, so — unlike keiko-cli's lazy-loaded equivalents this
// function replaces — none of the three per-store attempts below needs `await`: the store
// packages are already static imports in this package (no dynamic `import()` to wait on).
function uiStoreFingerprintOutcome(
  stateDir: string,
  env: Readonly<Record<string, string | undefined>>,
): StoreFingerprintOutcome {
  try {
    const uiDataDir = env.KEIKO_UI_DATA_DIR ?? join(stateDir, UI_STATE_SUBDIR);
    const dbPath = join(uiDataDir, UI_DB_FILENAME);
    if (!existsSync(dbPath)) return unavailableOutcome("ui", "missing");
    const db = openNodeUiDatabaseReadOnly(dbPath);
    try {
      return { fingerprint: computeUiStoreFingerprint(db) };
    } finally {
      db.close();
    }
  } catch {
    return unavailableOutcome("ui", "open-failed");
  }
}

function localKnowledgeStoreFingerprintOutcome(stateDir: string): StoreFingerprintOutcome {
  try {
    const dbPath = resolveKnowledgeStorePath({ runtimeStateDir: stateDir });
    if (!existsSync(dbPath)) return unavailableOutcome("local-knowledge", "missing");
    const db = openKnowledgeStoreReadOnly(dbPath);
    try {
      return { fingerprint: computeLocalKnowledgeStoreFingerprint(db) };
    } finally {
      db.close();
    }
  } catch {
    return unavailableOutcome("local-knowledge", "open-failed");
  }
}

function memoryVaultStoreFingerprintOutcome(
  stateDir: string,
  env: Readonly<Record<string, string | undefined>>,
): StoreFingerprintOutcome {
  try {
    const memoryDir = env.KEIKO_MEMORY_DIR ?? join(stateDir, MEMORY_STATE_SUBDIR);
    const dbPath = join(memoryDir, MEMORY_DB_FILENAME);
    if (!existsSync(dbPath)) return unavailableOutcome("memory-vault", "missing");
    // `resolveVaultKeyReadOnly` (never the mutating `resolveVaultKey`) — a db that exists but
    // answers to neither the env key nor the OS keychain must degrade `keySource` to `undefined`
    // (computeMemoryVaultStoreFingerprint tolerates that), never mint and persist a brand-new
    // keyfile into the very state dir this diagnostic export is trying to inspect (Finding 0).
    const resolved = resolveVaultKeyReadOnly(env);
    const db = openMemoryDatabaseReadOnly(dbPath);
    try {
      return { fingerprint: computeMemoryVaultStoreFingerprint(db, resolved.source) };
    } finally {
      db.close();
    }
  } catch {
    return unavailableOutcome("memory-vault", "open-failed");
  }
}

function partitionStoreFingerprintOutcomes(
  outcomes: readonly StoreFingerprintOutcome[],
): CollectStoreFingerprintsResult {
  const fingerprints: StoreFingerprint[] = [];
  const unavailable: StoreFingerprintUnavailableEntry[] = [];
  for (const outcome of outcomes) {
    if ("fingerprint" in outcome) {
      fingerprints.push(outcome.fingerprint);
    } else {
      unavailable.push(outcome.unavailable);
    }
  }
  return { fingerprints, unavailable };
}

/**
 * Opens each of the ui, local-knowledge, and memory-vault stores found under `input.stateDir`
 * through its owning package's genuinely read-only open, computes a redacted
 * {@link StoreFingerprint} for each store that is present and openable, and reports every other
 * store — never used yet from this state dir, or present but unopenable — in `unavailable` with a
 * closed-vocabulary reason. Never throws: a per-store open failure degrades to an `unavailable`
 * entry rather than failing the whole collection.
 *
 * Returns a `Promise` for parity with `keiko-cli`'s other lazily-loaded server-module seams (and
 * headroom for a genuinely async store package later), even though every read here is
 * synchronous today (`node:sqlite`) — an `async` declaration with no real `await` inside it would
 * itself be flagged (`@typescript-eslint/require-await`), so the wrapping is explicit instead.
 */
export function collectStoreFingerprints(
  input: CollectStoreFingerprintsInput,
): Promise<CollectStoreFingerprintsResult> {
  const outcomes = [
    uiStoreFingerprintOutcome(input.stateDir, input.env),
    localKnowledgeStoreFingerprintOutcome(input.stateDir),
    memoryVaultStoreFingerprintOutcome(input.stateDir, input.env),
  ];
  return Promise.resolve(partitionStoreFingerprintOutcomes(outcomes));
}
