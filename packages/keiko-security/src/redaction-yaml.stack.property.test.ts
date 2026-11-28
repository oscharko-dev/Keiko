import { describe, expect, it } from "vitest";
import {
  LINEAR_RATIO_MAX,
  assertFrequencyFloor,
  checkProperty,
  measureScaling,
  propertySettings,
  scalingRatio,
  type Generator,
} from "../../../tests/support/property-testing.js";
import { redactContent } from "./content-redaction.js";
import { redact } from "./redaction.js";
import { YamlDepthRefusal, isYamlDocument } from "./redaction-yaml.js";

/**
 * Redaction of YAML-shaped text never throws, whatever the nesting depth or the number of lines,
 * never lets a secret through, and its own YAML walks stay linear. The pinned parser recurses per
 * nesting level and the projection once spread one call argument per entry; both overflowed the
 * call stack and masked the whole remaining output.
 */

const SECRET = "tr0ub4dor-secret-value";
const SHAPES = ["nested-map", "nested-seq", "compact-seq", "flat-map", "stat-records"] as const;

interface Case {
  readonly shape: (typeof SHAPES)[number];
  readonly size: number;
  readonly secret: boolean;
}

// Indented shapes grow quadratically in text, so their deep sizes stay a few thousand levels.
const cases: Generator<Case> = (random) => {
  const shape = random.pick(SHAPES);
  const largest = shape === "nested-map" || shape === "nested-seq" ? 2_500 : 6_000;
  return {
    shape,
    size: random.chance(0.3) ? random.integer(600, largest) : random.integer(1, 600),
    secret: random.chance(0.5),
  };
};

function lines(size: number, line: (index: string, i: number) => string): string {
  return Array.from({ length: size }, (_, i) => line(String(i), i)).join("");
}

function body({ shape, size }: Case): string {
  switch (shape) {
    case "nested-map":
      return lines(size, (n, i) => `${" ".repeat(i)}k${n}:\n`) + `${" ".repeat(size)}v: 1\n`;
    case "nested-seq":
      return lines(size, (_n, i) => `${" ".repeat(i * 2)}-\n`) + `${" ".repeat(size * 2)}x\n`;
    case "compact-seq":
      return `${"- ".repeat(size)}x\n`;
    case "flat-map":
      return lines(size, (n) => `k${n}: ${n}\n`);
    case "stat-records":
      return lines(
        size,
        (n, i) =>
          `f${n}.ctime: 1700000000:${n}\nf${n}.dev: 16777230\nf${n}.size: ${String(i * 7)}\n`,
      );
  }
}

function build(value: Case): string {
  return value.secret ? `${body(value)}password: ${SECRET}\n` : body(value);
}

const RUNS = 60;
const NESTED: readonly Case["shape"][] = ["nested-map", "nested-seq", "compact-seq"];

describe("YAML-shaped redaction (property)", () => {
  it("never throws, never leaks, and keeps public flat listings readable", async () => {
    const { runs } = propertySettings({ name: "yaml-shaped redaction", runs: RUNS });
    let deep = 0;
    let readable = 0;
    await checkProperty({
      name: "yaml-shaped redaction",
      runs,
      generate: cases,
      property: (value) => {
        const text = build(value);
        const strict = redact(text);
        const content = redactContent(text, "redact");
        if (value.secret) {
          expect(strict).not.toContain(SECRET);
          expect(content).not.toContain(SECRET);
        }
        if (NESTED.includes(value.shape)) {
          if (value.size > 600) deep += 1;
        } else if (!value.secret) {
          expect(strict).toBe(text);
          readable += 1;
        }
      },
    });
    assertFrequencyFloor({
      what: "deep documents",
      count: deep,
      runs,
      share: 0.05,
      validatedRuns: RUNS,
    });
    assertFrequencyFloor({
      what: "public flat listings",
      count: readable,
      runs,
      share: 0.05,
      validatedRuns: RUNS,
    });
  }, 60_000);

  it("refuses a too-deep document with the explicit depth outcome only", () => {
    const text = build({ shape: "nested-map", size: 5_000, secret: true });
    expect(() => isYamlDocument(text)).toThrow(YamlDepthRefusal);
  });

  it.each(["flat-map", "compact-seq"] as const)("scans %s text in linear time", (shape) => {
    const scaling = measureScaling({
      build: (size) => build({ shape, size, secret: true }),
      run: (text) => {
        try {
          isYamlDocument(text);
        } catch (error) {
          if (!(error instanceof YamlDepthRefusal)) throw error;
        }
      },
      size: 64,
      maximumSize: 16_384,
    });
    expect(scaling.measurable).toBe(true);
    expect(scalingRatio(scaling)).toBeLessThan(LINEAR_RATIO_MAX);
  });
});
