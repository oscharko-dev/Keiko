import { describe, expect, it } from "vitest";

import { looksLikeSecretShape } from "@oscharko-dev/keiko-contracts/memory";

import { looksLikeEuDePii, scanForSecrets } from "./secret-patterns.js";

// Literal credential shapes are assembled by string concatenation so push-protection scanners
// never see a real-looking secret in source. Each fragment is meaningless in isolation; the
// concatenated string is a SHAPE for the regex to match on, not a real secret.

// The same rule applies to payment-card shapes. These are the well-known non-issuable test
// numbers, but a spaced or dashed PAN written literally still trips PII/secret scanners, so the
// digit groups are joined at runtime and the chosen separator is what each case is actually about.
const VISA_GROUPS = ["4111", "1111", "1111", "1111"];
const MASTERCARD_GROUPS = ["5500", "0000", "0000", "0004"];
const AMEX_GROUPS = ["34", "0000", "0000", "0000", "9"];
// 13 digits, deliberately Luhn-invalid: the benign long number the naive digit-run pattern used to
// reject and the canonical detector correctly accepts.
const NON_LUHN_REFERENCE = ["123", "4567", "8901", "23"].join("");

function pan(groups: readonly string[], separator: string): string {
  return groups.join(separator);
}

describe("scanForSecrets — credential-shape patterns (looksLikeSecretShape parity + extensions)", () => {
  it("rejects an OpenAI-style key shape", () => {
    const shape = "sk" + "-" + "abcdef0123456789abcdef0123";
    expect(scanForSecrets(`api key: ${shape}`)).toBe("credential-shape");
  });

  it("rejects an AWS access-key id shape", () => {
    const shape = "AKIA" + "ABCDEFGHIJKLMNOP";
    expect(scanForSecrets(`access key: ${shape}`)).toBe("credential-shape");
  });

  it("rejects a GitHub personal-access-token shape", () => {
    const shape = "gh" + "p_" + "abcdef0123456789abcdef0123456789ABCD";
    expect(scanForSecrets(shape)).toBe("credential-shape");
  });

  it("rejects a Slack-style token shape", () => {
    const shape = "xox" + "b-" + "1234567890-abcdefghij";
    expect(scanForSecrets(shape)).toBe("credential-shape");
  });

  it("rejects a three-part JWT shape", () => {
    const shape = "eyJ" + "abcdef12.abcdef1234.abcdef9876";
    expect(scanForSecrets(`token: ${shape}`)).toBe("credential-shape");
  });

  it("rejects a PEM private-key header", () => {
    const shape = "-----BEGIN RSA PRIVATE KEY-----";
    expect(scanForSecrets(`my key: ${shape}`)).toBe("credential-shape");
  });

  it("rejects a long contiguous digit run (PAN/IBAN shape)", () => {
    expect(scanForSecrets(`card: ${pan(VISA_GROUPS, "")}`)).toBe("credential-shape");
  });

  // This module's header claims parity with looksLikeSecretShape, but its digit element was a bare
  // /\b\d{13,19}\b/ where the contracts implementation strips separators and Luhn-validates. The
  // divergence ran in BOTH directions, and the wrong way round: the PRIMARY write-time boundary
  // missed the human-typed spaced/dashed card numbers the weaker audit-time check catches, while
  // rejecting benign long numbers the audit-time check accepts.
  it("rejects a space-separated payment card number", () => {
    expect(scanForSecrets(`My card is ${pan(VISA_GROUPS, " ")}, please charge it`)).toBe(
      "credential-shape",
    );
  });

  it("rejects a dash-separated payment card number", () => {
    expect(scanForSecrets(`${pan(VISA_GROUPS, "-")} is the number`)).toBe("credential-shape");
  });

  it("does not reject a benign long digit run that fails the Luhn check", () => {
    expect(scanForSecrets(`order reference ${NON_LUHN_REFERENCE}`)).toBeNull();
  });

  // The two "parity" claims must not be able to drift apart again silently. The write-time gate is
  // allowed to be STRICTER (it owns Bearer tokens, URL creds and form-encoded assignments), but on
  // PAN-shaped input alone the two must agree exactly.
  it("classifies PAN-shaped input identically to looksLikeSecretShape", () => {
    const panShapedInputs = [
      pan(VISA_GROUPS, ""),
      `My card is ${pan(VISA_GROUPS, " ")}, please charge it`,
      `${pan(VISA_GROUPS, "-")} is the number`,
      pan(MASTERCARD_GROUPS, " "),
      pan(AMEX_GROUPS, ""),
      `order reference ${NON_LUHN_REFERENCE}`,
      "we have 12 open issues",
      "build 20240131 finished",
      `ticket ${"9".repeat(16)} closed`,
    ];
    for (const input of panShapedInputs) {
      expect([input, scanForSecrets(input) === "credential-shape"]).toEqual([
        input,
        looksLikeSecretShape(input),
      ]);
    }
  });

  it("rejects an opaque Bearer authorization header", () => {
    const value = ["Bearer", " ", "opaque-token-1234567890"].join("");
    expect(scanForSecrets(value)).toBe("credential-shape");
  });

  it("rejects a lowercase bearer authorization header", () => {
    const value = "bearer opaque-token-1234567890";
    expect(scanForSecrets(value)).toBe("credential-shape");
  });

  it("rejects a URL with embedded basic-auth credentials", () => {
    const url = "https://alice:p4ssw0rd@example.com/repo.git";
    expect(scanForSecrets(`clone ${url}`)).toBe("credential-shape");
  });

  it("rejects a form-encoded password assignment", () => {
    expect(scanForSecrets("logged in with password=hunter2 today")).toBe("credential-shape");
  });

  it("rejects a form-encoded secret assignment", () => {
    expect(scanForSecrets("export secret=abc123")).toBe("credential-shape");
  });

  it("rejects a form-encoded api_key assignment", () => {
    expect(scanForSecrets("api_key=ZZZ-yyy")).toBe("credential-shape");
  });

  it("rejects a form-encoded token assignment", () => {
    expect(scanForSecrets("token=abcdefgh")).toBe("credential-shape");
  });
});

