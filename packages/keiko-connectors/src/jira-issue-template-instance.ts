import {
  jiraTemplateIssueTypeMatches,
  normalizeJiraSectionHeading,
  parseJiraIssueTemplate,
  readJiraDescriptionSections,
  type AtlassianConnectorWriteFailureReason,
  type JiraIssueTemplate,
  JIRA_BINDING_UNRESOLVED,
  jiraTemplateBindingDigest,
  jiraTemplateTransitionTargets,
  type JiraTemplateBinding,
  type JiraTemplateBindingIds,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  JiraTemplateOptions,
  JiraTemplateOptionsRequest,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import {
  resolveJiraTemplateFieldIds,
  type JiraFieldCatalogEntry,
  type JiraTemplateInstanceMetadata,
} from "./jira-issue-template-check.js";
import {
  jiraCreateMutationMetadata,
  type JiraMutationRequest,
} from "./jira-managed-mutation-metadata.js";
import {
  mergeJiraTemplateFieldCatalogs,
  readJiraFieldCatalog,
} from "./jira-managed-template-gate.js";
import { jiraTemplateNativeIssueType } from "./jira-template-parent-types.js";
import { jiraProjectDirectory } from "./jira-managed-metadata.js";
import { jiraNativeId, jiraNativeName } from "./jira-native-values.js";

/**
 * Read-only instance facts for the Jira Pod template settings (#4177): what a template is
 * validated against, and what a proposed template is derived from. Every request is a bounded GET
 * through the Pod's own transport; nothing here writes to Jira or to the template library.
 */
export type JiraTemplateInstanceRead<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly reason: AtlassianConnectorWriteFailureReason };

const MALFORMED = { ok: false, reason: "malformed-payload" } as const;
const SAMPLE_SIZE = 25;
const LINK_TYPES_MAX = 1000;
const ISSUE_TYPES_MAX = 12;
const SECTIONS_MAX = 8;
const ROUTING_FIELDS: ReadonlySet<string> = new Set([
  "project",
  "issuetype",
  "summary",
  "description",
  "reporter",
]);
const PROJECT_KEY = /^[A-Za-z]\w{0,127}$/u;

