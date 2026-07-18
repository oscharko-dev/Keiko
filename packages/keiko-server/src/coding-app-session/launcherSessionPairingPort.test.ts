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
