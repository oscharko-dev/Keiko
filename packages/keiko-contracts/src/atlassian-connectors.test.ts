import { describe, expect, it } from "vitest";
import {
  ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK,
  ATLASSIAN_CONNECTOR_ACTION_CLASS,
  ATLASSIAN_CONNECTOR_ACTION_PROVIDER,
  ATLASSIAN_CONNECTOR_ACTION_REQUIRED_SCOPE,
  ATLASSIAN_CONNECTOR_ACTION_TYPES,
  ATLASSIAN_CONNECTOR_AUTH_SCHEMES,
  ATLASSIAN_CONNECTOR_PROVIDERS,
  ATLASSIAN_CONNECTOR_SCOPE_DENY_REASON,
  ATLASSIAN_CONNECTOR_SUPERVISED_ACTION_KIND,
  ATLASSIAN_CONNECTOR_WORKBENCH_ACTION_CLASS,
  ATLASSIAN_CONNECTOR_WORKBENCH_RESOURCE_SCOPE,
  ATLASSIAN_CONFLUENCE_SPACE_KEY_MAX_CHARS,
  ATLASSIAN_CONNECTOR_BASE_URL_MAX_CHARS,
  ATLASSIAN_CONNECTOR_DISPLAY_NAME_MAX_CHARS,
  ATLASSIAN_CONNECTOR_IDENTIFIER_MAX_CHARS,
  ATLASSIAN_JIRA_PROJECT_KEY_MAX_CHARS,
  ATLASSIAN_JQL_MAX_CHARS,
  ATLASSIAN_LIVE_ISSUE_SUMMARY_MAX_CHARS,
  ATLASSIAN_LIVE_SEARCH_MAX_RESULTS,
  ATLASSIAN_LIVE_SEARCH_TEMPLATE_IDS,
  ATLASSIAN_SYNC_FAILURE_REASONS,
  ATLASSIAN_SYNC_JOB_STATUSES,
  ATLASSIAN_SYNC_SCOPE_MAX_KEYS,
  DEFAULT_ATLASSIAN_SYNC_BOUNDS,
  decideAtlassianConnectorAction,
  isAtlassianConnectorActionType,
  isAtlassianConnectorAuthRef,
  isAtlassianConnectorAuthScheme,
  isAtlassianConnectorProvider,
  isAtlassianLiveSearchTemplateId,
  isAtlassianSyncFailureReason,
  isAtlassianSyncJobStatus,
  isAtlassianSyncTerminalStatus,
  isJiraIssueCitationMetadata,
  isSafeAtlassianConnectorBaseUrl,
  isSafeAtlassianDisplayName,
  isSafeAtlassianIdentifier,
  isSafeConfluenceSpaceKey,
  isSafeJiraBrowseUrl,
  isSafeJiraCitationFieldText,
  isSafeJiraLiveIssueSummary,
  isSafeJiraProjectKey,
  ATLASSIAN_CONNECTOR_AUTHORITY_FAILURE_REASONS,
  ATLASSIAN_CONNECTOR_HUMAN_INITIATION_REASON,
  ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS,
  isAtlassianConnectorActionReviewReason,
  isAtlassianConnectorAuthorityFailureReason,
  isAtlassianConnectorWriteFailureReason,
  type AtlassianConnectorActionClass,
  type AtlassianConnectorActionType,
  type AtlassianConnectorActionDisposition,
  type AtlassianConnectorActivityReasonCode,
  type AtlassianConnectorProvider,
} from "./atlassian-connectors.js";
import {
  CODING_WORKBENCH_CONNECTOR_SCOPES,
  CODING_WORKBENCH_MODES,
  CODING_WORKBENCH_POLICY_DENIAL_REASONS,
  type CodingWorkbenchApprovalRisk,
  type CodingWorkbenchConnectorScope,
  type CodingWorkbenchMode,
} from "./coding-workbench.js";
import { EDITOR_AGENT_ACTION_DENY_REASONS } from "./editor-agent-governance.js";

// The ADR-0128 D4 mapping table, verbatim. Every assertion in this file that touches an action
// row derives from this single fixture, so a drift between contract tables and the accepted
// record fails loudly here.
interface D4Row {
  readonly action: AtlassianConnectorActionType;
  readonly provider: AtlassianConnectorProvider;
  readonly actionClass: AtlassianConnectorActionClass;
  readonly scope: CodingWorkbenchConnectorScope;
  readonly risk: CodingWorkbenchApprovalRisk;
  readonly dispositions: Readonly<Record<CodingWorkbenchMode, AtlassianConnectorActionDisposition>>;
}

