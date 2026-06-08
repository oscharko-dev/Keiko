// Typed error for the secretbox authenticated-encryption primitive. A single stable `code`
// discriminant so callers can branch on the failure class without parsing the message. The
// message is intentionally generic — it never echoes key material, plaintext, or ciphertext, so
// it is always safe to log across a trust boundary. An auth-tag mismatch (tampered ciphertext OR
// wrong key) and a malformed envelope both surface here; we do NOT distinguish "wrong key" from
// "tampered" by design, because telling an attacker which one failed is an oracle.

export class SecretboxError extends Error {
  public readonly code = "SECRETBOX_OPEN_FAILED" as const;

  public constructor(message: string) {
    super(message);
    this.name = "SecretboxError";
  }
}
