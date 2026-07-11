// Issue #2248 — route-level governance tests for the live JQL read action on the shared actions
// route (#2244 wiring). Hermetic: the transport is the in-memory Jira fixture wrapped in a
// counting port (no network), envelopes register far-future, singleton registries reset around
// every test, and the ephemeral proof inspects a fresh temp knowledge store.
//
// The mode × scope matrix asserts against a LITERAL copy of the ADR-0128 D4 search-issues-live
// row — never re-derived through the contract helper — so the route is proven against the ADR.

import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_SCHEMA_VERSION,
  validateAtlassianConnectorActivityRecord,
  validateAtlassianConnectorPendingApproval,
  validateJiraLiveSearchResult,
  type AtlassianConnectorPendingApproval,
  type CodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchConnectorScope,
  type CodingWorkbenchMode,
  type JiraLiveSearchResult,
} from "@oscharko-dev/keiko-contracts";
import {
  createInMemoryJiraFixture,
  JIRA_LIVE_SEARCH_TEMPLATE_JQL,
  type AtlassianCredentialCustody,
  type AtlassianCredentialMetadata,
  type AtlassianHttpBodyPort,
  type AtlassianHttpBodyRequest,
  type AtlassianHttpBodyResult,
  type JiraFixtureIssue,
} from "@oscharko-dev/keiko-connectors";
import { listCapsules } from "@oscharko-dev/keiko-local-knowledge";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import type { RouteContext } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { openKnowledgeStoreForDeps } from "../local-knowledge-store-open.js";
import {
  editorAgentAuthorityRegistry,
  editorAgentWorkspaceRootDigest,
} from "../editor/agentAuthorityRegistry.js";
import { atlassianActionApprovalRegistry } from "./actionApprovals.js";
import type { AtlassianConnectorCredentialDeps } from "./credentialRoutes.js";
import { atlassianSyncJobRegistry, connectorIdForAuthRef } from "./syncService.js";
import {
  handleApproveAtlassianConnectorActionApproval,
  handleExecuteAtlassianConnectorAction,
  handleListAtlassianConnectorActionApprovals,
  handleRejectAtlassianConnectorActionApproval,
} from "./writeActionRoutes.js";

const ROOT = "/repo";
const BASE_URL = "https://tenant.example";
const JIRA_AUTH_REF = `atlassian-cred:${"A".repeat(22)}`;
const CONFLUENCE_AUTH_REF = `atlassian-cred:${"B".repeat(22)}`;
const READ_SCOPE: readonly CodingWorkbenchConnectorScope[] = ["issue-tracker.read"];
const FREE_JQL = 'labels = "confidential-initiative-x" ORDER BY updated DESC';
const SECRET_SUMMARY = "Login token expires early on the confidential rollout";

const MODES: readonly CodingWorkbenchMode[] = [
  "governed-assist",
  "supervised-coding",
  "autonomous-delivery",
];

// The ADR-0128 D4 search-issues-live row, copied verbatim (scope present).
const D4_LIVE_ROW: Readonly<Record<CodingWorkbenchMode, "allowed" | "review-required">> = {
  "governed-assist": "review-required",
  "supervised-coding": "allowed",
  "autonomous-delivery": "allowed",
};

// ─── Fixtures ───────────────────────────────────────────────────────────────────
const FIXTURE_ISSUES: readonly JiraFixtureIssue[] = [
  {
    issueId: "10007",
    key: "PROJ-7",
    summary: SECRET_SUMMARY,
    updated: "2026-05-01T10:22:33.000+0000",
    extraFields: {
      status: { name: "In Progress" },
      issuetype: { name: "Bug" },
      timetracking: { originalEstimate: "3d", remainingEstimate: "2d" },
      parent: { key: "PROJ-1" },
      subtasks: [{ key: "PROJ-8" }],
    },
  },
  {
    issueId: "10009",
    key: "PROJ-9",
    summary: "Second open issue",
    updated: "2026-05-02T09:00:00.000+0000",
  },
];