const D4_TABLE: readonly D4Row[] = [
  {
    action: "sync-space",
    provider: "confluence",
    actionClass: "connector-access",
    scope: "knowledge-base.read",
    risk: "low",
    dispositions: {
      "governed-assist": "review-required",
      "supervised-coding": "allowed",
      "autonomous-delivery": "allowed",
    },
  },
  {
    action: "sync-project",
    provider: "jira",
    actionClass: "connector-access",
    scope: "issue-tracker.read",
    risk: "low",
    dispositions: {
      "governed-assist": "review-required",
      "supervised-coding": "allowed",
      "autonomous-delivery": "allowed",
    },
  },
  {
    action: "search-issues-live",
    provider: "jira",
    actionClass: "connector-access",
    scope: "issue-tracker.read",
    risk: "low",
    dispositions: {
      "governed-assist": "review-required",
      "supervised-coding": "allowed",
      "autonomous-delivery": "allowed",
    },
  },
  {
    action: "create-issue",
    provider: "jira",
    actionClass: "connector-write",
    scope: "issue-tracker.write",
    risk: "high",
    dispositions: {
      "governed-assist": "review-required",
      "supervised-coding": "review-required",
      "autonomous-delivery": "allowed",
    },
  },
  {
    action: "update-issue-fields",
    provider: "jira",
    actionClass: "connector-write",
    scope: "issue-tracker.write",
    risk: "medium",
    dispositions: {
      "governed-assist": "review-required",
      "supervised-coding": "allowed",
      "autonomous-delivery": "allowed",
    },
  },
  {
    action: "transition-issue",
    provider: "jira",
    actionClass: "connector-write",
    scope: "issue-tracker.write",
    risk: "high",
    dispositions: {
      "governed-assist": "review-required",
      "supervised-coding": "review-required",
      "autonomous-delivery": "allowed",
    },
  },
  {
    action: "add-issue-comment",
    provider: "jira",
    actionClass: "connector-write",
    scope: "issue-tracker.write",
    risk: "low",
    dispositions: {
      "governed-assist": "review-required",
      "supervised-coding": "allowed",
      "autonomous-delivery": "allowed",
    },
  },
  {
    action: "create-page",
    provider: "confluence",
    actionClass: "connector-write",
    scope: "knowledge-base.write",
    risk: "high",
    dispositions: {
      "governed-assist": "review-required",
      "supervised-coding": "review-required",
      "autonomous-delivery": "allowed",
    },
  },
  {
    action: "update-page",
    provider: "confluence",
    actionClass: "connector-write",
    scope: "knowledge-base.write",
    risk: "medium",
    dispositions: {
      "governed-assist": "review-required",
      "supervised-coding": "allowed",
      "autonomous-delivery": "allowed",
    },
  },
  {
    action: "add-page-comment",
    provider: "confluence",
    actionClass: "connector-write",
    scope: "knowledge-base.write",
    risk: "low",
    dispositions: {
      "governed-assist": "review-required",
      "supervised-coding": "allowed",
      "autonomous-delivery": "allowed",
    },
  },
];

const ALL_SCOPES: readonly CodingWorkbenchConnectorScope[] = CODING_WORKBENCH_CONNECTOR_SCOPES;

function scopesWithout(
  scope: CodingWorkbenchConnectorScope,
): readonly CodingWorkbenchConnectorScope[] {
  return ALL_SCOPES.filter((candidate) => candidate !== scope);
}

describe("CodingWorkbenchConnectorScope extension (ADR-0128 D4)", () => {
  it("adds the knowledge-base scope pair alongside the existing pairs", () => {
    expect(CODING_WORKBENCH_CONNECTOR_SCOPES).toEqual([
      "source-control.read",
      "source-control.write",
      "issue-tracker.read",
      "issue-tracker.write",
      "knowledge-base.read",
      "knowledge-base.write",
    ]);
  });

  it("exports the complete central denial-reason vocabulary", () => {
    expect(CODING_WORKBENCH_POLICY_DENIAL_REASONS).toEqual([
      "workspace-read-denied",
      "workspace-write-denied",
      "command-execution-denied",
      "verification-denied",
      "connector-access-denied",
      "connector-write-denied",
      "network-denied",
      "delivery-denied",
    ]);
  });
});

