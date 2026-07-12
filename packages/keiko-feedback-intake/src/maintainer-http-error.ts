import { MaintainerAuthError } from "./maintainer-auth.js";
import { FeedbackReviewError, type FeedbackReviewErrorCode } from "./feedback-review-types.js";
import { FeedbackPublicationError } from "./feedback-publication-types.js";
import type { MaintainerDiagnosticCategory } from "./maintainer-http-response.js";

export class MaintainerRequestError extends Error {}

export interface MaintainerErrorMapping {
  readonly status: 400 | 403 | 404 | 409 | 422 | 503;
  readonly category: MaintainerDiagnosticCategory;
}

const DOMAIN_ERROR_MAPPING: Readonly<Record<FeedbackReviewErrorCode, MaintainerErrorMapping>> = {
  "not-found": { status: 404, category: "not-found" },
  "cas-mismatch": { status: 409, category: "conflict" },
  "idempotency-mismatch": { status: 409, category: "conflict" },
  "invalid-transition": { status: 409, category: "conflict" },
  "invalid-duplicate-target": { status: 409, category: "conflict" },
  "invalid-legal-hold": { status: 422, category: "invalid-domain" },
  "invalid-actor": { status: 422, category: "invalid-domain" },
  "invalid-request": { status: 400, category: "invalid-domain" },
  "payload-expired": { status: 422, category: "invalid-domain" },
  "payload-digest-drift": { status: 503, category: "dependency-unavailable" },
};

export function mapMaintainerError(error: unknown): MaintainerErrorMapping {
  if (error instanceof MaintainerRequestError) {
    return { status: 400, category: "invalid-domain" };
  }
  if (error instanceof MaintainerAuthError) {
    return error.code === "invalid-callback"
      ? { status: 400, category: "invalid-domain" }
      : { status: 403, category: "invalid-domain" };
  }
  if (error instanceof FeedbackPublicationError) return mapPublicationError(error);
  return error instanceof FeedbackReviewError
    ? DOMAIN_ERROR_MAPPING[error.code]
    : { status: 503, category: "dependency-unavailable" };
}

function mapPublicationError(error: FeedbackPublicationError): MaintainerErrorMapping {
  if (error.code === "permission-denied") return { status: 403, category: "invalid-domain" };
  if (error.code === "not-found" || error.code === "payload-private") {
    return { status: 404, category: "not-found" };
  }
  if (error.code === "invalid-request") return { status: 400, category: "invalid-domain" };
  if (error.code === "invalid-actor" || error.code === "payload-expired") {
    return { status: 422, category: "invalid-domain" };
  }
  if (
    error.code === "cas-mismatch" ||
    error.code === "idempotency-mismatch" ||
    error.code === "invalid-transition" ||
    error.code === "target-policy-drift" ||
    error.code === "projection-drift"
  ) {
    return { status: 409, category: "conflict" };
  }
  return { status: 503, category: "dependency-unavailable" };
}
