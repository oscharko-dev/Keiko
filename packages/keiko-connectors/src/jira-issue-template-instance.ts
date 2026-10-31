import {
  normalizeJiraSectionHeading,
  parseJiraIssueTemplate,
  type AtlassianConnectorWriteFailureReason,
  type JiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import type {
  JiraFieldCatalogEntry,
  JiraTemplateInstanceMetadata,
} from "./jira-issue-template-check.js";
import {
  jiraCreateMutationMetadata,
  type JiraMutationRequest,
} from "./jira-managed-mutation-metadata.js";

/**
 * Read-only instance facts for the Jira Pod template settings (#4177): what a template is
 * validated against, and what a proposed template is derived from. Every request is a bounded GET
 * through the Pod's own transport; nothing here writes to Jira or to the template library.
 */
export type JiraTemplateInstanceRead<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly reason: AtlassianConnectorWriteFailureReason };

const MALFORMED = { ok: false, reason: "malformed-payload" } as const;
const FIELD_LIST_MAX = 5000;
const SAMPLE_SIZE = 25;
const ISSUE_TYPES_MAX = 12;
const SECTIONS_MAX = 8;
const ROUTING_FIELDS: ReadonlySet<string> = new Set([
  "project",
  "issuetype",
  "summary",
  "description",
  "reporter",
]);
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,127}$/u;
const MARKDOWN_HEADING = /^\s{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/u;
const WIKI_HEADING = /^\s*h[1-6]\.[ \t]+(.+?)[ \t]*$/u;

interface ProjectFacts {
  readonly id: string;
  readonly key: string;
  readonly issueTypes: readonly { readonly id: string; readonly name: string }[];
}

function projectFacts(body: Record<string, unknown> | undefined): ProjectFacts | undefined {
  const types = asArray(body?.issueTypes);
  if (
    body === undefined ||
    typeof body.id !== "string" ||
    typeof body.key !== "string" ||
    types === undefined
  )
    return undefined;
  const issueTypes = types.flatMap((item): readonly { id: string; name: string }[] => {
    const record = asRecord(item);
    return typeof record?.id === "string" && typeof record.name === "string"
      ? [{ id: record.id, name: record.name }]
      : [];
  });
  return { id: body.id, key: body.key, issueTypes };
}

async function readProject(
  request: JiraMutationRequest,
  projectKey: string,
): Promise<JiraTemplateInstanceRead<{ project: ProjectFacts | undefined }>> {
  if (!PROJECT_KEY.test(projectKey)) return { ok: true, project: undefined };
  const response = await request(`project/${encodeURIComponent(projectKey)}`);
  if (!response.ok) {
    return response.reason === "not-found" ? { ok: true, project: undefined } : response;
  }
  const project = projectFacts(response.body);
  return project === undefined ? MALFORMED : { ok: true, project };
}

async function readFieldCatalog(
  request: JiraMutationRequest,
): Promise<readonly JiraFieldCatalogEntry[] | undefined> {
  const response = await request("field", "GET", undefined, "json-array");
  const items = response.ok ? response.items : undefined;
  if (items === undefined || items.length > FIELD_LIST_MAX) return undefined;
  return items.flatMap((item): readonly JiraFieldCatalogEntry[] => {
    const record = asRecord(item);
    return typeof record?.id === "string" && typeof record.name === "string"
      ? [{ id: record.id, name: record.name }]
      : [];
  });
}

async function readLinkTypes(
  request: JiraMutationRequest,
): Promise<JiraTemplateInstanceMetadata["linkTypes"]> {
  const response = await request("issueLinkType");
  const types = response.ok ? asArray(response.body?.issueLinkTypes) : undefined;
  if (types === undefined || types.length > 1000) return undefined;
  return types.flatMap((item) => {
    const record = asRecord(item);
    if (typeof record?.name !== "string") return [];
    return [
      {
        name: record.name,
        ...(typeof record.inward === "string" ? { inward: record.inward } : {}),
        ...(typeof record.outward === "string" ? { outward: record.outward } : {}),
      },
    ];
  });
}

async function readStatuses(
  request: JiraMutationRequest,
  template: JiraIssueTemplate,
  project: ProjectFacts,
): Promise<readonly string[] | undefined> {
  const response = await request(
    `project/${encodeURIComponent(project.key)}/statuses`,
    "GET",
    undefined,
    "json-array",
  );
  const types = response.ok ? response.items : undefined;
  if (types === undefined || types.length > 200) return undefined;
  const wanted = project.issueTypes.find(
    (type) =>
      type.id === template.issueType ||
      type.name.toLowerCase() === template.issueType.toLowerCase(),
  );
  return statusNames(types, wanted?.id);
}

/** Status names of the wanted issue type's workflow, or of every type when it is unknown. */
function statusNames(types: readonly unknown[], wantedId: string | undefined): readonly string[] {
  const names = new Set<string>();
  for (const type of types) {
    const record = asRecord(type);
    if (wantedId !== undefined && record?.id !== wantedId) continue;
    for (const status of asArray(record?.statuses) ?? []) {
      const name = asRecord(status)?.name;
      if (typeof name === "string") names.add(name);
    }
  }
  return [...names];
}

/** The live facts one template is validated against; unreadable parts are left out, not guessed. */
export async function readJiraTemplateInstanceMetadata(
  request: JiraMutationRequest,
  template: JiraIssueTemplate,
): Promise<JiraTemplateInstanceRead<{ instance: JiraTemplateInstanceMetadata }>> {
  const read = await readProject(request, template.project);
  if (!read.ok) return read;
  const { project } = read;
  const fields = await readFieldCatalog(request);
  const linkTypes = await readLinkTypes(request);
  const statuses =
    project === undefined ? undefined : await readStatuses(request, template, project);
  return {
    ok: true,
    instance: {
      ...(fields === undefined ? {} : { fields }),
      ...(linkTypes === undefined ? {} : { linkTypes }),
      ...(statuses === undefined ? {} : { statuses }),
      ...(project === undefined
        ? {}
        : { project: { key: project.key, issueTypes: project.issueTypes } }),
    },
  };
}

function headingsOf(description: string): readonly string[] {
  const seen = new Map<string, string>();
  for (const line of description.replace(/\r\n?/gu, "\n").split("\n")) {
    const title = (MARKDOWN_HEADING.exec(line) ?? WIKI_HEADING.exec(line))?.[1];
    if (title === undefined) continue;
    const key = normalizeJiraSectionHeading(title);
    if (key.length > 0 && key.length <= 120 && !seen.has(key)) seen.set(key, title.trim());
  }
  return [...seen.values()];
}

/**
 * Description sections that most sampled issues share: a heading is proposed when at least half of
 * the descriptions that have any structure carry it. Pure and deterministic.
 */
export function deriveJiraTemplateSections(descriptions: readonly string[]): readonly string[] {
  const structured = descriptions.map(headingsOf).filter((headings) => headings.length > 0);
  if (structured.length < 2) return [];
  const counts = new Map<string, { title: string; count: number; first: number }>();
  structured.forEach((headings, sample) => {
    for (const title of headings) {
      const key = normalizeJiraSectionHeading(title);
      const entry = counts.get(key) ?? { title, count: 0, first: sample };
      counts.set(key, { ...entry, count: entry.count + 1 });
    }
  });
  const threshold = Math.ceil(structured.length / 2);
  return [...counts.values()]
    .filter((entry) => entry.count >= threshold)
    .sort((left, right) => right.count - left.count || left.first - right.first)
    .slice(0, SECTIONS_MAX)
    .map((entry) => entry.title);
}

function listItem(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 _./()+-]*$/u.test(value) ? value : JSON.stringify(value);
}

