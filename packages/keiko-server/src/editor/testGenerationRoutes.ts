// BFF route for governed, editor-driven unit-test generation (Issue #1202, ADR-0042 D7).
//
//   POST /api/editor/test-generation — assemble governed coding context for an editor target and,
//                                      when enabled, produce a reviewable candidate test patch.
//
// Wave-2 surface, shipped switched OFF (ADR-0042 D7). Editor-driven test generation, execution, and
// verification execute untrusted, model-generated code through an assured pre-filter and are deferred
// behind a default-off feature flag enabled only once a deny-by-default network-egress boundary is
// enforced and proven by an automated test. The route therefore exposes two independent gates, both
// default-off:
//
//   Gate A — KEIKO_EDITOR_TEST_GENERATION           — surfaces the feature at all. Off (default) →
//            `disabled`: no retrieval, no model, no execution. This is the v1 behaviour.
//   Gate B — KEIKO_EDITOR_TEST_GENERATION_EXECUTION — permits producing a candidate (a governed model
//            call) once the enforced egress boundary is available. Off (default) → `deferred`: the
//            route still runs governed discovery (#1211, `purpose: "test-generation"`) for provenance
//            but makes NO model call and produces no candidate. No v1 flow executes model-generated
//            code (the assured pre-filter that EXECUTES candidates is shared with #1204/#1206 and stays
//            `not-run`; a candidate this route surfaces can only ever be `unverified`).
//
// Containment reuses the files routes' realpath resolution; the response is redacted (D9) and
// content-free apart from the reviewable patch `newText`. The browser never reaches a model directly.

import type {
  CodingContextPack,
  CodingContextRequest,
  CodingContextWirePack,
  EditorTestGenerationWireRequest,
  EditorTestGenerationWireResponse,
  EditorTestGenerationWireTarget,
} from "@oscharko-dev/keiko-contracts";
import {
  CODING_CONTEXT_BUDGETS,
  CODING_CONTEXT_SCHEMA_VERSION,
  toCodingContextWirePack,
} from "@oscharko-dev/keiko-contracts/runtime/coding-context";
import {
  EDITOR_TEST_GENERATION_SCHEMA_VERSION,
  notRunTestGenerationFunnel,
  parseEditorTestGenerationRequest,
} from "@oscharko-dev/keiko-contracts/runtime/editor-test-generation";
import { isValidScopePath } from "@oscharko-dev/keiko-contracts/runtime/connected-context";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { newCorrelationId } from "../correlation.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import { readJsonObject, resolveRequestRoot, runFilesHandler } from "../files.js";
import { assembleCodingContext } from "./codingContext.js";
import { recordCodingContextEvidence } from "./codingContextEvidence.js";
import { clientAbortSignal, resolveOverlayPath } from "./languageRoutes.js";
import { recordTestGenerationEvidence } from "./testGenerationEvidence.js";
import {
  defaultTestGenerationRunner,
  type TestGenerationRunner,
  type TestGenerationRunResult,
} from "./testGenerationRunner.js";
import { defaultAssuredPreFilter, type AssuredPreFilterPort } from "./assuredPreFilterRunner.js";
import { editorAiStatusActive, resolveEditorAiAssistStatusForRoot } from "./aiAssistActivation.js";

// The overlay buffer(s) may be up to the document-size cap; allow 64 KiB of JSON on top, doubled to
// accommodate a small changed-file set.
const MAX_TEST_GENERATION_BODY_BYTES = 2 * (1_048_576 + 64 * 1024);
const MAX_CHANGED_SET_DOCUMENTS = 32;

// Gate A — deployment ceiling (default OFF: this wave-2 feature remains unavailable unless the
// operator explicitly permits it; M7 settings still provide the separate explicit opt-in).
const TEST_GENERATION_POLICY_ENV = "KEIKO_EDITOR_TEST_GENERATION";
// Gate B — permits producing a candidate once the enforced egress boundary is available (default OFF).
const TEST_GENERATION_EXECUTION_ENV = "KEIKO_EDITOR_TEST_GENERATION_EXECUTION";
const ENABLE_TOKENS: ReadonlySet<string> = new Set(["1", "true", "on", "yes", "enabled"]);

// Content-free, static explanations (never a prompt, model output, or secret).
const DISABLED_REASON =
  "Editor-driven test generation is disabled in this build. It is a wave-2 feature gated behind an enforced network-egress boundary (ADR-0042 D7).";
const DEFERRED_REASON =
  "Editor-driven test generation is enabled, but the assured pre-filter requires an enforced, deny-by-default network-egress boundary that is not yet available. No tests were generated or executed.";
const FAILED_REASON = "Test generation could not be completed. The editor is still usable.";

