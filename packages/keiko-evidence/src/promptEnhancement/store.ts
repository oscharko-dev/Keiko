// Local-state store for Prompt Enhancement runs (Epic #1307, Issue #1313; ADR-0044 §1/§5).
//
// Extends the existing `keiko-evidence` JSON-on-disk discipline (ADR-0023 D7 "extend, don't fork"),
// mirroring the Quality Intelligence store: each run is persisted as one schema-validated JSON file
// `<runId>.pe.json` under a `pe/` subdirectory of the evidence base dir, kept separate from the
// run-level evidence manifests and the QI sub-manifests.
//
// The record path is record → redact → hash → validate → write:
//   1. every free-text leaf is passed through the security redactor (redaction by construction);
//   2. per-group SHA-256 integrity hashes are computed over the redacted groups;
//   3. the (totals, collection-length) invariant is asserted;
//   4. the manifest is written atomically (O_EXCL temp + rename) inside a realpath-contained base dir.
// On read the schema gate, the totals invariant, and the integrity hashes are all re-checked, so a
// tampered or corrupt manifest fails closed.

import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveWithinWorkspace, type WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { assertValidRunId, sha256Hex } from "@oscharko-dev/keiko-security";
import type { GroundingDirective } from "@oscharko-dev/keiko-contracts";
import { replaceViaDurableTempFile } from "../durable-write.js";
import { EvidenceReadError, EvidenceWriteError } from "../errors.js";
import { existingOwnedDirectory, prepareOwnedDirectory } from "../fs-safety.js";
import {
  PROMPT_ENHANCEMENT_EVIDENCE_SCHEMA_VERSION,
  validatePromptEnhancementEvidenceManifest,
  type PromptEnhancementCandidateScoreRow,
  type PromptEnhancementEvidenceManifest,
  type PromptEnhancementEvidenceStatus,
  type PromptEnhancementIntegrityHashes,
  type PromptEnhancementModelMetadata,
  type PromptEnhancementSafetyRecord,
} from "./manifestSchema.js";
import {
  redactPromptEnhancementEvidence,
  type PromptEnhancementRedactionOptions,
} from "./redaction.js";

// `pe/` subdir of the evidence base; chosen so `listEvidence()` and the QI `list()` never see Prompt
// Enhancement manifests by accident — different layer, different shape.
export const PE_SUBDIR = "pe";

const PE_MANIFEST_SUFFIX = ".pe.json";
const PE_DIR_MODE = 0o700;
const DEFAULT_INPUT_EXCERPT_MAX_CHARS = 2_000;

// ─── Builder input ───────────────────────────────────────────────────────────────────
export interface PromptEnhancementRecordInput {
  readonly runId: string;
  readonly recordedAt: string;
  readonly requestId: string;
  readonly status: PromptEnhancementEvidenceStatus;
  // The original, untrusted user input. Represented in evidence as a SHA-256 fingerprint plus a
  // redacted, truncated excerpt.
  readonly originalInput: string;
  readonly inputExcerptMaxChars?: number | undefined;
  readonly enhancedPromptId: string;
  // The rendered enhanced prompt (redacted before persist).
  readonly enhancedPromptText: string;
  readonly appliedSafetyRules: readonly string[];
  readonly appliedGroundingDirectives: readonly GroundingDirective[];
  readonly assumptions: readonly string[];
  readonly candidateScores: readonly PromptEnhancementCandidateScoreRow[];
  readonly safety: PromptEnhancementSafetyRecord;
  readonly modelMetadata: PromptEnhancementModelMetadata;
}

export interface PromptEnhancementRecordOptions {
  readonly store?: PromptEnhancementLocalStore | undefined;
  readonly evidenceDir?: string | undefined;
  readonly redaction?: PromptEnhancementRedactionOptions | undefined;
}

export interface PromptEnhancementRecordResult {
  readonly manifest: PromptEnhancementEvidenceManifest;
  readonly location: string;
}

function sha256OfJson(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
}

type PromptEnhancementEvidenceManifestWithoutHashes = Omit<
  PromptEnhancementEvidenceManifest,
  "integrityHashes"
>;

function buildIntegrityHashes(
  enhancedOutput: {
    readonly enhancedPromptId: string;
    readonly enhancedPromptTextRedacted: string;
  },
  appliedRules: {
    readonly appliedSafetyRules: readonly string[];
    readonly appliedGroundingDirectives: readonly GroundingDirective[];
    readonly assumptions: readonly string[];
  },
  candidateScores: readonly PromptEnhancementCandidateScoreRow[],
  record: PromptEnhancementEvidenceManifestWithoutHashes,
): PromptEnhancementIntegrityHashes {
  return {
    enhancedOutput: sha256OfJson(enhancedOutput),
    appliedRules: sha256OfJson(appliedRules),
    candidateScores: sha256OfJson(candidateScores),
    record: sha256OfJson(record),
  };
}

