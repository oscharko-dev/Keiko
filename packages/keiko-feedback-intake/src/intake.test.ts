import { createHash } from "node:crypto";
import { prepareFeedbackReportV1 } from "@oscharko-dev/keiko-security/feedback-report";
import type { PreparedFeedbackReportV1 } from "@oscharko-dev/keiko-security/feedback-report";
import { describe, expect, it } from "vitest";
import { createInMemoryFeedbackIntake } from "./intake.js";
import { DEFAULT_TEST_LIMITS } from "./config.js";

function prepared(
  title = "Safe feedback",
  description = "A governed submission.",
): PreparedFeedbackReportV1 {
  const value = prepareFeedbackReportV1({
    schemaVersion: "1",
    category: "defect",
    title,
    description,
    reproductionSteps: "Open Settings.",
    expectedBehavior: "Submission succeeds.",
    actualBehavior: "The report is ready.",
    productVersion: "0.2.14",
    platform: "Linux",
    featureArea: "model-configuration",
    impact: "Degrades core workflow",
  });
  if (!value.ok) throw new Error("fixture failed");
  return value.value;
}

describe("hosted feedback intake", () => {
  it("accepts exact canonical bytes and gives every duplicate a fresh capability", async () => {
    const intake = createInMemoryFeedbackIntake({ now: () => new Date("2026-07-11T12:00:00Z") });
    const body = prepared();
    const first = await intake.submit(
      body.canonicalBody.copyBytes(),
      body.exactBodySha256,
      new Uint8Array([1, 2, 3, 4]),
    );
    const second = await intake.submit(
      body.canonicalBody.copyBytes(),
      body.exactBodySha256,
      new Uint8Array([1, 2, 3, 4]),
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    if (first.status !== 202 || second.status !== 202) return;
    expect(second.body.receiptId).not.toBe(first.body.receiptId);
    expect(intake.inspect()).toMatchObject({ payloadCount: 1, receiptCount: 2 });
    await expect(intake.receipt(first.body.receiptId, first.body.receiptSecret)).resolves.toEqual({
      status: 200,
      body: {
        receiptId: first.body.receiptId,
        status: "received",
        expiresAt: first.body.expiresAt,
      },
    });
  });

  it("uses a fixed 30-day receipt lifetime without extending dedupe retention", async () => {
    let time = new Date("2026-01-01T00:00:00.000Z");
    const intake = createInMemoryFeedbackIntake({ now: () => time });
    const body = prepared();
    const bytes = body.canonicalBody.copyBytes();
    const first = await intake.submit(bytes, body.exactBodySha256, new Uint8Array([1]));
    if (first.status !== 202) throw new Error("submission failed");

    time = new Date("2026-01-30T00:00:00.000Z");
    await expect(
      intake.receipt(first.body.receiptId, first.body.receiptSecret),
    ).resolves.toMatchObject({ status: 200 });
    const duplicate = await intake.submit(bytes, body.exactBodySha256, new Uint8Array([2]));
    if (duplicate.status !== 202) throw new Error("duplicate submission failed");
    expect(duplicate.body.receiptId).not.toBe(first.body.receiptId);

    time = new Date("2026-02-01T00:00:00.000Z");
    await expect(intake.receipt(first.body.receiptId, first.body.receiptSecret)).resolves.toEqual({
      status: 404,
      body: { error: "invalid-request" },
    });
    await expect(
      intake.receipt(duplicate.body.receiptId, duplicate.body.receiptSecret),
    ).resolves.toMatchObject({ status: 200 });
    time = new Date("2026-03-02T00:00:00.000Z");
    await expect(
      intake.receipt(duplicate.body.receiptId, duplicate.body.receiptSecret),
    ).resolves.toMatchObject({ status: 404 });
    expect(intake.purge()).toMatchObject({ receipts: 2, payloads: 0, dedupe: 0 });
    time = new Date("2026-06-30T00:00:00.000Z");
    expect(intake.purge().dedupe).toBe(1);
  });

  it("makes a late duplicate indistinguishable from a unique receipt while retaining its semantic group", async () => {
    let time = new Date("2026-01-01T00:00:00.000Z");
    const intake = createInMemoryFeedbackIntake({ now: () => time });
    const first = prepared();
    const unique = prepareFeedbackReportV1({
      schemaVersion: "1",
      category: "defect",
      title: "Other safe feedback",
      description: "Other report.",
      reproductionSteps: "Open Settings.",
      expectedBehavior: "Submission succeeds.",
      actualBehavior: "The report is ready.",
      productVersion: "0.2.14",
      platform: "Linux",
      featureArea: "model-configuration",
      impact: "Degrades core workflow",
    });
    if (!unique.ok) throw new Error("fixture failed");
    await intake.submit(
      first.canonicalBody.copyBytes(),
      first.exactBodySha256,
      new Uint8Array([1]),
    );
    time = new Date("2026-03-05T00:00:00.000Z");
    const late = await intake.submit(
      first.canonicalBody.copyBytes(),
      first.exactBodySha256,
      new Uint8Array([2]),
    );
    const other = await intake.submit(
      unique.value.canonicalBody.copyBytes(),
      unique.value.exactBodySha256,
      new Uint8Array([3]),
    );
    if (late.status !== 202 || other.status !== 202) throw new Error("submission failed");
    expect(late.body.expiresAt).toBe(other.body.expiresAt);
    expect(intake.inspect()).toMatchObject({ payloadCount: 3, dedupeCount: 2 });
  });

  it.each(["count", "bytes"] as const)(
    "rejects duplicate and unique submissions uniformly at %s capacity",
    async (capacity) => {
      const description = capacity === "bytes" ? "A".repeat(400) : "A governed submission.";
      const first = prepared("Safe feedback", description);
      const unique = prepared("Different safe feedback", description);
      const firstBytes = first.canonicalBody.copyBytes();
      const limits = {
        ...DEFAULT_TEST_LIMITS,
        openPayloadCount: capacity === "count" ? 1 : DEFAULT_TEST_LIMITS.openPayloadCount,
        openPayloadBytes: capacity === "bytes" ? 1_024 : 256_000_000,
      };
      const intake = createInMemoryFeedbackIntake({
        now: () => new Date("2026-07-11T12:00:00Z"),
        limits,
      });
      expect(
        (await intake.submit(firstBytes, first.exactBodySha256, new Uint8Array([1]))).status,
      ).toBe(202);

      const duplicate = await intake.submit(firstBytes, first.exactBodySha256, new Uint8Array([2]));
      const other = await intake.submit(
        unique.canonicalBody.copyBytes(),
        unique.exactBodySha256,
        new Uint8Array([3]),
      );

      expect(duplicate).toEqual({ status: 503, body: { error: "temporarily-unavailable" } });
      expect(other).toEqual(duplicate);
    },
  );

  it("rejects digest drift, noncanonical bodies, and private security reports without storage", async () => {
    const intake = createInMemoryFeedbackIntake({ now: () => new Date("2026-07-11T12:00:00Z") });
    const body = prepared();
    const noncanonical = new TextEncoder().encode(` ${body.canonicalJson}`);
    expect(
      (await intake.submit(body.canonicalBody.copyBytes(), "0".repeat(64), new Uint8Array([1])))
        .status,
    ).toBe(422);
    expect(
      (
        await intake.submit(
          noncanonical,
          createHash("sha256").update(noncanonical).digest("hex"),
          new Uint8Array([1]),
        )
      ).status,
    ).toBe(422);
    expect(intake.inspect().payloadCount).toBe(0);
  });

  it("uses a uniform receipt 404 for unknown and mismatched capabilities", async () => {
    const intake = createInMemoryFeedbackIntake({ now: () => new Date("2026-07-11T12:00:00Z") });
    const body = prepared();
    const accepted = await intake.submit(
      body.canonicalBody.copyBytes(),
      body.exactBodySha256,
      new Uint8Array([1]),
    );
    if (accepted.status !== 202) throw new Error("submission failed");
    const unknown = await intake.receipt("0".repeat(32), "0".repeat(64));
    const mismatch = await intake.receipt(accepted.body.receiptId, "0".repeat(64));
    expect(unknown).toEqual(mismatch);
    expect(unknown).toEqual({ status: 404, body: { error: "invalid-request" } });
  });

  it("admits only the current UTC abuse bucket and expires it at exactly 48 hours", async () => {
    let time = new Date("2026-07-11T23:59:59.999Z");
    const intake = createInMemoryFeedbackIntake({
      now: () => time,
      limits: { ...DEFAULT_TEST_LIMITS, perIdentity: 1 },
    });
    const body = prepared();
    const bytes = body.canonicalBody.copyBytes();
    expect((await intake.submit(bytes, body.exactBodySha256, new Uint8Array([1]))).status).toBe(
      202,
    );
    expect((await intake.submit(bytes, body.exactBodySha256, new Uint8Array([1]))).status).toBe(
      429,
    );
    time = new Date("2026-07-12T00:00:00.000Z");
    expect((await intake.submit(bytes, body.exactBodySha256, new Uint8Array([1]))).status).toBe(
      202,
    );
    time = new Date("2026-07-13T00:00:00.000Z");
    expect(intake.purge().abuse).toBe(1);
  });

  it("does not refresh the fixed 180-day semantic dedupe expiry", async () => {
    let time = new Date("2026-01-01T00:00:00.000Z");
    const intake = createInMemoryFeedbackIntake({ now: () => time });
    const body = prepared();
    const bytes = body.canonicalBody.copyBytes();
    await intake.submit(bytes, body.exactBodySha256, new Uint8Array([1]));
    time = new Date("2026-04-11T00:00:00.000Z");
    await intake.submit(bytes, body.exactBodySha256, new Uint8Array([2]));
    time = new Date("2026-06-30T00:00:00.000Z");
    expect(intake.purge().dedupe).toBe(1);
    expect(intake.purge()).toEqual({ payloads: 0, receipts: 0, dedupe: 0, abuse: 0 });
  });
});
