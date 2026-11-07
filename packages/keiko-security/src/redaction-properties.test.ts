import { describe, expect, it } from "vitest";

import {
  characters,
  checkProperty,
  shrinkString,
  type SeededRandom,
} from "../../../tests/support/seeded-property.js";
import { redactContent } from "./content-redaction.js";
import { redact, REDACTION_PLACEHOLDER } from "./redaction.js";

// Seeded property tests for the credential floor (`redactContent` under `preserve`) and the strict
// projection (`redact`). Every secret is synthetic and built from the alphabet its shape admits.

const UPPER = characters("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
const LOWER = characters("abcdefghijklmnopqrstuvwxyz");
const DIGIT = characters("0123456789");
const ALNUM = [...UPPER, ...LOWER, ...DIGIT];
const B64URL = [...ALNUM, "-", "_"];
const UPPER_DIGIT = [...UPPER, ...DIGIT];

type Policy = "floor" | "strict";

interface Secret {
  /** The text that carries the credential, as it is written. */
  readonly text: string;
  /** The part that must not survive anywhere in the output. */
  readonly value: string;
  /** The classes only the strict projection owns (key-name and personal-data heuristics). */
  readonly strictOnly: boolean;
}

function token(
  random: SeededRandom,
  prefix: string,
  alphabet: readonly string[],
  min: number,
  max: number,
): Secret {
  const value = random.string(alphabet, min, max);
  return { text: prefix + value, value, strictOnly: false };
}

function jwt(random: SeededRandom): Secret {
  const header = "eyJ" + random.string(B64URL, 10, 30);
  const payload = "eyJ" + random.string(B64URL, 8, 30);
  const signature = random.string(B64URL, random.boolean(0.2) ? 0 : 5, 40);
  const text = `${header}.${payload}.${signature}`;
  return { text, value: header, strictOnly: false };
}

function privateKey(random: SeededRandom): Secret {
  const label = random.pick([
    "RSA PRIVATE KEY",
    "PRIVATE KEY",
    "EC PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
  ]);
  const body = random
    .array(1, 6, () => random.string([...ALNUM, "+", "/"], 16, 64))
    .join(random.pick(["\n", "\r\n"]));
  const value = random.string(ALNUM, 24, 40);
  const text = `-----BEGIN ${label}-----\n${body}\n${value}\n-----END ${label}-----`;
  return { text, value, strictOnly: false };
}

function urlCredential(random: SeededRandom): Secret {
  const scheme = random.pick(["https", "http", "postgres", "mongodb+srv", "ftp", "redis"]);
  const user = random.string(LOWER, 2, 8);
  const password = random.string([...ALNUM, "-", "_", "!", "$", "%"], 6, 24);
  const host = `${random.string(LOWER, 3, 10)}.example.test`;
  if (random.boolean(0.3)) {
    // A personal-access token used as the userinfo has no colon.
    const bare = random.string(ALNUM, 8, 30);
    return { text: `${scheme}://${bare}@${host}/r.git`, value: bare, strictOnly: false };
  }
  return { text: `${scheme}://${user}:${password}@${host}/db`, value: password, strictOnly: false };
}

function authorizationHeader(random: SeededRandom): Secret {
  const value = random.string([...ALNUM, ".", "-", "_", "~", "+", "/", "="], 8, 40);
  const scheme = random.pick(["Bearer ", "Basic ", "Token ", ""]);
  const name = random.pick([
    "Authorization",
    "authorization",
    "AUTHORIZATION",
    "Proxy-Authorization",
  ]);
  const gap = random.pick([": ", ":", "=", " : "]);
  return { text: `${name}${gap}${scheme}${value}`, value, strictOnly: false };
}

/**
 * A header value holding a character that ends a token in source: the floor masks the whole value,
 * so strict redaction must too, at least in plain text (#4271 audit).
 */
function structuredAuthorizationHeader(random: SeededRandom): Secret {
  const value =
    random.string(ALNUM, 4, 12) +
    random.pick(["$", "(", ")", "[", "]", "{", "}", "<", ">", "`"]) +
    random.string(ALNUM, 2, 16);
  const scheme = random.pick(["Bearer ", "Basic ", "Token ", ""]);
  const gap = random.pick([": ", ":", "="]);
  return {
    text: `${random.pick(["Authorization", "authorization"])}${gap}${scheme}${value}`,
    value,
    strictOnly: false,
  };
}

function encodedBearer(random: SeededRandom): Secret {
  // An encoded-looking value carries a digit, so the scheme word alone does not make it prose.
  const value = random.string([...ALNUM, ".", "-", "+", "/", "="], 8, 40) + random.pick(DIGIT);
  const scheme = random.pick(["Bearer", "Basic", "bearer", "BASIC"]);
  return { text: `${scheme}${random.pick([" ", "  ", "\t"])}${value}`, value, strictOnly: false };
}

function keyedValue(random: SeededRandom): Secret {
  const key = random.pick([
    "password",
    "passwd",
    "api_key",
    "apiKey",
    "x-api-key",
    "client_secret",
    "refresh_token",
    "access_token",
    "aws_secret_access_key",
    "secret",
    "token",
    "DB_PASSWORD",
  ]);
  const value = random.string([...ALNUM, ".", "-", "_"], 6, 32);
  const text = random.pick([
    `${key}=${value}`,
    `${key}: ${value}`,
    `"${key}": "${value}"`,
    `${key} = '${value}'`,
  ]);
  return { text, value, strictOnly: true };
}

const SECRET_MAKERS: readonly ((random: SeededRandom) => Secret)[] = [
  (r): Secret => token(r, "ghp_", ALNUM, 20, 40),
  (r): Secret => token(r, r.pick(["gho_", "ghu_", "ghs_", "ghr_"]), ALNUM, 20, 40),
  (r): Secret => token(r, "AKIA", UPPER_DIGIT, 16, 16),
  (r): Secret => token(r, "sk-", [...ALNUM, "-", "_"], 16, 48),
  (r): Secret => token(r, `xox${r.pick(characters("baprs"))}-`, [...ALNUM, "-"], 10, 30),
  (r): Secret => token(r, "AIza", [...ALNUM, "-", "_"], 20, 40),
  (r): Secret => token(r, `${r.pick(["sk", "rk"])}_${r.pick(["live", "test"])}_`, ALNUM, 16, 32),
  jwt,
  privateKey,
  urlCredential,
  authorizationHeader,
  structuredAuthorizationHeader,
  encodedBearer,
  keyedValue,
];

/** Surrounding text that cannot spell a secret or a credential context by itself. */
const NEIGHBOURS = [
  ...characters("the quick brown fox runs over lazy dogs"),
  " ",
  " ",
  "\n",
  "\r\n",
  "\t",
  "ü",
  "😀",
  "日本",
  "\u200b",
  "\u0301",
  ".",
  ",",
  "(",
  ")",
  "[",
  "]",
  ">",
];

const WRAPPERS: readonly ((text: string) => string)[] = [
  (t): string => t,
  (t): string => `"${t}"`,
  (t): string => `'${t}'`,
  (t): string =>
    `{"value": "${t.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"}`,
  (t): string => `key: ${t}`,
  (t): string => `export TOKEN_VALUE=${t}`,
  (t): string => `curl -H '${t}' https://example.test`,
  (t): string => `- ${t}`,
  (t): string => `<${t}>`,
];

interface Case {
  readonly secrets: readonly Secret[];
  readonly text: string;
}

function generateCase(random: SeededRandom): Case {
  const secrets: Secret[] = [];
  let text = random.string(NEIGHBOURS, 0, 30);
  for (const _ of random.array(1, 3, () => 0)) {
    const secret = random.pick(SECRET_MAKERS)(random);
    secrets.push(secret);
    const wrapped = random.pick(WRAPPERS)(secret.text);
    const repeated = random.boolean(0.25) ? `${wrapped} ${wrapped}` : wrapped;
    // A token glued to a word character is a different, longer run (the shapes are anchored on a
    // word boundary, and the AWS key shape is exactly 16 characters), so a space always delimits.
    text += random.pick([" ", "\n", ": ", "="]) + repeated + " " + random.string(NEIGHBOURS, 0, 30);
  }
  return { secrets, text };
}

function apply(policy: Policy, input: string, literals: readonly string[] = []): string {
  return policy === "floor" ? redactContent(input, "preserve", literals) : redact(input, literals);
}

/** The shrinker keeps the secrets and shrinks the text around them. */
function shrinkCase(input: Case): Iterable<Case> {
  return (function* (): Generator<Case> {
    for (const text of shrinkString(input.text)) yield { secrets: input.secrets, text };
  })();
}

function survivors(output: string, secrets: readonly Secret[], policy: Policy): string[] {
  return secrets
    .filter((secret) => policy === "strict" || !secret.strictOnly)
    .map((secret) => secret.value)
    .filter((value) => output.includes(value));
}

describe("credential redaction properties (#4271)", () => {
  it.each(["floor", "strict"] as const)("no generated credential survives, %s", (policy) => {
    checkProperty(
      generateCase,
      ({ secrets, text }) => {
        const output = apply(policy, text);
        // Only a secret that still stands in the input can be asked to disappear (a later
        // wrapper may cut an earlier secret's text apart).
        const present = secrets.filter((secret) => text.includes(secret.text));
        expect(survivors(output, present, policy)).toHaveLength(0);
      },
      { runs: 400, shrink: shrinkCase },
    );
  });

  it.each(["floor", "strict"] as const)(
    "a configured secret literal never survives, %s",
    (policy) => {
      checkProperty(
        (random) => {
          const literal = "L" + random.string([...ALNUM, "-", "_", ".", "/", "$", "!"], 4, 24);
          const text =
            random.string(NEIGHBOURS, 0, 20) + literal + random.string(NEIGHBOURS, 0, 20);
          const doubled = random.boolean(0.3)
            ? `${text}${random.pick([" ", "\n"])}${literal}`
            : text;
          return { literal, text: doubled };
        },
        ({ literal, text }) => {
          expect(apply(policy, text, [literal])).not.toContain(literal);
        },
        {
          runs: 300,
          shrink: (input) => [...shrinkString(input.text)].map((text) => ({ ...input, text })),
        },
      );
    },
  );

  const WORDS = [
    "build",
    "the",
    "package",
    "returns",
    "value",
    "function",
    "config",
    "import",
    "export",
    // The scheme words stay in prose; a digit after them would be an encoded-looking credential,
    // which the floor documents as redacted ("Bearer 0.0.0.1t").
    "Basic configuration",
    "Bearer authentication",
    "authentication",
    "configuration",
    "token",
    "rotation",
    "key",
    "secret",
    "user@example.com",
    "Max Mustermann",
    "DE89 3704 0044 0532 0130 00",
    "+49 170 1234567",
    "const x = foo(a, b);",
    "if (a === b) { return c; }",
    "SELECT * FROM t WHERE id = 1;",
    "/usr/local/lib/node_modules",
    "packages/keiko-security/src/redaction.ts",
    "C:\\Users\\me\\a.txt",
    "https://example.test/path?q=1",
    "git@github.com:org/repo.git",
    "ssh://git@host/r.git",
    "1.2.3",
    "10.0.0.1",
    "2026-11-06",
    "task-1234567890abcdef",
    "- item",
    "# Title",
    '"quoted"',
  ];

  it("ordinary text without a credential shape is preserved unchanged under preserve", () => {
    checkProperty(
      (random) =>
        random.array(0, 40, () => random.pick(WORDS)).join(random.pick([" ", "\n", ", "])),
      (text) => {
        expect(redactContent(text, "preserve")).toBe(text);
      },
      { runs: 300, shrink: shrinkString },
    );
  });

  function mixed(random: SeededRandom): string {
    const parts = random.array(0, 8, () =>
      random.boolean(0.5) ? random.pick(SECRET_MAKERS)(random).text : random.pick(WORDS),
    );
    return parts.join(random.pick([" ", "\n", "="])) + random.string(NEIGHBOURS, 0, 10);
  }

  // 400 runs of two strict projections take about 2.5 s locally and more than the 15 s default under
  // CI coverage instrumentation; these runs found the idempotence defect, so the bound grows, not
  // the run count shrinks.
  const IDEMPOTENCE_TIMEOUT_MS = 60_000;

  it.each(["floor", "strict"] as const)(
    "redaction is idempotent, %s",
    (policy) => {
      checkProperty(
        mixed,
        (text) => {
          const once = apply(policy, text);
          expect(apply(policy, once)).toBe(once);
        },
        { runs: 400, shrink: shrinkString },
      );
    },
    IDEMPOTENCE_TIMEOUT_MS,
  );

  const HOSTILE = characters("ab c\n\r\t\0\u0001\u007f=:\"'[]{}-_/\\.@").concat([
    "\ud800",
    "\udc00",
    "\ud83d",
    "😀",
    "Bearer ",
    "password=",
    "-----BEGIN PRIVATE KEY-----",
    "://",
    "eyJ",
    "sk-",
    "ghp_",
    "\u2028",
    "\ufeff",
  ]);

  it.each(["floor", "strict"] as const)("never throws on arbitrary strings, %s", (policy) => {
    checkProperty(
      (random) => random.string(HOSTILE, 0, 200),
      (text) => {
        expect(typeof apply(policy, text, ["abcd", "x\u0000yz"])).toBe("string");
      },
      { runs: 500, shrink: shrinkString },
    );
  });

  it.each(["floor", "strict"] as const)(
    "handles the empty string and 64 KiB inputs, %s",
    (policy) => {
      expect(apply(policy, "")).toBe("");
      checkProperty(
        (random) => {
          // One line only: strict source inference re-parses the remainder at every line that
          // looks like source, so many such lines cost quadratic time. That cost is an open #4271
          // finding; a time bound cannot separate it from real documents without masking them.
          const unit = random.string(HOSTILE, 1, 64).replaceAll(/[\n\r]/gu, " ");
          return unit.repeat(Math.ceil(65_536 / unit.length)).slice(0, 65_536);
        },
        (text) => {
          expect(typeof apply(policy, text)).toBe("string");
        },
        { runs: 6 },
      );
    },
  );

  it("uses the shared placeholder", () => {
    expect(apply("floor", `ghp_${"a".repeat(24)}`)).toContain(REDACTION_PLACEHOLDER);
  });
});
