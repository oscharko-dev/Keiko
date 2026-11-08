import type { AtlassianHttpLifecycleOptions } from "./httpRequestLifecycle.js";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { UiHandlerDeps } from "../deps.js";
import type { JiraChatCatalogContext } from "./jiraChatCatalogConsumer.js";
import type { JiraLivePodCredential } from "./jiraPodAccess.js";
import type { JiraPrivatePortFactoryResult } from "./httpPrivateIdentity.js";
import { recordJiraHumanInput } from "./credentialActivity.js";

type Dependencies = Pick<UiHandlerDeps, "store" | "atlassianConnectorCredentials">;
/** Lazy native ports only. Building an ordinary read connection neither logs in nor reads myself. */
export function jiraChatPrivatePorts(
  deps: Dependencies,
  context: JiraChatCatalogContext,
  credential: JiraLivePodCredential,
  invocation: ManagedMcpInvocationContext,
  lifecycle?: AtlassianHttpLifecycleOptions,
): JiraPrivatePortFactoryResult | undefined {
  const factory = deps.atlassianConnectorCredentials?.jiraPrivatePortFactory;
  const chat = deps.store.findChatById(context.chatId);
  const pod = chat?.jiraPodBinding;
  if (factory === undefined || pod === undefined || pod.podId !== credential.livePod.podId ||
      pod.bindingGeneration !== chat?.jiraBindingGeneration || pod.authenticationGeneration !== credential.generation) return undefined;
  const selection = context.activeHumanInput?.();
  return factory(credential, invocation, {
    sessionScope: { context: { kind: "chat", chatId: context.chatId, podId: pod.podId, bindingGeneration: pod.bindingGeneration },
      authority: context.authorityReference,
      principalDigest: credential.livePod.ownerDigest, authRef: credential.authRef,
      authenticationGeneration: credential.generation, verificationRevision: credential.livePod.verificationRevision,
      expiresAt: Date.parse(context.deadlineAt) },
    ...(selection === undefined ? {} : { selection }),
    onConsumed: (view): void => {
      const binding = selection?.binding.context;
      if (binding?.kind !== "chat" || binding.chatId !== context.chatId || binding.messageId !== context.userMessageId ||
          view.requestId !== selection?.requestId) throw new TypeError("Private Jira input context changed");
      deps.store.updateChatToolTranscript(binding.messageId, { kind: "human-input", callId: binding.callId, view }, context.correlationId);
      recordJiraHumanInput(deps.atlassianConnectorCredentials, context.correlationId, "consumed");
    },
  }, lifecycle ?? { beforeDispatch: invocation.beforeEffect });
}
