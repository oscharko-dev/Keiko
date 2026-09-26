import type { IncomingMessage } from "node:http";
import type { MemoryAutonomyPolicyWire } from "@oscharko-dev/keiko-contracts";
import { parseUpdateMemoryAutonomyPolicyWire } from "@oscharko-dev/keiko-contracts/runtime/bff-wire";
import type { UiHandlerDeps } from "./deps.js";
import {
  DEFAULT_MEMORY_AUTONOMY_MODE,
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
  const deploymentCeiling = deps.codingRuntimeDeploymentCeiling ?? DEFAULT_MEMORY_AUTONOMY_MODE;
  return {
    requestedMode,
    effectiveMode: resolveMemoryCaptureAutonomyMode(deps, requestedMode),
    deploymentCeiling,
    revision,
  };
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_POLICY_BODY_BYTES) {
        settleReject(new Error("policy request body too large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", settleReject);
    // A client disconnect mid-upload emits neither "end" nor "error" — without this, the promise
    // (and the awaiting route handler) would hang until the process itself tears down the socket.
    req.once("aborted", () => {
      settleReject(new Error("policy request aborted"));
    });
  });
}

async function parseUpdate(req: IncomingMessage): Promise<unknown> {
  const raw = await readRequestBody(req);
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
    update = await parseUpdate(ctx.req);
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
