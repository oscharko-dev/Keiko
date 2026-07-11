// Issue #2246 Scope 6 — route-level policy regression across the WHOLE D4 table.
//
// The per-child suites verify the D4 matrix per family (writeActionRoutes.test.ts for the 7 writes,
// syncRoutes.policy.test.ts for the 2 syncs, writeActionRoutes.liveSearch.test.ts for live search).
// This suite consolidates all TEN governed action types into ONE uniform grid asserted at the
// route level against a LITERAL copy of the ADR-0128 D4 dispositions (never re-derived through the
// contract helper), driving both route entry points (sync-start and the action route), and then
// re-verifies the mode-independent authority failures (expiry / digest mismatch / budget
// exhaustion) hold on a representative of each family through its own route.
//
// Hermetic: in-memory custody + a credential-blind fixture transport, one temp store, registries
// reset each test. Sync-allowed cells start a real background job that this suite awaits to keep
// the registry clean.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  AtlassianCredentialCustody,
  AtlassianCredentialMetadata,
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
} from "@oscharko-dev/keiko-connectors";
import {
  createInMemoryConfluenceFixture,
  createInMemoryJiraFixture,
} from "@oscharko-dev/keiko-connectors";
import {
  ATLASSIAN_CONNECTOR_ACTION_TYPES,
  type AtlassianConnectorActionType,
  type CodingWorkbenchConnectorScope,
  type CodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts";
import type { RouteContext } from "../../packages/keiko-server/src/routes.js";
import type { UiHandlerDeps } from "../../packages/keiko-server/src/deps.js";
import type { AtlassianConnectorCredentialDeps } from "../../packages/keiko-server/src/atlassian/credentialRoutes.js";
import { handleStartAtlassianConnectorSync } from "../../packages/keiko-server/src/atlassian/syncRoutes.js";
import { handleExecuteAtlassianConnectorAction } from "../../packages/keiko-server/src/atlassian/writeActionRoutes.js";
import {
  CONNECTOR_BASE_URL,
  awaitJobTerminal,
  createConnectorServerHarness,
  registerConnectorEnvelope,
  resetConnectorRegistries,
  routeCtx,
  type ConnectorAuthorityContext,
  type ConnectorServerHarness,
} from "./harness.js";

const JIRA_AUTH_REF = `atlassian-cred:${"A".repeat(22)}`;
const CONFLUENCE_AUTH_REF = `atlassian-cred:${"B".repeat(22)}`;
const ALL_SCOPES: readonly CodingWorkbenchConnectorScope[] = [
  "knowledge-base.read",
  "knowledge-base.write",
  "issue-tracker.read",
  "issue-tracker.write",
];
const MODES: readonly CodingWorkbenchMode[] = [
  "governed-assist",
  "supervised-coding",
  "autonomous-delivery",
];

// ─── ADR-0128 D4 dispositions (scope present), copied verbatim ─────────────────
const D4: Readonly<
  Record<
    CodingWorkbenchMode,
    Readonly<Record<AtlassianConnectorActionType, "allowed" | "review-required">>
  >
> = {
  "governed-assist": {
    "sync-space": "review-required",
    "sync-project": "review-required",
    "search-issues-live": "review-required",
    "create-issue": "review-required",
    "update-issue-fields": "review-required",
    "transition-issue": "review-required",
    "add-issue-comment": "review-required",
    "create-page": "review-required",
    "update-page": "review-required",
    "add-page-comment": "review-required",
  },
  "supervised-coding": {
    "sync-space": "allowed",
    "sync-project": "allowed",
    "search-issues-live": "allowed",
    "create-issue": "review-required",
    "update-issue-fields": "allowed",
    "transition-issue": "review-required",
    "add-issue-comment": "allowed",
    "create-page": "review-required",
    "update-page": "allowed",
    "add-page-comment": "allowed",
  },
  "autonomous-delivery": {
    "sync-space": "allowed",
    "sync-project": "allowed",
    "search-issues-live": "allowed",
    "create-issue": "allowed",
    "update-issue-fields": "allowed",
    "transition-issue": "allowed",
    "add-issue-comment": "allowed",
    "create-page": "allowed",
    "update-page": "allowed",
    "add-page-comment": "allowed",
  },
};

// Literal deny reason per action (reads → connector-access-denied, writes → connector-write-denied).
const MISSING_SCOPE_REASON: Readonly<Record<AtlassianConnectorActionType, string>> = {
  "sync-space": "connector-access-denied",
  "sync-project": "connector-access-denied",
  "search-issues-live": "connector-access-denied",
  "create-issue": "connector-write-denied",
  "update-issue-fields": "connector-write-denied",
  "transition-issue": "connector-write-denied",
  "add-issue-comment": "connector-write-denied",
  "create-page": "connector-write-denied",
  "update-page": "connector-write-denied",
  "add-page-comment": "connector-write-denied",
};

// ─── Fixture transport (sync reads + writes + live search) ─────────────────────
function response(status: number, bodyText: string): AtlassianHttpBodyResult {
  return {
    kind: "response",
    status,
    bodyText,
    bodyBytes: new TextEncoder().encode(bodyText).length,
    truncated: false,
  };
}

function writeResponse(request: AtlassianHttpBodyRequest): AtlassianHttpBodyResult {
  const { url, method } = request;
  if (url.endsWith("/transitions") && method === "GET") {
    return response(200, '{"transitions":[{"id":"31"}]}');
  }
  if (method === "PUT") return response(204, "");
  if (url.endsWith("/rest/api/3/issue")) return response(201, '{"id":"10001","key":"PROJ-9"}');
  if (url.includes("/comment") || url.endsWith("/footer-comments"))
    return response(201, '{"id":"20001"}');
  if (url.endsWith("/wiki/api/v2/pages"))
    return response(200, '{"id":"123","version":{"number":1}}');
  return response(204, "");
}

function combinedPort(): AtlassianHttpBodyPort {
  const confluence = createInMemoryConfluenceFixture({
    baseUrl: CONNECTOR_BASE_URL,
    spaces: [
      { key: "ENG", id: "100", pages: [{ pageId: "1", title: "Guide", storageBody: "<p>ok</p>" }] },
    ],
  });
  const jira = createInMemoryJiraFixture({
    baseUrl: CONNECTOR_BASE_URL,
    projects: [
      {
        key: "PROJ",
        issues: [
          {
            issueId: "10001",
            key: "PROJ-1",
            summary: "Tracked",
            updated: "2026-05-01T10:22:33.000+0000",
          },
        ],
      },
    ],
  });
  return (request) => {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname.endsWith("/transitions")) {
      return Promise.resolve(writeResponse(request));
    }
    return url.pathname.includes("/wiki/") ? confluence(request) : jira(request);
  };
}