/** Injectable options for the route (tests supply a fake runner, pre-filter, and a fixed clock). */
export interface EditorTestGenerationRouteOptions {
  readonly runner?: TestGenerationRunner | undefined;
  readonly preFilter?: AssuredPreFilterPort | undefined;
  readonly now?: (() => number) | undefined;
}

function envFlagEnabled(value: string | undefined): boolean {
  return value !== undefined && ENABLE_TOKENS.has(value.trim().toLowerCase());
}

/** Whether the test-generation feature is permitted by deployment policy (Gate A; default off). */
export function isTestGenerationEnabledByPolicy(env: EnvSource | undefined): boolean {
  const token = env?.[TEST_GENERATION_POLICY_ENV]?.trim().toLowerCase();
  return token !== undefined && ENABLE_TOKENS.has(token);
}

/**
 * Whether the route may produce a candidate (Gate B; default off). Requires the feature flag AND the
 * explicit execution flag — the latter is the wave-2 enablement that only an enforced egress boundary
 * justifies. No candidate (no model call) is produced until both are set.
 */
export function isTestGenerationExecutionEnabledByPolicy(env: EnvSource | undefined): boolean {
  return (
    isTestGenerationEnabledByPolicy(env) && envFlagEnabled(env?.[TEST_GENERATION_EXECUTION_ENV])
  );
}

function isRouteResult(value: unknown): value is RouteResult {
  return typeof value === "object" && value !== null && "status" in value && "body" in value;
}

function disabledResponse(): EditorTestGenerationWireResponse {
  return {
    schemaVersion: EDITOR_TEST_GENERATION_SCHEMA_VERSION,
    status: "disabled",
    reason: DISABLED_REASON,
    funnel: notRunTestGenerationFunnel(),
  };
}

function deferredResponse(context: CodingContextWirePack): EditorTestGenerationWireResponse {
  return {
    schemaVersion: EDITOR_TEST_GENERATION_SCHEMA_VERSION,
    status: "deferred",
    reason: DEFERRED_REASON,
    funnel: notRunTestGenerationFunnel(),
    context,
  };
}

function failedResponse(context: CodingContextWirePack): EditorTestGenerationWireResponse {
  return {
    schemaVersion: EDITOR_TEST_GENERATION_SCHEMA_VERSION,
    status: "failed",
    reason: FAILED_REASON,
    funnel: notRunTestGenerationFunnel(),
    context,
  };
}

function unsupportedVerificationResponse(
  context: CodingContextWirePack,
  produced: TestGenerationRunResult,
): EditorTestGenerationWireResponse {
  return {
    schemaVersion: EDITOR_TEST_GENERATION_SCHEMA_VERSION,
    status: "generated",
    assurance: "unverified",
    funnel: produced.funnel,
    context,
    patch: produced.patch,
    provenance: produced.provenance,
    reason:
      produced.unsupportedVerificationReason ??
      "The generated candidate cannot run through a supported assured pre-filter and is unverified review evidence only.",
  };
}

// ─── Target coordinates ──────────────────────────────────────────────────────────────────────────

function targetDocumentPaths(target: EditorTestGenerationWireTarget): readonly string[] {
  return target.kind === "changed-file-set"
    ? target.documents.map((document) => document.path)
    : [target.document.path];
}

function anchorDocumentPath(target: EditorTestGenerationWireTarget): string {
  if (target.kind === "changed-file-set") {
    // The parser guarantees a non-empty document set; `?? ""` only satisfies the index check.
    return target.documents[0]?.path ?? "";
  }
  return target.document.path;
}

function targetSymbolName(target: EditorTestGenerationWireTarget): string | undefined {
  return target.kind === "symbol" ? target.symbol.name : undefined;
}

function changedFilePaths(target: EditorTestGenerationWireTarget): readonly string[] | undefined {
  return target.kind === "changed-file-set" ? target.documents.map((d) => d.path) : undefined;
}

// Validates the shape + containment of every document path the target references. Returns a 400/403
// RouteResult on the first failure, or undefined when every path is a contained, workspace-relative path.
function validateTargetContainment(
  realRoot: string,
  fs: WorkspaceFs,
  target: EditorTestGenerationWireTarget,
): RouteResult | undefined {
  if (target.kind === "changed-file-set" && target.documents.length > MAX_CHANGED_SET_DOCUMENTS) {
    return {
      status: 400,
      body: errorBody(
        "INVALID_REQUEST",
        `target.documents must contain at most ${MAX_CHANGED_SET_DOCUMENTS.toString()} documents.`,
      ),
    };
  }
  for (const path of targetDocumentPaths(target)) {
    if (!isValidScopePath(path, { mustBeRelative: true })) {
      return {
        status: 400,
        body: errorBody(
          "INVALID_REQUEST",
          `target document path is not workspace-relative: ${path}`,
        ),
      };
    }
    // Throws FilesError on escape/denied (handled by runFilesHandler).
    resolveOverlayPath(realRoot, path, fs);
  }
  return undefined;
}

