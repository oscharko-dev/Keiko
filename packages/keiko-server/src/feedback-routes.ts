import { Buffer } from "node:buffer";

import { FEEDBACK_REPORT_LIMITS } from "@oscharko-dev/keiko-contracts/feedback-report";
import {
  isFeedbackReceiptExpiryV1,
  isFeedbackReceiptIdV1,
  isFeedbackReceiptSecretV1,
} from "@oscharko-dev/keiko-contracts/feedback-intake";
import {
  prepareFeedbackReportV1,
  verifyCanonicalFeedbackReportBodyV1,
} from "@oscharko-dev/keiko-security/feedback-report";
import { feedbackSecurityRoutingDecisionV1 } from "@oscharko-dev/keiko-security/feedback-security-routing";

import { currentRedactionSecrets, type UiHandlerDeps } from "./deps.js";
import { decodeFeedbackDraftAttachmentEnvelopes } from "./feedback-attachment-envelope.js";
import { readStrictFeedbackJsonObject } from "./feedback-request-decoder.js";
import type {
  FeedbackSubmissionReceipt,
  FeedbackSubmissionUiOutcome,
} from "./feedback-submission.js";
import { errorBody, type RouteContext, type RouteDefinition, type RouteResult } from "./routes.js";

const MAX_FEEDBACK_PREVIEW_REQUEST_BYTES = FEEDBACK_REPORT_LIMITS.canonicalBodyBytes * 2;
const MAX_FEEDBACK_SUBMIT_REQUEST_BYTES = FEEDBACK_REPORT_LIMITS.canonicalBodyBytes * 2 + 1_024;
const FEEDBACK_SUBMIT_KEYS = new Set(["canonicalJson", "exactBodySha256"]);
const TEXT_ENCODER = new TextEncoder();

function isRouteResult(value: unknown): value is RouteResult {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof Reflect.get(value, "status") === "number" &&
    Reflect.has(value, "body")
  );
}

function feedbackRedactionPolicy(deps: UiHandlerDeps): {
  readonly sensitiveLiterals: readonly string[];
} {
  return {
    sensitiveLiterals:
      deps.gatewayConfig === undefined
        ? (deps.redactionSecrets ?? [])
        : currentRedactionSecrets(deps),
  };
}

interface FeedbackSubmitEnvelope {
  readonly canonicalJson: string;
  readonly exactBodySha256: string;
}

function feedbackSubmitEnvelope(
  value: Record<string, unknown>,
): FeedbackSubmitEnvelope | undefined {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== FEEDBACK_SUBMIT_KEYS.size ||
    !keys.every((key) => typeof key === "string" && FEEDBACK_SUBMIT_KEYS.has(key)) ||
    typeof value.canonicalJson !== "string" ||
    typeof value.exactBodySha256 !== "string"
  ) {
    return undefined;
  }
  if (
    value.canonicalJson.length > FEEDBACK_REPORT_LIMITS.canonicalBodyBytes ||
    Buffer.byteLength(value.canonicalJson, "utf8") > FEEDBACK_REPORT_LIMITS.canonicalBodyBytes
  ) {
    return undefined;
  }
  return {
    canonicalJson: value.canonicalJson,
    exactBodySha256: value.exactBodySha256,
  };
}

function submissionOutcome(outcome: FeedbackSubmissionUiOutcome): RouteResult {
  return { status: 200, body: outcome };
}

type FeedbackRevalidationOutcome = "valid" | "rejected" | "security";

function revalidationOutcome(outcome: FeedbackRevalidationOutcome): RouteResult {
  return { status: 200, body: { outcome } };
}

function routesToPrivateSecurity(
  report: Parameters<typeof feedbackSecurityRoutingDecisionV1>[0],
): boolean {
  return feedbackSecurityRoutingDecisionV1(report).route === "private-security-advisory";
}

function uncertainSubmissionOutcome(): RouteResult {
  return {
    status: 502,
    body: errorBody("FEEDBACK_SUBMIT_FAILED", "Feedback submission could not be confirmed."),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === "string" && expected.includes(key))
  );
}

function acceptedReceipt(value: unknown): FeedbackSubmissionReceipt | undefined {
  const fields = record(value);
  if (fields === undefined) return undefined;
  if (!hasExactKeys(fields, ["receiptId", "receiptSecret", "expiresAt"])) return undefined;
  if (
    !isFeedbackReceiptIdV1(fields.receiptId) ||
    !isFeedbackReceiptSecretV1(fields.receiptSecret) ||
    !isFeedbackReceiptExpiryV1(fields.expiresAt)
  ) {
    return undefined;
  }
  return {
    receiptId: fields.receiptId,
    receiptSecret: fields.receiptSecret,
    expiresAt: fields.expiresAt,
  };
}

