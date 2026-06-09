// Quality Intelligence drift re-check + targeted regeneration routes (Epic #735, Issue #743).
//
// NOTE on "current sources": The original run's START request sources are NOT persisted in the
// manifest. Therefore re-check and regenerate-stale both require the sources to be re-supplied
// by the caller. Both routes are POST to carry the sources in the body; the GET verb is avoided
// because sources can be arbitrarily large.
//
//   POST /api/quality-intelligence/runs/:id/re-check
//     Body: { sources: QualityIntelligenceInlineSource[] }
//     Returns: QualityIntelligenceUiStalenessReport
//
//   POST /api/quality-intelligence/runs/:id/regenerate-stale
//     Body: { sources: QualityIntelligenceInlineSource[] }
//     Returns: { runId: string; regeneratedCount: number; preservedCount: number }
//
// Both routes go through the central CSRF guard in server.ts (all POSTs do).

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import type {
  QualityIntelligenceCapsuleSource,
  QualityIntelligenceInlineSource,
} from "@oscharko-dev/keiko-contracts";

type QiTestCaseCandidate = QualityIntelligence.QualityIntelligenceTestCaseCandidate;
type QiRunPlan = QualityIntelligence.QualityIntelligenceRunPlan;
import {
  loadQualityIntelligenceRun,
  loadQualityIntelligenceCandidates,
  recordQualityIntelligenceCandidates,
  createNodeQualityIntelligenceLocalStore,
} from "@oscharko-dev/keiko-evidence";
import { compareStaleness } from "@oscharko-dev/keiko-quality-intelligence";
import { runQualityIntelligenceModelRoutedTestDesign } from "@oscharko-dev/keiko-workflows";
import type {
  QualityIntelligenceIngestedAtom,
  QualityIntelligenceModelRoutedTestDesignDeps,
} from "@oscharko-dev/keiko-workflows";
import type { RouteContext, RouteResult, RouteDefinition } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { ingestInlineSources, QiIngestionError } from "./runIngestion.js";
import { createQiGenerationPort, QiGenerationError } from "./generationPort.js";
import { createQiJudgePort } from "./judgePort.js";
import { makeCapsuleResolver } from "./capsuleAdapter.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

const errorResult = (status: number, code: string, message: string): RouteResult => ({
  status,
  body: { error: { code, message } },
});

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });

function validateCapsuleSource(
  label: string,
  raw: Record<string, unknown>,
): QualityIntelligenceCapsuleSource | undefined {
  if (typeof raw.capsuleId !== "string" || raw.capsuleId.trim().length === 0) return undefined;
  return { kind: "capsule", label, capsuleId: raw.capsuleId };
}

function validateSource(raw: unknown): QualityIntelligenceInlineSource | undefined {
  if (!isObject(raw) || typeof raw.label !== "string") return undefined;
  const label = raw.label;
  if (raw.kind === "requirements" && typeof raw.text === "string") {
    return { kind: "requirements", label, text: raw.text };
  }
  if (raw.kind === "workspace" && typeof raw.path === "string") {
    return { kind: "workspace", label, path: raw.path };
  }
  if (raw.kind === "file" && typeof raw.path === "string") {
    return { kind: "file", label, path: raw.path };
  }
  if (raw.kind === "capsule") {
    return validateCapsuleSource(label, raw);
  }
  return undefined;
}

type ParseSourcesOutcome =
  | { readonly ok: true; readonly sources: readonly QualityIntelligenceInlineSource[] }
  | { readonly ok: false; readonly result: RouteResult };

async function parseSources(req: IncomingMessage): Promise<ParseSourcesOutcome> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    return {
      ok: false,
      result: errorResult(413, "QI_BODY_TOO_LARGE", "Request body is too large."),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      result: errorResult(400, "QI_BAD_REQUEST", "Request body is not valid JSON."),
    };
  }
  if (!isObject(parsed) || !Array.isArray(parsed.sources) || parsed.sources.length === 0) {
    return {
      ok: false,
      result: errorResult(400, "QI_BAD_REQUEST", "At least one source is required."),
    };
  }
  const sources: QualityIntelligenceInlineSource[] = [];
  for (const raw_ of parsed.sources) {
    const source = validateSource(raw_);
    if (source === undefined) {
      return {
        ok: false,
        result: errorResult(400, "QI_BAD_SOURCE", "A source entry is malformed."),
      };
    }
    sources.push(source);
  }
  return { ok: true, sources };
}

