import { describe, expect, it } from "vitest";

import {
  LINEAR_RATIO_MAX,
  measureScaling,
  scalingRatio,
} from "../../../tests/support/property-testing.js";
import { applyPolicy, classifySensitivity } from "./policy.js";

describe("classifySensitivity", () => {
  it("returns public for plain preferences", () => {
    expect(classifySensitivity("I prefer two-space indentation")).toBe("public");
  });

  it("returns confidential when the body contains an email address", () => {
    expect(classifySensitivity("contact alice@example.com for review")).toBe("confidential");
  });

  it("takes an address only where its local part starts at a word boundary", () => {
    expect(classifySensitivity("write to a-b@example.com")).toBe("confidential");
    expect(classifySensitivity("write to .x@example.com")).toBe("confidential");
    expect(classifySensitivity("an @example.com handle")).toBe("public");
    expect(classifySensitivity("a stray -@example.com")).toBe("public");
    expect(classifySensitivity("alice@example")).toBe("public");
  });

  // "1.1.1." and "z.B.z.B." once cost quadratic time: the address pattern read the rest of the
  // text from every position before it found no "@".
  it.each(["1.", "z.B.", "a.", "x.x@"])(
    "classifies a long run of %j in linear time",
    { timeout: 60_000 },
    (piece) => {
      const scaling = measureScaling({
        build: (size) => piece.repeat(Math.ceil(size / piece.length)),
        run: (text) => classifySensitivity(text),
        size: 1_000,
        maximumSize: 1_000,
      });
      expect(scaling.measurable, JSON.stringify(scaling)).toBe(true);
      expect(scalingRatio(scaling), JSON.stringify(scaling)).toBeLessThan(LINEAR_RATIO_MAX);
    },
  );

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
    expect(classifySensitivity("Meine IBAN ist DE89 3704 0044 0532 0130 00")).toBe("confidential");
    expect(classifySensitivity("Steuer-ID: 12 345 678 901")).toBe("confidential");
    expect(classifySensitivity("Ruf mich unter +49 30 1234567 an")).toBe("confidential");
    expect(classifySensitivity("Lokale Nummer 030-1234567 ist privat")).toBe("confidential");
  });

  // #4206 audit: with no review step left a confidential body is refused, and a calendar date had
  // the shape of a local telephone number, so a fact with an end date was never learned.
  it("reads a calendar date as a date, not as a telephone number", () => {
    expect(classifySensitivity("Ich arbeite bei Acme bis 31.12.2027.")).toBe("public");
    expect(classifySensitivity("seit 01.03.2024 bei Acme")).toBe("public");
    expect(classifySensitivity("I started on 2026-11-07.")).toBe("public");
    expect(classifySensitivity("from 1/2/2026 on")).toBe("public");
    expect(classifySensitivity("bis 31.12.2027, Tel 030 1234 5678")).toBe("confidential");
    expect(classifySensitivity("Ruf mich am 31.12.2027 unter +49 30 1234567 an")).toBe(
      "confidential",
    );
  });

  // A dotted telephone number has date-shaped groups; only a standalone date may be blanked.
  it("keeps a dotted telephone number confidential", () => {
    expect(classifySensitivity("Meine Nummer ist 01.23.45.67.89")).toBe("confidential");
    expect(classifySensitivity("Durchwahl 030.12.05.2020")).toBe("confidential");
    expect(classifySensitivity("call 12.34.5678")).toBe("confidential");
  });

  // #4206 audit: blanking every date-shaped token removed the tail of a telephone number whose
  // subscriber part looks like a date, and the remaining prefix no longer read as a number.
  it("keeps a telephone number with a date-shaped tail confidential", () => {
    expect(classifySensitivity("Tel 0171 12.12.12")).toBe("confidential");
    expect(classifySensitivity("Ruf 089 10.11.12 an")).toBe("confidential");
    expect(classifySensitivity("Meine Nummer ist +49 30 12.05.2020")).toBe("confidential");
    expect(classifySensitivity("Ab 31.12.2027 030 1234 5678")).toBe("confidential");
  });

  it("keeps a date next to an ordinary number or another date public", () => {
    expect(classifySensitivity("Termin am 12.05.2026 10 Uhr")).toBe("public");
    expect(classifySensitivity("Raum 3 12.05.2026")).toBe("public");
    expect(classifySensitivity("Projekt vom 01.01.2026 - 31.12.2027")).toBe("public");
    // A short date opening a range, or a time, is no dialling prefix.
    expect(classifySensitivity("Urlaub 01.03. - 31.03.2026")).toBe("public");
    expect(classifySensitivity("Kurs 09.30 12.03.2026")).toBe("public");
    expect(classifySensitivity("Sitzung am 05. 12.03.2026")).toBe("public");
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