// ─── Governed discovery (#1211) ────────────────────────────────────────────────────────────────────

function contextBudgetBytes(request: EditorTestGenerationWireRequest): number {
  return Math.min(
    CODING_CONTEXT_BUDGETS["test-generation"].budgetBytes,
    Math.max(0, Math.trunc(request.contextBudgetBytes)),
  );
}

function buildDiscoveryRequest(request: EditorTestGenerationWireRequest): CodingContextRequest {
  const target = request.target;
  return {
    schemaVersion: CODING_CONTEXT_SCHEMA_VERSION,
    purpose: "test-generation",
    editorSessionId: request.editorSessionId,
    documentPath: anchorDocumentPath(target),
    symbol: targetSymbolName(target) ?? request.context?.symbol,
    queryText: request.context?.queryText,
    changedFiles: changedFilePaths(target) ?? request.context?.changedFiles,
    capsuleId: request.context?.capsuleId,
    capsuleSetId: request.context?.capsuleSetId,
  };
}

// Runs the existing governed retrieval substrate (#1211) for related-file/test discovery — repository
// search plus, when a capsule/connector is selected and policy-allowed, Local Knowledge and memory —
// rather than a new editor-only collector. Records content-free evidence and returns the wire pack.
async function assembleDiscoveryContext(
  ctx: OutcomeContext,
  allowEmbeddingProviders: boolean,
): Promise<{ readonly pack: CodingContextPack; readonly wire: CodingContextWirePack }> {
  const pack = await assembleCodingContext(buildDiscoveryRequest(ctx.request), {
    deps: ctx.deps,
    realRoot: ctx.realRoot,
    fs: ctx.fs,
    signal: ctx.signal,
    nowMs: ctx.nowMs,
    budgetBytes: contextBudgetBytes(ctx.request),
    allowEmbeddingProviders,
    // The git context calls the git routes in-process; without the id their failure lines are
    // orphaned under UNKNOWN_CORRELATION_ID (AGENTS.md §8 Rule 1).
    correlationId: ctx.correlationId,
  });
  const wire = toCodingContextWirePack(pack);
  recordCodingContextEvidence(ctx.deps.evidenceStore, ctx.deps.redactor, wire, ctx.nowMs);
  return { pack, wire };
}

// ─── Outcome ──────────────────────────────────────────────────────────────────────────────────────

interface OutcomeContext {
  readonly request: EditorTestGenerationWireRequest;
  readonly deps: UiHandlerDeps;
  readonly realRoot: string;
  readonly fs: WorkspaceFs;
  readonly signal: AbortSignal;
  readonly nowMs: number;
  readonly options: EditorTestGenerationRouteOptions;
  // Request-scoped correlation id (RB-6) so the `failed` response an operator sees in the editor can
  // be tied to the redacted server-side record of WHY the runner or the pre-filter threw.
  readonly correlationId: string | undefined;
}

// `failed` is the same wire status a genuinely unproducible candidate yields, so without this record
// a model outage, a revoked provider credential, and "the runner declined" are indistinguishable.
// Content-free: error class, machine code, correlation id — never the patch, the buffer, or a prompt.
function reportTestGenerationFailure(ctx: OutcomeContext, error: unknown): void {
  emitServerDiagnostic(
    ctx.deps.diagnostics,
    serverDiagnosticFromError({
      correlationId: ctx.correlationId ?? newCorrelationId(),
      operation: "editor.testGeneration",
      source: "editor.testGenerationRoutes",
      error,
      summary: "Editor test generation failed.",
      redact: (message): string => String(ctx.deps.redactor(message)),
    }),
  );
}

