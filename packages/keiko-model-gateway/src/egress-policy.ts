import { isIP } from "node:net";
import type { OutboundHttpEgressConfig } from "./types.js";

export type OutboundTargetClass =
  "public" | "loopback" | "private" | "link-local" | "metadata" | "multicast";

export function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
}

function parseIpv4(hostname: string): readonly [number, number, number, number] | undefined {
  if (isIP(hostname) !== 4) return undefined;
  const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return undefined;
  }
  return parts as [number, number, number, number];
}

function isLoopbackIpv4(parts: readonly [number, number, number, number]): boolean {
  const [a] = parts;
  return a === 127;
}

function isMetadataIpv4(parts: readonly [number, number, number, number]): boolean {
  const [a, b, c, d] = parts;
  return a === 169 && b === 254 && c === 169 && d === 254;
}

function isLinkLocalIpv4(parts: readonly [number, number, number, number]): boolean {
  const [a, b] = parts;
  return a === 169 && b === 254;
}

function isRfc1918TenIpv4(parts: readonly [number, number, number, number]): boolean {
  const [a] = parts;
  return a === 10;
}

function isRfc1918OneSeventyTwoIpv4(parts: readonly [number, number, number, number]): boolean {
  const [a, b] = parts;
  return a === 172 && b >= 16 && b <= 31;
}

function isRfc1918OneNinetyTwoIpv4(parts: readonly [number, number, number, number]): boolean {
  const [a, b] = parts;
  return a === 192 && b === 168;
}

function isCarrierGradeNatIpv4(parts: readonly [number, number, number, number]): boolean {
  const [a, b] = parts;
  return a === 100 && b >= 64 && b <= 127;
}

function isReservedOrMulticastIpv4(parts: readonly [number, number, number, number]): boolean {
  const [a] = parts;
  return a === 0 || a >= 224;
}

function isIetfProtocolAssignmentIpv4(parts: readonly [number, number, number, number]): boolean {
  const [a, b, c] = parts;
  return a === 192 && b === 0 && c === 0;
}

function isBenchmarkingIpv4(parts: readonly [number, number, number, number]): boolean {
  const [a, b] = parts;
  return a === 198 && (b === 18 || b === 19);
}

interface Ipv4ClassificationRule {
  readonly targetClass: OutboundTargetClass;
  readonly matches: (parts: readonly [number, number, number, number]) => boolean;
}

// Explicit, named network ranges keep SSRF/private-address policy auditable. Order matters only
// where ranges overlap: the /32 cloud-metadata address is a subset of the /16 link-local block,
// so it must be checked first to win the more specific classification.
function ipv4ClassificationRules(): readonly Ipv4ClassificationRule[] {
  return [
    { targetClass: "loopback", matches: isLoopbackIpv4 },
    { targetClass: "metadata", matches: isMetadataIpv4 },
    { targetClass: "link-local", matches: isLinkLocalIpv4 },
    { targetClass: "private", matches: isRfc1918TenIpv4 },
    { targetClass: "private", matches: isRfc1918OneSeventyTwoIpv4 },
    { targetClass: "private", matches: isRfc1918OneNinetyTwoIpv4 },
    { targetClass: "private", matches: isCarrierGradeNatIpv4 },
    { targetClass: "private", matches: isReservedOrMulticastIpv4 },
    { targetClass: "private", matches: isIetfProtocolAssignmentIpv4 },
    { targetClass: "private", matches: isBenchmarkingIpv4 },
  ];
}

function classifyIpv4(parts: readonly [number, number, number, number]): OutboundTargetClass {
  const rule = ipv4ClassificationRules().find((candidate) => candidate.matches(parts));
  return rule?.targetClass ?? "public";
}

function mappedIpv4FromIpv6(hostname: string): string | undefined {
  const prefix = "::ffff:";
  return hostname.startsWith(prefix) ? hostname.slice(prefix.length) : undefined;
}

function firstIpv6Hextet(hostname: string): number {
  const first = hostname.split(":", 1)[0] ?? "";
  return first.length === 0 ? 0 : Number.parseInt(first, 16);
}

const IPV6_HEXTET_COUNT = 8;

// Fully expand a compressed or already-expanded IPv6 literal into its 8 hextets, so embedded-IPv4
// forms (IPv4-mapped, NAT64) can be decoded regardless of how the "::" run happens to fall. Returns
// undefined for anything that is not a plain hex-group literal (e.g. a trailing dotted-quad, which
// `mappedIpv4FromIpv6` already covers for the common "::ffff:a.b.c.d" case).
function expandIpv6Hextets(hostname: string): readonly number[] | undefined {
  const compressedAt = hostname.indexOf("::");
  const headText = compressedAt === -1 ? hostname : hostname.slice(0, compressedAt);
  const tailText = compressedAt === -1 ? "" : hostname.slice(compressedAt + 2);
  const headGroups = headText.length === 0 ? [] : headText.split(":");
  const tailGroups = tailText.length === 0 ? [] : tailText.split(":");
  const missing = IPV6_HEXTET_COUNT - headGroups.length - tailGroups.length;
  if (compressedAt === -1 ? missing !== 0 : missing < 0) return undefined;
  const zeroFill = compressedAt === -1 ? [] : Array.from({ length: missing }, () => "0");
  const groups = [...headGroups, ...zeroFill, ...tailGroups];
  if (groups.length !== IPV6_HEXTET_COUNT) return undefined;
  const hextets = groups.map((group) => Number.parseInt(group, 16));
  return hextets.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffff)
    ? hextets
    : undefined;
}

