import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import {
  createToolCatalog,
  createToolDescriptor,
  createToolRef,
  compileToolProjection,
} from "@oscharko-dev/keiko-tool-catalog";
import type {
  ToolDescriptor,
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ToolConsumerContext,
  ToolConsumerActionIdentity,
  ToolEffectGuard,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import { createBufferedServerLogSink } from "../../../../../tests/support/buffered-server-log.js";
import { profile } from "./catalogDefinition.js";
import { createCodingToolInvocationRegistry } from "../../coding-runtime/codingToolInvocationRegistry.js";
import { createCatalogToolBinder } from "../catalogToolDispatch.js";
import type {
  CatalogConsumer,
  CatalogConsumerPort,
  CatalogHandlerContext,
  CatalogHandlerResult,
  CatalogToolHandlerBinding,
  CatalogToolBinderInput,
} from "../catalogToolPorts.js";
import type { ManagedProviderCatalog } from "../managedProviderCatalog.js";

interface ConversationContext extends ToolConsumerContext {
  chatId: string;
  actorId: string;
  readonly binding: { generation: number };
}
export interface ConversationAction extends ToolConsumerActionIdentity {
  readonly action: "lookup" | "mutation";
  readonly query: string;
}
export interface ConversationConsumer extends CatalogConsumer {
  readonly context: ConversationContext;
  readonly action: ConversationAction;
  readonly guard: ToolEffectGuard;
}
function captureAction(value: CatalogJsonValue): ConversationAction | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as CatalogJsonObject;
  if (
    Object.keys(data).sort(compareStrings).join() !== "action,actionId,idempotencyKey,query" ||
    (data.action !== "lookup" && data.action !== "mutation") ||
    typeof data.actionId !== "string" ||
    typeof data.idempotencyKey !== "string" ||
    typeof data.query !== "string"
  )
    return undefined;
  return {
    action: data.action,
    actionId: data.actionId,
    idempotencyKey: data.idempotencyKey,
    query: data.query,
  };
}
const consumerPort: CatalogConsumerPort<ConversationConsumer> = {
  scope: (context) => ({
    kind: "conversation",
    chatId: context.chatId,
    actorId: context.actorId,
    generation: context.binding.generation,
  }),
  staleReason: "consumer-stale",
  requiredEffects: () => ["connector-access"],
  captureAction: (_handler, value) => captureAction(value),
  captureApprovedAction: captureAction,
};
export function queryArgument(args: CatalogJsonValue): string {
  const query = (args as CatalogJsonObject).query;
  if (typeof query !== "string") throw new TypeError("Invalid synthetic query");
  return query;
}
export function conversationDescriptor(): ToolDescriptor {
  return createToolDescriptor({
    toolRef: createToolRef("keiko.fixture.conversation.read", 1),
    description: "Read synthetic conversation-bound data.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", maxLength: 64 } },
      required: ["query"],
      additionalProperties: false,
    },
    resultSchema: {
      type: "object",
      properties: { text: { type: "string", maxLength: 64 } },
      required: ["text"],
      additionalProperties: false,
    },
    effects: ["connector-access"],
    actionMapping: [{ action: "lookup", effects: ["connector-access"] }],
    policyReferences: ["fixture-read"],
    handlerRequirement: { id: "fixture-conversation-read", contractVersion: 1 },
    bounds: {
      maxArgumentBytes: 1024,
      maxResultBytes: 2048,
      maxResultCount: 1,
      maxDurationMs: 2000,
    },
    idempotency: "server-key-required",
    cancellation: "before-effect",
  });
}
export interface ConversationFixture {
  context: ConversationContext;
  binder: ReturnType<typeof createCatalogToolBinder>;
  invocation: object;
  effects: string[];
  logs: ReturnType<typeof createBufferedServerLogSink>;
  dispose: () => void;
  abort: () => void;
}
function contextFor(signal: AbortSignal, consumerId: string): ConversationContext {
  return {
    runId: `turn-${consumerId}`,
    correlationId: `correlation-${consumerId}`,
    authority: "opaque-authority",
    authorityExpiresAt: new Date(100000).toISOString(),
    deadlineAt: new Date(100000).toISOString(),
    signal,
    chatId: `chat-${consumerId}`,
    actorId: `actor-${consumerId}`,
    binding: { generation: 1 },
  };
}
function defaultBinding(
  descriptor: ToolDescriptor,
  effects: string[],
  before: (() => Promise<void>) | undefined,
): CatalogToolHandlerBinding<ConversationConsumer> {
  return {
    toolRef: descriptor.toolRef,
    descriptorDigest: descriptor.descriptorDigest,
    handlerId: descriptor.handlerRequirement.id,
    handlerVersion: 1,
    catalogAction: "lookup",
    readiness: (): "ready" => "ready",
    previewAction: (identity): ConversationAction => ({
      ...identity,
      action: "lookup",
      query: "fixture",
    }),
    actionFor: (args, identity): ConversationAction => ({
      ...identity,
      action: "lookup",
      query: queryArgument(args),
    }),
    execute: async (
      _args,
      bound: CatalogHandlerContext<ConversationConsumer>,
    ): Promise<CatalogHandlerResult> => {
      await before?.();
      if (!bound.beforeEffect()) throw new Error("Consumer changed before effect");
      effects.push(bound.chatId);
      return {
        data: { text: "synthetic-result" },
        page: { truncated: false, reason: "none", cursor: null },
        resultCount: 1,
      };
    },
  };
}
function fixturePorts(
  logs: ReturnType<typeof createBufferedServerLogSink>,
): Pick<
  CatalogToolBinderInput<ConversationConsumer>,
  "authorityPort" | "budgetPort" | "approvalPort" | "logPort"
