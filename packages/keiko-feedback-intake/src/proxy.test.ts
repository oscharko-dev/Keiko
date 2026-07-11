import { describe, expect, it } from "vitest";
import { canonicalTrustedCidrs, normalizeAddress, resolveClientAddress } from "./proxy.js";

describe("trusted client address resolution", () => {
  it("ignores forwarding from an untrusted socket peer", () => {
    const result = resolveClientAddress({
      peer: "203.0.113.9",
      forwarded: "for=198.51.100.2",
      family: "forwarded",
      trustedCidrs: ["10.0.0.0/8"],
      maxHops: 3,
    });
    expect(result).toEqual({ ok: true, bytes: new Uint8Array([203, 0, 113, 9]) });
  });

  it("walks a bounded trusted X-Forwarded-For chain right to left", () => {
    const result = resolveClientAddress({
      peer: "10.0.0.2",
      xForwardedFor: "198.51.100.7, 10.0.0.1",
      family: "x-forwarded-for",
      trustedCidrs: ["10.0.0.0/8"],
      maxHops: 3,
    });
    expect(result).toEqual({ ok: true, bytes: new Uint8Array([198, 51, 100, 7]) });
  });

  it("normalizes mapped IPv4 and rejects mixed or malformed trusted chains", () => {
    expect(
      resolveClientAddress({
        peer: "::ffff:10.0.0.2",
        xForwardedFor: "::ffff:198.51.100.7",
        family: "x-forwarded-for",
        trustedCidrs: ["10.0.0.0/8"],
        maxHops: 2,
      }),
    ).toEqual({ ok: true, bytes: new Uint8Array([198, 51, 100, 7]) });
    expect(
      resolveClientAddress({
        peer: "10.0.0.2",
        forwarded: "for=198.51.100.7",
        xForwardedFor: "198.51.100.7",
        family: "forwarded",
        trustedCidrs: ["10.0.0.0/8"],
        maxHops: 2,
      }),
    ).toEqual({ ok: false });
    expect(
      resolveClientAddress({
        peer: "10.0.0.2",
        forwarded: "for=garbage",
        family: "forwarded",
        trustedCidrs: ["10.0.0.0/8"],
        maxHops: 2,
      }),
    ).toEqual({ ok: false });
  });

  it("collapses decimal and hexadecimal IPv4-mapped IPv6 prefixes", () => {
    expect(normalizeAddress("::ffff:192.0.2.1")).toEqual(new Uint8Array([192, 0, 2, 1]));
    expect(normalizeAddress("::ffff:c000:201")).toEqual(new Uint8Array([192, 0, 2, 1]));
  });

  it("expands strict dotted IPv4 tails without collapsing distinct IPv6 clients", () => {
    expect(normalizeAddress("2001:db8::192.0.2.1")).toEqual(normalizeAddress("2001:db8::c000:201"));
    expect(normalizeAddress("::ffff:192.0.2.1")).toEqual(normalizeAddress("::ffff:c000:201"));
    expect(normalizeAddress("::ffff:192.0.2.1")).toEqual(normalizeAddress("192.0.2.1"));
    expect(normalizeAddress("2001:db8::192.0.2.1")).not.toEqual(
      normalizeAddress("2001:db8::192.0.2.2"),
    );
    expect(normalizeAddress("2001:db8::192.0.2.999")).toBeUndefined();
  });

  it("keeps adversarial trusted Forwarded dotted-tail clients distinct", () => {
    const first = resolveClientAddress({
      peer: "10.0.0.2",
      forwarded: 'for="[2001:db8::192.0.2.1]"',
      family: "forwarded",
      trustedCidrs: ["10.0.0.0/8"],
      maxHops: 2,
    });
    const second = resolveClientAddress({
      peer: "10.0.0.2",
      forwarded: 'for="[2001:db8::192.0.2.2]"',
      family: "forwarded",
      trustedCidrs: ["10.0.0.0/8"],
      maxHops: 2,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.bytes).not.toEqual(second.bytes);
  });

  it("fails startup validation for malformed, scoped, or host-bit CIDRs", () => {
    expect(canonicalTrustedCidrs(["10.0.0.0/8", "2001:db8::/32"])).toEqual([
      "10.0.0.0/8",
      "2001:db8::/32",
    ]);
    for (const value of ["10.0.0.1/8", "10.0.0.0/33", "fe80::1%en0/64", "garbage"]) {
      expect(() => canonicalTrustedCidrs([value])).toThrow("CIDR");
    }
  });
});
