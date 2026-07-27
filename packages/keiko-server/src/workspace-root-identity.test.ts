import { describe, expect, it } from "vitest";
import { workspaceRootObjectIdentityDigestFor } from "./workspace-root-identity.js";

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
  });
});