function firstChatModelId(deps: UiHandlerDeps): string | undefined {
  const providers = deps.config?.providers ?? [];
  return providers[0]?.modelId;
}

function resolveChatModelId(deps: UiHandlerDeps): string | null {
  const id = firstChatModelId(deps);
  return id ?? null;
}

function buildJudgePortIfAvailable(
  deps: UiHandlerDeps,
  modelId: string,
): ReturnType<typeof createQiJudgePort> | undefined {
  try {
    return createQiJudgePort(deps, modelId);
  } catch {
    return undefined;
  }
}

type QiCandidateRow = NonNullable<
  ReturnType<typeof loadQualityIntelligenceCandidates>
>["candidates"][number];

interface DriftContext {
  readonly staleness: ReturnType<typeof compareStaleness>;
  readonly ingestion: ReturnType<typeof ingestInlineSources>;
  readonly allOldCandidates: readonly QiCandidateRow[];
  readonly evidenceRefs: readonly { envelopeId: string; atomId: string }[];
}

type DriftOutcome =
  | { readonly ok: true; readonly value: DriftContext }
  | { readonly ok: false; readonly result: RouteResult };

/**
 * Shared drift computation for both routes: parse sources, load the recorded run, re-ingest the
 * current sources, and diff their fingerprints. Pure read — loads/ingests but never writes.
 */
async function computeDrift(
  req: RouteContext["req"],
  evidenceDir: string,
  id: string,
  ingestRunId: string,
  deps: UiHandlerDeps,
): Promise<DriftOutcome> {
  const parsed = await parseSources(req);
  if (!parsed.ok) return { ok: false, result: parsed.result };
  const manifest = loadQualityIntelligenceRun(id, { evidenceDir });
  if (manifest === undefined) {
    return {
      ok: false,
      result: errorResult(404, "QI_NOT_FOUND", "Quality Intelligence run not found."),
    };
  }
  let ingestion: ReturnType<typeof ingestInlineSources>;
  try {
    ingestion = ingestInlineSources({
      request: { sources: parsed.sources },
      runId: ingestRunId,
      registeredAt: new Date().toISOString(),
      capsuleResolver: makeCapsuleResolver(deps),
    });
  } catch (error) {
    const code = error instanceof QiIngestionError ? error.code : "QI_INGESTION_FAILED";
    const message = error instanceof QiIngestionError ? error.message : "Source ingestion failed.";
    return { ok: false, result: errorResult(400, code, message) };
  }
  const allOldCandidates = loadQualityIntelligenceCandidates(id, { evidenceDir })?.candidates ?? [];
  const evidenceRefs = manifest.evidenceRefs.map((r) => ({
    envelopeId: r.envelopeId,
    atomId: r.atomId,
  }));
  const staleness = compareStaleness({
    oldFingerprints: manifest.sourceFingerprints ?? [],
    evidenceRefs,
    candidates: allOldCandidates.map((c) => ({
      id: c.id,
      derivedFromAtomIds: c.derivedFromAtomIds,
    })),
    currentFingerprints: ingestion.envelopes.map((e) => ({
      envelopeId: String(e.id),
      integrityHashSha256Hex: e.provenance.integrityHashSha256Hex,
    })),
  });
  return { ok: true, value: { staleness, ingestion, allOldCandidates, evidenceRefs } };
}

