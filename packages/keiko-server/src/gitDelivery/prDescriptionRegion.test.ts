import { describe, expect, it } from "vitest";
import {
  framePrDescriptionRegion,
  PR_DESCRIPTION_REGION_START as START,
  PR_DESCRIPTION_REGION_END as END,
} from "@oscharko-dev/keiko-contracts/runtime/pr-description-region";
import { reconcilePrDescriptionRegion } from "./prDescriptionRegion.js";

describe("managed PR region byte preservation", () => {
  it("replaces only one region without normalizing template, footer or sole issue directive", () => {
    const before = "\ufeff# Human template\r\n\r\nCloses #42\r\n";
    const after = "\r\n\r\nCopyright human\r\n";
    const old = before + framePrDescriptionRegion("old") + after;
    const region = framePrDescriptionRegion("new\n\nby Keiko");
    const result = reconcilePrDescriptionRegion(old, region);
    expect(result.finalBody).toBe(before + region + after);
    expect(result.prefix).toBe(before);
    expect(result.suffix).toBe(after);
  });
  it("inserts after every existing byte and repeats without duplicating the frame", () => {
    const region = framePrDescriptionRegion("new");
    const result = reconcilePrDescriptionRegion("Closes #42\r\n", region);
    expect(result.finalBody).toBe("Closes #42\r\n\n\n" + region);
    expect(reconcilePrDescriptionRegion(result.finalBody, region).finalBody).toBe(result.finalBody);
  });
  it.each([
    START,
    END,
    END + START,
    START + START + END,
    START + END + END,
    START + END + START + END,
    "<!-- keiko:pr-description:v2:start -->",
    "<!-- keiko : pr-description:v1:start -->",
    START + "Closes #55" + END,
  ])("refuses malformed/nested/duplicate markers or closing directives inside region", (body) => {
    expect(() => reconcilePrDescriptionRegion(body, framePrDescriptionRegion("new"))).toThrow();
  });
  it("refuses replacement bodies with outside content or nested markers", () => {
    expect(() =>
      reconcilePrDescriptionRegion("", "outside" + framePrDescriptionRegion("new")),
    ).toThrow();
    expect(() => reconcilePrDescriptionRegion("", START + START + END)).toThrow();
  });
});
