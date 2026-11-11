import type { IncomingMessage } from "node:http";
import type { MemoryAutonomyPolicyWire } from "@oscharko-dev/keiko-contracts";
import { parseUpdateMemoryAutonomyPolicyWire } from "@oscharko-dev/keiko-contracts/runtime/bff-wire";
import { readBoundedRequestBody } from "./bounded-request-body.js";
import type { UiHandlerDeps } from "./deps.js";
import {
  DEFAULT_MEMORY_AUTONOMY_MODE,
  memoryDeploymentCeiling,
  memoryOperatorRestrictsAcceptance,
  resolveMemoryCaptureAutonomyMode,
} from "./memory-capture-policy.js";
import { errorBody, type RouteContext, type RouteResult } from "./routes.js";
import type { MemoryAutonomyPolicyRecord } from "./store/index.js";

const MAX_POLICY_BODY_BYTES = 1_024;

function policyProjection(
  deps: UiHandlerDeps,
  stored = deps.store.readMemoryAutonomyPolicy(),
): MemoryAutonomyPolicyWire {
  const { requestedMode, revision } = stored ?? {
    requestedMode: DEFAULT_MEMORY_AUTONOMY_MODE,
    revision: 0,
  };
  const deploymentCeiling = memoryDeploymentCeiling(deps);
  return {
    requestedMode,
    effectiveMode: resolveMemoryCaptureAutonomyMode(deps, requestedMode),
    deploymentCeiling,
    revision,
    routineFactsHeldForReview: memoryOperatorRestrictsAcceptance(deps),
  };
}

async function parseUpdate(
  req: IncomingMessage,
  correlationId: string | undefined,
): Promise<unknown> {
  const raw = await readBoundedRequestBody(req, MAX_POLICY_BODY_BYTES, undefined, correlationId);
  if (raw.length === 0) return undefined;
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed
    : undefined;
}

export function handleGetMemoryAutonomyPolicy(
  _ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult {
  return { status: 200, body: policyProjection(deps) };
}

export async function handlePutMemoryAutonomyPolicy(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  let update: unknown;
  try {
    update = await parseUpdate(ctx.req, ctx.correlationId);
  } catch {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "Invalid memory autonomy policy.", ctx.correlationId),
    };
  }
  const parsed = parseUpdateMemoryAutonomyPolicyWire(update);
  if (parsed === undefined) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "Invalid memory autonomy policy update.", ctx.correlationId),
    };
  }
  const stored: MemoryAutonomyPolicyRecord | undefined = deps.store.updateMemoryAutonomyPolicy(
    parsed.requestedMode,
    parsed.expectedRevision,
  );
  if (stored === undefined) {
    return {
      status: 409,
      body: errorBody(
        "CONFLICT",
        "Memory autonomy policy changed. Reload and retry.",
        ctx.correlationId,
      ),
    };
  }
  return { status: 200, body: policyProjection(deps, stored) };
}
