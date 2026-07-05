// Local-state store for Quality Intelligence runs (Issue #274, Epic #270, ADR-0023 D7+D8).
//
// Extends the existing `keiko-evidence` JSON-on-disk discipline (NOT a separate database, NOT a
// new runtime dependency) per ADR-0023 D7 "extend, don't fork". Each QI run is persisted as one
// schema-validated JSON file `<runId>.qi.json` under a `qi/` subdirectory of the evidence base
// dir; the four conceptual "tables" of the brief (runs / findings / exports / evidence-refs)
// surface as the readonly arrays on the manifest itself.
//
// Why JSON-on-disk and not a new SQLite table set: the local-state contract (issue #175) freezes
// the on-disk surface to "evidence is JSON". Introducing a SQLite DB inside keiko-evidence would
// fork the contract. The brief explicitly allows the "analogous structure if the store is not
// SQLite" alternative.
//
// Safety:
// - Base dir is realpath-contained once at construction; every child path is derived from a
//   validated runId and the lexical directory entry is inspected before overwrite/delete.
// - File names are derived from the VALIDATED runId via assertValidRunId — no separator/`..`/NUL
//   can reach the resolved path.
// - Writes are atomic O_EXCL temp + rename. A partial write leaves a `.tmp` that is invisible to
//   list (which only counts `.qi.json` suffixes), so an unclean shutdown never surfaces a
//   half-written run.
// - The QI base dir is created with mode 0o700, files with the default umask + 0o600 intent (the
//   atomic temp inherits the umask; the rename preserves it).

import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, lstatSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveWithinWorkspace, type WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { assertValidRunId } from "@oscharko-dev/keiko-security";
import { replaceViaDurableTempFile } from "../durable-write.js";
import { EvidenceReadError, EvidenceWriteError } from "../errors.js";
import { existingOwnedDirectory, prepareOwnedDirectory } from "../fs-safety.js";
import {
  QUALITY_INTELLIGENCE_EVIDENCE_SCHEMA_VERSION,
  validateQualityIntelligenceEvidenceManifest,
  type QualityIntelligenceEvidenceManifest,
  type QualityIntelligenceAtomFingerprintRow,
  type QualityIntelligenceIntegrityHashes,
  type QualityIntelligenceSourceFingerprintRow,
} from "./manifestSchema.js";
import {
  redactQualityIntelligenceEvidence,
  type QualityIntelligenceRedactionOptions,
} from "./redaction.js";

// `qi/` subdir of the evidence base; chosen so `listEvidence()` (the existing API for run-level
// JSON manifests) does NOT see QI manifests by accident — different layer, different shape.
export const QI_SUBDIR = "qi";

const QI_MANIFEST_SUFFIX = ".qi.json";

const QI_DIR_MODE = 0o700;

// ─── Port ──────────────────────────────────────────────────────────────────────────

// The QI local-state port. Modelled after the EvidenceStore port but typed against the QI
// manifest shape so callers never have to round-trip through `JSON.parse(unknown)`.
export interface QualityIntelligenceLocalStore {
  readonly record: (manifest: QualityIntelligenceEvidenceManifest) => string;
  readonly load: (runId: string) => QualityIntelligenceEvidenceManifest | undefined;
  readonly list: () => readonly string[];
  readonly location: (runId: string) => string;
  readonly delete: (runId: string) => boolean;
}

// ─── In-memory store (tests + future port-injected callers) ─────────────────────────

export function createInMemoryQualityIntelligenceLocalStore(): QualityIntelligenceLocalStore {
  const data = new Map<string, QualityIntelligenceEvidenceManifest>();
  return {
    record: (manifest: QualityIntelligenceEvidenceManifest): string => {
      assertValidRunId(manifest.runId);
      data.set(manifest.runId, manifest);
      return `${manifest.runId}${QI_MANIFEST_SUFFIX}`;
    },
    load: (runId: string): QualityIntelligenceEvidenceManifest | undefined => {
      assertValidRunId(runId);
      return data.get(runId);
    },
    list: (): readonly string[] => [...data.keys()].sort(),
    location: (runId: string): string => {
      assertValidRunId(runId);
      return `${runId}${QI_MANIFEST_SUFFIX}`;
    },
    delete: (runId: string): boolean => {
      assertValidRunId(runId);
      return data.delete(runId);
    },
  };
}

// ─── Node adapter ──────────────────────────────────────────────────────────────────

function prepareQiBaseDir(baseDir: string, fs: WorkspaceFs): string {
  return prepareOwnedDirectory(baseDir, fs, "QI evidence directory", { mode: QI_DIR_MODE });
}

