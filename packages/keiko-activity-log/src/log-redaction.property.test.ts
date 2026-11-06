import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  checkProperty,
  shrinkString,
  type SeededRandom,
} from "../../../tests/support/seeded-property.js";
import { sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import { looksLikePersonalIdentifier } from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  isDeniedLogFieldName,
  REDACTED_KEY,
  redactLogFields,
  redactLogString,
} from "./log-redaction.js";

/**
 * Seeded property tests of the Activity Log sink privacy filter (owner decision 2026-11-04: the
 * log carries no personal data, and its sink over-redacts). All personal data below is synthetic.
 * The label policy itself (`looksLikePersonalIdentifier`) is owned by keiko-contracts; these
 * properties drive it through the sink (`redactLogString`, `redactLogFields`) that persists it.
 */

type Generator = (random: SeededRandom) => string;

const DIGITS = "0123456789".split("");
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const LOWER = "abcdefghijklmnopqrstuvwxyz".split("");

const digits = (random: SeededRandom, count: number): string => random.string(DIGITS, count, count);

// ISO 13616 lengths for a few countries; the check digits are computed here with mod 97-10 so the
// lowercase spelling carries a VALID checksum (the sink recognises lowercase only by checksum).
const IBAN_FORMATS: readonly (readonly [string, number])[] = [
  ["DE", 22],
  ["GB", 22],
  ["FR", 27],
  ["IT", 27],
  ["ES", 24],
  ["NL", 18],
  ["AT", 20],
  ["CH", 21],
  ["BE", 16],
  ["PL", 28],
];

function ibanCheckDigits(country: string, bban: string): string {
  const rearranged = `${bban}${country}00`;
  let remainder = 0;
  for (const char of rearranged) {
    const digit = Number.parseInt(char, 36);
    remainder = (remainder * (digit < 10 ? 10 : 100) + digit) % 97;
  }
  return String(98 - remainder).padStart(2, "0");
}

function compactIban(random: SeededRandom): string {
  const [country, length] = random.pick(IBAN_FORMATS);
  // Numeric BBAN keeps the generator simple; letters appear in the bank code of real accounts.
  const bban = digits(random, length - 4);
  return `${country}${ibanCheckDigits(country, bban)}${bban}`;
}

function groupedIban(random: SeededRandom): string {
  const iban = compactIban(random);
  const separator = random.pick([" ", "-", ""]);
  return (iban.match(/.{1,4}/gu) ?? [iban]).join(separator);
}

function lowercaseIban(random: SeededRandom): string {
  return compactIban(random).toLowerCase();
}

function internationalPhone(random: SeededRandom): string {
  const country = random.pick(["1", "44", "49", "33", "39", "34", "90", "91"]);
  const separator = random.pick([" ", "-", ".", "/", ""]);
  // At least seven digits after the country code: shorter is no real subscriber number, and the
  // policy's telephone shape starts at seven.
  const groups = random.array(2, 4, () => digits(random, random.integer(4, 5)));
  const body = groups.join(separator);
  return random.boolean(0.3) ? `+${country} (${body})` : `+${country}${separator}${body}`;
}

function nationalPhone(random: SeededRandom): string {
  const area = `0${random.pick(["171", "151", "160", "30", "89", "40", "69", "211"])}`;
  const subscriber = digits(random, random.integer(6, 8));
  return `${area}${random.pick(["-", "/", " ", ""])}${subscriber}`;
}

