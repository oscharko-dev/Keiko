// Prompt Enhancer BFF route (Epic #1307, Issue #1314; ADR-0044 §1 "BFF /api/prompt-enhancer/* routes").
//
// A single additive POST handler under `/api/prompt-enhancement`. It composes the existing route
// plumbing (RouteContext / UiHandlerDeps / errorBody) exactly like `qualityIntelligence/connectorRoutes`
// and does not modify any sibling handler. The deterministic enhancement is assembled by
// `runPromptEnhancement` (orchestrate.ts); this file owns only the HTTP envelope: bounded body read,
// JSON parsing, wire validation, cancellation, Model-Gateway config hand-off, redaction, and safe error
// shaping. No provider SDK import, no outbound network request, no model dispatch.

import type { IncomingMessage } from "node:http";
import { validatePromptEnhancementWireRequest } from "@oscharko-dev/keiko-contracts";
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
  buildPromptEnhancementRecordInput,
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
export const handlePromptEnhancement = async (
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> => {
  const signal = requestAbortSignal(ctx);
  const validated = await readPromptEnhancementRequest(ctx, signal);
  if (!validated.ok) return validated.result;

  try {
    const result = runPromptEnhancement(validated.value, {
      gatewayConfig: currentGatewayConfig(deps),
      signal,
    });
    const body: PromptEnhancementWireResponse = {
      ...result,
      evidence: recordEvidenceReference(validated.value.text, result, deps),
    };
    // AC4 defence-in-depth: deep-redact every string leaf of the response through the live audit
    // redactor before it leaves the server, so any secret-shaped substring a user pasted into their own
    // draft is scrubbed from the echoed input / rendered prompt. Scores, ids, and enums are untouched.
    return { status: 200, body: deps.redactor(body) };
  } catch (error) {
    if (error instanceof PromptEnhancementCancelledError) {
      return cancelledResult();
    }
    if (error instanceof PromptEnhancementInputError) {
      return invalidRequest(error.errors);
    }
    if (error instanceof EvidenceWriteError) {
      return {
        status: 500,
        body: errorBody(
          "PROMPT_ENHANCER_EVIDENCE_WRITE",
          "Prompt enhancement evidence could not be recorded.",
        ),
      };
    }
    // Unknown failure: a safe, content-free 500 (no raw input, stack, or provider detail).
    return {
      status: 500,
      body: errorBody("PROMPT_ENHANCER_INTERNAL", "Prompt enhancement failed unexpectedly."),
    };
  }
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
