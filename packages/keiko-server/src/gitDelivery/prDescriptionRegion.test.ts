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

  // #3384 B5-7: a maintainer's own fenced-code-block quote of the exact marker syntax (a
  // README-style example) must be treated as documentation, not the real managed region — it must
  // never be silently spliced out and replaced on the next generated-description write.
  it("treats a single START/END pair quoted inside a fenced code block as documentation, not the managed region", () => {
    const body = [
      "# Human template",
      "",
      "Example of the managed markers Keiko uses:",
      "```",
      START,
      "old content",
      END,
      "```",
      "",
      "Closes #42",
    ].join("\n");
    const region = framePrDescriptionRegion("new");
    const result = reconcilePrDescriptionRegion(body, region);
    // The fenced example is left untouched and the real region is appended after it, never spliced
    // into the fence as though it were the live managed region.
    expect(result.finalBody).toBe(body + "\n\n" + region);
    expect(result.finalBody).toContain("old content");
    expect(result.prefix).toBe(body);
    expect(result.suffix).toBe("");
  });

  // The duplicate-region guard still fires for a genuine second REAL (unfenced, own-line) region
  // pair — the fence gate only ever downgrades a fenced example to "no managed region", never a
  // real duplicate to "no managed region".
  it("still refuses a genuine duplicate managed region even when a fenced example is also present", () => {
    const body = [
      "```",
      START,
      "fenced example",
      END,
      "```",
      START,
      "real region one",
      END,
      START,
      "real region two",
      END,
    ].join("\n");
    expect(() => reconcilePrDescriptionRegion(body, framePrDescriptionRegion("new"))).toThrow();
  });

  // Reviewer 3941860530: `firstUnfencedIndex` correctly locates the real region for splitting, but
  // the duplicate-marker check must apply the same fence-aware interpretation, or a fenced example
  // that sits OUTSIDE the real managed region (in prefix or suffix) is wrongly flagged as a
  // duplicate on every subsequent reconciliation.
  it("does not flag a fenced example as a duplicate when it precedes the real managed region on a repeated reconciliation", () => {
    const example = [
      "# Human template",
      "",
      "Example of the managed markers Keiko uses:",
      "```",
      START,
      "old content",
      END,
      "```",
      "",
      "Closes #42",
    ].join("\n");
    const region = framePrDescriptionRegion("new");
    const first = reconcilePrDescriptionRegion(example, region);
    expect(first.finalBody).toBe(example + "\n\n" + region);
    // Second reconciliation against the SAME already-managed body must succeed (idempotent
    // update), not throw "Duplicate or nested PR description region" because of the fenced
    // example that now sits in the prefix.
    const updatedRegion = framePrDescriptionRegion("updated");
    const second = reconcilePrDescriptionRegion(first.finalBody, updatedRegion);
    expect(second.finalBody).toBe(example + "\n\n" + updatedRegion);
    expect(second.prefix).toBe(example + "\n\n");
    expect(second.suffix).toBe("");
  });

  it("does not flag a fenced example as a duplicate when it follows the real managed region", () => {
    const region = framePrDescriptionRegion("old");
    const example = [
      "",
      "Example of the managed markers Keiko uses:",
      "```",
      START,
      "old content",
      END,
      "```",
    ].join("\n");
    const body = region + example;
    const updatedRegion = framePrDescriptionRegion("updated");
    const result = reconcilePrDescriptionRegion(body, updatedRegion);
    expect(result.finalBody).toBe(updatedRegion + example);
    expect(result.suffix).toBe(example);
  });

  // Reviewer 3941916909: fence detection must match the OPENING delimiter's character and length,
  // not merely toggle on any backtick/tilde prefix. A four-backtick outer fence containing a
  // three-backtick inner example must stay open across that shorter inner "```" run — otherwise
  // the inner opening is mistaken for the outer's close and the marker pair inside is treated as
  // the real managed region, silently overwriting the human documentation on the first update.
  it("keeps a four-backtick fence open across a nested three-backtick example, preserving the marker pair as documentation", () => {
    const body = [
      "# Human template",
      "",
      "Example of nested fences Keiko must not misparse:",
      "````markdown",
      "some prose",
      "```html",
      START,
      "old content",
      END,
      "```",
      "more prose",
      "````",
      "",
      "Closes #42",
    ].join("\n");
    const region = framePrDescriptionRegion("new");
    const result = reconcilePrDescriptionRegion(body, region);
    expect(result.finalBody).toBe(body + "\n\n" + region);
    expect(result.finalBody).toContain("old content");
    expect(result.prefix).toBe(body);
    expect(result.suffix).toBe("");
  });

  // Same defect, tilde fence variant: an outer ~~~ fence containing inner backticks must not close
  // early on the inner run either.
  it("keeps a tilde fence open across a nested backtick example, preserving the marker pair as documentation", () => {
    const body = [
      "# Human template",
      "",
      "~~~markdown",
      "prose",
      "```html",
      START,
      "old content",
      END,
      "```",
      "~~~",
      "",
      "Closes #1",
    ].join("\n");
    const region = framePrDescriptionRegion("new");
    const result = reconcilePrDescriptionRegion(body, region);
    expect(result.finalBody).toBe(body + "\n\n" + region);
    expect(result.finalBody).toContain("old content");
    expect(result.prefix).toBe(body);
    expect(result.suffix).toBe("");
  });

  // An unterminated fence has no safe append position: appending a region would place it inside
  // the human fence, so the next reconciliation would ignore it and append another copy.
  it("refuses to append a managed region inside an unterminated human fence", () => {
    const body = ["# Human template", "", "```markdown", START, "content", END].join("\n");
    const region = framePrDescriptionRegion("new");
    expect(() => reconcilePrDescriptionRegion(body, region)).toThrow(
      "Unterminated fenced code block prevents safe PR description insertion",
    );
    expect(body).toBe(["# Human template", "", "```markdown", START, "content", END].join("\n"));
  });
});
