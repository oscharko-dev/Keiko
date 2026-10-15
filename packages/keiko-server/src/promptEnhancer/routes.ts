// Prompt Enhancer BFF route (Epic #1307, Issue #1314; ADR-0044 §1 "BFF /api/prompt-enhancer/* routes").
//
// A single additive POST handler under `/api/prompt-enhancement`. It composes the existing route
// plumbing (RouteContext / UiHandlerDeps / errorBody) exactly like `qualityIntelligence/connectorRoutes`
// and does not modify any sibling handler. The deterministic enhancement is assembled by
// `runPromptEnhancement` (orchestrate.ts); this file owns only the HTTP envelope: bounded body read,
// JSON parsing, wire validation, cancellation, Model-Gateway config hand-off, redaction, and safe error
// shaping. No provider SDK import lives here; optional model-assisted enhancement routes through the
// existing ModelPort factory so provider credentials stay behind the server boundary.

import type { IncomingMessage } from "node:http";
import { resolveAppSessionReadAuthority } from "../coding-app-session/appSessionReadAuthority.js";
import { logMarkdownSkillOperation } from "../markdown-skill-log.js";
import { correlationIdOrUnknown } from "../correlation.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import { validatePromptEnhancementWireRequest } from "@oscharko-dev/keiko-contracts/runtime/prompt-enhancer-bff";
import type {
  PromptEnhancementWireRequest,
  PromptEnhancementWireResponse,
} from "@oscharko-dev/keiko-contracts";
import {
  EvidenceReadError,
  EvidenceWriteError,
  InvalidRunIdError,
  loadPromptEnhancementRun,
  recordPromptEnhancementRun,
} from "@oscharko-dev/keiko-evidence";
import type { RouteContext, RouteResult } from "../routes.js";
import { errorBody } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  currentEvidenceRequiresFullStringRedaction,
  currentEvidenceTopologyRedactionSecrets,
  currentGatewayConfig,
} from "../deps.js";
import {
  PromptEnhancementCancelledError,
  PromptEnhancementInputError,
  PromptEnhancementSkillDraftError,
  buildPromptEnhancementRecordInput,
  promptEnhancementGatewayRoutingConfig,
  runPromptEnhancement,
} from "./orchestrate.js";

// A generous-but-bounded cap. A maximal valid request (a 100k-character draft, fully \uXXXX-escaped in
// JSON, plus the small metadata fields) stays well under this ceiling; anything larger is rejected with
// a 413 before parsing so a hostile upload cannot exhaust memory.
const MAX_BODY_BYTES = 1_048_576;

class BodyTooLargeError extends Error {
  public constructor() {
    super("Request body exceeds prompt-enhancement route cap");
    this.name = "BodyTooLargeError";
  }
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new BodyTooLargeError());
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalidRequest = (details: readonly string[]): RouteResult => ({
  status: 400,
  body: {
    ...errorBody("PROMPT_ENHANCER_INVALID_REQUEST", "The prompt enhancement request was invalid."),
    details,
  },
});

// Bind an AbortSignal to client disconnect. The res "close" event is the canonical "client gone" signal
// (the req "aborted" event is deprecated and fires unreliably since Node 17), mirroring grounded-qa.
const requestAbortSignal = (ctx: RouteContext): AbortSignal => {
  const controller = new AbortController();
  ctx.res.on("close", () => {
    if (!ctx.res.writableEnded && !controller.signal.aborted) {
      controller.abort("prompt enhancement request cancelled");
    }
  });
  return controller.signal;
};

const cancelledResult = (): RouteResult => ({
  status: 499,
  body: errorBody("PROMPT_ENHANCER_CANCELLED", "The prompt enhancement request was cancelled."),
});

const notRecordedEvidence = (): PromptEnhancementWireResponse["evidence"] => ({
  status: "not-recorded",
  reason: "evidence-store-not-configured",
});

const peEvidenceUrl = (runId: string): string =>
  `/api/prompt-enhancement/evidence/${encodeURIComponent(runId)}`;

type ValidatedPromptEnhancementRequest =
  | { readonly ok: true; readonly value: PromptEnhancementWireRequest }
  | { readonly ok: false; readonly result: RouteResult };

function recordEvidenceReference(
  rawInput: string,
  result: PromptEnhancementWireResponse,
  deps: UiHandlerDeps,
): PromptEnhancementWireResponse["evidence"] {
  if (deps.evidenceDir === undefined) {
    return notRecordedEvidence();
  }
  const record = buildPromptEnhancementRecordInput({
    rawInput,
    result,
    recordedAt: new Date().toISOString(),
  });
  const { manifest } = recordPromptEnhancementRun(record, {
    evidenceDir: deps.evidenceDir,
    redaction: {
      additionalSecrets: currentEvidenceTopologyRedactionSecrets(deps),
      redactAllStrings: currentEvidenceRequiresFullStringRedaction(deps),
    },
  });
  return {
    status: "recorded",
    reason: "evidence-recorded",
    runId: manifest.runId,
    manifestUrl: peEvidenceUrl(manifest.runId),
    peEvidenceSchemaVersion: manifest.peEvidenceSchemaVersion,
    recordIntegritySha256: manifest.integrityHashes.record,
  };
}