describe("scanForSecrets — private-credential-path patterns", () => {
  it("rejects a path to an SSH private key", () => {
    expect(scanForSecrets("see ~/.ssh/id_rsa for the key")).toBe("private-credential-path");
  });

  it("rejects a path to an SSH ed25519 key under any prefix", () => {
    expect(scanForSecrets("/home/me/.ssh/id_ed25519 is mine")).toBe("private-credential-path");
  });

  it("rejects a path to ~/.aws/credentials", () => {
    expect(scanForSecrets("look at ~/.aws/credentials")).toBe("private-credential-path");
  });

  it("rejects a path to .npmrc", () => {
    expect(scanForSecrets("config in ./.npmrc")).toBe("private-credential-path");
  });

  it("rejects a path to .env", () => {
    expect(scanForSecrets("see ./.env for vars")).toBe("private-credential-path");
  });

  it("rejects a path to a .env.<environment> file", () => {
    expect(scanForSecrets("see ./.env.production for vars")).toBe("private-credential-path");
  });
});

describe("scanForSecrets — provider base URLs", () => {
  it("rejects provider base URLs called out explicitly in natural language", () => {
    expect(
      scanForSecrets("remember that our provider base URL is https://llm.internal.example.com/v1"),
    ).toBe("provider-base-url");
  });

  it("rejects an OpenAI-compatible endpoint URL even without nearby provider wording", () => {
    expect(scanForSecrets("https://gateway.example.invalid/openai/v1")).toBe("provider-base-url");
  });

  it("does not reject an ordinary documentation URL", () => {
    expect(scanForSecrets("remember that docs live at https://docs.example.com/setup")).toBeNull();
  });

  // SonarCloud S8786: the pathname trailing-slash strip used to be the unanchored `/\/+$/u`.
  // Without a `^` anchor, the engine retries the match at every position inside a long slash run
  // whenever the string doesn't end in "/" — quadratic in input length (confirmed empirically:
  // ~1.6s at 64k characters before the fix). `value` here is attacker-influenced free text, so
  // this must stay linear even on an adversarially long URL path.
  it("stays fast on a URL whose path is a long non-terminating slash run (regression for SonarCloud S8786)", () => {
    const raw = `https://docs.example.com${"/".repeat(20_000)}end`;
    const start = Date.now();
    const result = scanForSecrets(raw);
    expect(Date.now() - start).toBeLessThan(1500);
    expect(result).toBeNull();
  });
});