describe("D4 effect-class mapping table (ADR-0128)", () => {
  it("covers exactly the ten D4 action rows", () => {
    expect(ATLASSIAN_CONNECTOR_ACTION_TYPES).toEqual(D4_TABLE.map((row) => row.action));
  });

  it("reproduces the D4 action-class column verbatim", () => {
    for (const row of D4_TABLE) {
      expect(ATLASSIAN_CONNECTOR_ACTION_CLASS[row.action]).toBe(row.actionClass);
    }
  });

  it("reproduces the D4 provider column verbatim", () => {
    for (const row of D4_TABLE) {
      expect(ATLASSIAN_CONNECTOR_ACTION_PROVIDER[row.action]).toBe(row.provider);
    }
  });

  it("reproduces the D4 connector-scope column verbatim", () => {
    for (const row of D4_TABLE) {
      expect(ATLASSIAN_CONNECTOR_ACTION_REQUIRED_SCOPE[row.action]).toBe(row.scope);
    }
  });

  it("reproduces the D4 approval-risk column verbatim", () => {
    for (const row of D4_TABLE) {
      expect(ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK[row.action]).toBe(row.risk);
    }
  });

  it("maps both connector classes onto the shared Workbench vocabulary without new members", () => {
    expect(ATLASSIAN_CONNECTOR_WORKBENCH_ACTION_CLASS).toEqual({
      "connector-access": "connector-access",
      "connector-write": "connector-access",
    });
    expect(ATLASSIAN_CONNECTOR_SUPERVISED_ACTION_KIND).toEqual({
      "connector-access": null,
      "connector-write": "connector-write",
    });
    expect(ATLASSIAN_CONNECTOR_WORKBENCH_RESOURCE_SCOPE).toEqual({
      "connector-access": "internet",
      "connector-write": "internet",
    });
    expect(ATLASSIAN_CONNECTOR_SCOPE_DENY_REASON).toEqual({
      "connector-access": "connector-access-denied",
      "connector-write": "connector-write-denied",
    });
  });
});

describe("decideAtlassianConnectorAction — full D4 matrix (action × mode × scope)", () => {
  it("reproduces every D4 disposition cell when the required scope is present", () => {
    for (const row of D4_TABLE) {
      for (const mode of CODING_WORKBENCH_MODES) {
        const decision = decideAtlassianConnectorAction(row.action, mode, ALL_SCOPES);
        expect(decision.disposition, `${row.action} × ${mode}`).toBe(row.dispositions[mode]);
        expect(decision.actionType).toBe(row.action);
        expect(decision.actionClass).toBe(row.actionClass);
        expect(decision.requiredScope).toBe(row.scope);
        expect(decision.risk).toBe(row.risk);
      }
    }
  });

  it("denies every action with the class-specific reason when its scope is absent, in every mode", () => {
    for (const row of D4_TABLE) {
      for (const mode of CODING_WORKBENCH_MODES) {
        for (const scopes of [scopesWithout(row.scope), [] as const]) {
          const decision = decideAtlassianConnectorAction(row.action, mode, scopes);
          expect(decision.disposition, `${row.action} × ${mode}`).toBe("denied");
          expect(decision.denyReason).toBe(ATLASSIAN_CONNECTOR_SCOPE_DENY_REASON[row.actionClass]);
          expect(decision.reviewReason).toBeUndefined();
        }
      }
    }
  });

  it("denies every write action with connector-write-denied when the write scope is absent, including Full access", () => {
    const writeRows = D4_TABLE.filter((row) => row.actionClass === "connector-write");
    expect(writeRows).toHaveLength(7);
    for (const row of writeRows) {
      for (const mode of CODING_WORKBENCH_MODES) {
        const decision = decideAtlassianConnectorAction(row.action, mode, scopesWithout(row.scope));
        expect(decision.disposition).toBe("denied");
        expect(decision.denyReason).toBe("connector-write-denied");
      }
    }
  });

  it("yields review-required (never allowed) for every write action in Ask for approval", () => {
    for (const row of D4_TABLE.filter((entry) => entry.actionClass === "connector-write")) {
      const decision = decideAtlassianConnectorAction(row.action, "governed-assist", ALL_SCOPES);
      expect(decision.disposition).toBe("review-required");
    }
  });

  it("carries exactly one content-free reason for every matrix cell", () => {
    for (const row of D4_TABLE) {
      for (const mode of CODING_WORKBENCH_MODES) {
        for (const scopes of [ALL_SCOPES, scopesWithout(row.scope)]) {
          const decision = decideAtlassianConnectorAction(row.action, mode, scopes);
          if (decision.disposition === "allowed") {
            expect(decision.denyReason).toBeUndefined();
            expect(decision.reviewReason).toBeUndefined();
          } else if (decision.disposition === "review-required") {
            expect(decision.denyReason).toBeUndefined();
            expect(decision.reviewReason).toBeDefined();
          } else {
            expect(decision.denyReason).toBeDefined();
            expect(decision.reviewReason).toBeUndefined();
          }
        }
      }
    }
  });

  it("is deterministic: equal inputs produce an equal decision", () => {
    const first = decideAtlassianConnectorAction("create-issue", "supervised-coding", ALL_SCOPES);
    const second = decideAtlassianConnectorAction("create-issue", "supervised-coding", ALL_SCOPES);
    expect(first).toEqual(second);
  });

  it("distinguishes the deterministic-risk review reason from the blanket mode reason", () => {
    const highRisk = decideAtlassianConnectorAction(
      "create-issue",
      "supervised-coding",
      ALL_SCOPES,
    );
    expect(highRisk.reviewReason).toBe("deterministic-risk-approval-required");
    const blanket = decideAtlassianConnectorAction("sync-project", "governed-assist", ALL_SCOPES);
    expect(blanket.reviewReason).toBe("mode-approval-required");
  });

  it("denies when the Authority Envelope grant omits the connector-access action class", () => {
    for (const mode of CODING_WORKBENCH_MODES) {
      const decision = decideAtlassianConnectorAction("create-issue", mode, ALL_SCOPES, [
        "workspace-read",
        "workspace-write",
      ]);
      expect(decision.disposition).toBe("denied");
      expect(decision.denyReason).toBe("connector-access-denied");
    }
  });

  it("admits normally when the Authority Envelope grant includes connector-access", () => {
    const decision = decideAtlassianConnectorAction(
      "add-issue-comment",
      "autonomous-delivery",
      ALL_SCOPES,
      ["connector-access"],
    );
    expect(decision.disposition).toBe("allowed");
  });
});

