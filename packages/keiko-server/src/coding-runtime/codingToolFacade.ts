import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";

import {
  CODING_TOOL_MAX_BODY_BYTES,
  CODING_TOOL_MAX_IN_FLIGHT,
  CODING_TOOL_MAX_READ_BYTES,
  isPermissionObservation,
  parseCodingToolRequest,
  type CodingToolActionRequest,
  type CodingToolResult,
} from "./codingToolIpc.js";
import type {
  CodingToolAdmission,
  CodingToolFacade,
  CodingToolFacadeInput,
  CodingToolFacadeOptions,
  CodingToolFacadePorts,
} from "./codingToolFacadePorts.js";
import type {
  CodingToolInvocationRegistry,
  CodingToolInvocationTakeResult,
} from "./codingToolInvocationRegistry.js";

export function createCodingToolFacade(
  ports: CodingToolFacadePorts,
  options: CodingToolFacadeOptions = {},
): CodingToolFacade {
  const maxBodyBytes = boundedOption(options.maxBodyBytes, CODING_TOOL_MAX_BODY_BYTES);
  const maxInFlight = boundedOption(options.maxInFlight, CODING_TOOL_MAX_IN_FLIGHT);
  let inFlight = 0;
  return {
    execute: async (input) =>
      execute(
        ports,
        input,
        maxBodyBytes,
        maxInFlight,
        options.invocationRegistry,
        options.requireInvocationRegistryForEdits === true,
        () => inFlight,
        (next) => {
          inFlight = next;
        },
      ),
  };
}

async function execute(
  ports: CodingToolFacadePorts,
  input: CodingToolFacadeInput,
  maxBodyBytes: number,
  maxInFlight: number,
  invocationRegistry: CodingToolInvocationRegistry | undefined,
  requireInvocationRegistryForEdits: boolean,
  current: () => number,
  set: (next: number) => void,
): Promise<CodingToolResult> {
  if (hasOrigin(input.headers)) return empty("denied");
  if (isPermissionObservation(input.body, maxBodyBytes)) return empty("observed");
  const request = parseCodingToolRequest(input.body, maxBodyBytes);
  if (request === undefined) return empty("invalid");
  if (input.signal?.aborted === true) return empty("cancelled");
  if (current() >= maxInFlight) return empty("busy");
  set(current() + 1);
  try {
    return await executeAdmitted(
      ports,
      input,
      request,
      invocationRegistry,
      requireInvocationRegistryForEdits,
    );
  } finally {
    set(current() - 1);
  }
}

async function executeAdmitted(
  ports: CodingToolFacadePorts,
  input: CodingToolFacadeInput,
  request: CodingToolActionRequest,
  invocationRegistry: CodingToolInvocationRegistry | undefined,
  requireInvocationRegistryForEdits: boolean,
): Promise<CodingToolResult> {
  const admission = ports.authority.admit(input.capability, request);
  if (!admission.ok) return empty("denied");
  if (input.signal?.aborted === true) return empty("cancelled");
  if (!admission.mutationGuard.check()) return empty("denied");
  if (request.action === "edit" && invocationRegistry !== undefined) {
    return executeStagedEdit(ports, input, request, admission, invocationRegistry);
  }
  if (request.action === "edit" && requireInvocationRegistryForEdits) return empty("denied");
  try {
    return project(
      request,
      await ports.delegate.execute(request, input.signal, admission.mutationGuard),
    );
  } catch {
    return projected("failed");
  }
}

async function executeStagedEdit(
  ports: CodingToolFacadePorts,
  input: CodingToolFacadeInput,
  request: Extract<CodingToolActionRequest, { readonly action: "edit" }>,
  admission: Extract<CodingToolAdmission, { readonly ok: true }>,
  registry: CodingToolInvocationRegistry,
): Promise<CodingToolResult> {
  const binding = admission.binding ?? admission.mutationGuard.binding;
  const payload = typeof input.body === "string" ? Buffer.from(input.body, "utf8") : input.body;
  if (binding === undefined) return wipeAndReturn(payload, empty("denied"));
  const identity = {
    runId: binding.runId,
    actionId: request.actionId,
    idempotencyKey: request.idempotencyKey,
  };
  const staged = registry.stage({
    ...identity,
    digest: createHash("sha256").update(payload).digest("hex"),
    authorityExpiresAt: binding.expiresAt,
    payload,
  });
  if (staged.kind !== "staged") {
    return wipeAndReturn(payload, empty(staged.kind === "busy" ? "busy" : "denied"));
  }
  const claimed = registry.take(identity);
  if (claimed.kind !== "ready") return wipeAndReturn(payload, empty("denied"));
  try {
    return await executeClaimedEdit(ports, input, request, admission, claimed);
  } finally {
    registry.settle(identity);
  }
}

async function executeClaimedEdit(
  ports: CodingToolFacadePorts,
  input: CodingToolFacadeInput,
  request: Extract<CodingToolActionRequest, { readonly action: "edit" }>,
  admission: Extract<CodingToolAdmission, { readonly ok: true }>,
  claimed: Extract<CodingToolInvocationTakeResult, { readonly kind: "ready" }>,
): Promise<CodingToolResult> {
  const signal =
    input.signal === undefined ? claimed.signal : AbortSignal.any([input.signal, claimed.signal]);
  if (isAborted(signal)) return empty("cancelled");
  try {
    const result = await ports.delegate.execute(request, signal, admission.mutationGuard);
    return isAborted(signal) ? empty("cancelled") : project(request, result);
  } catch {
    return projected("failed");
  }
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function wipeAndReturn<T extends CodingToolResult>(payload: Buffer, result: T): T {
  payload.fill(0);
  return result;
}

function project(request: CodingToolActionRequest, value: unknown): CodingToolResult {
  if (!isRecord(value) || (value.outcome !== "completed" && value.outcome !== "failed"))
    return projected("failed");
  const read =
    request.action === "read" && value.outcome === "completed"
      ? projectRead(value.read)
      : undefined;
  return read === undefined
    ? projected(value.outcome)
    : { status: "completed", evidence: [{ kind: "governed-delegate", code: "completed" }], read };
}

function projectRead(
  value: unknown,
): { readonly text: string; readonly byteCount: number; readonly digest: string } | undefined {
  if (!isRecord(value) || typeof value.text !== "string") return undefined;
  const bytes = Buffer.from(value.text, "utf8");
  if (bytes.length > CODING_TOOL_MAX_READ_BYTES || !isUtf8(bytes)) return undefined;
  return {
    text: value.text,
    byteCount: bytes.length,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function projected(status: "completed" | "failed"): CodingToolResult {
  return { status, evidence: [{ kind: "governed-delegate", code: status }] };
}
function hasOrigin(headers: CodingToolFacadeInput["headers"]): boolean {
  return (
    headers !== undefined &&
    (headers instanceof Headers
      ? headers.has("origin")
      : Object.keys(headers).some((key) => key.toLowerCase() === "origin"))
  );
}
function empty(
  status: Exclude<CodingToolResult["status"], "completed" | "failed">,
): CodingToolResult {
  return { status, evidence: [] };
}
function boundedOption(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isSafeInteger(value) || value <= 0 || value > fallback
    ? fallback
    : value;
}
