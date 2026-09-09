import {
  CODING_RUNTIME_GIT_MAX_PATHS,
  isCodingRuntimeGitPath,
} from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-git";
import { isDenied } from "@oscharko-dev/keiko-workspace";
import type { CodingToolRequestIdentity } from "./codingToolIpc.js";
export type RuntimeGitRequest = CodingToolRequestIdentity & { readonly action: "git" } & (
    | { readonly operation: "status" }
    | {
        readonly operation: "diff";
        readonly scope: "working-tree" | "index";
        readonly paths: readonly string[];
      }
    | { readonly operation: "stage"; readonly phase: "propose"; readonly paths: readonly string[] }
    | { readonly operation: "stage"; readonly phase: "execute"; readonly proposalId: string }
  );
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
  if (value.operation !== "stage") return undefined;
  if (value.phase === "propose" && exact(value, ["phase", "paths"]) && runtimeGitPaths(value.paths))
    return { ...base, operation: "stage", phase: "propose", paths: value.paths };
  return stageExecution(value, base);
}
function stageExecution(
  value: Record<string, unknown>,
  base: CodingToolRequestIdentity & { readonly action: "git" },
): RuntimeGitRequest | undefined {
  if (
    value.phase === "execute" &&
    exact(value, ["phase", "proposalId"]) &&
    typeof value.proposalId === "string" &&
    /^stage-\d{1,39}$/u.test(value.proposalId)
  )
    return { ...base, operation: "stage", phase: "execute", proposalId: value.proposalId };
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
