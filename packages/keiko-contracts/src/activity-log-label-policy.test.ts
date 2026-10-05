import { describe, expect, it } from "vitest";
import {
  looksLikePersonalIdentifier,
  looksLikeSecret,
  OPAQUE_TOKEN_RUN_LENGTH,
} from "./activity-log-label-policy.js";

// Assemble credential-shaped fixtures so the source itself is not a stored credential.
const CREDENTIALS = [
  ["sk", "proj", "examplefixture012345"].join("-"),
  ["ghp", "examplefixture012345"].join("_"),
  ["xoxb", "examplefixture012345"].join("-"),
  ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "fixture"].join("."),
  ["AKIA", "IOSFODNN7EXAMPLE"].join(""),
  ["-----BEGIN ", "PRIVATE KEY-----"].join(""),
  ["Bearer", "fixture"].join(" "),
  ["https://user", "password@example.test"].join(":"),
  ["https://example.test/?api_key", "fixture"].join("="),
  ["password", "fixture"].join(":"),
];

describe("shared body-free label privacy policy", () => {
  it.each(CREDENTIALS)("recognizes a credential-shaped label %#", (value) => {
    expect(looksLikeSecret(value)).toBe(true);
  });

  it.each([
    "operator@example.test",
    "mailto:operator@example.test",
    "tel:+14155550142",
    "123-45-6789",
  ])("recognizes personal-identifier shape %#", (value) => {
    expect(looksLikePersonalIdentifier(value)).toBe(true);
  });

  it.each([
    "gateway.chat.started",
    "bff",
    "abc123",
    "a".repeat(64),
    "/api/local-knowledge/capsules/cap-2f9c/sources/src-7c1a/root",
  ])("preserves body-free machine metadata %#", (value) => {
    expect(looksLikeSecret(value)).toBe(false);
    expect(looksLikePersonalIdentifier(value)).toBe(false);
  });

  it("applies the opaque threshold to one mixed-alphabet run, including embedded runs", () => {
    const boundary = `aA0${"b".repeat(OPAQUE_TOKEN_RUN_LENGTH - 3)}`;
    expect(looksLikeSecret(boundary.slice(0, -1))).toBe(false);
    expect(looksLikeSecret(boundary)).toBe(true);
    expect(looksLikeSecret(`prefix.${boundary}.suffix`)).toBe(true);
    expect(looksLikeSecret(`${boundary.slice(0, 20)}/${boundary.slice(20)}`)).toBe(false);
    expect(looksLikeSecret(`${boundary.slice(0, 20)}.${boundary.slice(20)}`)).toBe(false);
    expect(looksLikeSecret("a".repeat(OPAQUE_TOKEN_RUN_LENGTH * 2))).toBe(false);
  });

  it("continues past malformed email candidates across large adversarial labels", () => {
    const prefix = "x@ ".repeat(262_144);
    expect(looksLikePersonalIdentifier(`${prefix}operator@example.test`)).toBe(true);
    expect(looksLikePersonalIdentifier(`${prefix}operator@localhost`)).toBe(false);
    expect(looksLikePersonalIdentifier(`${"a".repeat(1_048_576)}@localhost`)).toBe(false);
  });
});
