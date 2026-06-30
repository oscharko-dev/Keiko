import { describe, expect, it } from "vitest";

import { applyPolicy, classifySensitivity } from "./policy.js";

describe("classifySensitivity", () => {
  it("returns public for plain preferences", () => {
    expect(classifySensitivity("I prefer two-space indentation")).toBe("public");
  });

  it("returns confidential when the body contains an email address", () => {
    expect(classifySensitivity("contact alice@example.com for review")).toBe("confidential");
  });

  it("returns confidential when the body contains a phone-shape number", () => {
    expect(classifySensitivity("call +1-555-123-4567")).toBe("confidential");
  });

  it("returns confidential when the body carries an explicit 'confidential' marker", () => {
    expect(classifySensitivity("this note is confidential: ship before Q3")).toBe("confidential");
  });

  it("returns confidential when the body carries 'internal' or 'private' markers", () => {
    expect(classifySensitivity("internal only: switch to graviton instances")).toBe("confidential");
    expect(classifySensitivity("private: do not share")).toBe("confidential");
  });

  it("returns confidential for German governance markers", () => {
    expect(classifySensitivity("vertraulich: Release erst morgen")).toBe("confidential");
    expect(classifySensitivity("nur intern: API Gateway bleibt selbst gehostet")).toBe(
      "confidential",
    );
    expect(classifySensitivity("privat: nicht teilen")).toBe("confidential");
    expect(classifySensitivity("geheim: Feature-Flag bleibt aus")).toBe("confidential");
    expect(classifySensitivity("nicht speichern: nur temporär merken")).toBe("confidential");
  });

  it("returns confidential for German IBAN, Steuer-ID, and phone shapes", () => {
    expect(classifySensitivity("Meine IBAN ist DE89 3704 0044 0532 0130 00")).toBe(
      "confidential",
    );
    expect(classifySensitivity("Steuer-ID: 12 345 678 901")).toBe("confidential");
    expect(classifySensitivity("Ruf mich unter +49 30 1234567 an")).toBe("confidential");
    expect(classifySensitivity("Lokale Nummer 030-1234567 ist privat")).toBe("confidential");
  });

  it("keeps false-positive-near German number examples public", () => {
    expect(classifySensitivity("Wir haben 12345678901 Testfälle im synthetischen Benchmark")).toBe(
      "public",
    );
    expect(classifySensitivity("Ticket 030-123 bleibt offen")).toBe("public");
    expect(classifySensitivity("DE89 ist nur ein kurzer Länderpräfix-Hinweis")).toBe("public");
  });

  it("honors a defaultSensitivity override for benign text", () => {
    expect(classifySensitivity("I prefer dark mode", "confidential")).toBe("confidential");
  });

  it("never promotes the default upward — markers always win", () => {
    expect(classifySensitivity("contact bob@example.com", "public")).toBe("confidential");
  });
});

describe("applyPolicy", () => {
  it("public body flows through without approval", () => {
    const decision = applyPolicy("I prefer two-space indentation");
    expect(decision.sensitivity).toBe("public");
    expect(decision.requiresApproval).toBe(false);
  });

  it("confidential body requires approval", () => {
    const decision = applyPolicy("internal: deploy at midnight");
    expect(decision.sensitivity).toBe("confidential");
    expect(decision.requiresApproval).toBe(true);
  });

  it("override forcing default to confidential flips approval on benign text", () => {
    const decision = applyPolicy("I prefer dark mode", { defaultSensitivity: "confidential" });
    expect(decision.sensitivity).toBe("confidential");
    expect(decision.requiresApproval).toBe(true);
  });

  it("rejects an explicit restricted default — restricted is unrepresentable from text", () => {
    expect(() => {
      applyPolicy("anything", { defaultSensitivity: "restricted" });
    }).toThrow(/restricted/);
  });
});