export interface JiraTemplateProposalInput {
  readonly projectKey: string;
  readonly issueType: string;
  readonly requiredFields: readonly string[];
  readonly sections: readonly string[];
}

/** The proposed template as Markdown the lead edits and saves; it always parses. */
export function renderProposedJiraIssueTemplate(input: JiraTemplateProposalInput): string {
  const front = [
    "---",
    "keiko: jira-issue-template",
    "version: 1",
    `project: ${input.projectKey.toUpperCase()}`,
    `issueType: ${listItem(input.issueType)}`,
    "activateOn: [create]",
    ...(input.requiredFields.length === 0
      ? []
      : [`requiredFields: [${input.requiredFields.map(listItem).join(", ")}]`]),
    "---",
  ];
  const sections = input.sections.flatMap((section) => [
    `## ${section.replace(/[\r\n]+/gu, " ")}`,
    "",
  ]);
  return [...front, `# ${input.issueType} template`, "", ...sections].join("\n").trimEnd() + "\n";
}

async function requiredCreateFields(
  request: JiraMutationRequest,
  project: ProjectFacts,
  issueTypeId: string,
): Promise<readonly string[]> {
  const metadata = await jiraCreateMutationMetadata(request, project.id, issueTypeId);
  if (!metadata.ok) return [];
  return metadata.fields
    .filter((field) => field.required && !field.hasDefaultValue && !ROUTING_FIELDS.has(field.id))
    .map((field) => field.name);
}

