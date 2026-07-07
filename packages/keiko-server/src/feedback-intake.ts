import { sha256Hex } from "@oscharko-dev/keiko-security";
import {
  buildFeedbackGithubIssueDraft,
  type FeedbackGithubIssueDraft,
  type FeedbackGithubIssueRef,
  type FeedbackIntakeItem,
  type FeedbackIntakeReceipt,
  type FeedbackIntakeStatus,
  type FeedbackRedactionProvenance,
  type FeedbackReportDraft,
  type FeedbackReviewAction,
  type FeedbackReviewEvent,
  type FeedbackReviewState,
  feedbackReviewStatusAfter,
  FEEDBACK_INTAKE_SCHEMA_VERSION,
} from "@oscharko-dev/keiko-contracts/feedback-intake";

export class FeedbackIntakeError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "FeedbackIntakeError";
  }
}

export interface FeedbackSubmitInput {
  readonly report: FeedbackReportDraft;
  readonly provenance: FeedbackRedactionProvenance;
}

export interface FeedbackReviewInput {
  readonly intakeId: string;
  readonly action: FeedbackReviewAction;
  readonly actor: string;
  readonly reason?: string | undefined;
  readonly duplicateOf?: string | undefined;
}

export interface FeedbackGithubIssueCreator {
  readonly createIssue: (draft: FeedbackGithubIssueDraft) => Promise<FeedbackGithubIssueRef>;
}

export interface FeedbackIntakeService {
  readonly submit: (input: FeedbackSubmitInput) => FeedbackIntakeItem;
  readonly list: () => readonly FeedbackIntakeItem[];
  readonly get: (intakeId: string) => FeedbackIntakeItem | undefined;
  readonly review: (input: FeedbackReviewInput) => FeedbackIntakeItem;
  readonly markGithubCreated: (
    intakeId: string,
    issue: FeedbackGithubIssueRef,
    actor: string,
  ) => FeedbackIntakeItem;
}

export interface FeedbackIntakeServiceOptions {
  readonly now?: (() => string) | undefined;
  readonly newId?: (() => string) | undefined;
  readonly rateLimitWindowMs?: number | undefined;
  readonly rateLimitMaxSubmissions?: number | undefined;
}

function defaultNow(): string {
  return new Date().toISOString();
}

function defaultId(): string {
  const suffix = Math.random().toString(36).slice(2, 12);
  return `fb_${Date.now().toString(36)}_${suffix}`;
}

function dedupeKeyFor(report: FeedbackReportDraft): string {
  return sha256Hex(
    JSON.stringify({
      category: report.category,
      severity: report.severity,
      title: report.title.toLowerCase(),
      description: report.description.toLowerCase(),
      featureArea: report.featureArea?.toLowerCase(),
    }),
  ).slice(0, 32);
}

function receipt(input: {
  readonly intakeId: string;
  readonly status: FeedbackIntakeStatus;
  readonly dedupeKey: string;
  readonly submittedAt: string;
}): FeedbackIntakeReceipt {
  return {
    schemaVersion: FEEDBACK_INTAKE_SCHEMA_VERSION,
    intakeId: input.intakeId,
    status: input.status,
    dedupeKey: input.dedupeKey,
    submittedAt: input.submittedAt,
  };
}

