// Quality Intelligence review-action BFF route (Epic #270, Issue #282).
//
//   * POST /api/quality-intelligence/runs/:id/review — record a human review decision
//
// Applies an explicit, auditable review decision (approve / reject / request-changes / reopen /
// withdraw) to a run or a single candidate, persisting it to the review companion artifact. Nothing
// is approved by default; a decision is required to flip state. The route never echoes raw content.

import type { IncomingMessage } from "node:http";
import { loadQualityIntelligenceRun } from "@oscharko-dev/keiko-evidence";
import type { RouteContext, RouteResult, RouteDefinition } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  applyReviewDecision,
  QualityIntelligenceReviewTransitionRejected,
  type QiReviewAction,
} from "./reviewStore.js";

const MAX_BODY_BYTES = 16 * 1024;
const ACTIONS: ReadonlySet<string> = new Set<QiReviewAction>([
  "approve",
  "reject",
  "request-changes",
  "reopen",
  "withdraw",
]);

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

const errorResult = (status: number, code: string, message: string): RouteResult => ({
  status,
  body: { error: { code, message } },
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface ParsedDecision {
  readonly action: QiReviewAction;
  readonly scope: "run" | "candidate";
  readonly candidateId?: string;
  readonly reviewerLabel: string;
}

function parseDecision(body: Record<string, unknown>): ParsedDecision | undefined {
  const action = body.action;
  if (typeof action !== "string" || !ACTIONS.has(action)) return undefined;
  const candidateId = typeof body.candidateId === "string" ? body.candidateId : undefined;
  const scope = candidateId !== undefined ? "candidate" : "run";
  const reviewerLabel =
    typeof body.reviewerLabel === "string" && body.reviewerLabel.trim().length > 0
      ? body.reviewerLabel.trim().slice(0, 80)
      : "reviewer";
  return {
    action: action as QiReviewAction,
    scope,
    reviewerLabel,
    ...(candidateId ? { candidateId } : {}),
  };
}

type DecisionOutcome =
  | { readonly ok: true; readonly decision: ParsedDecision }
  | { readonly ok: false; readonly result: RouteResult };

async function readDecision(req: IncomingMessage): Promise<DecisionOutcome> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    return {
      ok: false,
      result: errorResult(413, "QI_BODY_TOO_LARGE", "Review body is too large."),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      result: errorResult(400, "QI_BAD_REQUEST", "Review body is not valid JSON."),
    };
  }
  if (!isObject(parsed)) {
    return {
      ok: false,
      result: errorResult(400, "QI_BAD_REQUEST", "Review body must be an object."),
    };
  }
  const decision = parseDecision(parsed);
  if (decision === undefined) {
    return {
      ok: false,
      result: errorResult(400, "QI_BAD_ACTION", "A valid review action is required."),
    };
  }
  return { ok: true, decision };
}

export async function handleQiReview(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  const { id } = ctx.params;
  if (id === undefined || id.trim().length === 0) {
    return errorResult(400, "QI_BAD_REQUEST", "Run id is required.");
  }
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined) {
    return errorResult(500, "QI_NO_EVIDENCE_DIR", "The evidence directory is not configured.");
  }
  const parsed = await readDecision(ctx.req);
  if (!parsed.ok) return parsed.result;
  const { decision } = parsed;
  try {
    if (loadQualityIntelligenceRun(id, { evidenceDir }) === undefined) {
      return errorResult(404, "QI_NOT_FOUND", "Quality Intelligence run not found.");
    }
    const next = applyReviewDecision({
      runId: id,
      evidenceDir,
      action: decision.action,
      scope: decision.scope,
      reviewerLabel: decision.reviewerLabel,
      now: new Date().toISOString(),
      redact: deps.redactor,
      ...(decision.candidateId ? { candidateId: decision.candidateId } : {}),
    });
    return {
      status: 200,
      body: {
        runState: next.runState,
        candidateStates: next.candidateStates,
        auditCount: next.auditLog.length,
      },
    };
  } catch (error) {
    if (error instanceof QualityIntelligenceReviewTransitionRejected) {
      return errorResult(
        409,
        "QI_REVIEW_TRANSITION_NOT_ALLOWED",
        `Review transition not permitted: cannot ${error.action} a run/candidate in state "${error.from}".`,
      );
    }
    return errorResult(500, "QI_REVIEW_FAILED", "Failed to record the review decision.");
  }
}

export const QI_REVIEW_ROUTE_GROUP: readonly RouteDefinition[] = [
  { method: "POST", pattern: "/api/quality-intelligence/runs/:id/review", handler: handleQiReview },
];
