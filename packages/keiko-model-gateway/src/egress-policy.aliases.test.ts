import { describe, expect, it } from "vitest";
import {
  classifyOutboundHost,
  outboundAddressBlockedReason,
  outboundTargetBlockedReason,
} from "./egress-policy.js";

const ALIASES = [
  ["0.0.0.0", "unspecified"],
  ["::", "unspecified"],
  ["0:0:0:0:0:0:0:0", "unspecified"],
  ["::ffff:0:0", "unspecified"],
  ["::ffff:0.0.0.0", "unspecified"],
  ["64:ff9b::0:0", "unspecified"],
  ["::1", "loopback"],
  ["0:0:0:0:0:0:0:1", "loopback"],
  ["::ffff:7f00:1", "loopback"],
  ["::ffff:127.0.0.1", "loopback"],
  ["0:0:0:0:0:ffff:127.0.0.1", "loopback"],
  ["64:ff9b::127.0.0.1", "loopback"],
  ["::ffff:a9fe:a9fe", "metadata"],
  ["::ffff:169.254.169.254", "metadata"],
  ["0:0:0:0:0:ffff:169.254.169.254", "metadata"],
  ["64:ff9b::169.254.169.254", "metadata"],
  ["::ffff:a9fe:1", "link-local"],
  ["::ffff:169.254.0.1", "link-local"],
  ["::ffff:a00:1", "private"],
  ["0:0:0:0:0:ffff:10.0.0.1", "private"],
  ["fd12::1", "private"],
  ["::ffff:808:808", "public"],
  ["64:ff9b::8.8.8.8", "public"],
] as const;

function urlFor(host: string): URL {
  return new URL(`http://${host.includes(":") ? `[${host}]` : host}:18443/probe`);
}

describe("canonical outbound address aliases", () => {
  it.each(ALIASES)("classifies raw and URL-normalized %s as %s", (host, expected) => {
    expect(classifyOutboundHost(host)).toBe(expected);
    expect(classifyOutboundHost(urlFor(host).hostname)).toBe(expected);
  });

  it.each(ALIASES.filter(([, kind]) => kind === "unspecified"))(
    "never permits an unspecified target %s through either override",
    (host) => {
      const egress = { allowPrivateNetwork: true, allowLinkLocalAndMetadata: true };
      expect(outboundAddressBlockedReason(host, egress)).toBe("unspecified address");
      expect(outboundTargetBlockedReason(urlFor(host), egress)).toBe("unspecified address");
    },
  );

  it.each(ALIASES.filter(([, kind]) => kind === "loopback"))(
    "preserves loopback controls for every representation of %s",
    (host) => {
      expect(outboundAddressBlockedReason(host, {})).toBeUndefined();
      expect(outboundAddressBlockedReason(host, { denyLoopback: true })).toBe("loopback address");
      expect(outboundTargetBlockedReason(urlFor(host), { deniedLoopbackPorts: [18443] })).toBe(
        "active loopback listener",
      );
    },
  );

  it.each(ALIASES.filter(([, kind]) => kind === "metadata" || kind === "link-local"))(
    "does not let private-network admission permit %s",
    (host, kind) => {
      expect(outboundAddressBlockedReason(host, { allowPrivateNetwork: true })).toBe(
        `${kind} address`,
      );
    },
  );

  it.each(["10.0.0.1", "172.20.0.1", "192.168.0.1", "fd12::1", "::ffff:a00:1"])(
    "continues to permit genuine private target %s only with its scoped opt-in",
    (host) => {
      expect(outboundAddressBlockedReason(host, {})).toBe("private address");
      expect(outboundAddressBlockedReason(host, { allowPrivateNetwork: true })).toBeUndefined();
    },
  );
});
