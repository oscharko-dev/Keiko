import { describe, expect, it } from "vitest";
import {
  validateAtlassianConnectorActionExecutionResult,
  validateAtlassianConnectorActivityRecord,
  validateAtlassianConnectorDescriptor,
  validateAtlassianConnectorPendingApproval,
  validateAtlassianConnectorPodSource,
  validateAtlassianSyncBounds,
  validateAtlassianSyncChangeSummary,
  validateAtlassianSyncJobState,
  validateAtlassianSyncScope,
  validateJiraLiveSearchRequest,
  validateJiraLiveSearchResult,
  type AtlassianConnectorValidation,
} from "./atlassian-connectors-validation.js";
import {
  ATLASSIAN_CONNECTOR_AUTHORITY_FAILURE_REASONS,
  ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS,
  ATLASSIAN_JQL_MAX_CHARS,
  ATLASSIAN_LIVE_SEARCH_MAX_RESULTS,
  ATLASSIAN_SYNC_TERMINAL_STATUSES,
  type AtlassianConnectorActivityRecord,
  type AtlassianConnectorDescriptor,
  type AtlassianConnectorPodSource,
  type AtlassianSyncBounds,
  type AtlassianSyncChangeSummary,
  type AtlassianSyncJobState,
  type AtlassianSyncScope,
  type AtlassianSyncTerminalStatus,
} from "./atlassian-connectors.js";

const DIGEST = "a".repeat(64);

function errorsOf<T>(result: AtlassianConnectorValidation<T>): readonly string[] {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a validation failure");
  return result.errors;
}