function credential(provider: "jira" | "confluence"): AtlassianCredentialMetadata {
  return {
    schemaVersion: "1",
    authRef: provider === "jira" ? JIRA_AUTH_REF : CONFLUENCE_AUTH_REF,
    provider,
    displayName: provider === "jira" ? "Jira (Prod)" : "Confluence (Prod)",
    baseUrl: BASE_URL,
    authScheme: "basic-api-token",
    createdAt: 1,
  };
}

interface FetchCounter {
  count: number;
  readonly requests: AtlassianHttpBodyRequest[];
}

function guardWith(
  counter: FetchCounter,
  override?: (request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult | undefined,
): AtlassianConnectorCredentialDeps {
  const fixture = createInMemoryJiraFixture({
    baseUrl: BASE_URL,
    projects: [{ key: "PROJ", issues: FIXTURE_ISSUES }],
    ...(override === undefined ? {} : { override }),
  });
  const countingPort: AtlassianHttpBodyPort = (request) => {
    counter.count += 1;
    counter.requests.push(request);
    return fixture(request);
  };
  const custody = {
    create: (): never => {
      throw new Error("create not exercised");
    },
    getMetadata: (authRef: string): AtlassianCredentialMetadata | undefined => {
      if (authRef === JIRA_AUTH_REF) return credential("jira");
      if (authRef === CONFLUENCE_AUTH_REF) return credential("confluence");
      return undefined;
    },
    list: (): readonly AtlassianCredentialMetadata[] => [credential("jira")],
    delete: (): boolean => false,
  } satisfies AtlassianCredentialCustody;
  return {
    custody,
    httpPortFactory: () => () => Promise.resolve({ kind: "network-error" as const }),
    httpBodyPortFactory: () => countingPort,
  };
}

function deps(
  guard: AtlassianConnectorCredentialDeps,
  mode: CodingWorkbenchMode,
  uiDbPath?: string,
): UiHandlerDeps {
  return {
    atlassianConnectorCredentials: guard,
    autonomousDeliveryDeploymentCeiling: mode,
    ...(uiDbPath === undefined ? {} : { uiDbPath }),
  } as UiHandlerDeps;
}

function envelope(
  mode: CodingWorkbenchMode,
  connectorScopes: readonly CodingWorkbenchConnectorScope[],
  over: Partial<CodingWorkbenchAuthorityEnvelope> = {},
): CodingWorkbenchAuthorityEnvelope {
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    runId: "run-2248",
    localUser: "local-operator",
    taskRefs: ["issue-2248"],
    workspace: {
      workspaceId: "workspace-1",
      rootLabel: "workspace",
      rootDigest: editorAgentWorkspaceRootDigest(ROOT),
    },
    branch: {
      baseRef: "dev",
      headRef: "local-workspace",
      allowDetachedHead: false,
      allowedPrefixes: ["local-"],
    },
    requestedMode: mode,
    deploymentCeiling: mode,
    effectiveMode: mode,
    runtimeSource: "keiko-sidecar",
    actionClasses: CODING_WORKBENCH_ACTION_CLASSES,
    connectorScopes,
    modelProfile: {
      profileId: "profile-1",
      source: "keiko-model-gateway",
      supportsStreaming: true,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "governed",
      allow: [],
      deny: [],
      maxCommandTimeoutMs: 60_000,
      requirePerCommandApproval: false,
    },
    networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
    gates: ["human-approval", "branch-allowlist"],
    budget: {
      maxRuntimeMs: 3_600_000,
      maxToolCalls: 50,
      maxPromptTokens: 10_000,
      maxPatchBytes: 65_536,
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
    approvalProofDigest: "a".repeat(64),
    ...over,
  };
}

interface AuthorityContext {
  readonly runId: string;
  readonly envelopeDigest: string;
  readonly workspaceRoot: string;
}

function registerEnvelope(
  mode: CodingWorkbenchMode,
  connectorScopes: readonly CodingWorkbenchConnectorScope[],
): AuthorityContext {
  const registration = editorAgentAuthorityRegistry.register(
    envelope(mode, connectorScopes),
    mode,
    new Date().toISOString(),
  );
  if (!registration.ok)
    throw new Error(`test envelope registration failed: ${registration.reason}`);
  return { ...registration.authorityRef, workspaceRoot: ROOT };
}

function fakeReq(body: Record<string, unknown>): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  queueMicrotask(() => {
    req.emit("data", Buffer.from(JSON.stringify(body), "utf8"));
    req.emit("end");
  });
  return req;
}

