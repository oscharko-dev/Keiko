"use client";

import type { JiraTemplateParseError } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  JiraTemplateBound,
  JiraTemplateOptions,
  JiraTemplateOptionsRequest,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { codingAppSessionPairingSettled } from "./coding-app-session-client";
import { bffFetchJson } from "./http";

/** Customer-defined Jira issue templates live in the private skill library (#4177). */
export interface JiraTemplateEntry {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly valid: boolean;
  readonly project?: string;
  readonly issueType?: string;
  readonly activations?: readonly string[];
  /** How many other saved templates govern the same project and issue type (every one must be met). */
  readonly sharedWith?: number;
}

export const JIRA_TEMPLATE_FINDING_CODES = [
  "unknown-project",
  "unknown-issue-type",
  "unknown-field",
  "ambiguous-field",
  "unknown-link-type",
  "unknown-transition-target",
  "wrong-parent-field",
] as const;
export type JiraTemplateFindingCode = (typeof JIRA_TEMPLATE_FINDING_CODES)[number];

export interface JiraTemplateFinding {
  readonly code: JiraTemplateFindingCode;
  readonly subject: string;
}

/**
 * What this Jira's own view says about the template's typed issue types: already bound to their ids,
 * ready to be bound, or a name that is not exactly one type here (#4354).
 */
export type JiraTemplateBindingState =
  | { readonly state: "bound"; readonly issueType: string }
  | { readonly state: "bindable"; readonly issueType: string }
  | { readonly state: "unresolved" | "ambiguous" | "dead"; readonly subject: string };

export type JiraTemplateValidation =
  | { readonly valid: false; readonly errors: readonly JiraTemplateParseError[] }
  | {
      readonly valid: true;
      readonly binding?: JiraTemplateBindingState;
      readonly findings: readonly JiraTemplateFinding[];
      readonly checked: {
        readonly project: boolean;
        readonly fields: boolean;
        readonly linkTypes: boolean;
        readonly transitions: boolean;
      };
    };

/** The Jira read that did not answer for a proposal that was kept anyway (#4354). */
export type JiraTemplateProposalPartial = "required-fields-unavailable" | "samples-unavailable";
export interface JiraTemplateProposal {
  readonly issueType: string;
  readonly markdown: string;
  readonly sampledIssueCount: number;
  readonly partial?: JiraTemplateProposalPartial;
}

/** Why an issue type of the project has no proposal; each is a closed word with its own plain text. */
export type JiraTemplateWithoutProposalReason =
  "nothing-to-learn" | "template-invalid" | "jira-unavailable" | "beyond-limit";
export interface JiraTemplateWithoutProposal {
  readonly issueType: string;
  readonly reason: JiraTemplateWithoutProposalReason;
}
/** A proposal run accounts for every issue type of the project (#4354). */
export interface JiraTemplateProposalRun {
  readonly proposals: readonly JiraTemplateProposal[];
  /** The first entries by name; the others are only counted in `withoutProposalMoreCount`. */
  readonly withoutProposal: readonly JiraTemplateWithoutProposal[];
  readonly withoutProposalMoreCount: number;
  readonly typeCount: number;
}

export type { JiraTemplateParseErrorCode } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

function request<T>(path: string, body?: unknown, correlationId?: string): Promise<T> {
  return codingAppSessionPairingSettled().then(() =>
    bffFetchJson<T>(
      path,
      {
        signal: AbortSignal.timeout(90_000),
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      },
      correlationId === undefined ? undefined : { correlationId },
    ),
  );
}

export async function fetchJiraTemplates(
  correlationId?: string,
): Promise<readonly JiraTemplateEntry[]> {
  return (
    await request<{ templates: readonly JiraTemplateEntry[] }>(
      "/api/skills/jira-templates",
      undefined,
      correlationId,
    )
  ).templates;
}

export function validateJiraTemplate(
  podId: string,
  markdown: string,
  correlationId?: string,
): Promise<JiraTemplateValidation> {
  return request("/api/skills/jira-templates/validate", { podId, markdown }, correlationId);
}

export function fetchJiraTemplateOptions(
  selection: JiraTemplateOptionsRequest,
  correlationId?: string,
): Promise<JiraTemplateOptions> {
  return request("/api/skills/jira-templates/options", selection, correlationId);
}

export async function proposeJiraTemplates(
  podId: string,
  projectKey: string,
  correlationId?: string,
): Promise<JiraTemplateProposalRun> {
  return request<JiraTemplateProposalRun>(
    "/api/skills/jira-templates/propose",
    { podId, projectKey },
    correlationId,
  );
}

export type { JiraTemplateBound };

/** Writes the ids of this Jira's issue types into the template as a new revision (#4354). */
export function bindJiraTemplate(
  podId: string,
  skillId: string,
  revision: number,
  correlationId?: string,
  migrate?: boolean,
): Promise<JiraTemplateBound> {
  return request(
    "/api/skills/jira-templates/bind",
    { podId, skillId, revision, ...(migrate === true ? { migrate } : {}) },
    correlationId,
  );
}
