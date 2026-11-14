import {
  createJiraReadRequest,
  jiraInstanceIdentity,
  proposeJiraIssueTemplates,
  readJiraTemplateInstanceMetadata,
  resolveJiraTemplateBinding,
  validateJiraIssueTemplateAgainstInstance,
} from "@oscharko-dev/keiko-connectors";
import {
  MARKDOWN_SKILL_LIMITS,
  type MarkdownSkillDocument,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  bindJiraIssueTemplateText,
  jiraTemplateForInstance,
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
  type JiraTemplateActivation,
  type JiraTemplateBinding,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import type { UiHandlerDeps } from "./deps.js";
import { findOwnedJiraPod, isReadyJiraPod } from "./atlassian/jiraPodAccess.js";
import { readMutation, withSkillAccess } from "./markdown-skill-routes.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { invalidRequest, notFound, UiStoreError } from "./store/errors.js";

/**
 * Jira Pod template settings (#4177): list the issue templates in the skill library, validate one
 * against the live instance, and propose a set from an existing project. Templates are ordinary
 * private skills, so import, edit, export and delete use the skill routes. These routes only read
 * Jira, through the Pod the caller owns, and never write to it or to the library.
 */
type TemplateRouteDeps = Pick<
  UiHandlerDeps,
  "store" | "codingAppSessionChannel" | "serverPrincipal" | "atlassianConnectorCredentials"
>;

const READ_TIMEOUT_MS = 60_000;
const BODY_BYTES = Math.ceil((MARKDOWN_SKILL_LIMITS.importBytes * 4) / 3) + 2048;

function activationLabel(activation: JiraTemplateActivation): string {
  return activation.kind === "transition" && activation.target !== undefined
    ? `transition:${activation.target}`
    : activation.kind;
}

function templateSummary(template: JiraIssueTemplate): {
  readonly project: string;
  readonly issueType: string;
  readonly activations: readonly string[];
} {
  return {
    project: template.project,
    issueType: template.issueType,
    activations: template.activations.map(activationLabel),
  };
}

export function handleListJiraTemplates(
  ctx: RouteContext,
  deps: TemplateRouteDeps,
): Promise<RouteResult> {
  return withSkillAccess(ctx, deps, "jira-template-list", () => ({
    status: 200,
    body: {
      templates: deps.store.markdownSkills.jiraTemplates().map(({ skill, template }) => ({
        id: skill.id,
        revision: skill.revision,
        name: skill.name,
        valid: template !== undefined,
        ...(template === undefined ? {} : templateSummary(template)),
      })),
    },
  }));
}

function readyPod(
  deps: TemplateRouteDeps,
  podId: unknown,
): NonNullable<ReturnType<typeof findOwnedJiraPod>> {
  const pod = typeof podId === "string" ? findOwnedJiraPod(deps, podId) : undefined;
  if (pod === undefined) throw notFound("Jira Pod");
  if (!isReadyJiraPod(pod)) {
    throw new UiStoreError("INVALID_REQUEST", "The Jira Pod is not ready.", 409);
  }
  return pod;
}

function podRequest(
  deps: TemplateRouteDeps,
  ctx: RouteContext,
  pod: ReturnType<typeof readyPod>,
): ReturnType<typeof createJiraReadRequest> {
  const factory = deps.atlassianConnectorCredentials?.httpBodyPortFactory;
  if (factory === undefined) throw notFound("Jira Pod");
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
  const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
  return createJiraReadRequest(
    {
      baseUrl: pod.baseUrl,
      deployment: pod.deployment,
      http: factory(pod, correlationId, { beforeDispatch: () => !signal.aborted }),
    },
    {
      invocationId: correlationId,
      correlationId,
      signal,
      beforeEffect: () => !signal.aborted,
    },
  );
}

function jiraReadFailure(reason: string): UiStoreError {
  return new UiStoreError(
    "INTERNAL",
    `Jira could not be read (${reason}). Check the Pod and try again.`,
    502,
  );
}

export function handleValidateJiraTemplate(
  ctx: RouteContext,
  deps: TemplateRouteDeps,
): Promise<RouteResult> {
  return withSkillAccess(ctx, deps, "jira-template-validate", async () => {
    const body = await readMutation(ctx, deps, BODY_BYTES);
    if (body.kind === "rejected") return body.response;
    const { markdown, podId } = body.value;
    if (typeof markdown !== "string") throw invalidRequest("Provide the template Markdown.");
    const parsed = parseJiraIssueTemplate(markdown);
    if (!parsed.ok) return { status: 200, body: { valid: false, errors: parsed.errors } };
    const pod = readyPod(deps, podId);
    const instanceId = jiraInstanceIdentity(pod.baseUrl);
    // A binding made for another Jira means nothing here: the typed names are what this Jira sees.
    const template = jiraTemplateForInstance(parsed.template, instanceId);
    const read = await readJiraTemplateInstanceMetadata(podRequest(deps, ctx, pod), template);
    if (!read.ok) throw jiraReadFailure(read.reason);
    return {
      status: 200,
      body: {
        valid: true,
        template: templateSummary(template),
        binding: resolveJiraTemplateBinding(template, read.instance, instanceId),
        findings: validateJiraIssueTemplateAgainstInstance(template, read.instance),
        checked: {
          project: read.instance.project !== undefined,
          fields: read.instance.fields !== undefined,
          linkTypes: read.instance.linkTypes !== undefined,
          transitions: read.instance.statuses !== undefined,
        },
      },
    };
  });
}

export function handleProposeJiraTemplates(
  ctx: RouteContext,
  deps: TemplateRouteDeps,
): Promise<RouteResult> {
  return withSkillAccess(ctx, deps, "jira-template-propose", async () => {
    const body = await readMutation(ctx, deps, 4096);
    if (body.kind === "rejected") return body.response;
    const { projectKey, podId } = body.value;
    if (typeof projectKey !== "string" || !/^[A-Za-z]\w{0,127}$/u.test(projectKey)) {
      throw invalidRequest("Provide a Jira project key.");
    }
    const pod = readyPod(deps, podId);
    const result = await proposeJiraIssueTemplates(
      podRequest(deps, ctx, pod),
      projectKey,
      jiraInstanceIdentity(pod.baseUrl),
    );
    if (!result.ok) {
      if (result.reason === "not-found") throw notFound("Jira project");
      throw jiraReadFailure(result.reason);
    }
    return { status: 200, body: { proposals: result.proposals } };
  });
}

const BIND_BODY_BYTES = 4096;
/** A file name the skill store accepts, derived from the skill's own display name. */
function skillFileName(name: string): string {
  const stem = name
    .replace(/[\\/:\p{Cc}]/gu, "-")
    .replace(/^\.+/u, "")
    .trim();
  return `${stem.length === 0 ? "template" : stem}.md`.slice(-MARKDOWN_SKILL_LIMITS.fileNameChars);
}
function refusedBinding(
  resolution: Extract<
    ReturnType<typeof resolveJiraTemplateBinding>,
    { state: "unresolved" | "ambiguous" }
  >,
): UiStoreError {
  const what =
    resolution.state === "ambiguous"
      ? `More than one issue type in this Jira is called "${resolution.subject}"`
      : `This Jira has no issue type called "${resolution.subject}" in your language`;
  return new UiStoreError(
    "INVALID_REQUEST",
    `${what}, so the template cannot be bound. Change the name in the template to a type you see in Jira, then check it again.`,
    422,
  );
}

/** The stored template the caller named, at the revision it named; a stale revision changes nothing. */
function bindTarget(
  deps: TemplateRouteDeps,
  skillId: unknown,
  revision: unknown,
): { readonly skill: MarkdownSkillDocument; readonly template: JiraIssueTemplate } {
  if (typeof skillId !== "string" || typeof revision !== "number")
    throw invalidRequest("Provide the template and its revision.");
  const skill = deps.store.markdownSkills.get(skillId);
  if (skill === undefined) throw notFound("Skill");
  if (skill.revision !== revision)
    throw new UiStoreError(
      "INVALID_REQUEST",
      "Skill revision is stale. Reload before changing it.",
      409,
    );
  const parsed = parseJiraIssueTemplate(skill.body);
  if (!parsed.ok) throw invalidRequest("This skill is not a valid Jira issue template.");
  return { skill, template: parsed.template };
}

/** The new skill revision that carries the binding, written through the skill store's own replace. */
function saveBinding(
  deps: TemplateRouteDeps,
  skill: MarkdownSkillDocument,
  binding: JiraTemplateBinding,
): MarkdownSkillDocument {
  const bound = bindJiraIssueTemplateText(skill.body, binding);
  if (bound === undefined) throw invalidRequest("This template cannot be bound.");
  return deps.store.markdownSkills.replace(skill.id, skill.revision, {
    fileName: skillFileName(skill.name),
    contentBase64: Buffer.from(bound, "utf8").toString("base64"),
  });
}

/**
 * Binds a stored template to the issue types of the Jira the caller chose (#4354): the typed names are
 * resolved in the caller's own view and the ids are written into the template's front matter as a new
 * skill revision, so the binding travels with an exported copy. It writes nothing to Jira.
 */
export function handleBindJiraTemplate(
  ctx: RouteContext,
  deps: TemplateRouteDeps,
): Promise<RouteResult> {
  return withSkillAccess(ctx, deps, "jira-template-bind", async () => {
    const body = await readMutation(ctx, deps, BIND_BODY_BYTES);
    if (body.kind === "rejected") return body.response;
    const { skill, template: stored } = bindTarget(deps, body.value.skillId, body.value.revision);
    const pod = readyPod(deps, body.value.podId);
    const instanceId = jiraInstanceIdentity(pod.baseUrl);
    const template = jiraTemplateForInstance(stored, instanceId);
    const read = await readJiraTemplateInstanceMetadata(podRequest(deps, ctx, pod), template);
    if (!read.ok) throw jiraReadFailure(read.reason);
    const resolution = resolveJiraTemplateBinding(template, read.instance, instanceId);
    if (resolution.state === "bound")
      return { status: 200, body: { changed: false, issueType: resolution.issueType } };
    if (resolution.state !== "bindable") throw refusedBinding(resolution);
    const saved = saveBinding(deps, skill, resolution.binding);
    return {
      status: 200,
      body: {
        changed: true,
        issueType: resolution.issueType,
        parentTypeCount: resolution.binding.parentIssueTypeIds?.length ?? 0,
        skill: { id: saved.id, revision: saved.revision },
      },
    };
  });
}
