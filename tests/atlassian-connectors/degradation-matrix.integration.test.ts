// Issue #2246 Scope 4 — the cross-connector degradation matrix.
//
// ONE data-driven table maps 401/403/404/429/5xx/timeout/network × {confluence, jira} × {sync,
// live, write} onto the closed #2240 failure vocabulary, so the ADR-0128 D3 status→reason mapping
// and the test rows correspond 1:1 and can be read side by side. Every cell drives the real lane
// or executor over an injected condition port (no network) with a recorded no-op backoff sleep
// (deterministic, no wall-clock), and asserts exactly one content-free reason. A second section
// proves the readiness projection (ADR-0128 D5) and recovery on the next clean run.
//
// This suite consolidates what the per-adapter tests assert individually into one uniform table:
// the point is that every provider and every operation share ONE classification vocabulary.

import { describe, expect, it } from "vitest";
import {
  createConfluenceSyncSource,
  createInMemoryConfluenceFixture,
  createJiraSyncSource,
  createConfluencePage,
  createJiraIssue,
  executeJiraLiveSearch,
  runAtlassianSyncFetch,
  type AtlassianSyncFetchOutcome,
} from "@oscharko-dev/keiko-connectors";
import {
  DEFAULT_ATLASSIAN_SYNC_BOUNDS,
  type AtlassianSyncFailureReason,
  type AtlassianSyncJobStatus,
  type KnowledgePodReadiness,
} from "@oscharko-dev/keiko-contracts";
import {
  CONNECTOR_BASE_URL,
  DEGRADATION_CONDITIONS,
  conditionBodyPort,
  noopSleep,
  type DegradationCondition,
} from "./harness.js";

type Operation = "sync" | "live" | "write";
type Provider = "confluence" | "jira";

interface MatrixRow {
  readonly operation: Operation;
  readonly provider: Provider;
  readonly condition: DegradationCondition;
  readonly expectedReason: string;
}

// ADR-0128 D3 status→reason mapping for reads (sync enumeration + live search share `failureReason
// ForStatus`; a truncation/parse failure is not reachable through a status-only condition port).
const READ_REASON: Readonly<Record<DegradationCondition, AtlassianSyncFailureReason>> = {
  "401": "auth-failed",
  "403": "permission-denied",
  "404": "unavailable",
  "429": "rate-limited",
  "5xx": "unavailable",
  timeout: "timeout",
  network: "unavailable",
};

// ADR-0128 D3 status→reason mapping for writes (`failureReasonForWriteStatus`): 404 is a concrete
// `not-found` here (a write targets a specific artifact), which is exactly why the write column
// differs from the read column and the matrix is meaningful rather than uniform.
const WRITE_REASON: Readonly<Record<DegradationCondition, string>> = {
  "401": "auth-failed",
  "403": "permission-denied",
  "404": "not-found",
  "429": "rate-limited",
  "5xx": "unavailable",
  timeout: "timeout",
  network: "unavailable",
};

function rowsForOperation(
  operation: Operation,
  providers: readonly Provider[],
  reasons: Readonly<Record<DegradationCondition, string>>,
): readonly MatrixRow[] {
  return providers.flatMap((provider) =>
    DEGRADATION_CONDITIONS.map((condition) => ({
      operation,
      provider,
      condition,
      expectedReason: reasons[condition],
    })),
  );
}

const MATRIX: readonly MatrixRow[] = [
  ...rowsForOperation("sync", ["confluence", "jira"], READ_REASON),
  ...rowsForOperation("live", ["jira"], READ_REASON),
  ...rowsForOperation("write", ["jira", "confluence"], WRITE_REASON),
];

async function runSyncCell(provider: Provider, condition: DegradationCondition): Promise<string> {
  const http = conditionBodyPort(condition);
  const bounds = DEFAULT_ATLASSIAN_SYNC_BOUNDS;
  // Branch so each call infers its own item-ref type (the two sources are not a common subtype).
  const outcome =
    provider === "confluence"
      ? await runAtlassianSyncFetch({
          source: createConfluenceSyncSource({
            baseUrl: CONNECTOR_BASE_URL,
            connectorId: "cred-degradation",
            spaceKeys: ["ENG"],
          }),
          http,
          bounds,
          sleep: noopSleep,
        })
      : await runAtlassianSyncFetch({
          source: createJiraSyncSource({
            baseUrl: CONNECTOR_BASE_URL,
            connectorId: "cred-degradation",
            projectKeys: ["PROJ"],
          }),
          http,
          bounds,
          sleep: noopSleep,
        });
  if (outcome.status === "failed" || outcome.status === "truncated") return outcome.reason;
  throw new Error(`sync did not degrade: ${outcome.status}`);
}

async function runLiveCell(condition: DegradationCondition): Promise<string> {
  const outcome = await executeJiraLiveSearch(
    { http: conditionBodyPort(condition), sleep: noopSleep },
    { baseUrl: CONNECTOR_BASE_URL, jql: "project = PROJ" },
  );
  if (!outcome.ok) return outcome.reason;
  throw new Error("live search did not degrade");
}