/** Narrow the freshly-ingested atoms to only those whose source envelope backs a stale candidate. */
function narrowStaleAtoms(drift: DriftContext): {
  readonly staleIds: ReadonlySet<string>;
  readonly narrowedAtoms: QualityIntelligenceIngestedAtom[];
} {
  const { staleness, allOldCandidates, evidenceRefs, ingestion } = drift;
  const staleIds = new Set<string>([
    ...staleness.changedStale.map((r) => r.candidateId),
    ...staleness.orphanedStale.map((r) => r.candidateId),
  ]);
  const staleAtomIds = new Set<string>();
  for (const c of allOldCandidates) {
    if (staleIds.has(c.id)) {
      for (const atomId of c.derivedFromAtomIds) staleAtomIds.add(atomId);
    }
  }
  const atomToEnvelope = new Map(evidenceRefs.map((r) => [r.atomId, r.envelopeId]));
  const staleEnvelopeIds = new Set<string>();
  for (const atomId of staleAtomIds) {
    const envelopeId = atomToEnvelope.get(atomId);
    if (envelopeId !== undefined) staleEnvelopeIds.add(envelopeId);
  }
  const narrowedAtoms = ingestion.ingestedAtoms.filter((a) =>
    staleEnvelopeIds.has(String(a.atom.sourceEnvelopeId)),
  );
  return { staleIds, narrowedAtoms };
}

type RegenOutcome =
  | { readonly ok: true; readonly candidates: readonly QiTestCaseCandidate[] }
  | { readonly ok: false; readonly result: RouteResult };

/** Build the workflow deps for a scoped regeneration; `capture` receives the generated candidates. */
function regenWorkflowDeps(
  deps: UiHandlerDeps,
  modelId: string,
  evidenceDir: string,
  newRunId: string,
  capture: (cands: readonly QiTestCaseCandidate[]) => void,
): QualityIntelligenceModelRoutedTestDesignDeps {
  return {
    sink: { emit: () => undefined },
    evidenceStore: createNodeQualityIntelligenceLocalStore(evidenceDir),
    candidatesSink: {
      record: (cands, generatedAt): void => {
        capture(cands);
        recordQualityIntelligenceCandidates({
          runId: newRunId,
          generatedAt,
          candidates: cands,
          evidenceDir,
          redact: deps.redactor,
        });
      },
    },
    generate: createQiGenerationPort(deps, modelId),
    judge: buildJudgePortIfAvailable(deps, modelId),
  };
}

/** Run the model-routed workflow for the narrowed atoms and persist a NEW immutable run. */
async function runScopedAndPersist(args: {
  readonly deps: UiHandlerDeps;
  readonly modelId: string;
  readonly evidenceDir: string;
  readonly newRunId: string;
  readonly ingestion: ReturnType<typeof ingestInlineSources>;
  readonly atomsToRegen: readonly QualityIntelligenceIngestedAtom[];
}): Promise<RegenOutcome> {
  const { deps, modelId, evidenceDir, newRunId, ingestion, atomsToRegen } = args;
  let regenerated: readonly QiTestCaseCandidate[] = [];
  const plan: QiRunPlan = {
    id: QualityIntelligence.asQualityIntelligenceRunId(newRunId),
    requestedAt: new Date().toISOString(),
    plannerKind: "model-routed",
    stages: [],
  };
  try {
    const summary = await runQualityIntelligenceModelRoutedTestDesign(
      {
        plan,
        envelopes: ingestion.envelopes,
        ingestedAtoms: atomsToRegen,
        provenanceRefs: ingestion.provenanceRefs,
      },
      regenWorkflowDeps(deps, modelId, evidenceDir, newRunId, (cands) => {
        regenerated = [...cands];
      }),
    );
    if (summary.status !== "succeeded") {
      return {
        ok: false,
        result: errorResult(500, "QI_REGEN_FAILED", "Scoped regeneration did not succeed."),
      };
    }
  } catch (error) {
    const code = error instanceof QiGenerationError ? error.code : "QI_REGEN_FAILED";
    const message =
      error instanceof QiGenerationError ? error.message : "Scoped regeneration failed.";
    return { ok: false, result: errorResult(500, code, message) };
  }
  return { ok: true, candidates: regenerated };
}

