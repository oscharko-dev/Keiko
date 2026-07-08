import { describe, expect, it } from "vitest";
import {
  classifyOutboundHost,
  normalizeHost,
  outboundAddressBlockedReason,
  outboundTargetBlockedReason,
} from "./egress-policy.js";

describe("normalizeHost (GEN-DUP-SEMANTIC-004)", () => {
  it("strips a single set of IPv6 literal brackets", () => {
    expect(normalizeHost("[::1]")).toBe("::1");
    expect(normalizeHost("[fe80::1]")).toBe("fe80::1");
  });

  it("lowercases the hostname", () => {
    expect(normalizeHost("EXAMPLE.COM")).toBe("example.com");
    expect(normalizeHost("Api.Example.COM")).toBe("api.example.com");
  });

  it("is a no-op for an already-normalized bare host", () => {
    expect(normalizeHost("example.com")).toBe("example.com");
    expect(normalizeHost("127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("classifyOutboundHost consumes normalizeHost", () => {
  it("classifies a bracketed, upper-cased IPv6 loopback via normalization", () => {
    expect(classifyOutboundHost("[::1]")).toBe("loopback");
  });

  it("classifies localhost regardless of case", () => {
    expect(classifyOutboundHost("LOCALHOST")).toBe("loopback");
  });
});

describe("classifyOutboundHost IPv6 edge ranges (AUDIT-SEC-003)", () => {
  it("classifies IPv6 multicast (ff00::/8) instead of defaulting to public", () => {
    expect(classifyOutboundHost("[ff02::1]")).toBe("multicast");
  });

  it("decodes a NAT64 (64:ff9b::/96) alias of the cloud-metadata address as metadata", () => {
    expect(classifyOutboundHost("[64:ff9b::a9fe:a9fe]")).toBe("metadata");
  });

  it("resolves a fully-expanded IPv4-mapped loopback to loopback", () => {
    expect(classifyOutboundHost("[0:0:0:0:0:ffff:7f00:1]")).toBe("loopback");
  });

  it("still classifies the compressed IPv4-mapped loopback form", () => {
    expect(classifyOutboundHost("[::ffff:127.0.0.1]")).toBe("loopback");
  });
});

describe("outbound blocked-reason helpers keep metadata/link-local/multicast blocked even when allowPrivateNetwork is on (AUDIT-SEC-002)", () => {
  it("still blocks the literal cloud-metadata address as a target URL", () => {
    const reason = outboundTargetBlockedReason(
      new URL("https://169.254.169.254/latest/meta-data"),
      {
        allowPrivateNetwork: true,
      },
    );
    expect(reason).toBe("metadata address");
  });

  it("still blocks a link-local resolved address", () => {
    const reason = outboundAddressBlockedReason("169.254.1.2", { allowPrivateNetwork: true });
    expect(reason).toBe("link-local address");
  });

  it("still blocks an IPv6 multicast resolved address", () => {
    const reason = outboundAddressBlockedReason("ff02::1", { allowPrivateNetwork: true });
    expect(reason).toBe("multicast address");
  });

  it("still allows an RFC-1918 private address once allowPrivateNetwork is on", () => {
    const reason = outboundAddressBlockedReason("10.0.0.5", { allowPrivateNetwork: true });
    expect(reason).toBeUndefined();
  });

  it("blocks an RFC-1918 private address by default", () => {
    const reason = outboundAddressBlockedReason("10.0.0.5", undefined);
    expect(reason).toBe("private address");
  });
});
