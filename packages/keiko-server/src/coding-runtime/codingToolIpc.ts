export const CODING_TOOL_MAX_BODY_BYTES = 16_384;
export const CODING_TOOL_MAX_IN_FLIGHT = 8;

export type CodingToolAction =
  "edit" | "command" | "verification" | "git" | "delivery" | "connector" | "egress";

export interface CodingToolRequestIdentity {
  readonly actionId: string;
  readonly idempotencyKey: string;
}

export type CodingToolActionRequest =
  | (CodingToolRequestIdentity & {
      readonly action: "edit";
      readonly targetPath: string;
      readonly patchBytes: number;
    })
  | (CodingToolRequestIdentity & { readonly action: "command"; readonly commandId: string })
  | (CodingToolRequestIdentity & {
      readonly action: "verification";
      readonly verifierId: string;
    })
  | (CodingToolRequestIdentity & { readonly action: "git"; readonly operation: "read" | "write" })
  | (CodingToolRequestIdentity & {
      readonly action: "delivery";
      readonly intent: "commit" | "push" | "pull-request" | "merge";
    })
  | (CodingToolRequestIdentity & { readonly action: "connector"; readonly scope: string })
  | (CodingToolRequestIdentity & { readonly action: "egress"; readonly target: string });

export type CodingToolResult =
  | { readonly status: "completed" | "failed"; readonly evidence: readonly CodingToolEvidence[] }
  | {
      readonly status: "denied" | "invalid" | "cancelled" | "busy" | "observed";
      readonly evidence: readonly [];
    };

export interface CodingToolEvidence {
  readonly kind: string;
  readonly code: string;
}

export function parseCodingToolRequest(
  body: string,
  maxBodyBytes: number,
): CodingToolActionRequest | undefined {
  if (Buffer.byteLength(body, "utf8") > maxBodyBytes) return undefined;
  const value = parseJson(body);
  return isRecord(value) ? requestFromRecord(value) : undefined;
}

export function isPermissionObservation(body: string, maxBodyBytes: number): boolean {
  if (Buffer.byteLength(body, "utf8") > maxBodyBytes) return false;
  const value = parseJson(body);
  return (
    isRecord(value) &&
    hasExactKeys(value, ["action", "requestId"]) &&
    value.action === "permission-event" &&
    nonEmpty(value.requestId)
  );
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function requestFromRecord(value: Record<string, unknown>): CodingToolActionRequest | undefined {
  switch (value.action) {
    case "edit":
      return editRequest(value);
    case "command":
      return namedRequest(value, "commandId", "command");
    case "verification":
      return namedRequest(value, "verifierId", "verification");
    case "git":
      return gitRequest(value);
    case "delivery":
      return deliveryRequest(value);
    case "connector":
      return namedRequest(value, "scope", "connector");
    case "egress":
      return namedRequest(value, "target", "egress");
    default:
      return undefined;
  }
}

function editRequest(value: Record<string, unknown>): CodingToolActionRequest | undefined {
  const identity = requestIdentity(value);
  if (
    identity === undefined ||
    !hasExactKeys(value, ["action", "actionId", "idempotencyKey", "targetPath", "patchBytes"])
  )
    return undefined;
  return nonEmpty(value.targetPath) && nonNegative(value.patchBytes)
    ? { ...identity, action: "edit", targetPath: value.targetPath, patchBytes: value.patchBytes }
    : undefined;
}

function namedRequest(
  value: Record<string, unknown>,
  key: "commandId" | "verifierId" | "scope" | "target",
  action: "command" | "verification" | "connector" | "egress",
): CodingToolActionRequest | undefined {
  const identity = requestIdentity(value);
  if (
    identity === undefined ||
    !hasExactKeys(value, ["action", "actionId", "idempotencyKey", key]) ||
    !nonEmpty(value[key])
  )
    return undefined;
  if (action === "command") return { ...identity, action, commandId: value[key] };
  if (action === "verification") return { ...identity, action, verifierId: value[key] };
  if (action === "connector") return { ...identity, action, scope: value[key] };
  return { ...identity, action, target: value[key] };
}

function gitRequest(value: Record<string, unknown>): CodingToolActionRequest | undefined {
  const identity = requestIdentity(value);
  if (
    identity === undefined ||
    !hasExactKeys(value, ["action", "actionId", "idempotencyKey", "operation"])
  )
    return undefined;
  return value.operation === "read" || value.operation === "write"
    ? { ...identity, action: "git", operation: value.operation }
    : undefined;
}

function deliveryRequest(value: Record<string, unknown>): CodingToolActionRequest | undefined {
  const identity = requestIdentity(value);
  if (
    identity === undefined ||
    !hasExactKeys(value, ["action", "actionId", "idempotencyKey", "intent"])
  )
    return undefined;
  return deliveryIntent(value.intent)
    ? { ...identity, action: "delivery", intent: value.intent }
    : undefined;
}

function requestIdentity(value: Record<string, unknown>): CodingToolRequestIdentity | undefined {
  return nonEmpty(value.actionId) && nonEmpty(value.idempotencyKey)
    ? { actionId: value.actionId, idempotencyKey: value.idempotencyKey }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function nonNegative(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000
  );
}

function deliveryIntent(value: unknown): value is "commit" | "push" | "pull-request" | "merge" {
  return value === "commit" || value === "push" || value === "pull-request" || value === "merge";
}