function credentialMeta(provider: "jira" | "confluence"): AtlassianCredentialMetadata {
  return {
    schemaVersion: "1",
    authRef: provider === "jira" ? JIRA_AUTH_REF : CONFLUENCE_AUTH_REF,
    provider,
    displayName: provider === "jira" ? "Jira" : "Confluence",
    baseUrl: CONNECTOR_BASE_URL,
    authScheme: "basic-api-token",
    createdAt: 1,
  };
}

function guard(): AtlassianConnectorCredentialDeps {
  const jira = credentialMeta("jira");
  const confluence = credentialMeta("confluence");
  const custody = {
    create: (): never => {
      throw new Error("create is not exercised");
    },
    getMetadata: (authRef: string): AtlassianCredentialMetadata | undefined =>
      authRef === JIRA_AUTH_REF ? jira : authRef === CONFLUENCE_AUTH_REF ? confluence : undefined,
    list: (): readonly AtlassianCredentialMetadata[] => [jira, confluence],
    delete: (): boolean => false,
  } satisfies AtlassianCredentialCustody;
  const port = combinedPort();
  return {
    custody,
    httpPortFactory: () => () => Promise.resolve({ kind: "network-error" as const }),
    httpBodyPortFactory: () => port,
  };
}

// ─── Route dispatch → normalized disposition ───────────────────────────────────
const WRITE_ACTION_BODIES: Readonly<Record<string, Record<string, unknown>>> = {
  "create-issue": { type: "create-issue", projectKey: "PROJ", issueTypeId: "10004", summary: "S" },
  "update-issue-fields": { type: "update-issue-fields", issueKey: "PROJ-9", summary: "Sharper" },
  "transition-issue": { type: "transition-issue", issueKey: "PROJ-9", transitionId: "31" },
  "add-issue-comment": { type: "add-issue-comment", issueKey: "PROJ-9", commentText: "Verified" },
  "create-page": { type: "create-page", spaceId: "777", title: "Runbook", bodyText: "Steps" },
  "update-page": {
    type: "update-page",
    pageId: "123",
    title: "Runbook",
    bodyText: "New",
    currentVersion: 4,
  },
  "add-page-comment": { type: "add-page-comment", pageId: "123", commentText: "Looks right" },
  "search-issues-live": { type: "search-issues-live", jql: "project = PROJ ORDER BY updated DESC" },
};