function cardOrAccountNumber(random: SeededRandom): string {
  const length = random.integer(13, 19);
  const raw = digits(random, length);
  const separator = random.pick(["", " ", "-"]);
  return (raw.match(/.{1,4}/gu) ?? [raw]).join(separator);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function dateWithYear(random: SeededRandom): string {
  const day = pad(random.integer(1, 28));
  const month = pad(random.integer(1, 12));
  const year = String(random.integer(1920, 2029));
  switch (random.integer(0, 3)) {
    case 0:
      return `${day}.${month}.${year}`;
    case 1:
      return `${day}/${month}/${year}`;
    case 2:
      return `${year}-${month}-${day}`;
    default:
      return `${year}${month}${day}`;
  }
}

function ipv4(random: SeededRandom): string {
  for (;;) {
    const octets = random.array(4, 4, () => random.integer(0, 255));
    // Loopback and unspecified addresses identify no one's machine: the contract allows them.
    if (octets[0] === 127 || octets.every((octet) => octet === 0)) continue;
    return octets.join(".");
  }
}

function remoteUrl(random: SeededRandom): string {
  const scheme = random.pick(["http", "https", "ftp", "ssh", "wss", "postgres", "HTTPS"]);
  const label = random.string(LOWER, 3, 10);
  const host = random.pick([
    `${label}.example.test`,
    `${label}.${random.string(LOWER, 2, 6)}.example.test`,
    `${label}.example.test:${String(random.integer(1, 65535))}`,
    ipv4(random),
  ]);
  const tail = random.pick(["", "/", `/${random.string(LOWER, 1, 8)}`, "?a=1"]);
  return `${scheme}://${host}${tail}`;
}

// Documented limit, not a defect: a lowercase surname alone is indistinguishable from any
// identifier, so the name class is the capitalised single word the policy documents.
function personName(random: SeededRandom): string {
  const word = (): string => `${random.pick(UPPER)}${random.string(LOWER, 2, 10)}`;
  return random.boolean(0.3) ? `${word()}-${word()}` : word();
}

function email(random: SeededRandom): string {
  const local = random.string([...LOWER, ...DIGITS, ".", "_", "-"], 1, 12);
  const domain = `${random.string(LOWER, 2, 8)}.${random.pick(["test", "example", "invalid"])}`;
  return `${random.pick(["", "mailto:"])}${local}@${domain}`;
}

const CLASSES: readonly (readonly [string, Generator])[] = [
  [
    "compact or grouped IBAN",
    (random) => (random.boolean() ? groupedIban(random) : compactIban(random)),
  ],
  ["lowercase IBAN", lowercaseIban],
  ["international telephone", internationalPhone],
  ["national telephone", nationalPhone],
  ["card or account number", cardOrAccountNumber],
  ["date with a year", dateWithYear],
  ["IPv4 address", ipv4],
  ["remote URL", remoteUrl],
  ["personal name", personName],
  ["email address", email],
];

// Delimiters a value can stand next to inside a longer, space-free token. Alphanumerics, `.`, `-`
// and `_` are deliberately not here: they continue an identifier, and that is where the policy
// documents digests, counters and versions (`corr-root-00000001`) are left readable.
const OPENERS = ["", "(", "[", "{", '"', "'", "=", ":", ",", ";", "|", "<", "#", "@", "~", "!"];
const CLOSERS = ["", ")", "]", "}", '"', "'", ",", ";", "|", ">", "#", "!", "?", "/"];

interface Case {
  readonly label: string;
  readonly core: string;
  readonly opener: string;
  readonly closer: string;
  readonly value: string;
}

function makeCase(label: string, core: string, opener: string, closer: string): Case {
  return { label, core, opener, closer, value: `${opener}${core}${closer}` };
}

function generateCase(random: SeededRandom): Case {
  const [label, generator] = random.pick(CLASSES);
  const core = generator(random);
  // A name is judged only standing alone (documented in the label policy): embedded in a token it
  // is indistinguishable from an enum word or a code (`reason=Timeout`), so it is never wrapped.
  const embed = label !== "personal name" && random.boolean(0.6);
  return makeCase(
    label,
    core,
    embed ? random.pick(OPENERS) : "",
    embed ? random.pick(CLOSERS) : "",
  );
}

// Shrinks the embedding only: shrinking the core character by character leaves the class, and a
// counterexample outside the class is not a counterexample.
function* shrinkCase(input: Case): Generator<Case> {
  if (input.opener !== "") yield makeCase(input.label, input.core, "", input.closer);
  if (input.closer !== "") yield makeCase(input.label, input.core, input.opener, "");
}

const FIELD_NAMES = ["stage", "detail", "kind", "ref", "x", "contact_hint", "a.b", "N1"];

function leafStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => leafStrings(entry, into));
  else if (typeof value === "object" && value !== null) {
    Object.values(value).forEach((entry) => leafStrings(entry, into));
  }
  return into;
}