function ctx(body: Record<string, unknown>, params: Record<string, string>): RouteContext {
  return {
    req: fakeReq(body),
    res: undefined,
    params,
    url: new URL("http://127.0.0.1:1983/api/atlassian-connectors"),
  } as unknown as RouteContext;
}

interface RouteReply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function postLiveSearch(
  action: Record<string, unknown>,
  authority: AuthorityContext | undefined,
  handlerDeps: UiHandlerDeps,
  authRef: string = JIRA_AUTH_REF,
): Promise<RouteReply> {
  const result = await handleExecuteAtlassianConnectorAction(
    ctx({ action, ...(authority === undefined ? {} : { authority }) }, { authRef }),
    handlerDeps,
  );
  return result as RouteReply;
}

function liveSearchOf(body: Record<string, unknown>): JiraLiveSearchResult {
  const liveSearch = body.liveSearch as JiraLiveSearchResult | undefined;
  if (liveSearch === undefined) throw new Error("expected liveSearch payload on the response");
  return liveSearch;
}

beforeEach(() => {
  editorAgentAuthorityRegistry.reset();
  atlassianActionApprovalRegistry.reset();
  atlassianSyncJobRegistry.reset();
});

afterEach(() => {
  editorAgentAuthorityRegistry.reset();
  atlassianActionApprovalRegistry.reset();
  atlassianSyncJobRegistry.reset();
});

// ─── AC1: the D4 search-issues-live row at route level ─────────────────────────
describe("live-search route — ADR-0128 D4 matrix (AC1)", () => {
  it("matches the D4 row in every mode with issue-tracker.read present", async () => {
    for (const mode of MODES) {
      editorAgentAuthorityRegistry.reset();
      atlassianActionApprovalRegistry.reset();
      const counter: FetchCounter = { count: 0, requests: [] };
      const guard = guardWith(counter);
      const authority = registerEnvelope(mode, READ_SCOPE);
      const { status, body } = await postLiveSearch(
        { type: "search-issues-live", jql: FREE_JQL },
        authority,
        deps(guard, mode),
      );
      const expected = D4_LIVE_ROW[mode];
      expect({ mode, disposition: body.disposition }).toEqual({ mode, disposition: expected });
      if (expected === "allowed") {
        expect(status).toBe(200);
        expect((body.result as { status: string }).status).toBe("succeeded");
        expect(liveSearchOf(body).source).toBe("live");
        expect(counter.count).toBeGreaterThan(0);
      } else {
        expect(status).toBe(202);
        expect(body.approval).toBeDefined();
        expect(body.liveSearch).toBeUndefined();
        expect(counter.count).toBe(0);
      }
    }
  });

  it("denies with connector-access-denied in EVERY mode when issue-tracker.read is absent", async () => {
    for (const mode of MODES) {
      for (const connectorScopes of [
        [] as readonly CodingWorkbenchConnectorScope[],
        // The WRITE scope alone must not admit the read action.
        ["issue-tracker.write", "knowledge-base.read"] as readonly CodingWorkbenchConnectorScope[],
      ]) {
        editorAgentAuthorityRegistry.reset();
        const counter: FetchCounter = { count: 0, requests: [] };
        const guard = guardWith(counter);
        const authority = registerEnvelope(mode, connectorScopes);
        const { status, body } = await postLiveSearch(
          { type: "search-issues-live", templateId: "assigned-to-me-open" },
          authority,
          deps(guard, mode),
        );
        expect(status).toBe(200);
        expect(body.disposition).toBe("denied");
        expect(body.reasonCode).toBe("connector-access-denied");
        expect(body.liveSearch).toBeUndefined();
        expect(counter.count).toBe(0);
      }
    }
  });

  it("400s a request without the authority context — no ungoverned bypass exists", async () => {
    const counter: FetchCounter = { count: 0, requests: [] };
    const guard = guardWith(counter);
    const result = await postLiveSearch(
      { type: "search-issues-live", jql: FREE_JQL },
      undefined,
      deps(guard, "autonomous-delivery"),
    );
    expect(result.status).toBe(400);
    expect(counter.count).toBe(0);
  });
});

