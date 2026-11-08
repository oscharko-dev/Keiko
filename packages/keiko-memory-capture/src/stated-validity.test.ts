import { describe, expect, it } from "vitest";

import { statedReason, statedValidUntil } from "./stated-validity.js";

const NOW = Date.UTC(2026, 10, 5);
const endOfMonth = (year: number, month: number): number =>
  Date.UTC(year, month + 1, 0, 23, 59, 59, 999);

describe("statedValidUntil", () => {
  it.each([
    ["Ich nutze Slack bis März.", endOfMonth(2027, 2)],
    ["Ich nutze Slack bis Dezember.", endOfMonth(2026, 11)],
    ["Ich nutze Slack bis Ende März 2028.", endOfMonth(2028, 2)],
    ["I use Slack until March.", endOfMonth(2027, 2)],
    ["I use Slack until the end of June 2027.", endOfMonth(2027, 5)],
    ["Ich nutze Slack bis zum 31.03.2027.", Date.UTC(2027, 2, 31, 23, 59, 59, 999)],
    ["Ich nutze Slack bis 15.2.", Date.UTC(2027, 1, 15, 23, 59, 59, 999)],
    ["I use Slack until 2027-03-31.", Date.UTC(2027, 2, 31, 23, 59, 59, 999)],
  ])("reads %s", (sentence, expected) => {
    expect(statedValidUntil(sentence, NOW)).toBe(expected);
  });

  it.each([
    "Ich nutze Slack.",
    "Ich warte bis morgen.",
    "Ich nutze Slack bis 31.02.2027.",
    "Ich nutze Slack bis März 2020.",
    "I use Slack until 2020-01-01.",
    "I may use Slack.",
  ])("reads no end in %s", (sentence) => {
    expect(statedValidUntil(sentence, NOW)).toBeNull();
  });
});

describe("statedReason", () => {
  it.each([
    ["Ich nehme X, weil es offline läuft.", "es offline läuft"],
    ["I chose X because it runs offline.", "it runs offline"],
  ])("reads %s", (sentence, reason) => {
    expect(statedReason(sentence)).toBe(reason);
  });

  it("reads no reason where none is stated", () => {
    expect(statedReason("Ich nehme X.")).toBeNull();
  });
});
