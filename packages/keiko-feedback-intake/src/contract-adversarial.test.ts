import { createHash } from "node:crypto";
import { prepareFeedbackReportV1 } from "@oscharko-dev/keiko-security/feedback-report";
import type { PreparedFeedbackReportV1 } from "@oscharko-dev/keiko-security/feedback-report";
import { describe, expect, it } from "vitest";
import { createInMemoryFeedbackIntake } from "./intake.js";

function canonical(): PreparedFeedbackReportV1 {
  const result = prepareFeedbackReportV1({
    schemaVersion: "1",
    category: "defect",
    title: "Hosted contract",
    description: "The independently verified report.",
    reproductionSteps: "Submit the preview.",
    expectedBehavior: "Exact bytes are accepted.",
    actualBehavior: "Validation runs.",
    productVersion: "0.2.14",
    platform: "Linux",
    featureArea: "model-configuration",
    impact: "Degrades core workflow",
  });
  if (!result.ok) throw new Error("fixture");
  return result.value;
}

function encoded(value: string): { readonly bytes: Uint8Array; readonly digest: string } {
  const bytes = new TextEncoder().encode(value);
  return { bytes, digest: createHash("sha256").update(bytes).digest("hex") };
}

describe("hosted verifier adversarial matrix", () => {
  it.each([
    [
      "flattened summary",
      (report: Record<string, unknown>): Record<string, unknown> => ({
        ...report,
        summary: "flat",
      }),
    ],
    [
      "missing provenance",
      (report: Record<string, unknown>): Record<string, unknown> => {
        const copy = { ...report };
        delete copy.redactionProvenance;
        return copy;
      },
    ],
    [
      "version drift",
      (report: Record<string, unknown>): Record<string, unknown> => ({
        ...report,
        privacyContractVersion: "999",
      }),
    ],
  ])("rejects %s without persistence", async (_name, mutate) => {
    const prepared = canonical();
    const drifted = JSON.stringify(mutate(prepared.report as unknown as Record<string, unknown>));
    const input = encoded(drifted);
    const intake = createInMemoryFeedbackIntake();
    expect((await intake.submit(input.bytes, input.digest, new Uint8Array([1]))).status).toBe(422);
    expect(intake.inspect().payloadCount).toBe(0);
  });

  it.each([
    [
      "BOM",
      (json: string): Uint8Array =>
        Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(json)]),
    ],
    ["invalid UTF-8", (_json: string): Uint8Array => Uint8Array.from([0xc3, 0x28])],
    [
      "duplicate key",
      (json: string): Uint8Array =>
        new TextEncoder().encode(
          json.replace('{"actualResult":', '{"actualResult":"duplicate","actualResult":'),
        ),
    ],
  ])("rejects %s bytes", async (_name, makeBytes) => {
    const bytes = makeBytes(canonical().canonicalJson);
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(
      (await createInMemoryFeedbackIntake().submit(bytes, digest, new Uint8Array([1]))).status,
    ).toBe(422);
  });

  it("routes explicit vulnerability reports away from anonymous intake", async () => {
    const prepared = canonical();
    const report = {
      ...prepared.report,
      summary: {
        title: "Security vulnerability in Keiko: bypass",
        description: "An exploit against Keiko is described.",
      },
    };
    const input = encoded(JSON.stringify(report));
    expect(
      (await createInMemoryFeedbackIntake().submit(input.bytes, input.digest, new Uint8Array([1])))
        .status,
    ).toBe(422);
  });

  it("atomically groups concurrent equal submissions while preserving fresh receipts", async () => {
    const prepared = canonical();
    const intake = createInMemoryFeedbackIntake();
    const submissions = await Promise.all(
      Array.from({ length: 12 }, () =>
        intake.submit(
          prepared.canonicalBody.copyBytes(),
          prepared.exactBodySha256,
          new Uint8Array([1]),
        ),
      ),
    );
    expect(submissions.every((item) => item.status === 202)).toBe(true);
    expect(
      new Set(submissions.map((item) => (item.status === 202 ? item.body.receiptId : ""))).size,
    ).toBe(12);
    expect(intake.inspect()).toMatchObject({ payloadCount: 1, receiptCount: 12, dedupeCount: 1 });
  });
});
