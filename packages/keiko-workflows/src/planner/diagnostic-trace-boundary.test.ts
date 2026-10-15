import { describe, expect, it } from "vitest";
import { parseDiagnosticTraceText } from "../bug-investigation/failure-parse.js";
import { extractRetrievalChannels } from "./references.js";

function externalFrames(count: number): string {
  return Array.from(
    { length: count },
    (_value, index) => `    at execute (node:internal/tool-${String(index)}:10:3)`,
  ).join("\n");
}

describe("diagnostic parsing preserves the human request after its frame scan budget", () => {
  it.each([1_999, 2_000, 2_010])("keeps request terms after %i external frames", (count) => {
    const channels = extractRetrievalChannels(
      `${externalFrames(count)}\nExplain PaymentValidator`,
      8,
    );
    expect(channels.questionText).toBe("Explain PaymentValidator");
    expect(channels.anchors.map((anchor) => anchor.term)).toContain("paymentvalidator");
    expect(channels.references).toEqual([]);
    expect(channels.stackTraceDetected).toBe(true);
    expect(channels.stackTraceFrameCount).toBeLessThanOrEqual(25);
  });

  it("preserves an ordinary request following two thousand empty lines", () => {
    const text = `${"\n".repeat(2_000)}Explain PaymentValidator`;
    const parsed = parseDiagnosticTraceText(text);
    expect(parsed.questionText).toBe(text);
    expect(parsed.detected).toBe(false);
    expect(extractRetrievalChannels(text, 8).anchors.map((anchor) => anchor.term)).toContain(
      "paymentvalidator",
    );
  });

  it("does not collect an additional in-scope diagnostic reference after the scan cap", () => {
    const channels = extractRetrievalChannels(
      `${externalFrames(2_000)}\n    at run (src/private.ts:301:5)\nExplain PaymentValidator`,
      8,
    );
    expect(channels.references).toEqual([]);
    expect(channels.questionText).toBe("Explain PaymentValidator");
  });
});
