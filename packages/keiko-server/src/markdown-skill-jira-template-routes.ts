import {
  createJiraReadRequest,
  proposeJiraIssueTemplates,
  readJiraTemplateInstanceMetadata,
  validateJiraIssueTemplateAgainstInstance,
} from "@oscharko-dev/keiko-connectors";
import { MARKDOWN_SKILL_LIMITS } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
  type JiraTemplateActivation,
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
    const read = await readJiraTemplateInstanceMetadata(
      podRequest(deps, ctx, pod),
      parsed.template,
    );
    if (!read.ok) throw jiraReadFailure(read.reason);
    return {
      status: 200,
      body: {
        valid: true,
        template: templateSummary(parsed.template),
        findings: validateJiraIssueTemplateAgainstInstance(parsed.template, read.instance),
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
    if (typeof projectKey !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(projectKey)) {
      throw invalidRequest("Provide a Jira project key.");
    }
    const pod = readyPod(deps, podId);
    const result = await proposeJiraIssueTemplates(podRequest(deps, ctx, pod), projectKey);
    if (!result.ok) {
      if (result.reason === "not-found") throw notFound("Jira project");
      throw jiraReadFailure(result.reason);
    }
    return { status: 200, body: { proposals: result.proposals } };
  });
}