function event(
  action: FeedbackReviewEvent["action"],
  actor: string,
  at: string,
  reason?: string,
): FeedbackReviewEvent {
  return {
    action,
    actor,
    at,
    ...(reason === undefined || reason.trim().length === 0 ? {} : { reason: reason.trim() }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRedactionProvenance(
  provenance: unknown,
): asserts provenance is FeedbackRedactionProvenance {
  if (
    !isRecord(provenance) ||
    provenance.engine !== "keiko-feedback-redaction" ||
    provenance.schemaVersion !== FEEDBACK_INTAKE_SCHEMA_VERSION ||
    !Array.isArray(provenance.blockedReasons)
  ) {
    throw new FeedbackIntakeError(
      "FEEDBACK_MISSING_REDACTION_PROVENANCE",
      "Feedback intake requires Keiko redaction provenance.",
      400,
    );
  }
  if (provenance.blockedReasons.length > 0) {
    throw new FeedbackIntakeError(
      "FEEDBACK_UNSAFE_PAYLOAD",
      "Feedback report contains blocked payload classes.",
      409,
    );
  }
}

interface FeedbackIntakeServiceState {
  readonly now: () => string;
  readonly newId: () => string;
  readonly rateLimitWindowMs: number;
  readonly rateLimitMaxSubmissions: number;
  readonly records: Map<string, FeedbackIntakeItem>;
  readonly submissions: number[];
}

function withStatus(item: FeedbackIntakeItem, status: FeedbackIntakeStatus): FeedbackIntakeItem {
  return {
    ...item,
    receipt: { ...item.receipt, status },
    review: { ...item.review, status },
  };
}

function getOrThrow(state: FeedbackIntakeServiceState, intakeId: string): FeedbackIntakeItem {
  const item = state.records.get(intakeId);
  if (item === undefined) {
    throw new FeedbackIntakeError("FEEDBACK_NOT_FOUND", "Feedback intake item not found.", 404);
  }
  return item;
}

function recordSubmissionForRateLimit(
  state: FeedbackIntakeServiceState,
  submittedAt: string,
): void {
  const submittedAtMs = Date.parse(submittedAt);
  if (!Number.isFinite(submittedAtMs)) return;
  const cutoff = submittedAtMs - state.rateLimitWindowMs;
  while (state.submissions.length > 0 && (state.submissions[0] ?? 0) < cutoff) {
    state.submissions.shift();
  }
  if (state.submissions.length >= state.rateLimitMaxSubmissions) {
    throw new FeedbackIntakeError(
      "FEEDBACK_RATE_LIMITED",
      "Feedback intake rate limit exceeded.",
      429,
    );
  }
  state.submissions.push(submittedAtMs);
}

function createSubmittedItem(
  input: FeedbackSubmitInput,
  intakeId: string,
  submittedAt: string,
  duplicate: FeedbackIntakeItem | undefined,
): FeedbackIntakeItem {
  const status: FeedbackIntakeStatus = duplicate === undefined ? "new" : "duplicate";
  return {
    schemaVersion: FEEDBACK_INTAKE_SCHEMA_VERSION,
    receipt: receipt({ intakeId, status, dedupeKey: dedupeKeyFor(input.report), submittedAt }),
    report: input.report,
    provenance: input.provenance,
    review: {
      status,
      events: [
        event(
          "submit",
          "feedback-intake",
          submittedAt,
          duplicate === undefined ? undefined : `Duplicate of ${duplicate.receipt.intakeId}`,
        ),
      ],
      ...(duplicate === undefined ? {} : { duplicateOf: duplicate.receipt.intakeId }),
    },
  };
}

function submitFeedback(
  state: FeedbackIntakeServiceState,
  input: FeedbackSubmitInput,
): FeedbackIntakeItem {
  assertRedactionProvenance(input.provenance);
  const submittedAt = state.now();
  recordSubmissionForRateLimit(state, submittedAt);
  const dedupeKey = dedupeKeyFor(input.report);
  const duplicate = [...state.records.values()].find(
    (item) => item.receipt.dedupeKey === dedupeKey,
  );
  const item = createSubmittedItem(input, state.newId(), submittedAt, duplicate);
  state.records.set(item.receipt.intakeId, item);
  return item;
}

function listFeedback(state: FeedbackIntakeServiceState): readonly FeedbackIntakeItem[] {
  return [...state.records.values()].sort((a, b) =>
    a.receipt.submittedAt.localeCompare(b.receipt.submittedAt),
  );
}

function duplicateOfForReview(
  current: FeedbackIntakeItem,
  input: FeedbackReviewInput,
): Pick<FeedbackReviewState, "duplicateOf"> {
  if (input.action === "mark-duplicate") return { duplicateOf: input.duplicateOf };
  return current.review.duplicateOf === undefined
    ? {}
    : { duplicateOf: current.review.duplicateOf };
}

function reviewFeedback(
  state: FeedbackIntakeServiceState,
  input: FeedbackReviewInput,
): FeedbackIntakeItem {
  const current = getOrThrow(state, input.intakeId);
  const nextStatus = feedbackReviewStatusAfter(current.review.status, input.action);
  if (nextStatus === undefined) {
    throw new FeedbackIntakeError(
      "FEEDBACK_REVIEW_TRANSITION_NOT_ALLOWED",
      "The requested feedback review transition is not allowed.",
      409,
    );
  }
  if (input.action === "mark-duplicate" && input.duplicateOf === undefined) {
    throw new FeedbackIntakeError(
      "FEEDBACK_DUPLICATE_TARGET_REQUIRED",
      "A duplicate target is required.",
      400,
    );
  }
  const next: FeedbackIntakeItem = {
    ...withStatus(current, nextStatus),
    review: {
      status: nextStatus,
      events: [
        ...current.review.events,
        event(input.action, input.actor, state.now(), input.reason),
      ],
      ...duplicateOfForReview(current, input),
    },
  };
  state.records.set(input.intakeId, next);
  return next;
}

function markFeedbackGithubCreated(
  state: FeedbackIntakeServiceState,
  intakeId: string,
  issue: FeedbackGithubIssueRef,
  actor: string,
): FeedbackIntakeItem {
  const current = getOrThrow(state, intakeId);
  if (current.review.status !== "approved-for-github") {
    throw new FeedbackIntakeError(
      "FEEDBACK_GITHUB_REVIEW_REQUIRED",
      "Feedback must be approved before creating a GitHub Issue.",
      409,
    );
  }
  const next: FeedbackIntakeItem = {
    ...withStatus(current, "github-created"),
    githubIssue: issue,
    review: {
      ...current.review,
      status: "github-created",
      events: [...current.review.events, event("github-create", actor, state.now(), issue.url)],
    },
  };
  state.records.set(intakeId, next);
  return next;
}

export function createInMemoryFeedbackIntakeService(
  options: FeedbackIntakeServiceOptions = {},
): FeedbackIntakeService {
  const state: FeedbackIntakeServiceState = {
    now: options.now ?? defaultNow,
    newId: options.newId ?? defaultId,
    rateLimitWindowMs: options.rateLimitWindowMs ?? 60_000,
    rateLimitMaxSubmissions: options.rateLimitMaxSubmissions ?? 30,
    records: new Map<string, FeedbackIntakeItem>(),
    submissions: [],
  };
  return {
    submit(input): FeedbackIntakeItem {
      return submitFeedback(state, input);
    },
    list(): readonly FeedbackIntakeItem[] {
      return listFeedback(state);
    },
    get(intakeId): FeedbackIntakeItem | undefined {
      return state.records.get(intakeId);
    },
    review(input): FeedbackIntakeItem {
      return reviewFeedback(state, input);
    },
    markGithubCreated(intakeId, issue, actor): FeedbackIntakeItem {
      return markFeedbackGithubCreated(state, intakeId, issue, actor);
    },
  };
}

export function buildGithubIssueDraftForFeedback(
  item: FeedbackIntakeItem,
): FeedbackGithubIssueDraft {
  if (item.review.status !== "approved-for-github") {
    throw new FeedbackIntakeError(
      "FEEDBACK_GITHUB_REVIEW_REQUIRED",
      "Feedback must be approved before creating a GitHub Issue.",
      409,
    );
  }
  return buildFeedbackGithubIssueDraft(item);
}
