import { isIP } from "node:net";

export interface ClientAddressInput {
  readonly peer: string;
  readonly forwarded?: string | undefined;
  readonly xForwardedFor?: string | undefined;
  readonly family: "forwarded" | "x-forwarded-for";
  readonly trustedCidrs: readonly string[];
  readonly maxHops: number;
}

export type ClientAddressResult =
  { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false };

function ipv4(value: string): Uint8Array | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const numbers = parts.map(Number);
  return numbers.every(
    (part, index) =>
      Number.isInteger(part) && part >= 0 && part <= 255 && String(part) === parts[index],
  )
    ? Uint8Array.from(numbers)
    : undefined;
}

function expandIpv6(value: string): Uint8Array | undefined {
  const normalized = expandDottedIpv4Tail(value);
  if (normalized === undefined || isIP(normalized) !== 6) return undefined;
  const groups = ipv6Groups(normalized);
  if (groups === undefined) return undefined;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const word = Number.parseInt(group, 16);
    bytes[index * 2] = word >>> 8;
    bytes[index * 2 + 1] = word & 255;
  });
  return mappedIpv4(bytes) ?? bytes;
}

function expandDottedIpv4Tail(value: string): string | undefined {
  if (!value.includes(".")) return value;
  const separator = value.lastIndexOf(":");
  if (separator < 0) return undefined;
  const tail = ipv4(value.slice(separator + 1));
  if (tail === undefined) return undefined;
  const high = ((tail[0] ?? 0) << 8) | (tail[1] ?? 0);
  const low = ((tail[2] ?? 0) << 8) | (tail[3] ?? 0);
  return `${value.slice(0, separator + 1)}${high.toString(16)}:${low.toString(16)}`;
}

function ipv6Groups(value: string): readonly string[] | undefined {
  const halves = value.toLowerCase().split("::");
  const left = halves[0]?.split(":").filter(Boolean) ?? [];
  const right = halves[1]?.split(":").filter(Boolean) ?? [];
  const groups =
    halves.length === 2
      ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]
      : left;
  return groups.length === 8 ? groups : undefined;
}

function mappedIpv4(bytes: Uint8Array): Uint8Array | undefined {
  const mappedPrefix =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 255 && bytes[11] === 255;
  return mappedPrefix ? bytes.slice(12) : undefined;
}

export function normalizeAddress(value: string): Uint8Array | undefined {
  const unbracketed = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return isIP(unbracketed) === 4 ? ipv4(unbracketed) : expandIpv6(unbracketed);
}

function prefixMatch(address: Uint8Array, network: Uint8Array, bits: number): boolean {
  if (address.length !== network.length || bits < 0 || bits > address.length * 8) return false;
  const whole = Math.floor(bits / 8);
  for (let i = 0; i < whole; i += 1) if (address[i] !== network[i]) return false;
  const remaining = bits % 8;
  return (
    remaining === 0 ||
    ((address[whole] ?? 0) & (255 << (8 - remaining))) ===
      ((network[whole] ?? 0) & (255 << (8 - remaining)))
  );
}

function networkHasHostBits(network: Uint8Array, bits: number): boolean {
  const whole = Math.floor(bits / 8);
  const remaining = bits % 8;
  if (remaining > 0 && ((network[whole] ?? 0) & ((1 << (8 - remaining)) - 1)) !== 0) return true;
  return network.slice(whole + (remaining > 0 ? 1 : 0)).some((byte) => byte !== 0);
}

export function canonicalTrustedCidrs(values: readonly string[]): readonly string[] {
  if (values.length > 32) throw new Error("Invalid trusted proxy CIDR configuration");
  return Object.freeze(
    values.map((value) => {
      if (value !== value.trim() || value.includes("%")) {
        throw new Error("Invalid trusted proxy CIDR configuration");
      }
      const parts = value.split("/");
      if (parts.length !== 2) throw new Error("Invalid trusted proxy CIDR configuration");
      const network = normalizeAddress(parts[0] ?? "");
      const bits = Number(parts[1]);
      if (
        network === undefined ||
        !Number.isInteger(bits) ||
        bits < 0 ||
        bits > network.length * 8 ||
        networkHasHostBits(network, bits)
      ) {
        throw new Error("Invalid trusted proxy CIDR configuration");
      }
      return value.toLowerCase();
    }),
  );
}

function trusted(address: Uint8Array, cidrs: readonly string[]): boolean {
  return cidrs.some((cidr) => {
    const [raw, prefix] = cidr.split("/");
    const network = raw === undefined ? undefined : normalizeAddress(raw);
    const bits = prefix === undefined ? (network?.length ?? 0) * 8 : Number(prefix);
    return network !== undefined && Number.isInteger(bits) && prefixMatch(address, network, bits);
  });
}

function forwardedChain(value: string): readonly string[] | undefined {
  const results: string[] = [];
  for (const item of value.split(",")) {
    const address = forwardedAddress(item);
    if (address === undefined) return undefined;
    results.push(address);
  }
  return results;
}

function forwardedAddress(item: string): string | undefined {
  const values = item
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.toLowerCase().startsWith("for="));
  if (values.length !== 1) return undefined;
  const raw = values[0]?.slice(4).trim();
  if (raw === undefined) return undefined;
  const address = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  if (!address.includes(":") || address.startsWith("[") || isIP(address) === 6) return address;
  return undefined;
}

function selectedChain(input: ClientAddressInput): readonly string[] | undefined {
  const raw = input.family === "forwarded" ? input.forwarded : input.xForwardedFor;
  if (raw === undefined) return [];
  return input.family === "forwarded"
    ? forwardedChain(raw)
    : raw.split(",").map((item) => item.trim());
}

function walkTrustedChain(
  peer: Uint8Array,
  chain: readonly string[],
  trustedCidrs: readonly string[],
): ClientAddressResult {
  let current = peer;
  for (let index = chain.length - 1; index >= 0 && trusted(current, trustedCidrs); index -= 1) {
    const candidate = normalizeAddress(chain[index] ?? "");
    if (candidate === undefined) return { ok: false };
    current = candidate;
  }
  return { ok: true, bytes: current };
}

export function resolveClientAddress(input: ClientAddressInput): ClientAddressResult {
  const peer = normalizeAddress(input.peer);
  if (peer === undefined) return { ok: false };
  if (!trusted(peer, input.trustedCidrs)) return { ok: true, bytes: peer };
  if (input.forwarded !== undefined && input.xForwardedFor !== undefined) return { ok: false };
  const chain = selectedChain(input);
  if (chain === undefined || chain.length > input.maxHops) return { ok: false };
  if (chain.length === 0) return { ok: true, bytes: peer };
  return walkTrustedChain(peer, chain, input.trustedCidrs);
}
