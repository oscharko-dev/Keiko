import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
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
