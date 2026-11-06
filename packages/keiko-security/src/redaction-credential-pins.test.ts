import { describe, expect, it } from "vitest";

import { redactContent } from "./content-redaction.js";
import { redact } from "./redaction.js";
import { isTypeScriptSource } from "./redaction-typescript.js";

// Regression pins for the counterexamples of the seeded property tests (#4271). Every value is
// synthetic.
const VALUE = "R6QPOEwTQZ_Yswfem";

describe("strict redaction is a superset of the credential floor", () => {
  it.each([
    `authorization:KuBREU=${VALUE}`,
    `Authorization: ${VALUE}`,
    `Authorization: Token ${VALUE}`,
    `Proxy-Authorization = ${VALUE}`,
    `"authorization": "${VALUE}"`,
  ])("redacts an Authorization header value without a Bearer or Basic scheme: %s", (text) => {
    expect(redactContent(text, "preserve")).not.toContain(VALUE);
    expect(redact(text)).not.toContain(VALUE);
  });
});

describe("structured keys use the same secret-label grammar as flat text", () => {
  it.each([
    `y: 1\nopenai_api_key: ${VALUE}`,
    `y: 1\nmy_password: ${VALUE}`,
    `y: 1\nGITHUB_TOKEN: ${VALUE}`,
    `y:\n=apiKey: ${VALUE}`,
    `y:\n-apiKey: ${VALUE}`,
    `{"my_password": "${VALUE}", "a": 1}`,
    `{"openai_api_key": "${VALUE}", "a": 1}`,
  ])("redacts the value of a compound secret key: %s", (text) => {
    expect(redact(text)).not.toContain(VALUE);
  });

  it.each([`y: 1\nmax_tokens: ${VALUE}`, `y: 1\nmypassword: ${VALUE}`, `{"tokens": "${VALUE}"}`])(
    "keeps a key that only contains a secret word: %s",
    (text) => {
      expect(redact(text)).toContain(VALUE);
    },
  );
});

describe("an Authorization key inside source keeps the source's syntax", () => {
  // #4271 audit: masking header values over preserved source regions cut a template literal and a
  // call open; the value is masked as a data literal of a sensitive key instead.
  it.each([
    `const headers = { Authorization: \`Bearer \${token}\` };\nconst after = "${VALUE}-public";`,
    `const headers = { authorization: "${VALUE}" };\nexport const ready = true;`,
    `const authorization = build(bar, baz);\nexport const ready = true;`,
  ])("keeps valid TypeScript: %s", (source) => {
    const output = redact(source);
    expect(isTypeScriptSource(output)).toBe(true);
    expect(output).not.toContain(`"${VALUE}"`);
  });

  it.each([`authorization: ${VALUE}\ny: 1`, `{"Proxy-Authorization": "${VALUE}", "a": 1}`])(
    "masks the value of a structured authorization key: %s",
    (text) => {
      expect(redact(text)).not.toContain(VALUE);
    },
  );

  it.each([`y: 1\nsessionToken: ${VALUE}`, `{"openaiApiKey": "${VALUE}", "a": 1}`])(
    "masks a camelCase compound secret key: %s",
    (text) => {
      expect(redact(text)).not.toContain(VALUE);
    },
  );

  it.each([`y: 1\ntokenizer: ${VALUE}`, `{"passwordHash": "${VALUE}", "a": 1}`])(
    "keeps a camelCase key that does not end in a secret label: %s",
    (text) => {
      expect(redact(text)).toContain(VALUE);
    },
  );
});

describe("an Authorization value holding a source-structural character (#4271 audit)", () => {
  // The floor masks the whole value; strict redaction once left the part after `$`, `(`, `[` or `{`
  // readable because the line is a YAML mapping and only the token-safe header pass saw it.
  const STRUCTURED = ["Rsx$yubaZhrl1", "Rsx(yuba)Zhrl1", "Rsx[yuba]Zhrl1", "Rsx{yuba}Zhrl1"];
  const tail = (value: string): string => value.slice(4);

  it.each(STRUCTURED)("masks it whole in a header line and keeps the scheme: %s", (value) => {
    for (const text of [`Authorization: ${value}`, `Authorization: Bearer ${value}`]) {
      expect(redactContent(text, "preserve")).not.toContain(tail(value));
      expect(redact(text)).not.toContain(tail(value));
    }
    expect(redact(`Authorization: Bearer ${value}`)).toBe("Authorization: Bearer [REDACTED]");
  });

  it.each(STRUCTURED)("masks it whole as a structured value: %s", (value) => {
    for (const text of [
      `{"Authorization": "Bearer ${value}", "a": 1}`,
      `y: 1\nproxy-authorization: Token ${value}`,
      `curl -H 'Authorization: ${value}' https://example.test`,
    ]) {
      expect(redact(text)).not.toContain(tail(value));
    }
  });

  it.each(STRUCTURED)("keeps valid TypeScript around it: %s", (value) => {
    const output = redact(`const headers = { Authorization: "Bearer ${value}" };\nexport {};`);
    expect(isTypeScriptSource(output)).toBe(true);
    expect(output).not.toContain(tail(value));
  });
});
