import { describe, expect, it } from "vitest";
import {
  workspaceRootObjectIdentityDigestFor,
  workspaceRootObjectIdentityFor,
} from "./workspace-root-identity.js";

describe("workspace root object identity", () => {
  it("is stable across path aliases for the same filesystem object", () => {
    const stat = { dev: 7n, ino: 11n, birthtimeNs: 13n };

    expect(workspaceRootObjectIdentityDigestFor(stat)).toBe(
      workspaceRootObjectIdentityDigestFor(stat),
    );
  });

  it("changes when an inode is reused for a newly created object", () => {
    expect(workspaceRootObjectIdentityDigestFor({ dev: 7n, ino: 11n, birthtimeNs: 13n })).not.toBe(
      workspaceRootObjectIdentityDigestFor({ dev: 7n, ino: 11n, birthtimeNs: 17n }),
    );
  });

  it("keeps bigint identity fields exact beyond Number precision", () => {
    const beyondNumberPrecision = 2n ** 60n;

    expect(
      workspaceRootObjectIdentityDigestFor({
        dev: 7n,
        ino: beyondNumberPrecision + 1n,
        birthtimeNs: 13n,
      }),
    ).not.toBe(
      workspaceRootObjectIdentityDigestFor({
        dev: 7n,
        ino: beyondNumberPrecision + 2n,
        birthtimeNs: 13n,
      }),
    );
  });

  it("fails closed when the filesystem has no durable creation identity", () => {
    expect(
      workspaceRootObjectIdentityDigestFor({ dev: 7n, ino: 11n, birthtimeNs: 0n }),
    ).toBeUndefined();
    expect(workspaceRootObjectIdentityFor({ dev: 7n, ino: 11n, birthtimeNs: 0n })).toEqual({
      digest: undefined,
      unsupported: true,
    });
    expect(workspaceRootObjectIdentityFor({ dev: 7n, ino: 11n, birthtimeNs: -1n })).toEqual({
      digest: undefined,
      unsupported: true,
    });
  });

  it("marks a positive creation identity as supported", () => {
    const identity = workspaceRootObjectIdentityFor({ dev: 7n, ino: 11n, birthtimeNs: 1n });

    expect(identity.unsupported).toBe(false);
    expect(identity.digest).toMatch(/^[0-9a-f]{64}$/u);
  });
});
