import type { Pool } from "pg";

import type {
  FeedbackFlowResult,
  NegativeResult,
  NegativeScenario,
  PreparedFeedback,
} from "./feedback-flow-2077-common.js";
import {
  createFeedbackFlowHarness,
  payloadCount,
  preview,
  previewAndSubmit,
  safeDraft,
  storedPayload,
  submitPrepared,
} from "./feedback-flow-2077-infrastructure.js";
import { publish } from "./feedback-flow-2077-publication.js";

export type { FeedbackFlowResult } from "./feedback-flow-2077-common.js";

interface NegativeCaseContext {
  readonly pool: Pool;
  readonly schema: string;
  readonly origin: string;
  readonly scopedPool: Parameters<typeof publish>[0];
  readonly installationScopedPool: Parameters<typeof publish>[1];
}

export async function runFeedbackFlow(databaseUrl: string): Promise<FeedbackFlowResult> {
  const harness = await createFeedbackFlowHarness(databaseUrl);
  try {
    const prepared = await previewAndSubmit(harness.bff.origin);
    const payload = await storedPayload(harness.pool, harness.schema);
    const transport = await publish(harness.scopedPool, harness.installationScopedPool, payload);
    const linkage = await publicIssueLinkage(harness.pool, harness.schema);
    return flowResult(
      prepared,
      payload.canonicalBytes,
      payload.exactBodySha256,
      transport.createdIssueCount(),
      linkage,
    );
  } finally {
    await harness.close();
  }
}

export async function runFeedbackNegativeCase(
  databaseUrl: string,
  scenario: NegativeScenario,
): Promise<NegativeResult> {
  const harness = await createFeedbackFlowHarness(databaseUrl, intakeMode(scenario));
  try {
    return await negativeScenarioResult(
      {
        pool: harness.pool,
        schema: harness.schema,
        origin: harness.bff.origin,
        scopedPool: harness.scopedPool,
        installationScopedPool: harness.installationScopedPool,
      },
      scenario,
    );
  } finally {
    await harness.close();
  }
}

function intakeMode(scenario: NegativeScenario): Parameters<typeof createFeedbackFlowHarness>[1] {
  if (scenario === "unavailable") return { kind: "unavailable" };
  if (scenario === "rate-limited") return { kind: "available", perIdentity: 1 };
  return { kind: "available" };
}

function flowResult(
  prepared: PreparedFeedback,
  canonicalBytes: Buffer,
  exactBodySha256: string,
  createdIssues: number,
  linkage: { readonly number: number; readonly url: string },
): FeedbackFlowResult {
  return {
    createdIssues,
    exactBytesPreserved:
      Buffer.from(prepared.canonicalJson).equals(canonicalBytes) &&
      prepared.exactBodySha256 === exactBodySha256,
    publicIssueNumber: linkage.number,
    publicIssueUrl: linkage.url,
  };
}

async function negativeScenarioResult(
  context: NegativeCaseContext,
  scenario: NegativeScenario,
): Promise<NegativeResult> {
  if (scenario === "unsafe") return unsafeResult(context);
  const prepared = await previewSafeFeedback(context.origin);
  if (scenario === "unavailable") return unavailableResult(context, prepared);
  if (scenario === "rate-limited") return rateLimitedResult(context, prepared);
  return githubPermissionResult(context, prepared);
}

async function unsafeResult(context: NegativeCaseContext): Promise<NegativeResult> {
  const response = await preview(context.origin, {
    ...safeDraft(),
    title: "Exploit: session validation",
    description: "A proof-of-concept exploit is reproducible.",
  });
  return {
    createdIssues: 0,
    persistedPayloads: await payloadCount(context.pool, context.schema),
    rejectedAttemptDidNotPersist: true,
    safeTerminalState: response.status === 422 && !(await response.text()).includes("exploit"),
  };
}

