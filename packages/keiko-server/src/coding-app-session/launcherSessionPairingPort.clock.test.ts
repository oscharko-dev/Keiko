import { describe, expect, it } from "vitest";
import {
  createLauncherSessionPairingPort,
  mintLauncherPairingAttestation,
} from "./launcherSessionPairingPort.js";
import { createCodingAppSessionChannel } from "./sessionChannel.js";
import { createSessionRegistry } from "./sessionRegistry.js";

const SECRET = "synthetic-process-bound-launcher-secret-32-chars";
const START = 1_000_000;

function claim(
  requestId: string,
  issuedAtMs: number,
): ReturnType<typeof mintLauncherPairingAttestation> {
  return mintLauncherPairingAttestation({ secret: SECRET, requestId, issuedAtMs });
}

describe("launcher pairing clock safety", () => {
  it("cannot mint a second session by rewinding after a consumed claim was pruned", () => {
    let now = START;
    const channel = createCodingAppSessionChannel({
      registry: createSessionRegistry({ now: () => now }),
      pairingPort: createLauncherSessionPairingPort({ secret: SECRET, now: () => now }),
    });
    const original = claim("original_request", now);
    const first = channel.pair(original);
    expect(first.paired).toBe(true);
    expect(channel.pair(original)).toEqual({ paired: false });
    now += 30_001;
    expect(channel.pair(original)).toEqual({ paired: false });
    now = START;
    expect(channel.pair(original)).toEqual({ paired: false });
    expect(channel.pair(claim("fresh_but_clock_rewound", now))).toEqual({ paired: false });
    expect(channel.sessionCount()).toBe(1);
    if (!first.paired) throw new TypeError("Expected the reachable healthy pairing control");
    expect(channel.verifySession(first.cookieToken)).toBeDefined();
    now = START + 30_001;
    expect(channel.pair(original)).toEqual({ paired: false });
    expect(channel.pair(claim("fresh_after_clock_recovery", now)).paired).toBe(true);
    expect(channel.sessionCount()).toBe(2);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "refuses invalid clock %s without losing replay state or blocking recovery",
    (invalidNow) => {
      let now = START;
      const port = createLauncherSessionPairingPort({ secret: SECRET, now: () => now });
      const original = claim("original_request", now);
      expect(port.attest(original).outcome).toBe("approved");
      now = invalidNow;
      expect(port.attest(claim("invalid_clock_request", START)).outcome).toBe("denied");
      now = START;
      expect(port.attest(original).outcome).toBe("denied");
      expect(port.attest(claim("fresh_after_invalid_clock", now)).outcome).toBe("approved");
    },
  );

  it("preserves inclusive freshness and permits equal or increasing observed time", () => {
    let now = START;
    const port = createLauncherSessionPairingPort({ secret: SECRET, now: () => now });
    const original = claim("original_request", now);
    expect(port.attest(original).outcome).toBe("approved");
    expect(port.attest(claim("same_clock_request", now)).outcome).toBe("approved");
    now += 30_000;
    expect(port.attest(original).outcome).toBe("denied");
    expect(port.attest(claim("inclusive_past_boundary", START)).outcome).toBe("approved");
    expect(port.attest(claim("inclusive_future_boundary", now + 30_000)).outcome).toBe("approved");
    now += 1;
    expect(port.attest(claim("expired_request", START)).outcome).toBe("denied");
    expect(port.attest(claim("current_request", now)).outcome).toBe("approved");
  });
});