> {
  return {
    authorityPort: {
      preview: () => ({ ok: true }),
      admit: (): { ok: true; mutationGuard: ToolEffectGuard } => ({
        ok: true,
        mutationGuard: { check: () => true },
      }),
    },
    budgetPort: {
      available: () => true,
      reserve: (_descriptor, _context, invocationId) => ({
        reservationId: `reservation-${invocationId}`,
      }),
      check: () => true,
      commit: () => undefined,
      release: () => undefined,
    },
    approvalPort: { available: () => false, request: () => Promise.resolve(undefined) },
    logPort: { primary: logs, diagnostics: { record: () => undefined } },
  };
}
function defaultCatalog(descriptor: ToolDescriptor): ReturnType<typeof createToolCatalog> {
  return createToolCatalog(
    { descriptors: [descriptor], profiles: [profile(descriptor)], compatibility: [] },
    { referenceTimeMs: 0 },
  );
}
export function createConversationConsumerFixture(
  before?: () => Promise<void>,
  managed?: ManagedProviderCatalog<ConversationConsumer>,
  consumerId = "one",
): ConversationFixture {
  const descriptor = conversationDescriptor();
  const catalog = managed?.catalog ?? defaultCatalog(descriptor);
  const controller = new AbortController();
  const context = contextFor(controller.signal, consumerId);
  const effects: string[] = [];
  const logs = createBufferedServerLogSink();
  const registry = createCodingToolInvocationRegistry({ now: () => 1000 });
  let serial = 0;
  const binder = createCatalogToolBinder<ConversationConsumer>(
    {
      consumerPort,
      projection:
        managed?.projection ?? compileToolProjection(catalog, { id: "fixture", version: 1 }),
      handlerBindings: managed?.handlerBindings ?? [defaultBinding(descriptor, effects, before)],
      ...fixturePorts(logs),
    },
    {
      catalog,
      context: () => context,
      now: () => 1000,
      mintId: () => `${consumerId}-invocation-${String(++serial)}`,
      invocationRegistry: registry,
    },
  );
  const offer = binder.offer();
  return {
    context,
    binder,
    effects,
    logs,
    abort: (): void => {
      controller.abort();
    },
    dispose: (): void => {
      registry.dispose();
    },
    invocation: {
      kind: "bound",
      toolRef: offer.toolRefs[0],
      projectionDigest: offer.binding.projectionDigest,
      offerId: offer.offerId,
      arguments: { query: "fixture" },
    },
  };
}