function actionAuthRef(actionType: AtlassianConnectorActionType): string {
  return actionType === "create-page" ||
    actionType === "update-page" ||
    actionType === "add-page-comment"
    ? CONFLUENCE_AUTH_REF
    : JIRA_AUTH_REF;
}

interface Admission {
  readonly disposition: "allowed" | "review-required" | "denied";
  readonly reasonCode?: string | undefined;
}

function withMode(deps: UiHandlerDeps, mode: CodingWorkbenchMode): UiHandlerDeps {
  return { ...deps, autonomousDeliveryDeploymentCeiling: mode };
}

async function admitSync(
  actionType: "sync-space" | "sync-project",
  authority:
    ConnectorAuthorityContext | { runId: string; envelopeDigest: string; workspaceRoot: string },
  deps: UiHandlerDeps,
): Promise<Admission> {
  const authRef = actionType === "sync-space" ? CONFLUENCE_AUTH_REF : JIRA_AUTH_REF;
  const scope = actionType === "sync-space" ? { spaceKeys: ["ENG"] } : { projectKeys: ["PROJ"] };
  const result = await handleStartAtlassianConnectorSync(
    routeCtx({ authRef }, { ...scope, authority }) as unknown as RouteContext,
    deps,
  );
  const body = result.body as {
    disposition?: string;
    reasonCode?: string;
    job?: { jobId: string };
  };
  if (body.job !== undefined) {
    await awaitJobTerminal(body.job.jobId);
    return { disposition: "allowed" };
  }
  if (body.disposition === "review-required") return { disposition: "review-required" };
  return { disposition: "denied", reasonCode: body.reasonCode };
}

async function admitAction(
  actionType: AtlassianConnectorActionType,
  authority: { runId: string; envelopeDigest: string; workspaceRoot: string },
  deps: UiHandlerDeps,
): Promise<Admission> {
  const result = await handleExecuteAtlassianConnectorAction(
    routeCtx(
      { authRef: actionAuthRef(actionType) },
      { action: WRITE_ACTION_BODIES[actionType], authority },
    ) as unknown as RouteContext,
    deps,
  );
  const body = result.body as { disposition?: string; reasonCode?: string };
  if (body.disposition === "allowed") return { disposition: "allowed" };
  if (body.disposition === "review-required") return { disposition: "review-required" };
  return { disposition: "denied", reasonCode: body.reasonCode };
}

function admit(
  actionType: AtlassianConnectorActionType,
  authority: { runId: string; envelopeDigest: string; workspaceRoot: string },
  deps: UiHandlerDeps,
): Promise<Admission> {
  if (actionType === "sync-space" || actionType === "sync-project") {
    return admitSync(actionType, authority, deps);
  }
  return admitAction(actionType, authority, deps);
}

// ─── Harness ───────────────────────────────────────────────────────────────────
let harness: ConnectorServerHarness;

beforeAll(() => {
  harness = createConnectorServerHarness(guard(), { tmpPrefix: "keiko-atl-policy-2246-" });
});

afterAll(() => {
  harness.cleanup();
});

beforeEach(() => {
  resetConnectorRegistries();
});