describe("sink privacy filter properties", () => {
  it("never accepts a forbidden-class value unchanged, as a string or under any field", () => {
    checkProperty(
      generateCase,
      ({ value }) => {
        expect(redactLogString(value)).not.toBe(value);
        const name = FIELD_NAMES[value.length % FIELD_NAMES.length] ?? "stage";
        const carried = redactLogFields({
          [name]: value,
          list: [value],
          nested: { inner: [value], deeper: { leaf: value } },
        });
        // Every accepted leaf is a marker or a dropped branch; the value never survives verbatim.
        for (const leaf of leafStrings(carried)) expect(leaf).not.toContain(value);
        expect(JSON.stringify(carried ?? {})).not.toContain(JSON.stringify(value).slice(1, -1));
      },
      { runs: 1500, shrink: shrinkCase },
    );
  });

  it("refuses a value embedded in a JSON-like string whatever delimiter surrounds it", () => {
    checkProperty(
      generateCase,
      ({ label, value }) => {
        // Documented limit: a bare name is judged only standing alone (see generateCase).
        if (label === "personal name") return;
        const wrappers = [`{"k":"${value}"}`, `[${value}]`, `k=${value}`, `k:${value};`];
        for (const wrapped of wrappers) expect(redactLogString(wrapped)).not.toBe(wrapped);
      },
      { runs: 600, shrink: shrinkCase },
    );
  });

  it("refuses a personal field name in every spelling, at any depth", () => {
    // The names are the owner's classes: a name, IBAN, telephone, account and address field.
    const names = [
      "email",
      "phone",
      "phoneNumber",
      "iban",
      "firstName",
      "lastName",
      "fullName",
      "displayName",
      "accountNumber",
      "ipAddress",
      "dateOfBirth",
      "username",
      "address",
      "street",
      "surname",
    ];
    const spell = (random: SeededRandom, name: string): string => {
      const separator = random.pick(["", "_", "-"]);
      const words = name
        .replace(/([A-Z])/gu, " $1")
        .toLowerCase()
        .split(" ");
      const joined = words.join(separator);
      return random.pick([
        joined,
        joined.toUpperCase(),
        name,
        `${joined[0]?.toUpperCase() ?? ""}${joined.slice(1)}`,
      ]);
    };
    checkProperty(
      (random) => spell(random, random.pick(names)),
      (name) => {
        expect(isDeniedLogFieldName(name)).toBe(true);
        expect(redactLogFields({ [name]: "x1" })).toStrictEqual({ [name]: REDACTED_KEY });
        expect(redactLogFields({ outer: { [name]: ["x1"] } })).toStrictEqual({
          outer: { [name]: REDACTED_KEY },
        });
      },
      { runs: 300, shrink: shrinkString },
    );
  });

  it("refuses a remote host under a host field and keeps the local binding readable", () => {
    checkProperty(
      remoteHostOrIp,
      (host) => {
        for (const name of ["host", "hostname", "Host", "HOSTNAME"]) {
          expect(redactLogFields({ [name]: host })).toStrictEqual({
            [name]: "[redacted:personal]",
          });
        }
      },
      { runs: 300, shrink: shrinkString },
    );
    // `[::1]` is in the production allow-list but is refused as a structured payload before the
    // value is returned; that is over-redaction, not a leak, so it is not asserted readable.
    for (const local of ["localhost", "127.0.0.1", "0.0.0.0", "::1"]) {
      expect(redactLogFields({ host: local })).toStrictEqual({ host: local });
    }
  });
});

function remoteHostOrIp(random: SeededRandom): string {
  const label = random.string(LOWER, 2, 10);
  return random.boolean()
    ? ipv4(random)
    : `${label}.${random.pick(["example.test", "corp.example.test", "invalid"])}`;
}

