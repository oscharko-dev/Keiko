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