interface Cell {
  readonly mode: CodingWorkbenchMode;
  readonly actionType: AtlassianConnectorActionType;
  readonly expected: "allowed" | "review-required";
}

const PRESENT_MATRIX: readonly Cell[] = MODES.flatMap((mode) =>
  ATLASSIAN_CONNECTOR_ACTION_TYPES.map((actionType) => ({
    mode,
    actionType,
    expected: D4[mode][actionType],
  })),
);

describe("route-level policy regression — D4 matrix, scope present (Scope 6)", () => {
  it.each(PRESENT_MATRIX)(
    "$mode / $actionType → $expected",
    async ({ mode, actionType, expected }) => {
      const authority = registerConnectorEnvelope(mode, ALL_SCOPES);
      const admission = await admit(actionType, authority, withMode(harness.deps, mode));
      expect(admission.disposition).toBe(expected);
    },
  );

  it("covers all ten action types in every mode", () => {
    expect(PRESENT_MATRIX).toHaveLength(MODES.length * ATLASSIAN_CONNECTOR_ACTION_TYPES.length);
    expect(ATLASSIAN_CONNECTOR_ACTION_TYPES).toHaveLength(10);
  });
});

describe("route-level policy regression — missing scope denies in every mode (Scope 6)", () => {
  it.each(
    MODES.flatMap((mode) =>
      ATLASSIAN_CONNECTOR_ACTION_TYPES.map((actionType) => ({ mode, actionType })),
    ),
  )("$mode / $actionType with NO scopes → denied", async ({ mode, actionType }) => {
    const authority = registerConnectorEnvelope(mode, []);
    const admission = await admit(actionType, authority, withMode(harness.deps, mode));
    expect(admission.disposition).toBe("denied");
    expect(admission.reasonCode).toBe(MISSING_SCOPE_REASON[actionType]);
  });
});

// ─── Envelope authority failures (mode-independent) per route family ───────────
interface AuthorityFailureCase {
  readonly label: string;
  readonly authorityFor: (base: ConnectorAuthorityContext) => ConnectorAuthorityContext;
  readonly registerOver?: Parameters<typeof registerConnectorEnvelope>[2];
  readonly registeredAtIso?: string;
  readonly expectedReason: string;
}

const REPRESENTATIVES: readonly AtlassianConnectorActionType[] = [
  "sync-space",
  "search-issues-live",
  "create-issue",
];

const AUTHORITY_FAILURES: readonly AuthorityFailureCase[] = [
  {
    label: "digest mismatch → authority-invalid",
    authorityFor: (base) => ({ ...base, envelopeDigest: "f".repeat(64) }),
    expectedReason: "authority-invalid",
  },
  {
    label: "expired envelope → authority-expired",
    authorityFor: (base) => base,
    registerOver: { expiresAt: "2020-01-02T00:00:00.000Z" },
    registeredAtIso: "2020-01-01T00:00:00.000Z",
    expectedReason: "authority-expired",
  },
  {
    label: "runtime budget exhausted → authority-budget-exceeded",
    authorityFor: (base) => base,
    registerOver: {
      budget: {
        maxRuntimeMs: 60_000,
        maxToolCalls: 50,
        maxPromptTokens: 10_000,
        maxPatchBytes: 65_536,
      },
    },
    registeredAtIso: "2020-01-01T00:00:00.000Z",
    expectedReason: "authority-budget-exceeded",
  },
];

describe("route-level policy regression — envelope authority failures (Scope 6)", () => {
  for (const actionType of REPRESENTATIVES) {
    it.each(AUTHORITY_FAILURES)(
      `${actionType}: $label`,
      async ({ authorityFor, registerOver, registeredAtIso, expectedReason }) => {
        const base = registerConnectorEnvelope(
          "autonomous-delivery",
          ALL_SCOPES,
          registerOver ?? {},
          registeredAtIso ?? new Date().toISOString(),
        );
        const admission = await admit(
          actionType,
          authorityFor(base),
          withMode(harness.deps, "autonomous-delivery"),
        );
        expect(admission.disposition).toBe("denied");
        expect(admission.reasonCode).toBe(expectedReason);
      },
    );
  }
});
