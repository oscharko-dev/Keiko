import {
  createJiraReadRequest,
  boundJiraTemplateWithoutProposal,
  jiraInstanceIdentity,
  proposeJiraIssueTemplates,
  readJiraTemplateInstanceMetadata,
  readJiraTemplateOptions,
  resolveJiraTemplateBinding,
  validateJiraIssueTemplateAgainstInstance,
} from "@oscharko-dev/keiko-connectors";
import {
  MARKDOWN_SKILL_LIMITS,
  type JiraTemplateBound,
  type JiraTemplateOptionsRequest,
  type MarkdownSkillDocument,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  bindJiraIssueTemplateText,
  isJiraNativeId,
  jiraIssueTemplateLabel,
  jiraTemplateForInstance,
  jiraTemplateGovernsWrites,
  jiraTemplatesShareIssueType,
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
  type JiraTemplateActivation,
  type JiraTemplateBinding,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { resolveAppSessionReadAuthority } from "./coding-app-session/appSessionReadAuthority.js";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import type { UiHandlerDeps } from "./deps.js";
import { findOwnedJiraPod, isReadyJiraPod, listOwnedJiraPods } from "./atlassian/jiraPodAccess.js";
import { readMutation, withSkillAccess } from "./markdown-skill-routes.js";
import type {
  MarkdownSkillProposalAccounting,
  MarkdownSkillTemplateAccounting,
} from "./markdown-skill-log.js";
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

/**
 * How many other saved templates govern the same project and issue type as this one (#4354, F07a):
 * the gate checks every governing template, so a write must meet all of them. The same type means the
 * same bound issue type id, or else the same typed name; a template that only governs a status change
 * does not share a type with one that governs writes.
 */
function sharedTypeCount(
  template: JiraIssueTemplate,
  all: readonly JiraIssueTemplate[],
  instances: readonly (string | undefined)[],
): number {
  if (!jiraTemplateGovernsWrites(template)) return 0;
  // Each template as it governs one of the caller's Jiras (a binding made for another Jira is dropped
  // there, as in the gate), by the one rule; the most any one Jira shows is the count.
  const counts = instances.map((instance) => {
    const view = jiraTemplateForInstance(template, instance);
    return all.filter(
      (other) =>
        other !== template &&
        jiraTemplateGovernsWrites(other) &&
        jiraTemplatesShareIssueType(view, jiraTemplateForInstance(other, instance)),
    ).length;
  });
  return Math.max(0, ...counts);
}

export function handleListJiraTemplates(
  ctx: RouteContext,
  deps: TemplateRouteDeps,
): Promise<RouteResult> {
  return withSkillAccess(ctx, deps, "jira-template-list", () => {
    const entries = deps.store.markdownSkills.jiraTemplates();
    const parsed = entries.flatMap(({ template }) => (template === undefined ? [] : [template]));
    const pods = listOwnedJiraPods(deps).filter((pod) => isReadyJiraPod(pod));
    const instances =
      pods.length === 0 ? [undefined] : pods.map((pod) => jiraInstanceIdentity(pod.baseUrl));
    return {
      status: 200,
      body: {
        templates: entries.map(({ skill, template }) => ({
          id: skill.id,
          revision: skill.revision,
          name: skill.name,
          valid: template !== undefined,
          ...(template === undefined
            ? {}
            : {
                ...templateSummary(template),
                sharedWith: sharedTypeCount(template, parsed, instances),
              }),
        })),
      },
    };
  });
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
  // A snapshot: the credential generation the read is made for cannot move under it.
  return { ...pod };
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
  // A revoked session sends nothing more to Jira: the same check gates every dispatch and effect.
  const permitted = (): boolean => !signal.aborted && sessionHeld(ctx, deps);
  return createJiraReadRequest(
    {
      baseUrl: pod.baseUrl,
      deployment: pod.deployment,
      http: factory(pod, correlationId, { beforeDispatch: permitted }),
    },
    {
      invocationId: correlationId,
      correlationId,
      signal,
      beforeEffect: permitted,
    },
  );
}

/**
 * A session can expire or be revoked while Jira is being read: what the read returned is then
 * disclosed to no one, and nothing is counted or written.
 */
function sessionHeld(ctx: RouteContext, deps: TemplateRouteDeps): boolean {
  return resolveAppSessionReadAuthority(deps, ctx.req) !== undefined;
}

/**
 * After an awaited Jira read: the session is still held, and the Pod the read was made for is still
 * owned, ready and at the same credential generation. A removed or replaced Pod never discloses or
 * saves what an older Jira credential read.
 */
function assertReadHeld(
  ctx: RouteContext,
  deps: TemplateRouteDeps,
  pod: ReturnType<typeof readyPod>,
): void {
  if (!sessionHeld(ctx, deps)) throw notFound("Skill");
  const current = findOwnedJiraPod(deps, pod.livePod.podId);
  if (
    current === undefined ||
    !isReadyJiraPod(current) ||
    current.authRef !== pod.authRef ||
    current.generation !== pod.generation
  )
    throw notFound("Jira Pod");
}

function jiraReadFailure(reason: string): UiStoreError {
  return new UiStoreError(
    "INTERNAL",
    `Jira could not be read (${reason}). Check the Pod and try again.`,
    502,
  );
}

function optionsSelection(
  value: Record<string, unknown>,
): Pick<JiraTemplateOptionsRequest, "projectKey" | "issueTypeId"> {
  const { projectKey, issueTypeId } = value;
  if (projectKey === undefined && issueTypeId === undefined) return {};
  if (typeof projectKey !== "string" || !/^[A-Za-z]\w{0,127}$/u.test(projectKey))
    throw invalidRequest("Provide a Jira project key.");
  if (issueTypeId === undefined) return { projectKey };
  if (!isJiraNativeId(issueTypeId))
    throw invalidRequest("Choose an issue type from the Jira project.");
  return { projectKey, issueTypeId };
}

export function handleJiraTemplateOptions(
  ctx: RouteContext,
  deps: TemplateRouteDeps,
): Promise<RouteResult> {
  let accounting: MarkdownSkillTemplateAccounting | undefined;
  return withSkillAccess(
    ctx,
    deps,
    "jira-template-options",
    async () => {
      const body = await readMutation(ctx, deps, 4096);
      if (body.kind === "rejected") return body.response;
      const selection = optionsSelection(body.value);
      const pod = readyPod(deps, body.value.podId);
      const read = await readJiraTemplateOptions(
        podRequest(deps, ctx, pod),
        selection,
        jiraInstanceIdentity(pod.baseUrl),
      );
      assertReadHeld(ctx, deps, pod);
      if (!read.ok) {
        if (read.reason === "not-found") throw notFound("Jira project or issue type");
        throw jiraReadFailure(read.reason);
      }
      const { options } = read;
      switch (options.kind) {
        case "projects":
          accounting = { projectCount: options.projects.length };
          break;
        case "types":
          accounting = { typeCount: options.issueTypes.length };
          break;
        case "details":
          accounting = {
            ...(options.fields === undefined ? {} : { checkedFieldCount: options.fields.length }),
            ...(options.statuses === undefined ? {} : { statusCount: options.statuses.length }),
          };
          break;
      }
      return { status: 200, body: options };
    },
    () => accounting,
  );
}

export function handleValidateJiraTemplate(
  ctx: RouteContext,
  deps: TemplateRouteDeps,
): Promise<RouteResult> {
  let accounting: MarkdownSkillTemplateAccounting | undefined;
  return withSkillAccess(
    ctx,
    deps,
    "jira-template-validate",
    async () => {
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
      assertReadHeld(ctx, deps, pod);
      if (!read.ok) throw jiraReadFailure(read.reason);
      const findings = validateJiraIssueTemplateAgainstInstance(template, read.instance);
      accounting = {
        ...(read.instance.fields === undefined
          ? {}
          : { checkedFieldCount: read.instance.fields.length }),
        validationFindingCount: findings.length,
      };
      return {
        status: 200,
        body: {
          valid: true,
          template: templateSummary(template),
          binding: resolveJiraTemplateBinding(template, read.instance, instanceId),
          ...unconfirmedBinding(parsed.template, template),
          findings,
          checked: {
            project: read.instance.project !== undefined,
            fields: read.instance.fields !== undefined,
            linkTypes: read.instance.linkTypes !== undefined,
            transitions: read.instance.statuses !== undefined,
          },
        },
      };
    },
    () => accounting,
  );
}

/** Counts per closed reason of a proposal run: what the closing log line carries, never a type name. */
function proposalAccounting(result: {
  readonly proposals: readonly { readonly partial?: string }[];
  readonly withoutProposal: readonly { readonly reason: string }[];
  readonly typeCount: number;
}): MarkdownSkillProposalAccounting {
  const count = (reason: string): number =>
    result.withoutProposal.filter((entry) => entry.reason === reason).length;
  return {
    typeCount: result.typeCount,
    proposalCount: result.proposals.length,
    nothingToLearnCount: count("nothing-to-learn"),
    templateInvalidCount: count("template-invalid"),
    jiraUnavailableCount: count("jira-unavailable"),
    beyondLimitCount: count("beyond-limit"),
    partialProposalCount: result.proposals.filter((proposal) => proposal.partial !== undefined)
      .length,
  };
}

export function handleProposeJiraTemplates(
  ctx: RouteContext,
  deps: TemplateRouteDeps,
): Promise<RouteResult> {
  let accounted: MarkdownSkillProposalAccounting | undefined;
  return withSkillAccess(
    ctx,
    deps,
    "jira-template-propose",
    async () => {
      const body = await readMutation(ctx, deps, 4096);
      if (body.kind === "rejected") return body.response;
      const { projectKey, podId } = body.value;
      if (typeof projectKey !== "string" || !/^[A-Za-z]\w{0,127}$/u.test(projectKey)) {
        throw invalidRequest("Provide a Jira project key.");
      }
      const pod = readyPod(deps, podId);
      const result = await proposeJiraIssueTemplates(podRequest(deps, ctx, pod), projectKey);
      assertReadHeld(ctx, deps, pod);
      if (!result.ok) {
        if (result.reason === "not-found") throw notFound("Jira project");
        throw jiraReadFailure(result.reason);
      }
      accounted = proposalAccounting(result);
      const { listed, moreCount } = boundJiraTemplateWithoutProposal(result.withoutProposal);
      return {
        status: 200,
        body: {
          proposals: result.proposals,
          withoutProposal: listed,
          withoutProposalMoreCount: moreCount,
          typeCount: result.typeCount,
        },
      };
    },
    () => accounted,
  );
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
  template: JiraIssueTemplate,
  resolution: Extract<
    ReturnType<typeof resolveJiraTemplateBinding>,
    { state: "unresolved" | "ambiguous" }
  >,
): UiStoreError {
  const what =
    resolution.state === "ambiguous"
      ? `More than one issue type in this Jira is called "${resolution.subject}"`
      : `This Jira shows no issue type called "${resolution.subject}" to you`;
  return new UiStoreError(
    "INVALID_REQUEST",
    `${what}, so the template "${jiraIssueTemplateLabel(template)}" cannot be bound. Write the type as this Jira shows it to you and save the template again, or ask its author to check it against Jira.`,
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

/** The answers that write nothing: already bound for this Jira, or bound to a type that is gone. */
function unchangedBinding(
  resolution: Extract<ReturnType<typeof resolveJiraTemplateBinding>, { state: "bound" | "dead" }>,
): JiraTemplateBound {
  return resolution.state === "bound"
    ? { changed: false, issueType: resolution.issueType }
    : { changed: false, dead: true, issueType: resolution.subject };
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
 * Marks a file whose binding this Jira does not confirm (another Jira's, or one whose typed names
 * were edited by hand): replacing that binding is the person's explicit choice (PR #4464).
 */
function bindingUnconfirmed(stored: JiraIssueTemplate, forInstance: JiraIssueTemplate): boolean {
  return stored.binding !== undefined && forInstance.binding === undefined;
}

function unconfirmedBinding(
  stored: JiraIssueTemplate,
  forInstance: JiraIssueTemplate,
): { readonly bindingUnconfirmed?: true } {
  return bindingUnconfirmed(stored, forInstance) ? { bindingUnconfirmed: true } : {};
}

function readAccounting(fields: readonly unknown[] | undefined): MarkdownSkillTemplateAccounting {
  return {
    ...(fields === undefined ? {} : { checkedFieldCount: fields.length }),
    bindingUpdateCount: 0,
  };
}

/** A binding this Jira does not confirm is another Jira's (or an edited one): replacing it needs an explicit migration. */
function assertMigrationAsked(
  stored: JiraIssueTemplate,
  template: JiraIssueTemplate,
  migrate: unknown,
): void {
  if (!bindingUnconfirmed(stored, template) || migrate === true) return;
  throw new UiStoreError(
    "INVALID_REQUEST",
    `The template "${jiraIssueTemplateLabel(stored)}" is bound to another Jira. Migrate it to this Jira explicitly to replace that binding.`,
    409,
  );
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
  let accounting: MarkdownSkillTemplateAccounting | undefined;
  return withSkillAccess(
    ctx,
    deps,
    "jira-template-bind",
    async () => {
      const body = await readMutation(ctx, deps, BIND_BODY_BYTES);
      if (body.kind === "rejected") return body.response;
      const { skill, template: stored } = bindTarget(deps, body.value.skillId, body.value.revision);
      const pod = readyPod(deps, body.value.podId);
      const instanceId = jiraInstanceIdentity(pod.baseUrl);
      const template = jiraTemplateForInstance(stored, instanceId);
      const read = await readJiraTemplateInstanceMetadata(podRequest(deps, ctx, pod), template);
      assertReadHeld(ctx, deps, pod);
      if (!read.ok) throw jiraReadFailure(read.reason);
      const resolution = resolveJiraTemplateBinding(template, read.instance, instanceId);
      accounting = readAccounting(read.instance.fields);
      if (resolution.state === "bound" || resolution.state === "dead")
        return { status: 200, body: unchangedBinding(resolution) };
      if (resolution.state !== "bindable") throw refusedBinding(template, resolution);
      assertMigrationAsked(stored, template, body.value.migrate);
      const saved = saveBinding(deps, skill, resolution.binding);
      accounting = { ...accounting, bindingUpdateCount: 1 };
      const answer: JiraTemplateBound = {
        changed: true,
        issueType: resolution.issueType,
        parentTypeCount: resolution.binding.parentIssueTypeIds?.length ?? 0,
        skill: saved,
      };
      return { status: 200, body: answer };
    },
    () => accounting,
  );
}
