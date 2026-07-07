import type { IncomingMessage } from "node:http";
import {
  buildFeedbackReportPreview,
  feedbackPreviewHasRedactionProvenance,
  parseFeedbackReportDraft,
  FEEDBACK_REVIEW_ACTIONS,
  type FeedbackReportPreview,
  type FeedbackReviewAction,
} from "@oscharko-dev/keiko-contracts/feedback-intake";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext, RouteDefinition, RouteResult } from "./routes.js";
import {
  buildGithubIssueDraftForFeedback,
  FeedbackIntakeError,
  type FeedbackReviewInput,
  type FeedbackIntakeService,
} from "./feedback-intake.js";

const MAX_FEEDBACK_BODY_BYTES = 80_000;
const MAX_REVIEW_REASON_CHARS = 512;

class BodyTooLargeError extends Error {}

function errorBody(
  code: string,
  message: string,
): { readonly error: { readonly code: string; readonly message: string } } {
  return { error: { code, message } };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_FEEDBACK_BODY_BYTES) {
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
      if (!capped) resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FeedbackIntakeError("FEEDBACK_BAD_REQUEST", "Request body is not valid JSON.", 400);
  }
  if (!isRecord(parsed)) {
    throw new FeedbackIntakeError("FEEDBACK_BAD_REQUEST", "Request body must be an object.", 400);
  }
  return parsed;
}

function service(deps: UiHandlerDeps): FeedbackIntakeService {
  if (deps.feedbackIntake === undefined) {
    throw new FeedbackIntakeError(
      "FEEDBACK_INTAKE_UNAVAILABLE",
      "Feedback intake is not configured.",
      503,
    );
  }
  return deps.feedbackIntake;
}

function toRouteError(error: unknown): RouteResult {
  if (error instanceof BodyTooLargeError) {
    return {
      status: 413,
      body: errorBody(
        "FEEDBACK_PAYLOAD_TOO_LARGE",
        "Feedback request body exceeds the size limit.",
      ),
    };
  }
  if (error instanceof FeedbackIntakeError) {
    return { status: error.status, body: errorBody(error.code, error.message) };
  }
  throw error;
}

async function guarded(work: () => Promise<RouteResult> | RouteResult): Promise<RouteResult> {
  try {
    return await work();
  } catch (error) {
    return toRouteError(error);
  }
}

function parseReviewAction(value: unknown): FeedbackReviewAction | undefined {
  return typeof value === "string" && (FEEDBACK_REVIEW_ACTIONS as readonly string[]).includes(value)
    ? (value as FeedbackReviewAction)
    : undefined;
}

function optionalStringField(
  body: Record<string, unknown>,
  field: string,
  maxChars: number,
): string | undefined {
  const value = body[field];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, maxChars)
    : undefined;
}

function reviewInputFromBody(
  intakeId: string,
  body: Record<string, unknown>,
): FeedbackReviewInput | undefined {
  const action = parseReviewAction(body.action);
  if (action === undefined) return undefined;
  const actor = optionalStringField(body, "actor", 120) ?? "local-maintainer";
  const reason = optionalStringField(body, "reason", MAX_REVIEW_REASON_CHARS);
  const duplicateOf = optionalStringField(body, "duplicateOf", 160);
  return {
    intakeId,
    action,
    actor,
    ...(reason === undefined ? {} : { reason }),
    ...(duplicateOf === undefined ? {} : { duplicateOf }),
  };
}

export async function handleFeedbackPreview(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return guarded(async () => {
    const parsed = parseFeedbackReportDraft(await readJsonObject(ctx.req));
    if (!parsed.ok) {
      return { status: 400, body: errorBody("FEEDBACK_BAD_REPORT", parsed.errors.join("; ")) };
    }
    return {
      status: 200,
      body: buildFeedbackReportPreview(parsed.value, (input: string) =>
        String(deps.redactor(input)),
      ),
    };
  });
}

