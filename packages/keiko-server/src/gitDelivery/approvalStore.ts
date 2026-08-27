import { randomBytes, timingSafeEqual } from "node:crypto";
import type {
  GitDeliveryApprovalClaim,
  GitDeliveryApprovalRequirement,
} from "@oscharko-dev/keiko-contracts";
import {
  GIT_DELIVERY_SCHEMA_VERSION,
  isGitDeliveryApprovalClaim,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";

// KEIKO-0693: "action-sheet" was removed from this union -- action-sheet is read-only and never
// approval-gated (actionSheetRoutes.ts always sets `approvalRequirement: { required: false }`
// and never touches the approval store), so the member was pure type-noise that suggested a
// non-existent binding could be constructed.
export type GitDeliveryApprovalOperation = "local-mutation" | "commit" | "push" | "pr" | "merge";

export interface GitDeliveryApprovalBinding {
  readonly projectId: string;
  readonly operation: GitDeliveryApprovalOperation;
  readonly command: unknown;
}

export interface GitDeliveryApprovalIssueInput {
  readonly binding: GitDeliveryApprovalBinding;
  readonly approvedByUserId: string;
  readonly nowMs?: number | undefined;
  readonly ttlMs?: number | undefined;
}

export interface GitDeliveryIssuedApproval {
  readonly approval: GitDeliveryApprovalClaim;
  readonly approvalTokenHash: string;
  readonly approvedByUserId: string;
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
}

export interface GitDeliveryApprovalConsumeInput {
  readonly approval: GitDeliveryApprovalClaim;
  readonly binding: GitDeliveryApprovalBinding;
  readonly nowMs: number;
}

export interface GitDeliveryApprovalStore {
  issue(input: GitDeliveryApprovalIssueInput): GitDeliveryIssuedApproval;
  consume(input: GitDeliveryApprovalConsumeInput): GitDeliveryApprovalRequirement | undefined;
}

export type ParsedGitDeliveryApprovalRequest =
  { readonly kind: "none" } | { readonly kind: "claim"; readonly claim: GitDeliveryApprovalClaim };

interface StoredApprovalRecord {
  readonly bindingHash: string;
  readonly tokenHash: string;
  readonly approvedByUserId: string;
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 512;

export function gitDeliveryApprovalBindingHash(binding: GitDeliveryApprovalBinding): string {
  return sha256Hex(canonicalise(binding));
}

function hashToken(token: string): string {
  return sha256Hex(token);
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(a) || !/^[0-9a-f]{64}$/u.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function pruneExpired(
  records: Map<string, StoredApprovalRecord>,
  nowMs: number,
  maxRecords: number,
): void {
  for (const [id, record] of records) {
    if (record.expiresAtMs <= nowMs) records.delete(id);
  }
  while (records.size > maxRecords) {
    const first = records.keys().next().value;
    if (first === undefined) break;
    records.delete(first);
  }
}

// eslint-disable-next-line max-lines-per-function -- approval issue/consume state machine is intentionally co-located.
export function createInMemoryGitDeliveryApprovalStore(
  options: {
    readonly maxRecords?: number | undefined;
    readonly ttlMs?: number | undefined;
  } = {},
): GitDeliveryApprovalStore {
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const records = new Map<string, StoredApprovalRecord>();
  return {
    issue(input): GitDeliveryIssuedApproval {
      const nowMs = input.nowMs ?? Date.now();
      pruneExpired(records, nowMs, maxRecords);
      const approvalId = `gda_${randomBytes(16).toString("hex")}`;
      const approvalToken = randomBytes(32).toString("hex");
      const tokenHash = hashToken(approvalToken);
      const expiresAtMs = nowMs + (input.ttlMs ?? ttlMs);
      records.set(approvalId, {
        bindingHash: gitDeliveryApprovalBindingHash(input.binding),
        tokenHash,
        approvedByUserId: input.approvedByUserId,
        approvedAtMs: nowMs,
        expiresAtMs,
      });
      return {
        approval: {
          schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
          approvalId,
          approvalToken,
        },
        approvalTokenHash: tokenHash,
        approvedByUserId: input.approvedByUserId,
        approvedAtMs: nowMs,
        expiresAtMs,
      };
    },
    consume(input): GitDeliveryApprovalRequirement | undefined {
      pruneExpired(records, input.nowMs, maxRecords);
      const record = records.get(input.approval.approvalId);
      if (record === undefined) return undefined;
      if (record.expiresAtMs <= input.nowMs) {
        records.delete(input.approval.approvalId);
        return undefined;
      }
      if (record.bindingHash !== gitDeliveryApprovalBindingHash(input.binding)) return undefined;
      if (!constantTimeHexEqual(record.tokenHash, hashToken(input.approval.approvalToken))) {
        return undefined;
      }
      records.delete(input.approval.approvalId);
      return {
        required: true,
        approvalTokenHash: record.tokenHash,
        approvedByUserId: record.approvedByUserId,
        approvedAtMs: record.approvedAtMs,
        expiresAtMs: record.expiresAtMs,
      };
    },
  };
}

// Exported (not module-private) so the mint route (which calls `.issue()`) and every consume-side
// caller share the exact SAME in-memory store instance by default. Before the mint route existed,
// this stayed private because nothing but `resolveGitDeliveryApprovalRequirement` ever touched it; a
// route that mints an approval must issue into the identical store the execute routes consume from,
// or every default-store mint would be unredeemable (issued into one Map, looked up in another).
export const DEFAULT_GIT_DELIVERY_APPROVAL_STORE = createInMemoryGitDeliveryApprovalStore();

// The fixed local principal for this single-user, loopback-bound desktop product. Mirrors the
// established "local-operator" convention used for other loopback approval/reviewer identities in
// this codebase (e.g. memory-handlers.ts, memory-conversation-context.ts, deps.ts) — there is no
// per-request authenticated end user to attribute a mint to, only the one local human at the
// keyboard, so every git-delivery approval claim this process mints is attributed to this constant.
export const GIT_DELIVERY_LOCAL_OPERATOR_ID = "local-operator";

export function parseGitDeliveryApprovalRequest(
  raw: unknown,
): ParsedGitDeliveryApprovalRequest | undefined {
  if (raw === undefined) return { kind: "none" };
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (record.required === false && Object.keys(record).length === 1) return { kind: "none" };
  }
  if (isGitDeliveryApprovalClaim(raw)) return { kind: "claim", claim: raw };
  return undefined;
}

export function resolveGitDeliveryApprovalRequirement(
  approval: ParsedGitDeliveryApprovalRequest,
  input: {
    readonly store?: GitDeliveryApprovalStore | undefined;
    readonly binding: GitDeliveryApprovalBinding;
    readonly nowMs: number;
  },
): GitDeliveryApprovalRequirement | undefined {
  if (approval.kind === "none") return { required: false };
  return (input.store ?? DEFAULT_GIT_DELIVERY_APPROVAL_STORE).consume({
    approval: approval.claim,
    binding: input.binding,
    nowMs: input.nowMs,
  });
}