async function previewSafeFeedback(origin: string): Promise<PreparedFeedback> {
  const response = await preview(origin);
  if (!response.ok) throw new Error("Expected a safe feedback preview");
  return response.json() as Promise<PreparedFeedback>;
}

async function unavailableResult(
  context: NegativeCaseContext,
  prepared: PreparedFeedback,
): Promise<NegativeResult> {
  const submitted = await submitPrepared(context.origin, prepared);
  const body = await submitted.text();
  return {
    createdIssues: 0,
    persistedPayloads: await payloadCount(context.pool, context.schema),
    rejectedAttemptDidNotPersist: true,
    safeTerminalState: submitted.status === 502 && !body.includes(prepared.canonicalJson),
  };
}

async function rateLimitedResult(
  context: NegativeCaseContext,
  prepared: PreparedFeedback,
): Promise<NegativeResult> {
  const accepted = await submitPrepared(context.origin, prepared);
  const countBeforeLimited = await payloadCount(context.pool, context.schema);
  const limited = await submitPrepared(context.origin, prepared);
  const countAfterLimited = await payloadCount(context.pool, context.schema);
  const acceptedText = await accepted.text();
  const limitedText = await limited.text();
  const acceptedBody = JSON.parse(acceptedText) as { outcome?: string };
  const limitedBody = JSON.parse(limitedText) as { outcome?: string };
  if (acceptedBody.outcome !== "accepted" || limitedBody.outcome !== "rate-limited") {
    throw new Error(`Rate-limit outcomes: ${acceptedText}/${limitedText}`);
  }
  return {
    createdIssues: 0,
    persistedPayloads: countAfterLimited,
    rejectedAttemptDidNotPersist: countBeforeLimited === countAfterLimited,
    safeTerminalState: true,
  };
}

async function githubPermissionResult(
  context: NegativeCaseContext,
  prepared: PreparedFeedback,
): Promise<NegativeResult> {
  const accepted = await submitPrepared(context.origin, prepared);
  const acceptedText = await accepted.text();
  const acceptedBody = JSON.parse(acceptedText) as { outcome?: string };
  if (acceptedBody.outcome !== "accepted")
    throw new Error(`Expected publication scenario admission: ${acceptedText}`);
  const payload = await storedPayload(context.pool, context.schema);
  const transport = await publish(
    context.scopedPool,
    context.installationScopedPool,
    payload,
    true,
  );
  const status = await publicationStatus(context.pool, context.schema);
  return {
    createdIssues: transport.createdIssueCount(),
    persistedPayloads: await payloadCount(context.pool, context.schema),
    rejectedAttemptDidNotPersist: true,
    safeTerminalState: status.status === "manual-reconciliation" && status.count === "0",
  };
}

async function publicIssueLinkage(
  pool: Pool,
  schema: string,
): Promise<{ readonly number: number; readonly url: string }> {
  const result = await pool.query<{ readonly issue_number: number }>(
    `SELECT github_issue_number AS issue_number FROM "${schema}".feedback_github_issue_linkage`,
  );
  const linkage = result.rows[0];
  if (linkage === undefined) throw new Error("Expected one persisted public issue linkage");
  return {
    number: linkage.issue_number,
    url: `https://github.com/keiko-feedback/public-findings/issues/${String(linkage.issue_number)}`,
  };
}

async function publicationStatus(
  pool: Pool,
  schema: string,
): Promise<{ readonly status: string; readonly count: string }> {
  const result = await pool.query<{ readonly status: string; readonly count: string }>(
    `SELECT outbox.status,count(linkage.item_id)::text AS count FROM "${schema}".feedback_publication_outbox outbox JOIN "${schema}".feedback_publication_preparations prep ON prep.id=outbox.preparation_id LEFT JOIN "${schema}".feedback_github_issue_linkage linkage ON linkage.item_id=prep.item_id GROUP BY outbox.status`,
  );
  const status = result.rows[0];
  if (status === undefined) throw new Error("Expected a publication status");
  return status;
}