// Produces the candidate outcome once the feature is enabled. Gate B off → `deferred` with NO model
// call. Gate B on (wave 2) → the injectable runner produces a candidate, which the assured pre-filter
// then EXECUTES in an enforced-egress disposable root: it is surfaced as `assured` only when it builds,
// passes, is stable, increases coverage, and kills enough mutants; otherwise it is `unverified`
// (untrusted evidence only — including the fail-closed path when egress cannot be enforced). The patch
// is always returned for review; assurance tells the editor whether it is apply-ready.
async function produceOutcome(
  ctx: OutcomeContext,
  discovery: { readonly pack: CodingContextPack; readonly wire: CodingContextWirePack },
): Promise<EditorTestGenerationWireResponse> {
  if (!isTestGenerationExecutionEnabledByPolicy(ctx.deps.env)) {
    return deferredResponse(discovery.wire);
  }
  const runner = ctx.options.runner ?? defaultTestGenerationRunner;
  try {
    const produced = await runner({
      request: ctx.request,
      deps: ctx.deps,
      realRoot: ctx.realRoot,
      fs: ctx.fs,
      signal: ctx.signal,
      nowMs: ctx.nowMs,
      contextPack: discovery.pack,
    });
    if (produced === undefined) {
      return deferredResponse(discovery.wire);
    }
    if (produced.verification === undefined) {
      return unsupportedVerificationResponse(discovery.wire, produced);
    }
    const preFilter = ctx.options.preFilter ?? defaultAssuredPreFilter;
    const assured = await preFilter({
      patch: produced.patch,
      request: ctx.request,
      realRoot: ctx.realRoot,
      signal: ctx.signal,
      verification: produced.verification,
    });
    return {
      schemaVersion: EDITOR_TEST_GENERATION_SCHEMA_VERSION,
      status: "generated",
      assurance: assured.assurance,
      funnel: assured.funnel,
      context: discovery.wire,
      patch: produced.patch,
      provenance: produced.provenance,
      applyableDiff: produced.proposedDiff,
      ...(assured.rejectionReason === undefined ? {} : { reason: assured.rejectionReason }),
    };
  } catch (error) {
    reportTestGenerationFailure(ctx, error);
    return failedResponse(discovery.wire);
  }
}

// ADR-0133 D7: discard in-flight work at the activation revision boundary rather than surfacing a
// stale-authorized result if activation was revoked while the model call ran.
async function testGenerationActivationStillActive(
  deps: UiHandlerDeps,
  realRoot: string,
): Promise<boolean> {
  return editorAiStatusActive(
    await resolveEditorAiAssistStatusForRoot(deps, realRoot, "testGeneration"),
  );
}

/** Assembles the outcome context, including the request-scoped correlation id for its diagnostics. */
function outcomeContext(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  options: EditorTestGenerationRouteOptions,
  resolved: Pick<OutcomeContext, "request" | "realRoot" | "fs" | "signal" | "nowMs">,
): OutcomeContext {
  return { ...resolved, deps, options, correlationId: ctx.correlationId };
}

async function discoverAndProduceOutcome(
  ctx: OutcomeContext,
  allowEmbeddingProviders: boolean,
): Promise<EditorTestGenerationWireResponse> {
  const discovery = await assembleDiscoveryContext(ctx, allowEmbeddingProviders);
  return produceOutcome(ctx, discovery);
}

export async function handleEditorTestGeneration(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  options: EditorTestGenerationRouteOptions = {},
): Promise<RouteResult> {
  // Gate A — default OFF: the feature is switched off, so no request-body parsing, retrieval, model, or
  // execution runs. This avoids serializing/parsing the full editor buffer for a disabled wave-2 feature.
  if (!isTestGenerationEnabledByPolicy(deps.env)) {
    return { status: 200, body: deps.redactor(disabledResponse()) };
  }
  const body = await readJsonObject(ctx.req, MAX_TEST_GENERATION_BODY_BYTES);
  if (isRouteResult(body)) {
    return body;
  }
  const parsed = parseEditorTestGenerationRequest(body);
  if (!parsed.ok) {
    return { status: 400, body: errorBody("INVALID_REQUEST", parsed.errors.join("; ")) };
  }
  const request = parsed.value;
  return runFilesHandler(async () => {
    const root = await resolveRequestRoot(ctx, deps, request.root);
    const { canonicalRoot, fs } = root.access;
    const containment = validateTargetContainment(canonicalRoot, fs, request.target);
    if (containment !== undefined) {
      return containment;
    }
    if (!(await testGenerationActivationStillActive(deps, canonicalRoot))) {
      return { status: 200, body: deps.redactor(disabledResponse()) };
    }
    const nowMs = (options.now ?? Date.now)();
    const signal = clientAbortSignal(ctx);
    const executionEnabled = isTestGenerationExecutionEnabledByPolicy(deps.env);
    const operation = outcomeContext(ctx, deps, options, {
      request,
      realRoot: canonicalRoot,
      fs,
      signal,
      nowMs,
    });
    const outcome = await discoverAndProduceOutcome(operation, executionEnabled);
    if (!(await testGenerationActivationStillActive(deps, canonicalRoot))) {
      return { status: 200, body: deps.redactor(disabledResponse()) };
    }
    recordTestGenerationEvidence(deps.evidenceStore, deps.redactor, outcome, nowMs);
    return { status: 200, body: deps.redactor(outcome) };
  });
}