function buildManifestIntegrityHashes(
  manifest: PromptEnhancementEvidenceManifestWithoutHashes,
): PromptEnhancementIntegrityHashes {
  return buildIntegrityHashes(
    {
      enhancedPromptId: manifest.enhancedPromptId,
      enhancedPromptTextRedacted: manifest.enhancedPromptTextRedacted,
    },
    {
      appliedSafetyRules: manifest.appliedSafetyRules,
      appliedGroundingDirectives: manifest.appliedGroundingDirectives,
      assumptions: manifest.assumptions,
    },
    manifest.candidateScores,
    manifest,
  );
}

function withoutIntegrityHashes(
  manifest: PromptEnhancementEvidenceManifest,
): PromptEnhancementEvidenceManifestWithoutHashes {
  const record = { ...manifest } as {
    integrityHashes?: PromptEnhancementEvidenceManifest["integrityHashes"];
  } & PromptEnhancementEvidenceManifestWithoutHashes;
  delete record.integrityHashes;
  return record;
}

function withRecomputedIntegrityHashes(
  manifest: PromptEnhancementEvidenceManifestWithoutHashes,
): PromptEnhancementEvidenceManifest {
  return { ...manifest, integrityHashes: buildManifestIntegrityHashes(manifest) };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * Build a redacted, hashed Prompt Enhancement evidence manifest from a run record. Pure: no IO, no
 * clock, no randomness (the caller supplies `recordedAt` and `runId`). Redacts every free-text leaf,
 * computes per-group SHA-256 integrity hashes over the redacted groups, and stamps the totals. The
 * result always passes {@link validatePromptEnhancementEvidenceManifest} and the on-read integrity
 * assertions.
 */
interface RedactedTextFields {
  readonly originalInputRedacted: string;
  readonly inputExcerptRedacted: string;
  readonly enhancedPromptTextRedacted: string;
  readonly appliedSafetyRules: readonly string[];
  readonly assumptions: readonly string[];
  readonly modelMetadata: PromptEnhancementModelMetadata;
}

function assembleManifest(
  input: PromptEnhancementRecordInput,
  redacted: RedactedTextFields,
  summary: PromptEnhancementEvidenceManifest["redactionSummary"],
  inputRedactedFingerprintSha256: string,
): PromptEnhancementEvidenceManifest {
  const manifestWithoutHashes: PromptEnhancementEvidenceManifestWithoutHashes = {
    peEvidenceSchemaVersion: PROMPT_ENHANCEMENT_EVIDENCE_SCHEMA_VERSION,
    runId: input.runId,
    recordedAt: input.recordedAt,
    requestId: input.requestId,
    status: input.status,
    inputRedactedFingerprintSha256,
    inputExcerptRedacted: redacted.inputExcerptRedacted,
    enhancedPromptId: input.enhancedPromptId,
    enhancedPromptTextRedacted: redacted.enhancedPromptTextRedacted,
    appliedSafetyRules: redacted.appliedSafetyRules,
    appliedGroundingDirectives: input.appliedGroundingDirectives,
    assumptions: redacted.assumptions,
    candidateScores: input.candidateScores,
    safety: input.safety,
    modelMetadata: redacted.modelMetadata,
    redactionSummary: summary,
    totals: {
      candidateScores: input.candidateScores.length,
      appliedSafetyRules: redacted.appliedSafetyRules.length,
      assumptions: redacted.assumptions.length,
      safetyFindings: input.safety.findingCodes.length,
    },
  };
  return withRecomputedIntegrityHashes(manifestWithoutHashes);
}

export function buildPromptEnhancementEvidenceManifest(
  input: PromptEnhancementRecordInput,
  redaction: PromptEnhancementRedactionOptions = {},
): { readonly manifest: PromptEnhancementEvidenceManifest } {
  assertValidRunId(input.runId);
  const excerptMax = input.inputExcerptMaxChars ?? DEFAULT_INPUT_EXCERPT_MAX_CHARS;
  // Redact every free-text leaf BEFORE assembly or hashing (redaction by construction). Ids, enums,
  // and numbers (runId, requestId, candidate ids/profiles, scores, finding codes) carry no free text
  // and stay outside the redactor — matching the QI store's redaction scope.
  const { redacted, summary } = redactPromptEnhancementEvidence(
    {
      originalInputRedacted: input.originalInput,
      inputExcerptRedacted: "",
      enhancedPromptTextRedacted: input.enhancedPromptText,
      appliedSafetyRules: input.appliedSafetyRules,
      assumptions: input.assumptions,
      modelMetadata: input.modelMetadata,
    },
    redaction,
  );
  const inputExcerptRedacted = truncate(redacted.originalInputRedacted, excerptMax);
  const inputRedactedFingerprintSha256 = sha256Hex(redacted.originalInputRedacted);
  const manifest = assembleManifest(
    input,
    { ...redacted, inputExcerptRedacted },
    summary,
    inputRedactedFingerprintSha256,
  );
  assertManifestWriteReady(manifest);
  return { manifest };
}

function foldRedactionSummary(
  base: PromptEnhancementEvidenceManifest["redactionSummary"],
  add: PromptEnhancementEvidenceManifest["redactionSummary"],
): PromptEnhancementEvidenceManifest["redactionSummary"] {
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

function assertManifestWriteReady(manifest: PromptEnhancementEvidenceManifest): void {
  const validation = validatePromptEnhancementEvidenceManifest(manifest);
  if (!validation.ok) {
    throw new EvidenceWriteError(`PE manifest schema invalid: ${validation.reason ?? "unknown"}`);
  }
  try {
    assertManifestIntegrity(manifest);
  } catch (error) {
    throw new EvidenceWriteError(
      error instanceof Error ? error.message : "PE manifest integrity invalid",
    );
  }
}

function sanitizeManifestForPersistence(
  manifest: PromptEnhancementEvidenceManifest,
): PromptEnhancementEvidenceManifest {
  assertValidRunId(manifest.runId);
  const { redacted, summary } = redactPromptEnhancementEvidence(withoutIntegrityHashes(manifest));
  const redactionSummary =
    summary.stringsRedacted > 0
      ? foldRedactionSummary(redacted.redactionSummary, summary)
      : redacted.redactionSummary;
  const sanitized = withRecomputedIntegrityHashes({ ...redacted, redactionSummary });
  assertManifestWriteReady(sanitized);
  return sanitized;
}

// ─── Port ──────────────────────────────────────────────────────────────────────────
export interface PromptEnhancementLocalStore {
  readonly record: (manifest: PromptEnhancementEvidenceManifest) => string;
  readonly load: (runId: string) => PromptEnhancementEvidenceManifest | undefined;
  readonly list: () => readonly string[];
  readonly location: (runId: string) => string;
  readonly delete: (runId: string) => boolean;
}

// ─── In-memory store (tests + future port-injected callers) ─────────────────────────
export function createInMemoryPromptEnhancementLocalStore(): PromptEnhancementLocalStore {
  const data = new Map<string, PromptEnhancementEvidenceManifest>();
  return {
    record: (manifest: PromptEnhancementEvidenceManifest): string => {
      const sanitized = sanitizeManifestForPersistence(manifest);
      data.set(sanitized.runId, sanitized);
      return `${sanitized.runId}${PE_MANIFEST_SUFFIX}`;
    },
    load: (runId: string): PromptEnhancementEvidenceManifest | undefined => {
      assertValidRunId(runId);
      const manifest = data.get(runId);
      return manifest === undefined
        ? undefined
        : parseAndValidateManifest(JSON.stringify(manifest));
    },
    list: (): readonly string[] => [...data.keys()].sort(),
    location: (runId: string): string => {
      assertValidRunId(runId);
      return `${runId}${PE_MANIFEST_SUFFIX}`;
    },
    delete: (runId: string): boolean => {
      assertValidRunId(runId);
      return data.delete(runId);
    },
  };
}

// ─── Integrity assertions (on read) ──────────────────────────────────────────────────
function assertHashMatches(label: string, expected: string, stored: string): void {
  if (expected !== stored) {
    throw new EvidenceReadError(`PE manifest ${label} integrity hash mismatch`);
  }
}

function assertManifestIntegrity(manifest: PromptEnhancementEvidenceManifest): void {
  const expectations: readonly [string, number, number][] = [
    ["candidateScores", manifest.totals.candidateScores, manifest.candidateScores.length],
    ["appliedSafetyRules", manifest.totals.appliedSafetyRules, manifest.appliedSafetyRules.length],
    ["assumptions", manifest.totals.assumptions, manifest.assumptions.length],
    ["safetyFindings", manifest.totals.safetyFindings, manifest.safety.findingCodes.length],
  ];
  for (const [label, total, length] of expectations) {
    if (total !== length) {
      throw new EvidenceReadError(
        `PE manifest totals.${label} (${String(total)}) does not match collection length (${String(length)})`,
      );
    }
  }
  const expected = buildManifestIntegrityHashes(withoutIntegrityHashes(manifest));
  assertHashMatches(
    "enhancedOutput",
    expected.enhancedOutput,
    manifest.integrityHashes.enhancedOutput,
  );
  assertHashMatches("appliedRules", expected.appliedRules, manifest.integrityHashes.appliedRules);
  assertHashMatches(
    "candidateScores",
    expected.candidateScores,
    manifest.integrityHashes.candidateScores,
  );
  assertHashMatches("record", expected.record, manifest.integrityHashes.record);
}

function parseAndValidateManifest(json: string): PromptEnhancementEvidenceManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new EvidenceReadError(
      `PE manifest is not valid JSON: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  const validation = validatePromptEnhancementEvidenceManifest(parsed);
  if (!validation.ok) {
    throw new EvidenceReadError(`PE manifest schema invalid: ${validation.reason ?? "unknown"}`);
  }
  const manifest = parsed as PromptEnhancementEvidenceManifest;
  assertManifestIntegrity(manifest);
  return manifest;
}

// ─── Node adapter ──────────────────────────────────────────────────────────────────
function prepareBaseDir(baseDir: string, fs: WorkspaceFs): string {
  return prepareOwnedDirectory(baseDir, fs, "PE evidence directory", { mode: PE_DIR_MODE });
}

function existingBaseDir(baseDir: string, fs: WorkspaceFs): string | undefined {
  return existingOwnedDirectory(baseDir, fs, "PE evidence directory");
}

function lexicalManifestPath(runId: string, realBase: string): string {
  assertValidRunId(runId);
  return resolveWithinWorkspace(realBase, `${runId}${PE_MANIFEST_SUFFIX}`);
}

function isManifestName(name: string): boolean {
  if (!name.endsWith(PE_MANIFEST_SUFFIX)) {
    return false;
  }
  const runId = name.slice(0, name.length - PE_MANIFEST_SUFFIX.length);
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
      `cannot inspect PE manifest: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function assertWritableManifestEntry(target: string, fs: WorkspaceFs): void {
  const entry = lstatSync(target, { throwIfNoEntry: false });
  if (entry === undefined) return;
  if (!entry.isFile() || !isSingleLinkRegularFile(target, fs)) {
    throw new EvidenceWriteError("cannot overwrite a non-ledger PE manifest");
  }
}

function listRunIds(realBase: string, fs: WorkspaceFs): readonly string[] {
  const runIds: string[] = [];
  try {
    for (const entry of readdirSync(realBase, { withFileTypes: true })) {
      if (
        entry.isSymbolicLink() ||
        !entry.isFile() ||
        !isManifestName(entry.name) ||
        !isSingleLinkRegularFile(join(realBase, entry.name), fs)
      ) {
        continue;
      }
      runIds.push(entry.name.slice(0, entry.name.length - PE_MANIFEST_SUFFIX.length));
    }
  } catch (error) {
    throw new EvidenceReadError(
      `cannot list PE manifests: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  return runIds.sort();
}

function atomicWriteManifest(target: string, json: string, randomSuffix: () => string): void {
  const temp = `${target}.${randomSuffix()}.tmp`;
  try {
    replaceViaDurableTempFile(target, temp, json);
  } catch (error) {
    rmSync(temp, { force: true });
    throw new EvidenceWriteError(
      `PE manifest write failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function recordManifest(
  baseDir: string,
  fs: WorkspaceFs,
  randomSuffix: () => string,
  manifest: PromptEnhancementEvidenceManifest,
): string {
  const sanitized = sanitizeManifestForPersistence(manifest);
  const realBase = prepareBaseDir(baseDir, fs);
  const target = lexicalManifestPath(sanitized.runId, realBase);
  assertWritableManifestEntry(target, fs);
  atomicWriteManifest(target, JSON.stringify(sanitized), randomSuffix);
  return target;
}

function loadManifest(
  baseDir: string,
  fs: WorkspaceFs,
  runId: string,
): PromptEnhancementEvidenceManifest | undefined {
  assertValidRunId(runId);
  const realBase = existingBaseDir(baseDir, fs);
  if (realBase === undefined) {
    return undefined;
  }
  const target = join(realBase, `${runId}${PE_MANIFEST_SUFFIX}`);
  try {
    if (lstatSync(target, { throwIfNoEntry: false })?.isFile() !== true) {
      return undefined;
    }
    if (!isSingleLinkRegularFile(target, fs)) {
      return undefined;
    }
    return parseAndValidateManifest(readFileSync(target, "utf8"));
  } catch (error) {
    if (error instanceof EvidenceReadError) {
      throw error;
    }
    throw new EvidenceReadError(
      `cannot read PE manifest: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function deleteManifest(baseDir: string, fs: WorkspaceFs, runId: string): boolean {
  assertValidRunId(runId);
  const realBase = existingBaseDir(baseDir, fs);
  if (realBase === undefined) {
    return false;
  }
  const target = lexicalManifestPath(runId, realBase);
  if (lstatSync(target, { throwIfNoEntry: false })?.isFile() !== true) {
    return false;
  }
  if (!isSingleLinkRegularFile(target, fs)) {
    return false;
  }
  rmSync(target, { force: true });
  return true;
}

export interface PromptEnhancementNodeStoreOptions {
  readonly fs?: WorkspaceFs;
  readonly randomSuffix?: () => string;
}

/**
 * Build a Prompt Enhancement store that writes under `<evidenceDir>/pe/`. The caller passes the SAME
 * evidence dir it would pass to `createNodeEvidenceStore`; the store layers the `pe/` subdir itself.
 */
export function createNodePromptEnhancementLocalStore(
  evidenceDir: string,
  options: PromptEnhancementNodeStoreOptions = {},
): PromptEnhancementLocalStore {
  const baseDir = join(evidenceDir, PE_SUBDIR);
  const fs = options.fs ?? nodeWorkspaceFs;
  const randomSuffix = options.randomSuffix ?? randomUUID;
  return {
    record: (manifest: PromptEnhancementEvidenceManifest): string =>
      recordManifest(baseDir, fs, randomSuffix, manifest),
    load: (runId: string): PromptEnhancementEvidenceManifest | undefined =>
      loadManifest(baseDir, fs, runId),
    list: (): readonly string[] => {
      const realBase = existingBaseDir(baseDir, fs);
      return realBase === undefined ? [] : listRunIds(realBase, fs);
    },
    location: (runId: string): string => {
      assertValidRunId(runId);
      const realBase = existingBaseDir(baseDir, fs);
      return realBase === undefined
        ? join(resolve(baseDir), `${runId}${PE_MANIFEST_SUFFIX}`)
        : lexicalManifestPath(runId, realBase);
    },
    delete: (runId: string): boolean => deleteManifest(baseDir, fs, runId),
  };
}

// ─── Public CRUD API ───────────────────────────────────────────────────────────────
function resolveStore(
  options: PromptEnhancementRecordOptions,
): PromptEnhancementLocalStore | undefined {
  if (options.store !== undefined) {
    return options.store;
  }
  if (options.evidenceDir !== undefined) {
    return createNodePromptEnhancementLocalStore(options.evidenceDir);
  }
  return undefined;
}

/**
 * Build and persist a Prompt Enhancement run record. Redacts every free-text leaf, hashes the redacted
 * groups, validates the totals invariant, then writes the manifest through the resolved store. The
 * store is supplied via `options.store` (explicit, e.g. in-memory for tests) or `options.evidenceDir`
 * (resolve to a node adapter); one MUST be provided.
 */
export function recordPromptEnhancementRun(
  input: PromptEnhancementRecordInput,
  options: PromptEnhancementRecordOptions = {},
): PromptEnhancementRecordResult {
  const store = resolveStore(options);
  if (store === undefined) {
    throw new EvidenceWriteError(
      "recordPromptEnhancementRun requires options.store or options.evidenceDir",
    );
  }
  const { manifest } = buildPromptEnhancementEvidenceManifest(input, options.redaction ?? {});
  return { manifest, location: store.record(manifest) };
}

export interface PromptEnhancementLoadOptions {
  readonly store?: PromptEnhancementLocalStore | undefined;
  readonly evidenceDir?: string | undefined;
}

function resolveLoadStore(options: PromptEnhancementLoadOptions): PromptEnhancementLocalStore {
  if (options.store !== undefined) {
    return options.store;
  }
  if (options.evidenceDir !== undefined) {
    return createNodePromptEnhancementLocalStore(options.evidenceDir);
  }
  throw new EvidenceReadError("PE load/list requires options.store or options.evidenceDir");
}

export function loadPromptEnhancementRun(
  runId: string,
  options: PromptEnhancementLoadOptions = {},
): PromptEnhancementEvidenceManifest | undefined {
  return resolveLoadStore(options).load(runId);
}

export function listPromptEnhancementRuns(
  options: PromptEnhancementLoadOptions = {},
): readonly string[] {
  return resolveLoadStore(options).list();
}
