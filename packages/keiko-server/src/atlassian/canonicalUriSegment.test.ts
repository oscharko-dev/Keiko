import { describe, expect, it } from "vitest";
import { decodeCanonicalUriSegment } from "./canonicalUriSegment.js";

describe("canonical UTF-8 URI segment decoding", () => {
  it.each([
    ["", ""],
    ["node-1_~.!*'()", "node-1_~.!*'()"],
    ["two%20words", "two words"],
    ["caf%C3%A9", "café"],
    ["%E2%82%AC", "€"],
    ["%F0%9F%98%80", "😀"],
    ["%EF%BF%BD", "�"],
    ["%2F", "/"],
    ["%25", "%"],
    ["%00", "\u0000"],
  ])("decodes %s without adding entity admission rules", (encoded, decoded) => {
    expect(decodeCanonicalUriSegment(encoded)).toBe(decoded);
  });
  it.each([
    undefined,
    "%",
    "%0",
    "%GG",
    "%2f",
    "%c3%A9",
    "%41",
    "%7E",
    "%20 ",
    "two words",
    "é",
    "😀",
    "\ud800",
    "\udfff",
    "/",
    "?",
    "#",
    "\\",
    "\n",
    "%80",
    "%BF",
    "%C0%AF",
    "%C1%BF",
    "%C2",
    "%C2%41",
    "%E0%80%AF",
    "%ED%A0%80",
    "%ED%BF%BF",
    "%E2%82",
    "%F0%80%80%AF",
    "%F4%90%80%80",
    "%F5%80%80%80",
    "%FF",
    "%F0%9F%98",
    "%E2x%82%AC",
    "%EF%BF%BD%80",
  ])("refuses malformed, noncanonical or invalid UTF-8 %s without throwing", (encoded) => {
    expect(() => decodeCanonicalUriSegment(encoded)).not.toThrow();
    expect(decodeCanonicalUriSegment(encoded)).toBeUndefined();
  });
});
