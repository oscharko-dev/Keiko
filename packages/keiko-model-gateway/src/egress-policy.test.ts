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

describe("classifyOutboundHost IPv4 edge ranges", () => {
  it.each([
    ["8.8.8.8", "public"],
    ["8.8.8.254", "public"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.255", "loopback"],
    ["169.254.169.254", "metadata"],
    ["1.254.169.254", "public"],
    ["1.2.169.254", "public"],
    ["169.1.169.254", "public"],
    ["169.254.169.253", "link-local"],
    ["169.254.1.254", "link-local"],
    ["169.254.1.2", "link-local"],
    ["169.1.2.3", "public"],
    ["1.254.2.3", "public"],
    ["10.0.0.1", "private"],
    ["172.15.255.255", "public"],
    ["172.16.0.0", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.0", "public"],
    ["192.168.0.1", "private"],
    ["8.168.0.1", "public"],
    ["100.63.255.255", "public"],
    ["100.64.0.0", "private"],
    ["100.127.255.255", "private"],
    ["100.128.0.0", "public"],
    ["8.64.0.1", "public"],
    ["0.0.0.1", "private"],
    ["223.255.255.255", "public"],
    ["224.0.0.0", "private"],
    ["255.255.255.255", "private"],
    ["192.0.0.1", "private"],
    ["192.0.1.1", "public"],
    ["8.0.0.1", "public"],
    ["192.1.0.1", "public"],
    ["198.17.255.255", "public"],
    ["198.18.0.0", "private"],
    ["198.19.255.255", "private"],
    ["198.20.0.0", "public"],
    ["8.18.0.1", "public"],
  ] as const)("classifies %s as %s", (host, expected) => {
    expect(classifyOutboundHost(host)).toBe(expected);
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
