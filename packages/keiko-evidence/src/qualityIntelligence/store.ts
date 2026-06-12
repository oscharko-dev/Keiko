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
// - Base dir is realpath-contained once at construction (reusing the assertContainedRealPath
//   primitive); every child path is re-checked before any read/write/delete.
// - File names are derived from the VALIDATED runId via assertValidRunId — no separator/`..`/NUL
//   can reach the resolved path.
// - Writes are atomic O_EXCL temp + rename. A partial write leaves a `.tmp` that is invisible to
//   list (which only counts `.qi.json` suffixes), so an unclean shutdown never surfaces a
//   half-written run.
// - The QI base dir is created with mode 0o700, files with the default umask + 0o600 intent (the
//   atomic temp inherits the umask; the rename preserves it).

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  lstatSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  assertContainedRealPath,
  resolveWithinWorkspace,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { assertValidRunId } from "@oscharko-dev/keiko-security";
import { EvidenceReadError, EvidenceWriteError } from "../errors.js";
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
  try {
    mkdirSync(baseDir, { recursive: true, mode: QI_DIR_MODE });
    return fs.realPath(baseDir);
  } catch (error) {
    throw new EvidenceWriteError(
      `cannot create QI evidence directory: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function existingQiBaseDir(baseDir: string, fs: WorkspaceFs): string | undefined {
  if (!fs.exists(baseDir)) {
    return undefined;
  }
  try {
    return fs.realPath(baseDir);
  } catch (error) {
    throw new EvidenceReadError(
      `cannot read QI evidence directory: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function containedQiManifestPath(runId: string, realBase: string, fs: WorkspaceFs): string {
  assertValidRunId(runId);
  const lexical = resolveWithinWorkspace(realBase, `${runId}${QI_MANIFEST_SUFFIX}`);
  return assertContainedRealPath(fs, realBase, lexical, `${runId}${QI_MANIFEST_SUFFIX}`);
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
    writeFileSync(temp, json, { encoding: "utf8", flag: "wx" });
    // Best-effort 0o600 on the temp file (the rename preserves the mode). Failure is non-fatal:
    // POSIX-default umask handles the common case; the assertion is realpath containment, not
    // permission bits.
    try {
      chmodSync(temp, 0o600);
    } catch {
      // ignore; not all filesystems support chmod (e.g. Windows)
    }
    renameSync(temp, target);
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
    : containedQiManifestPath(runId, realBase, fs);
}

function parseAndValidateManifest(json: string): QualityIntelligenceEvidenceManifest {
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

function assertHashMatches(
  label: string,
  expected: string | undefined,
  stored: string | undefined,
): void {
  if (expected !== stored) {
    throw new EvidenceReadError(`QI manifest ${label} integrity hash mismatch`);
  }
}

// Backward-compatible group check: a group that shipped before it was integrity-hashed (coverageMatrix
// #738, sourceFingerprints #735) may exist on a legacy manifest without a stored hash. Enforce the
// check only once a stored hash is present; new manifests always carry it, so tampering with a current
// group is still caught.
function assertOptionalHashMatches(
  label: string,
  value: unknown,
  stored: string | undefined,
): void {
  if (stored === undefined) return;
  if (sha256OfJson(value) !== stored) {
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
  assertOptionalHashMatches(
    "coverageMatrix",
    manifest.coverageMatrix,
    manifest.integrityHashes.coverageMatrix,
  );
  assertOptionalHashMatches(
    "sourceFingerprints",
    manifest.sourceFingerprints,
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
    const json = readFileSync(target, "utf8");
    return parseAndValidateManifest(json);
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
  const target = containedQiManifestPath(manifest.runId, realBase, fs);
  atomicWriteQiManifest(target, JSON.stringify(manifest), randomSuffix);
  return target;
}

function deleteQiManifest(baseDir: string, fs: WorkspaceFs, runId: string): boolean {
  assertValidRunId(runId);
  const realBase = existingQiBaseDir(baseDir, fs);
  if (realBase === undefined) {
    return false;
  }
  const target = containedQiManifestPath(runId, realBase, fs);
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
  /** Optional run quality score — percent of judged candidates rated "strong" [0-100]; null when judge was skipped. Added in #736. */
  readonly qualityScore?: QualityIntelligenceEvidenceManifest["qualityScore"];
  /** Optional per-envelope content fingerprints for drift detection (Epic #735). */
  readonly sourceFingerprints?: readonly QualityIntelligenceSourceFingerprintRow[];
  /** Optional per-atom content fingerprints for atom-aware drift detection (#798/#799). */
  readonly atomFingerprints?: readonly QualityIntelligenceAtomFingerprintRow[];
  /** Optional model id that generated the candidates (Epic #761). */
  readonly modelId?: string;
  /** Optional redaction-safe request parameter scalars (Epic #761). */
  readonly modelParameters?: Record<string, unknown>;
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
    | "sourceFingerprints"
    | "atomFingerprints"
    | "modelId"
    | "modelParameters"
    | "seedUsed"
  >
> {
  return {
    // coverageMatrix + modelParameters are taken from the redacted set; the remaining optionals are
    // ids / sha-256 hashes / numbers that carry no free text and need no persist-time scrub.
    ...(redacted.coverageMatrix !== undefined ? { coverageMatrix: redacted.coverageMatrix } : {}),
    ...(input.qualityScore !== undefined ? { qualityScore: input.qualityScore } : {}),
    ...(input.sourceFingerprints !== undefined
      ? { sourceFingerprints: input.sourceFingerprints }
      : {}),
    ...(input.atomFingerprints !== undefined ? { atomFingerprints: input.atomFingerprints } : {}),
    ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    ...(redacted.modelParameters !== undefined
      ? { modelParameters: redacted.modelParameters }
      : {}),
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
  });
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
