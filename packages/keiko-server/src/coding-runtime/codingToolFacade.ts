import {
  CODING_TOOL_MAX_BODY_BYTES,
  CODING_TOOL_MAX_IN_FLIGHT,
  isPermissionObservation,
  parseCodingToolRequest,
  type CodingToolActionRequest,
  type CodingToolResult,
} from "./codingToolIpc.js";
import type {
  CodingToolFacade,
  CodingToolFacadeInput,
  CodingToolFacadeOptions,
  CodingToolFacadePorts,
} from "./codingToolFacadePorts.js";

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
    return await executeAdmitted(ports, input, request);
  } finally {
    set(current() - 1);
  }
}

async function executeAdmitted(
  ports: CodingToolFacadePorts,
  input: CodingToolFacadeInput,
  request: CodingToolActionRequest,
): Promise<CodingToolResult> {
  const admission = ports.authority.admit(input.capability, request);
  if (!admission.ok) return empty("denied");
  if (input.signal?.aborted === true) return empty("cancelled");
  if (!admission.mutationGuard.check()) return empty("denied");
  try {
    return project(await ports.delegate.execute(request, input.signal, admission.mutationGuard));
  } catch {
    return projected("failed");
  }
}

function project(value: unknown): CodingToolResult {
  if (!isRecord(value)) return projected("failed");
  if (value.outcome === "completed" || value.outcome === "failed") {
    return projected(value.outcome);
  }
  return projected("failed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projected(status: "completed" | "failed"): CodingToolResult {
  return { status, evidence: [{ kind: "governed-delegate", code: status }] };
}

function hasOrigin(headers: CodingToolFacadeInput["headers"]): boolean {
  if (headers === undefined) return false;
  if (headers instanceof Headers) return headers.has("origin");
  return Object.keys(headers).some((key) => key.toLowerCase() === "origin");
}

function empty(
  status: Exclude<CodingToolResult["status"], "completed" | "failed">,
): CodingToolResult {
  return { status, evidence: [] };
}

function boundedOption(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0 || value > fallback)
    return fallback;
  return value;
}
