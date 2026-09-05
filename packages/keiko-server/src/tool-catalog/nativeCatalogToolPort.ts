import type {
  CatalogToolPort,
  ToolHandlerExecutionEvidence,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import type {
  CatalogJsonValue,
  ToolDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { WorkspaceToolHost } from "@oscharko-dev/keiko-tools";
import { compileToolProjection, lookupCatalogTool } from "@oscharko-dev/keiko-tool-catalog";
import type { CodingToolActionRequest } from "../coding-runtime/codingToolIpc.js";
import { createCatalogToolBinder } from "./catalogToolDispatch.js";
import type {
  CatalogActionIdentity,
  CatalogToolBinderInput,
  CatalogToolBinderOptions,
  CatalogToolHandlerBinding,
  CatalogHandlerResult,
  CatalogToolDispatchOutcome,
} from "./catalogToolPorts.js";

export interface NativeCatalogHandlerAction {
  readonly descriptor: ToolDescriptor;
  readonly preview: (identity: CatalogActionIdentity) => CodingToolActionRequest;
  readonly resolve: (
    argumentsValue: CatalogJsonValue,
    identity: CatalogActionIdentity,
  ) => CodingToolActionRequest;
}
export interface NativeCatalogToolPortInput {
  readonly host: WorkspaceToolHost;
  readonly actions: readonly NativeCatalogHandlerAction[];
  readonly binder: Omit<CatalogToolBinderInput, "handlerBindings" | "projection">;
  readonly options: CatalogToolBinderOptions;
  /** Existing server action owner supplies identity; provider toolCallId is correlation only. */
  readonly nextIdentity: (toolCallId: string) => CatalogActionIdentity;
  readonly observeExecution: (evidence: ToolHandlerExecutionEvidence) => void;
}
function handler(
  input: NativeCatalogToolPortInput,
  action: NativeCatalogHandlerAction,
  observer: () => NativeCatalogToolPortInput["observeExecution"],
): CatalogToolHandlerBinding {
  const descriptor = lookupCatalogTool(input.options.catalog, action.descriptor.toolRef);
  if (descriptor?.descriptorDigest !== action.descriptor.descriptorDigest)
    throw new TypeError("Native handler descriptor mismatch");
  return {
    toolRef: descriptor.toolRef,
    descriptorDigest: descriptor.descriptorDigest,
    handlerId: descriptor.handlerRequirement.id,
    handlerVersion: descriptor.handlerRequirement.contractVersion,
    catalogAction: descriptor.actionMapping[0]?.action ?? "",
    readiness: () =>
      input.host.catalogDescriptor(descriptor.toolRef).descriptorDigest ===
      descriptor.descriptorDigest
        ? "ready"
        : "mismatch",
    previewAction: action.preview,
    actionFor: action.resolve,
    execute: async (argumentsValue, context): Promise<CatalogHandlerResult> => {
      const observeExecution = observer();
      const result = await input.host.executeCatalog({
        toolCallId: context.invocationId,
        toolRef: descriptor.toolRef,
        descriptorDigest: descriptor.descriptorDigest,
        arguments: argumentsValue,
        signal: context.signal,
        beforeEffect: context.beforeEffect,
        observeExecution,
      });
      return {
        data: result.output,
        resultCount: 1,
        page: { truncated: false, reason: "none", cursor: null },
      };
    },
  };
}
/** Reuses one binder and WorkspaceToolHost handlers. No facade admission or result-body cache. */
export function createNativeCatalogToolPort(input: NativeCatalogToolPortInput): CatalogToolPort {
  const catalog = input.options.catalog;
  const projection = compileToolProjection(catalog, { id: "legacy-native", version: 1 });
  let active: { readonly toolCallId: string; readonly signal: AbortSignal } | undefined;
  const observer = (): NativeCatalogToolPortInput["observeExecution"] => {
    const scope = active;
    if (scope === undefined) throw new TypeError("No active native tool invocation");
    return (evidence): void => {
      if (active !== scope)
        throw new TypeError("Native execution evidence arrived after settlement");
      input.observeExecution({ ...evidence, toolCallId: scope.toolCallId });
    };
  };
  const binder = createCatalogToolBinder(
    {
      ...input.binder,
      projection,
      handlerBindings: input.actions.map((action) => handler(input, action, observer)),
    },
    {
      ...input.options,
      context: () => {
        const context = input.options.context();
        return active === undefined
          ? context
          : { ...context, signal: AbortSignal.any([context.signal, active.signal]) };
      },
    },
  );
  return {
    kind: "catalog",
    offer: () => ({ kind: "bound", catalog, projection, offered: binder.offer() }),
    execute: async (request): Promise<CatalogToolDispatchOutcome> => {
      if (active !== undefined || request.signal.aborted)
        throw new TypeError("Native tool invocation unavailable");
      active = { toolCallId: request.toolCallId, signal: request.signal };
      try {
        return await binder.dispatch(request.invocation, input.nextIdentity(request.toolCallId));
      } finally {
        active = undefined;
      }
    },
  };
}
