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

import {
  CODING_CONTEXT_BUDGETS,
  CODING_CONTEXT_SCHEMA_VERSION,
  EDITOR_TEST_GENERATION_SCHEMA_VERSION,
  isValidScopePath,
  notRunTestGenerationFunnel,
  parseEditorTestGenerationRequest,
  toCodingContextWirePack,
  type CodingContextPack,
  type CodingContextRequest,
  type CodingContextWirePack,
  type EditorTestGenerationWireRequest,
  type EditorTestGenerationWireResponse,
  type EditorTestGenerationWireTarget,
} from "@oscharko-dev/keiko-contracts";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { readJsonObject, resolveRoot, runFilesHandler } from "../files.js";
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
    resolveOverlayPath(realRoot, path);
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
  request: EditorTestGenerationWireRequest,
  deps: UiHandlerDeps,
  realRoot: string,
  signal: AbortSignal,
  nowMs: number,
  allowEmbeddingProviders: boolean,
): Promise<{ readonly pack: CodingContextPack; readonly wire: CodingContextWirePack }> {
  const pack = await assembleCodingContext(buildDiscoveryRequest(request), {
    deps,
    realRoot,
    signal,
    nowMs,
    budgetBytes: contextBudgetBytes(request),
    allowEmbeddingProviders,
  });
  const wire = toCodingContextWirePack(pack);
  recordCodingContextEvidence(deps.evidenceStore, deps.redactor, wire, nowMs);
  return { pack, wire };
}

// ─── Outcome ──────────────────────────────────────────────────────────────────────────────────────

interface OutcomeContext {
  readonly request: EditorTestGenerationWireRequest;
  readonly deps: UiHandlerDeps;
  readonly realRoot: string;
  readonly signal: AbortSignal;
  readonly nowMs: number;
  readonly options: EditorTestGenerationRouteOptions;
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
  } catch {
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
    const root = await resolveRoot(deps.store, request.root, deps.redactor);
    const containment = validateTargetContainment(root.realRoot, request.target);
    if (containment !== undefined) {
      return containment;
    }
    if (!(await testGenerationActivationStillActive(deps, root.realRoot))) {
      return { status: 200, body: deps.redactor(disabledResponse()) };
    }
    const nowMs = (options.now ?? Date.now)();
    const signal = clientAbortSignal(ctx);
    const executionEnabled = isTestGenerationExecutionEnabledByPolicy(deps.env);
    const discovery = await assembleDiscoveryContext(
      request,
      deps,
      root.realRoot,
      signal,
      nowMs,
      executionEnabled,
    );
    const outcome = await produceOutcome(
      { request, deps, realRoot: root.realRoot, signal, nowMs, options },
      discovery,
    );
    if (!(await testGenerationActivationStillActive(deps, root.realRoot))) {
      return { status: 200, body: deps.redactor(disabledResponse()) };
    }
    recordTestGenerationEvidence(deps.evidenceStore, deps.redactor, outcome, nowMs);
    return { status: 200, body: deps.redactor(outcome) };
  });
}