function existingQiBaseDir(baseDir: string, fs: WorkspaceFs): string | undefined {
  return existingOwnedDirectory(baseDir, fs, "QI evidence directory");
}

function lexicalQiManifestPath(runId: string, realBase: string): string {
  assertValidRunId(runId);
  return resolveWithinWorkspace(realBase, `${runId}${QI_MANIFEST_SUFFIX}`);
}

function isQiManifestName(name: string): boolean {
  if (!name.endsWith(QI_MANIFEST_SUFFIX)) {
    return false;
  }
  const runId = name.slice(0, name.length - QI_MANIFEST_SUFFIX.length);
  try {
    assertValidRunId(runId);
    return true;
  } catch {
    return false;
  }
}

function isSingleLinkRegularFile(path: string, fs: WorkspaceFs): boolean {
  try {
    const stat = fs.stat(path);
    return stat.isFile && (stat.hardLinkCount ?? 1) <= 1;
  } catch (error) {
    throw new EvidenceReadError(
      `cannot inspect QI manifest: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function assertWritableQiManifestEntry(target: string, fs: WorkspaceFs): void {
  const entry = lstatSync(target, { throwIfNoEntry: false });
  if (entry === undefined) return;
  if (!entry.isFile() || !isSingleLinkRegularFile(target, fs)) {
    throw new EvidenceWriteError("cannot overwrite a non-ledger QI manifest");
  }
}

function listQiRunIds(realBase: string, fs: WorkspaceFs): readonly string[] {
  const runIds: string[] = [];
  try {
    for (const entry of readdirSync(realBase, { withFileTypes: true })) {
      if (
        entry.isSymbolicLink() ||
        !entry.isFile() ||
        !isQiManifestName(entry.name) ||
        !isSingleLinkRegularFile(join(realBase, entry.name), fs)
      ) {
        continue;
      }
      runIds.push(entry.name.slice(0, entry.name.length - QI_MANIFEST_SUFFIX.length));
    }
  } catch (error) {
    throw new EvidenceReadError(
      `cannot list QI manifests: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  return runIds.sort();
}

function atomicWriteQiManifest(target: string, json: string, randomSuffix: () => string): void {
  const temp = `${target}.${randomSuffix()}.tmp`;
  try {
    replaceViaDurableTempFile(target, temp, json);
  } catch (error) {
    rmSync(temp, { force: true });
    throw new EvidenceWriteError(
      `QI manifest write failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function reportQiLocation(baseDir: string, fs: WorkspaceFs, runId: string): string {
  assertValidRunId(runId);
  const realBase = existingQiBaseDir(baseDir, fs);
  return realBase === undefined
    ? join(resolve(baseDir), `${runId}${QI_MANIFEST_SUFFIX}`)
    : lexicalQiManifestPath(runId, realBase);
}

// Test-observable counter of full manifest parse+verify passes. Incremented once per manifest that
// is actually parsed and integrity-verified (i.e. per cache MISS). A regression test asserts that a
// second list of unchanged manifests adds zero to this counter (GEN-PERF-PERSISTENCE-009).
export const __qiVerificationStats = { verifications: 0 };

function parseAndValidateManifest(json: string): QualityIntelligenceEvidenceManifest {
  __qiVerificationStats.verifications += 1;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new EvidenceReadError(
      `QI manifest is not valid JSON: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  const validation = validateQualityIntelligenceEvidenceManifest(parsed);
  if (!validation.ok) {
    throw new EvidenceReadError(`QI manifest schema invalid: ${validation.reason ?? "unknown"}`);
  }
  const manifest = parsed as QualityIntelligenceEvidenceManifest;
  // Issue #637 — verify recorded SHA-256 integrity hashes AND totals against the live
  // collections on read. The strict-schema gate above only validates the schema-version literal,
  // the closed top-level key set, and the status enum; it does NOT detect a tampered finding /
  // export / evidenceRef payload or a totals/collections drift. Failing closed here keeps the
  // BFF list endpoint from surfacing corrupted runs and forces the detail endpoint into its
  // controlled error path.
  assertManifestIntegrity(manifest);
  return manifest;
}

// GEN-PERF-PERSISTENCE-009 — the QI list endpoint parses + SHA-256-re-hashes up to 100 manifests
// per request, and callers often re-list within seconds. QI manifests are write-once by contract
// (only an export append rewrites the file, which bumps mtime+size), so a positive verification
// result is safe to memoise keyed by absolute path + mtimeMs + size: any at-rest tamper changes the
// content (and therefore, on a real filesystem, the size and/or mtime), forcing a cache miss and a
// full re-verify on the next read. Tamper-evidence is preserved — we cache ONLY verified manifests.
//
// Correctness guards: (1) if the filesystem cannot report mtimeMs (e.g. the in-memory test fs) we
// never cache, so those callers always re-verify; (2) the cache is bounded (LRU) and in-process
// only — no plaintext or verification state is ever persisted.
interface QiVerificationCacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly manifest: QualityIntelligenceEvidenceManifest;
}

const QI_VERIFICATION_CACHE_MAX_ENTRIES = 256;
const qiVerificationCache = new Map<string, QiVerificationCacheEntry>();

function qiVerificationCacheGet(
  absolutePath: string,
  mtimeMs: number,
  size: number,
): QualityIntelligenceEvidenceManifest | undefined {
  const entry = qiVerificationCache.get(absolutePath);
  if (entry?.mtimeMs !== mtimeMs || entry.size !== size) {
    return undefined;
  }
  // Refresh LRU recency: re-insert so the most-recently-used key is last.
  qiVerificationCache.delete(absolutePath);
  qiVerificationCache.set(absolutePath, entry);
  return entry.manifest;
}

function qiVerificationCacheSet(
  absolutePath: string,
  mtimeMs: number,
  size: number,
  manifest: QualityIntelligenceEvidenceManifest,
): void {
  qiVerificationCache.delete(absolutePath);
  qiVerificationCache.set(absolutePath, { mtimeMs, size, manifest });
  while (qiVerificationCache.size > QI_VERIFICATION_CACHE_MAX_ENTRIES) {
    const oldest = qiVerificationCache.keys().next().value;
    if (oldest === undefined) break;
    qiVerificationCache.delete(oldest);
  }
}

// Test-only: reset the module-level verification cache so a suite gets a clean slate.
export function __resetQiVerificationCacheForTests(): void {
  qiVerificationCache.clear();
}

function assertHashMatches(
  label: string,
  expected: string | undefined,
  stored: string | undefined,
): void {
  if (expected !== stored) {
    throw new EvidenceReadError(`QI manifest ${label} integrity hash mismatch`);
  }
}

function assertIntegrityHashesMatch(manifest: QualityIntelligenceEvidenceManifest): void {
  const expected = buildIntegrityHashes(manifest.findings, manifest.exports, manifest.evidenceRefs);
  assertHashMatches("findings", expected.findings, manifest.integrityHashes.findings);
  assertHashMatches("exports", expected.exports, manifest.integrityHashes.exports);
  assertHashMatches("evidenceRefs", expected.evidenceRefs, manifest.integrityHashes.evidenceRefs);
  // atomFingerprints are hashed unconditionally whenever present (#821), so compare expected-vs-stored
  // directly — a removed or added set (stored present, expected absent or vice versa) is caught too.
  const expectedAtomFingerprints =
    manifest.atomFingerprints === undefined ? undefined : sha256OfJson(manifest.atomFingerprints);
  assertHashMatches(
    "atomFingerprints",
    expectedAtomFingerprints,
    manifest.integrityHashes.atomFingerprints,
  );
  // coverageMatrix and sourceFingerprints: derive expected = (collection === undefined ? undefined :
  // sha256OfJson(collection)) and compare with assertHashMatches so a present collection with a
  // deleted stored sub-hash FAILS CLOSED (mirrors atomFingerprints above — removal-proof).
  const expectedCoverageMatrix =
    manifest.coverageMatrix === undefined ? undefined : sha256OfJson(manifest.coverageMatrix);
  assertHashMatches(
    "coverageMatrix",
    expectedCoverageMatrix,
    manifest.integrityHashes.coverageMatrix,
  );
  const expectedSourceFingerprints =
    manifest.sourceFingerprints === undefined
      ? undefined
      : sha256OfJson(manifest.sourceFingerprints);
  assertHashMatches(
    "sourceFingerprints",
    expectedSourceFingerprints,
    manifest.integrityHashes.sourceFingerprints,
  );
}

// Integrity scope (be precise — this is the on-read tamper-detection contract): we verify the
// (totals ↔ collection-length) invariant for findings/exports AND the per-group SHA-256 hashes for
// findings / exports / evidenceRefs / atomFingerprints (+ coverageMatrix / sourceFingerprints when
// their stored hash is present). We do NOT hash the run-level scalars (`status`, `totals.candidates`,
// `provenanceRefs`, `qualityScore`, `modelId`, `modelParameters`, `seedUsed`, `planAt`/`completedAt`,
// `retentionPolicyId`, `policyProfileIds`, `modelGatewayCallCount`, `redactionSummary`): a local
// on-disk edit of those passes load. This is an accepted limitation of the local-state threat model
// (the operator owns the disk); extending coverage to a scalar `meta` group is tracked as a #274
// follow-up (see ADR-0023 D8). The schema gate already rejects unknown/missing top-level keys and a
// bad status enum, so a scalar edit cannot change the manifest SHAPE — only a value.
function assertManifestIntegrity(manifest: QualityIntelligenceEvidenceManifest): void {
  if (manifest.totals.findings !== manifest.findings.length) {
    throw new EvidenceReadError(
      `QI manifest totals.findings (${String(manifest.totals.findings)}) does not match findings.length (${String(manifest.findings.length)})`,
    );
  }
  if (manifest.totals.exports !== manifest.exports.length) {
    throw new EvidenceReadError(
      `QI manifest totals.exports (${String(manifest.totals.exports)}) does not match exports.length (${String(manifest.exports.length)})`,
    );
  }
  assertIntegrityHashesMatch(manifest);
}

// eslint-disable-next-line complexity -- the mtime+size verification-cache fast path (GEN-PERF-PERSISTENCE-009) is interleaved with the symlink/regular-file safety guards; splitting it would separate the cache-hit branch from the guards it depends on.
function loadQiManifest(
  baseDir: string,
  fs: WorkspaceFs,
  runId: string,
): QualityIntelligenceEvidenceManifest | undefined {
  assertValidRunId(runId);
  const realBase = existingQiBaseDir(baseDir, fs);
  if (realBase === undefined) {
    return undefined;
  }
  const target = join(realBase, `${runId}${QI_MANIFEST_SUFFIX}`);
  try {
    if (lstatSync(target, { throwIfNoEntry: false })?.isFile() !== true) {
      return undefined;
    }
    if (!isSingleLinkRegularFile(target, fs)) {
      return undefined;
    }
    // GEN-PERF-PERSISTENCE-009 — reuse a previously verified manifest when the file's mtime+size is
    // unchanged, so a repeated list does not re-parse + re-hash unmodified write-once manifests.
    // Only cache when the fs reports mtimeMs (real node fs does; the in-memory test fs does not).
    const stat = fs.stat(target);
    const mtimeMs = stat.mtimeMs;
    if (mtimeMs !== undefined) {
      const cached = qiVerificationCacheGet(target, mtimeMs, stat.size);
      if (cached !== undefined) {
        return cached;
      }
    }
    const json = readFileSync(target, "utf8");
    const manifest = parseAndValidateManifest(json);
    if (mtimeMs !== undefined) {
      qiVerificationCacheSet(target, mtimeMs, stat.size, manifest);
    }
    return manifest;
  } catch (error) {
    if (error instanceof EvidenceReadError) {
      throw error;
    }
    throw new EvidenceReadError(
      `cannot read QI manifest: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function recordQiManifest(
  baseDir: string,
  fs: WorkspaceFs,
  randomSuffix: () => string,
  manifest: QualityIntelligenceEvidenceManifest,
): string {
  assertValidRunId(manifest.runId);
  const realBase = prepareQiBaseDir(baseDir, fs);
  const target = lexicalQiManifestPath(manifest.runId, realBase);
  assertWritableQiManifestEntry(target, fs);
  atomicWriteQiManifest(target, JSON.stringify(manifest), randomSuffix);
  const stat = fs.stat(target);
  if (stat.mtimeMs !== undefined) {
    qiVerificationCacheSet(target, stat.mtimeMs, stat.size, manifest);
  }
  return target;
}

function deleteQiManifest(baseDir: string, fs: WorkspaceFs, runId: string): boolean {
  assertValidRunId(runId);
  const realBase = existingQiBaseDir(baseDir, fs);
  if (realBase === undefined) {
    return false;
  }
  const target = lexicalQiManifestPath(runId, realBase);
  if (lstatSync(target, { throwIfNoEntry: false })?.isFile() !== true) {
    return false;
  }
  if (!isSingleLinkRegularFile(target, fs)) {
    return false;
  }
  rmSync(target, { force: true });
  return true;
}

export interface QualityIntelligenceNodeStoreOptions {
  readonly fs?: WorkspaceFs;
  readonly randomSuffix?: () => string;
}

// Build a QI store that writes under `<evidenceDir>/qi/`. The caller passes the SAME evidence dir
// it would pass to `createNodeEvidenceStore` (i.e. the output of `resolveEvidenceDir`), and the
// store layers the `qi/` subdir itself so the local-state contract resolves identically for both
// the run-level evidence manifest and the QI sub-manifest.
export function createNodeQualityIntelligenceLocalStore(
  evidenceDir: string,
  options: QualityIntelligenceNodeStoreOptions = {},
): QualityIntelligenceLocalStore {
  const baseDir = join(evidenceDir, QI_SUBDIR);
  const fs = options.fs ?? nodeWorkspaceFs;
  const randomSuffix = options.randomSuffix ?? randomUUID;
  return {
    record: (manifest: QualityIntelligenceEvidenceManifest): string =>
      recordQiManifest(baseDir, fs, randomSuffix, manifest),
    load: (runId: string): QualityIntelligenceEvidenceManifest | undefined =>
      loadQiManifest(baseDir, fs, runId),
    list: (): readonly string[] => {
      const realBase = existingQiBaseDir(baseDir, fs);
      return realBase === undefined ? [] : listQiRunIds(realBase, fs);
    },
    location: (runId: string): string => reportQiLocation(baseDir, fs, runId),
    delete: (runId: string): boolean => deleteQiManifest(baseDir, fs, runId),
  };
}

// ─── Public CRUD API ───────────────────────────────────────────────────────────────

export interface QualityIntelligenceRecordInput {
  readonly runId: string;
  readonly planAt: string;
  readonly completedAt: string | undefined;
  readonly status: QualityIntelligenceEvidenceManifest["status"];
  readonly policyProfileIds: readonly string[];
  readonly retentionPolicyId: string;
  readonly modelGatewayCallCount: number;
  readonly totals: QualityIntelligenceEvidenceManifest["totals"];
  readonly findings: QualityIntelligenceEvidenceManifest["findings"];
  readonly exports: QualityIntelligenceEvidenceManifest["exports"];
  readonly evidenceRefs: QualityIntelligenceEvidenceManifest["evidenceRefs"];
  readonly provenanceRefs: QualityIntelligenceEvidenceManifest["provenanceRefs"];
  /** Optional coverage matrix (per-atom status, refs only). Added in #738. */
  readonly coverageMatrix?: QualityIntelligenceEvidenceManifest["coverageMatrix"];
  /** Optional run quality score — percent of candidates with a strong judge outcome [0-100]; null when judge was skipped. Added in #736. */
  readonly qualityScore?: QualityIntelligenceEvidenceManifest["qualityScore"];
  /** Optional count-only judge diagnostics separating judged from unjudged candidates. */
  readonly qualityDiagnostics?: QualityIntelligenceEvidenceManifest["qualityDiagnostics"];
  /** Optional per-envelope content fingerprints for drift detection (Epic #735). */
  readonly sourceFingerprints?: readonly QualityIntelligenceSourceFingerprintRow[];
  /** Optional per-atom content fingerprints for atom-aware drift detection (#798/#799). */
  readonly atomFingerprints?: readonly QualityIntelligenceAtomFingerprintRow[];
  /** Optional model id that generated the candidates (Epic #761). */
  readonly modelId?: string;
  /** Optional redaction-safe request parameter scalars (Epic #761). */
  readonly modelParameters?: Record<string, unknown>;
  /** Optional explicit QI model policy/routing provenance. */
  readonly modelRouting?: QualityIntelligenceEvidenceManifest["modelRouting"];
  /** Optional seed used for deterministic sampling (Epic #761). */
  readonly seedUsed?: number | null;
}

export interface QualityIntelligenceRecordOptions {
  readonly store?: QualityIntelligenceLocalStore | undefined;
  readonly evidenceDir?: string | undefined;
  readonly redaction?: QualityIntelligenceRedactionOptions | undefined;
}

export interface QualityIntelligenceRecordResult {
  readonly manifest: QualityIntelligenceEvidenceManifest;
  readonly location: string;
}

function sha256OfJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function buildIntegrityHashes(
  findings: QualityIntelligenceEvidenceManifest["findings"],
  exports_: QualityIntelligenceEvidenceManifest["exports"],
  evidenceRefs: QualityIntelligenceEvidenceManifest["evidenceRefs"],
  atomFingerprints?: QualityIntelligenceEvidenceManifest["atomFingerprints"],
  coverageMatrix?: QualityIntelligenceEvidenceManifest["coverageMatrix"],
  sourceFingerprints?: QualityIntelligenceEvidenceManifest["sourceFingerprints"],
): QualityIntelligenceIntegrityHashes {
  return {
    findings: sha256OfJson(findings),
    exports: sha256OfJson(exports_),
    evidenceRefs: sha256OfJson(evidenceRefs),
    ...(atomFingerprints !== undefined ? { atomFingerprints: sha256OfJson(atomFingerprints) } : {}),
    ...(coverageMatrix !== undefined ? { coverageMatrix: sha256OfJson(coverageMatrix) } : {}),
    ...(sourceFingerprints !== undefined
      ? { sourceFingerprints: sha256OfJson(sourceFingerprints) }
      : {}),
  };
}

function assertTotalsMatchCollections(input: QualityIntelligenceRecordInput): void {
  // The `candidates` total is reported by the workflow (it isn't carried as a separate collection
  // on the manifest), so we only validate findings and exports here.
  if (input.totals.findings !== input.findings.length) {
    throw new EvidenceWriteError(
      `QI totals.findings (${String(input.totals.findings)}) does not match findings.length (${String(input.findings.length)})`,
    );
  }
  if (input.totals.exports !== input.exports.length) {
    throw new EvidenceWriteError(
      `QI totals.exports (${String(input.totals.exports)}) does not match exports.length (${String(input.exports.length)})`,
    );
  }
}

function resolveStore(
  options: QualityIntelligenceRecordOptions,
): QualityIntelligenceLocalStore | undefined {
  if (options.store !== undefined) {
    return options.store;
  }
  if (options.evidenceDir !== undefined) {
    return createNodeQualityIntelligenceLocalStore(options.evidenceDir);
  }
  return undefined;
}

// Persist a QI run record. Runs the QI redactor over the input FIRST (every string leaf), then
// computes per-group SHA-256 integrity hashes over the redacted collections, then validates the
// (totals, collection-length) invariant, then writes the assembled manifest atomically.
//
// The store is wired via options.store (explicit, e.g. in-memory for tests) or options.evidenceDir
// (resolve to a node adapter). Either MUST be supplied.
/**
 * The string-bearing optional manifest fields that pass the persist redactor in
 * `recordQualityIntelligenceRun`. They are sourced from the redacted set (not raw `input`) so the
 * persisted/hashed values match what the redactor produced.
 */
interface RedactedOptionalManifestFields {
  readonly coverageMatrix?: QualityIntelligenceEvidenceManifest["coverageMatrix"];
  readonly modelParameters?: QualityIntelligenceEvidenceManifest["modelParameters"];
  readonly modelRouting?: QualityIntelligenceEvidenceManifest["modelRouting"];
}

/** Optional manifest fields that are only present when supplied (exactOptionalPropertyTypes). */
function optionalManifestFields(
  input: QualityIntelligenceRecordInput,
  redacted: RedactedOptionalManifestFields,
): Partial<
  Pick<
    QualityIntelligenceEvidenceManifest,
    | "coverageMatrix"
    | "qualityScore"
    | "qualityDiagnostics"
    | "sourceFingerprints"
    | "atomFingerprints"
    | "modelId"
    | "modelParameters"
    | "modelRouting"
    | "seedUsed"
  >
> {
  return {
    // coverageMatrix + modelParameters are taken from the redacted set; the remaining optionals are
    // ids / sha-256 hashes / numbers that carry no free text and need no persist-time scrub.
    ...(redacted.coverageMatrix !== undefined ? { coverageMatrix: redacted.coverageMatrix } : {}),
    ...(input.qualityScore !== undefined ? { qualityScore: input.qualityScore } : {}),
    ...(input.qualityDiagnostics !== undefined
      ? { qualityDiagnostics: input.qualityDiagnostics }
      : {}),
    ...(input.sourceFingerprints !== undefined
      ? { sourceFingerprints: input.sourceFingerprints }
      : {}),
    ...(input.atomFingerprints !== undefined ? { atomFingerprints: input.atomFingerprints } : {}),
    ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    ...(redacted.modelParameters !== undefined
      ? { modelParameters: redacted.modelParameters }
      : {}),
    ...(redacted.modelRouting !== undefined ? { modelRouting: redacted.modelRouting } : {}),
    ...(input.seedUsed !== undefined ? { seedUsed: input.seedUsed } : {}),
  };
}

function buildRunManifest(
  input: QualityIntelligenceRecordInput,
  redacted: {
    readonly planAt: QualityIntelligenceEvidenceManifest["planAt"];
    readonly completedAt: QualityIntelligenceEvidenceManifest["completedAt"];
    readonly policyProfileIds: QualityIntelligenceEvidenceManifest["policyProfileIds"];
    readonly retentionPolicyId: QualityIntelligenceEvidenceManifest["retentionPolicyId"];
    readonly findings: QualityIntelligenceEvidenceManifest["findings"];
    readonly exports: QualityIntelligenceEvidenceManifest["exports"];
    readonly evidenceRefs: QualityIntelligenceEvidenceManifest["evidenceRefs"];
    readonly provenanceRefs: QualityIntelligenceEvidenceManifest["provenanceRefs"];
  },
  summary: QualityIntelligenceEvidenceManifest["redactionSummary"],
  integrityHashes: QualityIntelligenceEvidenceManifest["integrityHashes"],
  redactedOptionals: RedactedOptionalManifestFields,
): QualityIntelligenceEvidenceManifest {
  return {
    qiEvidenceSchemaVersion: QUALITY_INTELLIGENCE_EVIDENCE_SCHEMA_VERSION,
    runId: input.runId as QualityIntelligenceEvidenceManifest["runId"],
    planAt: redacted.planAt,
    completedAt: redacted.completedAt,
    status: input.status,
    policyProfileIds: redacted.policyProfileIds,
    retentionPolicyId: redacted.retentionPolicyId,
    modelGatewayCallCount: input.modelGatewayCallCount,
    totals: input.totals,
    findings: redacted.findings,
    exports: redacted.exports,
    evidenceRefs: redacted.evidenceRefs,
    provenanceRefs: redacted.provenanceRefs,
    redactionSummary: summary,
    integrityHashes,
    ...optionalManifestFields(input, redactedOptionals),
  };
}

export function recordQualityIntelligenceRun(
  input: QualityIntelligenceRecordInput,
  options: QualityIntelligenceRecordOptions = {},
): QualityIntelligenceRecordResult {
  assertValidRunId(input.runId);
  assertTotalsMatchCollections(input);
  const store = resolveStore(options);
  if (store === undefined) {
    throw new EvidenceWriteError(
      "recordQualityIntelligenceRun requires options.store or options.evidenceDir",
    );
  }
  // Redact every string leaf of the user-supplied collections + scalars BEFORE the manifest is
  // assembled or persisted. The summary is the counts-only artefact the audit will cross-check.
  const { redacted, summary } = redactQualityIntelligenceEvidence(
    {
      planAt: input.planAt,
      completedAt: input.completedAt,
      policyProfileIds: input.policyProfileIds,
      retentionPolicyId: input.retentionPolicyId,
      findings: input.findings,
      exports: input.exports,
      evidenceRefs: input.evidenceRefs,
      provenanceRefs: input.provenanceRefs,
      // coverageMatrix carries requirementExcerptRedacted (derived from raw source text) and
      // modelParameters is a free-shaped Record; both are string-bearing leaves that must pass the
      // persist redactor — not just their build-time scrub — so audit storage keeps the same
      // fail-closed backstop as findings/evidenceRefs (#273 audit — AC#3 audit-storage safety).
      coverageMatrix: input.coverageMatrix,
      modelParameters: input.modelParameters,
      modelRouting: input.modelRouting,
    },
    options.redaction ?? {},
  );
  const integrityHashes = buildIntegrityHashes(
    redacted.findings,
    redacted.exports,
    redacted.evidenceRefs,
    input.atomFingerprints,
    redacted.coverageMatrix,
    input.sourceFingerprints,
  );
  const manifest = buildRunManifest(input, redacted, summary, integrityHashes, {
    coverageMatrix: redacted.coverageMatrix,
    modelParameters: redacted.modelParameters,
    modelRouting: redacted.modelRouting,
  });
  return { manifest, location: store.record(manifest) };
}

// ─── Export-evidence append (Issue #283, AC4) ────────────────────────────────────────

export interface QualityIntelligenceExportEvidenceInput {
  readonly runId: string;
  /** The export row to append: target adapter, artifact id, integrity hash, attestation, mode. */
  readonly export: QualityIntelligenceEvidenceManifest["exports"][number];
}

// Fold a second redaction summary into a base one so the manifest's counts-only redaction summary
// stays internally consistent after an export row is appended (the run summary + the row's scan).
function foldRedactionSummary(
  base: QualityIntelligenceEvidenceManifest["redactionSummary"],
  add: QualityIntelligenceEvidenceManifest["redactionSummary"],
): QualityIntelligenceEvidenceManifest["redactionSummary"] {
  const patternsMatched: Record<string, number> = { ...base.patternsMatched };
  for (const [key, count] of Object.entries(add.patternsMatched)) {
    patternsMatched[key] = (patternsMatched[key] ?? 0) + count;
  }
  return {
    totalStringsScanned: base.totalStringsScanned + add.totalStringsScanned,
    stringsRedacted: base.stringsRedacted + add.stringsRedacted,
    patternsMatched,
  };
}

/**
 * Append one export-evidence row to an already-recorded run manifest (Issue #283, AC4 — "export
 * evidence records target type, artifact IDs, mapping profile, and result without leaking secrets";
 * Audit Addendum — "audit evidence for every export action").
 *
 * Every QI export action — a local serialisation download, a binary PDF/ZIP bundle, or a dry-run
 * preview — emits one audit row recording WHAT was exported (`targetAdapter`), the artifact id, its
 * integrity hash, the redaction attestation, and whether it was a dry-run. The disabled external-TMS
 * write path produces no artifact and therefore records nothing.
 *
 * Rows are deduplicated by exact `(id, dryRun)` to make append retries idempotent. Export routes
 * mint a fresh id for each successful user action, so repeated downloads are still auditable as
 * distinct actions while a retried append of the same row remains safe.
 *
 * Invariants preserved (mirrors {@link recordQualityIntelligenceRun}):
 *  - the new row's string leaves pass the persist redactor before assembly (the row carries only
 *    ids / an enum / a sha-256 hash / booleans, so this is a no-op in practice, but the persist
 *    redactor is applied unconditionally to keep the fail-closed contract uniform);
 *  - `integrityHashes.exports` is recomputed over the full new collection; the other hash groups are
 *    carried over unchanged because their collections did not change;
 *  - `totals.exports` stays equal to `exports.length` (asserted on read);
 *  - the counts-only `redactionSummary` folds in the new row's scan;
 *  - the manifest is rewritten through the same atomic O_EXCL temp + rename path.
 *
 * Throws `EvidenceReadError` when the run manifest does not exist (an export cannot precede its run)
 * and `EvidenceWriteError` when neither `store` nor `evidenceDir` is supplied or the write fails.
 */
export function appendQualityIntelligenceExportRow(
  input: QualityIntelligenceExportEvidenceInput,
  options: QualityIntelligenceRecordOptions = {},
): QualityIntelligenceRecordResult {
  assertValidRunId(input.runId);
  const store = resolveStore(options);
  if (store === undefined) {
    throw new EvidenceWriteError(
      "appendQualityIntelligenceExportRow requires options.store or options.evidenceDir",
    );
  }
  const existing = store.load(input.runId);
  if (existing === undefined) {
    throw new EvidenceReadError(
      `cannot append export evidence: QI run "${input.runId}" was not found`,
    );
  }
  const { redacted: redactedRow, summary: rowSummary } = redactQualityIntelligenceEvidence(
    input.export,
    options.redaction ?? {},
  );
  const isSameRow = (row: QualityIntelligenceEvidenceManifest["exports"][number]): boolean =>
    row.id === redactedRow.id && (row.dryRun ?? false) === (redactedRow.dryRun ?? false);
  if (existing.exports.some(isSameRow)) {
    return { manifest: existing, location: store.location(input.runId) };
  }
  const exports = [...existing.exports, redactedRow];
  const integrityHashes: QualityIntelligenceIntegrityHashes = {
    ...existing.integrityHashes,
    exports: sha256OfJson(exports),
  };
  const manifest: QualityIntelligenceEvidenceManifest = {
    ...existing,
    exports,
    totals: { ...existing.totals, exports: exports.length },
    integrityHashes,
    redactionSummary: foldRedactionSummary(existing.redactionSummary, rowSummary),
  };
  return { manifest, location: store.record(manifest) };
}

export interface QualityIntelligenceLoadOptions {
  readonly store?: QualityIntelligenceLocalStore | undefined;
  readonly evidenceDir?: string | undefined;
}

export function loadQualityIntelligenceRun(
  runId: string,
  options: QualityIntelligenceLoadOptions = {},
): QualityIntelligenceEvidenceManifest | undefined {
  const store = resolveLoadStore(options);
  return store.load(runId);
}

export function listQualityIntelligenceRuns(
  options: QualityIntelligenceLoadOptions = {},
): readonly string[] {
  const store = resolveLoadStore(options);
  return store.list();
}

function resolveLoadStore(options: QualityIntelligenceLoadOptions): QualityIntelligenceLocalStore {
  if (options.store !== undefined) {
    return options.store;
  }
  if (options.evidenceDir !== undefined) {
    return createNodeQualityIntelligenceLocalStore(options.evidenceDir);
  }
  throw new EvidenceReadError("QI load/list requires options.store or options.evidenceDir");
}
