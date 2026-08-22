// StoreFingerprint — a redacted, point-in-time snapshot of one persisted store's schema and
// integrity state (Wave 4a, epic #3233 §6.2). `keiko bundle export`'s manifest assembly (in
// `keiko-server`, which already depends on all three store packages) calls each store's own
// `computeStoreFingerprint(db)` and embeds the resulting array in the support bundle manifest's
// `storeFingerprints` field.
//
// Every field is a count, a closed-vocabulary label, or a bounded identifier drawn from this
// repository's own fixed table/migration lists — never a row, a path, a key, a secret, or free
// text (ADR-0128 D6 redaction vocabulary). `isStoreFingerprint` lets the manifest assembler
// refuse a malformed value before it is embedded, mirroring the fail-closed guard style already
// established in `atlassian-connectors-validation.ts`.
//
// Leaf-package rule (ADR-0019 direction 1): no `@oscharko-dev/keiko-*` imports, pure functions
// only, zero logic beyond the shape and its guard.

/**
 * A point-in-time, redacted snapshot of one persisted store's schema/integrity state, computed
 * by each store package's own `computeStoreFingerprint(db)` and assembled into the support
 * bundle manifest's `storeFingerprints` array (Wave 4a).
 */
export interface StoreFingerprint {
  readonly store: "ui" | "local-knowledge" | "memory-vault";
  /** `PRAGMA user_version`. */
  readonly schemaVersion: number;
  /** Migration-group names, already tracked by the store's own migration runner. */
  readonly migrationsApplied: readonly string[];
  /**
   * `COUNT(*)` over a FIXED, closed table-name list the owning package already declares — never
   * a dynamic table walk.
   */
  readonly tableRowCounts: Readonly<Record<string, number>>;
  /** `PRAGMA quick_check` summary — pass/fail only, never the raw check output. */
  readonly quickCheckOk: boolean;
  readonly encryptionMode: "plaintext" | "encrypted" | "migrating";
  /** The already-computed-then-discarded key-resolution tier, when the store is encrypted. */
  readonly keySource?: "env" | "keychain" | "keyfile" | undefined;
}

// ─── Closed-vocabulary sets (S7776: a Set, never `.includes()` on a constant array) ────────────
const STORE_FINGERPRINT_STORE_SET = new Set<string>(["ui", "local-knowledge", "memory-vault"]);
const STORE_FINGERPRINT_ENCRYPTION_MODE_SET = new Set<string>([
  "plaintext",
  "encrypted",
  "migrating",
]);
const STORE_FINGERPRINT_KEY_SOURCE_SET = new Set<string>(["env", "keychain", "keyfile"]);
const STORE_FINGERPRINT_KEY_SET = new Set<string>([
  "store",
  "schemaVersion",
  "migrationsApplied",
  "tableRowCounts",
  "quickCheckOk",
  "encryptionMode",
  "keySource",
]);

// A migration-group name or SQL table name is identifier-shaped and named by our own migration
// runners and schema declarations, never a caller — but the manifest assembler still refuses
// anything sentence-shaped before it is embedded, mirroring `ERROR_KIND_PATTERN`'s guard against
// an echoed payload riding an envelope field (ADR-0173 D11). Migration-group names commonly lead
// with a numeric sequence prefix (e.g. "0001-initial"), so — unlike `ERROR_KIND_PATTERN` — the
// leading character allows a digit too.
const BOUNDED_IDENTIFIER_PATTERN = /^\w[\w.-]{0,127}$/u;

// Defensive ceilings: both lists are FIXED and package-owned (never attacker- or user-grown), but
// a validator that embeds the result in a customer-facing bundle still bounds array/object size
// rather than trusting the producer unconditionally.
const STORE_FINGERPRINT_MAX_MIGRATIONS = 512;
const STORE_FINGERPRINT_MAX_TABLES = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && BOUNDED_IDENTIFIER_PATTERN.test(value);
}

function isStoreFingerprintStore(value: unknown): value is StoreFingerprint["store"] {
  return typeof value === "string" && STORE_FINGERPRINT_STORE_SET.has(value);
}

function isStoreFingerprintEncryptionMode(
  value: unknown,
): value is StoreFingerprint["encryptionMode"] {
  return typeof value === "string" && STORE_FINGERPRINT_ENCRYPTION_MODE_SET.has(value);
}

function isOptionalStoreFingerprintKeySource(
  value: unknown,
): value is StoreFingerprint["keySource"] {
  if (value === undefined) return true;
  return typeof value === "string" && STORE_FINGERPRINT_KEY_SOURCE_SET.has(value);
}

function isMigrationsApplied(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= STORE_FINGERPRINT_MAX_MIGRATIONS &&
    value.every((entry) => isBoundedIdentifier(entry))
  );
}

function isTableRowCounts(value: unknown): value is Readonly<Record<string, number>> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= STORE_FINGERPRINT_MAX_TABLES &&
    entries.every(
      ([table, count]) => isBoundedIdentifier(table) && isFiniteNonNegativeInteger(count),
    )
  );
}

function hasKnownStoreFingerprintKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => STORE_FINGERPRINT_KEY_SET.has(key));
}

function isStoreFingerprintCore(value: Record<string, unknown>): boolean {
  return (
    isStoreFingerprintStore(value.store) &&
    isFiniteNonNegativeInteger(value.schemaVersion) &&
    isMigrationsApplied(value.migrationsApplied) &&
    isTableRowCounts(value.tableRowCounts)
  );
}

function isStoreFingerprintEncryptionShape(value: Record<string, unknown>): boolean {
  return (
    typeof value.quickCheckOk === "boolean" &&
    isStoreFingerprintEncryptionMode(value.encryptionMode) &&
    isOptionalStoreFingerprintKeySource(value.keySource)
  );
}

/**
 * Fail-closed structural guard for {@link StoreFingerprint}: every union is checked against its
 * closed vocabulary, every count is a finite non-negative integer, every table/migration name is
 * a bounded identifier, and no unexpected field rides through. The manifest assembler uses this
 * to refuse a malformed fingerprint rather than embed it.
 */
export function isStoreFingerprint(value: unknown): value is StoreFingerprint {
  if (!isRecord(value) || !hasKnownStoreFingerprintKeys(value)) return false;
  return isStoreFingerprintCore(value) && isStoreFingerprintEncryptionShape(value);
}
