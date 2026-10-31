import type {
  JiraReportIncompleteReason,
  JiraReportStatusCategory,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

/** One deviation from a rule. `ruleId` is a stable identifier; no value or text is carried. */
export interface JiraReportDeviation {
  readonly ruleId: string;
  readonly fieldId?: string;
}

/** The compact, derived record kept per issue; raw Jira payloads are never retained. */
export interface JiraReportIssue {
  readonly key: string;
  readonly typeName: string;
  /** A sub-task type never makes its parent a container of work. */
  readonly subtask: boolean;
  readonly summary: string;
  readonly statusName: string;
  readonly category: JiraReportStatusCategory;
  /** Hierarchical parent (parent, Epic Link or Parent Link), in or out of the scope. */
  readonly parentKey: string | undefined;
  /** Targets of every issue link of the issue, either direction. */
  readonly linkedKeys: readonly string[];
  readonly assigned: boolean;
  readonly dueDate: string | undefined;
  readonly estimate: number | undefined;
  /** The instance marks it as an epic (a value in the Epic Name field). */
  readonly epicMarker: boolean;
  readonly deviations: readonly JiraReportDeviation[];
  /** Declared requirement ids this issue names in its summary, labels or description. */
  readonly requirementIds: readonly string[];
}

/** What a template checker sees: derived facts plus the raw values of the fields it asked for. */
export interface JiraReportIssueFacts {
  readonly key: string;
  readonly projectKey: string;
  readonly issueTypeId: string;
  readonly typeName: string;
  readonly category: JiraReportStatusCategory;
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * The shared compliance check (#4177). The report asks for the checker's fields in the same Jira
 * reads and raises exactly the deviations it returns; it never interprets a template itself.
 */
export interface JiraReportComplianceChecker {
  readonly fieldIds: readonly string[];
  readonly check: (facts: JiraReportIssueFacts) => readonly JiraReportDeviation[];
}

export interface JiraReportStatusCounts {
  readonly total: number;
  readonly new: number;
  readonly indeterminate: number;
  readonly done: number;
  /** Statuses whose category Jira reports as `undefined` (or does not report). */
  readonly noCategory: number;
}

export interface JiraReportEstimate {
  readonly total: number;
  readonly done: number;
  readonly remaining: number;
  readonly unestimated: number;
}

export interface JiraReportProgress extends JiraReportStatusCounts {
  /** Done issues over all issues, in percent with one decimal; 0 for an empty set. */
  readonly donePercent: number;
  readonly estimate: JiraReportEstimate;
}

export interface JiraReportTypeProgress {
  readonly typeName: string;
  readonly total: number;
  readonly done: number;
}

export interface JiraReportStatusCount {
  readonly typeName: string;
  readonly statusName: string;
  readonly category: JiraReportStatusCategory;
  readonly total: number;
}

export interface JiraReportContainer {
  readonly key: string;
  readonly summary: string;
  readonly typeName: string;
  readonly statusName: string;
  readonly category: JiraReportStatusCategory;
  /** The container is not part of the scope; only its members are. */
  readonly external: boolean;
  readonly members: JiraReportProgress;
  readonly linked: JiraReportProgress;
  readonly byType: readonly JiraReportTypeProgress[];
}

export interface JiraReportDeviationRecord {
  readonly key: string;
  readonly ruleIds: readonly string[];
  readonly fieldIds: readonly string[];
}

export interface JiraReportRequirementCoverage {
  readonly id: string;
  readonly coveredBy: readonly string[];
  readonly itemCount: number;
  readonly done: number;
  readonly byType: readonly JiraReportTypeProgress[];
}

export type JiraReportIssueClass = "container" | "member" | "linked" | "orphan";

export interface JiraReportCompleteness {
  readonly complete: boolean;
  readonly reason?: JiraReportIncompleteReason;
  readonly issuesRead: number;
  readonly issuesTotal: number | undefined;
  readonly pageCount: number;
}

export interface JiraReportScope {
  readonly projectKey?: string;
  readonly jql: string;
  readonly estimateFieldId?: string;
}

export interface JiraReport {
  readonly digest: string;
  readonly generatedAt: string;
  readonly scope: JiraReportScope;
  readonly completeness: JiraReportCompleteness;
  readonly hierarchy: {
    readonly discovery: "complete" | "unavailable";
    readonly fieldCount: number;
  };
  readonly progress: {
    readonly project: JiraReportProgress;
    readonly byType: readonly JiraReportTypeProgress[];
    /** Issues per issue type and status name, so a status the instance names can be read back. */
    readonly byStatus: readonly JiraReportStatusCount[];
    readonly unassigned: number;
    readonly overdue: number;
  };
  readonly epics: readonly JiraReportContainer[];
  readonly compliance: {
    readonly requiredFieldRules: "applied" | "partial" | "unavailable" | "not-requested";
    readonly checker: "applied" | "none";
    readonly issuesChecked: number;
    readonly issuesWithDeviations: number;
    readonly deviationCount: number;
    readonly byRule: readonly { readonly ruleId: string; readonly count: number }[];
    readonly deviations: readonly JiraReportDeviationRecord[];
  };
  readonly coverage: {
    readonly uncoveredEpics: readonly string[];
    readonly orphans: readonly string[];
    readonly requirements:
      | {
          readonly declared: number;
          readonly covered: number;
          readonly items: readonly JiraReportRequirementCoverage[];
          readonly uncovered: readonly string[];
        }
      | undefined;
  };
  /** Per-issue rows for the export; never part of the tool result. */
  readonly rows: readonly JiraReportRow[];
}

export interface JiraReportRow {
  readonly issue: JiraReportIssue;
  readonly classification: JiraReportIssueClass;
  readonly containerKeys: readonly string[];
  readonly overdue: boolean;
}
