import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("feedback review projection migration 006", () => {
  it("persists immutable bounded queue metadata without retaining another report body", async () => {
    const source = await readFile(
      new URL("../migrations/006_feedback_review_projection.sql", import.meta.url),
      "utf8",
    );
    expect(source).toContain("report_category text");
    expect(source).toContain("report_feature_area text");
    expect(source).toContain("feedback_payload_report_projection_complete");
    expect(source).toContain("populate_feedback_payload_report_projection");
    expect(source).toContain("prevent_feedback_payload_content_update");
    expect(source).not.toMatch(/report_(?:body|description|title|attachment)/u);
    expect(source).toContain(
      "INSERT INTO feedback_schema_migrations (version, applied_at) VALUES (6, now())",
    );
  });
});
