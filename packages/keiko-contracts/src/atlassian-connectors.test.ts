import { describe, expect, it } from "vitest";
import {
  ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS,
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
  isAtlassianContentPreviewUnpresentable,
  isAtlassianLiveSearchTemplateId,
  isAtlassianSyncFailureReason,
  isAtlassianSyncJobStatus,
  isAtlassianSyncTerminalStatus,
  isJiraIssueCitationMetadata,
  isSafeAtlassianConnectorBaseUrl,
  isSafeAtlassianContentPreview,
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
  type AtlassianConnectorPendingApproval,
  type AtlassianConnectorProvider,
} from "./atlassian-connectors.js";
import { validateAtlassianConnectorPendingApproval } from "./atlassian-connectors-validation.js";
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
      "supervised-coding": "review-required",
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
      "supervised-coding": "review-required",
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
      "supervised-coding": "review-required",
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
      "supervised-coding": "review-required",
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
      "supervised-coding": "review-required",
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
      "supervised-coding": "review-required",
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
      "supervised-coding": "review-required",
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

describe("isAtlassianContentPreviewUnpresentable (KEIKO-0186 P1-P4)", () => {
  it("is true for an empty string", () => {
    expect(isAtlassianContentPreviewUnpresentable("")).toBe(true);
  });

  it("is true for a string made entirely of Unicode combining marks (no base character)", () => {
    // COMBINING ACUTE ACCENT (U+0301), built at runtime for the same reason as the bidi/zero-width
    // cases below: the source file never carries the code point directly.
    expect(isAtlassianContentPreviewUnpresentable(String.fromCharCode(0x301).repeat(5))).toBe(true);
  });

  it("is false for a base character followed by a combining mark (a real, renderable character)", () => {
    expect(isAtlassianContentPreviewUnpresentable("e" + String.fromCharCode(0x301))).toBe(false);
  });

  it("is false for ordinary text", () => {
    expect(isAtlassianContentPreviewUnpresentable("Fix the flaky gate")).toBe(false);
    expect(isAtlassianContentPreviewUnpresentable("x")).toBe(false);
  });

  // KEIKO-0186 P2 (Codex): the P1 pattern (^\p{M}+$) is anchored end-to-end, so it stops matching
  // the moment ANY other character is present -- including whitespace. A lone space, a run of
  // TAB/LF, or whitespace next to a floating combining mark all satisfied it and were classified
  // presentable. Whitespace, like a combining mark, is outside the {Letter, Number, Punctuation}
  // allowlist P4 settled on, so these cases hold under every version of the predicate.
  it("is true for whitespace only: space, TAB, LF, and a mix of all three", () => {
    const space = " ";
    const tab = String.fromCharCode(9);
    const lf = String.fromCharCode(10);
    expect(isAtlassianContentPreviewUnpresentable(space)).toBe(true);
    expect(isAtlassianContentPreviewUnpresentable(tab)).toBe(true);
    expect(isAtlassianContentPreviewUnpresentable(lf)).toBe(true);
    expect(isAtlassianContentPreviewUnpresentable(space + tab + lf + space)).toBe(true);
  });

  it("is true for whitespace next to a combining mark, in either order", () => {
    const spaceThenMark = " " + String.fromCharCode(0x301);
    const markThenSpace = String.fromCharCode(0x301) + " ";
    expect(isAtlassianContentPreviewUnpresentable(spaceThenMark)).toBe(true);
    expect(isAtlassianContentPreviewUnpresentable(markThenSpace)).toBe(true);
    // A run mixing TAB and multiple combining marks in both orders is still nothing but the two
    // ignorable categories -- no base character anywhere in it.
    const mixed =
      " " + String.fromCharCode(0x301) + String.fromCharCode(9) + String.fromCharCode(0x301);
    expect(isAtlassianContentPreviewUnpresentable(mixed)).toBe(true);
  });

  it("is true for whitespace next to a zero-width/format character, independent of stripUnsafeFormatChars having run first", () => {
    // ZERO WIDTH SPACE (U+200B) is Unicode general category Cf (Format) -- outside the {L, N, P}
    // allowlist on its own terms, so this predicate does not rely on stripUnsafeFormatChars
    // already having removed it -- defense in depth, not a redundant check: the producer always
    // sanitizes first, but this predicate must be correct on its own.
    const zeroWidthOnly = String.fromCharCode(0x200b).repeat(3);
    const spaceThenZeroWidth = " " + String.fromCharCode(0x200b);
    expect(isAtlassianContentPreviewUnpresentable(zeroWidthOnly)).toBe(true);
    expect(isAtlassianContentPreviewUnpresentable(spaceThenZeroWidth)).toBe(true);
  });

  // KEIKO-0186 P3 (Codex): U+3164 HANGUL FILLER (used historically to fill an empty Hangul input
  // slot) renders as nothing, yet its Unicode general category is Lo -- a LETTER. This is the
  // reason the P4 allowlist cannot be "characters in {L, N, P}" alone: general category does not
  // track rendering behaviour, so a naive allowlist membership test would wrongly accept HANGUL
  // FILLER as presentable. It is also Default_Ignorable_Code_Point, which the predicate checks
  // and excludes independently of general category -- these cases are the reason that second,
  // independent check exists.
  it("is true for HANGUL FILLER (U+3164) alone, repeated, and mixed with whitespace or a combining mark", () => {
    const hangulFiller = String.fromCodePoint(0x3164);
    expect(isAtlassianContentPreviewUnpresentable(hangulFiller)).toBe(true);
    expect(isAtlassianContentPreviewUnpresentable(hangulFiller.repeat(3))).toBe(true);
    expect(isAtlassianContentPreviewUnpresentable(" " + hangulFiller)).toBe(true);
    expect(isAtlassianContentPreviewUnpresentable(hangulFiller + String.fromCharCode(0x301))).toBe(
      true,
    );
  });

  it("is true for a variation selector alone (VARIATION SELECTOR-16, U+FE0F -- itself Unicode general category Mn, outside the allowlist on that basis alone)", () => {
    expect(isAtlassianContentPreviewUnpresentable(String.fromCodePoint(0xfe0f))).toBe(true);
  });

  // KEIKO-0186 P4 (Codex): U+2800 BRAILLE PATTERN BLANK is deliberately blank by design, yet its
  // Unicode general category is So (a SYMBOL) -- it matched none of \s, \p{M}, or
  // Default_Ignorable_Code_Point, defeating every prior layer. Unicode has no "renders blank"
  // property, so a fourth enumerated exception would only invite a fifth. The predicate is now an
  // ALLOWLIST: presentable requires at least one character in {Letter, Number, Punctuation}; a
  // symbol -- BRAILLE PATTERN BLANK included -- is never in that set, so it is unpresentable
  // regardless of whether anyone ever named it specifically.
  it("is true for BRAILLE PATTERN BLANK (U+2800) alone, repeated, and mixed with whitespace", () => {
    const braillePatternBlank = String.fromCodePoint(0x2800);
    expect(isAtlassianContentPreviewUnpresentable(braillePatternBlank)).toBe(true);
    expect(isAtlassianContentPreviewUnpresentable(braillePatternBlank.repeat(5))).toBe(true);
    expect(isAtlassianContentPreviewUnpresentable(" " + braillePatternBlank)).toBe(true);
  });

  // P4's allowlist inversion has a real cost, made deliberately and documented at the predicate's
  // definition: \p{S} (Symbol, which includes emoji) is excluded from the allowlist entirely, not
  // folded in minus the known-blank ranges -- carving out "safe symbols" would recreate the exact
  // enumeration problem this fix exists to end, just on the allow side. This test asserts that
  // decision is machine-checked, not merely described: a real, renderable emoji-presentation pair
  // (a heavy black heart forced to emoji style) is STILL classified unpresentable on its own,
  // because its base character (U+2764 HEAVY BLACK HEART) is itself \p{S} -- unlike the P3 test
  // above this replaces, the base character here is a symbol, not a letter.
  it("is true for an emoji-presentation pair alone (P4: \\p{S} is excluded from the allowlist, including when the base character would otherwise be visible)", () => {
    const heavyBlackHeart = String.fromCodePoint(0x2764);
    const variationSelector16 = String.fromCodePoint(0xfe0f);
    expect(isAtlassianContentPreviewUnpresentable(heavyBlackHeart + variationSelector16)).toBe(
      true,
    );
  });

  it("is true for emoji-only content with no variation selector involved (a grinning face, and a thumbs-up)", () => {
    expect(isAtlassianContentPreviewUnpresentable(String.fromCodePoint(0x1f600))).toBe(true);
    expect(isAtlassianContentPreviewUnpresentable(String.fromCodePoint(0x1f44d))).toBe(true);
  });

  it("is false for CJK-only content: \\p{L} already covers CJK ideographs and other non-Latin scripts, so the P4 allowlist decision is narrower than 'excludes non-Latin text'", () => {
    expect(isAtlassianContentPreviewUnpresentable("已完成")).toBe(false); // Chinese: "done"
    expect(isAtlassianContentPreviewUnpresentable("ありがとう")).toBe(false); // Japanese hiragana
    expect(isAtlassianContentPreviewUnpresentable("완료")).toBe(false); // Korean hangul syllables
  });

  it("is false when real text and emoji are mixed: only one presentable character is required, anywhere in the value", () => {
    expect(isAtlassianContentPreviewUnpresentable(String.fromCodePoint(0x1f389) + " Success")).toBe(
      false,
    );
  });

  it("distinguishes a truncation window that is all HANGUL FILLER from the untruncated string that has a base character just past it", () => {
    const fillerPrefix = String.fromCodePoint(0x3164).repeat(
      ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS,
    );
    const withBaseCharPastTheBound = fillerPrefix + "X";
    const truncationWindow = withBaseCharPastTheBound.slice(
      0,
      ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS,
    );
    expect(isAtlassianContentPreviewUnpresentable(withBaseCharPastTheBound)).toBe(false);
    expect(isAtlassianContentPreviewUnpresentable(truncationWindow)).toBe(true);
  });

  it("distinguishes a truncation window that is all whitespace/combining marks from the untruncated string that has a base character just past it", () => {
    // Builds a candidate whose first MAX characters (what contentPreviewFor's bound would keep)
    // are alternating space + combining-mark pairs, with a real base character appended right
    // after that window -- exactly the shape truncation can produce in practice.
    const pairs = (" " + String.fromCharCode(0x301)).repeat(
      Math.ceil(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS / 2),
    );
    const withBaseCharPastTheBound =
      pairs.slice(0, ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS) + "X";
    const truncationWindow = withBaseCharPastTheBound.slice(
      0,
      ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS,
    );
    expect(isAtlassianContentPreviewUnpresentable(withBaseCharPastTheBound)).toBe(false);
    expect(isAtlassianContentPreviewUnpresentable(truncationWindow)).toBe(true);
  });

  it("distinguishes a truncation window that is all BRAILLE PATTERN BLANK from the untruncated string that has a base character just past it", () => {
    const braillePrefix = String.fromCodePoint(0x2800).repeat(
      ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS,
    );
    const withBaseCharPastTheBound = braillePrefix + "X";
    const truncationWindow = withBaseCharPastTheBound.slice(
      0,
      ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS,
    );
    expect(isAtlassianContentPreviewUnpresentable(withBaseCharPastTheBound)).toBe(false);
    expect(isAtlassianContentPreviewUnpresentable(truncationWindow)).toBe(true);
  });

  // KEIKO-0186 P5 (Codex): U+13441 EGYPTIAN HIEROGLYPH FULL BLANK and U+13442 HALF BLANK are
  // Unicode general category Lo (LETTERS) -- not Default_Ignorable_Code_Point -- yet render blank
  // on a client with the font. A fifth input class defeats character-property classification for
  // the same structural reason HANGUL FILLER did under P3: general category tracks
  // classification, not rendering, and whether a glyph renders at all depends on the reader's own
  // fonts besides. This predicate closes today's specific report (KNOWN_BLANK_LETTER_PATTERN,
  // cheap and narrow) but is no longer the only defence -- see ConnectorApprovalsPanel's
  // character-count signal, which holds for a blank Letter nobody has reported yet.
  it("is true for EGYPTIAN HIEROGLYPH FULL BLANK (U+13441) and HALF BLANK (U+13442), alone, repeated, and mixed with each other or whitespace", () => {
    const fullBlank = String.fromCodePoint(0x13441);
    const halfBlank = String.fromCodePoint(0x13442);
    expect(isAtlassianContentPreviewUnpresentable(fullBlank)).toBe(true);
    expect(isAtlassianContentPreviewUnpresentable(halfBlank)).toBe(true);
    expect(isAtlassianContentPreviewUnpresentable(fullBlank.repeat(3))).toBe(true);
    expect(isAtlassianContentPreviewUnpresentable(fullBlank + halfBlank)).toBe(true);
    expect(isAtlassianContentPreviewUnpresentable(" " + fullBlank)).toBe(true);
  });

  it("is false for a real base character alongside an EGYPTIAN HIEROGLYPH BLANK: only one presentable character is required", () => {
    expect(isAtlassianContentPreviewUnpresentable("Done" + String.fromCodePoint(0x13441))).toBe(
      false,
    );
  });
});

