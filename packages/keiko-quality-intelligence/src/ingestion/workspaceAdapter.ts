// Quality Intelligence — Workspace adapter (Epic #270, Issue #278).
//
// Pure adapter that converts a `ContextPack` from @oscharko-dev/keiko-workspace into a
// `QualityIntelligenceRepositoryContextEnvelope` (kind: "repository-context") suitable
// for QI ingestion. The QI pure-domain package is locked down (ADR-0019 rule 10a) to
// `keiko-contracts` and `keiko-security` only, so this adapter consumes the workspace
// contract types via their re-export from @oscharko-dev/keiko-contracts (workspace.ts).
//
// Why this is safe:
//   * Path containment stays in @oscharko-dev/keiko-workspace at construction time.
//   * The adapter accepts only the already-redacted `ContextPack` and carries only
//     workspace-relative refs into the envelope. Absolute paths and `..` segments are
//     rejected with a typed `WorkspaceAdapterError` so a caller cannot smuggle an
//     out-of-workspace ref through the contract surface.
//   * The envelope `integrityHashSha256Hex` is computed by the caller (the workspace
//     adapter declines to import @oscharko-dev/keiko-security to avoid pulling a hashing
//     primitive into the QI ingestion sub-namespace; callers compute the digest in the
//     keiko-workspace consumer and pass it in).
//
// Structurally inspired by Test Intelligence reference (TI) repo-context adapters, but
// the envelope shape is anchored on the QI contracts.

import type { ContextEntry, ContextPack } from "@oscharko-dev/keiko-contracts";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

import { planSourceMix, type SourceMixPlan } from "./sourceMixPlanning.js";

type RepoEnvelope = QualityIntelligence.QualityIntelligenceRepositoryContextEnvelope;
const { asQualityIntelligenceSourceEnvelopeId } = QualityIntelligence;

export type WorkspaceAdapterErrorCode =
  | "ABSOLUTE_PATH"
  | "PATH_TRAVERSAL"
  | "EMPTY_PATH"
  | "INVALID_INTEGRITY_HASH"
  | "INVALID_REGISTERED_AT";

export class WorkspaceAdapterError extends Error {
  public readonly code: WorkspaceAdapterErrorCode;
  constructor(code: WorkspaceAdapterErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "WorkspaceAdapterError";
    this.code = code;
  }
}

const HEX64 = /^[0-9a-f]{64}$/u;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

const assertRelativePath = (path: string): void => {
  if (path.length === 0) {
    throw new WorkspaceAdapterError("EMPTY_PATH", "Context entry path is empty");
  }
  // Absolute path on POSIX or Windows drive-style ("C:\…" / "C:/…").
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path)) {
    throw new WorkspaceAdapterError(
      "ABSOLUTE_PATH",
      `Context entry path must be workspace-relative; got "${path}"`,
    );
  }
  // Reject any `..` segment regardless of separator.
  const segments = path.split(/[\\/]/u);
  if (segments.some((s) => s === "..")) {
    throw new WorkspaceAdapterError(
      "PATH_TRAVERSAL",
      `Context entry path contains a ".." segment: "${path}"`,
    );
  }
};

const assertHash = (hash: string): void => {
  if (!HEX64.test(hash)) {
    throw new WorkspaceAdapterError(
      "INVALID_INTEGRITY_HASH",
      "integrityHashSha256Hex must be 64 lowercase hex chars",
    );
  }
};

const assertRegisteredAt = (timestamp: string): void => {
  if (!ISO_8601.test(timestamp)) {
    throw new WorkspaceAdapterError(
      "INVALID_REGISTERED_AT",
      "registeredAt must be ISO 8601 UTC (e.g. 2026-06-05T00:00:00Z)",
    );
  }
};

const buildLocalRef = (entry: ContextEntry): string => {
  assertRelativePath(entry.path);
  return entry.path;
};

const buildDisplayLabel = (rootLabel: string, entry: ContextEntry): string => {
  const base = `${rootLabel}:${entry.path}`;
  // The envelope itself caps display labels at 256; we trim here so the consumer
  // never has to discard an otherwise valid envelope.
  if (base.length <= 256) return base;
  return `${base.slice(0, 253)}...`;
};

export interface BuildWorkspaceEnvelopesInput {
  /**
   * Display-only label naming the workspace (e.g. "main", "feature/foo"). Not a path,
   * not a URL; carried only into envelope `displayLabel` and `provenance.origin`.
   */
  readonly workspaceLabel: string;
  /**
   * ISO 8601 UTC timestamp the consumer captured when assembling the pack. The QI
   * ingestion sub-namespace deliberately refuses to read the clock so callers stay
   * deterministic.
   */
  readonly registeredAt: string;
  readonly contextPack: ContextPack;
  /**
   * Caller-supplied SHA-256 hex digest table keyed by the context-entry path. The
   * adapter rejects any entry without a matching digest with `INVALID_INTEGRITY_HASH`.
   */
  readonly integrityHashByEntryPath: Readonly<Record<string, string>>;
  /**
   * Optional id-prefix the caller pre-allocates (e.g. "qi-src-ws-1234"). Each envelope's
   * id is `${idPrefix}:${entry.path}`; the contract validator (asQualityIntelligence-
   * SourceEnvelopeId) rejects forbidden fragments — callers must pre-validate the
   * prefix.
   */
  readonly idPrefix: string;
}

/**
 * Convert a workspace `ContextPack` into a list of repository-context source envelopes,
 * one per context entry. Pure, no IO.
 *
 * Rejects:
 *   * absolute paths or paths containing `..` segments
 *   * missing or non-hex-64 integrity hashes
 *   * malformed `registeredAt` timestamps
 */
export const buildWorkspaceSourceEnvelopes = (
  input: BuildWorkspaceEnvelopesInput,
): readonly RepoEnvelope[] => {
  assertRegisteredAt(input.registeredAt);
  const envelopes: RepoEnvelope[] = [];
  for (const entry of input.contextPack.selected) {
    const localRef = buildLocalRef(entry);
    const hash = input.integrityHashByEntryPath[entry.path];
    if (typeof hash !== "string") {
      throw new WorkspaceAdapterError(
        "INVALID_INTEGRITY_HASH",
        `No integrity hash supplied for entry "${entry.path}"`,
      );
    }
    assertHash(hash);
    const id = asQualityIntelligenceSourceEnvelopeId(`${input.idPrefix}:${entry.path}`);
    envelopes.push({
      id,
      kind: "repository-context",
      displayLabel: buildDisplayLabel(input.workspaceLabel, entry),
      provenance: {
        origin: `workspace:${input.workspaceLabel}`,
        registeredAt: input.registeredAt,
        integrityHashSha256Hex: hash,
      },
      localRef,
    });
  }
  return envelopes;
};

/**
 * Convenience: build envelopes AND run the deterministic mix planner so the consumer
 * gets the policy-ordered planner output in a single call. Pure.
 */
export const workspaceSourceMixPolicy = (
  input: BuildWorkspaceEnvelopesInput,
): {
  readonly envelopes: readonly RepoEnvelope[];
  readonly plan: SourceMixPlan;
} => {
  const envelopes = buildWorkspaceSourceEnvelopes(input);
  const plan = planSourceMix(envelopes);
  return { envelopes, plan };
};
