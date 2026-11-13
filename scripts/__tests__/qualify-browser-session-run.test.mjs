import { describe, expect, it } from "vitest";
import { judge, validateSchedule } from "../qualify-browser-session-run.mjs";

describe("the two-hour browser session run (#4370 AC2)", () => {
  const good = [4, 11, 19, 26, 31, 38, 47, 55, 63, 70, 78, 86, 93, 101, 109, 117, 124];

  it("requires the incident's 26 and 31 minute reloads and refuses a gap at the idle lifetime", () => {
    expect(validateSchedule(good, 124)).toBeUndefined();
    expect(
      validateSchedule(
        good.filter((point) => point !== 26),
        124,
      ),
    ).toMatch(/26-minute/u);
    expect(
      validateSchedule(
        good.filter((point) => point !== 31),
        124,
      ),
    ).toMatch(/31-minute/u);
    expect(validateSchedule([26, 31, 62], 62)).toMatch(/idle lifetime/u);
    expect(validateSchedule([4, 26, 31, 40], 125)).toMatch(/ends before/u);
    expect(validateSchedule([26, 26, 31], 31)).toMatch(/duplicate/u);
    expect(validateSchedule([0, 26, 31], 31)).toMatch(/invalid/u);
  });

  it("lets a smoke run skip the incident reloads and nothing else", () => {
    expect(validateSchedule([1, 2], 2, true)).toBeUndefined();
    expect(validateSchedule([1, 40], 40, true)).toMatch(/idle lifetime/u);
  });

  const reloads = [{ minute: 26, session: "active", connectControlVisible: false }];
  const op = (name, extra = {}) => ({ op: name, ts: "2026-11-13T12:00:00.000Z", extra });

  it("passes one pairing with no refusal, expiry, denial or failed repair", () => {
    const verdict = judge([op("coding-app-session.paired")], reloads);
    expect(verdict.failures).toEqual([]);
    expect(verdict.pairings).toBe(1);
  });

  it.each([
    [
      "a second pairing",
      [op("coding-app-session.paired"), op("coding-app-session.paired")],
      /exactly one pairing/u,
    ],
    ["no pairing", [], /exactly one pairing/u],
    [
      "a refused proof",
      [op("coding-app-session.paired"), op("coding-app-session.proof.refused")],
      /refused session proof/u,
    ],
    ["an expiry", [op("coding-app-session.paired"), op("coding-app-session.expired")], /expiry/u],
    [
      "a refused repair counted in a closed window",
      [
        op("coding-app-session.paired"),
        op("coding-app-session.local-session.denied", { count: 2, windowClosed: true }),
      ],
      /refused local-session repair/u,
    ],
    [
      "a failed client repair",
      [op("coding-app-session.paired"), op("client.session-repair.failed")],
      /failed client session repair/u,
    ],
  ])("fails %s", (_name, events, pattern) => {
    expect(judge(events, reloads).failures.join(" ")).toMatch(pattern);
  });

  it("counts a refused repair once: the mid-window alert is not added to its closing summary", () => {
    const events = [
      op("coding-app-session.paired"),
      op("coding-app-session.local-session.denied", { count: 10, windowClosed: false }),
      op("coding-app-session.local-session.denied", { count: 12, windowClosed: true }),
    ];
    expect(judge(events, reloads).denials).toBe(12);
  });

  it("fails a reload that found the session lost or the Connect control shown", () => {
    const lost = [{ minute: 31, session: "unavailable", connectControlVisible: false }];
    const shown = [{ minute: 31, session: "active", connectControlVisible: true }];
    for (const bad of [lost, shown])
      expect(judge([op("coding-app-session.paired")], bad).failures.join(" ")).toMatch(
        /minute 31/u,
      );
  });
});
