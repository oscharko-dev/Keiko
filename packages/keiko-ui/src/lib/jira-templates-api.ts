"use client";

import type { JiraTemplateParseError } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
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

export interface JiraTemplateProposal {
  readonly issueType: string;
  readonly markdown: string;
  readonly sampledIssueCount: number;
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

export async function proposeJiraTemplates(
  podId: string,
  projectKey: string,
  correlationId?: string,
): Promise<readonly JiraTemplateProposal[]> {
  return (
    await request<{ proposals: readonly JiraTemplateProposal[] }>(
      "/api/skills/jira-templates/propose",
      { podId, projectKey },
      correlationId,
    )
  ).proposals;
}

/** What binding a template to this Jira did: the issue type it now names by id. */
export interface JiraTemplateBound {
  readonly changed: boolean;
  readonly issueType: string;
  readonly parentTypeCount?: number;
}

/** Writes the ids of this Jira's issue types into the template as a new revision (#4354). */
export function bindJiraTemplate(
  podId: string,
  skillId: string,
  revision: number,
  correlationId?: string,
): Promise<JiraTemplateBound> {
  return request("/api/skills/jira-templates/bind", { podId, skillId, revision }, correlationId);
}