function acceptedSubmissionOutcome(value: unknown): FeedbackSubmissionUiOutcome | undefined {
  const outcome = record(value);
  if (outcome === undefined || !hasExactKeys(outcome, ["outcome", "receipt"])) return undefined;
  const receipt = acceptedReceipt(outcome.receipt);
  return outcome.outcome === "accepted" && receipt !== undefined
    ? { outcome: "accepted", receipt }
    : undefined;
}

function contentFreeSubmissionOutcome(value: unknown): value is "rejected" | "rate-limited" {
  return value === "rejected" || value === "rate-limited";
}

async function handleFeedbackPreview(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  const draft = await readStrictFeedbackJsonObject(ctx.req, MAX_FEEDBACK_PREVIEW_REQUEST_BYTES);
  if (isRouteResult(draft)) return draft;
  const decoded = decodeFeedbackDraftAttachmentEnvelopes(draft);
  if (!decoded.ok) {
    const limit = decoded.reason === "limit";
    return {
      status: limit ? 413 : 400,
      body: errorBody(
        limit ? "FEEDBACK_ATTACHMENT_LIMIT" : "FEEDBACK_ATTACHMENT_ENVELOPE_INVALID",
        limit
          ? "Feedback attachment limits were exceeded."
          : "The feedback attachment envelope is invalid.",
      ),
    };
  }

  const prepared = prepareFeedbackReportV1(decoded.value, feedbackRedactionPolicy(deps));
  if (!prepared.ok) {
    return {
      status: 422,
      body: {
        ...errorBody("FEEDBACK_PREVIEW_REJECTED", "The feedback draft needs attention."),
        errors: prepared.errors,
      },
    };
  }
  if (routesToPrivateSecurity(prepared.value.report)) {
    return {
      status: 422,
      body: errorBody("FEEDBACK_SECURITY_REPORT", "Use the private security reporting route."),
    };
  }

  return {
    status: 200,
    body: {
      report: prepared.value.report,
      canonicalJson: prepared.value.canonicalJson,
      exactBodySha256: prepared.value.exactBodySha256,
      dispositionSidecar: prepared.value.dispositionSidecar,
    },
  };
}

async function handleFeedbackSubmit(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  const body = await readStrictFeedbackJsonObject(ctx.req, MAX_FEEDBACK_SUBMIT_REQUEST_BYTES);
  if (isRouteResult(body)) return body;
  const envelope = feedbackSubmitEnvelope(body);
  if (envelope === undefined) {
    return {
      status: 400,
      body: errorBody(
        "FEEDBACK_SUBMIT_ENVELOPE_INVALID",
        "The feedback submission envelope is invalid.",
      ),
    };
  }

  const verified = verifyCanonicalFeedbackReportBodyV1({
    bytes: TEXT_ENCODER.encode(envelope.canonicalJson),
    claimedDigest: envelope.exactBodySha256,
    policy: feedbackRedactionPolicy(deps),
  });
  if (!verified.ok) return submissionOutcome({ outcome: "rejected" });
  if (routesToPrivateSecurity(verified.value.report))
    return submissionOutcome({ outcome: "rejected" });
  if (deps.feedbackSubmission === undefined) return submissionOutcome({ outcome: "unavailable" });
  try {
    const outcome: unknown = await deps.feedbackSubmission.submit(verified.value);
    if (contentFreeSubmissionOutcome(outcome)) return submissionOutcome({ outcome });
    const accepted = acceptedSubmissionOutcome(outcome);
    return accepted === undefined ? uncertainSubmissionOutcome() : submissionOutcome(accepted);
  } catch {
    return uncertainSubmissionOutcome();
  }
}

async function handleFeedbackRevalidate(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readStrictFeedbackJsonObject(ctx.req, MAX_FEEDBACK_SUBMIT_REQUEST_BYTES);
  if (isRouteResult(body)) return body;
  const envelope = feedbackSubmitEnvelope(body);
  if (envelope === undefined) {
    return {
      status: 400,
      body: errorBody(
        "FEEDBACK_REVALIDATE_ENVELOPE_INVALID",
        "The feedback revalidation envelope is invalid.",
      ),
    };
  }
  const verified = verifyCanonicalFeedbackReportBodyV1({
    bytes: TEXT_ENCODER.encode(envelope.canonicalJson),
    claimedDigest: envelope.exactBodySha256,
    policy: feedbackRedactionPolicy(deps),
  });
  if (!verified.ok) return revalidationOutcome("rejected");
  return revalidationOutcome(routesToPrivateSecurity(verified.value.report) ? "security" : "valid");
}

export const FEEDBACK_ROUTE_GROUP = [
  { method: "POST", pattern: "/api/feedback/preview", handler: handleFeedbackPreview },
  { method: "POST", pattern: "/api/feedback/submit", handler: handleFeedbackSubmit },
  { method: "POST", pattern: "/api/feedback/revalidate", handler: handleFeedbackRevalidate },
] as const satisfies readonly RouteDefinition[];