describe("D5 sync bound defaults (ADR-0128)", () => {
  it("declares the exact D5 defaults", () => {
    expect(DEFAULT_ATLASSIAN_SYNC_BOUNDS).toEqual({
      maxItems: 2_000,
      maxBytes: 50_000_000,
      maxDurationMs: 900_000,
      maxConcurrency: 4,
    });
    expect(ATLASSIAN_LIVE_SEARCH_MAX_RESULTS).toBe(100);
  });

  it("declares the bounded-input ceilings downstream children compose against", () => {
    expect(ATLASSIAN_SYNC_SCOPE_MAX_KEYS).toBe(50);
    expect(ATLASSIAN_JQL_MAX_CHARS).toBe(2_048);
    expect(ATLASSIAN_CONNECTOR_BASE_URL_MAX_CHARS).toBe(2_048);
    expect(ATLASSIAN_CONNECTOR_DISPLAY_NAME_MAX_CHARS).toBe(100);
    expect(ATLASSIAN_CONNECTOR_IDENTIFIER_MAX_CHARS).toBe(128);
    expect(ATLASSIAN_CONFLUENCE_SPACE_KEY_MAX_CHARS).toBe(255);
    expect(ATLASSIAN_JIRA_PROJECT_KEY_MAX_CHARS).toBe(32);
  });

  it("freezes the defaults and the closed vocabularies", () => {
    expect(Object.isFrozen(DEFAULT_ATLASSIAN_SYNC_BOUNDS)).toBe(true);
    expect(Object.isFrozen(ATLASSIAN_SYNC_JOB_STATUSES)).toBe(true);
    expect(Object.isFrozen(ATLASSIAN_SYNC_FAILURE_REASONS)).toBe(true);
    expect(Object.isFrozen(ATLASSIAN_CONNECTOR_ACTION_CLASS)).toBe(true);
  });
});

describe("closed enums and guards", () => {
  it("keeps the provider, auth-scheme, status, and failure-reason unions closed", () => {
    expect(ATLASSIAN_CONNECTOR_PROVIDERS).toEqual(["confluence", "jira"]);
    expect(ATLASSIAN_CONNECTOR_AUTH_SCHEMES).toEqual(["basic-api-token", "bearer-pat"]);
    expect(ATLASSIAN_SYNC_JOB_STATUSES).toEqual([
      "pending",
      "running",
      "partial",
      "succeeded",
      "failed",
      "cancelled",
    ]);
    expect(ATLASSIAN_SYNC_FAILURE_REASONS).toEqual([
      "auth-failed",
      "permission-denied",
      "rate-limited",
      "timeout",
      "unavailable",
      "scope-exceeded",
      "bounds-exceeded",
      "cancelled",
      "malformed-payload",
    ]);
  });

  it("rejects unknown enum values through every guard", () => {
    expect(isAtlassianConnectorProvider("bitbucket")).toBe(false);
    expect(isAtlassianConnectorProvider(1)).toBe(false);
    expect(isAtlassianConnectorAuthScheme("oauth-3lo")).toBe(false);
    expect(isAtlassianConnectorActionType("delete-issue")).toBe(false);
    expect(isAtlassianSyncJobStatus("paused")).toBe(false);
    expect(isAtlassianSyncTerminalStatus("running")).toBe(false);
    expect(isAtlassianSyncFailureReason("unknown-error")).toBe(false);
  });

  it("accepts every declared enum member through its guard", () => {
    for (const provider of ATLASSIAN_CONNECTOR_PROVIDERS) {
      expect(isAtlassianConnectorProvider(provider)).toBe(true);
    }
    for (const scheme of ATLASSIAN_CONNECTOR_AUTH_SCHEMES) {
      expect(isAtlassianConnectorAuthScheme(scheme)).toBe(true);
    }
    for (const action of ATLASSIAN_CONNECTOR_ACTION_TYPES) {
      expect(isAtlassianConnectorActionType(action)).toBe(true);
    }
    for (const status of ATLASSIAN_SYNC_JOB_STATUSES) {
      expect(isAtlassianSyncJobStatus(status)).toBe(true);
    }
    for (const reason of ATLASSIAN_SYNC_FAILURE_REASONS) {
      expect(isAtlassianSyncFailureReason(reason)).toBe(true);
    }
  });
});

