import { describe, expect, it } from "vitest";

import { redactContent } from "./content-redaction.js";
import { redact } from "./redaction.js";

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
