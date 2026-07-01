// Quality Intelligence review-action BFF route (Epic #270, Issue #282).
//
//   * POST /api/quality-intelligence/runs/:id/review — record a human review decision
//
// Applies an explicit, auditable review decision (approve / reject / request-changes / reopen /
// withdraw) to a run or a single candidate, persisting it to the review companion artifact. Nothing
// is approved by default; a decision is required to flip state. The route never echoes raw content.

import type { IncomingMessage } from "node:http";
import {
  loadQualityIntelligenceCandidates,
  loadQualityIntelligenceRun,
} from "@oscharko-dev/keiko-evidence";
import { normaliseCandidateText } from "@oscharko-dev/keiko-quality-intelligence";
import type { RouteContext, RouteResult, RouteDefinition } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  applyReviewDecision,
  candidateReviewStateOf,
  loadRunReviewState,
  QualityIntelligenceReviewCandidateNotFound,
  QualityIntelligenceReviewGovernanceRejected,
  QualityIntelligenceReviewRunApprovalRejected,
  QualityIntelligenceReviewTransitionRejected,
  QualityIntelligenceReviewWriteConflict,
  type QiReviewAction,
} from "./reviewStore.js";
import { resolveQualityIntelligenceReviewPrincipal } from "./reviewPrincipal.js";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_REASON_LEN = 512;
const ACTIONS: ReadonlySet<string> = new Set<QiReviewAction>([
  "approve",
  "reject",
  "request-changes",
  "reopen",
  "withdraw",
]);

class BodyTooLargeError extends Error {}

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
  readonly reviewerLabel?: string;
  readonly reason?: string;
}

function parseDecision(body: Record<string, unknown>): ParsedDecision | undefined {
  const action = body.action;
  if (typeof action !== "string" || !ACTIONS.has(action)) return undefined;
  const candidateId = typeof body.candidateId === "string" ? body.candidateId : undefined;
  const scope = candidateId !== undefined ? "candidate" : "run";
  const rawLabel =
    typeof body.reviewerLabel === "string" ? normaliseCandidateText(body.reviewerLabel) : "";
  const rawReason = typeof body.reason === "string" ? normaliseCandidateText(body.reason) : "";
  return {
    action: action as QiReviewAction,
    scope,
    ...(rawLabel.length > 0 ? { reviewerLabel: rawLabel.slice(0, 80) } : {}),
    ...(rawReason.length > 0 ? { reason: rawReason.slice(0, MAX_REASON_LEN) } : {}),
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

const runApprovalBlockedByCandidates = (
  runId: string,
  candidateIds: readonly string[],
  evidenceDir: string,
): RouteResult | null => {
  if (candidateIds.length === 0) return null;
  const review = loadRunReviewState(runId, evidenceDir);
  const hasUnapprovedCandidate = candidateIds.some(
    (candidateId) => candidateReviewStateOf(review, candidateId) !== "approved",
  );
  return hasUnapprovedCandidate
    ? errorResult(
        409,
        "QI_REVIEW_RUN_APPROVAL_BLOCKED",
        "Approve every candidate before approving the Quality Intelligence run.",
      )
    : null;
};

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
    const candidateArtifact = loadQualityIntelligenceCandidates(id, { evidenceDir });
    const candidateIds = candidateArtifact?.candidates.map((candidate) => candidate.id);
    if (
      decision.scope === "candidate" &&
      decision.candidateId !== undefined &&
      (candidateIds === undefined || !candidateIds.includes(decision.candidateId))
    ) {
      return errorResult(404, "QI_CANDIDATE_NOT_FOUND", "Candidate not found for this run.");
    }
    if (decision.scope === "run" && decision.action === "approve") {
      const blocked = runApprovalBlockedByCandidates(id, candidateIds ?? [], evidenceDir);
      if (blocked !== null) return blocked;
    }
    const principal = resolveQualityIntelligenceReviewPrincipal(ctx.req, deps);
    const next = applyReviewDecision({
      runId: id,
      evidenceDir,
      action: decision.action,
      scope: decision.scope,
      actor: principal,
      now: new Date().toISOString(),
      redact: deps.redactor,
      ...(candidateIds !== undefined ? { candidateIds } : {}),
      ...(decision.candidateId ? { candidateId: decision.candidateId } : {}),
      ...(decision.reviewerLabel !== undefined ? { reviewerLabel: decision.reviewerLabel } : {}),
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
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
    if (error instanceof QualityIntelligenceReviewGovernanceRejected) {
      if (error.code === "REOPEN_REASON_REQUIRED") {
        return errorResult(
          409,
          "QI_REVIEW_REOPEN_REASON_REQUIRED",
          "Reopening a review requires a non-empty reason.",
        );
      }
      if (error.code === "REOPEN_ACTOR_REQUIRED") {
        return errorResult(
          409,
          "QI_REVIEW_REOPEN_ACTOR_REQUIRED",
          "Reopening a review requires a server-resolved reviewer principal.",
        );
      }
      return errorResult(
        409,
        "QI_REVIEW_FOUR_EYES_FORBIDDEN",
        "Review governance requires a different server principal for this approval.",
      );
    }
    if (error instanceof QualityIntelligenceReviewCandidateNotFound) {
      return errorResult(404, "QI_CANDIDATE_NOT_FOUND", "Candidate not found for this run.");
    }
    if (error instanceof QualityIntelligenceReviewRunApprovalRejected) {
      return errorResult(
        409,
        "QI_REVIEW_RUN_APPROVAL_BLOCKED",
        "Approve every candidate before approving the Quality Intelligence run.",
      );
    }
    if (error instanceof QualityIntelligenceReviewWriteConflict) {
      return errorResult(
        409,
        "QI_REVIEW_WRITE_CONFLICT",
        "Another review update is in progress. Retry the review action.",
      );
    }
    return errorResult(500, "QI_REVIEW_FAILED", "Failed to record the review decision.");
  }
}

export const QI_REVIEW_ROUTE_GROUP: readonly RouteDefinition[] = [
  { method: "POST", pattern: "/api/quality-intelligence/runs/:id/review", handler: handleQiReview },
];
