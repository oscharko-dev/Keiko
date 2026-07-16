import { describe, expect, it } from "vitest";

import { resolveProductionOpenCodePorts } from "./productionOpenCodeActivation.js";
import type { SecureWorkspaceTextReadPort } from "./secureWorkspaceTextRead.js";

const secureRead: SecureWorkspaceTextReadPort = {
  readText: () => Promise.resolve({ ok: false, reason: "denied" }),
};

function activationInput(
  env: NodeJS.ProcessEnv,
  withSecureRead: boolean,
): Parameters<typeof resolveProductionOpenCodePorts>[0] {
  return {
    env,
    runtimeStateDir: "/tmp/keiko-runtime-state",
    runtimeEvidence: { observe: () => undefined },
    gatewayReadiness: {
      waitForObservedRequest: () => Promise.resolve(false),
      clear: () => undefined,
    },
    ...(withSecureRead ? { secureWorkspaceTextRead: secureRead } : {}),
  };
}

describe("production OpenCode activation", () => {
  it("fails closed without a discoverable portable artifact", () => {
    const ports = resolveProductionOpenCodePorts(activationInput({ KEIKO_UI_PORT: "1983" }, true));
    expect(ports).toBeUndefined();
  });

  it("fails closed without a valid loopback UI port", () => {
    for (const port of [undefined, "", "0", "-1", "65536", "not-a-port"]) {
      const ports = resolveProductionOpenCodePorts(
        activationInput(port === undefined ? {} : { KEIKO_UI_PORT: port }, true),
      );
      expect(ports).toBeUndefined();
    }
  });

  it("fails closed without a verified secure-read port", () => {
    const ports = resolveProductionOpenCodePorts(activationInput({ KEIKO_UI_PORT: "1983" }, false));
    expect(ports).toBeUndefined();
  });
});
