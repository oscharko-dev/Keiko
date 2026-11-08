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
  type JiraHumanInputSelection,
} from "@oscharko-dev/keiko-connectors";
import {
  JIRA_MUTATION_OPERATIONS,
  JIRA_HUMAN_INPUT_PURPOSES,
  JIRA_HUMAN_INPUT_MAX_LIFETIME_MS,
  JIRA_MANAGED_ACTION_TYPES,
  type JiraHumanInputPurpose,
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

const ALIASES = new Map(
  JIRA_HUMAN_INPUT_PURPOSES.map((purpose) => [`jira_${purpose.replaceAll("-", "_")}`, purpose]),
);
interface Prepared {
  readonly operation: string;
  readonly argumentsDigest: string;
  readonly selection: JiraHumanInputSelection;
}
function capturedObject(value: CatalogJsonValue): value is CatalogJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Private companion to source preparation, scoped to this already-held turn; no secret values. */
export function createJiraChatHumanInput(
  options: JiraChatTurnOptions,
  context: JiraChatCatalogContext,
) {
  const selections = new Map<string, Prepared>();
  let active: Prepared | undefined;
  function current() {
    return resolveCurrentJiraChatAuthority(
      options.deps,
      context.chatId,
      context.authorityReference,
      new Date().toISOString(),
      context.correlationId,
    );
  }
  function admitted(): boolean {
    const resolved = current();
    if (!resolved.ok || context.signal.aborted) return false;
    const grant = options.deps.atlassianActionApprovalRegistry?.findChatReadGrantForRequest(
      resolved.envelope.subject,
      context.authorityReference,
      context.correlationId,
    );
    return (
      grant?.grant.state === "granted" &&
      isCurrentJiraChatReadGrant(
        options.deps,
        grant,
        new Date().toISOString(),
        context.correlationId,
      )
    );
  }
  async function consent(ports: ChatToolInvocationPreparationPorts): Promise<void> {
    const grant = requestJiraChatReadGrant(
      options.deps,
      context.chatId,
      context.authorityReference,
      new Date().toISOString(),
      context.correlationId,
    );
    requireDispatch(grant.kind !== "denied", "denied", "authority-invalid");
    if (grant.kind === "review-required") await ports.requestReadConsent(grant.grant);
    requireDispatch(admitted(), "denied", "authority-invalid");
  }
  async function binding(
    call: ChatToolExchange["call"],
    purpose: JiraHumanInputPurpose,
    args: CatalogJsonObject,
  ): Promise<JiraHumanInputBinding> {
    const resolved = current();
    const credentials = options.deps.atlassianConnectorCredentials;
    const principalDigest = jiraChatActorDigest(options.deps);
    requireDispatch(
      resolved.ok && credentials !== undefined && principalDigest !== undefined && admitted(),
      "denied",
      "authority-invalid",
    );
    const expected = args.expectedActorKey;
    requireDispatch(
      typeof expected === "string" && expected.length > 0 && expected.length <= 255,
      "invalid",
      "invalid-arguments",
    );
    const request = createJiraReadRequest(
      {
        deployment: resolved.credential.deployment,
        baseUrl: resolved.credential.baseUrl,
        http: credentials.httpBodyPortFactory(resolved.credential, context.correlationId, {
          beforeDispatch: admitted,
        }),
      },
      {
        invocationId: call.id,
        correlationId: context.correlationId,
        signal: context.signal,
        beforeEffect: admitted,
      },
    );
    const actor = await request("myself", "GET", undefined, "json");
    const body = actor.ok && actor.status === 200 ? actor.body : undefined;
    requireDispatch(
      admitted() &&
        body?.key === expected &&
        typeof body.name === "string" &&
        body.name.length > 0 &&
        body.name.length <= 255,
      "denied",
      "authority-invalid",
    );
    const review = await prepareJiraHumanInputReview(
      purpose,
      args,
      resolved.credential.baseUrl,
      request,
    );
    requireDispatch(
      admitted() &&
        review !== undefined &&
        review.actorUserKey === expected &&
        review.actorUsername === body.name,
      "denied",
      "authority-invalid",
    );
    return {
      context: {
        kind: "chat",
        chatId: context.chatId,
        messageId: options.message.id,
        callId: call.id,
        podId: resolved.envelope.subject.podId,
        bindingGeneration: resolved.envelope.subject.bindingGeneration,
      },
      authority: context.authorityReference,
      operationCorrelationId: context.correlationId,
      principalDigest,
      authRef: resolved.credential.authRef,
      authenticationGeneration: resolved.credential.generation,
      verificationRevision: resolved.credential.livePod.verificationRevision,
      operation: `jira.${purpose}`,
      argumentsDigest: sha256Hex(canonicalise(args)),
      actorUserKey: expected,
      actorUsername: body.name,
      review,
      expiresAt: Math.min(
        Date.parse(context.deadlineAt),
        Date.now() + JIRA_HUMAN_INPUT_MAX_LIFETIME_MS,
      ),
    };
  }
  return {
    async prepare(
      call: ChatToolExchange["call"],
      actionId: string,
      ports: ChatToolInvocationPreparationPorts,
    ): Promise<void> {
      active = undefined;
      const purpose = ALIASES.get(call.name);
      if (purpose === undefined) return;
      const contract = jiraOperationForTool(`jira.${purpose}`);
      // The catalog owns the final typed refusal. Do not ask for private values for invalid args.
      const args = captureCatalogJson(call.arguments, TOOL_CATALOG_LIMITS.maxArgumentBytes);
      if (
        contract === undefined ||
        !capturedObject(args) ||
        describeCatalogSchemaMismatch(contract.declaration.descriptor.inputSchema, args) !==
          undefined
      )
        return;
      const custody = options.deps.atlassianConnectorCredentials?.custody.humanInputs;
      requireDispatch(custody !== undefined, "failed", "handler-unavailable");
      const authority = current();
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
      await consent(ports);
      const resolved = current();
      const credentials = options.deps.atlassianConnectorCredentials;
      requireDispatch(resolved.ok && credentials !== undefined, "denied", "authority-invalid");
      const operation = JIRA_MUTATION_OPERATIONS.find((name) => name === `jira.${purpose}`);
      if (operation !== undefined) {
        const checked = await checkJiraManagedMutation(
          operation,
          args,
          {
            invocationId: call.id,
            correlationId: context.correlationId,
            signal: context.signal,
            beforeEffect: admitted,
          },
          {
            deployment: resolved.credential.deployment,
            baseUrl: resolved.credential.baseUrl,
            http: credentials.httpBodyPortFactory(resolved.credential, context.correlationId, {
              beforeDispatch: admitted,
            }),
          },
        );
        if (!checked.ok) return;
      }
      const bound = await binding(call, purpose, args);
      const selection = await prepareJiraHumanInput(
        custody,
        bound,
        async (view) => {
          await ports.publishHumanInput(view);
          if (view.state === "awaiting-input")
            recordJiraHumanInput(
              options.deps.atlassianConnectorCredentials,
              context.correlationId,
              "requested",
            );
        },
        context.signal,
        (error) =>
          reportJiraHumanInputCleanupFailure(
            options.deps.atlassianConnectorCredentials,
            bound,
            error,
          ),
      );
      active = { operation: bound.operation, argumentsDigest: bound.argumentsDigest, selection };
      selections.set(actionId, active);
      requireDispatch(admitted(), "denied", "authority-invalid");
    },
    finalize(actionId: string): void {
      const selected = selections.get(actionId);
      if (selected === undefined) return;
      cancelUnclaimedJiraHumanInput(
        options.deps.atlassianConnectorCredentials,
        selected.selection.requestId,
        selected.selection.binding,
      );
      if (active === selected) active = undefined;
      selections.delete(actionId);
    },
    finish(): void {
      for (const selected of selections.values())
        cancelUnclaimedJiraHumanInput(
          options.deps.atlassianConnectorCredentials,
          selected.selection.requestId,
          selected.selection.binding,
        );
      selections.clear();
      active = undefined;
    },
    currentSelection(): JiraHumanInputSelection | undefined {
      return active?.selection;
    },
    revisionFor(actionId: string, argumentsDigest: string): string | undefined {
      const found = selections.get(actionId);
      return found?.argumentsDigest === argumentsDigest ? found.selection.revision : undefined;
    },
    selectionFor(operation: string, argumentsDigest: string): JiraHumanInputSelection | undefined {
      // One serial tool call is held by ChatToolTurn; identities cannot be substituted by args.
      return active?.operation === operation && active.argumentsDigest === argumentsDigest
        ? active.selection
        : undefined;
    },
  };
}