// ─── AC2: Ask for approval — park, approve executes, reject records ────────────
describe("live-search route — pending approvals (AC2)", () => {
  it("parks with ZERO fetcher invocations, then approve executes the live query", async () => {
    const counter: FetchCounter = { count: 0, requests: [] };
    const guard = guardWith(counter);
    const authority = registerEnvelope("governed-assist", READ_SCOPE);
    const { status, body } = await postLiveSearch(
      { type: "search-issues-live", templateId: "assigned-to-me-open", maxResults: 50 },
      authority,
      deps(guard, "governed-assist"),
    );
    expect(status).toBe(202);
    expect(counter.count).toBe(0);
    const approval = body.approval as AtlassianConnectorPendingApproval;
    expect(validateAtlassianConnectorPendingApproval(approval).ok).toBe(true);
    expect(approval.actionType).toBe("search-issues-live");
    expect(approval.actionClass).toBe("connector-access");
    expect(approval.requiredScope).toBe("issue-tracker.read");
    expect(approval.risk).toBe("low");
    expect(approval.reviewReason).toBe("mode-approval-required");
    // Template queries surface WHICH template as the target — never any JQL text.
    expect(approval.targetRef).toBe("assigned-to-me-open");
    const listed = (await handleListAtlassianConnectorActionApprovals(
      ctx({}, {}),
      deps(guard, "governed-assist"),
    )) as { body: { approvals: readonly AtlassianConnectorPendingApproval[] } };
    expect(listed.body.approvals.map((entry) => entry.approvalId)).toEqual([approval.approvalId]);
    expect(counter.count).toBe(0);
    // Approve → executes NOW with the review-required disposition and the live payload.
    const approved = (await handleApproveAtlassianConnectorActionApproval(
      ctx({}, { approvalId: approval.approvalId }),
      deps(guard, "governed-assist"),
    )) as RouteReply;
    expect(approved.status).toBe(200);
    expect(approved.body.disposition).toBe("review-required");
    expect((approved.body.result as { status: string }).status).toBe("succeeded");
    const liveSearch = liveSearchOf(approved.body);
    expect(liveSearch.source).toBe("live");
    expect(liveSearch.issues.map((issue) => issue.key)).toEqual(["PROJ-7", "PROJ-9"]);
    expect(counter.count).toBeGreaterThan(0);
    // Single-use: a replayed approve finds nothing.
    const replayed = (await handleApproveAtlassianConnectorActionApproval(
      ctx({}, { approvalId: approval.approvalId }),
      deps(guard, "governed-assist"),
    )) as RouteReply;
    expect(replayed.status).toBe(404);
  });

  it("reject records the attempt with its digest and never executes", async () => {
    const counter: FetchCounter = { count: 0, requests: [] };
    const guard = guardWith(counter);
    const authority = registerEnvelope("governed-assist", READ_SCOPE);
    const { body } = await postLiveSearch(
      { type: "search-issues-live", jql: FREE_JQL },
      authority,
      deps(guard, "governed-assist"),
    );
    const approval = body.approval as AtlassianConnectorPendingApproval;
    const rejected = (await handleRejectAtlassianConnectorActionApproval(
      ctx({}, { approvalId: approval.approvalId }),
      deps(guard, "governed-assist"),
    )) as RouteReply;
    expect(rejected.status).toBe(200);
    expect(rejected.body.outcome).toBe("cancelled");
    expect(counter.count).toBe(0);
    const records = atlassianSyncJobRegistry.listActivity(connectorIdForAuthRef(JIRA_AUTH_REF));
    expect(records.map((record) => record.outcome)).toEqual(["pending-review", "cancelled"]);
    for (const record of records) {
      expect(record.jqlDigest).toBe(sha256Hex(FREE_JQL));
      expect(validateAtlassianConnectorActivityRecord(record).ok).toBe(true);
    }
  });
});

