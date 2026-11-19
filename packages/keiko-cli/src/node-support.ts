// Whether the Node.js that runs Keiko is one the package declares it supports. npm only warns about
// an `engines` mismatch, so a plain npm installation can run for weeks on an unsupported Node.js
// without a word. The range is read from the package's own manifest, never restated here, and an
// answer Keiko cannot give is `unknown`, never a refusal: a running installation must keep
// starting. The closed value is what `process.started` records; no version text leaves the process.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type NodeSupport = "supported" | "unsupported" | "unknown";

type Triple = readonly [number, number, number];
type Comparator = (actual: Triple, bound: Triple) => boolean;

const VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/u;
const COMPARATOR = /^(>=|<=|>|<|=)?(.+)$/u;

function parseVersion(text: string): Triple | undefined {
  const match = VERSION.exec(text);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compareTriples(left: Triple, right: Triple): number {
  for (const index of [0, 1, 2] as const) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

const COMPARATORS: Readonly<Record<string, Comparator>> = {
  ">=": (actual, bound) => compareTriples(actual, bound) >= 0,
  "<=": (actual, bound) => compareTriples(actual, bound) <= 0,
  ">": (actual, bound) => compareTriples(actual, bound) > 0,
  "<": (actual, bound) => compareTriples(actual, bound) < 0,
  "=": (actual, bound) => compareTriples(actual, bound) === 0,
};

function satisfiesToken(actual: Triple, token: string): boolean | undefined {
  const match = COMPARATOR.exec(token);
  const bound = parseVersion(match?.[2] ?? "");
  const compare = COMPARATORS[match?.[1] ?? "="];
  return bound === undefined || compare === undefined ? undefined : compare(actual, bound);
}

function satisfiesClause(actual: Triple, clause: string): boolean | undefined {
  const tokens = clause
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return undefined;
  let satisfied = true;
  for (const token of tokens) {
    const verdict = satisfiesToken(actual, token);
    if (verdict === undefined) return undefined;
    satisfied = satisfied && verdict;
  }
  return satisfied;
}

/** The support verdict of `version` against a declared range such as `>=26.13.1 <27`. */
export function nodeSupportOf(version: string, range: string | undefined): NodeSupport {
  const actual = parseVersion(version);
  if (actual === undefined || range === undefined) return "unknown";
  let unsupported = false;
  for (const clause of range.split("||")) {
    const verdict = satisfiesClause(actual, clause);
    if (verdict === undefined) return "unknown";
    if (verdict) return "supported";
    unsupported = true;
  }
  return unsupported ? "unsupported" : "unknown";
}

/**
 * The Node.js range this installation declares in its own manifest. The bin shim names the running
 * entry (`<package>/dist/cli/index.js`); the manifest sits two directories above it.
 */
export function declaredNodeRange(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const entry = env.KEIKO_CLI_BIN_PATH;
  if (entry === undefined || entry.length === 0) return undefined;
  try {
    const manifest = JSON.parse(
      readFileSync(join(resolve(dirname(entry), "..", ".."), "package.json"), "utf8"),
    ) as { readonly engines?: { readonly node?: unknown } };
    const range = manifest.engines?.node;
    return typeof range === "string" ? range : undefined;
  } catch {
    return undefined;
  }
}

/** The verdict for the running Node.js, or for an injected version in tests. */
export function currentNodeSupport(
  env: Readonly<Record<string, string | undefined>>,
  runningVersion: string = process.version,
): NodeSupport {
  return nodeSupportOf(runningVersion, declaredNodeRange(env));
}

/** The one plain line `keiko start` prints for an unsupported Node.js, or undefined. */
export function unsupportedNodeNotice(
  env: Readonly<Record<string, string | undefined>>,
  runningVersion: string = process.version,
): string | undefined {
  const range = declaredNodeRange(env);
  if (nodeSupportOf(runningVersion, range) !== "unsupported") return undefined;
  return `keiko start: this Keiko requires Node.js ${String(range)}, but runs on Node.js ${runningVersion}. This combination is not supported; install a supported Node.js.\n`;
}
