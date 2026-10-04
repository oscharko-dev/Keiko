import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { ChatConnectedScope } from "@/lib/types";

function normalizedRoot(root: string): string {
  const forward = root.replaceAll("\\", "/");
  if (/^[A-Za-z]:\/?$/u.test(forward)) return forward;
  let end = forward.length;
  while (end > 0 && forward.charAt(end - 1) === "/") end -= 1;
  return forward.slice(0, end);
}

function normalizedRelativePath(path: string): string {
  const forward = path.replaceAll("\\", "/");
  let start = 0;
  let end = forward.length;
  while (start < end && forward.charAt(start) === "/") start += 1;
  while (end > start && forward.charAt(end - 1) === "/") end -= 1;
  return forward.slice(start, end);
}

/** A comparison identity only; it never authorizes a workspace read. */
export function connectedScopeIdentity(scope: ChatConnectedScope | null): string | null {
  if (scope?.root === undefined) return null;
  return JSON.stringify([
    normalizedRoot(scope.root),
    scope.kind,
    scope.relativePaths.map(normalizedRelativePath),
  ]);
}

/** Preserve the acknowledged edge's identity without persisting its raw paths. */
export function connectedScopeFingerprint(scope: ChatConnectedScope): string | undefined {
  const identity = connectedScopeIdentity(scope);
  return identity === null
    ? undefined
    : bytesToHex(sha256(utf8ToBytes(`keiko-files-scope-reference-v1\u0000${identity}`)));
}

export function isConnectedScopeFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
