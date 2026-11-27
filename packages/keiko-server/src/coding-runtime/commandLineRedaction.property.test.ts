import { describe, expect, it } from "vitest";
import {
  arrayOf,
  assertFrequencyFloor,
  checkProperty,
  measureScaling,
  propertySettings,
  scalingRatio,
  LINEAR_RATIO_MAX,
  shrinkArray,
  type Generator,
} from "../../../../tests/support/property-testing.js";
import { redactCommandLineCredentials } from "./commandLineRedaction.js";

const NAMES = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "api-key",
  "credential",
  "auth",
  "db.password",
  "my-auth-token",
  "PASSWORD",
] as const;
const SAFE_NAMES = ["verbose", "offline", "batch-mode", "Dtest", "reporter", "threads"] as const;
const VALUES = ["hunter2", "s3cr3t-value", "a.b/c:d", "x".repeat(40), "tok_9F8e7D6c5B4a"] as const;
const SAFE_VALUES = ["true", "4", "dot", "src/app"] as const;
const SPACES = [" ", "  ", "\t"] as const;

const SHAPES = [
  "equals",
  "define",
  "space",
  "quoted",
  "wrapped",
  "env",
  "unbalanced",
  "escaped",
  "escapedSingle",
  "powershell",
  "envFlag",
  "envFlagSpaced",
] as const;
type Shape = (typeof SHAPES)[number];
// Names whose substring is a credential word but whose LAST segment is not: never masked.
const SUBSTRING_NAMES = [
  "pass-through",
  "keyword",
  "key-file",
  "monkey-patch",
  "password-file",
  "author",
] as const;

interface Case {
  readonly name: string;
  readonly value: string;
  readonly shape: Shape;
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly space: string;
}

const generateCase: Generator<Case> = (random) => ({
  name: random.pick(NAMES),
  value: random.pick(VALUES),
  shape: random.pick(SHAPES),
  before: arrayOf((r) => r.pick(SAFE_NAMES), 0, 3)(random).map((word) => `--${word}`),
  after: arrayOf((r) => r.pick(SAFE_VALUES), 0, 3)(random),
  space: random.pick(SPACES),
});

const envName = (name: string): string => name.replace(/[^A-Za-z0-9_]/gu, "_");

function render(item: Case): string {
  const option = {
    equals: `--${item.name}=${item.value}`,
    define: `-D${item.name}=${item.value}`,
    space: `--${item.name} ${item.value}`,
    quoted: `--${item.name}="${item.value} with spaces"`,
    wrapped: `"--${item.name}=${item.value} with spaces"`,
    env: `${envName(item.name)}=${item.value}`,
    unbalanced: `"oops --${item.name}=${item.value}`,
    escaped: `--${item.name}="${item.value}\\" ${item.value}x"`,
    escapedSingle: `--${item.name} '${item.value}\\' ${item.value}x`,
    powershell: `$env:${envName(item.name)}="${item.value} w"`,
    envFlag: `--env=${envName(item.name)}=${item.value}`,
    envFlagSpaced: `--env ${envName(item.name)}=${item.value}`,
  }[item.shape];
  return ["mvn", ...item.before, option, ...item.after].join(item.space);
}

// The settings of one property, so the vacuity floor below is derived from the runs actually made.
const MASKING = { name: "credential-named options are masked wherever they sit" };

describe("redactCommandLineCredentials (properties)", () => {
  it("masks the value of every credential-named option, in every spelling", async () => {
    const seen = Object.fromEntries(SHAPES.map((shape) => [shape, 0])) as Record<Shape, number>;
    await checkProperty({
      ...MASKING,
      generate: generateCase,
      shrink: function* (item) {
        for (const before of shrinkArray(item.before)) yield { ...item, before };
        for (const after of shrinkArray(item.after)) yield { ...item, after };
      },
      property: (item) => {
        seen[item.shape] += 1;
        const out = redactCommandLineCredentials(render(item));
        expect(out).not.toContain(item.value);
        expect(out).toContain("[REDACTED]");
      },
    });
    const { runs } = propertySettings(MASKING);
    for (const shape of SHAPES) {
      assertFrequencyFloor({
        what: `the ${shape} spelling`,
        count: seen[shape],
        runs,
        share: 0.04,
        validatedRuns: 200,
      });
    }
  });

  it("decides on the last segment of the name, never on a substring", async () => {
    await checkProperty({
      name: "substring names are left alone",
      generate: (random) =>
        `tool --${random.pick(SUBSTRING_NAMES)}=${random.pick(VALUES)} --${random.pick(SUBSTRING_NAMES)} ${random.pick(SAFE_VALUES)}`,
      property: (line) => {
        expect(redactCommandLineCredentials(line)).toBe(line);
      },
    });
  });

  it("changes nothing in a line without a credential-named option", async () => {
    await checkProperty({
      name: "safe options are left alone",
      generate: (random) =>
        [
          "mvn",
          ...arrayOf((r) => `--${r.pick(SAFE_NAMES)}=${r.pick(SAFE_VALUES)}`, 0, 5)(random),
        ].join(random.pick(SPACES)),
      property: (line) => {
        expect(redactCommandLineCredentials(line)).toBe(line);
      },
    });
  });

  it("keeps a following option: --auth --verbose masks nothing", () => {
    expect(redactCommandLineCredentials("tool --auth --verbose")).toBe("tool --auth --verbose");
  });

  it("is linear in the length of a hostile line", () => {
    const scaling = measureScaling({
      size: 2_000,
      maximumSize: 128_000,
      build: (size: number) => `--token=${'"'.repeat(size)} ${"-D".repeat(size)}`,
      run: (line: string) => void redactCommandLineCredentials(line),
    });
    expect(scalingRatio(scaling)).toBeLessThanOrEqual(LINEAR_RATIO_MAX);
  });
});