describe("sink allowed shapes", () => {
  const catalog = JSON.parse(
    readFileSync(
      new URL("../../../docs/observability/op-catalog.generated.json", import.meta.url),
      "utf8",
    ),
  ) as { readonly operations: readonly string[] };

  it("passes every registered operation name that holds no space unchanged", () => {
    // Derived from the production registry, not restated. Route operations hold a space by design
    // and are judged by the route-template reducer elsewhere.
    const names = catalog.operations.filter((operation) => !operation.includes(" "));
    expect(names.length).toBeGreaterThan(100);
    checkProperty(
      (random) => random.pick(names),
      (operation) => {
        expect(redactLogString(operation)).toBe(operation);
        expect(redactLogFields({ subject: operation })).toStrictEqual({ subject: operation });
      },
      { runs: 400 },
    );
  });

  it("passes counts, flags, digests and correlation-shaped ids unchanged", () => {
    checkProperty(
      (random) => ({
        count: random.integer(0, 2_000_000_000),
        flag: random.boolean(),
        // The production digest function, never a restated hash.
        digest: sha256Hex(random.string(LOWER, 0, 32)),
        sequence: `corr-root-${digits(random, 8)}`,
        loopback: `127.${String(random.integer(0, 255))}.${String(random.integer(0, 255))}.${String(random.integer(1, 255))}`,
        version: `${String(random.integer(0, 30))}.${String(random.integer(0, 30))}.${String(random.integer(0, 30))}`,
        instant: new Date(random.integer(0, 4_000_000_000) * 1000).toISOString(),
      }),
      (fields) => {
        expect(redactLogFields({ ...fields, listed: [fields.digest] })).toStrictEqual({
          ...fields,
          listed: [fields.digest],
        });
      },
      { runs: 400 },
    );
  });

  it("keeps a short all-digit hex id readable under the generated-hex field names only", () => {
    checkProperty(
      // Seven to nineteen digits is the number shape; a longer run is documented as a digest.
      (random) => digits(random, random.integer(8, 19)),
      (hex) => {
        expect(redactLogFields({ xInstanceId: hex })).toStrictEqual({ xInstanceId: hex });
        expect(redactLogFields({ bodyDigest: hex })).toStrictEqual({ bodyDigest: hex });
        expect(redactLogFields({ stage: hex })).not.toStrictEqual({ stage: hex });
      },
      { runs: 200 },
    );
  });
});

describe("sink totality and determinism", () => {
  const ALPHABET = [
    ..."aZ09 .-_/\\:@+()[]{}\"'=,;<>#%~!?*\t\n",
    "é",
    "日",
    " ",
    "\u0000",
    "😀",
    "https://",
    "+49",
    "DE89",
  ];

  function arbitraryValue(random: SeededRandom, depth: number): unknown {
    const kind = random.integer(0, depth > 0 ? 6 : 4);
    switch (kind) {
      case 0:
        return random.string(ALPHABET, 0, 40);
      case 1:
        return random.integer(-1000, 1000) / random.pick([1, 3, 0]);
      case 2:
        return random.boolean();
      case 3:
        return random.pick([null, undefined, Number.NaN, BigInt(7), Symbol("s")]);
      case 4:
        return random.string(ALPHABET, 150, 400);
      case 5:
        return random.array(0, 20, () => arbitraryValue(random, depth - 1));
      default:
        return Object.fromEntries(
          random.array(0, 8, () => [
            random.string(ALPHABET, 0, 12),
            arbitraryValue(random, depth - 1),
          ]),
        );
    }
  }

  it("never throws on arbitrary input and is deterministic", () => {
    checkProperty(
      (random) => arbitraryValue(random, 4),
      (input) => {
        const first = redactLogFields(input);
        const second = redactLogFields(input);
        expect(second).toStrictEqual(first);
        // The output is a fixed point of the filter's own string rule.
        if (typeof input === "string") {
          const once = redactLogString(input);
          expect(redactLogString(once)).toBe(once);
        }
      },
      { runs: 800 },
    );
    checkProperty(
      (random) => random.string(ALPHABET, 0, 300),
      (text) => {
        const once = redactLogString(text);
        expect(redactLogString(text)).toBe(once);
        expect(once.length).toBeLessThanOrEqual(Math.max(text.length, 40));
        expect(looksLikePersonalIdentifier(text)).toBe(looksLikePersonalIdentifier(text));
      },
      { runs: 1500, shrink: shrinkString },
    );
  });
});
