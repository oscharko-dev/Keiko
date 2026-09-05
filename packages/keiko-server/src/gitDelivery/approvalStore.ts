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
// "authority-admission" (#3386, ADR-0138 D2) was REMOVED (final-audit F2/#3390): it was meant as a
// coarse, run-identity-bound claim redeemed by `runBoundAuthority.authorizeGitDelivery`'s own
// "approval-required" disposition for a lower mode, but no production HTTP route ever minted a
// claim bound to it (`grep -rn 'operation: "authority-admission"' packages/keiko-server/src` before
// this fix matched only this file's own type declaration and unit tests that hand-built the
// binding) -- there was no `/approve`-equivalent endpoint for it, so every lower-mode delivery
// admission was permanently unredeemable. `requestPreparation.ts`'s `gitDeliveryApprovalRedemption`
// now redeems "approval-required" two ways instead: (1) `deliveryApprovalDeferred` defers to the
// operation's OWN mandatory, mode-independent execute-time approval consumption (commit, push, pr,
// merge, pr-mark-ready, pr-description-apply all already enforce this unconditionally -- see
// policyPackMintability.ts), so the coarse gate does not need a second, redundant claim; (2) a
// non-consuming peek (`matches`) against the SAME per-operation claim the route already parses from
// its own request body, for operations without such downstream enforcement (local-mutation, and —
// final-audit F2 repair — fetch/pull, which are bounded network operations with no `GitDeliveryActionKind`
// / kernel policy pack of their own to defer to; see syncRoutes.ts). Both reuse the existing
// per-operation claim shapes below; neither needs a new token kind.
// "pr-mark-ready" (#3389, epic #3384 correction 7): the draft->ready transition, deliberately a
// SEPARATE operation from "pr" so the generic pr-update admission (convertFromDraft) can never
// redeem it — the bound command carries the exact facts (repository, PR identity, base/head SHAs,
// readiness digest, transition-payload digest) re-verified immediately before execution.
// "fetch" / "pull" (final-audit F2 repair, #3390): bound to `{projectId, operation, command}` only —
// no run identity — mirroring "local-mutation" exactly, since either operation is admitted via the
// SAME non-consuming-peek-then-consume mechanism. syncRoutes.ts owns their guarded HTTP mint routes.
export type GitDeliveryApprovalOperation =
  | "local-mutation"
  | "commit"
  | "push"
  | "pr"
  | "merge"
  | "pr-description-apply"
  | "pr-mark-ready"
  | "fetch"
  | "pull";

