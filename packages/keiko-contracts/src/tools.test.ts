import { describe, expect, it } from "vitest";
import { DEFAULT_COMMAND_RULES, isValidNetworkGatewayPolicy } from "./tools.js";

// Codex-sweep finding (same bug class as command-runner.ts's COMMAND_TASK_RULES, KEIKO-0139):
// Object.freeze on the DEFAULT_COMMAND_RULES array only freezes the array's own indices, not the
// rule objects it holds. Several nested arrays inside each rule (allowedSubcommands, denyFlags,
// valueFlags, deniedArgumentsBySubcommand) were already individually wrapped in their own
// Object.freeze at declaration time, but the RULE OBJECT ITSELF — and any field on it that was
// NOT individually wrapped — was still writable: `DEFAULT_COMMAND_RULES[0].executable = "rm"`
// succeeded, which could redirect an allowlisted rule's identity for the rest of the process.
describe("DEFAULT_COMMAND_RULES", () => {
  it("is a non-empty allowlist of read-only-shaped default rules", () => {
    expect(DEFAULT_COMMAND_RULES.length).toBeGreaterThan(0);
    expect(DEFAULT_COMMAND_RULES.map((rule) => rule.executable)).toContain("npm");
  });

  it("freezes each rule object itself, not just the array holding them", () => {
    const [first] = DEFAULT_COMMAND_RULES;
    expect(first).toBeDefined();
    expect(() => {
      (first as { executable: string }).executable = "rm";
    }).toThrow(TypeError);
    expect(DEFAULT_COMMAND_RULES[0]?.executable).toBe(first?.executable);
  });

  // KEIKO-0888: DEFAULT_COMMAND_RULES must be built with the shared `deepFreeze` helper (not a
  // shallow `Object.freeze` on the outer array alone), so every nested rule object is frozen too.
  it("reports every nested rule object as frozen (Object.isFrozen), not just the array", () => {
    expect(Object.isFrozen(DEFAULT_COMMAND_RULES[0])).toBe(true);
  });
});

// #2951: the gateway-allowlist NetworkPolicy variant a long-lived coding sidecar uses to reach
// exactly one loopback destination. Deliberately NOT a general allowlist — a loopback host and a
// single in-range port, nothing else — so the guard must reject every shape that would widen it.
describe("isValidNetworkGatewayPolicy", () => {
  const valid = { mode: "gateway", host: "127.0.0.1", port: 1983 } as const;

  it("accepts an IPv4 loopback host with an in-range port", () => {
    expect(isValidNetworkGatewayPolicy(valid)).toBe(true);
  });

  it("accepts the IPv6 loopback host", () => {
    expect(isValidNetworkGatewayPolicy({ ...valid, host: "::1" })).toBe(true);
  });

  it("accepts the boundary ports 1 and 65535", () => {
    expect(isValidNetworkGatewayPolicy({ ...valid, port: 1 })).toBe(true);
    expect(isValidNetworkGatewayPolicy({ ...valid, port: 65_535 })).toBe(true);
  });

  // Failing-before: before this guard existed there was no way to express "loopback-only, one
  // port" at all, so nothing could distinguish this from a non-loopback destination.
  it.each(["0.0.0.0", "localhost", "::ffff:127.0.0.1", "192.0.2.1", ""])(
    "rejects a non-loopback host %s",
    (host) => {
      expect(isValidNetworkGatewayPolicy({ ...valid, host })).toBe(false);
    },
  );

  it("rejects a missing port", () => {
    const { port: _port, ...withoutPort } = valid;
    expect(isValidNetworkGatewayPolicy(withoutPort)).toBe(false);
  });

  it.each([0, -1, 65_536, 1.5, Number.NaN, "1983"])("rejects an invalid port %s", (port) => {
    expect(isValidNetworkGatewayPolicy({ ...valid, port })).toBe(false);
  });

  it("rejects the wrong discriminant and extra/unknown fields", () => {
    expect(isValidNetworkGatewayPolicy({ ...valid, mode: "none" })).toBe(false);
    expect(isValidNetworkGatewayPolicy({ ...valid, extra: "widen-me" })).toBe(false);
  });

  it("rejects non-object and malformed inputs", () => {
    for (const hostile of [null, undefined, "gateway", 42, [], []])
      expect(isValidNetworkGatewayPolicy(hostile)).toBe(false);
  });
});
