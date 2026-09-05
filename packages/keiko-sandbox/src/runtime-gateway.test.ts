import { describe, expect, it } from "vitest";
import {
  buildRuntimeGatewaySeatbeltCommand,
  createRuntimeGatewayConfinement,
  isRuntimeGatewayConfinement,
  type RuntimeGatewayConfinementInput,
} from "./runtime-gateway.js";

const input: RuntimeGatewayConfinementInput = {
  gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
  runId: "run-2951",
  treeBindingId: "a".repeat(64),
  envelopeDigest: "b".repeat(64),
  runtimeArtifactDigest: "c".repeat(64),
  modelProfileDigest: "d".repeat(64),
};

describe("long-lived gateway network confinement", () => {
  it("rejects accessors without invoking them before compiling a wrapper", () => {
    const policy = createRuntimeGatewayConfinement(input);
    let reads = 0;
    const hostile = Object.defineProperty({ ...policy }, "port", {
      enumerable: true,
      get: (): number => {
        reads += 1;
        return policy.port;
      },
    });
    expect(isRuntimeGatewayConfinement(hostile)).toBe(false);
    expect(() => buildRuntimeGatewaySeatbeltCommand(hostile, "/runtime", [])).toThrow();
    expect(reads).toBe(0);
  });

  it("permits only the authenticated gateway's TCP family/port and denies process/service escapes", () => {
    const policy = createRuntimeGatewayConfinement(input);
    const wrapped = buildRuntimeGatewaySeatbeltCommand(policy, "/trusted/opencode", ["serve"]);
    expect(wrapped.command).toBe("/usr/bin/sandbox-exec");
    expect(wrapped.args).toEqual(["-p", expect.any(String), "/trusted/opencode", "serve"]);
    const profile = wrapped.args[1];
    for (const denied of ["network*", "process-fork", "mach-lookup", "appleevent-send", "lsopen"])
      expect(profile).toContain(`(deny ${denied})`);
    expect(profile).toContain('(remote tcp4 "localhost:1983")');
    expect(profile).toContain('(local tcp4 "localhost:*")');
    expect(profile).not.toContain("unix-socket");
    expect(profile).not.toContain("udp");
    expect(profile).not.toContain('remote tcp4 "localhost:*"');
    expect(Object.isFrozen(policy)).toBe(true);
    expect(JSON.stringify(policy)).not.toContain(input.gatewayUrl);
  });

  it("keeps IPv6 destinations separate from IPv4 and preserves the exact boundary ports", () => {
    for (const port of [1, 65_535]) {
      const policy = createRuntimeGatewayConfinement({
        ...input,
        gatewayUrl: `http://[::1]:${String(port)}/gateway`,
      });
      expect(policy.addressFamily).toBe("ipv6");
      expect(buildRuntimeGatewaySeatbeltCommand(policy, "/runtime", []).args[1]).toContain(
        `(remote tcp6 "localhost:${String(port)}")`,
      );
    }
    expect(
      createRuntimeGatewayConfinement({ ...input, gatewayUrl: "http://127.0.0.1/gateway" }).port,
    ).toBe(80);
  });

  it.each([
    "https://127.0.0.1:1983/gateway",
    "http://localhost:1983/gateway",
    "http://0.0.0.0:1983/gateway",
    "http://192.0.2.1:1983/gateway",
    "http://127.0.0.2:1983/gateway",
    "http://[::ffff:127.0.0.1]:1983/gateway",
    "http://127.0.0.1:0/gateway",
    "http://127.0.0.1:65536/gateway",
    "http://secret@127.0.0.1:1983/gateway",
    "http://127.0.0.1:1983/gateway?token=secret",
    "http://127.0.0.1:1983/gateway#secret",
    "not-a-url",
  ])("rejects an unqualified destination %s", (gatewayUrl) => {
    expect(() => createRuntimeGatewayConfinement({ ...input, gatewayUrl })).toThrow(
      "runtime-gateway-policy-invalid",
    );
  });

  it.each([
    "runId",
    "treeBindingId",
    "envelopeDigest",
    "runtimeArtifactDigest",
    "modelProfileDigest",
  ] as const)("binds the policy to %s and rejects malformed identities", (key) => {
    const policy = createRuntimeGatewayConfinement(input);
    const changed = createRuntimeGatewayConfinement({
      ...input,
      [key]: key === "runId" ? "other-run" : "e".repeat(64),
    });
    expect(changed.policyDigest).not.toBe(policy.policyDigest);
    expect(() => createRuntimeGatewayConfinement({ ...input, [key]: "" })).toThrow();
  });

  it("rejects widening, identity tampering, unknown fields and incomplete policies", () => {
    const policy = createRuntimeGatewayConfinement(input);
    expect(isRuntimeGatewayConfinement(policy)).toBe(true);
    for (const invalid of [
      null,
      [],
      {},
      { ...policy, port: 80 },
      { ...policy, addressFamily: "ipv6" },
      { ...policy, profile: "inherit" },
      { ...policy, schemaVersion: 2 },
      { ...policy, token: "secret" },
      { ...policy, modelProfileDigest: "e".repeat(64) },
      { ...policy, policyDigest: "invalid" },
    ])
      expect(isRuntimeGatewayConfinement(invalid)).toBe(false);
    expect(() =>
      buildRuntimeGatewaySeatbeltCommand({ ...policy, port: 80 }, "/runtime", []),
    ).toThrow();
  });
});