// ─── AC4: ephemeral result — nothing persisted to any store ─────────────────────
describe("live-search route — ephemeral results (AC4)", () => {
  let tmp: string;

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("persists nothing: no capsule, no connector source, no fingerprints, no new files", async () => {
    tmp = mkdtempSync(join(tmpdir(), "keiko-live-2248-"));
    const uiDbPath = join(tmp, "keiko-ui.db");
    const counter: FetchCounter = { count: 0, requests: [] };
    const guard = guardWith(counter);
    const handlerDeps = deps(guard, "autonomous-delivery", uiDbPath);
    // Materialize the empty knowledge store first, then snapshot the directory baseline.
    const before = openKnowledgeStoreForDeps(handlerDeps, { recover: true });
    expect(listCapsules(before.store)).toEqual([]);
    before.close();
    const baselineFiles = readdirSync(tmp, { recursive: true }).map(String).sort();

    const authority = registerEnvelope("autonomous-delivery", READ_SCOPE);
    const { status, body } = await postLiveSearch(
      { type: "search-issues-live", jql: FREE_JQL },
      authority,
      handlerDeps,
    );
    expect(status).toBe(200);
    const liveSearch = liveSearchOf(body);
    expect(liveSearch.queriedAt).toBeGreaterThan(0);
    expect(liveSearch.source).toBe("live");
    expect(liveSearch.issues).toHaveLength(2);
    expect(validateJiraLiveSearchResult(liveSearch).ok).toBe(true);
    expect(counter.count).toBeGreaterThan(0);

    // Store inspection after the call: zero capsules — and therefore zero connector_sources
    // rows, zero connector_item_fingerprints, and zero index documents, all of which are keyed
    // under a capsule — and no new files anywhere in the runtime-state directory.
    const after = openKnowledgeStoreForDeps(handlerDeps, { recover: true });
    expect(listCapsules(after.store)).toEqual([]);
    after.close();
    expect(readdirSync(tmp, { recursive: true }).map(String).sort()).toEqual(baselineFiles);
    // The only durable trace is the content-free activity record (audit records only).
    const records = atlassianSyncJobRegistry.listActivity(connectorIdForAuthRef(JIRA_AUTH_REF));
    expect(records).toHaveLength(1);
    expect(records[0]?.outcome).toBe("succeeded");
  });
});