interface ProjectFacts {
  readonly id: string;
  readonly key: string;
  readonly issueTypes: readonly {
    readonly id: string;
    readonly name: string;
    readonly subtask?: boolean;
  }[];
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
  const issueTypes = types.flatMap(
    (item): readonly { id: string; name: string; subtask?: boolean }[] => {
      const record = asRecord(item);
      return typeof record?.id === "string" && typeof record.name === "string"
        ? [
            {
              id: record.id,
              name: record.name,
              ...(typeof record.subtask === "boolean" ? { subtask: record.subtask } : {}),
            },
          ]
        : [];
    },
  );
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

async function readLinkTypes(
  request: JiraMutationRequest,
): Promise<
  JiraTemplateInstanceRead<{ readonly linkTypes: JiraTemplateInstanceMetadata["linkTypes"] }>
> {
  const response = await request("issueLinkType");
  const types = response.ok ? asArray(response.body?.issueLinkTypes) : undefined;
  if (types === undefined) return { ok: true, linkTypes: undefined };
  if (types.length > LINK_TYPES_MAX) return { ok: false, reason: "bounds-exceeded" };
  const linkTypes = types.flatMap((item) => {
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
  return { ok: true, linkTypes };
}

interface ProjectStatuses {
  readonly names: readonly string[];
  readonly refs: readonly { readonly id: string; readonly name: string }[];
  /** Whether Jira listed the wanted workflow (any workflow when no type is wanted); an empty list is not that. */
  readonly listed: boolean;
}

async function readStatuses(
  request: JiraMutationRequest,
  projectKey: string,
  issueTypeId: string | undefined,
): Promise<ProjectStatuses | undefined> {
  const response = await request(
    `project/${encodeURIComponent(projectKey)}/statuses`,
    "GET",
    undefined,
    "json-array",
  );
  const types = response.ok ? response.items : undefined;
  if (types === undefined || types.length > 200) return undefined;
  return statusesOf(types, issueTypeId);
}

/** The id and name of one status entry; an entry without an id is no status a rule can be bound to. */
function statusRef(value: unknown): { readonly id: string; readonly name: string } | undefined {
  const entry = asRecord(value);
  return typeof entry?.id === "string" && typeof entry.name === "string"
    ? { id: entry.id, name: entry.name }
    : undefined;
}

/** Names and id-bearing refs of the statuses of one issue type's workflow entry. */
function statusesOfType(record: Record<string, unknown> | undefined): {
  readonly names: readonly string[];
  readonly refs: readonly { readonly id: string; readonly name: string }[];
} {
  const entries = asArray(record?.statuses) ?? [];
  return {
    names: entries.flatMap((status) => {
      const name = asRecord(status)?.name;
      return typeof name === "string" ? [name] : [];
    }),
    refs: entries.flatMap((status) => statusRef(status) ?? []),
  };
}

/** Status names and ids of the wanted issue type's workflow, or of every type when it is unknown. */
function statusesOf(types: readonly unknown[], wantedId: string | undefined): ProjectStatuses {
  const refs = new Map<string, { id: string; name: string }>();
  const names = new Set<string>();
  let listed = wantedId === undefined;
  for (const type of types) {
    const record = asRecord(type);
    if (wantedId !== undefined && record?.id !== wantedId) continue;
    if (asArray(record?.statuses) !== undefined) listed = true;
    const found = statusesOfType(record);
    for (const name of found.names) names.add(name);
    for (const ref of found.refs) refs.set(ref.id, ref);
  }
  return { names: [...names], refs: [...refs.values()], listed };
}

async function readParentIssueTypes(request: JiraMutationRequest): Promise<
  JiraTemplateInstanceRead<{
    readonly types: readonly { readonly id: string; readonly name: string }[];
  }>
> {
  const response = await request("issuetype", "GET", undefined, "json-array");
  if (!response.ok) return response;
  if (response.status !== 200 || response.items === undefined) return MALFORMED;
  if (response.items.length > 1000) return { ok: false, reason: "bounds-exceeded" };
  const types: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const item of response.items) {
    const type = jiraTemplateNativeIssueType(item);
    if (type === undefined) return MALFORMED;
    if (seen.has(type.id)) return MALFORMED;
    seen.add(type.id);
    types.push({ id: type.id, name: type.name });
  }
  return { ok: true, types } as const;
}

function readParentTypesIfRequired(
  request: JiraMutationRequest,
  template: JiraIssueTemplate,
): Promise<Awaited<ReturnType<typeof readParentIssueTypes>> | undefined> {
  return template.parent.issueTypes === undefined
    ? Promise.resolve(undefined)
    : readParentIssueTypes(request);
}
function readStatusesIfProject(
  request: JiraMutationRequest,
  template: JiraIssueTemplate,
  project: ProjectFacts | undefined,
): Promise<ProjectStatuses | undefined> {
  if (project === undefined) return Promise.resolve(undefined);
  const wanted = project.issueTypes.find((type) => jiraTemplateIssueTypeMatches(template, type));
  return readStatuses(request, project.key, wanted?.id);
}

type OptionsRead = JiraTemplateInstanceRead<{ readonly options: JiraTemplateOptions }>;

async function readTemplateProjects(request: JiraMutationRequest): Promise<OptionsRead> {
  const response = await request("project", "GET", undefined, "json-array");
  if (!response.ok) return response;
  const directory = jiraProjectDirectory(response.items);
  if (!directory.ok) return directory;
  // The editor asks for a project's types by its upper-cased key: keys that differ only by case would
  // load one project's types under the other's name, so neither is offered.
  const keyed = directory.projects.filter(({ key }) => PROJECT_KEY.test(key));
  const keyCounts = new Map<string, number>();
  for (const { key } of keyed)
    keyCounts.set(key.toUpperCase(), (keyCounts.get(key.toUpperCase()) ?? 0) + 1);
  const projects = keyed
    .filter(({ key, name }) => keyCounts.get(key.toUpperCase()) === 1 && jiraNativeName(name, 255))
    .map(({ key, name }) => ({ key, name }));
  return { ok: true, options: { kind: "projects", projects } };
}

async function readTemplateTypeDetails(
  request: JiraMutationRequest,
  project: ProjectFacts,
  issueTypeId: string,
): Promise<OptionsRead> {
  // The one native id rule, before any detail read: an id the picker never offers asks Jira nothing.
  if (!jiraNativeId(issueTypeId) || !project.issueTypes.some((type) => type.id === issueTypeId))
    return { ok: false, reason: "not-found" };
  const [metadata, statuses] = await Promise.all([
    jiraCreateMutationMetadata(request, encodeURIComponent(project.id), issueTypeId),
    readStatuses(request, project.key, issueTypeId),
  ]);
  const fields = metadata.ok
    ? metadata.fields
        .filter(
          (field) =>
            field.id !== "project" &&
            field.id !== "issuetype" &&
            field.kind !== "unsupported" &&
            field.operations.includes("set"),
        )
        .map(({ id, name, required }) => ({ id, name, required }))
    : undefined;
  return {
    ok: true,
    options: {
      kind: "details",
      ...(fields === undefined ? {} : { fields }),
      // A workflow Jira did not list is unknown, not empty: omitted, so the editor says so.
      ...(statuses?.listed === true ? { statuses: statuses.refs } : {}),
    },
  };
}

/** The same project facts used by validation and binding feed the guided editor. */
export async function readJiraTemplateOptions(
  request: JiraMutationRequest,
  selection: Pick<JiraTemplateOptionsRequest, "projectKey" | "issueTypeId">,
  instanceId: string,
): Promise<OptionsRead> {
  const { projectKey, issueTypeId } = selection;
  if (projectKey === undefined) return readTemplateProjects(request);
  const result = await readProject(request, projectKey);
  if (!result.ok) return result;
  const { project } = result;
  if (project === undefined) return { ok: false, reason: "not-found" };
  if (project.key.toUpperCase() !== projectKey.toUpperCase() || !jiraNativeId(project.id))
    return MALFORMED;
  if (issueTypeId !== undefined) return readTemplateTypeDetails(request, project, issueTypeId);
  const issueTypes = project.issueTypes
    .filter((type) => jiraNativeId(type.id) && jiraNativeName(type.name, 255))
    .map(({ id, name }) => ({ id, name }));
  return { ok: true, options: { kind: "types", issueTypes, instanceId } };
}

/** Resolve names missing from GET field against the selected type's create metadata, just as the
 * write gate does. Data Center exposes the localized parent name only there (#4390). A failed
 * supplemental read cannot prove that a field does not exist. */
async function readTemplateFields(
  request: JiraMutationRequest,
  template: JiraIssueTemplate,
  project: ProjectFacts | undefined,
): Promise<readonly JiraFieldCatalogEntry[] | undefined> {
  const fields = await readJiraFieldCatalog(request);
  if (fields === undefined || project === undefined) return fields;
  const references = [
    ...template.requiredFields,
    ...(template.parent.field === undefined ? [] : [template.parent.field]),
  ];
  if (
    references.every(
      (reference) => resolveJiraTemplateFieldIds(reference, fields, template).length > 0,
    )
  )
    return fields;
  const types = project.issueTypes.filter((type) => jiraTemplateIssueTypeMatches(template, type));
  const [type] = types;
  if (types.length !== 1 || type === undefined) return fields;
  const metadata = await jiraCreateMutationMetadata(
    request,
    encodeURIComponent(project.id),
    encodeURIComponent(type.id),
  );
  return metadata.ok ? mergeJiraTemplateFieldCatalogs(fields, metadata.fields) : undefined;
}

/** The live facts one template is validated against; unreadable parts are left out, not guessed. */
export async function readJiraTemplateInstanceMetadata(
  request: JiraMutationRequest,
  template: JiraIssueTemplate,
): Promise<JiraTemplateInstanceRead<{ instance: JiraTemplateInstanceMetadata }>> {
  const read = await readProject(request, template.project);
  if (!read.ok) return read;
  const { project } = read;
  const parentTypes = await readParentTypesIfRequired(request, template);
  if (parentTypes !== undefined && !parentTypes.ok) return parentTypes;
  const fields = await readTemplateFields(request, template, project);
  const links = await readLinkTypes(request);
  if (!links.ok) return links;
  const { linkTypes } = links;
  const statuses = await readStatusesIfProject(request, template, project);
  return {
    ok: true,
    instance: {
      ...(fields === undefined ? {} : { fields }),
      ...(linkTypes === undefined ? {} : { linkTypes }),
      ...(statuses === undefined ? {} : { statuses: statuses.names, statusRefs: statuses.refs }),
      ...(parentTypes === undefined ? {} : { parentIssueTypes: parentTypes.types }),
      ...(project === undefined
        ? {}
        : { project: { key: project.key, issueTypes: project.issueTypes } }),
    },
  };
}

function headingsOf(description: string): readonly string[] {
  const seen = new Map<string, string>();
  for (const { title } of readJiraDescriptionSections(description, "jira-wiki")) {
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

/** What one read of a type's facts gave: the facts, or that Jira did not answer (#4354). */
type Read<T> = { readonly facts: T } | "unavailable";

async function requiredCreateFields(
  request: JiraMutationRequest,
  project: ProjectFacts,
  issueTypeId: string,
): Promise<Read<readonly string[]>> {
  const metadata = await jiraCreateMutationMetadata(request, project.id, issueTypeId);
  if (!metadata.ok) return "unavailable";
  return {
    facts: metadata.fields
      .filter((field) => field.required && !field.hasDefaultValue && !ROUTING_FIELDS.has(field.id))
      .map((field) => field.name),
  };
}

async function sampledDescriptions(
  request: JiraMutationRequest,
  project: ProjectFacts,
  issueTypeId: string,
): Promise<Read<readonly string[]>> {
  const jql = `project = "${project.key}" AND issuetype = ${issueTypeId} ORDER BY created DESC`;
  const query = new URLSearchParams({
    jql,
    fields: "description",
    maxResults: String(SAMPLE_SIZE),
  });
  const response = await request(`search?${query.toString()}`);
  const issues = response.ok ? asArray(response.body?.issues) : undefined;
  if (issues === undefined) return "unavailable";
  return {
    facts: issues.flatMap((issue): readonly string[] => {
      const description = asRecord(asRecord(issue)?.fields)?.description;
      return typeof description === "string" ? [description] : [];
    }),
  };
}

/**
 * Which read Jira did not answer for a proposal that was kept anyway (#4354): the template then
 * misses what that read would have given, and the person must check it before saving. Both reads
 * failing leaves nothing to propose, so there are exactly two words.
 */
export type JiraTemplateProposalPartial = "required-fields-unavailable" | "samples-unavailable";

export interface JiraTemplateProposal {
  readonly issueType: string;
  readonly markdown: string;
  readonly sampledIssueCount: number;
  readonly partial?: JiraTemplateProposalPartial;
}

/** Why a type has no proposal: a closed reason a person can act on (#4354). */
export type JiraTemplateWithoutProposalReason =
  "nothing-to-learn" | "template-invalid" | "jira-unavailable" | "beyond-limit";
export interface JiraTemplateWithoutProposal {
  readonly issueType: string;
  readonly reason: JiraTemplateWithoutProposalReason;
}
const TYPE_NAME_MAX = 255;
/** A type name as Jira states it, on one line and bounded; the person reads it in a count line. */
function typeLabel(name: string): string {
  return name.replace(/[\r\n]+/gu, " ").slice(0, TYPE_NAME_MAX);
}

type ProposalOutcome =
  { readonly proposal: JiraTemplateProposal } | { readonly without: JiraTemplateWithoutProposal };

async function proposalFor(
  request: JiraMutationRequest,
  project: ProjectFacts,
  type: { readonly id: string; readonly name: string },
): Promise<ProposalOutcome> {
  const label = typeLabel(type.name);
  const [fields, samples] = await Promise.all([
    requiredCreateFields(request, project, type.id),
    sampledDescriptions(request, project, type.id),
  ]);
  const requiredFields = fields === "unavailable" ? [] : fields.facts;
  const descriptions = samples === "unavailable" ? [] : samples.facts;
  const sections = deriveJiraTemplateSections(descriptions);
  if (requiredFields.length === 0 && sections.length === 0) {
    // A failed read is not "nothing to learn": Jira did not tell, so the lead can try again.
    const reason =
      fields === "unavailable" || samples === "unavailable"
        ? "jira-unavailable"
        : "nothing-to-learn";
    return { without: { issueType: label, reason } };
  }
  const markdown = renderProposedJiraIssueTemplate({
    projectKey: project.key,
    issueType: type.name,
    requiredFields,
    sections,
  });
  const partial = partialOf(fields, samples);
  return parseJiraIssueTemplate(markdown).ok
    ? {
        proposal: {
          issueType: type.name,
          markdown,
          sampledIssueCount: descriptions.length,
          ...(partial === undefined ? {} : { partial }),
        },
      }
    : { without: { issueType: label, reason: "template-invalid" } };
}

function partialOf(
  fields: Read<readonly string[]>,
  samples: Read<readonly string[]>,
): JiraTemplateProposalPartial | undefined {
  if (fields === "unavailable") return "required-fields-unavailable";
  return samples === "unavailable" ? "samples-unavailable" : undefined;
}

/** The most entries without a proposal a response lists by name; the rest is only counted. */
export const JIRA_TEMPLATE_WITHOUT_PROPOSAL_LISTED_MAX = 20;

/**
 * Bounds the list of types without a proposal for a response (a project may have very many types):
 * the first entries by name and the exact number of the others, so a person reads "and N more".
 */
export function boundJiraTemplateWithoutProposal(entries: readonly JiraTemplateWithoutProposal[]): {
  readonly listed: readonly JiraTemplateWithoutProposal[];
  readonly moreCount: number;
} {
  const listed = entries.slice(0, JIRA_TEMPLATE_WITHOUT_PROPOSAL_LISTED_MAX);
  return { listed, moreCount: entries.length - listed.length };
}

/**
 * Drafts one template per issue type of an existing project from its create metadata and a small
 * sample of its issues. Deterministic and read-only: the lead edits and saves what is proposed. Every
 * issue type of the project is accounted for: a proposal, or one closed reason why there is none, and
 * `typeCount` is the number of types the project has (#4354).
 */
export async function proposeJiraIssueTemplates(
  request: JiraMutationRequest,
  projectKey: string,
): Promise<
  JiraTemplateInstanceRead<{
    proposals: readonly JiraTemplateProposal[];
    withoutProposal: readonly JiraTemplateWithoutProposal[];
    typeCount: number;
  }>
> {
  const read = await readProject(request, projectKey);
  if (!read.ok) return read;
  if (read.project === undefined) return { ok: false, reason: "not-found" };
  const { project } = read;
  const outcomes = await Promise.all(
    project.issueTypes.slice(0, ISSUE_TYPES_MAX).map((type) => proposalFor(request, project, type)),
  );
  const beyondLimit = project.issueTypes
    .slice(ISSUE_TYPES_MAX)
    .map((type): JiraTemplateWithoutProposal => ({
      issueType: typeLabel(type.name),
      reason: "beyond-limit",
    }));
  return {
    ok: true,
    proposals: outcomes.flatMap((outcome) => ("proposal" in outcome ? [outcome.proposal] : [])),
    withoutProposal: [
      ...outcomes.flatMap((outcome) => ("without" in outcome ? [outcome.without] : [])),
      ...beyondLimit,
    ],
    typeCount: project.issueTypes.length,
  };
}

/** What the acting person's own view of the Jira says about one template's issue-type names. */
export type JiraTemplateBindingResolution =
  | { readonly state: "bound"; readonly issueType: string }
  | {
      readonly state: "bindable";
      readonly issueType: string;
      readonly binding: JiraTemplateBinding;
    }
  | { readonly state: "unresolved" | "ambiguous"; readonly subject: string }
  /**
   * Bound for this Jira, but its bound issue type is no type of the project any more and the typed
   * name finds none either: the template governs nothing and blocks nothing (#4354).
   */
  | { readonly state: "dead"; readonly subject: string };

function namedTypes<T extends { readonly id: string; readonly name: string }>(
  types: readonly T[],
  typed: string,
): readonly T[] {
  const wanted = typed.trim().toLowerCase();
  return types.filter((type) => type.id === typed || type.name.trim().toLowerCase() === wanted);
}

type Pick1<T> =
  { readonly found: T } | { readonly state: "unresolved" | "ambiguous"; readonly subject: string };
function exactlyOne<T extends { readonly id: string; readonly name: string }>(
  types: readonly T[],
  typed: string,
): Pick1<T> {
  const found = namedTypes(types, typed);
  const [only] = found;
  if (found.length === 1 && only !== undefined) return { found: only };
  return { state: found.length === 0 ? "unresolved" : "ambiguous", subject: typed.slice(0, 120) };
}

/**
 * Resolves a template's typed issue type and parent types, in the view the metadata was read with, to
 * ids. Exactly one type per name or no binding: none or two types of that name never bind (#4354). A
 * template already bound for this Jira whose ids all still exist needs nothing.
 */
export function resolveJiraTemplateBinding(
  template: JiraIssueTemplate,
  instance: JiraTemplateInstanceMetadata,
  instanceId: string,
): JiraTemplateBindingResolution {
  const types = instance.project?.issueTypes;
  if (types === undefined) return { state: "unresolved", subject: template.project };
  const current = currentBinding(template, types, instance);
  if (current !== undefined) {
    const binding = completedFieldBinding(template, instance.fields, instanceId);
    return binding === undefined
      ? { state: "bound", issueType: current }
      : { state: "bindable", issueType: current, binding };
  }
  // A binding that no longer finds its ids is resolved again from the typed names.
  const own = exactlyOne(types, template.issueType);
  if (!("found" in own)) return unresolvedOrDead(template, own);
  const parents = parentTypeIds(template, instance.parentIssueTypes ?? []);
  if ("state" in parents) return parents;
  const ids: JiraTemplateBindingIds = {
    issueTypeId: own.found.id,
    ...(template.parent.issueTypes === undefined ? {} : { parentIssueTypeIds: parents }),
    ...boundFieldIds(template, instance.fields),
    ...boundStatusIds(template, instance.statusRefs),
  };
  return {
    state: "bindable",
    issueType: own.found.name,
    binding: { digest: jiraTemplateBindingDigest(instanceId, template, ids), ...ids },
  };
}

function oneFieldId(
  catalog: readonly JiraFieldCatalogEntry[] | undefined,
  reference: string,
): string {
  const ids = catalog === undefined ? [] : resolveJiraTemplateFieldIds(reference, catalog);
  return ids.length === 1 && ids[0] !== undefined ? ids[0] : JIRA_BINDING_UNRESOLVED;
}

/** Fill previously unresolved field slots without rebinding an existing id by a translated name. */
function completedFieldBinding(
  template: JiraIssueTemplate,
  catalog: readonly JiraFieldCatalogEntry[] | undefined,
  instanceId: string,
): JiraTemplateBinding | undefined {
  const bound = template.binding;
  if (bound === undefined || catalog === undefined) return undefined;
  const complete = (reference: string, existing: string | undefined): string => {
    if (existing !== undefined && existing !== JIRA_BINDING_UNRESOLVED) return existing;
    return oneFieldId(catalog, reference);
  };
  const ids: JiraTemplateBindingIds = {
    ...bound,
    ...(template.requiredFields.length === 0
      ? {}
      : {
          requiredFieldIds: template.requiredFields.map((field, index) =>
            complete(field, bound.requiredFieldIds?.[index]),
          ),
        }),
    ...(template.parent.field === undefined
      ? {}
      : {
          parentFieldId: complete(template.parent.field, bound.parentFieldId),
        }),
  };
  const changed =
    ids.parentFieldId !== bound.parentFieldId ||
    ids.requiredFieldIds?.some((id, index) => id !== bound.requiredFieldIds?.[index]) === true;
  return changed
    ? { ...ids, digest: jiraTemplateBindingDigest(instanceId, template, ids) }
    : undefined;
}

/** The field ids of the typed references in the author's view; a name that is not exactly one field stays `none`. */
function boundFieldIds(
  template: JiraIssueTemplate,
  catalog: readonly JiraFieldCatalogEntry[] | undefined,
): Pick<JiraTemplateBindingIds, "requiredFieldIds" | "parentFieldId"> {
  return {
    ...(template.requiredFields.length === 0
      ? {}
      : { requiredFieldIds: template.requiredFields.map((field) => oneFieldId(catalog, field)) }),
    ...(template.parent.field === undefined
      ? {}
      : { parentFieldId: oneFieldId(catalog, template.parent.field) }),
  };
}

/** The status id of each typed transition target that is a status name in the author's view. */
function boundStatusIds(
  template: JiraIssueTemplate,
  statuses: readonly TypeRef[] | undefined,
): Pick<JiraTemplateBindingIds, "transitionStatusIds"> {
  const targets = jiraTemplateTransitionTargets(template);
  if (targets.length === 0) return {};
  return {
    transitionStatusIds: targets.map((target) => {
      const found = exactlyOne(statuses ?? [], target);
      return "found" in found &&
        found.found.name.trim().toLowerCase() === target.trim().toLowerCase()
        ? found.found.id
        : JIRA_BINDING_UNRESOLVED;
    }),
  };
}

/** A bound template whose typed name finds no type either is dead; any other miss is what it says. */
function unresolvedOrDead(
  template: JiraIssueTemplate,
  own: Extract<JiraTemplateBindingResolution, { state: "unresolved" | "ambiguous" }>,
): JiraTemplateBindingResolution {
  return template.binding !== undefined && own.state === "unresolved"
    ? { state: "dead", subject: own.subject }
    : own;
}

interface TypeRef {
  readonly id: string;
  readonly name: string;
}
/** Whether every bound id of a list still exists in the view the metadata was read with (unread views confirm nothing wrong). */
function allKnown(
  bound: readonly string[] | undefined,
  known: readonly string[] | undefined,
): boolean {
  return (
    known === undefined ||
    (bound ?? []).every((id) => id === JIRA_BINDING_UNRESOLVED || known.includes(id))
  );
}

/** Whether the bound field and status ids still exist in this view. */
function boundIdsExist(
  bound: JiraTemplateBinding,
  instance: JiraTemplateInstanceMetadata,
): boolean {
  const fieldIds = [
    ...(bound.requiredFieldIds ?? []),
    ...(bound.parentFieldId === undefined ? [] : [bound.parentFieldId]),
  ];
  return (
    allKnown(
      fieldIds,
      instance.fields?.map((field) => field.id),
    ) &&
    allKnown(
      bound.transitionStatusIds,
      instance.statusRefs?.map((status) => status.id),
    )
  );
}

/** The name of the issue type a binding still finds, when every id it carries still exists. */
function currentBinding(
  template: JiraIssueTemplate,
  types: readonly TypeRef[],
  instance: JiraTemplateInstanceMetadata,
): string | undefined {
  const bound = template.binding;
  if (bound === undefined) return undefined;
  const type = types.find((candidate) => candidate.id === bound.issueTypeId);
  const parents = instance.parentIssueTypes ?? [];
  const parentsKnown = (bound.parentIssueTypeIds ?? []).every((id) =>
    parents.some((parent) => parent.id === id),
  );
  return parentsKnown && boundIdsExist(bound, instance) ? type?.name : undefined;
}
/** The ids of the typed parent types, or the first name that is not exactly one type. */
function parentTypeIds(
  template: JiraIssueTemplate,
  parents: readonly TypeRef[],
):
  | readonly string[]
  | Extract<JiraTemplateBindingResolution, { state: "unresolved" | "ambiguous" }> {
  const ids: string[] = [];
  for (const typed of template.parent.issueTypes ?? []) {
    const parent = exactlyOne(parents, typed);
    if (!("found" in parent)) return parent;
    ids.push(parent.found.id);
  }
  return ids;
}
