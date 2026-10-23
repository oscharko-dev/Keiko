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

function pathRegexArguments(segments: readonly string[]): string {
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
    .map((chunk) => JSON.stringify(`(^|/)(${chunk.join("|")})(/|$)`))
    .join(" ");
}

function buildCredentialPathRule(): string {
  const exemptSegment = segmentRegex(ENV_EXAMPLE_BASENAME);
  const segments = CREDENTIAL_PATH_DENY_PATTERNS.map(segmentRegex);
  // `.env.example` is the one documented exception to `.env.*`, exactly as in `isDenied`. It is
  // carved out of the pattern that would match it, never out of a denied directory beneath which
  // it sits: that directory's own segment still denies it.
  const exemptable = segments.filter((segment) =>
    new RegExp(`^${segment}$`, "u").test(ENV_EXAMPLE_BASENAME),
  );
  const plain = segments.filter((segment) => !exemptable.includes(segment));
  return (
    `(deny file-read* file-write* (regex ${pathRegexArguments(plain)}))` +
    "(deny file-read* file-write* (require-all " +
    `(regex ${pathRegexArguments(exemptable)}) ` +
    `(require-not (regex ${JSON.stringify(`/${exemptSegment}$`)}))))`
  );
}

/**
 * Last rule of the native profile: a credential-named path is unreadable and unwritable wherever
 * it sits, including inside the workspace and the private state that earlier rules re-allow.
 */
export const CREDENTIAL_PATH_SEATBELT_RULE: string = buildCredentialPathRule();