describe("isSafeAtlassianContentPreview (KEIKO-0186)", () => {
  it("accepts bounded, multi-line real text up to the cap", () => {
    expect(isSafeAtlassianContentPreview("Fix the flaky gate")).toBe(true);
    expect(isSafeAtlassianContentPreview("Fix the flaky gate\n\nFails on retries")).toBe(true);
    expect(
      isSafeAtlassianContentPreview("x".repeat(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS)),
    ).toBe(true);
    // TAB/LF/CR are legitimate formatting, not spoofing (a page body is not single-line).
    expect(
      isSafeAtlassianContentPreview(
        "line one" +
          String.fromCharCode(10) +
          "line two" +
          String.fromCharCode(9) +
          "tabbed" +
          String.fromCharCode(13, 10) +
          "line three",
      ),
    ).toBe(true);
  });

  it("rejects empty, overlong, control-character, bidi/zero-width, combining-marks-only, whitespace-only, default-ignorable-only, symbol/emoji-only, blank-letter-only, and non-string values", () => {
    expect(isSafeAtlassianContentPreview("")).toBe(false);
    expect(
      isSafeAtlassianContentPreview("x".repeat(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS + 1)),
    ).toBe(false);
    expect(isSafeAtlassianContentPreview("bell" + "\u0007" + "ring")).toBe(false);
    // RIGHT-TO-LEFT OVERRIDE (U+202E) and ZERO WIDTH SPACE (U+200B), built at runtime so the
    // source file never carries an invisible/spoofing byte directly (only this ASCII call).
    expect(isSafeAtlassianContentPreview("visible" + String.fromCharCode(0x202e) + "evil")).toBe(
      false,
    );
    expect(
      isSafeAtlassianContentPreview("visible" + String.fromCharCode(0x200b) + "zerowidth"),
    ).toBe(false);
    // KEIKO-0186 P1: non-empty but entirely Unicode combining marks -- no base character, exactly
    // as uninformative to a reviewer as empty (see isAtlassianContentPreviewUnpresentable above).
    expect(isSafeAtlassianContentPreview(String.fromCharCode(0x301).repeat(5))).toBe(false);
    // KEIKO-0186 P2: whitespace-only, and whitespace next to a combining mark, are exactly as
    // uninformative -- neither is a shape the P1 anchored pattern (^\p{M}+$) caught.
    expect(isSafeAtlassianContentPreview(" ")).toBe(false);
    expect(isSafeAtlassianContentPreview(String.fromCharCode(9) + String.fromCharCode(10))).toBe(
      false,
    );
    expect(isSafeAtlassianContentPreview(" " + String.fromCharCode(0x301))).toBe(false);
    expect(isSafeAtlassianContentPreview(String.fromCharCode(0x301) + " ")).toBe(false);
    // KEIKO-0186 P3: HANGUL FILLER (U+3164) renders as nothing despite belonging to Unicode
    // general category Lo (a letter) -- the allowlist alone would wrongly accept it; the
    // independent Default_Ignorable_Code_Point exclusion is why it is still rejected. A bare
    // variation selector is excluded on category grounds alone (it is \p{M}, not in {L, N, P}).
    expect(isSafeAtlassianContentPreview(String.fromCodePoint(0x3164))).toBe(false);
    expect(isSafeAtlassianContentPreview(String.fromCodePoint(0xfe0f))).toBe(false);
    // KEIKO-0186 P4: BRAILLE PATTERN BLANK (U+2800) is deliberately blank by design, yet is
    // Unicode general category So (a symbol) -- outside {L, N, P} the same as any other symbol.
    // Symbol/emoji-only content is also rejected: a deliberate P4 allowlist decision, not an
    // oversight (see isAtlassianContentPreviewUnpresentable's definition for the reasoning).
    expect(isSafeAtlassianContentPreview(String.fromCodePoint(0x2800))).toBe(false);
    expect(isSafeAtlassianContentPreview(String.fromCodePoint(0x1f600))).toBe(false);
    // KEIKO-0186 P5: EGYPTIAN HIEROGLYPH FULL BLANK (U+13441) and HALF BLANK (U+13442) are
    // Unicode general category Lo (letters) that render blank -- like HANGUL FILLER, the
    // allowlist alone would wrongly accept them; KNOWN_BLANK_LETTER_PATTERN is why they are still
    // rejected. See isAtlassianContentPreviewUnpresentable for why this predicate is now a
    // heuristic backed by the UI's character-count signal, not the sole defence.
    expect(isSafeAtlassianContentPreview(String.fromCodePoint(0x13441))).toBe(false);
    expect(isSafeAtlassianContentPreview(String.fromCodePoint(0x13442))).toBe(false);
    expect(isSafeAtlassianContentPreview(42)).toBe(false);
    expect(isSafeAtlassianContentPreview(null)).toBe(false);
    expect(isSafeAtlassianContentPreview(undefined)).toBe(false);
  });
});

