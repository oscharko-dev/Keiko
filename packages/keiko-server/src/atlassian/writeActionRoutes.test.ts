// Issue #2244 — route-level governance tests for the Confluence/Jira write actions. Hermetic: no
// network (the transport port is a counting fixture), no wall-clock races (envelopes register
// far-future or with pinned past instants), singleton registries reset around every test.
//
// The mode × action × scope matrix asserts against a LITERAL copy of the ADR-0128 D4 table —
// never re-derived through the contract helper — so the routes are proven against the ADR, not
// against themselves.

import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS,
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_SCHEMA_VERSION,
  validateAtlassianConnectorActivityRecord,
  validateAtlassianConnectorPendingApproval,
  type AtlassianConnectorActivityRecord,
  type AtlassianConnectorPendingApproval,
  type CodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchConnectorScope,
  type CodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts";
import type {
  AtlassianCredentialCustody,
  AtlassianCredentialMetadata,
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
} from "@oscharko-dev/keiko-connectors";
import type { RouteContext } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  editorAgentAuthorityRegistry,
  editorAgentWorkspaceRootDigest,
} from "../editor/agentAuthorityRegistry.js";
import {
  ATLASSIAN_ACTION_APPROVAL_MAX_PENDING,
  atlassianActionApprovalRegistry,
} from "./actionApprovals.js";
import type { AtlassianConnectorCredentialDeps } from "./credentialRoutes.js";
import { atlassianSyncJobRegistry, connectorIdForAuthRef } from "./syncService.js";
import {
  handleApproveAtlassianConnectorActionApproval,
  handleExecuteAtlassianConnectorAction,
  handleGetAtlassianConnectorActionApproval,
  handleListAtlassianConnectorActionApprovals,
  handleRejectAtlassianConnectorActionApproval,
} from "./writeActionRoutes.js";

const ROOT = "/repo";
const JIRA_AUTH_REF = `atlassian-cred:${"A".repeat(22)}`;
const CONFLUENCE_AUTH_REF = `atlassian-cred:${"B".repeat(22)}`;
const BOTH_WRITE_SCOPES: readonly CodingWorkbenchConnectorScope[] = [
  "issue-tracker.write",
  "knowledge-base.write",
];

// ─── Fixtures ───────────────────────────────────────────────────────────────────
function credential(provider: "jira" | "confluence"): AtlassianCredentialMetadata {
  return {
    schemaVersion: "1",
    authRef: provider === "jira" ? JIRA_AUTH_REF : CONFLUENCE_AUTH_REF,
    provider,
    displayName: provider === "jira" ? "Jira (Prod)" : "Confluence (Prod)",
    baseUrl: "https://example.atlassian.net",
    authScheme: "basic-api-token",
    createdAt: 1,
  };
}

interface FetchCounter {
  count: number;
  readonly requests: AtlassianHttpBodyRequest[];
}

function response(status: number, bodyText = "{}"): AtlassianHttpBodyResult {
  return { kind: "response", status, bodyText, bodyBytes: bodyText.length, truncated: false };
}