function expectOk<T>(result: AtlassianConnectorValidation<T>): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.errors.join("; ")}`);
  return result.value;
}

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    id: "conn-jira-prod",
    provider: "jira",
    displayName: "Jira (Prod)",
    baseUrl: "https://example.atlassian.net",
    authScheme: "basic-api-token",
    authRef: "atlassian-cred:AbCdEfGhIjKlMnOpQrStUv",
    ...overrides,
  };
}

function bounds(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    maxItems: 2_000,
    maxBytes: 50_000_000,
    maxDurationMs: 900_000,
    maxConcurrency: 4,
    ...overrides,
  };
}

function confluenceScope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { provider: "confluence", spaceKeys: ["ENG", "DOCS"], bounds: bounds(), ...overrides };
}

function jiraScope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { provider: "jira", projectKeys: ["PROJ", "OPS"], bounds: bounds(), ...overrides };
}

function changeCounts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    addedItems: 3,
    changedItems: 2,
    removedItems: 1,
    unchangedItems: 10,
    failedItems: 0,
    deniedItems: 0,
    ...overrides,
  };
}

function changeSummary(
  outcome: AtlassianSyncTerminalStatus = "succeeded",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const counts =
    outcome === "failed" || outcome === "cancelled"
      ? changeCounts({ addedItems: 0, changedItems: 0, removedItems: 0 })
      : changeCounts();
  return {
    schemaVersion: "1",
    outcome,
    counts,
    fingerprintSetDigest: DIGEST,
    completedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function progress(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enumeratedItems: 16,
    fetchedItems: 16,
    indexedItems: 15,
    skippedItems: 0,
    failedItems: 1,
    ...overrides,
  };
}

function job(status: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const common = {
    schemaVersion: "1",
    status,
    jobId: "job-1",
    connectorId: "conn-jira-prod",
    provider: "jira",
    queuedAt: 1_700_000_000_000,
    progress: progress(),
  };
  if (status === "pending") return { ...common, ...overrides };
  if (status === "running") return { ...common, startedAt: 1_700_000_000_100, ...overrides };
  const terminal = {
    ...common,
    startedAt: 1_700_000_000_100,
    completedAt: 1_700_000_000_900,
    changeSummary: changeSummary(status as AtlassianSyncTerminalStatus),
  };
  if (status === "partial") return { ...terminal, failureReasons: ["rate-limited"], ...overrides };
  if (status === "failed") return { ...terminal, failureReason: "timeout", ...overrides };
  return { ...terminal, ...overrides };
}

function activity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    activityId: "act-1",
    occurredAt: 1_700_000_000_000,
    connectorId: "conn-jira-prod",
    provider: "jira",
    actionType: "add-issue-comment",
    actionClass: "connector-write",
    disposition: "allowed",
    outcome: "succeeded",
    correlationId: "corr-1",
    durationMs: 240,
    ...overrides,
  };
}

function podSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "confluence",
    connectorId: "conn-confluence-prod",
    scopeLabels: ["ENG", "DOCS"],
    ...overrides,
  };
}

describe("validateAtlassianConnectorDescriptor (hostile input)", () => {
  it("accepts a valid descriptor and returns the typed value", () => {
    const value: AtlassianConnectorDescriptor = expectOk(
      validateAtlassianConnectorDescriptor(descriptor()),
    );
    expect(value.provider).toBe("jira");
    expect(value.authRef.startsWith("atlassian-cred:")).toBe(true);
  });

  it("rejects non-object input", () => {
    expect(errorsOf(validateAtlassianConnectorDescriptor(null))).toEqual([
      "descriptor must be an object",
    ]);
    expect(errorsOf(validateAtlassianConnectorDescriptor([])).length).toBeGreaterThan(0);
  });

  it("never carries a secret: any credential-bearing extra field is rejected", () => {
    for (const key of ["secret", "token", "apiToken", "password", "authorization"]) {
      const errors = errorsOf(validateAtlassianConnectorDescriptor(descriptor({ [key]: "x" })));
      expect(errors.some((error) => error.includes(`must not include ${key}`))).toBe(true);
    }
  });

  it.each([
    ["an http base URL", "http://example.atlassian.net"],
    ["a credentialed base URL", "https://user:token@example.atlassian.net"],
    ["a base URL with a query string", "https://example.atlassian.net?token=x"],
    ["a base URL with a fragment", "https://example.atlassian.net#admin"],
  ])("rejects %s", (_label, baseUrl) => {
    const errors = errorsOf(validateAtlassianConnectorDescriptor(descriptor({ baseUrl })));
    expect(errors.some((error) => error.includes("descriptor.baseUrl"))).toBe(true);
  });

  it("rejects unknown enum values, malformed ids, hostile names, and bad auth refs", () => {
    expect(
      errorsOf(validateAtlassianConnectorDescriptor(descriptor({ provider: "bitbucket" }))),
    ).toContain("descriptor.provider must be confluence or jira");
    expect(
      errorsOf(validateAtlassianConnectorDescriptor(descriptor({ authScheme: "oauth" }))),
    ).toContain("descriptor.authScheme must be basic-api-token or bearer-pat");
    expect(
      errorsOf(validateAtlassianConnectorDescriptor(descriptor({ id: "../escape" }))).length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf(validateAtlassianConnectorDescriptor(descriptor({ displayName: "see /etc/passwd" })))
        .length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf(validateAtlassianConnectorDescriptor(descriptor({ authRef: "cred:abc" }))).length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf(validateAtlassianConnectorDescriptor(descriptor({ schemaVersion: "2" }))).length,
    ).toBeGreaterThan(0);
  });
});

describe("validateAtlassianSyncBounds (narrow-only, ADR-0128 D5)", () => {
  it("accepts the declared defaults and narrower values", () => {
    const value: AtlassianSyncBounds = expectOk(validateAtlassianSyncBounds(bounds()));
    expect(value.maxItems).toBe(2_000);
    expectOk(
      validateAtlassianSyncBounds(
        bounds({ maxItems: 1, maxBytes: 1, maxDurationMs: 1, maxConcurrency: 1 }),
      ),
    );
  });

  it("rejects any widening beyond the D5 defaults", () => {
    for (const widened of [
      bounds({ maxItems: 2_001 }),
      bounds({ maxBytes: 50_000_001 }),
      bounds({ maxDurationMs: 900_001 }),
      bounds({ maxConcurrency: 5 }),
    ]) {
      expect(errorsOf(validateAtlassianSyncBounds(widened)).length).toBeGreaterThan(0);
    }
  });

  it("rejects zero, negative, fractional, missing, and unknown fields", () => {
    expect(errorsOf(validateAtlassianSyncBounds(bounds({ maxItems: 0 }))).length).toBeGreaterThan(
      0,
    );
    expect(errorsOf(validateAtlassianSyncBounds(bounds({ maxBytes: -1 }))).length).toBeGreaterThan(
      0,
    );
    expect(
      errorsOf(validateAtlassianSyncBounds(bounds({ maxDurationMs: 1.5 }))).length,
    ).toBeGreaterThan(0);
    const missing = bounds();
    delete missing.maxConcurrency;
    expect(errorsOf(validateAtlassianSyncBounds(missing)).length).toBeGreaterThan(0);
    expect(errorsOf(validateAtlassianSyncBounds(bounds({ maxRequests: 10 })))).toContain(
      "bounds must not include maxRequests",
    );
    expect(errorsOf(validateAtlassianSyncBounds("bounds")).length).toBeGreaterThan(0);
  });
});

describe("validateAtlassianSyncScope (hostile input)", () => {
  it("accepts a valid Confluence scope and a valid Jira scope with opaque JQL", () => {
    const confluence: AtlassianSyncScope = expectOk(validateAtlassianSyncScope(confluenceScope()));
    expect(confluence.provider).toBe("confluence");
    const jira = expectOk(
      validateAtlassianSyncScope(jiraScope({ jql: 'project = PROJ AND status != "Done"' })),
    );
    expect(jira.provider).toBe("jira");
  });

  it("rejects unknown providers and non-objects", () => {
    expect(errorsOf(validateAtlassianSyncScope({ provider: "github" }))).toEqual([
      "scope.provider must be confluence or jira",
    ]);
    expect(errorsOf(validateAtlassianSyncScope(null))).toEqual(["scope must be an object"]);
  });

  it("rejects cross-provider and unknown fields", () => {
    const withProjectKeys = errorsOf(
      validateAtlassianSyncScope(confluenceScope({ projectKeys: ["PROJ"] })),
    );
    expect(withProjectKeys.some((error) => error.includes("must not include projectKeys"))).toBe(
      true,
    );
    const withSpaceKeys = errorsOf(validateAtlassianSyncScope(jiraScope({ spaceKeys: ["ENG"] })));
    expect(withSpaceKeys.some((error) => error.includes("must not include spaceKeys"))).toBe(true);
  });

  it("rejects empty, oversized, duplicated, and malformed key sets", () => {
    expect(errorsOf(validateAtlassianSyncScope(confluenceScope({ spaceKeys: [] })))).toContain(
      "scope.spaceKeys must not be empty",
    );
    const oversized = Array.from({ length: 51 }, (_, index) => `S${String(index)}`);
    expect(
      errorsOf(validateAtlassianSyncScope(confluenceScope({ spaceKeys: oversized }))),
    ).toContain("scope.spaceKeys must contain at most 50 keys");
    expect(
      errorsOf(validateAtlassianSyncScope(confluenceScope({ spaceKeys: ["ENG", "ENG"] }))),
    ).toContain("scope.spaceKeys entries must be unique");
    expect(
      errorsOf(validateAtlassianSyncScope(confluenceScope({ spaceKeys: ["bad key"] }))),
    ).toContain("scope.spaceKeys entries must be valid keys");
    expect(
      errorsOf(validateAtlassianSyncScope(jiraScope({ projectKeys: ["lowercase"] }))),
    ).toContain("scope.projectKeys entries must be valid keys");
    expect(errorsOf(validateAtlassianSyncScope(jiraScope({ projectKeys: "PROJ" })))).toContain(
      "scope.projectKeys must be an array",
    );
  });

  it("bounds the opaque JQL and rejects non-string or empty JQL", () => {
    expect(
      errorsOf(validateAtlassianSyncScope(jiraScope({ jql: "x".repeat(2_049) }))).length,
    ).toBeGreaterThan(0);
    expect(errorsOf(validateAtlassianSyncScope(jiraScope({ jql: "" }))).length).toBeGreaterThan(0);
    expect(errorsOf(validateAtlassianSyncScope(jiraScope({ jql: 42 }))).length).toBeGreaterThan(0);
    expectOk(validateAtlassianSyncScope(jiraScope({ jql: "x".repeat(2_048) })));
  });

  it("propagates widened bounds as scope errors", () => {
    const errors = errorsOf(
      validateAtlassianSyncScope(jiraScope({ bounds: bounds({ maxItems: 5_000 }) })),
    );
    expect(errors.some((error) => error.startsWith("scope.bounds.maxItems"))).toBe(true);
  });
});

describe("validateAtlassianSyncChangeSummary (Epic #1856-aligned counts)", () => {
  it("accepts a valid summary for every terminal outcome", () => {
    for (const outcome of ATLASSIAN_SYNC_TERMINAL_STATUSES) {
      const value: AtlassianSyncChangeSummary = expectOk(
        validateAtlassianSyncChangeSummary(changeSummary(outcome)),
      );
      expect(value.outcome).toBe(outcome);
    }
  });

  it("rejects non-terminal outcomes and unknown fields", () => {
    expect(
      errorsOf(
        validateAtlassianSyncChangeSummary(changeSummary("succeeded", { outcome: "running" })),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf(validateAtlassianSyncChangeSummary(changeSummary("succeeded", { body: "diff" }))),
    ).toContain("changeSummary must not include body");
  });

  it("rejects malformed counts, digests, and timestamps", () => {
    expect(
      errorsOf(
        validateAtlassianSyncChangeSummary(
          changeSummary("succeeded", { counts: changeCounts({ addedItems: -1 }) }),
        ),
      ),
    ).toContain("changeSummary.counts.addedItems must be a non-negative integer");
    expect(
      errorsOf(
        validateAtlassianSyncChangeSummary(
          changeSummary("succeeded", { counts: changeCounts({ movedItems: 1 }) }),
        ),
      ),
    ).toContain("changeSummary.counts must not include movedItems");
    expect(
      errorsOf(
        validateAtlassianSyncChangeSummary(
          changeSummary("succeeded", { fingerprintSetDigest: "not-a-digest" }),
        ),
      ),
    ).toContain("changeSummary.fingerprintSetDigest must be a 64-character lowercase hex digest");
    expect(
      errorsOf(
        validateAtlassianSyncChangeSummary(changeSummary("succeeded", { completedAt: Number.NaN })),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("forces zero added/changed/removed counts for runs that did not apply (D5)", () => {
    expect(
      errorsOf(
        validateAtlassianSyncChangeSummary(
          changeSummary("failed", { counts: changeCounts({ addedItems: 1 }) }),
        ),
      ),
    ).toContain("changeSummary.counts.addedItems must be 0 for a failed run");
    expect(
      errorsOf(
        validateAtlassianSyncChangeSummary(
          changeSummary("cancelled", {
            counts: changeCounts({ addedItems: 0, changedItems: 0, removedItems: 2 }),
          }),
        ),
      ),
    ).toContain("changeSummary.counts.removedItems must be 0 for a cancelled run");
    expectOk(validateAtlassianSyncChangeSummary(changeSummary("failed")));
  });
});

describe("validateAtlassianSyncJobState (discriminated lifecycle)", () => {
  it("accepts a valid job in every lifecycle status", () => {
    for (const status of ["pending", "running", "succeeded", "partial", "failed", "cancelled"]) {
      const value: AtlassianSyncJobState = expectOk(validateAtlassianSyncJobState(job(status)));
      expect(value.status).toBe(status);
    }
  });

  it("accepts failed and cancelled jobs that never started", () => {
    for (const status of ["failed", "cancelled"]) {
      const never = job(status);
      delete never.startedAt;
      const value = expectOk(validateAtlassianSyncJobState(never));
      expect(value).not.toHaveProperty("startedAt");
    }
  });

  it("rejects unknown statuses and non-objects", () => {
    expect(errorsOf(validateAtlassianSyncJobState(job("paused")))).toEqual([
      "syncJob.status is invalid",
    ]);
    expect(errorsOf(validateAtlassianSyncJobState("job"))).toEqual(["syncJob must be an object"]);
  });

  it("rejects fields that do not belong to the status arm", () => {
    expect(errorsOf(validateAtlassianSyncJobState(job("pending", { startedAt: 1 })))).toContain(
      "syncJob must not include startedAt",
    );
    expect(errorsOf(validateAtlassianSyncJobState(job("running", { completedAt: 2 })))).toContain(
      "syncJob must not include completedAt",
    );
    expect(
      errorsOf(validateAtlassianSyncJobState(job("succeeded", { failureReason: "timeout" }))),
    ).toContain("syncJob must not include failureReason");
  });

  it("requires run and completion timestamps per arm", () => {
    const running = job("running");
    delete running.startedAt;
    expect(errorsOf(validateAtlassianSyncJobState(running))).toContain(
      "syncJob.startedAt must be a finite non-negative number",
    );
    const succeeded = job("succeeded");
    delete succeeded.completedAt;
    expect(errorsOf(validateAtlassianSyncJobState(succeeded))).toContain(
      "syncJob.completedAt must be a finite non-negative number",
    );
  });

  it("requires the change summary outcome to match the terminal status", () => {
    const mismatched = job("failed", { changeSummary: changeSummary("succeeded") });
    expect(errorsOf(validateAtlassianSyncJobState(mismatched))).toContain(
      "syncJob.changeSummary.outcome must equal the job status failed",
    );
  });

  it("requires content-free failure reasons on the failed and partial arms", () => {
    expect(
      errorsOf(validateAtlassianSyncJobState(job("failed", { failureReason: "disk exploded" }))),
    ).toContain(
      "syncJob.failureReason must be one of auth-failed|permission-denied|rate-limited|timeout|unavailable|scope-exceeded|bounds-exceeded|cancelled|malformed-payload",
    );
    expect(
      errorsOf(validateAtlassianSyncJobState(job("partial", { failureReasons: [] }))),
    ).toContain("syncJob.failureReasons must be a non-empty array for a partial run");
    expect(
      errorsOf(validateAtlassianSyncJobState(job("partial", { failureReasons: ["oops"] }))).length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf(
        validateAtlassianSyncJobState(job("partial", { failureReasons: ["timeout", "timeout"] })),
      ),
    ).toContain("syncJob.failureReasons entries must be unique");
  });

  it("rejects hostile identifiers, providers, and progress counts", () => {
    expect(
      errorsOf(validateAtlassianSyncJobState(job("pending", { jobId: "https://x" }))).length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf(validateAtlassianSyncJobState(job("pending", { provider: "github" }))).length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf(
        validateAtlassianSyncJobState(job("pending", { progress: progress({ fetchedItems: -1 }) })),
      ),
    ).toContain("syncJob.progress.fetchedItems must be a non-negative integer");
    expect(
      errorsOf(
        validateAtlassianSyncJobState(job("pending", { progress: progress({ pageBody: "x" }) })),
      ),
    ).toContain("syncJob.progress must not include pageBody");
  });
});

describe("validateAtlassianConnectorActivityRecord (ADR-0128 D6 evidence)", () => {
  it("accepts a minimal allowed/succeeded record", () => {
    const value: AtlassianConnectorActivityRecord = expectOk(
      validateAtlassianConnectorActivityRecord(activity({ targetRef: "PROJ-123" })),
    );
    expect(value.actionType).toBe("add-issue-comment");
  });

  it("is content-free by construction: every body-like extra key is rejected", () => {
    for (const key of [
      "body",
      "content",
      "text",
      "payload",
      "summary",
      "comment",
      "fields",
      "jql",
      "url",
      "token",
      "requestBody",
      "responseBody",
    ]) {
      const errors = errorsOf(validateAtlassianConnectorActivityRecord(activity({ [key]: "x" })));
      expect(errors, key).toContain(`activity must not include ${key}`);
    }
  });

  it("declares no body-like field at the type level", () => {
    // Compile-time proof: `Extract<keyof Shape, BodyLikeKey>` collapses to `never` only when the
    // evidence shape declares none of the body-like keys; if one is ever added, the conditional
    // type becomes `false` and the `= true` assignment stops compiling. The Jira sync SCOPE
    // legitimately transports opaque `jql`; the evidence shapes below must never carry it.
    type BodyLikeKey =
      | "body"
      | "content"
      | "text"
      | "payload"
      | "comment"
      | "fields"
      | "jql"
      | "url"
      | "token"
      | "secret"
      | "apiToken"
      | "password"
      | "summary";
    const activityIsBodyFree: Extract<
      keyof AtlassianConnectorActivityRecord,
      BodyLikeKey
    > extends never
      ? true
      : false = true;
    const descriptorIsSecretFree: Extract<
      keyof AtlassianConnectorDescriptor,
      BodyLikeKey
    > extends never
      ? true
      : false = true;
    const changeSummaryIsBodyFree: Extract<
      keyof AtlassianSyncChangeSummary,
      BodyLikeKey
    > extends never
      ? true
      : false = true;
    const podSourceIsBodyFree: Extract<keyof AtlassianConnectorPodSource, BodyLikeKey> extends never
      ? true
      : false = true;
    const bodyFreeProofs: readonly boolean[] = [
      activityIsBodyFree,
      descriptorIsSecretFree,
      changeSummaryIsBodyFree,
      podSourceIsBodyFree,
    ];
    expect(bodyFreeProofs).not.toContain(false);
  });

  it("pins the recorded class and provider to the D4 table for the action type", () => {
    expect(
      errorsOf(
        validateAtlassianConnectorActivityRecord(activity({ actionClass: "connector-access" })),
      ),
    ).toContain("activity.actionClass must match the D4 table for the action type");
    expect(
      errorsOf(validateAtlassianConnectorActivityRecord(activity({ provider: "confluence" }))),
    ).toContain("activity.provider must match the D4 table for the action type");
    expect(
      errorsOf(validateAtlassianConnectorActivityRecord(activity({ actionType: "delete-issue" }))),
    ).toContain("activity.actionType is invalid");
  });

  it("requires exactly the right reason vocabulary per disposition", () => {
    expectOk(
      validateAtlassianConnectorActivityRecord(
        activity({
          disposition: "denied",
          outcome: "denied",
          reasonCode: "connector-write-denied",
        }),
      ),
    );
    expect(
      errorsOf(
        validateAtlassianConnectorActivityRecord(
          activity({ disposition: "denied", outcome: "denied" }),
        ),
      ),
    ).toContain(
      "activity.reasonCode must be a policy denial or authority failure reason for a denied attempt",
    );
    expect(
      errorsOf(
        validateAtlassianConnectorActivityRecord(
          activity({
            disposition: "denied",
            outcome: "succeeded",
            reasonCode: "connector-write-denied",
          }),
        ),
      ),
    ).toContain("activity.outcome must be denied for a denied attempt");
    expectOk(
      validateAtlassianConnectorActivityRecord(
        activity({
          disposition: "review-required",
          outcome: "pending-review",
          reasonCode: "deterministic-risk-approval-required",
        }),
      ),
    );
    expect(
      errorsOf(
        validateAtlassianConnectorActivityRecord(
          activity({ disposition: "review-required", outcome: "pending-review" }),
        ),
      ),
    ).toContain("activity.reasonCode must be a review reason for a review-required attempt");
  });

  it("requires a closed failure reason when an allowed attempt fails", () => {
    expectOk(
      validateAtlassianConnectorActivityRecord(
        activity({ outcome: "failed", reasonCode: "rate-limited" }),
      ),
    );
    expect(
      errorsOf(validateAtlassianConnectorActivityRecord(activity({ outcome: "failed" }))),
    ).toContain("activity.reasonCode must be an execution failure reason for a failed attempt");
    expect(
      errorsOf(
        validateAtlassianConnectorActivityRecord(
          activity({ reasonCode: "connector-write-denied" }),
        ),
      ),
    ).toContain(
      "activity.reasonCode must be an execution failure reason or human-initiated for an allowed attempt",
    );
    expect(
      errorsOf(validateAtlassianConnectorActivityRecord(activity({ outcome: "denied" }))),
    ).toContain("activity.outcome must not be denied for an allowed attempt");
  });

  it("restricts syncSummary to sync actions and validates it", () => {
    expectOk(
      validateAtlassianConnectorActivityRecord(
        activity({
          actionType: "sync-project",
          actionClass: "connector-access",
          syncSummary: changeSummary("succeeded"),
        }),
      ),
    );
    expect(
      errorsOf(
        validateAtlassianConnectorActivityRecord(activity({ syncSummary: changeSummary() })),
      ),
    ).toContain("activity.syncSummary is only allowed for sync actions");
    const nested = errorsOf(
      validateAtlassianConnectorActivityRecord(
        activity({
          actionType: "sync-project",
          actionClass: "connector-access",
          syncSummary: changeSummary("succeeded", { fingerprintSetDigest: "nope" }),
        }),
      ),
    );
    expect(nested.some((error) => error.startsWith("activity.changeSummary"))).toBe(true);
  });

  it("restricts jqlDigest to search-issues-live and requires a sha256 hex digest", () => {
    expectOk(
      validateAtlassianConnectorActivityRecord(
        activity({
          actionType: "search-issues-live",
          actionClass: "connector-access",
          jqlDigest: DIGEST,
        }),
      ),
    );
    expect(
      errorsOf(validateAtlassianConnectorActivityRecord(activity({ jqlDigest: DIGEST }))),
    ).toContain("activity.jqlDigest is only allowed for search-issues-live");
    expect(
      errorsOf(
        validateAtlassianConnectorActivityRecord(
          activity({
            actionType: "search-issues-live",
            actionClass: "connector-access",
            jqlDigest: "project = PROJ",
          }),
        ),
      ),
    ).toContain("activity.jqlDigest must be a 64-character lowercase hex digest");
  });

  it("rejects hostile identifiers, targets, timestamps, and durations", () => {
    expect(
      errorsOf(
        validateAtlassianConnectorActivityRecord(activity({ targetRef: "https://evil.example" })),
      ),
    ).toContain("activity.targetRef must be a bounded identifier token when set");
    expect(
      errorsOf(validateAtlassianConnectorActivityRecord(activity({ activityId: "a b" }))).length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf(validateAtlassianConnectorActivityRecord(activity({ durationMs: -1 }))),
    ).toContain("activity.durationMs must be a non-negative integer");
    expect(
      errorsOf(validateAtlassianConnectorActivityRecord(activity({ occurredAt: Number.NaN })))
        .length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf(validateAtlassianConnectorActivityRecord(activity({ disposition: "maybe" }))),
    ).toContain("activity.disposition is invalid");
    expect(
      errorsOf(validateAtlassianConnectorActivityRecord(activity({ outcome: "unknown" }))),
    ).toContain("activity.outcome is invalid");
    expect(errorsOf(validateAtlassianConnectorActivityRecord(null))).toEqual([
      "activity must be an object",
    ]);
  });
});

describe("validateAtlassianConnectorPodSource (#2240 Scope 6)", () => {
  it("accepts minimal and fully populated pod source metadata", () => {
    const minimal: AtlassianConnectorPodSource = expectOk(
      validateAtlassianConnectorPodSource(podSource()),
    );
    expect(minimal.provider).toBe("confluence");
    expectOk(
      validateAtlassianConnectorPodSource(
        podSource({ lastSyncAt: 1_700_000_000_000, lastChangeSummary: changeSummary("partial") }),
      ),
    );
  });

  it("rejects unknown fields and body-like keys", () => {
    expect(errorsOf(validateAtlassianConnectorPodSource(podSource({ pages: ["body"] })))).toContain(
      "connectorSource must not include pages",
    );
    expect(errorsOf(validateAtlassianConnectorPodSource(null))).toEqual([
      "connectorSource must be an object",
    ]);
  });

  it("rejects hostile providers, ids, and scope labels", () => {
    expect(
      errorsOf(validateAtlassianConnectorPodSource(podSource({ provider: "notion" }))),
    ).toContain("connectorSource.provider must be confluence or jira");
    expect(
      errorsOf(validateAtlassianConnectorPodSource(podSource({ connectorId: "/etc/passwd" })))
        .length,
    ).toBeGreaterThan(0);
    expect(errorsOf(validateAtlassianConnectorPodSource(podSource({ scopeLabels: [] })))).toContain(
      "connectorSource.scopeLabels must not be empty",
    );
    expect(
      errorsOf(
        validateAtlassianConnectorPodSource(podSource({ scopeLabels: ["ENG", "https://x"] })),
      ),
    ).toContain("connectorSource.scopeLabels entries must be valid keys");
    expect(
      errorsOf(validateAtlassianConnectorPodSource(podSource({ scopeLabels: ["ENG", "ENG"] }))),
    ).toContain("connectorSource.scopeLabels entries must be unique");
  });

  it("validates the optional timestamps and nested change summary", () => {
    expect(errorsOf(validateAtlassianConnectorPodSource(podSource({ lastSyncAt: -5 })))).toContain(
      "connectorSource.lastSyncAt must be a finite non-negative number",
    );
    const nested = errorsOf(
      validateAtlassianConnectorPodSource(
        podSource({ lastChangeSummary: changeSummary("succeeded", { body: "raw" }) }),
      ),
    );
    expect(nested.some((error) => error.startsWith("connectorSource.changeSummary"))).toBe(true);
  });
});

// ─── Issue #2244 additions: write results, envelope-authority reasons, approvals ─

describe("activity reason pairing — Issue #2244 vocabulary", () => {
  it("accepts envelope-authority failure codes on denied attempts", () => {
    for (const reasonCode of ATLASSIAN_CONNECTOR_AUTHORITY_FAILURE_REASONS) {
      const value = expectOk(
        validateAtlassianConnectorActivityRecord(
          activity({ disposition: "denied", outcome: "denied", reasonCode }),
        ),
      );
      expect(value).toMatchObject({ disposition: "denied", outcome: "denied", reasonCode });
    }
  });

  it("accepts a write failure reason on a failed allowed attempt", () => {
    const conflict = expectOk(
      validateAtlassianConnectorActivityRecord(
        activity({ outcome: "failed", reasonCode: "conflict" }),
      ),
    );
    expect(conflict).toMatchObject({ outcome: "failed", reasonCode: "conflict" });
    const invalidTransition = expectOk(
      validateAtlassianConnectorActivityRecord(
        activity({ outcome: "failed", reasonCode: "invalid-transition" }),
      ),
    );
    expect(invalidTransition).toMatchObject({
      outcome: "failed",
      reasonCode: "invalid-transition",
    });
  });

  it("accepts human-initiated as the rationale on an allowed attempt, but never on failed", () => {
    expectOk(validateAtlassianConnectorActivityRecord(activity({ reasonCode: "human-initiated" })));
    expect(
      errorsOf(
        validateAtlassianConnectorActivityRecord(
          activity({ outcome: "failed", reasonCode: "human-initiated" }),
        ),
      ),
    ).toContain("activity.reasonCode must be an execution failure reason for a failed attempt");
  });

  it("accepts the write failure reason on a failed review-required attempt and keeps the review reason elsewhere", () => {
    expectOk(
      validateAtlassianConnectorActivityRecord(
        activity({ disposition: "review-required", outcome: "failed", reasonCode: "conflict" }),
      ),
    );
    expectOk(
      validateAtlassianConnectorActivityRecord(
        activity({
          disposition: "review-required",
          outcome: "cancelled",
          reasonCode: "deterministic-risk-approval-required",
        }),
      ),
    );
    expect(
      errorsOf(
        validateAtlassianConnectorActivityRecord(
          activity({
            disposition: "review-required",
            outcome: "failed",
            reasonCode: "mode-approval-required",
          }),
        ),
      ),
    ).toContain(
      "activity.reasonCode must be an execution failure reason for a failed review-required attempt",
    );
  });
});

describe("validateAtlassianConnectorPendingApproval (Issue #2244 → #2245 UI)", () => {
  function approval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: "1",
      approvalId: "3f0e93b4-6f0e-4d6e-9be1-2f9f31a2b0aa",
      connectorId: "conn-jira-prod",
      provider: "jira",
      actionType: "create-issue",
      actionClass: "connector-write",
      requiredScope: "issue-tracker.write",
      risk: "high",
      reviewReason: "deterministic-risk-approval-required",
      targetRef: "PROJ",
      correlationId: "corr-1",
      requestedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_600_000,
      ...overrides,
    };
  }

  it("accepts a valid pending approval", () => {
    const value = expectOk(validateAtlassianConnectorPendingApproval(approval()));
    expect(value.actionType).toBe("create-issue");
  });

  it("rejects unknown keys — body-like fields can never ride an approval", () => {
    for (const key of ["summary", "descriptionText", "commentText", "bodyText", "token"]) {
      expect(
        errorsOf(validateAtlassianConnectorPendingApproval(approval({ [key]: "raw" }))),
      ).toContain(`approval must not include ${key}`);
    }
  });

  it("pins the D4 row: class, provider, scope, and risk must match the action type", () => {
    expect(
      errorsOf(validateAtlassianConnectorPendingApproval(approval({ risk: "low" }))),
    ).toContain("approval.risk must match the D4 table for the action type");
    expect(
      errorsOf(
        validateAtlassianConnectorPendingApproval(
          approval({ requiredScope: "issue-tracker.read" }),
        ),
      ),
    ).toContain("approval.requiredScope must match the D4 table for the action type");
    expect(
      errorsOf(validateAtlassianConnectorPendingApproval(approval({ provider: "confluence" }))),
    ).toContain("approval.provider must match the D4 table for the action type");
    expect(
      errorsOf(
        validateAtlassianConnectorPendingApproval(approval({ actionClass: "connector-access" })),
      ),
    ).toContain("approval.actionClass must match the D4 table for the action type");
  });

  it("rejects hostile identifiers, review reasons, and inverted TTL windows", () => {
    expect(
      errorsOf(validateAtlassianConnectorPendingApproval(approval({ targetRef: "https://evil" })))
        .length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf(validateAtlassianConnectorPendingApproval(approval({ reviewReason: "because" }))),
    ).toContain("approval.reviewReason must be a review reason");
    expect(
      errorsOf(
        validateAtlassianConnectorPendingApproval(
          approval({ requestedAt: 2_000, expiresAt: 1_000 }),
        ),
      ),
    ).toContain("approval.expiresAt must not precede approval.requestedAt");
    expect(errorsOf(validateAtlassianConnectorPendingApproval(null))).toEqual([
      "approval must be an object",
    ]);
  });
});

describe("validateAtlassianConnectorActionExecutionResult (Issue #2244 wire results)", () => {
  it("accepts succeeded results with optional target and version", () => {
    const minimal = expectOk(
      validateAtlassianConnectorActionExecutionResult({ status: "succeeded" }),
    );
    expect(minimal).toMatchObject({ status: "succeeded" });
    const detailed = expectOk(
      validateAtlassianConnectorActionExecutionResult({
        status: "succeeded",
        targetRef: "PROJ-9",
        version: 4,
      }),
    );
    expect(detailed).toMatchObject({ status: "succeeded", targetRef: "PROJ-9", version: 4 });
  });

  it("accepts failed results with every closed write failure reason", () => {
    for (const reason of ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS) {
      const value = expectOk(
        validateAtlassianConnectorActionExecutionResult({
          status: "failed",
          reason,
          httpStatus: 409,
        }),
      );
      expect(value).toMatchObject({ status: "failed", reason });
    }
  });

  it("rejects unknown statuses, free-text reasons, and body-like extra keys", () => {
    expect(errorsOf(validateAtlassianConnectorActionExecutionResult({ status: "ok" }))).toEqual([
      "executionResult.status must be succeeded or failed",
    ]);
    expect(
      errorsOf(
        validateAtlassianConnectorActionExecutionResult({
          status: "failed",
          reason: "the upstream said no",
        }),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf(
        validateAtlassianConnectorActionExecutionResult({
          status: "succeeded",
          body: "<p>page</p>",
        }),
      ),
    ).toContain("executionResult must not include body");
    expect(
      errorsOf(
        validateAtlassianConnectorActionExecutionResult({
          status: "succeeded",
          targetRef: "https://evil",
        }),
      ),
    ).toContain("executionResult.targetRef must be a bounded identifier token when set");
    expect(
      errorsOf(
        validateAtlassianConnectorActionExecutionResult({ status: "succeeded", version: 0 }),
      ),
    ).toContain("executionResult.version must be a positive integer when set");
  });
});

// ─── Live JQL search request/result (Issue #2248) ─────────────────────────────
function liveIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "PROJ-7",
    summary: "Login token expires early",
    browseUrl: "https://example.atlassian.net/browse/PROJ-7",
    metadata: {
      issueKey: "PROJ-7",
      status: "In Progress",
      remainingEstimate: "2d",
      parentKey: "PROJ-1",
    },
    ...overrides,
  };
}

function liveResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    source: "live",
    queriedAt: 1_700_000_000_000,
    jqlDigest: DIGEST,
    totalMatched: 1,
    truncated: false,
    issues: [liveIssue()],
    ...overrides,
  };
}

describe("validateJiraLiveSearchRequest (Issue #2248 hostile input)", () => {
  it("accepts a bounded free-form JQL request", () => {
    const value = expectOk(
      validateJiraLiveSearchRequest({ jql: "labels = urgent ORDER BY updated DESC" }),
    );
    expect(value.jql).toContain("urgent");
    expect(value.templateId).toBeUndefined();
  });

  it("accepts a template request with a narrowed cap at both boundary values", () => {
    for (const maxResults of [1, ATLASSIAN_LIVE_SEARCH_MAX_RESULTS]) {
      const value = expectOk(
        validateJiraLiveSearchRequest({ templateId: "assigned-to-me-open", maxResults }),
      );
      expect(value.maxResults).toBe(maxResults);
    }
  });

  it("enforces the jql XOR templateId rule in both directions", () => {
    expect(errorsOf(validateJiraLiveSearchRequest({}))).toContain(
      "liveSearchRequest must carry exactly one of jql or templateId",
    );
    expect(
      errorsOf(
        validateJiraLiveSearchRequest({ jql: "project = A", templateId: "assigned-to-me-open" }),
      ),
    ).toContain("liveSearchRequest must carry exactly one of jql or templateId");
  });

  it("bounds the opaque JQL and rejects empty or non-string forms", () => {
    for (const jql of ["", "x".repeat(ATLASSIAN_JQL_MAX_CHARS + 1), 42, null, ["a"]]) {
      expect(errorsOf(validateJiraLiveSearchRequest({ jql }))).toContain(
        `liveSearchRequest.jql must be a non-empty string of at most ${String(ATLASSIAN_JQL_MAX_CHARS)} characters`,
      );
    }
    expect(
      expectOk(validateJiraLiveSearchRequest({ jql: "x".repeat(ATLASSIAN_JQL_MAX_CHARS) })).jql,
    ).toHaveLength(ATLASSIAN_JQL_MAX_CHARS);
  });

  it("rejects unknown template ids and hostile cap values", () => {
    expect(errorsOf(validateJiraLiveSearchRequest({ templateId: "all-issues" }))).toContain(
      "liveSearchRequest.templateId must be one of assigned-to-me-open",
    );
    for (const maxResults of [0, ATLASSIAN_LIVE_SEARCH_MAX_RESULTS + 1, 1.5, "50", -1]) {
      expect(
        errorsOf(validateJiraLiveSearchRequest({ templateId: "assigned-to-me-open", maxResults })),
      ).toContain(
        `liveSearchRequest.maxResults must be a positive integer of at most ${String(ATLASSIAN_LIVE_SEARCH_MAX_RESULTS)}`,
      );
    }
  });

  it("rejects unexpected fields and non-object input fail-closed", () => {
    expect(
      errorsOf(validateJiraLiveSearchRequest({ jql: "project = A", fields: "secrets" })),
    ).toContain("liveSearchRequest must not include fields");
    expect(validateJiraLiveSearchRequest("project = A").ok).toBe(false);
    expect(validateJiraLiveSearchRequest([{ jql: "a" }]).ok).toBe(false);
  });
});

describe("validateJiraLiveSearchResult (Issue #2248 ephemeral envelope)", () => {
  it("accepts a complete result and a truncated result without totalMatched", () => {
    const complete = expectOk(validateJiraLiveSearchResult(liveResult()));
    expect(complete.source).toBe("live");
    expect(complete.totalMatched).toBe(1);
    const truncated = expectOk(
      validateJiraLiveSearchResult(liveResult({ truncated: true, totalMatched: undefined })),
    );
    expect(truncated.truncated).toBe(true);
  });

  it("pins the envelope literals and digest shape", () => {
    expect(errorsOf(validateJiraLiveSearchResult(liveResult({ source: "synced" })))).toContain(
      'liveResult.source must be the literal "live"',
    );
    expect(errorsOf(validateJiraLiveSearchResult(liveResult({ jqlDigest: "abc" })))).toContain(
      "liveResult.jqlDigest must be a 64-character lowercase hex digest",
    );
    expect(errorsOf(validateJiraLiveSearchResult(liveResult({ queriedAt: -5 })))).toContain(
      "liveResult.queriedAt must be a finite non-negative number",
    );
    expect(errorsOf(validateJiraLiveSearchResult(liveResult({ truncated: "no" })))).toContain(
      "liveResult.truncated must be a boolean",
    );
  });

  it("enforces the totalMatched integrity rules", () => {
    expect(
      errorsOf(validateJiraLiveSearchResult(liveResult({ truncated: true, totalMatched: 1 }))),
    ).toContain("liveResult.totalMatched is only allowed for a complete (not truncated) result");
    expect(errorsOf(validateJiraLiveSearchResult(liveResult({ totalMatched: 7 })))).toContain(
      "liveResult.totalMatched must equal the returned issue count",
    );
    expect(errorsOf(validateJiraLiveSearchResult(liveResult({ totalMatched: 1.5 })))).toContain(
      "liveResult.totalMatched must be a non-negative integer",
    );
  });

  it("bounds the issue list at the D5 ceiling", () => {
    const issues = Array.from({ length: ATLASSIAN_LIVE_SEARCH_MAX_RESULTS + 1 }, (_, index) =>
      liveIssue({
        key: `PROJ-${String(index)}`,
        browseUrl: `https://example.atlassian.net/browse/PROJ-${String(index)}`,
        metadata: { issueKey: `PROJ-${String(index)}` },
      }),
    );
    expect(
      errorsOf(validateJiraLiveSearchResult(liveResult({ issues, totalMatched: issues.length }))),
    ).toContain(
      `liveResult.issues must be an array of at most ${String(ATLASSIAN_LIVE_SEARCH_MAX_RESULTS)} issues`,
    );
  });

  it("pins the per-issue cross-field integrity (key, browse URL, metadata)", () => {
    const rejects = (issue: Record<string, unknown>, message: string): void => {
      expect(errorsOf(validateJiraLiveSearchResult(liveResult({ issues: [issue] })))).toContain(
        message,
      );
    };
    rejects(
      liveIssue({ key: "https://evil" }),
      "liveResult.issues[0].key must be a bounded identifier token",
    );
    rejects(
      liveIssue({ browseUrl: "https://example.atlassian.net/browse/OTHER-1" }),
      "liveResult.issues[0].browseUrl must be an https browse URL ending in the issue key",
    );
    rejects(
      liveIssue({ browseUrl: "http://example.atlassian.net/browse/PROJ-7" }),
      "liveResult.issues[0].browseUrl must be an https browse URL ending in the issue key",
    );
    rejects(
      liveIssue({ metadata: { issueKey: "OTHER-1" } }),
      "liveResult.issues[0].metadata.issueKey must equal liveResult.issues[0].key",
    );
    rejects(
      liveIssue({ metadata: { issueKey: "PROJ-7", body: "leaked" } }),
      "liveResult.issues[0].metadata must be a valid citation-metadata projection",
    );
    rejects(
      liveIssue({ summary: "bad summary" }),
      "liveResult.issues[0].summary must be bounded single-line text",
    );
    rejects(liveIssue({ jql: "leak" }), "liveResult.issues[0] must not include jql");
  });
});

