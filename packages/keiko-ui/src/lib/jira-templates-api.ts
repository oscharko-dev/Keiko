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
] as const;
export type JiraTemplateFindingCode = (typeof JIRA_TEMPLATE_FINDING_CODES)[number];

export interface JiraTemplateFinding {
  readonly code: JiraTemplateFindingCode;
  readonly subject: string;
}

export type JiraTemplateValidation =
  | { readonly valid: false; readonly errors: readonly JiraTemplateParseError[] }
  | {
      readonly valid: true;
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

function request<T>(path: string, body?: unknown): Promise<T> {
  return codingAppSessionPairingSettled().then(() =>
    bffFetchJson<T>(path, {
      signal: AbortSignal.timeout(90_000),
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    }),
  );
}

export async function fetchJiraTemplates(): Promise<readonly JiraTemplateEntry[]> {
  return (await request<{ templates: readonly JiraTemplateEntry[] }>("/api/skills/jira-templates"))
    .templates;
}

export function validateJiraTemplate(
  podId: string,
  markdown: string,
): Promise<JiraTemplateValidation> {
  return request("/api/skills/jira-templates/validate", { podId, markdown });
}

export async function proposeJiraTemplates(
  podId: string,
  projectKey: string,
): Promise<readonly JiraTemplateProposal[]> {
  return (
    await request<{ proposals: readonly JiraTemplateProposal[] }>(
      "/api/skills/jira-templates/propose",
      { podId, projectKey },
    )
  ).proposals;
}
