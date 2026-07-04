import { describe, expect, it } from "vitest";
import { classifyOutboundHost, normalizeHost } from "./egress-policy.js";

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
