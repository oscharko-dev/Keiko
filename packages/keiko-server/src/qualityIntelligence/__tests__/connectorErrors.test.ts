import { describe, expect, it } from "vitest";
import {
  containsForbiddenSecretShape,
  payloadContainsForbiddenSecretShape,
  qiConnectorErrorBody,
  type QiConnectorErrorCode,
} from "../connectorErrors.js";

const ALL_CODES: readonly QiConnectorErrorCode[] = [
  "QI_BAD_REQUEST",
  "QI_CONNECTOR_DISABLED",
  "QI_FORBIDDEN_PAYLOAD",
  "QI_INVALID_ENVELOPE_SELECTION",
  "QI_INTERNAL",
];

const FORBIDDEN_SUBSTRINGS_IN_OUTPUT = [
  "Bearer ",
  "Authorization:",
  "apikey",
  "api_key",
  "X-Api-Key",
  "Cookie:",
  "Set-Cookie",
];

describe("qiConnectorErrorBody — no secret shapes in output", () => {
  it.each(ALL_CODES)("body for %s carries no credential-like substrings", (code) => {
    const body = qiConnectorErrorBody(code);
    const serialised = JSON.stringify(body);
    for (const forbidden of FORBIDDEN_SUBSTRINGS_IN_OUTPUT) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it.each(ALL_CODES)("body for %s matches the ApiError envelope shape", (code) => {
    const body = qiConnectorErrorBody(code);
    expect(body.error.code).toBe(code);
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it("error message never echoes caller-supplied content", () => {
    const sampleSecret = ["Bearer", " ", "abc123-totally-secret"].join("");
    const body = qiConnectorErrorBody("QI_FORBIDDEN_PAYLOAD");
    expect(body.error.message).not.toContain(sampleSecret);
    expect(body.error.message).not.toContain("abc123");
  });
});

describe("containsForbiddenSecretShape", () => {
  it.each([
    ["Bearer", " ", "abcdef"].join(""),
    "Authorization: token=xyz",
    "Basic dXNlcjpwYXNz",
    "Cookie: session=foo",
    "Set-Cookie: id=bar",
    "X-Api-Key: secret",
    "my apikey value",
    "the api_key here",
  ])("detects %s", (value) => {
    expect(containsForbiddenSecretShape(value)).toBe(true);
  });

  it.each(["plain text", "some envelope id", "abc-123"])("passes clean strings: %s", (value) => {
    expect(containsForbiddenSecretShape(value)).toBe(false);
  });
});

describe("payloadContainsForbiddenSecretShape", () => {
  it("detects forbidden substrings in payload string values", () => {
    expect(payloadContainsForbiddenSecretShape({ foo: ["Bearer", " ", "abc"].join("") })).toBe(
      true,
    );
    expect(payloadContainsForbiddenSecretShape({ x: 1, y: "Authorization: x" })).toBe(true);
  });

  it("ignores non-string values", () => {
    expect(payloadContainsForbiddenSecretShape({ a: 1, b: true, c: null })).toBe(false);
    expect(payloadContainsForbiddenSecretShape({ nested: { secret: "Bearer x" } })).toBe(false);
  });

  it("returns false for empty payload", () => {
    expect(payloadContainsForbiddenSecretShape({})).toBe(false);
  });
});