// Answers a plausible minimal success for every write endpoint, unless an override matches.
function fixturePort(
  counter: FetchCounter,
  override?: (request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult | undefined,
): AtlassianHttpBodyPort {
  return (request) => {
    counter.count += 1;
    counter.requests.push(request);
    const overridden = override?.(request);
    if (overridden !== undefined) return Promise.resolve(overridden);
    if (request.url.endsWith("/transitions") && request.method === "GET") {
      return Promise.resolve(response(200, '{"transitions":[{"id":"31"}]}'));
    }
    if (request.method === "PUT") return Promise.resolve(response(204, ""));
    if (request.url.endsWith("/rest/api/3/issue")) {
      return Promise.resolve(response(201, '{"id":"10001","key":"PROJ-9"}'));
    }
    if (request.url.includes("/comment") || request.url.endsWith("/footer-comments")) {
      return Promise.resolve(response(201, '{"id":"20001"}'));
    }
    if (request.url.endsWith("/wiki/api/v2/pages")) {
      return Promise.resolve(response(200, '{"id":"123","version":{"number":1}}'));
    }
    return Promise.resolve(response(204, ""));
  };
}

function guardWith(
  counter: FetchCounter,
  override?: (request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult | undefined,
): AtlassianConnectorCredentialDeps {
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
    httpBodyPortFactory: () => fixturePort(counter, override),
  };
}

function deps(guard: AtlassianConnectorCredentialDeps, mode: CodingWorkbenchMode): UiHandlerDeps {
  return {
    atlassianConnectorCredentials: guard,
    autonomousDeliveryDeploymentCeiling: mode,
  } as UiHandlerDeps;
}

function envelope(
  mode: CodingWorkbenchMode,
  connectorScopes: readonly CodingWorkbenchConnectorScope[],
  over: Partial<CodingWorkbenchAuthorityEnvelope> = {},
): CodingWorkbenchAuthorityEnvelope {
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    runId: "run-2244",
    localUser: "local-operator",
    taskRefs: ["issue-2244"],
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
  over: Partial<CodingWorkbenchAuthorityEnvelope> = {},
  registeredAtIso = new Date().toISOString(),
): AuthorityContext {
  const registration = editorAgentAuthorityRegistry.register(
    envelope(mode, connectorScopes, over),
    mode,
    registeredAtIso,
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

type WriteActionType =
  | "create-issue"
  | "update-issue-fields"
  | "transition-issue"
  | "add-issue-comment"
  | "create-page"
  | "update-page"
  | "add-page-comment";

const ACTION_REQUESTS: Readonly<Record<WriteActionType, Record<string, unknown>>> = {
  "create-issue": {
    type: "create-issue",
    projectKey: "PROJ",
    issueTypeId: "10004",
    summary: "Fix the flaky gate",
    descriptionText: "Fails on\n\n- retries",
  },
  "update-issue-fields": { type: "update-issue-fields", issueKey: "PROJ-9", summary: "Sharper" },
  "transition-issue": { type: "transition-issue", issueKey: "PROJ-9", transitionId: "31" },
  "add-issue-comment": {
    type: "add-issue-comment",
    issueKey: "PROJ-9",
    commentText: "Verified on staging",
  },
  "create-page": { type: "create-page", spaceId: "777", title: "Runbook", bodyText: "Steps here" },
  "update-page": {
    type: "update-page",
    pageId: "123",
    title: "Runbook",
    bodyText: "New body",
    currentVersion: 4,
  },
  "add-page-comment": { type: "add-page-comment", pageId: "123", commentText: "Looks right" },
};

function authRefFor(action: WriteActionType): string {
  return action === "create-page" || action === "update-page" || action === "add-page-comment"
    ? CONFLUENCE_AUTH_REF
    : JIRA_AUTH_REF;
}

async function postAction(
  action: WriteActionType,
  authority: AuthorityContext,
  mode: CodingWorkbenchMode,
  guard: AtlassianConnectorCredentialDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const result = await handleExecuteAtlassianConnectorAction(
    ctx({ action: ACTION_REQUESTS[action], authority }, { authRef: authRefFor(action) }),
    deps(guard, mode),
  );
  return result as { status: number; body: Record<string, unknown> };
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

// ─── AC1: the D4 matrix at route level (LITERAL table, not re-derived) ─────────
const WRITE_ACTIONS: readonly WriteActionType[] = [
  "create-issue",
  "update-issue-fields",
  "transition-issue",
  "add-issue-comment",
  "create-page",
  "update-page",
  "add-page-comment",
];

// ADR-0128 D4 disposition columns for the seven write rows, copied verbatim.
const D4_WRITE_DISPOSITIONS: Readonly<
  Record<CodingWorkbenchMode, Readonly<Record<WriteActionType, "allowed" | "review-required">>>
> = {
  "governed-assist": {
    "create-issue": "review-required",
    "update-issue-fields": "review-required",
    "transition-issue": "review-required",
    "add-issue-comment": "review-required",
    "create-page": "review-required",
    "update-page": "review-required",
    "add-page-comment": "review-required",
  },
  "supervised-coding": {
    "create-issue": "review-required",
    "update-issue-fields": "review-required",
    "transition-issue": "review-required",
    "add-issue-comment": "review-required",
    "create-page": "review-required",
    "update-page": "review-required",
    "add-page-comment": "review-required",
  },
  "autonomous-delivery": {
    "create-issue": "allowed",
    "update-issue-fields": "allowed",
    "transition-issue": "allowed",
    "add-issue-comment": "allowed",
    "create-page": "allowed",
    "update-page": "allowed",
    "add-page-comment": "allowed",
  },
};

const MODES: readonly CodingWorkbenchMode[] = [
  "governed-assist",
  "supervised-coding",
  "autonomous-delivery",
];

describe("write-action route — ADR-0128 D4 matrix (AC1)", () => {
  it("matches every action × mode cell with the write scopes present", async () => {
    for (const mode of MODES) {
      for (const action of WRITE_ACTIONS) {
        editorAgentAuthorityRegistry.reset();
        atlassianActionApprovalRegistry.reset();
        const counter: FetchCounter = { count: 0, requests: [] };
        const guard = guardWith(counter);
        const authority = registerEnvelope(mode, BOTH_WRITE_SCOPES);
        const expected = D4_WRITE_DISPOSITIONS[mode][action];
        const { status, body } = await postAction(action, authority, mode, guard);
        expect({ mode, action, disposition: body.disposition }).toEqual({
          mode,
          action,
          disposition: expected,
        });
        if (expected === "allowed") {
          expect(status).toBe(200);
          expect((body.result as { status: string }).status).toBe("succeeded");
          expect(counter.count).toBeGreaterThan(0);
        } else {
          expect(status).toBe(202);
          expect(body.approval).toBeDefined();
          expect(counter.count).toBe(0);
        }
      }
    }
  });

  it("denies every write action with connector-write-denied when the write scope is absent, in ALL modes including Full access", async () => {
    for (const mode of MODES) {
      for (const action of WRITE_ACTIONS) {
        for (const connectorScopes of [
          [] as readonly CodingWorkbenchConnectorScope[],
          ["issue-tracker.read", "knowledge-base.read"] as readonly CodingWorkbenchConnectorScope[],
        ]) {
          editorAgentAuthorityRegistry.reset();
          const counter: FetchCounter = { count: 0, requests: [] };
          const guard = guardWith(counter);
          const authority = registerEnvelope(mode, connectorScopes);
          const { status, body } = await postAction(action, authority, mode, guard);
          expect(status).toBe(200);
          expect(body.disposition).toBe("denied");
          expect(body.reasonCode).toBe("connector-write-denied");
          expect(counter.count).toBe(0);
        }
      }
    }
  });
});

// ─── AC2: Ask for approval — pending, approve, reject ──────────────────────────
describe("write-action route — pending approvals (AC2)", () => {
  it("parks a pending approval with ZERO fetcher invocations, then approve executes", async () => {
    const counter: FetchCounter = { count: 0, requests: [] };
    const guard = guardWith(counter);
    const authority = registerEnvelope("governed-assist", BOTH_WRITE_SCOPES);
    const { status, body } = await postAction("create-issue", authority, "governed-assist", guard);
    expect(status).toBe(202);
    expect(counter.count).toBe(0);
    const approval = body.approval as AtlassianConnectorPendingApproval;
    expect(validateAtlassianConnectorPendingApproval(approval).ok).toBe(true);
    expect(approval.actionType).toBe("create-issue");
    expect(approval.reviewReason).toBe("deterministic-risk-approval-required");
    // The projection lists through the read endpoints for the #2245 UI.
    const listed = (await handleListAtlassianConnectorActionApprovals(
      ctx({}, {}),
      deps(guard, "governed-assist"),
    )) as { body: { approvals: readonly AtlassianConnectorPendingApproval[] } };
    expect(listed.body.approvals.map((entry) => entry.approvalId)).toEqual([approval.approvalId]);
    const fetched = (await handleGetAtlassianConnectorActionApproval(
      ctx({}, { approvalId: approval.approvalId }),
      deps(guard, "governed-assist"),
    )) as { status: number };
    expect(fetched.status).toBe(200);
    expect(counter.count).toBe(0);
    // Approve → executes now with the review-required disposition on the wire and in audit.
    const approved = (await handleApproveAtlassianConnectorActionApproval(
      ctx({}, { approvalId: approval.approvalId }),
      deps(guard, "governed-assist"),
    )) as { status: number; body: Record<string, unknown> };
    expect(approved.status).toBe(200);
    expect(approved.body.disposition).toBe("review-required");
    expect((approved.body.result as { status: string; targetRef?: string }).status).toBe(
      "succeeded",
    );
    expect(counter.count).toBeGreaterThan(0);
    // Single-use: a second approve finds nothing.
    const replayed = (await handleApproveAtlassianConnectorActionApproval(
      ctx({}, { approvalId: approval.approvalId }),
      deps(guard, "governed-assist"),
    )) as { status: number };
    expect(replayed.status).toBe(404);
  });

  it("reject records and never executes", async () => {
    const counter: FetchCounter = { count: 0, requests: [] };
    const guard = guardWith(counter);
    const authority = registerEnvelope("governed-assist", BOTH_WRITE_SCOPES);
    const { body } = await postAction("add-page-comment", authority, "governed-assist", guard);
    const approval = body.approval as AtlassianConnectorPendingApproval;
    const rejected = (await handleRejectAtlassianConnectorActionApproval(
      ctx({}, { approvalId: approval.approvalId }),
      deps(guard, "governed-assist"),
    )) as { status: number; body: Record<string, unknown> };
    expect(rejected.status).toBe(200);
    expect(rejected.body.outcome).toBe("cancelled");
    expect(counter.count).toBe(0);
    // Rejected approvals cannot be approved afterwards.
    const approved = (await handleApproveAtlassianConnectorActionApproval(
      ctx({}, { approvalId: approval.approvalId }),
      deps(guard, "governed-assist"),
    )) as { status: number };
    expect(approved.status).toBe(404);
    expect(counter.count).toBe(0);
    const records = atlassianSyncJobRegistry.listActivity(
      connectorIdForAuthRef(CONFLUENCE_AUTH_REF),
    );
    expect(records.map((record) => record.outcome)).toEqual(["pending-review", "cancelled"]);
  });
});

// KEIKO-0186: a human approving a governed Atlassian write could see only the action type and a
// bare identifier — never the content about to be written — making the review-required check an
// uninformed rubber-stamp. This is the finding's own acceptance scenario: create a pending
// approval for each write action with known text, read back the AtlassianConnectorPendingApproval
// the approve endpoint would return, and assert it contains that text (bounded) — while the SAME
// action's permanent activity record stays exactly as content-free as before (ADR-0128 D6).
// transition-issue is deliberately absent from EXPECTED_PREVIEW_SUBSTRINGS: it carries no text
// field, so it must have no preview.
const EXPECTED_PREVIEW_SUBSTRINGS: Readonly<
  Record<WriteActionType, readonly string[] | undefined>
> = {
  "create-issue": ["Fix the flaky gate", "Fails on"],
  "update-issue-fields": ["Sharper"],
  "transition-issue": undefined,
  "add-issue-comment": ["Verified on staging"],
  "create-page": ["Runbook", "Steps here"],
  "update-page": ["Runbook", "New body"],
  "add-page-comment": ["Looks right"],
};

describe("write-action route — content preview on pending approvals (KEIKO-0186)", () => {
  it("carries a bounded content preview reflecting each action's own text, absent from the permanent activity record", async () => {
    for (const action of WRITE_ACTIONS) {
      editorAgentAuthorityRegistry.reset();
      atlassianActionApprovalRegistry.reset();
      atlassianSyncJobRegistry.reset();
      const counter: FetchCounter = { count: 0, requests: [] };
      const guard = guardWith(counter);
      const authority = registerEnvelope("governed-assist", BOTH_WRITE_SCOPES);
      const { body } = await postAction(action, authority, "governed-assist", guard);
      const approval = body.approval as AtlassianConnectorPendingApproval;
      expect(validateAtlassianConnectorPendingApproval(approval).ok).toBe(true);

      const expectedSubstrings = EXPECTED_PREVIEW_SUBSTRINGS[action];
      if (expectedSubstrings === undefined) {
        expect(approval.contentPreview, `${action} should have no content preview`).toBeUndefined();
      } else {
        for (const substring of expectedSubstrings) {
          expect(approval.contentPreview, `${action} should preview its own text`).toContain(
            substring,
          );
        }
      }

      // Redaction-boundary pin: the SAME action's activity record must stay exactly as
      // content-free as before — present on the approval, absent from the permanent record.
      const records = atlassianSyncJobRegistry.listActivity(
        connectorIdForAuthRef(authRefFor(action)),
      );
      const pendingRecord = records.find((record) => record.disposition === "review-required");
      if (pendingRecord === undefined) {
        throw new Error(`expected a pending-review activity record for ${action}`);
      }
      expect(validateAtlassianConnectorActivityRecord(pendingRecord).ok).toBe(true);
      const serializedRecord = JSON.stringify(pendingRecord);
      expect(serializedRecord).not.toContain("contentPreview");
      if (expectedSubstrings !== undefined) {
        for (const substring of expectedSubstrings) {
          expect(serializedRecord).not.toContain(substring);
        }
      }
    }
  });
});

// KEIKO-0186 P1 (Codex): a write action's text can be non-empty on the wire yet sanitize (or
// truncate) to nothing presentable -- e.g. an all-zero-width-space comment. Emitting an empty
// contentPreview in that case would show a reviewer what looks like a contentless action while
// invisible content is actually written: the exact failure this class of finding is about. Every
// case below must produce contentPreviewUnavailable === true and contentPreview === undefined,
// through the SAME route as the test above, with the SAME activity-record redaction pin.
// transition-issue is excluded: it has no text field, so hostile-text substitution does not apply.
type TextBearingWriteActionType = Exclude<WriteActionType, "transition-issue">;

function hostileActionRequest(
  action: TextBearingWriteActionType,
  hostileText: string,
): Record<string, unknown> {
  switch (action) {
    case "create-issue":
      return {
        type: "create-issue",
        projectKey: "PROJ",
        issueTypeId: "10004",
        summary: hostileText,
      };
    case "update-issue-fields":
      return { type: "update-issue-fields", issueKey: "PROJ-9", summary: hostileText };
    case "add-issue-comment":
      return { type: "add-issue-comment", issueKey: "PROJ-9", commentText: hostileText };
    case "create-page":
      return { type: "create-page", spaceId: "777", title: hostileText, bodyText: "" };
    case "update-page":
      return {
        type: "update-page",
        pageId: "123",
        title: hostileText,
        bodyText: "",
        currentVersion: 4,
      };
    case "add-page-comment":
      return { type: "add-page-comment", pageId: "123", commentText: hostileText };
  }
}

async function postHostileAction(
  action: TextBearingWriteActionType,
  hostileText: string,
  authority: AuthorityContext,
  guard: AtlassianConnectorCredentialDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const result = await handleExecuteAtlassianConnectorAction(
    ctx(
      { action: hostileActionRequest(action, hostileText), authority },
      { authRef: authRefFor(action) },
    ),
    deps(guard, "governed-assist"),
  );
  return result as { status: number; body: Record<string, unknown> };
}

// Every write action with a text field (all but transition-issue).
const TEXT_BEARING_WRITE_ACTIONS: readonly TextBearingWriteActionType[] = [
  "create-issue",
  "update-issue-fields",
  "add-issue-comment",
  "create-page",
  "update-page",
  "add-page-comment",
];

// Shared assertion sequence for "the action had text, but nothing presentable survived
// sanitization/bounding": the approval must validate, must carry contentPreviewUnavailable
// (never an empty or absent-without-explanation contentPreview), and the SAME action's permanent
// activity record must stay exactly as content-free as any other pending-review action.
async function expectUnavailablePreview(
  action: TextBearingWriteActionType,
  hostileText: string,
): Promise<void> {
  editorAgentAuthorityRegistry.reset();
  atlassianActionApprovalRegistry.reset();
  atlassianSyncJobRegistry.reset();
  const counter: FetchCounter = { count: 0, requests: [] };
  const guard = guardWith(counter);
  const authority = registerEnvelope("governed-assist", BOTH_WRITE_SCOPES);
  const { body } = await postHostileAction(action, hostileText, authority, guard);
  const approval = body.approval as AtlassianConnectorPendingApproval;
  expect(validateAtlassianConnectorPendingApproval(approval).ok, action).toBe(true);
  expect(approval.contentPreviewUnavailable, action).toBe(true);
  expect(approval.contentPreview, action).toBeUndefined();

  // Redaction-boundary pin, exactly as the KEIKO-0186 test above: still content-free on the
  // permanent record.
  const records = atlassianSyncJobRegistry.listActivity(connectorIdForAuthRef(authRefFor(action)));
  const pendingRecord = records.find((record) => record.disposition === "review-required");
  if (pendingRecord === undefined) {
    throw new Error(`expected a pending-review activity record for ${action}`);
  }
  expect(validateAtlassianConnectorActivityRecord(pendingRecord).ok, action).toBe(true);
  expect(JSON.stringify(pendingRecord), action).not.toContain("contentPreview");
}

describe("write-action route — unpresentable content preview after sanitization (KEIKO-0186 P1/P2)", () => {
  it("an all-zero-width-space payload is reported unavailable for every text-bearing action, never as an empty preview", async () => {
    const allZeroWidth = String.fromCharCode(0x200b).repeat(12);
    for (const action of TEXT_BEARING_WRITE_ACTIONS) {
      await expectUnavailablePreview(action, allZeroWidth);
    }
  });

  it("an all-bidi-override payload is reported unavailable, not an empty preview", async () => {
    const allBidi = String.fromCharCode(0x202e).repeat(12);
    await expectUnavailablePreview("create-issue", allBidi);
  });

  it("a mixed bidi+zero-width payload that sanitizes to empty is reported unavailable, not an empty preview", async () => {
    const mixedInvisible =
      String.fromCharCode(0x202e) +
      String.fromCharCode(0x200b) +
      String.fromCharCode(0x202e) +
      String.fromCharCode(0x200b);
    await expectUnavailablePreview("add-page-comment", mixedInvisible);
  });

  // KEIKO-0186 P2 (Codex): the P1 predicate's anchored pattern (^\p{M}+$) stopped matching the
  // moment any OTHER character was present, including whitespace -- a whitespace-only preview, or
  // whitespace next to a P1 shape, rendered as an apparently blank "available" preview. Same
  // failure mode as P1 (a reviewer approving content they cannot see), reached through a
  // different input; same fix (isAtlassianContentPreviewUnpresentable), so the same route/helper
  // pins it here too.

  it("a whitespace-only (space) payload is reported unavailable for every text-bearing action", async () => {
    for (const action of TEXT_BEARING_WRITE_ACTIONS) {
      await expectUnavailablePreview(action, " ");
    }
  });

  it("TAB, LF, and mixed-whitespace payloads are reported unavailable via the comment fields (summary/title reject multi-line text on the wire, so a single space is the only whitespace value the loop above can share across every action)", async () => {
    const tab = String.fromCharCode(9);
    const lf = String.fromCharCode(10);
    await expectUnavailablePreview("add-issue-comment", tab);
    await expectUnavailablePreview("add-page-comment", lf);
    await expectUnavailablePreview("add-issue-comment", " " + tab + lf + " ");
  });

  it("whitespace next to a combining mark, in either order, is reported unavailable", async () => {
    const spaceThenMark = " " + String.fromCharCode(0x301);
    const markThenSpace = String.fromCharCode(0x301) + " ";
    await expectUnavailablePreview("create-issue", spaceThenMark);
    await expectUnavailablePreview("create-issue", markThenSpace);
  });

  it("whitespace next to a zero-width character sanitizes to whitespace-only and is reported unavailable", async () => {
    const spaceThenZeroWidth = " " + String.fromCharCode(0x200b);
    await expectUnavailablePreview("add-page-comment", spaceThenZeroWidth);
  });

  it("truncation can produce a whitespace-only tail through the real route, even when the untruncated text has a base character past the bound", async () => {
    // create-issue's summary/create-page's title are capped at 255 chars on the wire (well under
    // MAX+1) -- commentText has no such ceiling (bounded at 100,000 chars), so it is the field
    // that can actually carry a payload long enough to exercise truncation through the real route.
    const spacePrefix = " ".repeat(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS);
    const commentText = spacePrefix + "X";
    expect(commentText.length).toBeGreaterThan(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS);
    await expectUnavailablePreview("add-issue-comment", commentText);
  });

  it("truncation can produce a whitespace-plus-combining-mark tail through the real route, even when the untruncated text has a base character past the bound", async () => {
    // No separate "truncation-induced whitespace-plus-zero-width" pin: zero-width characters are
    // removed by sanitization, which runs BEFORE truncation, so they can never be part of what
    // survives INTO a truncation window (see the equivalent note in actionApprovals.test.ts).
    const pairs = (" " + String.fromCharCode(0x301)).repeat(
      Math.ceil(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS / 2),
    );
    const commentText = pairs.slice(0, ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS) + "X";
    expect(commentText.length).toBeGreaterThan(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS);
    await expectUnavailablePreview("add-issue-comment", commentText);
  });
});

// ─── AC3: Full access executes; envelope failures deny with the EXISTING codes ─
describe("write-action route — envelope authority (AC3)", () => {
  it("executes without per-action approval inside a valid Full-access envelope", async () => {
    const counter: FetchCounter = { count: 0, requests: [] };
    const guard = guardWith(counter);
    const authority = registerEnvelope("autonomous-delivery", BOTH_WRITE_SCOPES);
    const { status, body } = await postAction(
      "create-issue",
      authority,
      "autonomous-delivery",
      guard,
    );
    expect(status).toBe(200);
    expect(body.disposition).toBe("allowed");
    expect((body.result as { targetRef?: string }).targetRef).toBe("PROJ-9");
    expect(atlassianActionApprovalRegistry.listPending()).toEqual([]);
  });

  it("denies an expired envelope with authority-expired", async () => {
    const counter: FetchCounter = { count: 0, requests: [] };
    const guard = guardWith(counter);
    // Registered at a pinned PAST instant with a PAST expiry: valid at registration time,
    // deterministically expired when the route resolves with the real clock.
    const authority = registerEnvelope(
      "autonomous-delivery",
      BOTH_WRITE_SCOPES,
      { expiresAt: "2020-01-02T00:00:00.000Z" },
      "2020-01-01T00:00:00.000Z",
    );
    const { body } = await postAction("create-issue", authority, "autonomous-delivery", guard);
    expect(body.disposition).toBe("denied");
    expect(body.reasonCode).toBe("authority-expired");
    expect(counter.count).toBe(0);
  });

  it("denies a digest mismatch with authority-invalid", async () => {
    const counter: FetchCounter = { count: 0, requests: [] };
    const guard = guardWith(counter);
    const authority = registerEnvelope("autonomous-delivery", BOTH_WRITE_SCOPES);
    const { body } = await postAction(
      "create-issue",
      { ...authority, envelopeDigest: "f".repeat(64) },
      "autonomous-delivery",
      guard,
    );
    expect(body.disposition).toBe("denied");
    expect(body.reasonCode).toBe("authority-invalid");
    expect(counter.count).toBe(0);
  });

  it("denies a runtime-budget-exhausted envelope with authority-budget-exceeded", async () => {
    const counter: FetchCounter = { count: 0, requests: [] };
    const guard = guardWith(counter);
    // Registered far in the past with a tiny runtime budget and a far-future expiry: the runtime
    // budget is deterministically exhausted when the route resolves.
    const authority = registerEnvelope(
      "autonomous-delivery",
      BOTH_WRITE_SCOPES,
      {
        budget: {
          maxRuntimeMs: 60_000,
          maxToolCalls: 50,
          maxPromptTokens: 10_000,
          maxPatchBytes: 65_536,
        },
      },
      "2020-01-01T00:00:00.000Z",
    );
    const { body } = await postAction("create-issue", authority, "autonomous-delivery", guard);
    expect(body.disposition).toBe("denied");
    expect(body.reasonCode).toBe("authority-budget-exceeded");
    expect(counter.count).toBe(0);
  });

  it("denies with authority-budget-exceeded when the toolCall budget is consumed", async () => {
    const counter: FetchCounter = { count: 0, requests: [] };
    const guard = guardWith(counter);
    const authority = registerEnvelope("autonomous-delivery", BOTH_WRITE_SCOPES, {
      budget: { maxRuntimeMs: 3_600_000, maxToolCalls: 1, maxPromptTokens: 1, maxPatchBytes: 1 },
    });
    const first = await postAction("add-issue-comment", authority, "autonomous-delivery", guard);
    expect(first.body.disposition).toBe("allowed");
    const second = await postAction("add-issue-comment", authority, "autonomous-delivery", guard);
    expect(second.body.disposition).toBe("denied");
    expect(second.body.reasonCode).toBe("authority-budget-exceeded");
  });

  it("400s a request without the authority context — no ungoverned bypass exists", async () => {
    const guard = guardWith({ count: 0, requests: [] });
    const result = (await handleExecuteAtlassianConnectorAction(
      ctx({ action: ACTION_REQUESTS["add-issue-comment"] }, { authRef: JIRA_AUTH_REF }),
      deps(guard, "autonomous-delivery"),
    )) as { status: number };
    expect(result.status).toBe(400);
  });
});

// ─── AC4: audit completeness with scanning assertions ──────────────────────────
describe("write-action route — audit completeness (AC4)", () => {
  it("emits exactly one content-free record per attempt across allowed/review-required/denied/provider-failure", async () => {
    const counter: FetchCounter = { count: 0, requests: [] };
    const guard = guardWith(counter, (request) =>
      request.method === "PUT" && request.url.includes("/wiki/api/v2/pages/")
        ? response(409, '{"detail":"version conflict on Runbook"}')
        : undefined,
    );
    // allowed + succeeded (Full access comment).
    const allowedAuthority = registerEnvelope("autonomous-delivery", BOTH_WRITE_SCOPES);
    await postAction("add-issue-comment", allowedAuthority, "autonomous-delivery", guard);
    // provider-failure: allowed update-page hits the scripted 409 → typed conflict.
    await postAction("update-page", allowedAuthority, "autonomous-delivery", guard);
    // review-required (pending) under Ask for approval.
    editorAgentAuthorityRegistry.reset();
    const reviewAuthority = registerEnvelope("governed-assist", BOTH_WRITE_SCOPES);
    await postAction("create-issue", reviewAuthority, "governed-assist", guard);
    // denied: write scope absent.
    editorAgentAuthorityRegistry.reset();
    const deniedAuthority = registerEnvelope("autonomous-delivery", []);
    await postAction("transition-issue", deniedAuthority, "autonomous-delivery", guard);

    const jira = atlassianSyncJobRegistry.listActivity(connectorIdForAuthRef(JIRA_AUTH_REF));
    const confluence = atlassianSyncJobRegistry.listActivity(
      connectorIdForAuthRef(CONFLUENCE_AUTH_REF),
    );
    const records: readonly AtlassianConnectorActivityRecord[] = [...jira, ...confluence];
    expect(records).toHaveLength(4);
    expect(
      records.map((record) => ({
        actionType: record.actionType,
        disposition: record.disposition,
        outcome: record.outcome,
        reasonCode: record.reasonCode,
      })),
    ).toEqual([
      {
        actionType: "add-issue-comment",
        disposition: "allowed",
        outcome: "succeeded",
        reasonCode: undefined,
      },
      {
        actionType: "create-issue",
        disposition: "review-required",
        outcome: "pending-review",
        reasonCode: "deterministic-risk-approval-required",
      },
      {
        actionType: "transition-issue",
        disposition: "denied",
        outcome: "denied",
        reasonCode: "connector-write-denied",
      },
      {
        actionType: "update-page",
        disposition: "allowed",
        outcome: "failed",
        reasonCode: "conflict",
      },
    ]);
    // Every record passes the contract validator (shape, D4 pinning, reason pairing).
    for (const record of records) {
      expect(validateAtlassianConnectorActivityRecord(record).ok).toBe(true);
    }
    // Scanning assertion: no body text, no field values, no token-shaped content anywhere.
    const serialized = JSON.stringify(records);
    for (const leaked of [
      "Verified on staging",
      "Fix the flaky gate",
      "Fails on",
      "retries",
      "Runbook",
      "New body",
      "version conflict",
      "Sharper",
      "token",
      "Authorization",
      "Basic ",
    ]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  // KEIKO-0339: a review-required creation that fails on registry capacity (429
  // APPROVALS_EXHAUSTED) must still emit exactly one denied activity record with the
  // closed `approvals-registry-exhausted` reason, so the "one record per attempt" invariant
  // survives capacity denials.
  it("records the rejected attempt when APPROVALS_EXHAUSTED capacity denies a review-required creation", async () => {
    // Fill the registry to the 64-entry cap with distinct entries so the 65th create() lands
    // on the capacity-exhausted branch. Using registry.create() directly (rather than driving
    // 64 route calls) keeps the fixture bounded and does not depend on any per-approval
    // deduplication logic that a route might introduce.
    const authority = registerEnvelope("governed-assist", BOTH_WRITE_SCOPES);
    for (let index = 0; index < ATLASSIAN_ACTION_APPROVAL_MAX_PENDING; index += 1) {
      const filler = atlassianActionApprovalRegistry.create({
        approval: {
          schemaVersion: "1",
          approvalId: `apr_filler-${String(index).padStart(4, "0")}`,
          connectorId: connectorIdForAuthRef(JIRA_AUTH_REF),
          provider: "jira",
          actionType: "add-issue-comment",
          actionClass: "connector-write",
          requiredScope: "issue-tracker.write",
          risk: "low",
          reviewReason: "deterministic-risk-approval-required",
          correlationId: `req_filler-${String(index).padStart(4, "0")}`,
          requestedAt: 1,
          expiresAt: Number.MAX_SAFE_INTEGER,
        },
        authority: {
          runId: authority.runId,
          envelopeDigest: authority.envelopeDigest,
          workspaceRoot: authority.workspaceRoot,
        },
        authRef: JIRA_AUTH_REF,
        payload: {
          kind: "write-action",
          action: {
            type: "add-issue-comment",
            issueKey: `PROJ-${String(index + 100)}`,
            commentText: "filler",
          },
        },
      });
      expect(filler.ok).toBe(true);
    }
    const guard = guardWith({ count: 0, requests: [] });
    const { status, body } = await postAction("create-issue", authority, "governed-assist", guard);
    expect(status).toBe(429);
    expect((body.error as { code: string }).code).toBe("APPROVALS_EXHAUSTED");
    const records = atlassianSyncJobRegistry.listActivity(connectorIdForAuthRef(JIRA_AUTH_REF));
    const rejected = records.filter(
      (record) => record.actionType === "create-issue" && record.disposition === "denied",
    );
    expect(rejected).toHaveLength(1);
    const only = rejected[0];
    expect(only?.outcome).toBe("denied");
    expect(only?.reasonCode).toBe("approvals-registry-exhausted");
    expect(validateAtlassianConnectorActivityRecord(only ?? {}).ok).toBe(true);
  });
});

// ─── AC5: typed provider results through the route ─────────────────────────────
describe("write-action route — typed provider failures (AC5)", () => {
  it("answers the Confluence version conflict as a typed result", async () => {
    const counter: FetchCounter = { count: 0, requests: [] };
    const guard = guardWith(counter, (request) =>
      request.method === "PUT" && request.url.includes("/wiki/api/v2/pages/")
        ? response(409, "{}")
        : undefined,
    );
    const authority = registerEnvelope("autonomous-delivery", BOTH_WRITE_SCOPES);
    const { body } = await postAction("update-page", authority, "autonomous-delivery", guard);
    expect(body.disposition).toBe("allowed");
    expect(body.result).toEqual({ status: "failed", reason: "conflict", httpStatus: 409 });
  });

  it("answers the Jira invalid transition as a typed result without a mutating call", async () => {
    const counter: FetchCounter = { count: 0, requests: [] };
    const guard = guardWith(counter, (request) =>
      request.url.endsWith("/transitions") && request.method === "GET"
        ? response(200, '{"transitions":[{"id":"11"}]}')
        : undefined,
    );
    const authority = registerEnvelope("autonomous-delivery", BOTH_WRITE_SCOPES);
    const { body } = await postAction("transition-issue", authority, "autonomous-delivery", guard);
    expect(body.result).toEqual({ status: "failed", reason: "invalid-transition" });
    expect(counter.requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("rejects a provider/action mismatch and hostile action payloads with 400", async () => {
    const guard = guardWith({ count: 0, requests: [] });
    const authority = registerEnvelope("autonomous-delivery", BOTH_WRITE_SCOPES);
    const mismatched = (await handleExecuteAtlassianConnectorAction(
      ctx({ action: ACTION_REQUESTS["create-page"], authority }, { authRef: JIRA_AUTH_REF }),
      deps(guard, "autonomous-delivery"),
    )) as { status: number };
    expect(mismatched.status).toBe(400);
    const unexpectedField = (await handleExecuteAtlassianConnectorAction(
      ctx(
        {
          action: { ...ACTION_REQUESTS["add-issue-comment"], secretToken: "x" },
          authority,
        },
        { authRef: JIRA_AUTH_REF },
      ),
      deps(guard, "autonomous-delivery"),
    )) as { status: number };
    expect(unexpectedField.status).toBe(400);
  });
});

// ─── KEIKO-0488: BFF must reuse the connector package's exported bounds ─────────
describe("write-action route — reuses connector-package text bounds (KEIKO-0488)", () => {
  it("declares no local SINGLE_LINE_TEXT_MAX_CHARS constant", () => {
    const routesUrl = new URL("./writeActionRoutes.ts", import.meta.url);
    const source = readFileSync(fileURLToPath(routesUrl), "utf8");
    expect(source).not.toMatch(/SINGLE_LINE_TEXT_MAX_CHARS\s*=/u);
  });
});

// ─── KEIKO-0319: allow explicit "clear this field" for labels and composable body
describe("write-action route — clear-field validation (KEIKO-0319)", () => {
  it("accepts labels: [] on update-issue-fields as an explicit clear-all", async () => {
    const counter: FetchCounter = { count: 0, requests: [] };
    const guard = guardWith(counter);
    const authority = registerEnvelope("autonomous-delivery", BOTH_WRITE_SCOPES);
    const result = (await handleExecuteAtlassianConnectorAction(
      ctx(
        {
          action: { type: "update-issue-fields", issueKey: "PROJ-9", labels: [] },
          authority,
        },
        { authRef: JIRA_AUTH_REF },
      ),
      deps(guard, "autonomous-delivery"),
    )) as { status: number; body: Record<string, unknown> };
    expect(result.status).toBe(200);
    expect(result.body.disposition).toBe("allowed");
  });

  it("accepts descriptionText: '' on update-issue-fields as an explicit clear", async () => {
    const counter: FetchCounter = { count: 0, requests: [] };
    const guard = guardWith(counter);
    const authority = registerEnvelope("autonomous-delivery", BOTH_WRITE_SCOPES);
    const result = (await handleExecuteAtlassianConnectorAction(
      ctx(
        {
          action: { type: "update-issue-fields", issueKey: "PROJ-9", descriptionText: "" },
          authority,
        },
        { authRef: JIRA_AUTH_REF },
      ),
      deps(guard, "autonomous-delivery"),
    )) as { status: number; body: Record<string, unknown> };
    expect(result.status).toBe(200);
    expect(result.body.disposition).toBe("allowed");
  });

  it("accepts bodyText: '' on update-page as an explicit clear", async () => {
    const counter: FetchCounter = { count: 0, requests: [] };
    const guard = guardWith(counter);
    const authority = registerEnvelope("autonomous-delivery", BOTH_WRITE_SCOPES);
    const result = (await handleExecuteAtlassianConnectorAction(
      ctx(
        {
          action: {
            type: "update-page",
            pageId: "123",
            title: "Runbook",
            bodyText: "",
            currentVersion: 4,
          },
          authority,
        },
        { authRef: CONFLUENCE_AUTH_REF },
      ),
      deps(guard, "autonomous-delivery"),
    )) as { status: number; body: Record<string, unknown> };
    expect(result.status).toBe(200);
    expect(result.body.disposition).toBe("allowed");
  });

  it("still rejects commentText: '' on add-issue-comment (empty comment is not meaningful)", async () => {
    const guard = guardWith({ count: 0, requests: [] });
    const authority = registerEnvelope("autonomous-delivery", BOTH_WRITE_SCOPES);
    const result = (await handleExecuteAtlassianConnectorAction(
      ctx(
        {
          action: { type: "add-issue-comment", issueKey: "PROJ-9", commentText: "" },
          authority,
        },
        { authRef: JIRA_AUTH_REF },
      ),
      deps(guard, "autonomous-delivery"),
    )) as { status: number };
    expect(result.status).toBe(400);
  });

  it("still rejects commentText: '' on add-page-comment (empty comment is not meaningful)", async () => {
    const guard = guardWith({ count: 0, requests: [] });
    const authority = registerEnvelope("autonomous-delivery", BOTH_WRITE_SCOPES);
    const result = (await handleExecuteAtlassianConnectorAction(
      ctx(
        {
          action: { type: "add-page-comment", pageId: "123", commentText: "" },
          authority,
        },
        { authRef: CONFLUENCE_AUTH_REF },
      ),
      deps(guard, "autonomous-delivery"),
    )) as { status: number };
    expect(result.status).toBe(400);
  });
});