export async function handleFeedbackSubmit(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return guarded(async () => {
    const body = await readJsonObject(ctx.req);
    const preview = body.preview;
    if (!feedbackPreviewHasRedactionProvenance(preview)) {
      return {
        status: 400,
        body: errorBody(
          "FEEDBACK_MISSING_REDACTION_PROVENANCE",
          "Submit the redacted feedback preview payload.",
        ),
      };
    }
    const redactedPreview: FeedbackReportPreview = preview;
    if (!isRecord(redactedPreview.report)) {
      return { status: 400, body: errorBody("FEEDBACK_BAD_REPORT", "Feedback report is invalid.") };
    }
    const parsed = parseFeedbackReportDraft(redactedPreview.report);
    if (!parsed.ok) {
      return { status: 400, body: errorBody("FEEDBACK_BAD_REPORT", parsed.errors.join("; ")) };
    }
    const item = service(deps).submit({
      report: parsed.value,
      provenance: redactedPreview.provenance,
    });
    return { status: 201, body: { receipt: item.receipt, status: item.review.status } };
  });
}

export function handleFeedbackIntakeList(_ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  try {
    return { status: 200, body: { items: service(deps).list() } };
  } catch (error) {
    return toRouteError(error);
  }
}

export function handleFeedbackIntakeGet(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  try {
    const intakeId = ctx.params.intakeId;
    if (intakeId === undefined || intakeId.trim().length === 0) {
      return {
        status: 400,
        body: errorBody("FEEDBACK_BAD_REQUEST", "Feedback intake id is required."),
      };
    }
    const item = service(deps).get(intakeId);
    if (item === undefined) {
      return {
        status: 404,
        body: errorBody("FEEDBACK_NOT_FOUND", "Feedback intake item not found."),
      };
    }
    return { status: 200, body: item };
  } catch (error) {
    return toRouteError(error);
  }
}

export async function handleFeedbackReview(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return guarded(async () => {
    const intakeId = ctx.params.intakeId;
    if (intakeId === undefined || intakeId.trim().length === 0) {
      return {
        status: 400,
        body: errorBody("FEEDBACK_BAD_REQUEST", "Feedback intake id is required."),
      };
    }
    const body = await readJsonObject(ctx.req);
    const reviewInput = reviewInputFromBody(intakeId, body);
    if (reviewInput === undefined) {
      return {
        status: 400,
        body: errorBody("FEEDBACK_BAD_ACTION", "A valid review action is required."),
      };
    }
    return {
      status: 200,
      body: service(deps).review(reviewInput),
    };
  });
}

export async function handleFeedbackCreateGithubIssue(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return guarded(async () => {
    const intakeId = ctx.params.intakeId;
    if (intakeId === undefined || intakeId.trim().length === 0) {
      return {
        status: 400,
        body: errorBody("FEEDBACK_BAD_REQUEST", "Feedback intake id is required."),
      };
    }
    if (deps.feedbackGithubIssueCreator === undefined) {
      return {
        status: 503,
        body: errorBody("FEEDBACK_GITHUB_UNAVAILABLE", "GitHub issue creation is not configured."),
      };
    }
    const item = service(deps).get(intakeId);
    if (item === undefined) {
      return {
        status: 404,
        body: errorBody("FEEDBACK_NOT_FOUND", "Feedback intake item not found."),
      };
    }
    const draft = buildGithubIssueDraftForFeedback(item);
    const issue = await deps.feedbackGithubIssueCreator.createIssue(draft);
    return {
      status: 201,
      body: service(deps).markGithubCreated(intakeId, issue, "github-app"),
    };
  });
}

export const FEEDBACK_INTAKE_ROUTE_GROUP: readonly RouteDefinition[] = [
  { method: "POST", pattern: "/api/feedback/preview", handler: handleFeedbackPreview },
  { method: "POST", pattern: "/api/feedback/submit", handler: handleFeedbackSubmit },
  { method: "GET", pattern: "/api/feedback/intake", handler: handleFeedbackIntakeList },
  { method: "GET", pattern: "/api/feedback/intake/:intakeId", handler: handleFeedbackIntakeGet },
  {
    method: "POST",
    pattern: "/api/feedback/intake/:intakeId/review",
    handler: handleFeedbackReview,
  },
  {
    method: "POST",
    pattern: "/api/feedback/intake/:intakeId/github-issue",
    handler: handleFeedbackCreateGithubIssue,
  },
];