async function sampledDescriptions(
  request: JiraMutationRequest,
  project: ProjectFacts,
  issueTypeId: string,
): Promise<readonly string[]> {
  const jql = `project = "${project.key}" AND issuetype = ${issueTypeId} ORDER BY created DESC`;
  const query = new URLSearchParams({
    jql,
    fields: "description",
    maxResults: String(SAMPLE_SIZE),
  });
  const response = await request(`search?${query.toString()}`);
  const issues = response.ok ? asArray(response.body?.issues) : undefined;
  return (issues ?? []).flatMap((issue): readonly string[] => {
    const description = asRecord(asRecord(issue)?.fields)?.description;
    return typeof description === "string" ? [description] : [];
  });
}

export interface JiraTemplateProposal {
  readonly issueType: string;
  readonly markdown: string;
  readonly sampledIssueCount: number;
}

async function proposalFor(
  request: JiraMutationRequest,
  project: ProjectFacts,
  type: { readonly id: string; readonly name: string },
): Promise<JiraTemplateProposal | undefined> {
  const [requiredFields, descriptions] = await Promise.all([
    requiredCreateFields(request, project, type.id),
    sampledDescriptions(request, project, type.id),
  ]);
  const sections = deriveJiraTemplateSections(descriptions);
  if (requiredFields.length === 0 && sections.length === 0) return undefined;
  const markdown = renderProposedJiraIssueTemplate({
    projectKey: project.key,
    issueType: type.name,
    requiredFields,
    sections,
  });
  return parseJiraIssueTemplate(markdown).ok
    ? { issueType: type.name, markdown, sampledIssueCount: descriptions.length }
    : undefined;
}

/**
 * Drafts one template per issue type of an existing project from its create metadata and a small
 * sample of its issues. Deterministic and read-only: the lead edits and saves what is proposed.
 */
export async function proposeJiraIssueTemplates(
  request: JiraMutationRequest,
  projectKey: string,
): Promise<JiraTemplateInstanceRead<{ proposals: readonly JiraTemplateProposal[] }>> {
  const read = await readProject(request, projectKey);
  if (!read.ok) return read;
  if (read.project === undefined) return { ok: false, reason: "not-found" };
  const { project } = read;
  const proposals = await Promise.all(
    project.issueTypes.slice(0, ISSUE_TYPES_MAX).map((type) => proposalFor(request, project, type)),
  );
  return {
    ok: true,
    proposals: proposals.filter(
      (proposal): proposal is JiraTemplateProposal => proposal !== undefined,
    ),
  };
}
