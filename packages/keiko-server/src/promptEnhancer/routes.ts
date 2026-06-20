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
import type { RouteContext, RouteResult } from "../routes.js";
import { errorBody } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { currentGatewayConfig } from "../deps.js";
import {
  PromptEnhancementCancelledError,
  PromptEnhancementInputError,
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

/**
 * POST /api/prompt-enhancement — generate a governed, reviewable Enhanced Prompt from a raw draft.
 * Validation, Model-Gateway routing (AC3), cancellation, and safe error shaping are all handled here.
 */
export const handlePromptEnhancement = async (
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> => {
  const signal = requestAbortSignal(ctx);

  let raw: string;
  try {
    raw = await readBody(ctx.req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return {
        status: 413,
        body: errorBody("PROMPT_ENHANCER_PAYLOAD_TOO_LARGE", "The request body is too large."),
      };
    }
    return invalidRequest(["request body could not be read"]);
  }

  if (signal.aborted) return cancelledResult();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalidRequest(["request body is not valid JSON"]);
  }
  if (!isPlainObject(parsed)) {
    return invalidRequest(["request body must be a JSON object"]);
  }

  const validated = validatePromptEnhancementWireRequest(parsed);
  if (!validated.ok) {
    return invalidRequest(validated.errors);
  }

  try {
    const result = runPromptEnhancement(validated.value, {
      gatewayConfig: currentGatewayConfig(deps),
      signal,
    });
    // AC4 defence-in-depth: deep-redact every string leaf of the response through the live audit
    // redactor before it leaves the server, so any secret-shaped substring a user pasted into their own
    // draft is scrubbed from the echoed input / rendered prompt. Scores, ids, and enums are untouched.
    return { status: 200, body: deps.redactor(result) };
  } catch (error) {
    if (error instanceof PromptEnhancementCancelledError) {
      return cancelledResult();
    }
    if (error instanceof PromptEnhancementInputError) {
      return invalidRequest(error.errors);
    }
    // Unknown failure: a safe, content-free 500 (no raw input, stack, or provider detail).
    return {
      status: 500,
      body: errorBody("PROMPT_ENHANCER_INTERNAL", "Prompt enhancement failed unexpectedly."),
    };
  }
};