describe("activity live-result fields (Issue #2248 D6 extension)", () => {
  function liveActivity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return activity({
      actionType: "search-issues-live",
      actionClass: "connector-access",
      provider: "jira",
      jqlDigest: DIGEST,
      ...overrides,
    });
  }

  it("accepts jqlDigest + resultCount + resultIssueKeys on a succeeded live record", () => {
    const value = expectOk(
      validateAtlassianConnectorActivityRecord(
        liveActivity({ resultCount: 2, resultIssueKeys: ["PROJ-1", "PROJ-2"] }),
      ),
    );
    expect(value.resultCount).toBe(2);
    expect(value.resultIssueKeys).toEqual(["PROJ-1", "PROJ-2"]);
  });

  it("rejects the live fields on every non-live action type", () => {
    expect(
      errorsOf(validateAtlassianConnectorActivityRecord(activity({ resultCount: 1 }))),
    ).toContain("activity.resultCount is only allowed for search-issues-live");
    expect(
      errorsOf(validateAtlassianConnectorActivityRecord(activity({ resultIssueKeys: ["PROJ-1"] }))),
    ).toContain("activity.resultIssueKeys is only allowed for search-issues-live");
  });

  it("bounds and cross-checks the live fields", () => {
    expect(
      errorsOf(
        validateAtlassianConnectorActivityRecord(
          liveActivity({ resultCount: ATLASSIAN_LIVE_SEARCH_MAX_RESULTS + 1 }),
        ),
      ),
    ).toContain(
      `activity.resultCount must be a non-negative integer of at most ${String(ATLASSIAN_LIVE_SEARCH_MAX_RESULTS)}`,
    );
    expect(
      errorsOf(
        validateAtlassianConnectorActivityRecord(
          liveActivity({ resultCount: 2, resultIssueKeys: ["PROJ-1"] }),
        ),
      ),
    ).toContain("activity.resultIssueKeys length must equal activity.resultCount");
    expect(
      errorsOf(
        validateAtlassianConnectorActivityRecord(
          liveActivity({ resultIssueKeys: ["https://evil"] }),
        ),
      ),
    ).toContain("activity.resultIssueKeys must be a bounded array of identifier tokens");
  });
});