describe("scanForSecrets — raw log content", () => {
  it("rejects severity plus ISO timestamp log lines", () => {
    expect(
      scanForSecrets("ERROR 2026-06-08T06:00:00Z worker failed while processing module X"),
    ).toBe("raw-log-content");
  });

  it("rejects stack-trace style content with repeated frames", () => {
    expect(scanForSecrets("stack trace line 1 at foo() line 2 at bar()")).toBe("raw-log-content");
  });

  it("does not reject plain prose that mentions a module failure", () => {
    expect(scanForSecrets("remember that module X failed during a deploy rehearsal")).toBeNull();
  });
});

describe("scanForSecrets — customer-identifier matchers (caller-injected)", () => {
  it("returns customer-identifier when a caller matcher fires", () => {
    const matchers = [/\bAcmeCorp\b/];
    expect(scanForSecrets("remember that AcmeCorp uses postgres", matchers)).toBe(
      "customer-identifier",
    );
  });

  it("returns null when no caller matchers and no built-in match", () => {
    expect(scanForSecrets("remember that I prefer dark mode")).toBeNull();
  });

  it("returns null when matchers list is empty and no built-in match", () => {
    expect(scanForSecrets("benign text here", [])).toBeNull();
  });

  it("prefers credential-shape over a customer matcher when both could fire", () => {
    const matchers = [/\bAcmeCorp\b/];
    const shape = "AKIA" + "ABCDEFGHIJKLMNOP";
    expect(scanForSecrets(`AcmeCorp uses ${shape}`, matchers)).toBe("credential-shape");
  });
});

describe("scanForSecrets — benign content", () => {
  it("returns null for natural-language preferences", () => {
    expect(scanForSecrets("I prefer two-space indentation in TypeScript")).toBeNull();
  });

  it("returns null for short digit runs (under PAN length)", () => {
    expect(scanForSecrets("we have 12 open issues")).toBeNull();
  });

  it("returns null for a path that is not a credential store", () => {
    expect(scanForSecrets("see src/utils/parser.ts for the helper")).toBeNull();
  });

  it("returns null for a general-purpose API docs note without a provider endpoint shape", () => {
    expect(scanForSecrets("The API docs are at https://docs.example.com/reference")).toBeNull();
  });
});

describe("looksLikeEuDePii — review-policy markers, not hard rejections", () => {
  it("detects German IBANs with grouped spaces", () => {
    expect(looksLikeEuDePii("DE89 3704 0044 0532 0130 00")).toBe(true);
  });

  it("detects German IBANs obfuscated with tab separators", () => {
    expect(looksLikeEuDePii("DE89\t3704\t0044\t0532\t0130\t00")).toBe(true);
  });

  it("detects a labeled German Steuer-ID while avoiding unlabeled long numbers", () => {
    expect(looksLikeEuDePii("Steuer-ID: 12 345 678 901")).toBe(true);
    expect(looksLikeEuDePii("Benchmark 12345678901 passed")).toBe(false);
  });

  it("detects German phone formats and avoids short ticket-like values", () => {
    expect(looksLikeEuDePii("+49 30 1234567")).toBe(true);
    expect(looksLikeEuDePii("0049-89-12345678")).toBe(true);
    expect(looksLikeEuDePii("030-1234567")).toBe(true);
    expect(looksLikeEuDePii("Ticket 030-123")).toBe(false);
  });

  it("does not make PII shapes a credential hard rejection", () => {
    expect(scanForSecrets("Meine IBAN ist DE89 3704 0044 0532 0130 00")).toBeNull();
  });
});