function hextetPairToIpv4(
  high: number | undefined,
  low: number | undefined,
): readonly [number, number, number, number] | undefined {
  if (high === undefined || low === undefined) return undefined;
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
}

// RFC 4291 IPv4-mapped address (::ffff:0:0/96) in fully-expanded hextet form, e.g. the loopback
// alias `0:0:0:0:0:ffff:7f00:1` that the literal "::ffff:" prefix check in `mappedIpv4FromIpv6`
// does not match.
function mappedIpv4FromHextets(
  hextets: readonly number[],
): readonly [number, number, number, number] | undefined {
  const isMapped = hextets.slice(0, 5).every((value) => value === 0) && hextets[5] === 0xffff;
  return isMapped ? hextetPairToIpv4(hextets[6], hextets[7]) : undefined;
}

// RFC 6052 NAT64 well-known prefix (64:ff9b::/96) embeds an IPv4 address in the low 32 bits, so a
// blocked address (e.g. the 169.254.169.254 metadata address) reachable via its NAT64 alias must
// classify the same as the literal IPv4 form.
function nat64EmbeddedIpv4(
  hextets: readonly number[],
): readonly [number, number, number, number] | undefined {
  const isNat64Prefix =
    hextets[0] === 0x64 &&
    hextets[1] === 0xff9b &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0;
  return isNat64Prefix ? hextetPairToIpv4(hextets[6], hextets[7]) : undefined;
}

function embeddedIpv4FromHextets(
  hextets: readonly number[],
): readonly [number, number, number, number] | undefined {
  return mappedIpv4FromHextets(hextets) ?? nat64EmbeddedIpv4(hextets);
}

function isIpv6Multicast(hextets: readonly number[]): boolean {
  return (hextets[0] ?? 0) >= 0xff00;
}

// Classification that only the fully-expanded hextet form can answer (embedded-IPv4 decoding,
// multicast); undefined means "not decided here, fall back to the prefix-only classifier".
function classifyIpv6ByHextets(hextets: readonly number[]): OutboundTargetClass | undefined {
  const embeddedIpv4 = embeddedIpv4FromHextets(hextets);
  if (embeddedIpv4 !== undefined) return classifyIpv4(embeddedIpv4);
  return isIpv6Multicast(hextets) ? "multicast" : undefined;
}

function classifyIpv6ByPrefix(hostname: string): OutboundTargetClass {
  const first = firstIpv6Hextet(hostname);
  if (Number.isInteger(first) && first >= 0xfe80 && first <= 0xfebf) return "link-local";
  if (Number.isInteger(first) && (first & 0xfe00) === 0xfc00) return "private";
  return "public";
}

function classifyIpv6(hostname: string): OutboundTargetClass {
  if (hostname === "::1") return "loopback";
  if (hostname === "::") return "private";
  const mapped = mappedIpv4FromIpv6(hostname);
  if (mapped !== undefined) {
    const ipv4 = parseIpv4(mapped);
    return ipv4 === undefined ? "private" : classifyIpv4(ipv4);
  }
  const hextets = expandIpv6Hextets(hostname);
  const byHextets = hextets === undefined ? undefined : classifyIpv6ByHextets(hextets);
  return byHextets ?? classifyIpv6ByPrefix(hostname);
}

export function classifyOutboundHost(hostname: string): OutboundTargetClass | undefined {
  const normalized = normalizeHost(hostname);
  if (normalized === "localhost") return "loopback";
  const ipv4 = parseIpv4(normalized);
  if (ipv4 !== undefined) return classifyIpv4(ipv4);
  if (isIP(normalized) === 6) return classifyIpv6(normalized);
  return undefined;
}

// "multicast" has no legitimate override anywhere in the codebase and stays blocked
// unconditionally. "metadata"/"link-local" stay blocked for the generic `allowPrivateNetwork`
// opt-in (a scoped opt-in for the "private" class only -- it must never re-permit cloud-metadata
// or link-local addresses, AUDIT-SEC-002) but MAY be re-permitted by the much narrower
// `allowLinkLocalAndMetadata` opt-in, which only the model-gateway setup route ever sets, and
// only after its own dedicated env-flag-gated check already approved the exact submitted URL.
const ALWAYS_BLOCKED_TARGET_CLASSES: ReadonlySet<OutboundTargetClass> = new Set(["multicast"]);
const PRIVATE_NETWORK_OVERRIDABLE_TARGET_CLASSES: ReadonlySet<OutboundTargetClass> = new Set([
  "metadata",
  "link-local",
]);

function isTargetClassBlocked(
  targetClass: OutboundTargetClass,
  egress: OutboundHttpEgressConfig | undefined,
): boolean {
  if (targetClass === "public" || targetClass === "loopback") return false;
  if (ALWAYS_BLOCKED_TARGET_CLASSES.has(targetClass)) return true;
  if (PRIVATE_NETWORK_OVERRIDABLE_TARGET_CLASSES.has(targetClass)) {
    return egress?.allowLinkLocalAndMetadata !== true;
  }
  return egress?.allowPrivateNetwork !== true;
}

export function outboundTargetBlockedReason(
  url: URL,
  egress: OutboundHttpEgressConfig | undefined,
): string | undefined {
  const targetClass = classifyOutboundHost(url.hostname);
  if (targetClass === undefined || !isTargetClassBlocked(targetClass, egress)) return undefined;
  return `${targetClass} address`;
}

export function outboundAddressBlockedReason(
  address: string,
  egress: OutboundHttpEgressConfig | undefined,
): string | undefined {
  const targetClass = classifyOutboundHost(address);
  if (targetClass === undefined || !isTargetClassBlocked(targetClass, egress)) return undefined;
  return `${targetClass} address`;
}
