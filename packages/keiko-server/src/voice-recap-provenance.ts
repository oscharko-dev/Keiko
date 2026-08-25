import { createHash, randomUUID } from "node:crypto";
import type { VoiceProfile } from "@oscharko-dev/keiko-contracts";

const DEFAULT_ATTESTATION_TTL_MS = 5 * 60 * 1_000;

interface StoredAttestation {
  readonly profile: "speech-to-text";
  readonly sessionId: string;
  readonly spansDigest: string;
  readonly expiresAtMs: number;
  consumed: boolean;
}

export interface VoiceRecapContentAttestationStore {
  attest(input: {
    readonly profile: "speech-to-text";
    readonly sessionId: string;
    readonly committedSpans: readonly string[];
    readonly expiresAtMs?: number;
  }): string;
  consume(input: {
    readonly profile: VoiceProfile;
    readonly sessionId: string;
    readonly committedSpans: readonly string[];
    readonly proof: string;
  }): "attested" | "expired" | "invalid" | "replayed";
}

function spansDigest(spans: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(String(spans.length), "utf8");
  for (const span of spans) {
    hash.update(":", "utf8");
    hash.update(String(Buffer.byteLength(span, "utf8")), "utf8");
    hash.update(":", "utf8");
    hash.update(span, "utf8");
  }
  return hash.digest("hex");
}

export function createVoiceRecapContentAttestationStore(
  now: () => number = Date.now,
): VoiceRecapContentAttestationStore {
  const attestations = new Map<string, StoredAttestation>();

  return {
    attest(input): string {
      const proof = randomUUID();
      attestations.set(proof, {
        profile: input.profile,
        sessionId: input.sessionId,
        spansDigest: spansDigest(input.committedSpans),
        expiresAtMs: input.expiresAtMs ?? now() + DEFAULT_ATTESTATION_TTL_MS,
        consumed: false,
      });
      return proof;
    },
    consume(input): "attested" | "expired" | "invalid" | "replayed" {
      const attestation = attestations.get(input.proof);
      if (attestation === undefined) return "invalid";
      if (attestation.consumed) return "replayed";
      if (attestation.expiresAtMs < now()) return "expired";
      if (
        input.profile !== attestation.profile ||
        input.sessionId !== attestation.sessionId ||
        spansDigest(input.committedSpans) !== attestation.spansDigest
      ) {
        return "invalid";
      }
      attestation.consumed = true;
      return "attested";
    },
  };
}
