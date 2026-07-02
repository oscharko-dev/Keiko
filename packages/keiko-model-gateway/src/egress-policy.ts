import { isIP } from "node:net";
import type { OutboundHttpEgressConfig } from "./types.js";

export type OutboundTargetClass = "public" | "loopback" | "private" | "link-local" | "metadata";

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
}

function parseIpv4(hostname: string): readonly [number, number, number, number] | undefined {
  if (isIP(hostname) !== 4) return undefined;
  const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return undefined;
  }
  return parts as [number, number, number, number];
}

// eslint-disable-next-line complexity -- explicit network ranges keep SSRF/private-address policy auditable.
function classifyIpv4(parts: readonly [number, number, number, number]): OutboundTargetClass {
  const [a, b, c, d] = parts;
  if (a === 127) return "loopback";
  if (a === 169 && b === 254 && c === 169 && d === 254) return "metadata";
  if (a === 169 && b === 254) return "link-local";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private";
  if (a === 0 || a >= 224) return "private";
  if (a === 192 && b === 0 && c === 0) return "private";
  if (a === 198 && (b === 18 || b === 19)) return "private";
  return "public";
}

function mappedIpv4FromIpv6(hostname: string): string | undefined {
  const prefix = "::ffff:";
  return hostname.startsWith(prefix) ? hostname.slice(prefix.length) : undefined;
}

function firstIpv6Hextet(hostname: string): number {
  const first = hostname.split(":", 1)[0] ?? "";
  return first.length === 0 ? 0 : Number.parseInt(first, 16);
}

function classifyIpv6(hostname: string): OutboundTargetClass {
  if (hostname === "::1") return "loopback";
  if (hostname === "::") return "private";
  const mapped = mappedIpv4FromIpv6(hostname);
  if (mapped !== undefined) {
    const ipv4 = parseIpv4(mapped);
    return ipv4 === undefined ? "private" : classifyIpv4(ipv4);
  }
  const first = firstIpv6Hextet(hostname);
  if (Number.isInteger(first) && first >= 0xfe80 && first <= 0xfebf) return "link-local";
  if (Number.isInteger(first) && (first & 0xfe00) === 0xfc00) return "private";
  return "public";
}

export function classifyOutboundHost(hostname: string): OutboundTargetClass | undefined {
  const normalized = normalizeHost(hostname);
  if (normalized === "localhost") return "loopback";
  const ipv4 = parseIpv4(normalized);
  if (ipv4 !== undefined) return classifyIpv4(ipv4);
  if (isIP(normalized) === 6) return classifyIpv6(normalized);
  return undefined;
}

export function outboundTargetBlockedReason(
  url: URL,
  egress: OutboundHttpEgressConfig | undefined,
): string | undefined {
  if (egress?.allowPrivateNetwork === true) return undefined;
  const targetClass = classifyOutboundHost(url.hostname);
  if (targetClass === undefined || targetClass === "public" || targetClass === "loopback") {
    return undefined;
  }
  return `${targetClass} address`;
}

export function outboundAddressBlockedReason(
  address: string,
  egress: OutboundHttpEgressConfig | undefined,
): string | undefined {
  if (egress?.allowPrivateNetwork === true) return undefined;
  const targetClass = classifyOutboundHost(address);
  if (targetClass === undefined || targetClass === "public" || targetClass === "loopback") {
    return undefined;
  }
  return `${targetClass} address`;
}
