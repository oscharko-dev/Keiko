import type { CodingToolActionRequest, CodingToolRequestIdentity } from "./codingToolIpc.js";

export type DraftToolRequest = Extract<CodingToolActionRequest, { readonly action: "delivery" }> & {
  readonly intent: "push" | "pull-request";
  readonly phase: "propose" | "execute" | "reconcile";
};
export function isDraftToolRequest(request: CodingToolActionRequest): request is DraftToolRequest {
  return (
    request.action === "delivery" &&
    (request.intent === "push" || request.intent === "pull-request") &&
    request.phase !== undefined
  );
}
function exact(value: Record<string, unknown>, extra: readonly string[]): boolean {
  const keys = new Set(["action", "actionId", "idempotencyKey", "intent", "phase", ...extra]);
  return (
    Object.keys(value).length === keys.size && Object.keys(value).every((key) => keys.has(key))
  );
}
export function parseDraftToolRequest(
  value: Record<string, unknown>,
  identity: CodingToolRequestIdentity,
): DraftToolRequest | undefined {
  if (value.intent !== "push" && value.intent !== "pull-request") return undefined;
  const base = { ...identity, action: "delivery", intent: value.intent } as const;
  if (value.phase === "reconcile" && exact(value, []))
    return Object.freeze({ ...base, phase: "reconcile" });
  if (value.phase === "execute") return executeRequest(value, base);
  if (value.phase !== "propose") return undefined;
  if (value.intent === "push")
    return exact(value, []) ? Object.freeze({ ...base, phase: "propose" }) : undefined;
  return validProposalTitle(value)
    ? Object.freeze({ ...base, phase: "propose", title: value.title })
    : undefined;
}
function validTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= 256 &&
    !/[\0\r\n]/u.test(value)
  );
}

function executeRequest(
  value: Record<string, unknown>,
  base: CodingToolRequestIdentity & {
    readonly action: "delivery";
    readonly intent: "push" | "pull-request";
  },
): DraftToolRequest | undefined {
  return exact(value, ["proposalId"]) &&
    typeof value.proposalId === "string" &&
    /^delivery-\d{1,39}$/u.test(value.proposalId)
    ? Object.freeze({ ...base, phase: "execute", proposalId: value.proposalId })
    : undefined;
}

function validProposalTitle(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { title: string } {
  return exact(value, ["title"]) && validTitle(value.title);
}