async function regenerateFromDrift(args: {
  readonly deps: UiHandlerDeps;
  readonly id: string;
  readonly evidenceDir: string;
  readonly newRunId: string;
  readonly drift: DriftContext;
}): Promise<RouteResult> {
  const { deps, id, evidenceDir, newRunId, drift } = args;
  const { ingestion, allOldCandidates } = drift;
  const { staleIds, narrowedAtoms } = narrowStaleAtoms(drift);

  if (narrowedAtoms.length === 0 && staleIds.size === 0) {
    return {
      status: 200,
      body: { runId: id, regeneratedCount: 0, preservedCount: allOldCandidates.length },
    };
  }

  const modelId = resolveChatModelId(deps);
  if (modelId === null) {
    return errorResult(400, "QI_NO_MODEL", "No chat model is configured.");
  }
  const atomsToRegen = narrowedAtoms.length > 0 ? narrowedAtoms : ingestion.ingestedAtoms.slice(0, 1);
  const outcome = await runScopedAndPersist({
    deps,
    modelId,
    evidenceDir,
    newRunId,
    ingestion,
    atomsToRegen,
  });
  if (!outcome.ok) return outcome.result;

  const preservedCount = allOldCandidates.filter((candidate) => !staleIds.has(candidate.id)).length;
  return {
    status: 200,
    body: { runId: newRunId, regeneratedCount: outcome.candidates.length, preservedCount },
  };
}

/**
 * POST /api/quality-intelligence/runs/:id/re-check
 * Body: { sources: QualityIntelligenceInlineSource[] }
 *
 * Re-ingests the supplied sources, compares fingerprints against the stored manifest, and returns
 * the staleness report. Pure read — never writes or overwrites any artifact.
 */
export async function handleQiReCheck(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const { id } = ctx.params;
  if (id === undefined || id.trim().length === 0) {
    return errorResult(400, "QI_BAD_REQUEST", "Run id is required.");
  }
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined) {
    return errorResult(500, "QI_NO_EVIDENCE_DIR", "The evidence directory is not configured.");
  }
  try {
    const drift = await computeDrift(ctx.req, evidenceDir, id, `qi-recheck-${id}`, deps);
    if (!drift.ok) return drift.result;
    const { staleness } = drift.value;
    return {
      status: 200,
      body: {
        runId: id,
        staleCount: staleness.changedStale.length + staleness.orphanedStale.length,
        fresh: staleness.fresh,
        changedStale: staleness.changedStale,
        orphanedStale: staleness.orphanedStale,
      },
    };
  } catch {
    return errorResult(
      500,
      "QI_RECHECK_FAILED",
      "Failed to inspect the current sources for drift.",
    );
  }
}

/**
 * POST /api/quality-intelligence/runs/:id/regenerate-stale
 * Body: { sources: QualityIntelligenceInlineSource[] }
 *
 * Re-ingests sources, identifies stale candidates via compareStaleness, narrows the ingested atoms
 * to only those belonging to stale candidates, invokes the model-routed workflow with the narrowed
 * subset and a NEW runId, merges fresh-old candidates + regenerated candidates, persists the new
 * manifest + new candidates artifact under the NEW runId. The original runId artifacts are NEVER
 * re-written (immutability guarantee).
 */
export async function handleQiRegenerateStale(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const { id } = ctx.params;
  if (id === undefined || id.trim().length === 0) {
    return errorResult(400, "QI_BAD_REQUEST", "Run id is required.");
  }
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined) {
    return errorResult(500, "QI_NO_EVIDENCE_DIR", "The evidence directory is not configured.");
  }
  const newRunId = `qi-run-${randomUUID()}`;
  try {
    const drift = await computeDrift(ctx.req, evidenceDir, id, newRunId, deps);
    if (!drift.ok) return drift.result;
    return await regenerateFromDrift({ deps, id, evidenceDir, newRunId, drift: drift.value });
  } catch {
    return errorResult(500, "QI_REGEN_FAILED", "Failed to regenerate stale candidates.");
  }
}

export const QI_RECHECK_ROUTE_GROUP: readonly RouteDefinition[] = [
  {
    method: "POST",
    pattern: "/api/quality-intelligence/runs/:id/re-check",
    handler: handleQiReCheck,
  },
  {
    method: "POST",
    pattern: "/api/quality-intelligence/runs/:id/regenerate-stale",
    handler: handleQiRegenerateStale,
  },
];
