import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  copyOpenCodeServiceHostStartPacket,
  OPENCODE_SERVICE_HOST_START_PACKET_FIELDS,
  OPENCODE_SERVICE_HOST_START_PACKET_MAX_BYTES,
  copyOpenCodeServiceHostApproval,
  copyOpenCodeServiceHostApprovals,
  OPENCODE_SERVICE_HOST_DIGEST_FIELDS,
  OPENCODE_SERVICE_HOST_FIXED_FACTS,
} from "./opencode-service-host.js";

function fixture(): Record<string, unknown> {
  const receipt = JSON.parse(
    readFileSync(
      new URL("./opencode-service-host.private-qualified.fixture.json", import.meta.url),
      "utf8",
    ),
  ) as { readonly evidenceClass: string; readonly approval: Record<string, unknown> };
  expect(receipt.evidenceClass).toBe("private-functional");
  return receipt.approval;
}

describe("closed original OpenCode service-host metadata", () => {
  it("owns exact independently qualified final npm facts without asserting runtime approval", () => {
    const input = fixture();
    const output = copyOpenCodeServiceHostApproval(input);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    expect(Object.isFrozen(output)).toBe(true);
    expect(output?.moduleIntegrity).toBe("npm-sri");
    expect(output?.sourceBuildProvenance).toBe("reference-only");
  });

  it.each(Object.keys(OPENCODE_SERVICE_HOST_FIXED_FACTS))(
    "rejects changed fixed fact %s",
    (key) => {
      expect(
        copyOpenCodeServiceHostApproval({ ...fixture(), [key]: "substituted" }),
      ).toBeUndefined();
    },
  );

  it.each(OPENCODE_SERVICE_HOST_DIGEST_FIELDS)("rejects invalid digest %s", (key) => {
    expect(copyOpenCodeServiceHostApproval({ ...fixture(), [key]: "invalid" })).toBeUndefined();
  });

  it.each(["payloadFileCount", "payloadSizeBytes", "archiveSizeBytes"])(
    "bounds count %s",
    (key) => {
      for (const value of [
        0,
        -1,
        1.1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER,
      ]) {
        expect(copyOpenCodeServiceHostApproval({ ...fixture(), [key]: value })).toBeUndefined();
      }
    },
  );

  it("rejects partial, unknown, symbolic and accessor facts without reading the accessor", () => {
    const partial = fixture();
    delete partial.bootstrapSha256;
    expect(copyOpenCodeServiceHostApproval(partial)).toBeUndefined();
    expect(
      copyOpenCodeServiceHostApproval({ ...fixture(), sourceBuildAttested: true }),
    ).toBeUndefined();
    expect(
      copyOpenCodeServiceHostApproval({ ...fixture(), [Symbol("hidden")]: true }),
    ).toBeUndefined();
    let invoked = false;
    const accessor = Object.defineProperty(fixture(), "bootstrapSha256", {
      get: () => {
        invoked = true;
        return "a".repeat(64);
      },
    });
    expect(copyOpenCodeServiceHostApproval(accessor)).toBeUndefined();
    expect(invoked).toBe(false);
  });

  it("copies only correctly keyed supplemental target identities", () => {
    const input = { "macos-arm64": fixture() };
    const output = copyOpenCodeServiceHostApprovals(input);
    expect(output).toEqual(input);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output?.["macos-arm64"])).toBe(true);
    expect(copyOpenCodeServiceHostApprovals({ "macos-x64": fixture() })).toBeUndefined();
    expect(copyOpenCodeServiceHostApprovals({ unsupported: fixture() })).toBeUndefined();
    expect(copyOpenCodeServiceHostApprovals({})).toBeUndefined();
    expect(copyOpenCodeServiceHostApprovals(undefined)).toBeUndefined();
  });

  it.each(["object", "array"])("rejects a revoked %s without escaping validation", (kind) => {
    const revoked = Proxy.revocable(kind === "object" ? fixture() : [], {});
    revoked.revoke();
    expect(copyOpenCodeServiceHostApproval(revoked.proxy)).toBeUndefined();
    expect(copyOpenCodeServiceHostApprovals(revoked.proxy)).toBeUndefined();
    expect(copyOpenCodeServiceHostApprovals({ "macos-arm64": revoked.proxy })).toBeUndefined();
  });
});

function packetFixture(): Record<string, unknown> {
  return {
    workspace: "/accepted/workspace",
    stateRoot: "/private/run",
    password: "p".repeat(43),
    providerURL: "http://127.0.0.1:1983/api/coding-sidecar/gateway/chat/completions",
    facadeURL: "http://127.0.0.1:1983/api/coding-sidecar/tool",
    providerCapability: "m".repeat(32),
    facadeCapability: "t".repeat(32),
    mode: "supervised-coding",
    runId: "accepted-run",
    configDigest: "f".repeat(64),
  };
}

describe("closed fixed-host start data", () => {
  it("owns the exact ten fields and 16KiB transport ceiling without adding selectors", () => {
    const input = packetFixture();
    const output = copyOpenCodeServiceHostStartPacket(input);
    expect(output).toEqual(input);
    expect(Object.keys(output ?? {})).toEqual(OPENCODE_SERVICE_HOST_START_PACKET_FIELDS);
    expect(Object.isFrozen(output)).toBe(true);
    input.workspace = "/later/mutation";
    expect(output?.workspace).toBe("/accepted/workspace");
    expect(OPENCODE_SERVICE_HOST_START_PACKET_MAX_BYTES).toBe(16 * 1024);
  });
  it.each(OPENCODE_SERVICE_HOST_START_PACKET_FIELDS)("rejects missing/non-data field %s", (key) => {
    const missing = packetFixture();
    Reflect.deleteProperty(missing, key);
    expect(copyOpenCodeServiceHostStartPacket(missing)).toBeUndefined();
    expect(copyOpenCodeServiceHostStartPacket({ ...packetFixture(), [key]: 1 })).toBeUndefined();
    expect(copyOpenCodeServiceHostStartPacket({ ...packetFixture(), [key]: "" })).toBeUndefined();
    let reads = 0;
    const accessor = Object.defineProperty(packetFixture(), key, {
      get(): string {
        reads += 1;
        return "must not read";
      },
    });
    expect(copyOpenCodeServiceHostStartPacket(accessor)).toBeUndefined();
    expect(reads).toBe(0);
  });
  it.each(["module", "executable", "args", "toolProfile", "config", "lease"])(
    "refuses extra selector %s",
    (key) => {
      expect(
        copyOpenCodeServiceHostStartPacket({ ...packetFixture(), [key]: "invented" }),
      ).toBeUndefined();
    },
  );
  it("refuses invalid scalars, non-data symbols and revoked proxies without access", () => {
    for (const extra of [
      { password: "short" },
      { mode: "invented" },
      { runId: "../escape" },
      { configDigest: "invalid" },
      { workspace: "nul\u0000path" },
      { stateRoot: "x".repeat(4097) },
      { providerCapability: "t".repeat(32) },
      { facadeCapability: "short" },
    ])
      expect(copyOpenCodeServiceHostStartPacket({ ...packetFixture(), ...extra })).toBeUndefined();
    expect(
      copyOpenCodeServiceHostStartPacket({ ...packetFixture(), [Symbol("hidden")]: true }),
    ).toBeUndefined();
    const revoked = Proxy.revocable(packetFixture(), {});
    revoked.revoke();
    expect(copyOpenCodeServiceHostStartPacket(revoked.proxy)).toBeUndefined();
  });
});