async function readPromptEnhancementRequest(
  ctx: RouteContext,
  signal: AbortSignal,
): Promise<ValidatedPromptEnhancementRequest> {
  let raw: string;
  try {
    raw = await readBody(ctx.req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return {
        ok: false,
        result: {
          status: 413,
          body: errorBody("PROMPT_ENHANCER_PAYLOAD_TOO_LARGE", "The request body is too large."),
        },
      };
    }
    return { ok: false, result: invalidRequest(["request body could not be read"]) };
  }

  if (signal.aborted) return { ok: false, result: cancelledResult() };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, result: invalidRequest(["request body is not valid JSON"]) };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, result: invalidRequest(["request body must be a JSON object"]) };
  }

  const validated = validatePromptEnhancementWireRequest(parsed);
  if (!validated.ok) {
    return { ok: false, result: invalidRequest(validated.errors) };
  }
  return { ok: true, value: validated.value };
}

/**
 * POST /api/prompt-enhancement — generate a governed, reviewable Enhanced Prompt from a raw draft.
 * Validation, Model-Gateway routing (AC3), cancellation, and safe error shaping are all handled here.
 */
function draftAccessFailure(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  request: PromptEnhancementWireRequest,
): RouteResult | undefined {
  if (
    request.outputKind !== "markdown-skill" ||
    resolveAppSessionReadAuthority(deps, ctx.req) !== undefined
  )
    return undefined;
  return {
    status: 404,
    body: errorBody("NOT_FOUND", "Skill authoring is unavailable.", ctx.correlationId),
  };
}

function enhancementFailure(error: unknown): RouteResult {
  if (error instanceof PromptEnhancementCancelledError) return cancelledResult();
  if (error instanceof PromptEnhancementInputError) return invalidRequest(error.errors);
  if (error instanceof PromptEnhancementSkillDraftError)
    return { status: 422, body: errorBody("PROMPT_ENHANCER_SKILL_DRAFT_REFUSED", error.message) };
  if (error instanceof EvidenceWriteError)
    return {
      status: 500,
      body: errorBody(
        "PROMPT_ENHANCER_EVIDENCE_WRITE",
        "Prompt enhancement evidence could not be recorded.",
      ),
    };
  return {
    status: 500,
    body: errorBody("PROMPT_ENHANCER_INTERNAL", "Prompt enhancement failed unexpectedly."),
  };
}

async function enhancementResult(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  request: PromptEnhancementWireRequest,
  signal: AbortSignal,
): Promise<RouteResult> {
  const denied = draftAccessFailure(ctx, deps, request);
  if (denied !== undefined) return denied;
  try {
    const result = await runPromptEnhancement(request, {
      gatewayRoutingConfig: promptEnhancementGatewayRoutingConfig(currentGatewayConfig(deps)),
      modelPortFactory: deps.modelPortFactory,
      signal,
      correlationId: ctx.correlationId,
    });
    const revoked = draftAccessFailure(ctx, deps, request);
    if (revoked !== undefined) return revoked;
    const body: PromptEnhancementWireResponse = {
      ...result,
      evidence:
        request.outputKind === "markdown-skill"
          ? { status: "not-recorded", reason: "private-skill-draft" }
          : recordEvidenceReference(request.text, result, deps),
    };
    return { status: 200, body: deps.redactor(body) };
  } catch (error) {
    emitServerDiagnostic(
      deps.diagnostics,
      serverDiagnosticFromError({
        correlationId: correlationIdOrUnknown(ctx.correlationId),
        operation: "prompt.enhancement",
        source: "prompt.enhancement.route",
        error,
        redact: (message) => String(deps.redactor(message)),
      }),
    );
    return enhancementFailure(error);
  }
}

export const handlePromptEnhancement = async (
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> => {
  const signal = requestAbortSignal(ctx);
  const validated = await readPromptEnhancementRequest(ctx, signal);
  if (!validated.ok) return validated.result;
  const privateDraft = validated.value.outputKind === "markdown-skill";
  if (privateDraft) logMarkdownSkillOperation(ctx.correlationId, "generate", "started", 0);
  const result = await enhancementResult(ctx, deps, validated.value, signal);
  if (!privateDraft) return result;
  let phase: "failed" | "rejected" | "completed" = "completed";
  if (result.status >= 400) phase = "rejected";
  if (result.status >= 500) phase = "failed";
  logMarkdownSkillOperation(ctx.correlationId, "generate", phase, result.status);
  return { ...result, headers: { "Cache-Control": "no-store" } };
};

export const handlePromptEnhancementEvidence = (
  ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult => {
  const runId = ctx.params.runId ?? "";
  if (deps.evidenceDir === undefined) {
    return {
      status: 404,
      body: errorBody("NOT_FOUND", "No prompt enhancement evidence store is configured."),
    };
  }
  try {
    const manifest = loadPromptEnhancementRun(runId, { evidenceDir: deps.evidenceDir });
    if (manifest === undefined) {
      return {
        status: 404,
        body: errorBody("NOT_FOUND", "No prompt enhancement evidence for that run id."),
      };
    }
    return { status: 200, body: { manifest } };
  } catch (error) {
    if (error instanceof InvalidRunIdError) {
      return { status: 400, body: errorBody("BAD_REQUEST", "The run id is not valid.") };
    }
    if (error instanceof EvidenceReadError) {
      return { status: 422, body: errorBody("PROMPT_ENHANCER_EVIDENCE_READ", error.message) };
    }
    throw error;
  }
};