describe("validateAtlassianConnectorPendingApproval — contentPreview wiring (KEIKO-0186)", () => {
  const base: AtlassianConnectorPendingApproval = {
    schemaVersion: "1",
    approvalId: "ap1",
    connectorId: "cred-abc",
    provider: "jira",
    actionType: "create-issue",
    actionClass: "connector-write",
    requiredScope: "issue-tracker.write",
    risk: "high",
    reviewReason: "deterministic-risk-approval-required",
    correlationId: "corr1",
    requestedAt: 0,
    expiresAt: 1000,
  };

  it("accepts an approval with no contentPreview (transition-issue and friends)", () => {
    expect(validateAtlassianConnectorPendingApproval(base)).toMatchObject({ ok: true });
  });

  it("accepts an approval whose contentPreview is a bounded, sanitized string", () => {
    expect(
      validateAtlassianConnectorPendingApproval({
        ...base,
        contentPreview: "Fix the flaky gate\n\nFails on retries",
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects an approval whose contentPreview exceeds the bound", () => {
    expect(
      validateAtlassianConnectorPendingApproval({
        ...base,
        contentPreview: "x".repeat(ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS + 1),
      }),
    ).toMatchObject({
      ok: false,
      errors: [
        "approval.contentPreview must be a bounded, control-character-free preview when set",
      ],
    });
  });

  it("rejects an approval whose contentPreview carries a raw control character", () => {
    expect(
      validateAtlassianConnectorPendingApproval({
        ...base,
        contentPreview: "bell" + String.fromCharCode(7) + "ring",
      }),
    ).toMatchObject({
      ok: false,
      errors: [
        "approval.contentPreview must be a bounded, control-character-free preview when set",
      ],
    });
  });

  // KEIKO-0186 P1 (Codex): the action had text, but nothing presentable survived
  // sanitization/bounding. contentPreviewUnavailable is the explicit signal for that case --
  // never an empty or absent-without-explanation contentPreview.
  it("accepts an approval with contentPreviewUnavailable: true instead of a contentPreview", () => {
    expect(
      validateAtlassianConnectorPendingApproval({
        ...base,
        contentPreviewUnavailable: true,
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects an approval whose contentPreviewUnavailable is not literally true", () => {
    expect(
      validateAtlassianConnectorPendingApproval({
        ...base,
        contentPreviewUnavailable: false,
      }),
    ).toMatchObject({
      ok: false,
      errors: ["approval.contentPreviewUnavailable must be true when set"],
    });
  });

  it("rejects an approval carrying both contentPreview and contentPreviewUnavailable (mutually exclusive)", () => {
    expect(
      validateAtlassianConnectorPendingApproval({
        ...base,
        contentPreview: "Fix the flaky gate",
        contentPreviewUnavailable: true,
      }),
    ).toMatchObject({
      ok: false,
      errors: ["approval.contentPreview and approval.contentPreviewUnavailable are exclusive"],
    });
  });
});
