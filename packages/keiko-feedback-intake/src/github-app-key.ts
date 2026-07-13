import { createHash, createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { readSecureOperatorFile } from "./github-secure-file.js";

const MAX_PEM_BYTES = 16 * 1024;
const KEY_ERROR = "GitHub App signing is unavailable";

export interface GithubAppSignerSnapshot {
  readonly keyId: string;
  readonly rotatedAt: Date;
  signRs256(payload: Uint8Array): Uint8Array;
}

export interface GithubAppPrivateKeyMetadata {
  readonly asymmetricKeyType?: string;
  readonly asymmetricKeyDetails?: { readonly modulusLength?: number };
}

export function isAcceptableGithubAppPrivateKey(key: GithubAppPrivateKeyMetadata): boolean {
  return key.asymmetricKeyType === "rsa" && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048;
}

function signer(key: KeyObject, keyId: string, rotatedAt: Date): GithubAppSignerSnapshot {
  return Object.freeze({
    keyId,
    rotatedAt: new Date(rotatedAt),
    signRs256(payload: Uint8Array): Uint8Array {
      const signature = createSign("RSA-SHA256").update(payload).end().sign(key);
      return Uint8Array.from(signature);
    },
  });
}

function loadPrivateKey(path: string): KeyObject {
  try {
    const key = createPrivateKey({ key: readSecureOperatorFile(path, MAX_PEM_BYTES) });
    if (!isAcceptableGithubAppPrivateKey(key)) throw new Error("invalid key");
    return key;
  } catch {
    throw new Error(KEY_ERROR);
  }
}

export function validateGithubAppPrivateKeyFile(path: string): void {
  void loadPrivateKey(path);
}

export class GithubAppPrivateKeyProvider {
  constructor(
    private readonly path: string,
    private readonly rotatedAt: Date,
  ) {}

  snapshot(now: Date): GithubAppSignerSnapshot {
    const age = now.getTime() - this.rotatedAt.getTime();
    if (age < 0 || age > 90 * 86_400_000) throw new Error(KEY_ERROR);
    try {
      const key = loadPrivateKey(this.path);
      const publicJwk = key.export({ format: "jwk" });
      const fingerprint = createHash("sha256")
        .update(`${publicJwk.n ?? ""}.${publicJwk.e ?? ""}`)
        .digest("hex")
        .slice(0, 24);
      return signer(key, `rsa:${fingerprint}`, this.rotatedAt);
    } catch {
      throw new Error(KEY_ERROR);
    }
  }
}
