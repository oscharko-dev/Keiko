import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  chatConnectedScopeFingerprintInput,
  type ChatConnectedScope,
} from "@oscharko-dev/keiko-contracts/bff-wire";

/** Preserve the acknowledged edge's identity without persisting its raw paths. */
export function connectedScopeFingerprint(
  scope: ChatConnectedScope & { readonly root: string },
): string;
export function connectedScopeFingerprint(scope: ChatConnectedScope): string | undefined;
export function connectedScopeFingerprint(scope: ChatConnectedScope): string | undefined {
  const input = chatConnectedScopeFingerprintInput(scope);
  return input === undefined ? undefined : bytesToHex(sha256(utf8ToBytes(input)));
}

export function isConnectedScopeFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
