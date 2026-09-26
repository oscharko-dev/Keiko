import { vi } from "vitest";
import { fixture } from "./catalogDefinition.js";
import { createBufferedServerLogSink } from "../../observability/server-log.js";
import { createCodingToolInvocationRegistry } from "../../coding-runtime/codingToolInvocationRegistry.js";
import type { CodingToolAuthorityPreview } from "../../coding-runtime/codingToolAuthorityPort.js";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  CatalogHandlerResult,
  CatalogToolApprovalPort,
  CatalogToolBinderInput,
  CatalogToolBinderOptions,
  CatalogToolBudgetPort,
  CatalogToolHandlerBinding,
  CatalogTrustedContext,
} from "../catalogToolPorts.js";

function fixtureContext(): CatalogTrustedContext {
  return {
    runId: "run-1",
    correlationId: "correlation-1",
    workspaceRoot: "/private/workspace",
    workspaceIdentity: "workspace-1",
    workspaceRevision: "a".repeat(40),
    authority: "private-capability",
    deadlineAt: new Date(60_000).toISOString(),
    authorityExpiresAt: new Date(60_000).toISOString(),
    signal: new AbortController().signal,
  };
}
function fixtureHandler(pure: ReturnType<typeof fixture>): CatalogToolHandlerBinding {
  return {
    toolRef: pure.descriptor.toolRef,
    descriptorDigest: pure.descriptor.descriptorDigest,
    handlerId: "fixture-read",
    handlerVersion: 1,
    catalogAction: "read",
    readiness: () => "ready",
    previewAction: (identity) => ({ action: "read", relativePath: "fixture.ts", ...identity }),
    actionFor: (args, identity): ReturnType<CatalogToolHandlerBinding["actionFor"]> => {
      const path = (args as CatalogJsonObject).path;
      if (typeof path !== "string") throw new TypeError("Invalid fixture arguments");
      return { action: "read", relativePath: path, ...identity };
    },
    execute: (_args, context): Promise<CatalogHandlerResult> => {
      if (!context.beforeEffect()) throw new TypeError("Effect denied");
      return Promise.resolve({
        data: { text: "fixture-result" },
        page: { truncated: false, reason: "none", cursor: null },
        resultCount: 1,
      });
    },
  };
}

function fixtureOptions(
  pure: ReturnType<typeof fixture>,
  context: CatalogTrustedContext,
  now: () => number,
): CatalogToolBinderOptions {
  let serial = 0;
  return {
    catalog: pure.catalog,
    context: () => context,
    now,
    mintId: () => `minted-${String(++serial)}`,
    invocationRegistry: createCodingToolInvocationRegistry({ now }),
  };
}

export function catalogToolFixture(): {
  readonly pure: ReturnType<typeof fixture>;
  readonly input: CatalogToolBinderInput;
  readonly options: CatalogToolBinderOptions;
  readonly handler: CatalogToolHandlerBinding;
  readonly preview: ReturnType<typeof vi.fn<CodingToolAuthorityPreview>>;
  readonly budgetAvailable: ReturnType<typeof vi.fn<CatalogToolBudgetPort["available"]>>;
  readonly approvalAvailable: ReturnType<typeof vi.fn<CatalogToolApprovalPort["available"]>>;
  readonly now: ReturnType<typeof vi.fn<() => number>>;
  readonly context: CatalogTrustedContext;
  readonly primary: ReturnType<typeof createBufferedServerLogSink>;
} {
  const pure = fixture();
  const primary = createBufferedServerLogSink();
  const preview = vi.fn<CodingToolAuthorityPreview>(() => ({ ok: true }));
  const budgetAvailable = vi.fn<CatalogToolBudgetPort["available"]>(() => true);
  const approvalAvailable = vi.fn<CatalogToolApprovalPort["available"]>(() => false);
  const now = vi.fn(() => 1000);
  const context = fixtureContext();
  const handler = fixtureHandler(pure);
  const input: CatalogToolBinderInput = {
    projection: pure.projection,
    handlerBindings: [handler],
    authorityPort: { preview, admit: () => ({ ok: true, mutationGuard: { check: () => true } }) },
    budgetPort: {
      available: budgetAvailable,
      reserve: (_descriptor, _context, invocationId) => ({
        reservationId: `reservation-${invocationId}`,
      }),
      check: () => true,
      commit: () => undefined,
      release: () => undefined,
    },
    approvalPort: { available: approvalAvailable, request: () => Promise.resolve(undefined) },
    logPort: { primary, diagnostics: { record: vi.fn() } },
  };
  const options = fixtureOptions(pure, context, now);
  return {
    pure,
    input,
    options,
    handler,
    preview,
    budgetAvailable,
    approvalAvailable,
    now,
    context,
    primary,
  };
}
