import type {
  JiraReportEstimateUnit,
  JiraReportEstimateSource,
  JiraReportEstimateUnavailableReason,
  JiraReportFailureReason,
  JiraReportIncompleteReason,
  JiraReportStatusCategory,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";

/**
 * One deviation from a rule. `ruleId` is a stable identifier. `subject` names the template element
 * the rule concerns (a section, a field name, a label); it comes from the template, never from an
 * issue's description or comments.
 */
export interface JiraReportDeviation {
  readonly ruleId: string;
  readonly fieldId?: string;
  readonly subject?: string;
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
  /** Hierarchical parent (the `parent` field or a discovered or named parent field), in or out of the scope. */
  readonly parentKey: string | undefined;
  /** Targets of every issue link of the issue, either direction. */
  readonly linkedKeys: readonly string[];
  readonly assigned: boolean;
  readonly dueDate: string | undefined;
  readonly estimate: number | undefined;
  /**
   * Present (`true`) when the issue's type has no estimate field at all, so the issue is not
   * estimable, which is not the same as not yet estimated. Absent otherwise.
   */
  readonly estimateNotCarried?: true;
  /** The value of the alternate estimate field (see `JiraReportScope.estimateAlso`), when held. */
  readonly alternateEstimate?: number;
  readonly deviations: readonly JiraReportDeviation[];
  /**
   * Whether at least one issue template applied to this issue and judged it (#4181). `false` when
   * no template of its project and issue type exists, and whenever no template checker ran, so a
   * missing deviation never reads as compliance.
   */
  readonly templateJudged: boolean;
  /**
   * Whether the instance's required-field rules judged this issue: the create metadata of its
   * issue type was read. `false` when the rules were not requested or unavailable for its type.
   */
  readonly requiredJudged: boolean;
  /** Declared requirement ids this issue names in its summary, labels or description. */
  readonly requirementIds: readonly string[];
  /** The issue's labels, bounded; the trace a write left on the issue is read back from them. */
  readonly labels: readonly string[];
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
  readonly requiresNativeEvidence?: true;
  /** Auxiliary native evidence shares this slice's GET-only admission and deadline. */
  readonly check: (
    facts: JiraReportIssueFacts,
    request?: JiraMutationRequest,
  ) =>
    | readonly JiraReportDeviation[]
    | "unavailable"
    | Promise<readonly JiraReportDeviation[] | "unavailable">;
  /**
   * Whether at least one template applies to the issue, so that `check` actually judged it (#4181).
   * A checker without it is taken to judge every issue.
   */
  readonly covers?: (facts: JiraReportIssueFacts) => boolean;
}

/** The instance's fields by id and name, for resolving the names a template refers to. */
export interface JiraReportFieldCatalogEntry {
  readonly id: string;
  readonly name: string;
  /** The field's non-localized schema `custom` key, when the metadata states one. */
  readonly schemaKey?: string;
}

/**
 * A checker whose fields depend on the instance (#4177): the report binds it once, with the
 * instance's field list (`undefined` when that list could not be read). `none`: nothing governs
 * the report, so there is nothing to check; `unavailable`: the checker cannot be applied (an
 * unreadable or malformed template, or a name that cannot be resolved), and the report says so
 * instead of reporting zero deviations.
 */
export interface JiraReportCheckerBinder {
  readonly bind: (
    catalog: readonly JiraReportFieldCatalogEntry[] | undefined,
  ) => JiraReportComplianceChecker | "none" | "unavailable";
}
export type JiraReportCheckerPort = JiraReportComplianceChecker | JiraReportCheckerBinder;

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
  /** Null when no project estimate field could be established; never an invented zero. */
  readonly estimate: JiraReportEstimate | null;
}

export interface JiraReportTypeProgress {
  readonly typeName: string;
  readonly total: number;
  readonly done: number;
  /** Issues of this type with an estimate; `null` when no estimate is available, like the project's. */
  readonly estimated: number | null;
  /** Issues of this type without one; per-type counts sum to the project's `estimate.unestimated`. */
  readonly unestimated: number | null;
  /**
   * `not-carried`: the type has no estimate field, so its issues read as unestimated because they
   * cannot be estimated, not because nobody did. Absent for a type that carries the field.
   */
  readonly estimateField?: "not-carried";
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
  /** `ruleId: subject` per deviation, so a lead sees which section or field is missing. */
  readonly details: readonly string[];
}

export interface JiraReportRequirementSet {
  readonly declared: number;
  readonly covered: number;
  readonly items: readonly JiraReportRequirementCoverage[];
  readonly uncovered: readonly string[];
}

export interface JiraReportRequirementCoverage {
  readonly id: string;
  readonly coveredBy: readonly string[];
  /** The covering issues themselves: a story that covers a requirement alone is one. */
  readonly coveringTotal: number;
  readonly coveringDone: number;
  /** Their descendants and, for a container, its linked issues. */
  readonly itemCount: number;
  readonly done: number;
  readonly byType: readonly JiraReportTypeProgress[];
}

export type JiraReportIssueClass = "container" | "member" | "linked" | "orphan";

export interface JiraReportCompleteness {
  readonly complete: boolean;
  readonly reason?: JiraReportIncompleteReason;
  /** Why Jira could not be read further, when that is the reason. */
  readonly failure?: JiraReportFailureReason;
  readonly issuesRead: number;
  readonly issuesTotal: number | undefined;
  readonly pageCount: number;
}

