import {
  CODING_RUNTIME_GIT_MAX_PATHS,
  isCodingRuntimeGitPath,
} from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-git";
import { isDenied } from "@oscharko-dev/keiko-workspace";
import type { CodingToolApprovalProof, CodingToolRequestIdentity } from "./codingToolIpc.js";
export type RuntimeGitRequest = CodingToolRequestIdentity & { readonly action: "git" } & (
    | { readonly operation: "status" }
    // #3902 AC2: one fetch, or one fast-forward pull from the upstream, through the Git sync owner;
    // a narrower mode redeems the operator's approval of this exact call.
    | { readonly operation: "fetch"; readonly approvalProof?: CodingToolApprovalProof | undefined }
    | { readonly operation: "pull"; readonly approvalProof?: CodingToolApprovalProof | undefined }
    | {
        readonly operation: "diff";
        readonly scope: "working-tree" | "index";
        readonly paths: readonly string[];
      }
    | {
        readonly operation: RuntimeGitIndexOperation;
        readonly phase: "propose";
        readonly paths: readonly string[];
      }
    | {
        readonly operation: RuntimeGitIndexOperation;
        readonly phase: "execute";
        readonly proposalId: string;
      }
  );
/** The proposals that change the index: staging and, its inverse, unstaging (#3902 AC2). */
export type RuntimeGitIndexOperation = "stage" | "unstage";
/** The remote synchronizations the runtime may ask the Git sync owner for (#3902 AC2). */
export type RuntimeGitSyncOperation = "fetch" | "pull";

export function isRuntimeGitSyncOperation(value: unknown): value is RuntimeGitSyncOperation {
  return value === "fetch" || value === "pull";
}
const PROPOSAL_ID: Readonly<Record<RuntimeGitIndexOperation, RegExp>> = {
  stage: /^stage-\d{1,39}$/u,
  unstage: /^unstage-\d{1,39}$/u,
};
const BASE_KEYS = ["action", "actionId", "idempotencyKey", "operation"];
function exact(value: Record<string, unknown>, extra: readonly string[]): boolean {
  const keys = [...BASE_KEYS, ...extra];
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
export function runtimeGitPaths(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= CODING_RUNTIME_GIT_MAX_PATHS &&
    new Set(value).size === value.length &&
    value.every((path) => isCodingRuntimeGitPath(path) && !path.endsWith("/") && !isDenied(path))
  );
}
export function snapshotRuntimeGitRequest(request: RuntimeGitRequest): RuntimeGitRequest {
  return Object.freeze(
    "paths" in request ? { ...request, paths: Object.freeze([...request.paths]) } : { ...request },
  );
}
export function parseRuntimeGitRequest(
  value: Record<string, unknown>,
  identity: CodingToolRequestIdentity,
): RuntimeGitRequest | undefined {
  const request = parseValidatedRuntimeGitRequest(value, identity);
  return request === undefined ? undefined : snapshotRuntimeGitRequest(request);
}
function parseValidatedRuntimeGitRequest(
  value: Record<string, unknown>,
  identity: CodingToolRequestIdentity,
): RuntimeGitRequest | undefined {
  const base = { ...identity, action: "git" } as const;
  if (value.operation === "status")
    return exact(value, []) ? { ...base, operation: "status" } : undefined;
  if (value.operation === "diff") return diffRequest(value, base);
  if (value.operation !== "stage" && value.operation !== "unstage") return undefined;
  const operation = value.operation;
  if (value.phase === "propose" && exact(value, ["phase", "paths"]) && runtimeGitPaths(value.paths))
    return { ...base, operation, phase: "propose", paths: value.paths };
  return indexExecution(value, base, operation);
}
function indexExecution(
  value: Record<string, unknown>,
  base: CodingToolRequestIdentity & { readonly action: "git" },
  operation: RuntimeGitIndexOperation,
): RuntimeGitRequest | undefined {
  if (
    value.phase === "execute" &&
    exact(value, ["phase", "proposalId"]) &&
    typeof value.proposalId === "string" &&
    PROPOSAL_ID[operation].test(value.proposalId)
  )
    return { ...base, operation, phase: "execute", proposalId: value.proposalId };
  return undefined;
}
function diffRequest(
  value: Record<string, unknown>,
  base: CodingToolRequestIdentity & { readonly action: "git" },
): RuntimeGitRequest | undefined {
  return exact(value, ["scope", "paths"]) &&
    (value.scope === "working-tree" || value.scope === "index") &&
    runtimeGitPaths(value.paths)
    ? { ...base, operation: "diff", scope: value.scope, paths: value.paths }
    : undefined;
}
