import { isAbsolute, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_PATH_DENY_PATTERNS,
  ENV_EXAMPLE_BASENAME,
  TOOL_STATE_PATH_DENY_PATTERNS,
} from "@oscharko-dev/keiko-contracts/sensitive-path-patterns";
import {
  characters,
  checkProperty,
  shrinkString,
  shrinkWithin,
  type SeededRandom,
} from "../../../tests/support/seeded-property.js";
import { PathEscapeError } from "./errors.js";
import { isDenied } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";

/**
 * #4271: lexical workspace containment and the always-on deny list, against an independent
 * `node:path` specification. Generated paths mix traversal segments, separator runs, absolute,
 * drive and UNC spellings, control characters, percent-encoding, Unicode lookalikes and
 * normalization variants. A path is either admitted inside the root or refused with PathEscapeError.
 */

const ROOT = "/repo/root";
const SEGMENTS = [
  "..",
  ".",
  "",
  "a",
  "b",
  "src",
  "...",
  ".. ",
  "%2e%2e",
  "%2E%2E%2F",
  "\uFF0E\uFF0E",
  "\u2024\u2024",
  "\u2025",
  "\u00E9",
  "e\u0301",
  "\u0001",
  "\n",
  "C:",
  "\\",
  "..\\",
  "\\\\srv\\share",
  "~",
  ".env",
  "x".repeat(300),
];
const PREFIXES = ["", "", "/", "./", "../", "//", "C:\\", "\\\\", "/repo/root/", "/repo/root-x/"];
const SEPARATORS = ["/", "/", "//", "/./", "\\"];

function candidate(random: SeededRandom): string {
  const parts = random.array(0, 8, () => random.pick(SEGMENTS));
  let joined = random.pick(PREFIXES);
  for (const [index, part] of parts.entries()) {
    joined += (index === 0 ? "" : random.pick(SEPARATORS)) + part;
  }
  return random.boolean(0.2) ? `${joined}/` : joined;
}

function specAdmits(candidatePath: string): boolean {
  const resolved = resolve(ROOT, candidatePath);
  const rel = relative(ROOT, resolved);
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

function outcome(candidatePath: string): string {
  try {
    return resolveWithinWorkspace(ROOT, candidatePath);
  } catch (error) {
    if (error instanceof PathEscapeError) return "refused";
    throw error;
  }
}

describe("resolveWithinWorkspace properties (#4271)", () => {
  it("admits exactly the paths that resolve inside the root, and only refuses with PathEscapeError", () => {
    checkProperty(
      candidate,
      (path) => {
        const result = outcome(path);
        const expected = path.includes("\u0000") || !specAdmits(path);
        if (expected) {
          expect(result).toBe("refused");
          return;
        }
        expect(result).toBe(resolve(ROOT, path));
        expect(specAdmits(result)).toBe(true);
        expect(outcome(path)).toBe(result);
      },
      { shrink: shrinkString },
    );
  });

  it("refuses a NUL byte wherever it sits", () => {
    checkProperty(
      (random) => {
        const text = candidate(random);
        const at = random.integer(0, text.length);
        return `${text.slice(0, at)}\u0000${text.slice(at)}`;
      },
      (path) => {
        expect(outcome(path)).toBe("refused");
      },
      { shrink: shrinkWithin(shrinkString, (path) => path.includes("\u0000")) },
    );
  });

  it("never throws anything but PathEscapeError on arbitrary text", () => {
    checkProperty(
      (random) => random.string(characters("./\\:%~\u0000\uFF0E\u2024 aé\ud83d\ude00"), 0, 40),
      (path) => {
        outcome(path);
      },
      { shrink: shrinkString },
    );
  });
});

const DENIED_NAMES = [...CREDENTIAL_PATH_DENY_PATTERNS, ...TOOL_STATE_PATH_DENY_PATTERNS].map(
  (pattern) => pattern.replaceAll("*", "x1"),
);

function randomCase(random: SeededRandom, text: string): string {
  return Array.from(text)
    .map((c) => (random.boolean() ? c.toUpperCase() : c.toLowerCase()))
    .join("");
}

function deniedSpelling(random: SeededRandom): string {
  const name =
    randomCase(random, random.pick(DENIED_NAMES)) +
    random.pick(["", "", "", ".", " ", "...", ". .", "::$DATA", ":stream"]);
  const dirs = random.array(0, 3, () => random.pick(["a", "src", "x.y", ".", "", "..", "B"]));
  const nested = random.boolean(0.3)
    ? `${name}/${random.pick(["child", "a/b", ".env.example"])}`
    : name;
  const body = [...dirs, nested].join(random.pick(["/", "//", "/./", "\\"]));
  const lead = random.pick(["", "./", "", "/"]);
  return `${lead}${body}${random.pick(["", "", "/", "///", "\\"])}`;
}

describe("isDenied fixed pins (#4271)", () => {
  // Windows resolves a trailing dot or space, and an alternate-data-stream suffix, to the plain
  // name. Each spelling reaches a denied file there, so it must stay denied on every platform.
  it.each([".env ", ".ssh.", ".ssh ", "id_rsa.", "a.pem ", ".env::$DATA", "x/.aws. ./y"])(
    "denies the Windows alias spelling %j",
    (path) => {
      expect(isDenied(path)).toBe(true);
    },
  );

  it("allows the example env file only where no denied name is above it", () => {
    expect(isDenied(ENV_EXAMPLE_BASENAME)).toBe(false);
    expect(isDenied(`src/${ENV_EXAMPLE_BASENAME}`)).toBe(false);
    expect(isDenied(`.ssh/${ENV_EXAMPLE_BASENAME}`)).toBe(true);
    expect(isDenied(`.env/${ENV_EXAMPLE_BASENAME}`)).toBe(true);
  });

  it("keeps allowing ordinary names that merely resemble them", () => {
    for (const path of ["env", "ssh.txt", "a.pe", "keys/readme", "id_rsa_notes", "x. y"]) {
      expect(isDenied(path)).toBe(false);
    }
  });
});

describe("isDenied properties (#4271)", () => {
  it("denies every documented spelling of every denied name", () => {
    checkProperty(
      deniedSpelling,
      (path) => {
        // Every spelling keeps a denied name as one of its segments. The one documented exception,
        // the exact example file, only ever appears below that name here, so it never excuses one.
        expect(isDenied(path)).toBe(true);
      },
      // No shrink: a shorter string no longer spells a denied name, so every candidate would
      // "fail" and the report would end at a misleading empty path.
    );
  });

  it("is deterministic and never throws on arbitrary text", () => {
    checkProperty(
      (random) => random.string(characters("./\\.envEnvssh\u0000 %\uFF0E\u2024aé"), 0, 40),
      (path) => {
        expect(isDenied(path)).toBe(isDenied(path));
      },
      { shrink: shrinkString },
    );
  });
});
