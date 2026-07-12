import { MaintainerAuthError } from "./maintainer-auth.js";
import { FeedbackReviewError, type FeedbackReviewErrorCode } from "./feedback-review-types.js";
import {
  FeedbackPublicationError,
  type FeedbackPublicationErrorCode,
} from "./feedback-publication-types.js";
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

const PUBLICATION_ERROR_MAPPING: Readonly<
  Partial<Record<FeedbackPublicationErrorCode, MaintainerErrorMapping>>
> = {
  "permission-denied": { status: 403, category: "invalid-domain" },
  "not-found": { status: 404, category: "not-found" },
  "payload-private": { status: 404, category: "not-found" },
  "invalid-request": { status: 400, category: "invalid-domain" },
  "invalid-actor": { status: 422, category: "invalid-domain" },
  "payload-expired": { status: 422, category: "invalid-domain" },
  "cas-mismatch": { status: 409, category: "conflict" },
  "idempotency-mismatch": { status: 409, category: "conflict" },
  "invalid-transition": { status: 409, category: "conflict" },
  "target-policy-drift": { status: 409, category: "conflict" },
  "projection-drift": { status: 409, category: "conflict" },
};

const DEPENDENCY_UNAVAILABLE: MaintainerErrorMapping = {
  status: 503,
  category: "dependency-unavailable",
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
  return PUBLICATION_ERROR_MAPPING[error.code] ?? DEPENDENCY_UNAVAILABLE;
}