describe("isAtlassianConnectorAuthRef (ADR-0128 D2)", () => {
  it("accepts the atlassian-cred:<22 base64url chars> shape", () => {
    expect(isAtlassianConnectorAuthRef("atlassian-cred:AbCdEfGhIjKlMnOpQrStUv")).toBe(true);
    expect(isAtlassianConnectorAuthRef("atlassian-cred:0123456789_-abcdefghij")).toBe(true);
  });

  it("rejects wrong prefixes, lengths, alphabets, and non-strings", () => {
    expect(isAtlassianConnectorAuthRef("figma-cred:AbCdEfGhIjKlMnOpQrStUv")).toBe(false);
    expect(isAtlassianConnectorAuthRef("atlassian-cred:")).toBe(false);
    expect(isAtlassianConnectorAuthRef("atlassian-cred:short")).toBe(false);
    expect(isAtlassianConnectorAuthRef("atlassian-cred:AbCdEfGhIjKlMnOpQrStUvW")).toBe(false);
    expect(isAtlassianConnectorAuthRef("atlassian-cred:AbCdEfGhIjKlMnOpQrSt+=")).toBe(false);
    expect(isAtlassianConnectorAuthRef("ATLASSIAN-CRED:AbCdEfGhIjKlMnOpQrStUv")).toBe(false);
    expect(isAtlassianConnectorAuthRef(42)).toBe(false);
    expect(isAtlassianConnectorAuthRef(undefined)).toBe(false);
  });
});

