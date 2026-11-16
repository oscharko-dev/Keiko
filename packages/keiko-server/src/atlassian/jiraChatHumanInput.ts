import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  captureCatalogJson,
  describeCatalogSchemaMismatch,
} from "@oscharko-dev/keiko-tool-catalog";
import { jiraOperationForTool } from "./jiraManagedProvider.js";
import {
  createJiraReadRequest,
  checkJiraManagedMutation,
  prepareJiraHumanInput,
  prepareJiraHumanInputReview,
  type JiraHumanInputBinding,
  type JiraHumanInputCustody,
  type JiraHumanInputSelection,
} from "@oscharko-dev/keiko-connectors";
import {
  JIRA_MUTATION_OPERATIONS,
  JIRA_HUMAN_INPUT_PURPOSES,
  JIRA_HUMAN_INPUT_MAX_LIFETIME_MS,
  JIRA_MANAGED_ACTION_TYPES,
  type JiraHumanInputPurpose,
  type JiraHumanInputView,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { ChatToolInvocationPreparationPorts } from "../chat-tool-turn.js";
import { requireDispatch } from "../tool-catalog/catalogToolErrors.js";
import type { JiraChatTurnOptions } from "./jiraChatToolTurn.js";
import type { JiraChatCatalogContext } from "./jiraChatCatalogConsumer.js";
import {
  isCurrentJiraChatReadGrant,
  requestJiraChatReadGrant,
  resolveCurrentJiraChatAuthority,
} from "./jiraChatAuthority.js";
import { jiraChatActorDigest } from "./jiraPodAccess.js";
import { decideAtlassianEnvelopeAction } from "./actionPolicy.js";
import {
  cancelUnclaimedJiraHumanInput,
  recordJiraHumanInput,
  reportJiraHumanInputCleanupFailure,
} from "./credentialActivity.js";

const ALIASES: ReadonlyMap<string, JiraHumanInputPurpose> = new Map(
  JIRA_HUMAN_INPUT_PURPOSES.map((purpose): [string, JiraHumanInputPurpose] => [
    `jira_${purpose.replaceAll("-", "_")}`,
    purpose,
  ]),
);
interface Prepared {
  readonly operation: string;
  readonly argumentsDigest: string;
  readonly selection: JiraHumanInputSelection;
}
function capturedObject(value: CatalogJsonValue): value is CatalogJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
interface HumanInputPorts {
  readonly prepare: (
    call: ChatToolExchange["call"],
    actionId: string,
    ports: ChatToolInvocationPreparationPorts,
  ) => Promise<void>;
  readonly finalize: (actionId: string) => void;
  readonly finish: () => void;
  readonly currentSelection: () => JiraHumanInputSelection | undefined;
  readonly revisionFor: (actionId: string, argumentsDigest: string) => string | undefined;
  readonly selectionFor: (
    operation: string,
    argumentsDigest: string,
  ) => JiraHumanInputSelection | undefined;
}
type CurrentAuthority = Extract<ReturnType<typeof resolveCurrentJiraChatAuthority>, { ok: true }>;
type Credentials = NonNullable<JiraChatTurnOptions["deps"]["atlassianConnectorCredentials"]>;
type Review = NonNullable<JiraHumanInputBinding["review"]>;
interface SelectedInput {
  readonly call: ChatToolExchange["call"];
  readonly purpose: JiraHumanInputPurpose;
  readonly args: CatalogJsonObject;
}
interface BindingContext {
  readonly resolved: CurrentAuthority;
  readonly credentials: Credentials;
  readonly principalDigest: string;
}
function selectInput(call: ChatToolExchange["call"]): SelectedInput | undefined {
  const purpose: JiraHumanInputPurpose | undefined = ALIASES.get(call.name);
  if (purpose === undefined) return undefined;
  const contract = jiraOperationForTool(`jira.${purpose}`);
  // The catalog owns the final typed refusal. Do not ask for private values for invalid args.
  const args = captureCatalogJson(call.arguments, TOOL_CATALOG_LIMITS.maxArgumentBytes);
  if (
    contract === undefined ||
    !capturedObject(args) ||
    describeCatalogSchemaMismatch(contract.declaration.descriptor.inputSchema, args) !== undefined
  )
    return undefined;
  return { call, purpose, args };
}
function expectedActor(args: CatalogJsonObject): string {
  const expected = args.expectedActorKey;
  requireDispatch(
    typeof expected === "string" && expected.length > 0 && expected.length <= 255,
    "invalid",
    "invalid-arguments",
  );
  return expected;
}
class JiraChatHumanInputOwner {
  private readonly selections = new Map<string, Prepared>();
  private active: Prepared | undefined;
  constructor(
    private readonly options: JiraChatTurnOptions,
    private readonly context: JiraChatCatalogContext,
  ) {}

  private current(): ReturnType<typeof resolveCurrentJiraChatAuthority> {
    return resolveCurrentJiraChatAuthority(
      this.options.deps,
      this.context.chatId,
      this.context.authorityReference,
      new Date().toISOString(),
      this.context.correlationId,
    );
  }
  private admitted(): boolean {
    const resolved = this.current();
    if (!resolved.ok || this.context.signal.aborted) return false;
    const grant = this.options.deps.atlassianActionApprovalRegistry?.findChatReadGrantForRequest(
      resolved.envelope.subject,
      this.context.authorityReference,
      this.context.correlationId,
    );
    return (
      grant?.grant.state === "granted" &&
      isCurrentJiraChatReadGrant(
        this.options.deps,
        grant,
        new Date().toISOString(),
        this.context.correlationId,
      )
    );
  }
  private async consent(ports: ChatToolInvocationPreparationPorts): Promise<void> {
    const grant = requestJiraChatReadGrant(
      this.options.deps,
      this.context.chatId,
      this.context.authorityReference,
      new Date().toISOString(),
      this.context.correlationId,
    );
    requireDispatch(grant.kind !== "denied", "denied", "authority-invalid");
    if (grant.kind === "review-required") await ports.requestReadConsent(grant.grant);
    requireDispatch(this.admitted(), "denied", "authority-invalid");
  }
  private bindingContext(): BindingContext {
    const resolved = this.current();
    const credentials = this.options.deps.atlassianConnectorCredentials;
    const principalDigest = jiraChatActorDigest(this.options.deps);
    requireDispatch(
      resolved.ok && credentials !== undefined && principalDigest !== undefined && this.admitted(),
      "denied",
      "authority-invalid",
    );
    return { resolved, credentials, principalDigest };
  }
  private invocation(callId: string): Parameters<typeof createJiraReadRequest>[1] {
    return {
      invocationId: callId,
      correlationId: this.context.correlationId,
      signal: this.context.signal,
      beforeEffect: () => this.admitted(),
    };
  }
  private connection(
    resolved: CurrentAuthority,
    credentials: Credentials,
  ): Parameters<typeof createJiraReadRequest>[0] {
    return {
      deployment: resolved.credential.deployment,
      baseUrl: resolved.credential.baseUrl,
      http: credentials.httpBodyPortFactory(resolved.credential, this.context.correlationId, {
        beforeDispatch: () => this.admitted(),
      }),
    };
  }
  private async actor(
    request: ReturnType<typeof createJiraReadRequest>,
    expected: string,
  ): Promise<string> {
    const actor = await request("myself", "GET", undefined, "json");
    const body = actor.ok && actor.status === 200 ? actor.body : undefined;
    requireDispatch(
      this.admitted() &&
        body?.key === expected &&
        typeof body.name === "string" &&
        body.name.length > 0 &&
        body.name.length <= 255,
      "denied",
      "authority-invalid",
    );
    return body.name;
  }
  private async binding(input: SelectedInput): Promise<JiraHumanInputBinding> {
    const selected = this.bindingContext();
    const expected = expectedActor(input.args);
    const request = createJiraReadRequest(
      this.connection(selected.resolved, selected.credentials),
      this.invocation(input.call.id),
    );
    const username = await this.actor(request, expected);
    const review = await prepareJiraHumanInputReview(
      input.purpose,
      input.args,
      selected.resolved.credential.baseUrl,
      request,
    );
    requireDispatch(
      this.admitted() && review?.actorUserKey === expected && review.actorUsername === username,
      "denied",
      "authority-invalid",
    );
    return this.boundInput(input, selected, review);
  }
  private boundInput(
    input: SelectedInput,
    selected: BindingContext,
    review: Review,
  ): JiraHumanInputBinding {
    const { resolved, principalDigest } = selected;
    return {
      context: {
        kind: "chat",
        chatId: this.context.chatId,
        messageId: this.options.message.id,
        callId: input.call.id,
        podId: resolved.envelope.subject.podId,
        bindingGeneration: resolved.envelope.subject.bindingGeneration,
      },
      authority: this.context.authorityReference,
      operationCorrelationId: this.context.correlationId,
      principalDigest,
      authRef: resolved.credential.authRef,
      authenticationGeneration: resolved.credential.generation,
      verificationRevision: resolved.credential.livePod.verificationRevision,
      operation: `jira.${input.purpose}`,
      argumentsDigest: sha256Hex(canonicalise(input.args)),
      actorUserKey: review.actorUserKey,
      actorUsername: review.actorUsername,
      review,
      expiresAt: Math.min(
        Date.parse(this.context.deadlineAt),
        Date.now() + JIRA_HUMAN_INPUT_MAX_LIFETIME_MS,
      ),
    };
  }
  private authorizeInput(purpose: JiraHumanInputPurpose): JiraHumanInputCustody {
    const custody = this.options.deps.atlassianConnectorCredentials?.custody.humanInputs;
    requireDispatch(custody !== undefined, "failed", "handler-unavailable");
    const authority = this.current();
    requireDispatch(authority.ok, "denied", "authority-invalid");
    const policy = decideAtlassianEnvelopeAction(
      JIRA_MANAGED_ACTION_TYPES[`jira.${purpose}`],
      authority.envelope,
    );
    requireDispatch(
      policy.kind === "allowed" || policy.kind === "review-required",
      "denied",
      "authority-invalid",
    );
    return custody;
  }
  private async preflight(input: SelectedInput): Promise<boolean> {
    const resolved = this.current();
    const credentials = this.options.deps.atlassianConnectorCredentials;
    requireDispatch(resolved.ok && credentials !== undefined, "denied", "authority-invalid");
    const operation = JIRA_MUTATION_OPERATIONS.find((name) => name === `jira.${input.purpose}`);
    if (operation === undefined) return true;
    const checked = await checkJiraManagedMutation(
      operation,
      input.args,
      this.invocation(input.call.id),
      this.connection(resolved, credentials),
    );
    return checked.ok;
  }
  private async publishRequested(
    ports: ChatToolInvocationPreparationPorts,
    view: JiraHumanInputView,
  ): Promise<void> {
    await ports.publishHumanInput(view);
    if (view.state === "awaiting-input")
      recordJiraHumanInput(
        this.options.deps.atlassianConnectorCredentials,
        this.context.correlationId,
        "requested",
      );
  }
  private async prepare(
    call: ChatToolExchange["call"],
    actionId: string,
    ports: ChatToolInvocationPreparationPorts,
  ): Promise<void> {
    this.active = undefined;
    const input = selectInput(call);
    if (input === undefined) return;
    const custody = this.authorizeInput(input.purpose);
    await this.consent(ports);
    if (!(await this.preflight(input))) return;
    const bound = await this.binding(input);
    const selection = await prepareJiraHumanInput(
      custody,
      bound,
      (view) => this.publishRequested(ports, view),
      this.context.signal,
      (error) => {
        reportJiraHumanInputCleanupFailure(
          this.options.deps.atlassianConnectorCredentials,
          bound,
          error,
        );
      },
    );
    this.active = { operation: bound.operation, argumentsDigest: bound.argumentsDigest, selection };
    this.selections.set(actionId, this.active);
    requireDispatch(this.admitted(), "denied", "authority-invalid");
  }
  private finalize(actionId: string): void {
    const selected = this.selections.get(actionId);
    if (selected === undefined) return;
    cancelUnclaimedJiraHumanInput(
      this.options.deps.atlassianConnectorCredentials,
      selected.selection.requestId,
      selected.selection.binding,
    );
    if (this.active === selected) this.active = undefined;
    this.selections.delete(actionId);
  }
  private finish(): void {
    for (const selected of this.selections.values())
      cancelUnclaimedJiraHumanInput(
        this.options.deps.atlassianConnectorCredentials,
        selected.selection.requestId,
        selected.selection.binding,
      );
    this.selections.clear();
    this.active = undefined;
  }
  private revisionFor(actionId: string, argumentsDigest: string): string | undefined {
    const found = this.selections.get(actionId);
    return found?.argumentsDigest === argumentsDigest ? found.selection.revision : undefined;
  }
  private selectionFor(
    operation: string,
    argumentsDigest: string,
  ): JiraHumanInputSelection | undefined {
    // One serial tool call is held by ChatToolTurn; identities cannot be substituted by args.
    return this.active?.operation === operation && this.active.argumentsDigest === argumentsDigest
      ? this.active.selection
      : undefined;
  }
  ports(): HumanInputPorts {
    return {
      prepare: (call, actionId, ports) => this.prepare(call, actionId, ports),
      finalize: (actionId): void => {
        this.finalize(actionId);
      },
      finish: (): void => {
        this.finish();
      },
      currentSelection: () => this.active?.selection,
      revisionFor: (actionId, argumentsDigest) => this.revisionFor(actionId, argumentsDigest),
      selectionFor: (operation, argumentsDigest) => this.selectionFor(operation, argumentsDigest),
    };
  }
}
/** Private companion to source preparation, scoped to this already-held turn; no secret values. */
export function createJiraChatHumanInput(
  options: JiraChatTurnOptions,
  context: JiraChatCatalogContext,
): HumanInputPorts {
  return new JiraChatHumanInputOwner(options, context).ports();
}
