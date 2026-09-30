export const KEIKO_CONTRACTS_VERSION = "1.1.13" as const;

// Single-source product version. Surfaced as `keiko --version`, in the BFF healthcheck response,
// and as the SDK's exported `SDK_VERSION` constant. Kept in the contracts leaf so every consumer
// reaches it through one stable import path. Bump in lockstep with the root package.json version.
export const KEIKO_PRODUCT_VERSION = "1.1.13" as const;

interface ProductVersion {
  readonly components: readonly [number, number, number];
  readonly prerelease: readonly string[];
}

function parseProductVersion(value: string): ProductVersion | undefined {
  if (value.length > 128) return undefined;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/u.exec(value);
  if (match === null) return undefined;
  const components: readonly [number, number, number] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const prerelease = match[4]?.split(".") ?? [];
  if (!components.every(Number.isSafeInteger) || !prerelease.every(validPrereleaseIdentifier))
    return undefined;
  return { components, prerelease };
}

function validPrereleaseIdentifier(value: string): boolean {
  return value.length > 0 && (!/^\d+$/u.test(value) || value === "0" || !value.startsWith("0"));
}

function lexicalComparison(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric)
    return Math.sign(left.length - right.length) || lexicalComparison(left, right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return lexicalComparison(left, right);
}

function comparePrereleases(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  for (const [index, identifier] of left.entries()) {
    const other = right[index];
    if (other === undefined) return 1;
    const result = comparePrereleaseIdentifier(identifier, other);
    if (result !== 0) return result;
  }
  return Math.sign(left.length - right.length);
}

/** Shared by offline report compatibility and the governed update path. Invalid versions fail closed. */
export function compareProductVersions(left: string, right: string): number {
  const a = parseProductVersion(left);
  const b = parseProductVersion(right);
  if (a === undefined || b === undefined) throw new TypeError("Malformed product version.");
  for (const index of [0, 1, 2] as const) {
    const result = Math.sign(a.components[index] - b.components[index]);
    if (result !== 0) return result;
  }
  return comparePrereleases(a.prerelease, b.prerelease);
}

export function isStableProductVersion(value: string): boolean {
  return parseProductVersion(value)?.prerelease.length === 0;
}

export function isProductVersion(value: unknown): value is string {
  return typeof value === "string" && parseProductVersion(value) !== undefined;
}
