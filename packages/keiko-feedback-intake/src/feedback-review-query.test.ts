import { describe, expect, it, vi } from "vitest";
import { PostgresFeedbackReviewQuery } from "./feedback-review-query.js";

describe("feedback review query validation", () => {
  it("rejects a non-canonical cursor UUID before acquiring PostgreSQL", async () => {
    const connect = vi.fn();
    const query = new PostgresFeedbackReviewQuery({ connect });
    const cursor = Buffer.from(
      JSON.stringify(["2026-07-11T12:00:00.000Z", "NOT-A-CANONICAL-UUID"]),
    ).toString("base64url");
    await expect(query.list({ limit: 10, includePrivate: false, cursor })).rejects.toMatchObject({
      code: "invalid-request",
    });
    expect(connect).not.toHaveBeenCalled();
  });
});
