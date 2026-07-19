import type { IncomingMessage } from "node:http";
import {
  isCodingWorkbenchMode,
  type MemoryAutonomyPolicyWire,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "./deps.js";
import { resolveMemoryCaptureAutonomyMode } from "./memory-capture-policy.js";
import { errorBody, type RouteContext, type RouteResult } from "./routes.js";

const MAX_POLICY_BODY_BYTES = 1_024;
const DEFAULT_MEMORY_AUTONOMY_MODE = "governed-assist" as const;

function policyProjection(deps: UiHandlerDeps): MemoryAutonomyPolicyWire {
  const requestedMode = deps.store.getMemoryAutonomyMode() ?? DEFAULT_MEMORY_AUTONOMY_MODE;
  const deploymentCeiling = deps.codingRuntimeDeploymentCeiling ?? DEFAULT_MEMORY_AUTONOMY_MODE;
  return {
    requestedMode,
    effectiveMode: resolveMemoryCaptureAutonomyMode(deps, requestedMode),
    deploymentCeiling,
  };
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_POLICY_BODY_BYTES) {
        reject(new Error("policy request body too large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function parseRequestedMode(req: IncomingMessage): Promise<unknown> {
  const raw = await readRequestBody(req);
  if (raw.length === 0) return undefined;
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).requestedMode
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
  let requestedMode: unknown;
  try {
    requestedMode = await parseRequestedMode(ctx.req);
  } catch {
    return { status: 400, body: errorBody("BAD_REQUEST", "Invalid memory autonomy policy.") };
  }
  if (!isCodingWorkbenchMode(requestedMode)) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Invalid memory autonomy mode.") };
  }
  deps.store.setMemoryAutonomyMode(requestedMode);
  return { status: 200, body: policyProjection(deps) };
}