// ─── AC5: audit records — counts, keys, digest; never JQL or summaries ─────────
describe("live-search route — audit completeness (AC5)", () => {
  it("emits one content-free record per attempt across the disposition space", async () => {
    const counter: FetchCounter = { count: 0, requests: [] };
    const guard = guardWith(counter);
    // allowed + succeeded (Full access, free-form JQL).
    const allowedAuthority = registerEnvelope("autonomous-delivery", READ_SCOPE);
    await postLiveSearch(
      { type: "search-issues-live", jql: FREE_JQL },
      allowedAuthority,
      deps(guard, "autonomous-delivery"),
    );
    // review-required → approve → executed (template).
    editorAgentAuthorityRegistry.reset();
    const reviewAuthority = registerEnvelope("governed-assist", READ_SCOPE);
    const parked = await postLiveSearch(
      { type: "search-issues-live", templateId: "assigned-to-me-open" },
      reviewAuthority,
      deps(guard, "governed-assist"),
    );
    const approval = parked.body.approval as AtlassianConnectorPendingApproval;
    await handleApproveAtlassianConnectorActionApproval(
      ctx({}, { approvalId: approval.approvalId }),
      deps(guard, "governed-assist"),
    );
    // denied: read scope absent.
    editorAgentAuthorityRegistry.reset();
    const deniedAuthority = registerEnvelope("autonomous-delivery", []);
    await postLiveSearch(
      { type: "search-issues-live", jql: FREE_JQL },
      deniedAuthority,
      deps(guard, "autonomous-delivery"),
    );

    const records = atlassianSyncJobRegistry.listActivity(connectorIdForAuthRef(JIRA_AUTH_REF));
    expect(
      records.map((record) => ({
        disposition: record.disposition,
        outcome: record.outcome,
        reasonCode: record.reasonCode,
        targetRef: record.targetRef,
        resultCount: record.resultCount,
      })),
    ).toEqual([
      {
        disposition: "allowed",
        outcome: "succeeded",
        reasonCode: undefined,
        targetRef: undefined,
        resultCount: 2,
      },
      {
        disposition: "review-required",
        outcome: "pending-review",
        reasonCode: "mode-approval-required",
        targetRef: "assigned-to-me-open",
        resultCount: undefined,
      },
      {
        disposition: "review-required",
        outcome: "succeeded",
        reasonCode: "mode-approval-required",
        targetRef: "assigned-to-me-open",
        resultCount: 2,
      },
      {
        disposition: "denied",
        outcome: "denied",
        reasonCode: "connector-access-denied",
        targetRef: undefined,
        resultCount: undefined,
      },
    ]);
    // Digest correlation: the free-form attempts carry sha256(FREE_JQL); the template attempts
    // carry sha256 of the composed template JQL. Issue keys ride as identifiers on success.
    expect(records[0]?.jqlDigest).toBe(sha256Hex(FREE_JQL));
    expect(records[1]?.jqlDigest).toBe(
      sha256Hex(JIRA_LIVE_SEARCH_TEMPLATE_JQL["assigned-to-me-open"]),
    );
    expect(records[2]?.resultIssueKeys).toEqual(["PROJ-7", "PROJ-9"]);
    expect(records[3]?.jqlDigest).toBe(sha256Hex(FREE_JQL));
    for (const record of records) {
      expect(record.correlationId.length).toBeGreaterThan(0);
      expect(validateAtlassianConnectorActivityRecord(record).ok).toBe(true);
    }
    // Scanning assertion: no JQL verbatim (free-form OR composed template), no summaries, no
    // bodies, no credential material anywhere in the trail.
    const serialized = JSON.stringify(records);
    for (const leaked of [
      FREE_JQL,
      "confidential-initiative-x",
      "ORDER BY updated",
      JIRA_LIVE_SEARCH_TEMPLATE_JQL["assigned-to-me-open"],
      "currentUser()",
      SECRET_SUMMARY,
      "Login token",
      "Authorization",
      "Basic ",
      "token",
    ]) {
      expect(serialized, leaked).not.toContain(leaked);
    }
  });
});