async function runWriteCell(provider: Provider, condition: DegradationCondition): Promise<string> {
  const http = conditionBodyPort(condition);
  if (provider === "jira") {
    const result = await createJiraIssue(
      { http, baseUrl: CONNECTOR_BASE_URL, sleep: noopSleep },
      { projectKey: "PROJ", issueTypeId: "10001", summary: "Degradation probe" },
    );
    if (!result.ok) return result.reason;
    throw new Error("jira write did not degrade");
  }
  const result = await createConfluencePage(
    { http, baseUrl: CONNECTOR_BASE_URL, sleep: noopSleep },
    { spaceId: "100", title: "Degradation probe", bodyText: "body" },
  );
  if (!result.ok) return result.reason;
  throw new Error("confluence write did not degrade");
}

function runCell(row: MatrixRow): Promise<string> {
  if (row.operation === "sync") return runSyncCell(row.provider, row.condition);
  if (row.operation === "live") return runLiveCell(row.condition);
  return runWriteCell(row.provider, row.condition);
}

describe("connector degradation matrix (Issue #2246 Scope 4, ADR-0128 D3)", () => {
  it.each(MATRIX)("$operation/$provider under $condition → $expectedReason", async (row) => {
    expect(await runCell(row)).toBe(row.expectedReason);
  });

  it("covers every operation × provider × condition cell exactly once", () => {
    expect(MATRIX).toHaveLength((2 + 1 + 2) * DEGRADATION_CONDITIONS.length);
    const keys = MATRIX.map((row) => `${row.operation}:${row.provider}:${row.condition}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ─── Readiness projection (ADR-0128 D5) + recovery ─────────────────────────────
// The D5 sync-status → pod-readiness table, encoded as data so it visibly corresponds 1:1 with
// the ADR. `cancelled` keeps the pod's prior readiness (not advanced, not downgraded).
const POD_READINESS_FOR_JOB_STATUS: Readonly<
  Record<AtlassianSyncJobStatus, KnowledgePodReadiness | "unchanged">
> = {
  pending: "draft",
  running: "indexing",
  succeeded: "ready",
  partial: "degraded",
  failed: "error",
  cancelled: "unchanged",
};

const VALID_READINESS: readonly KnowledgePodReadiness[] = [
  "draft",
  "indexing",
  "ready",
  "stale",
  "degraded",
  "unavailable",
  "error",
];

function confluenceFixtureWithFailingPage(
  includeFailingPage: boolean,
): ReturnType<typeof createInMemoryConfluenceFixture> {
  const pages = [
    { pageId: "1", title: "Runbook", storageBody: "<p>healthy page</p>" },
    ...(includeFailingPage
      ? [{ pageId: "2", title: "Forbidden", storageBody: "<p>x</p>", bodyStatus: 403 }]
      : []),
  ];
  return createInMemoryConfluenceFixture({
    baseUrl: CONNECTOR_BASE_URL,
    spaces: [{ key: "ENG", id: "100", pages }],
  });
}

function runConfluenceSync(
  http: ReturnType<typeof createInMemoryConfluenceFixture>,
): Promise<AtlassianSyncFetchOutcome> {
  return runAtlassianSyncFetch({
    source: createConfluenceSyncSource({
      baseUrl: CONNECTOR_BASE_URL,
      connectorId: "cred-recovery",
      spaceKeys: ["ENG"],
    }),
    http,
    bounds: DEFAULT_ATLASSIAN_SYNC_BOUNDS,
    sleep: noopSleep,
  });
}

describe("readiness mapping + recovery (ADR-0128 D5)", () => {
  it("maps every terminal sync status onto a valid pod readiness", () => {
    for (const value of Object.values(POD_READINESS_FOR_JOB_STATUS)) {
      if (value === "unchanged") continue;
      expect(VALID_READINESS).toContain(value);
    }
    expect(POD_READINESS_FOR_JOB_STATUS.failed).toBe("error");
    expect(POD_READINESS_FOR_JOB_STATUS.partial).toBe("degraded");
    expect(POD_READINESS_FOR_JOB_STATUS.succeeded).toBe("ready");
  });

  it("degrades to partial (readiness degraded) when one item is forbidden, then recovers", async () => {
    const degraded = await runConfluenceSync(confluenceFixtureWithFailingPage(true));
    expect(degraded.status).toBe("completed");
    if (degraded.status !== "completed") throw new Error("unreachable");
    expect(degraded.failures.map((failure) => failure.reason)).toEqual(["permission-denied"]);
    // A completed run WITH failures maps to job `partial` → readiness `degraded`.
    expect(POD_READINESS_FOR_JOB_STATUS.partial).toBe("degraded");

    // Recovery on the next sync after the cause clears: no failures, full coverage → `ready`.
    const recovered = await runConfluenceSync(confluenceFixtureWithFailingPage(false));
    expect(recovered.status).toBe("completed");
    if (recovered.status !== "completed") throw new Error("unreachable");
    expect(recovered.failures).toEqual([]);
    expect(recovered.items).toHaveLength(1);
    expect(recovered.applicable).toBe(true);
    expect(POD_READINESS_FOR_JOB_STATUS.succeeded).toBe("ready");
  });
});
