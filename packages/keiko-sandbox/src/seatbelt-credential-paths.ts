import {
  CREDENTIAL_PATH_DENY_PATTERNS,
  ENV_EXAMPLE_BASENAME,
} from "@oscharko-dev/keiko-contracts/sensitive-path-patterns";

// The kernel half of the shared sensitive-path exclusion (#3897). keiko-contracts owns the names;
// `isDenied` in keiko-workspace reads the same list for the native read tool. This module only
// translates the CREDENTIAL subset into a Seatbelt path regex, so a shell child, an interpreter or a
// descendant is denied exactly the files the native tool is denied.

// A pattern is a single path segment of letters, digits, `_`, `.`, `-` and the `*` wildcard.
// Anything else cannot be translated without ambiguity, so the build refuses it (fail closed).
const SEGMENT_PATTERN = /^[A-Za-z0-9_.*-]+$/u;

/** One pattern character as a Seatbelt regex fragment: case-insensitive, no backslash escapes. */
function characterRegex(character: string): string {
  if (character === "*") return "[^/]*";
  const lower = character.toLowerCase();
  const upper = character.toUpperCase();
  if (lower !== upper) return `[${lower}${upper}]`;
  return /[0-9_]/u.test(character) ? character : `[${character}]`;
}

function segmentRegex(pattern: string): string {
  if (!SEGMENT_PATTERN.test(pattern)) throw new TypeError("seatbelt-credential-pattern-invalid");
  return Array.from(pattern, characterRegex).join("");
}

// A Seatbelt string literal is limited to 1,023 characters, so the alternation is split across
// several regex arguments; a `(regex a b ...)` filter matches when any argument matches.
const REGEX_CHUNK_MAX = 800;

function pathRegexArguments(segments: readonly string[], tail = "(/|$)"): string {
  const chunks: string[][] = [[]];
  let size = 0;
  for (const segment of segments) {
    if (size + segment.length > REGEX_CHUNK_MAX) {
      chunks.push([]);
      size = 0;
    }
    chunks.at(-1)?.push(segment);
    size += segment.length + 1;
  }
  return chunks
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => JSON.stringify(`(^|/)(${chunk.join("|")})${tail}`))
    .join(" ");
}

/**
 * Public certificate-authority bundles whose leaf is credential-shaped (`*.pem`) but which hold only
 * the public trust anchors every TLS client verifies a server with: the macOS system bundle (curl,
 * Git, Python's and Node's system store read `/etc/ssl/cert.pem`), Homebrew's `ca-certificates`
 * bundle and the `cert.pem` link each Homebrew OpenSSL keeps to it, and the bundle an installed
 * certifi ships for pip and requests (#4271 lab: every HTTPS client of a native shell failed certificate verification
 * while a standalone shell succeeded). A symbolic link is checked at its own location as well as at
 * its target, so the Homebrew OpenSSL links are named beside the bundle they point to.
 */
const PUBLIC_TRUST_BUNDLE_PATHS: readonly string[] = Object.freeze([
  "^/private/etc/ssl/cert[.]pem$",
  "^/(opt/homebrew|usr/local)/etc/(ca-certificates|openssl(@[0-9.]+)?)/cert[.]pem$",
  // certifi as an installed package, or as pip's vendored copy of it.
  "/(site|dist)-packages/(pip/_vendor/)?certifi/cacert[.]pem$",
]);
const PUBLIC_TRUST_BUNDLE_BASENAMES: readonly string[] = Object.freeze(["cert.pem", "cacert.pem"]);

function matchesLeaf(segment: string, name: string): boolean {
  return new RegExp(`^${segment}$`, "u").test(name);
}

function literalFilters(paths: readonly string[]): string {
  return [...new Set(paths)].map((path) => `(literal ${JSON.stringify(path)})`).join(" ");
}

/**
 * The patterns a trust bundle's leaf name matches (`*.pem`) deny every directory of that name
 * unconditionally and every file of that name except a public trust bundle and the certificate
 * files the operator named. The carve-out is a leaf exception only: a credential-named directory
 * above a bundle still denies it through its own pattern, every other credential name keeps its
 * rule, and whether the bundle is readable at all is decided by the read allowlist and the denied
 * roots before this rule. A named certificate file stays read-only.
 */
function trustBundleRule(segments: readonly string[], certificateFiles: readonly string[]): string {
  if (segments.length === 0) return "";
  const bundles = PUBLIC_TRUST_BUNDLE_PATHS.map((path) => JSON.stringify(path)).join(" ");
  const named = certificateFiles.length === 0 ? "" : ` ${literalFilters(certificateFiles)}`;
  return (
    `(deny file-read* file-write* (regex ${pathRegexArguments(segments, "/")}))` +
    "(deny file-read* file-write* (require-all " +
    `(regex ${pathRegexArguments(segments, "$")}) ` +
    `(require-not (require-any (regex ${bundles})${named}))))` +
    (certificateFiles.length === 0 ? "" : `(deny file-write* ${literalFilters(certificateFiles)})`)
  );
}

function buildCredentialPathRule(certificateFiles: readonly string[]): string {
  const exemptSegment = segmentRegex(ENV_EXAMPLE_BASENAME);
  const segments = CREDENTIAL_PATH_DENY_PATTERNS.map(segmentRegex);
  // `.env.example` is the one documented exception to `.env.*`, exactly as in `isDenied`. It is
  // carved out of the pattern that would match it, never out of a denied directory beneath which
  // it sits: that directory's own segment still denies it.
  const exemptable = segments.filter((segment) => matchesLeaf(segment, ENV_EXAMPLE_BASENAME));
  // A pattern that matched both exceptions keeps only the `.env.example` one (fail closed).
  const trust = segments.filter(
    (segment) =>
      !exemptable.includes(segment) &&
      PUBLIC_TRUST_BUNDLE_BASENAMES.some((name) => matchesLeaf(segment, name)),
  );
  const plain = segments.filter(
    (segment) => !exemptable.includes(segment) && !trust.includes(segment),
  );
  return (
    `(deny file-read* file-write* (regex ${pathRegexArguments(plain)}))` +
    "(deny file-read* file-write* (require-all " +
    `(regex ${pathRegexArguments(exemptable)}) ` +
    `(require-not (regex ${JSON.stringify("/" + exemptSegment + "$")}))))` +
    trustBundleRule(trust, certificateFiles)
  );
}

/** The rule without operator-named certificate files. */
export const CREDENTIAL_PATH_SEATBELT_RULE: string = buildCredentialPathRule([]);

/**
 * Last rule of the native profile: a credential-named path is unreadable and unwritable wherever
 * it sits, including inside the workspace and the private state that earlier rules re-allow. The
 * public trust bundles, and the certificate files the operator named (`certificateFiles`, exact
 * absolute paths, read-only), are the only `*.pem` leaves it leaves to the earlier rules.
 */
export function credentialPathSeatbeltRule(certificateFiles: readonly string[] = []): string {
  return certificateFiles.length === 0
    ? CREDENTIAL_PATH_SEATBELT_RULE
    : buildCredentialPathRule(certificateFiles);
}
