import { describe, expect, it } from "vitest";
import { assertQualityIntelligenceNever } from "../assertNever.js";

// KEIKO-0898: the exhaustiveness helper's TypeError bubbles out through log sinks, evidence
// records, and the BFF response envelope. Its message must not carry any property value the QI
// union might have been holding — only the bounded discriminant `kind`.

describe("assertQualityIntelligenceNever", () => {
  it("redacts non-discriminant properties from the thrown message", () => {
    try {
      assertQualityIntelligenceNever({
        kind: "requirements",
        text: "SECRET-CANARY-TEXT",
        apiKey: "should-never-appear",
      } as never);
      throw new Error("expected assertQualityIntelligenceNever to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      const message = (error as TypeError).message;
      expect(message).toContain("requirements");
      expect(message).not.toContain("SECRET-CANARY-TEXT");
      expect(message).not.toContain("apiKey");
      expect(message).not.toContain("should-never-appear");
    }
  });

  it("truncates a hostile discriminant to a bounded length", () => {
    const overlong = "x".repeat(4096);
    try {
      assertQualityIntelligenceNever({ kind: overlong } as never);
      throw new Error("expected assertQualityIntelligenceNever to throw");
    } catch (error) {
      const message = (error as TypeError).message;
      expect(message.length).toBeLessThan(overlong.length);
    }
  });

  it("falls back to typeof when the value has no `kind` property", () => {
    try {
      assertQualityIntelligenceNever(42 as never);
      throw new Error("expected assertQualityIntelligenceNever to throw");
    } catch (error) {
      expect((error as TypeError).message).toContain("number");
      expect((error as TypeError).message).not.toContain("42");
    }
  });
});