export interface GitDeliveryApprovalBinding {
  readonly projectId: string;
  readonly operation: GitDeliveryApprovalOperation;
  readonly command: unknown;
  // Present for approval-gated delivery operations. The server-owned active-run identity joins the
  // durable human proof to the exact Authority Envelope that admitted both mint and redemption.
  readonly runId?: string | undefined;
  readonly envelopeDigest?: string | undefined;
  readonly workspaceDigest?: string;
  readonly repositoryDigest?: string;
  readonly baseSha?: string;
  readonly headSha?: string;
  readonly stagedTreeDigest?: string;
  readonly verificationEvidenceId?: string;
  readonly proposalId?: string;
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
  matches(input: GitDeliveryApprovalConsumeInput): boolean;
  /** Server-only continuation of an already approved exact runtime commit; never an HTTP claim. */
  matchesCommitBinding(binding: GitDeliveryApprovalBinding, nowMs: number): boolean;
  consumeCommitBinding(
    binding: GitDeliveryApprovalBinding,
    nowMs: number,
  ): GitDeliveryApprovalRequirement | undefined;
  matchesStageBinding?(binding: GitDeliveryApprovalBinding, nowMs: number): boolean;
  consumeStageBinding?(
    binding: GitDeliveryApprovalBinding,
    nowMs: number,
  ): GitDeliveryApprovalRequirement | undefined;
  matchesDeliveryBinding?(binding: GitDeliveryApprovalBinding, nowMs: number): boolean;
  consumeDeliveryBinding?(
    binding: GitDeliveryApprovalBinding,
    nowMs: number,
  ): GitDeliveryApprovalRequirement | undefined;
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

function revokeMatchingBindingRecords(
  records: Map<string, StoredApprovalRecord>,
  bindingHash: string,
): void {
  for (const [id, record] of records) {
    if (record.bindingHash === bindingHash) records.delete(id);
  }
}

function matchingRecord(
  records: Map<string, StoredApprovalRecord>,
  input: GitDeliveryApprovalConsumeInput,
): StoredApprovalRecord | undefined {
  const record = records.get(input.approval.approvalId);
  if (record === undefined || record.expiresAtMs <= input.nowMs) return undefined;
  if (record.bindingHash !== gitDeliveryApprovalBindingHash(input.binding)) return undefined;
  return constantTimeHexEqual(record.tokenHash, hashToken(input.approval.approvalToken))
    ? record
    : undefined;
}

function commitBindingRecord(
  records: Map<string, StoredApprovalRecord>,
  binding: GitDeliveryApprovalBinding,
  nowMs: number,
  operation: "commit" | "local-mutation" | "push" | "pr" = "commit",
): readonly [string, StoredApprovalRecord] | undefined {
  if (
    binding.operation !== operation ||
    binding.proposalId === undefined ||
    binding.runId === undefined ||
    binding.envelopeDigest === undefined
  )
    return undefined;
  const digest = gitDeliveryApprovalBindingHash(binding);
  return [...records].find(
    ([, record]) => record.bindingHash === digest && record.expiresAtMs > nowMs,
  );
}
function requirementFor(record: StoredApprovalRecord): GitDeliveryApprovalRequirement {
  return {
    required: true,
    approvalTokenHash: record.tokenHash,
    approvedByUserId: record.approvedByUserId,
    approvedAtMs: record.approvedAtMs,
    expiresAtMs: record.expiresAtMs,
  };
}

type GitDeliveryCommitLikeOperation = "commit" | "local-mutation" | "push" | "pr";

// F31 (final-audit, simplicity-and-reuse): `matchesStageBinding`/`consumeStageBinding`,
// `matchesDeliveryBinding`/`consumeDeliveryBinding`, and `matchesCommitBinding`/
// `consumeCommitBinding` were three copy-paste-identical pairs (prune, then `commitBindingRecord`
// filtered by an operation set, then -- for consume -- delete + `requirementFor`) differing only in
// which operation(s) they accept. Collapsed into this one parameterized pair; callers below become
// one-line wrappers naming their own allowed operation set, and every external caller (
// `draftDeliveryService.ts`, `runtimeGitService.ts`, `verifiedCommitService.ts`) is unchanged since
// the method names and signatures on `GitDeliveryApprovalStore` did not change.
function matchesOperationBinding(
  records: Map<string, StoredApprovalRecord>,
  binding: GitDeliveryApprovalBinding,
  nowMs: number,
  maxRecords: number,
  allowed: readonly GitDeliveryCommitLikeOperation[],
): boolean {
  pruneExpired(records, nowMs, maxRecords);
  const operation = binding.operation;
  if (!(allowed as readonly string[]).includes(operation)) return false;
  return (
    commitBindingRecord(records, binding, nowMs, operation as GitDeliveryCommitLikeOperation) !==
    undefined
  );
}

function consumeOperationBinding(
  records: Map<string, StoredApprovalRecord>,
  binding: GitDeliveryApprovalBinding,
  nowMs: number,
  maxRecords: number,
  allowed: readonly GitDeliveryCommitLikeOperation[],
): GitDeliveryApprovalRequirement | undefined {
  pruneExpired(records, nowMs, maxRecords);
  const operation = binding.operation;
  if (!(allowed as readonly string[]).includes(operation)) return undefined;
  const matched = commitBindingRecord(
    records,
    binding,
    nowMs,
    operation as GitDeliveryCommitLikeOperation,
  );
  if (matched === undefined) return undefined;
  records.delete(matched[0]);
  return requirementFor(matched[1]);
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
      const bindingHash = gitDeliveryApprovalBindingHash(input.binding);
      revokeMatchingBindingRecords(records, bindingHash);
      const approvalId = `gda_${randomBytes(16).toString("hex")}`;
      const approvalToken = randomBytes(32).toString("hex");
      const tokenHash = hashToken(approvalToken);
      const expiresAtMs = nowMs + (input.ttlMs ?? ttlMs);
      records.set(approvalId, {
        bindingHash,
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
    matchesStageBinding(binding, nowMs): boolean {
      return matchesOperationBinding(records, binding, nowMs, maxRecords, ["local-mutation"]);
    },
    consumeStageBinding(binding, nowMs): GitDeliveryApprovalRequirement | undefined {
      return consumeOperationBinding(records, binding, nowMs, maxRecords, ["local-mutation"]);
    },
    matchesDeliveryBinding(binding, nowMs): boolean {
      return matchesOperationBinding(records, binding, nowMs, maxRecords, ["push", "pr"]);
    },
    consumeDeliveryBinding(binding, nowMs): GitDeliveryApprovalRequirement | undefined {
      return consumeOperationBinding(records, binding, nowMs, maxRecords, ["push", "pr"]);
    },
    matchesCommitBinding(binding, nowMs): boolean {
      return matchesOperationBinding(records, binding, nowMs, maxRecords, ["commit"]);
    },
    consumeCommitBinding(binding, nowMs): GitDeliveryApprovalRequirement | undefined {
      return consumeOperationBinding(records, binding, nowMs, maxRecords, ["commit"]);
    },
    matches(input): boolean {
      pruneExpired(records, input.nowMs, maxRecords);
      return matchingRecord(records, input) !== undefined;
    },
    consume(input): GitDeliveryApprovalRequirement | undefined {
      pruneExpired(records, input.nowMs, maxRecords);
      const record = matchingRecord(records, input);
      if (record === undefined) return undefined;
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
