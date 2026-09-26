import { describe, expect, it } from "vitest";

import {
  SESSION_PAIRING_LAUNCHER_SECRET_ENV,
  computeLauncherPairingClaim,
  createLauncherSessionPairingPort,
  mintLauncherPairingAttestation,
  resolveLauncherSessionPairingPort,
} from "./launcherSessionPairingPort.js";

const SECRET = "launcher-secret-that-is-long-enough-32+chars";

describe("createLauncherSessionPairingPort", () => {
  it("approves a fresh, correctly-signed attestation", () => {
    const port = createLauncherSessionPairingPort({ secret: SECRET, now: () => 1_000 });
    const attestation = mintLauncherPairingAttestation({
      secret: SECRET,
      requestId: "req_one",
      issuedAtMs: 1_000,
    });
    expect(port.attest(attestation)).toEqual({
      outcome: "approved",
      principalLabel: "local-app-session",
    });
  });

  it("denies a claim signed with the wrong secret", () => {
    const port = createLauncherSessionPairingPort({ secret: SECRET, now: () => 1_000 });
    const forged = mintLauncherPairingAttestation({
      secret: "a-different-secret-that-is-also-32+chars-x",
      requestId: "req_two",
      issuedAtMs: 1_000,
    });
    expect(port.attest(forged).outcome).toBe("denied");
  });

  it("denies a tampered claim", () => {
    const port = createLauncherSessionPairingPort({ secret: SECRET, now: () => 1_000 });
    const attestation = mintLauncherPairingAttestation({
      secret: SECRET,
      requestId: "req_three",
      issuedAtMs: 1_000,
    });
    expect(
      port.attest({ ...attestation, claim: `${attestation.claim.slice(0, -1)}0` }).outcome,
    ).toBe("denied");
  });

  it("denies replay of an already-consumed request id", () => {
    const port = createLauncherSessionPairingPort({ secret: SECRET, now: () => 1_000 });
    const attestation = mintLauncherPairingAttestation({
      secret: SECRET,
      requestId: "req_replay",
      issuedAtMs: 1_000,
    });
    expect(port.attest(attestation).outcome).toBe("approved");
    expect(port.attest(attestation).outcome).toBe("denied");
  });

  it("denies a stale attestation outside the freshness window", () => {
    const port = createLauncherSessionPairingPort({
      secret: SECRET,
      now: () => 1_000_000,
      claimFreshnessMs: 1_000,
    });
    const attestation = mintLauncherPairingAttestation({
      secret: SECRET,
      requestId: "req_stale",
      issuedAtMs: 500_000,
    });
    expect(port.attest(attestation).outcome).toBe("denied");
  });

  it("denies a malformed attestation before evaluating authority", () => {
    const port = createLauncherSessionPairingPort({ secret: SECRET, now: () => 1_000 });
    expect(port.attest({ requestId: "bad id!", issuedAtMs: 1_000, claim: "x" }).outcome).toBe(
      "denied",
    );
  });

  it("computes a stable claim for the same inputs", () => {
    expect(computeLauncherPairingClaim(SECRET, "req_x", 5)).toBe(
      computeLauncherPairingClaim(SECRET, "req_x", 5),
    );
    expect(computeLauncherPairingClaim(SECRET, "req_x", 5)).not.toBe(
      computeLauncherPairingClaim(SECRET, "req_x", 6),
    );
  });

  // Regression: PR #3099 R3 KfQ Major. Prune runs at the top of attest so a stream of stale-only
  // attestations (each rejected at isFresh) does not hoard the cap slots and starve a later
  // legitimate fresh attestation. Without this, availability degrades over long-lived processes.
  it("prunes stale entries even when the incoming attestation itself is stale", () => {
    let currentNow = 1_000;
    const port = createLauncherSessionPairingPort({
      secret: SECRET,
      now: () => currentNow,
      claimFreshnessMs: 5_000,
    });
    // Fill the cap with fresh attestations.
    for (let index = 0; index < 4_096; index += 1) {
      const attestation = mintLauncherPairingAttestation({
        secret: SECRET,
        requestId: `req_burst_${String(index)}`,
        issuedAtMs: currentNow,
      });
      expect(port.attest(attestation).outcome).toBe("approved");
    }
    // Advance past the freshness window; all entries are now prunable.
    currentNow += 10_000;
    // Fire a stale attestation. In the old code (prune after isFresh) this would return
    // "denied" without pruning, leaving the map full. In the new code (prune first) the stale
    // entries evict, but this stale attestation still returns "denied" via isFresh.
    const stale = mintLauncherPairingAttestation({
      secret: SECRET,
      requestId: "req_stale",
      issuedAtMs: currentNow - 20_000,
    });
    expect(port.attest(stale).outcome).toBe("denied");
    // Now a legitimate fresh attestation must succeed — before the fix it would be denied by
    // the cap gate because the stale burst's slots were never pruned.
    const fresh = mintLauncherPairingAttestation({
      secret: SECRET,
      requestId: "req_after_stale_burst",
      issuedAtMs: currentNow,
    });
    expect(port.attest(fresh).outcome).toBe("approved");
  });

  // Regression: KEIKO-0460. The anti-replay set previously grew unbounded and, once past the cap,
  // permanently denied every attestation for the rest of the process's life — including ones
  // whose ids could no longer be replayed under `isFresh`. Prune expired ids before the cap gate.
  it("prunes anti-replay ids whose freshness window has elapsed so the cap never becomes permanent", () => {
    let currentNow = 1_000;
    const port = createLauncherSessionPairingPort({
      secret: SECRET,
      now: () => currentNow,
      claimFreshnessMs: 5_000,
    });
    for (let index = 0; index < 4_096; index += 1) {
      const attestation = mintLauncherPairingAttestation({
        secret: SECRET,
        requestId: `req_${String(index)}`,
        issuedAtMs: currentNow,
      });
      expect(port.attest(attestation).outcome).toBe("approved");
    }
    const overflow = mintLauncherPairingAttestation({
      secret: SECRET,
      requestId: "req_full",
      issuedAtMs: currentNow,
    });
    expect(port.attest(overflow).outcome).toBe("denied");
    // Advance past the freshness window on every tracked id and try again.
    currentNow += 10_000;
    const afterDrain = mintLauncherPairingAttestation({
      secret: SECRET,
      requestId: "req_after_drain",
      issuedAtMs: currentNow,
    });
    expect(port.attest(afterDrain).outcome).toBe("approved");
  });
});

describe("resolveLauncherSessionPairingPort", () => {
  it("returns undefined (fail closed) without a launcher secret", () => {
    expect(resolveLauncherSessionPairingPort({})).toBeUndefined();
  });

  it("returns undefined when the launcher secret is too short", () => {
    expect(
      resolveLauncherSessionPairingPort({ [SESSION_PAIRING_LAUNCHER_SECRET_ENV]: "short" }),
    ).toBeUndefined();
  });

  it("builds a working port from a sufficiently long launcher secret", () => {
    const port = resolveLauncherSessionPairingPort({
      [SESSION_PAIRING_LAUNCHER_SECRET_ENV]: SECRET,
    });
    expect(port).toBeDefined();
    const attestation = mintLauncherPairingAttestation({
      secret: SECRET,
      requestId: "req_env",
      issuedAtMs: Date.now(),
    });
    expect(port?.attest(attestation).outcome).toBe("approved");
  });
});
