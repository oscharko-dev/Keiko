import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("feedback intake migration 001", () => {
  it("persists an immutable bounded review projection at initial admission", async () => {
    const source = await readFile(
      new URL("../migrations/001_feedback_intake.sql", import.meta.url),
      "utf8",
    );
    expect(source).toContain("report_category text");
    expect(source).toContain("report_feature_area text");
    expect(source).toContain("populate_feedback_payload_report_projection");
    expect(source).toContain("BEFORE INSERT ON feedback_payloads");
    expect(source).toContain("prevent_feedback_payload_content_update");
    expect(source).not.toMatch(/report_(?:body|description|title|attachment)/u);
  });
});