export interface JiraReportEstimateFieldRef {
  readonly fieldId: string;
  readonly fieldName: string;
  readonly unit: JiraReportEstimateUnit;
}

export interface JiraReportScope {
  readonly projectKey?: string;
  /** The Epic a report was scoped to; `jql` states the clause that selects it and its members. */
  readonly epicKey?: string;
  /** Members of the Epic that can hold sub-tasks, and the digest of their sorted keys. */
  readonly epicMemberCount?: number;
  readonly epicMembersDigest?: string;
  /** Whether the Epic Link field was addressed by id, or the instance has none. */
  readonly epicLink?: "field" | "absent";
  readonly jql: string;
  readonly estimateFieldId?: string;
  readonly estimateFieldName?: string;
  readonly estimateSource?: JiraReportEstimateSource;
  readonly estimateUnavailableReason?: JiraReportEstimateUnavailableReason;
  /** Seconds of original time estimate, or the named field's own unit. */
  readonly estimateUnit: JiraReportEstimateUnit;
  /**
   * Set when the report took another estimate field than the configured one because the
   * configured field holds no value on any issue in scope: the configured field, named here.
   */
  readonly estimateConfigured?: JiraReportEstimateFieldRef;
  /**
   * Set (`true`) when Jira withheld the configured estimate field on an issue: that field could not
   * be read, which is not the same as holding no value, so no other field is substituted.
   */
  readonly estimateUnreadable?: true;
  /**
   * Set when a second estimate field also holds values beside the one the figures use, so nothing
   * is hidden: that field, how many issues hold a value in it and their total in its own unit.
   */
  readonly estimateAlso?: JiraReportEstimateFieldRef & {
    readonly issues: number;
    readonly total: number;
  };
  /** The date overdue is judged against, in `timeZone`. */
  readonly asOf: string;
  readonly timeZone: "UTC";
}

export interface JiraReport {
  readonly digest: string;
  readonly generatedAt: string;
  readonly scope: JiraReportScope;
  readonly completeness: JiraReportCompleteness;
  readonly hierarchy: {
    readonly discovery: "complete" | "unavailable";
    /** Custom fields consulted for a parent: discovered by schema shape plus caller-named ones. */
    readonly fieldCount: number;
    /** How many of them held a parent key on at least one issue read. */
    readonly observedFieldCount: number;
    /** Discovered fields shown not to hold a parent, so later pages stopped asking for them. */
    readonly rejectedFieldCount: number;
    /**
     * Discovered fields, not named by the caller, whose issue-key values supplied a parent. Jira
     * states no role for an app's field, so these relations rest on the value shape alone: the
     * report discloses them as not verified; naming the field in `parentFieldIds` confirms it.
     */
    readonly inferredFieldCount: number;
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
    readonly checker: "applied" | "none" | "unavailable";
    /**
     * With `checker: "applied"`: the issues at least one template judged. An issue of a type no
     * template covers is not counted here; it is counted in `issuesWithoutTemplate`, because "no
     * deviation" is only a statement about an issue something judged (#4181). With `none` or
     * `unavailable` complete template coverage is unknown: the number is the issues read.
     * Independently measured partial deviations may remain, while missing evidence never adds one.
     */
    readonly issuesChecked: number;
    /**
     * Issues at least one contributing rule judged: the template-covered ones and those whose type
     * the required-field rules read. It is the denominator of every deviation count, because the
     * deviations come from both rule families; `issuesChecked` stays the template's own coverage.
     */
    readonly issuesJudged: number;
    /**
     * Issues no template judged. With `applied`: those whose project and issue type no template
     * covers. With `none`: every issue, as there is no template. With `unavailable`: 0, as
     * coverage cannot be told and the report is incomplete.
     */
    readonly issuesWithoutTemplate: number;
    /** `issuesWithoutTemplate` by issue type, largest first, then by name. */
    readonly withoutTemplateByType: readonly {
      readonly typeName: string;
      readonly count: number;
    }[];
    readonly issuesWithDeviations: number;
    readonly deviationCount: number;
    /** Issues per rule, each issue once however many of its fields or sections break it. */
    readonly byRule: readonly { readonly ruleId: string; readonly count: number }[];
    readonly deviations: readonly JiraReportDeviationRecord[];
  };
  readonly coverage: {
    /**
     * `unobserved`: nothing in the scope holds work, so which issues are containers cannot be
     * told and `uncoveredEpics` is not a statement that none is empty.
     */
    readonly containerRoles: "observed" | "unobserved";
    readonly uncoveredEpics: readonly string[];
    readonly orphans: readonly string[];
    /**
     * The headline coverage. With explicit identifiers in the documents it counts those only; a
     * document without any has the derived units as its requirements and they form the figure.
     */
    readonly requirements:
      | (JiraReportRequirementSet & {
          /** The readable name of each uncovered identifier Keiko derived (headline of a document without explicit ones). */
          readonly uncoveredLabels: Readonly<Record<string, string>>;
          /**
           * Units Keiko derived from statements without an identifier, beside an explicit headline,
           * with their own counts and their readable names. A context sentence the detector took
           * for a requirement shows up here, never in the headline and never dropped.
           */
          readonly derived?: JiraReportRequirementSet & {
            readonly names: Readonly<Record<string, string>>;
          };
        })
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
