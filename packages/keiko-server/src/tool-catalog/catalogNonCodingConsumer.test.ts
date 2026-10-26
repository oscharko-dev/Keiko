import { describe, expect, it } from "vitest";
import {
  createToolCatalog,
  createToolDescriptor,
  createToolRef,
  compileToolProjection,
} from "@oscharko-dev/keiko-tool-catalog";
import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ToolConsumerContext,
  ToolConsumerActionIdentity,
  ToolEffectGuard,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { profile } from "./__fixtures__/catalogDefinition.js";
import { createCodingToolInvocationRegistry } from "../coding-runtime/codingToolInvocationRegistry.js";
import { createCatalogToolBinder } from "./catalogToolDispatch.js";
import type {
  CatalogConsumer,
  CatalogConsumerPort,
  CatalogHandlerContext,
  CatalogHandlerResult,
} from "./catalogToolPorts.js";

interface ConversationContext extends ToolConsumerContext {
  chatId: string;
  actorId: string;
  readonly binding: { generation: number };
}
interface ConversationAction extends ToolConsumerActionIdentity {
  readonly action: "lookup";
  readonly query: string;
}
interface ConversationConsumer extends CatalogConsumer {
  readonly context: ConversationContext;
  readonly action: ConversationAction;
  readonly guard: ToolEffectGuard;
}
function captureAction(value: CatalogJsonValue): ConversationAction | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as CatalogJsonObject;
  if (
    Object.keys(data).sort().join() !== "action,actionId,idempotencyKey,query" ||
    data.action !== "lookup" ||
    typeof data.actionId !== "string" ||
    typeof data.idempotencyKey !== "string" ||
    typeof data.query !== "string"
  )
    return undefined;
  return {
    action: "lookup",
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
function queryArgument(args: CatalogJsonValue): string {
  const query = (args as CatalogJsonObject).query;
  if (typeof query !== "string") throw new TypeError("Invalid synthetic query");
  return query;
}
function fixture(before?: () => Promise<void>): {
  context: ConversationContext;
  binder: ReturnType<typeof createCatalogToolBinder>;
  invocation: object;
  effects: string[];
  logs: ReturnType<typeof createBufferedServerLogSink>;
  dispose: () => void;
} {
  const descriptor = createToolDescriptor({
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
  const catalog = createToolCatalog(
    { descriptors: [descriptor], profiles: [profile(descriptor)], compatibility: [] },
    { referenceTimeMs: 0 },
  );
  const context: ConversationContext = {
    runId: "turn-fixture",
    correlationId: "correlation-fixture",
    authority: "opaque-authority",
    authorityExpiresAt: new Date(100000).toISOString(),
    deadlineAt: new Date(100000).toISOString(),
    signal: new AbortController().signal,
    chatId: "chat-one",
    actorId: "actor-one",
    binding: { generation: 1 },
  };
  const effects: string[] = [];
  const logs = createBufferedServerLogSink();
  const registry = createCodingToolInvocationRegistry({ now: () => 1000 });
  let serial = 0;
  const binder = createCatalogToolBinder<ConversationConsumer>(
    {
      consumerPort,
      projection: compileToolProjection(catalog, { id: "fixture", version: 1 }),
      handlerBindings: [
        {
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
        },
      ],
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
    },
    {
      catalog,
      context: () => context,
      now: () => 1000,
      mintId: () => `invocation-${String(++serial)}`,
      invocationRegistry: registry,
    },
  );
  const offer = binder.offer();
  return {
    context,
    binder,
    effects,
    logs,
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
const identity = { actionId: "conversation-action", idempotencyKey: "conversation-key" };

describe("non-Coding consumer on the production catalog binder", () => {
  it("offers and settles without a Coding session, workspace root or Coding action", async () => {
    const f = fixture();
    try {
      expect(Object.keys(f.context).some((key) => key.startsWith("workspace"))).toBe(false);
      const result = await f.binder.dispatch(f.invocation, identity);
      expect(result).toMatchObject({
        kind: "settled",
        result: { status: "completed", data: { text: "synthetic-result" } },
      });
      expect(f.effects).toEqual(["chat-one"]);
      expect(
        f.logs.events.filter((event) => event.op === "tool-catalog.invocation-settled"),
      ).toHaveLength(1);
      expect(f.logs.lines().join()).not.toContain("synthetic-result");
    } finally {
      f.dispose();
    }
  });
  it.each(["chat", "actor", "generation"] as const)(
    "refuses changed %s scope before an effect",
    async (kind) => {
      const f = fixture();
      try {
        if (kind === "chat") f.context.chatId = "chat-two";
        else if (kind === "actor") f.context.actorId = "actor-two";
        else f.context.binding.generation += 1;
        expect(await f.binder.dispatch(f.invocation, identity)).toMatchObject({
          kind: "settled",
          result: { status: "invalid", reason: "consumer-stale", effectStarted: false },
        });
        expect(f.effects).toEqual([]);
      } finally {
        f.dispose();
      }
    },
  );
  it("keeps the captured scope immutable through a delayed handler and settles once", async () => {
    let enter = (): void => undefined;
    let release = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture(() => {
      enter();
      return pending;
    });
    try {
      const result = f.binder.dispatch(f.invocation, identity);
      await entered;
      f.context.binding.generation += 1;
      f.binder.offer();
      release();
      expect(await result).toMatchObject({
        kind: "settled",
        result: { status: "invalid", reason: "consumer-stale", effectStarted: false },
      });
      expect(f.effects).toEqual([]);
      expect(
        f.logs.events.filter((event) => event.op === "tool-catalog.invocation-settled"),
      ).toHaveLength(1);
    } finally {
      release();
      f.dispose();
    }
  });
  it("rejects model-supplied consumer routing before the handler", async () => {
    const f = fixture();
    try {
      expect(
        await f.binder.dispatch(
          { ...f.invocation, arguments: { query: "fixture", chatId: "chat-two" } },
          identity,
        ),
      ).toMatchObject({
        kind: "settled",
        result: { status: "invalid", reason: "invalid-arguments", effectStarted: false },
      });
      expect(f.effects).toEqual([]);
    } finally {
      f.dispose();
    }
  });
});
