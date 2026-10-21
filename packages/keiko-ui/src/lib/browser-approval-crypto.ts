"use client";

import {
  browserApprovalChallengeText,
  isBrowserApprovalPublicKey,
  validateBrowserApprovalChallenge,
  validateBrowserApprovalProofInput,
  type BrowserApprovalChallenge,
  type BrowserApprovalProofInput,
  type BrowserApprovalPublicKey,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { observeBrowserApproval } from "./browser-approval-evidence";

export interface BrowserApprovalKey {
  readonly privateKey: CryptoKey;
  readonly publicKey: BrowserApprovalPublicKey;
}

export interface BrowserChallengeBinding {
  readonly purpose: "complete" | "renew";
  readonly subjectId: string;
  readonly origin: string;
  readonly installationId?: string | undefined;
}

export function isBrowserApprovalPrivateKey(value: unknown): value is CryptoKey {
  if (typeof CryptoKey === "undefined" || !(value instanceof CryptoKey)) return false;
  const algorithm = value.algorithm;
  return (
    value.type === "private" &&
    !value.extractable &&
    algorithm.name === "ECDSA" &&
    "namedCurve" in algorithm &&
    algorithm.namedCurve === "P-256" &&
    value.usages.length === 1 &&
    value.usages[0] === "sign"
  );
}

export function createBrowserApprovalKey(
  parentCorrelationId?: string,
): Promise<BrowserApprovalKey> {
  return observeBrowserApproval(
    "key-create",
    async () => {
      if (globalThis.crypto?.subtle === undefined)
        throw new DOMException("Browser approval keys are unavailable.", "NotSupportedError");
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
        "sign",
        "verify",
      ]);
      const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
      const publicKey = { x: jwk.x, y: jwk.y };
      if (!isBrowserApprovalPublicKey(publicKey) || !isBrowserApprovalPrivateKey(pair.privateKey))
        throw new TypeError("Browser approval key shape is invalid.");
      return { value: { privateKey: pair.privateKey, publicKey }, outcome: "created" };
    },
    parentCorrelationId,
  );
}

function assertChallengeBinding(
  challenge: BrowserApprovalChallenge,
  binding: BrowserChallengeBinding,
): void {
  if (!validateBrowserApprovalChallenge(challenge).ok)
    throw new TypeError("Browser approval challenge is invalid.");
  if (
    challenge.purpose !== binding.purpose ||
    challenge.subjectId !== binding.subjectId ||
    challenge.origin !== binding.origin
  )
    throw new TypeError("Browser approval challenge binding changed.");
  if (binding.installationId !== undefined && challenge.installationId !== binding.installationId)
    throw new TypeError("Browser approval installation changed.");
}

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCodePoint(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function signBrowserApprovalChallenge(
  key: CryptoKey,
  challenge: BrowserApprovalChallenge,
  binding: BrowserChallengeBinding,
  parentCorrelationId?: string,
): Promise<BrowserApprovalProofInput> {
  return observeBrowserApproval(
    "proof-sign",
    async () => {
      if (!isBrowserApprovalPrivateKey(key))
        throw new TypeError("Browser approval key is invalid.");
      assertChallengeBinding(challenge, binding);
      const bytes = new TextEncoder().encode(browserApprovalChallengeText(challenge));
      const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bytes);
      assertChallengeBinding(challenge, binding);
      if (signature.byteLength !== 64)
        throw new TypeError("Browser approval signature size is invalid.");
      const proof = { challengeId: challenge.challengeId, signature: base64url(signature) };
      if (!validateBrowserApprovalProofInput(proof).ok)
        throw new TypeError("Browser approval signature is invalid.");
      return { value: proof, outcome: "signed" };
    },
    parentCorrelationId,
  );
}
