import type { HtmlManualCitationOpenUnavailableReason } from "@oscharko-dev/keiko-contracts/bff-wire";
import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/text-safety";

type DocumentationTargetClass = "local-file" | "loopback" | "intranet-http" | "external-http";

export interface DocumentationTargetClassificationOk {
  readonly ok: true;
  // Class of the parsed target.
  readonly targetClass: DocumentationTargetClass;
  // Redacted origin summary safe to display: `scheme://host[:port]` for http(s), the literal
  // string "local file" for file targets. Never contains a path, query, fragment, or credential.
  readonly originSummary: string;
  // Redacted path shape hint for http(s) targets: "/" when the path is empty or root, "/…" when a
  // non-root path is present. Never the real path. `null` for non-http targets.
  readonly pathSummary: string | null;
}

export interface DocumentationTargetClassificationFail {
  readonly ok: false;
  // Why the target could not be classified. The caller projects it into a closed citation status.
  readonly reason: "invalid-target" | "unsupported-scheme" | "credentials-in-target";
}

export type DocumentationTargetClassification =
  DocumentationTargetClassificationOk | DocumentationTargetClassificationFail;

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;
const INTRANET_SUFFIXES = [".local", ".internal", ".intranet", ".lan", ".corp", ".home"] as const;

function parseIpv4Octets(host: string): readonly number[] | null {
  const match = IPV4_PATTERN.exec(host);
  if (match === null) return null;
  const octets = match.slice(1).map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => octet > 255)) return null;
  return octets;
}

function isLoopbackIpv4(octets: readonly number[]): boolean {
  return octets[0] === 127;
}

function isPrivateIpv4(octets: readonly number[]): boolean {
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function classifyIpv4(octets: readonly number[]): DocumentationTargetClass {
  if (isLoopbackIpv4(octets)) return "loopback";
  return isPrivateIpv4(octets) ? "intranet-http" : "external-http";
}

// Classify a named (non-IPv4) host: unique-local/link-local IPv6 prefixes, single-label names, and
// *.local/*.internal/… suffixes are intranet-class; every other dotted public name is external.
function classifyNamedHost(lower: string): DocumentationTargetClass {
  const ipv6Literal = lower.includes(":");
  if (
    ipv6Literal &&
    (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80"))
  ) {
    return "intranet-http";
  }
  if (!lower.includes(".")) return "intranet-http";
  if (INTRANET_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return "intranet-http";
  return "external-http";
}

const IPV4_MAPPED_IPV6_PATTERN = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u;

// Unwrap an IPv4-mapped IPv6 literal (WHATWG URL normalises `::ffff:127.0.0.1` to the compressed hex
// form `::ffff:7f00:1`) back to its embedded IPv4 octets so it classifies identically to the
// dotted-decimal address it represents, instead of falling through to the named-host branch.
function parseIpv4MappedIpv6Octets(lower: string): readonly number[] | null {
  const match = IPV4_MAPPED_IPV6_PATTERN.exec(lower);
  if (match === null) return null;
  const [highWord, lowWord] = match.slice(1).map((part) => Number.parseInt(part, 16));
  if (highWord === undefined || lowWord === undefined) return null;
  return [highWord >> 8, highWord & 0xff, lowWord >> 8, lowWord & 0xff];
}

// Classify the host of an http(s) target. Loopback and private/link-local ranges plus single-label
// and *.local/*.internal/… names are treated as intranet-class; everything else is external.
function classifyHttpHost(rawHost: string): DocumentationTargetClass {
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower === "::1") return "loopback";
  const mappedOctets = parseIpv4MappedIpv6Octets(lower);
  if (mappedOctets !== null) return classifyIpv4(mappedOctets);
  const octets = parseIpv4Octets(lower);
  return octets !== null ? classifyIpv4(octets) : classifyNamedHost(lower);
}

function summarizeHttpOrigin(parsed: URL): string {
  // parsed.origin is `scheme://host[:port]` with no path/query/fragment/userinfo — exactly the safe
  // summary we want. Strip any format-spoofing code points defensively.
  return stripUnsafeFormatChars(parsed.origin);
}

function summarizeHttpPath(parsed: URL): string {
  return parsed.pathname === "" || parsed.pathname === "/" ? "/" : "/…";
}

// ─── Target classification ────────────────────────────────────────────────────────

/**
 * Classify a resolved documentation target with the WHATWG URL parser. Pure: no filesystem, no
 * network. Fails closed — credentials, unknown schemes, and unparseable input never resolve to a
 * loadable class. Never returns a path, query, fragment, or credential in any summary.
 */
export function classifyDocumentationTarget(raw: unknown): DocumentationTargetClassification {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, reason: "invalid-target" };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "invalid-target" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "credentials-in-target" };
  }
  if (parsed.protocol === "file:") {
    // Never expose the local path; a file target is summarised as a class label only.
    return { ok: true, targetClass: "local-file", originSummary: "local file", pathSummary: null };
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    const targetClass = classifyHttpHost(parsed.hostname);
    return {
      ok: true,
      targetClass,
      originSummary: summarizeHttpOrigin(parsed),
      pathSummary: summarizeHttpPath(parsed),
    };
  }
  return { ok: false, reason: "unsupported-scheme" };
}

export function classifyManualCitationTarget(
  target: string,
):
  | DocumentationTargetClassificationOk
  | { readonly ok: false; readonly reason: HtmlManualCitationOpenUnavailableReason } {
  const classification = classifyDocumentationTarget(target);
  if (classification.ok) {
    return classification.targetClass === "external-http"
      ? { ok: false, reason: "target-outside-approved-scope" }
      : classification;
  }
  switch (classification.reason) {
    case "credentials-in-target":
      return { ok: false, reason: "target-credentialed" };
    case "unsupported-scheme":
      return { ok: false, reason: "target-unsupported" };
    case "invalid-target":
      return { ok: false, reason: "target-unavailable" };
  }
}
