import { afterEach, describe, expect, it } from "vitest";

import { statedReason, statedValidUntil } from "./stated-validity.js";

const NOW = Date.UTC(2026, 10, 5);
// A stated day ends where the person lives: Keiko runs on their own machine.
const endOfMonth = (year: number, month: number): number =>
  new Date(year, month + 1, 0, 23, 59, 59, 999).getTime();
const endOfDay = (year: number, month: number, day: number): number =>
  new Date(year, month, day, 23, 59, 59, 999).getTime();

describe("statedValidUntil", () => {
  it.each([
    ["Ich nutze Slack bis März.", endOfMonth(2027, 2)],
    ["Ich nutze Slack bis Dezember.", endOfMonth(2026, 11)],
    ["Ich nutze Slack bis Ende März 2028.", endOfMonth(2028, 2)],
    ["I use Slack until March.", endOfMonth(2027, 2)],
    ["I use Slack until the end of June 2027.", endOfMonth(2027, 5)],
    ["Ich nutze Slack bis zum 31.03.2027.", endOfDay(2027, 2, 31)],
    ["Ich nutze Slack bis 15.2.", endOfDay(2027, 1, 15)],
    ["I use Slack until 2027-03-31.", endOfDay(2027, 2, 31)],
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

describe("statedValidUntil in the person's time zone (#4206)", () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  // UI walk: "bis zum 31.03.2027" showed "Valid until 4/1/2027, 1:59:59 AM" in Berlin, and west of
  // UTC the fact would end on the afternoon of the 31st.
  it.each(["Europe/Berlin", "America/New_York", "Asia/Tokyo"])(
    "ends a stated day and month at local midnight in %s",
    (zone) => {
      process.env.TZ = zone;
      const day = new Date(statedValidUntil("Ich bin bis zum 31.03.2027 im Projekt.", NOW) ?? 0);
      expect([day.getFullYear(), day.getMonth(), day.getDate(), day.getHours()]).toEqual([
        2027, 2, 31, 23,
      ]);
      const month = new Date(statedValidUntil("Ich nutze Slack bis Ende März 2028.", NOW) ?? 0);
      expect([month.getMonth(), month.getDate(), month.getHours()]).toEqual([2, 31, 23]);
    },
  );
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
