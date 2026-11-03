// Tests of the conservative redaction pass over real conversation text (#4208). Every credential-shaped
// value is a made-up placeholder with no relation to any real account or key, and each is assembled
// from fragments at run time, so no literal in this file has the shape of a credential (the secret
// scan of the repository runs the default rule set over it).
import { describe, expect, it } from "vitest";
import {
  addRedactionCounts,
  emptyRedactionCounts,
  redactText,
  totalRedactions,
} from "../testing/memory-lab/anchor/redact.mjs";

function assemble(...fragments) {
  return fragments.join("");
}

const SHAPES = Object.freeze({
  md5: "0123456789abcdef".repeat(2),
  sha256: "ab12".repeat(16),
  openAiKey: assemble("sk", "-proj-", "AbCdEfGhIjKlMnOpQrStUvWx", "_1234"),
  gitHubToken: assemble("gh", "p_", "AbCdEfGhIjKlMnOpQrStUvWxYz", "0123456789"),
  gitHubFineGrained: assemble("github", "_pat_", "11ABCDEFG0AbCdEfGhIjKlMnOp"),
  slackToken: assemble("xo", "xb-", "123456789012", "-AbCdEfGhIjKl"),
  awsKeyId: assemble("AK", "IA", "ABCDEFGHIJKLMNOP"),
  bearer: assemble("Bearer", " ", "abc.DEF-123_456~xyz+uvw/789="),
  basic: assemble("Basic", " ", "dXNlcjpwYXNzd29yZDEyMzQ1Ng=="),
  jwt: assemble(
    "ey",
    "JhbGciOiJIUzI1",
    ".",
    "ey",
    "JzdWIiOiIxMjM0NTY3",
    ".",
    "SflKxwRJSMeKKF2QT4fw",
  ),
});

describe("memory lab anchor redaction", () => {
  it.each([
    ["an email address", "Schreib mir an erika.mustermann+test@example.co.uk bitte", "email"],
    ["a grouped IBAN", "Meine IBAN ist DE89 3704 0044 0532 0130 00 ok", "iban"],
    ["an ungrouped IBAN", "iban: DE89370400440532013000.", "iban"],
    ["a lowercase IBAN", "iban de89370400440532013000 danke", "iban"],
    ["an md5-length hex run", `hash ${SHAPES.md5} fertig`, "hex"],
    ["a sha256-length hex run", `digest ${SHAPES.sha256} done`, "hex"],
    ["an sk- token", `key ${SHAPES.openAiKey} fertig`, "token"],
    ["a ghp_ token", `token ${SHAPES.gitHubToken}`, "token"],
    ["a github_pat_ token", `pat ${SHAPES.gitHubFineGrained}`, "token"],
    ["an xox token", `slack ${SHAPES.slackToken}`, "token"],
    ["an AWS access key id", `aws ${SHAPES.awsKeyId} end`, "token"],
    ["a bearer token", `Authorization: ${SHAPES.bearer}`, "bearer"],
    ["a lowercase bearer token", `authorization: ${SHAPES.bearer.toLowerCase()}`, "bearer"],
    ["a basic credential", `Authorization: ${SHAPES.basic}`, "bearer"],
    ["a JWT-shaped value", `jwt ${SHAPES.jwt}`, "bearer"],
    ["an international phone number", "Ruf mich an: +49 170 1234567 danach", "phone"],
    ["a national phone number", "Tel. 0170/1234567.", "phone"],
    ["a phone number with brackets", "Telefon (030) 123 456 78 gerne", "phone"],
    ["a long numeric identifier", "Kundennummer 1234567890", "phone"],
  ])("redacts %s", (_name, text, kind) => {
    const { text: redacted, counts } = redactText(text);
    expect(redacted).toContain("[redacted]");
    expect(counts[kind]).toBeGreaterThanOrEqual(1);
    expect(totalRedactions(counts)).toBe(counts[kind]);
  });

  it("removes the sensitive value and keeps the surrounding sentence", () => {
    const { text } = redactText("Mail an erika@example.com und fertig.");
    expect(text).toBe("Mail an [redacted] und fertig.");
  });

  it.each([
    "Ich bevorzuge Tabellen statt Listen und arbeite gern mit TypeScript.",
    "Basic information about the basic setup, a bearer of bad news.",
    "Am 12.05.2024 um 14:30 Uhr, Version 3.4.12, Preis 1.234,56 EUR.",
    "Eine Nummer mit acht Ziffern: 12345678 bleibt stehen.",
    `Ein 31-stelliger Hex-Wert ${SHAPES.md5.slice(0, 31)} bleibt stehen.`,
    "Der Schlüssel sk- allein oder sk-kurz bleibt stehen.",
    "ID42 und ab12 cdef sind keine IBAN.",
    "Schreib an @team oder an erika@ ohne Domain.",
    "ghp_ kurz und AKIA zu kurz",
  ])("leaves ordinary text alone: %s", (text) => {
    const { text: redacted, counts } = redactText(text);
    expect(redacted).toBe(text);
    expect(totalRedactions(counts)).toBe(0);
  });

  it("counts every match per kind", () => {
    const text = "a@b.de, c@d.de, DE89 3704 0044 0532 0130 00 und +49 170 1234567";
    const { counts } = redactText(text);
    expect(counts).toMatchObject({ email: 2, iban: 1, phone: 1, token: 0, bearer: 0, hex: 0 });
  });

  it("is idempotent", () => {
    const text = `${SHAPES.openAiKey}, erika@example.com, +49 170 1234567, DE89370400440532013000`;
    const once = redactText(text).text;
    const twice = redactText(once);
    expect(twice.text).toBe(once);
    expect(totalRedactions(twice.counts)).toBe(0);
  });

  it("redacts a token before the generic hex and digit rules could split it", () => {
    const { text, counts } = redactText(`key ${assemble("sk", "-", SHAPES.md5.repeat(2))} end`);
    expect(text).toBe("key [redacted] end");
    expect(counts.token).toBe(1);
    expect(counts.hex).toBe(0);
  });

  it("adds counts in place and sums them", () => {
    const target = emptyRedactionCounts();
    addRedactionCounts(target, redactText("a@b.de").counts);
    addRedactionCounts(target, redactText("c@d.de +49 170 1234567").counts);
    expect(target).toMatchObject({ email: 2, phone: 1 });
    expect(totalRedactions(target)).toBe(3);
    expect(Object.keys(emptyRedactionCounts()).toSorted()).toEqual([
      "bearer",
      "email",
      "hex",
      "iban",
      "phone",
      "token",
    ]);
  });

  it("stays linear on adversarial input", () => {
    const hostile = [
      "a".repeat(200_000),
      `${"a".repeat(100_000)}@`,
      "1 ".repeat(100_000),
      `${"-".repeat(100_000)}x`,
      `Bearer ${"a".repeat(100_000)}`,
      `DE12${" 1234".repeat(40_000)}`,
    ];
    const startedAt = Date.now();
    for (const text of hostile) redactText(text);
    // A catastrophic pattern needs minutes here; the bound only guards against that.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });
});