describe("isSafeAtlassianConnectorBaseUrl (ADR-0128 D3)", () => {
  it("accepts canonical HTTPS base URLs with optional port and context path", () => {
    expect(isSafeAtlassianConnectorBaseUrl("https://example.atlassian.net")).toBe(true);
    expect(isSafeAtlassianConnectorBaseUrl("https://example.atlassian.net/wiki")).toBe(true);
    expect(isSafeAtlassianConnectorBaseUrl("https://jira.internal.example:8443/jira")).toBe(true);
  });

  it("rejects http and other non-https schemes", () => {
    expect(isSafeAtlassianConnectorBaseUrl("http://example.atlassian.net")).toBe(false);
    expect(isSafeAtlassianConnectorBaseUrl("ftp://example.atlassian.net")).toBe(false);
    expect(isSafeAtlassianConnectorBaseUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects embedded credentials in every form", () => {
    expect(isSafeAtlassianConnectorBaseUrl("https://user:token@example.atlassian.net")).toBe(false);
    expect(isSafeAtlassianConnectorBaseUrl("https://user@example.atlassian.net")).toBe(false);
    expect(isSafeAtlassianConnectorBaseUrl("https://:token@example.atlassian.net")).toBe(false);
    expect(isSafeAtlassianConnectorBaseUrl("https://:@example.atlassian.net")).toBe(false);
  });

  it("rejects query strings and fragments, including empty markers", () => {
    expect(isSafeAtlassianConnectorBaseUrl("https://example.atlassian.net?token=x")).toBe(false);
    expect(isSafeAtlassianConnectorBaseUrl("https://example.atlassian.net?")).toBe(false);
    expect(isSafeAtlassianConnectorBaseUrl("https://example.atlassian.net#fragment")).toBe(false);
    expect(isSafeAtlassianConnectorBaseUrl("https://example.atlassian.net#")).toBe(false);
  });

  it("rejects malformed, empty, whitespace-bearing, and oversized inputs", () => {
    expect(isSafeAtlassianConnectorBaseUrl("not a url")).toBe(false);
    expect(isSafeAtlassianConnectorBaseUrl("")).toBe(false);
    expect(isSafeAtlassianConnectorBaseUrl("https://")).toBe(false);
    expect(isSafeAtlassianConnectorBaseUrl(" https://example.atlassian.net")).toBe(false);
    expect(isSafeAtlassianConnectorBaseUrl("https://example.atlassian.net/a path")).toBe(false);
    expect(isSafeAtlassianConnectorBaseUrl(`https://example.com/${"a".repeat(2048)}`)).toBe(false);
    expect(isSafeAtlassianConnectorBaseUrl(12)).toBe(false);
  });
});

describe("sync-scope key guards", () => {
  it("accepts standard and personal Confluence space keys", () => {
    expect(isSafeConfluenceSpaceKey("ENG")).toBe(true);
    expect(isSafeConfluenceSpaceKey("docs2024")).toBe(true);
    expect(isSafeConfluenceSpaceKey("~7120201")).toBe(true);
  });

  it("rejects malformed Confluence space keys", () => {
    expect(isSafeConfluenceSpaceKey("")).toBe(false);
    expect(isSafeConfluenceSpaceKey("~")).toBe(false);
    expect(isSafeConfluenceSpaceKey("has space")).toBe(false);
    expect(isSafeConfluenceSpaceKey("a/b")).toBe(false);
    expect(isSafeConfluenceSpaceKey("key!")).toBe(false);
    expect(isSafeConfluenceSpaceKey(`K${"e".repeat(255)}`)).toBe(false);
    expect(isSafeConfluenceSpaceKey(null)).toBe(false);
  });

  it("accepts uppercase Jira project keys and rejects malformed ones", () => {
    expect(isSafeJiraProjectKey("PROJ")).toBe(true);
    expect(isSafeJiraProjectKey("A1_B2")).toBe(true);
    expect(isSafeJiraProjectKey("proj")).toBe(false);
    expect(isSafeJiraProjectKey("1PROJ")).toBe(false);
    expect(isSafeJiraProjectKey("PROJ-1")).toBe(false);
    expect(isSafeJiraProjectKey(`P${"R".repeat(32)}`)).toBe(false);
    expect(isSafeJiraProjectKey("")).toBe(false);
    expect(isSafeJiraProjectKey(7)).toBe(false);
  });
});

describe("identifier and display-name guards", () => {
  it("accepts issue keys, page ids, and vault-style identifiers", () => {
    expect(isSafeAtlassianIdentifier("PROJ-123")).toBe(true);
    expect(isSafeAtlassianIdentifier("123456789")).toBe(true);
    expect(isSafeAtlassianIdentifier("conn_atlassian.prod-1")).toBe(true);
    expect(isSafeAtlassianIdentifier("~personal")).toBe(true);
  });

  it("rejects identifiers that could carry a URL, path, credential, or header", () => {
    expect(isSafeAtlassianIdentifier("https://example.com")).toBe(false);
    expect(isSafeAtlassianIdentifier("/etc/passwd")).toBe(false);
    expect(isSafeAtlassianIdentifier("a b")).toBe(false);
    expect(isSafeAtlassianIdentifier("user@host")).toBe(false);
    expect(isSafeAtlassianIdentifier("key:value")).toBe(false);
    expect(isSafeAtlassianIdentifier("")).toBe(false);
    expect(isSafeAtlassianIdentifier(`a${"b".repeat(128)}`)).toBe(false);
    expect(isSafeAtlassianIdentifier(undefined)).toBe(false);
  });

  it("accepts bounded human display names and rejects hostile ones", () => {
    expect(isSafeAtlassianDisplayName("Engineering Confluence")).toBe(true);
    expect(isSafeAtlassianDisplayName("Jira (Prod)")).toBe(true);
    expect(isSafeAtlassianDisplayName("")).toBe(false);
    expect(isSafeAtlassianDisplayName(" padded ")).toBe(false);
    expect(isSafeAtlassianDisplayName("ops@example.com")).toBe(false);
    expect(isSafeAtlassianDisplayName("https://example.com")).toBe(false);
    expect(isSafeAtlassianDisplayName("see /etc/passwd")).toBe(false);
    expect(isSafeAtlassianDisplayName("name?query")).toBe(false);
    expect(isSafeAtlassianDisplayName("name#fragment")).toBe(false);
    expect(isSafeAtlassianDisplayName("a".repeat(101))).toBe(false);
    expect(isSafeAtlassianDisplayName(null)).toBe(false);
  });
});

describe("Jira issue citation metadata (#2243; #2248 field-list parity)", () => {
  const FULL: unknown = {
    issueKey: "PLAT-2",
    status: "In Progress",
    issueType: "Bug",
    assignee: "Alice Example",
    reporter: "Bob Reporter",
    labels: ["auth", "backend"],
    priority: "High",
    resolution: "Unresolved",
    originalEstimate: "1w",
    remainingEstimate: "2d",
    parentKey: "PLAT-1",
    subtaskKeys: ["PLAT-3", "PLAT-4"],
    linkedIssues: [
      { linkType: "blocks", issueKey: "PLAT-9" },
      { linkType: "is blocked by", issueKey: "CORE-2" },
    ],
    created: "2026-04-01T09:00:00.000+0000",
    updated: "2026-05-01T10:22:33.000+0000",
  };

  it("accepts the full projection and the minimal issueKey-only projection", () => {
    expect(isJiraIssueCitationMetadata(FULL)).toBe(true);
    expect(isJiraIssueCitationMetadata({ issueKey: "PLAT-7" })).toBe(true);
  });

  it("rejects non-objects, missing/invalid issue keys, and unknown keys fail-closed", () => {
    expect(isJiraIssueCitationMetadata(undefined)).toBe(false);
    expect(isJiraIssueCitationMetadata(null)).toBe(false);
    expect(isJiraIssueCitationMetadata("PLAT-2")).toBe(false);
    expect(isJiraIssueCitationMetadata([])).toBe(false);
    expect(isJiraIssueCitationMetadata({})).toBe(false);
    expect(isJiraIssueCitationMetadata({ issueKey: "not a key!" })).toBe(false);
    expect(isJiraIssueCitationMetadata({ issueKey: "PLAT-2", body: "content" })).toBe(false);
  });

  it("rejects hostile scalar fields (URL markers, over-length, wrong types)", () => {
    expect(isJiraIssueCitationMetadata({ issueKey: "PLAT-2", status: "x".repeat(101) })).toBe(
      false,
    );
    expect(isJiraIssueCitationMetadata({ issueKey: "PLAT-2", assignee: "user@evil.example" })).toBe(
      false,
    );
    expect(
      isJiraIssueCitationMetadata({ issueKey: "PLAT-2", status: "see https://evil.example" }),
    ).toBe(false);
    expect(isJiraIssueCitationMetadata({ issueKey: "PLAT-2", priority: 5 })).toBe(false);
    expect(isJiraIssueCitationMetadata({ issueKey: "PLAT-2", parentKey: "in valid" })).toBe(false);
  });

  it("bounds list fields and validates every entry", () => {
    expect(isJiraIssueCitationMetadata({ issueKey: "PLAT-2", labels: ["ok", "also-ok"] })).toBe(
      true,
    );
    expect(
      isJiraIssueCitationMetadata({
        issueKey: "PLAT-2",
        labels: Array.from({ length: 51 }, () => "x"),
      }),
    ).toBe(false);
    expect(isJiraIssueCitationMetadata({ issueKey: "PLAT-2", labels: ["ok", 42] })).toBe(false);
    expect(isJiraIssueCitationMetadata({ issueKey: "PLAT-2", subtaskKeys: ["no spaces!"] })).toBe(
      false,
    );
    expect(isJiraIssueCitationMetadata({ issueKey: "PLAT-2", subtaskKeys: "PLAT-3" })).toBe(false);
  });

  it("validates linked-issue refs strictly: closed keys, safe link text, identifier keys", () => {
    const withLinks = (linkedIssues: unknown): unknown => ({ issueKey: "PLAT-2", linkedIssues });
    expect(
      isJiraIssueCitationMetadata(withLinks([{ linkType: "blocks", issueKey: "PLAT-9" }])),
    ).toBe(true);
    expect(isJiraIssueCitationMetadata(withLinks([{ linkType: "blocks" }]))).toBe(false);
    expect(isJiraIssueCitationMetadata(withLinks([{ issueKey: "PLAT-9" }]))).toBe(false);
    expect(
      isJiraIssueCitationMetadata(
        withLinks([{ linkType: "blocks", issueKey: "PLAT-9", extra: true }]),
      ),
    ).toBe(false);
    expect(
      isJiraIssueCitationMetadata(withLinks([{ linkType: "b://x", issueKey: "PLAT-9" }])),
    ).toBe(false);
    expect(isJiraIssueCitationMetadata(withLinks(["not-a-record"]))).toBe(false);
  });

  it("exposes the shared field-text guard used by the producing adapters", () => {
    expect(isSafeJiraCitationFieldText("In Progress")).toBe(true);
    expect(isSafeJiraCitationFieldText("2026-05-01T10:22:33.000+0000")).toBe(true);
    expect(isSafeJiraCitationFieldText("x".repeat(100))).toBe(true);
    expect(isSafeJiraCitationFieldText("x".repeat(101))).toBe(false);
    expect(isSafeJiraCitationFieldText("https://evil.example")).toBe(false);
    expect(isSafeJiraCitationFieldText(42)).toBe(false);
  });
});

// ─── Issue #2244 additions: write-action and envelope-authority vocabulary ──────

describe("write-action failure and authority reason vocabulary (Issue #2244)", () => {
  it("exports the closed write failure reason union with its guard", () => {
    expect(ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS).toEqual([
      "auth-failed",
      "permission-denied",
      "not-found",
      "rate-limited",
      "timeout",
      "unavailable",
      "malformed-payload",
      "bounds-exceeded",
      "conflict",
      "invalid-transition",
      "field-validation",
    ]);
    for (const reason of ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS) {
      expect(isAtlassianConnectorWriteFailureReason(reason)).toBe(true);
    }
    expect(isAtlassianConnectorWriteFailureReason("the server said no")).toBe(false);
    expect(isAtlassianConnectorWriteFailureReason(409)).toBe(false);
  });

  it("reuses the EXISTING envelope reason codes: the authority failure literals are editor deny reasons", () => {
    expect(ATLASSIAN_CONNECTOR_AUTHORITY_FAILURE_REASONS).toEqual([
      "authority-invalid",
      "authority-expired",
      "authority-budget-exceeded",
    ]);
    for (const reason of ATLASSIAN_CONNECTOR_AUTHORITY_FAILURE_REASONS) {
      expect(isAtlassianConnectorAuthorityFailureReason(reason)).toBe(true);
      // The exact literals already exist in the editor lane's deny vocabulary (ADR-0125).
      expect(EDITOR_AGENT_ACTION_DENY_REASONS).toContain(reason);
    }
    expect(isAtlassianConnectorAuthorityFailureReason("expired")).toBe(false);
  });

  it("exposes the human-initiation rationale and the review-reason guard", () => {
    expect(ATLASSIAN_CONNECTOR_HUMAN_INITIATION_REASON).toBe("human-initiated");
    expect(isAtlassianConnectorActionReviewReason("mode-approval-required")).toBe(true);
    expect(isAtlassianConnectorActionReviewReason("deterministic-risk-approval-required")).toBe(
      true,
    );
    expect(isAtlassianConnectorActionReviewReason("human-initiated")).toBe(false);
  });

  it("keeps the activity reason union assignable from every closed arm (compile-time proof)", () => {
    const reasons: readonly AtlassianConnectorActivityReasonCode[] = [
      "connector-write-denied",
      "mode-approval-required",
      "rate-limited",
      "conflict",
      "authority-expired",
      "human-initiated",
    ];
    expect(reasons).toHaveLength(6);
  });
});

// ─── Live JQL search primitives (Issue #2248) ─────────────────────────────────
describe("live search template ids (Issue #2248)", () => {
  it("declares the closed v1 template union and its guard", () => {
    expect(ATLASSIAN_LIVE_SEARCH_TEMPLATE_IDS).toEqual(["assigned-to-me-open"]);
    expect(Object.isFrozen(ATLASSIAN_LIVE_SEARCH_TEMPLATE_IDS)).toBe(true);
    expect(isAtlassianLiveSearchTemplateId("assigned-to-me-open")).toBe(true);
    for (const hostile of ["all-issues", "", 42, null, "ASSIGNED-TO-ME-OPEN"]) {
      expect(isAtlassianLiveSearchTemplateId(hostile)).toBe(false);
    }
  });
});

describe("isSafeJiraBrowseUrl (Issue #2248)", () => {
  it("accepts https browse URLs, including Data Center context paths", () => {
    expect(isSafeJiraBrowseUrl("https://example.atlassian.net/browse/PROJ-7")).toBe(true);
    expect(isSafeJiraBrowseUrl("https://intranet.example/jira/browse/OPS-12")).toBe(true);
  });

  it("fails closed on scheme, userinfo, query, fragment, and hostile keys", () => {
    for (const hostile of [
      "http://example.atlassian.net/browse/PROJ-7",
      "https://user:pw@example.atlassian.net/browse/PROJ-7",
      "https://example.atlassian.net/browse/PROJ-7?jql=secret",
      "https://example.atlassian.net/browse/PROJ-7#frag",
      "https://example.atlassian.net/browse/",
      "https://example.atlassian.net/secure/Dashboard.jspa",
      "https://example.atlassian.net/browse/PROJ-7/../admin",
      "https://example.atlassian.net/browse/a b",
      `https://example.atlassian.net/browse/${"A".repeat(2100)}`,
      "",
      42,
      undefined,
    ]) {
      expect(isSafeJiraBrowseUrl(hostile), String(hostile).slice(0, 60)).toBe(false);
    }
  });
});

describe("isSafeJiraLiveIssueSummary (Issue #2248)", () => {
  it("accepts bounded single-line content text, empty included", () => {
    expect(isSafeJiraLiveIssueSummary("")).toBe(true);
    expect(isSafeJiraLiveIssueSummary("Login token expires early (SSO @ prod)")).toBe(true);
    expect(isSafeJiraLiveIssueSummary("x".repeat(ATLASSIAN_LIVE_ISSUE_SUMMARY_MAX_CHARS))).toBe(
      true,
    );
  });

  it("fails closed on overflow, control characters, and non-strings", () => {
    expect(isSafeJiraLiveIssueSummary("x".repeat(ATLASSIAN_LIVE_ISSUE_SUMMARY_MAX_CHARS + 1))).toBe(
      false,
    );
    expect(isSafeJiraLiveIssueSummary("line one\nline two")).toBe(false);
    expect(isSafeJiraLiveIssueSummary("bell" + "\u0007" + "ring")).toBe(false);
    expect(isSafeJiraLiveIssueSummary(42)).toBe(false);
    expect(isSafeJiraLiveIssueSummary(null)).toBe(false);
  });
});