// ─── AC6: bounds and degradation surfaced through the route ────────────────────
describe("live-search route — bounds and degradation (AC6)", () => {
  it("rejects hostile request shapes with 400 before any policy or fetch work", async () => {
    const counter: FetchCounter = { count: 0, requests: [] };
    const guard = guardWith(counter);
    const authority = registerEnvelope("autonomous-delivery", READ_SCOPE);
    const handlerDeps = deps(guard, "autonomous-delivery");
    const hostile: readonly Record<string, unknown>[] = [
      { type: "search-issues-live" },
      { type: "search-issues-live", jql: FREE_JQL, templateId: "assigned-to-me-open" },
      { type: "search-issues-live", jql: "" },
      { type: "search-issues-live", jql: "x".repeat(2_049) },
      { type: "search-issues-live", jql: FREE_JQL, maxResults: 0 },
      { type: "search-issues-live", jql: FREE_JQL, maxResults: 101 },
      { type: "search-issues-live", jql: FREE_JQL, maxResults: 1.5 },
      { type: "search-issues-live", templateId: "all-issues" },
      { type: "search-issues-live", jql: FREE_JQL, fields: "description" },
    ];
    for (const action of hostile) {
      const result = await postLiveSearch(action, authority, handlerDeps);
      expect(result.status, JSON.stringify(action)).toBe(400);
    }
    expect(counter.count).toBe(0);
  });

  it("rejects the action on a Confluence credential (provider mismatch)", async () => {
    const counter: FetchCounter = { count: 0, requests: [] };
    const guard = guardWith(counter);
    const authority = registerEnvelope("autonomous-delivery", READ_SCOPE);
    const result = await postLiveSearch(
      { type: "search-issues-live", jql: FREE_JQL },
      authority,
      deps(guard, "autonomous-delivery"),
      CONFLUENCE_AUTH_REF,
    );
    expect(result.status).toBe(400);
    expect(counter.count).toBe(0);
  });

  it("enforces maxResults at the boundary through the route", async () => {
    const counter: FetchCounter = { count: 0, requests: [] };
    const guard = guardWith(counter);
    const authority = registerEnvelope("autonomous-delivery", READ_SCOPE);
    const { body } = await postLiveSearch(
      { type: "search-issues-live", jql: FREE_JQL, maxResults: 1 },
      authority,
      deps(guard, "autonomous-delivery"),
    );
    const liveSearch = liveSearchOf(body);
    expect(liveSearch.issues).toHaveLength(1);
    expect(liveSearch.truncated).toBe(true);
    expect(liveSearch.totalMatched).toBeUndefined();
  });

  it("surfaces the typed degradation matrix as content-free failed results", async () => {
    const matrix: readonly { scripted: AtlassianHttpBodyResult; reason: string }[] = [
      {
        scripted: {
          kind: "response",
          status: 401,
          bodyText: '{"detail":"expired token"}',
          bodyBytes: 26,
          truncated: false,
        },
        reason: "auth-failed",
      },
      {
        scripted: {
          kind: "response",
          status: 403,
          bodyText: '{"detail":"no browse permission"}',
          bodyBytes: 33,
          truncated: false,
        },
        reason: "permission-denied",
      },
      { scripted: { kind: "timeout" }, reason: "timeout" },
    ];
    for (const entry of matrix) {
      editorAgentAuthorityRegistry.reset();
      atlassianSyncJobRegistry.reset();
      const counter: FetchCounter = { count: 0, requests: [] };
      const guard = guardWith(counter, (request) =>
        request.url.includes("/search/jql") ? entry.scripted : undefined,
      );
      const authority = registerEnvelope("autonomous-delivery", READ_SCOPE);
      const { status, body } = await postLiveSearch(
        { type: "search-issues-live", jql: FREE_JQL },
        authority,
        deps(guard, "autonomous-delivery"),
      );
      expect(status).toBe(200);
      expect(body.disposition).toBe("allowed");
      expect(body.result).toEqual({ status: "failed", reason: entry.reason });
      expect(body.liveSearch).toBeUndefined();
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("expired token");
      expect(serialized).not.toContain("no browse permission");
      const records = atlassianSyncJobRegistry.listActivity(connectorIdForAuthRef(JIRA_AUTH_REF));
      expect(records.map((record) => record.outcome)).toEqual(["failed"]);
      expect(records[0]?.reasonCode).toBe(entry.reason);
      expect(records[0]?.jqlDigest).toBe(sha256Hex(FREE_JQL));
    }
  });

  it("keeps existing write actions working through the extended union (no regression)", async () => {
    const counter: FetchCounter = { count: 0, requests: [] };
    const guard = guardWith(counter, (request) =>
      request.method === "POST" && request.url.includes("/comment")
        ? {
            kind: "response",
            status: 201,
            bodyText: '{"id":"20001"}',
            bodyBytes: 14,
            truncated: false,
          }
        : undefined,
    );
    const authority = registerEnvelope("autonomous-delivery", [
      "issue-tracker.read",
      "issue-tracker.write",
    ]);
    const result = (await handleExecuteAtlassianConnectorAction(
      ctx(
        {
          action: { type: "add-issue-comment", issueKey: "PROJ-7", commentText: "Verified" },
          authority,
        },
        { authRef: JIRA_AUTH_REF },
      ),
      deps(guard, "autonomous-delivery"),
    )) as RouteReply;
    expect(result.status).toBe(200);
    expect(result.body.disposition).toBe("allowed");
    expect((result.body.result as { status: string }).status).toBe("succeeded");
  });
});
