import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";

import {
  validateAuxiliaryCapabilityOutcomeV1,
  type AuxiliaryCapabilityOutcomeV1,
} from "@oscharko-dev/keiko-contracts";

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
  const context: ExecutionContext = {
    ports,
    maxBodyBytes: boundedOption(options.maxBodyBytes, CODING_TOOL_MAX_BODY_BYTES),
    maxInFlight: boundedOption(options.maxInFlight, CODING_TOOL_MAX_IN_FLIGHT),
    invocationRegistry: options.invocationRegistry,
    requireInvocationRegistryForEdits: options.requireInvocationRegistryForEdits === true,
    inFlight: { count: 0 },
  };
  return {
    execute: async (input) => execute(context, input),
  };
}

interface ExecutionContext {
  readonly ports: CodingToolFacadePorts;
  readonly maxBodyBytes: number;
  readonly maxInFlight: number;
  readonly invocationRegistry: CodingToolInvocationRegistry | undefined;
  readonly requireInvocationRegistryForEdits: boolean;
  readonly inFlight: { count: number };
}

async function execute(
  context: ExecutionContext,
  input: CodingToolFacadeInput,
): Promise<CodingToolResult> {
  if (hasOrigin(input.headers)) return empty("denied");
  if (isPermissionObservation(input.body, context.maxBodyBytes)) return empty("observed");
  const request = parseCodingToolRequest(input.body, context.maxBodyBytes);
  if (request === undefined) return empty("invalid");
  if (input.signal?.aborted === true) return empty("cancelled");
  if (context.inFlight.count >= context.maxInFlight) return empty("busy");
  context.inFlight.count += 1;
  try {
    return await executeAdmitted(
      context.ports,
      input,
      request,
      context.invocationRegistry,
      context.requireInvocationRegistryForEdits,
    );
  } finally {
    context.inFlight.count -= 1;
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
  const auxiliary =
    value.outcome === "completed" ? projectAuxiliary(request, value.auxiliary) : undefined;
  if (auxiliary !== undefined) {
    return {
      status: "completed",
      evidence: [{ kind: "governed-delegate", code: "completed" }],
      auxiliary,
    };
  }
  if (request.action === "skill" || request.action === "child-agent") return projected("failed");
  const read = value.outcome === "completed" ? projectPayload(request, value.read) : undefined;
  return read === undefined
    ? projected(value.outcome)
    : { status: "completed", evidence: [{ kind: "governed-delegate", code: "completed" }], read };
}

function projectAuxiliary(
  request: CodingToolActionRequest,
  value: unknown,
): AuxiliaryCapabilityOutcomeV1 | undefined {
  if (request.action !== "skill" && request.action !== "child-agent") return undefined;
  const validated = validateAuxiliaryCapabilityOutcomeV1(value);
  return validated.ok ? validated.value : undefined;
}

function projectPayload(
  request: CodingToolActionRequest,
  value: unknown,
): { readonly text: string; readonly byteCount: number; readonly digest: string } | undefined {
  if (request.action === "read") return projectRead(value);
  if (request.action === "egress") return projectEgressRead(value);
  return undefined;
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

// A research page (#2387) may exceed the IPC read ceiling; unlike a repository read it is
// truncated at the last complete UTF-8 boundary instead of dropped, so the model always receives
// the bounded head of the page it was granted. Digest and byte count cover the returned bytes.
function projectEgressRead(
  value: unknown,
): { readonly text: string; readonly byteCount: number; readonly digest: string } | undefined {
  if (!isRecord(value) || typeof value.text !== "string") return undefined;
  let bytes: Buffer = Buffer.from(value.text, "utf8");
  if (bytes.length > CODING_TOOL_MAX_READ_BYTES) {
    bytes = bytes.subarray(0, CODING_TOOL_MAX_READ_BYTES);
    while (bytes.length > 0 && !isUtf8(bytes)) bytes = bytes.subarray(0, bytes.length - 1);
  }
  if (!isUtf8(bytes)) return undefined;
  return {
    text: bytes.toString("utf8"),
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
