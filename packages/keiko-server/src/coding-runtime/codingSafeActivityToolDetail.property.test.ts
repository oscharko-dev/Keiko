import { describe, expect, it } from "vitest";
import {
  assertFrequencyFloor,
  checkProperty,
  LINEAR_RATIO_MAX,
  measureScaling,
  propertySettings,
  scalingRatio,
  type Generator,
} from "../../../../tests/support/property-testing.js";
import { openCodeProgramKind } from "./codingSafeActivityToolDetail.js";

// A call's text inside a literal, a pattern or a comment is not a call: whatever code surrounds it,
// the program keeps the neutral label. A real call after the same literal, or between two
// divisions, is seen and names its kind exactly.
const MENTIONS = [
  "tools.shell({})",
  "tools.bash(1)",
  "tools.automation.create({})",
  "tools.fixture.echo({})",
] as const;
const WRAPS: readonly {
  readonly name: string;
  readonly pattern: boolean;
  readonly wrap: (mention: string) => string;
}[] = [
  { name: "double", pattern: false, wrap: (m): string => `"${m}"` },
  { name: "single", pattern: false, wrap: (m): string => `'${m}'` },
  { name: "template", pattern: false, wrap: (m): string => `\`${m}\`` },
  { name: "regex", pattern: true, wrap: (m): string => `/${m.replaceAll("/", "\\/")}/u` },
  { name: "class", pattern: true, wrap: (m): string => `/[/]${m}/g` },
  { name: "comment", pattern: false, wrap: (m): string => `/*${m}*/ 0` },
];
// What stands before a new expression: the start of one after each kind of token the scan must read.
const LEADS = [
  { head: "return ", tail: ";" },
  { head: "const x = ", tail: ";" },
  { head: "foo(", tail: ")" },
  { head: "a = b / c, d = ", tail: ";" },
  { head: "a / ", tail: ";" },
  { head: "a++ / ", tail: ";" },
  { head: "b-- / ", tail: ";" },
  { head: "x.in / ", tail: ";" },
  { head: "x.return / ", tail: ";" },
  { head: "(a + b) / ", tail: ";" },
  { head: "arr[0] / ", tail: ";" },
  { head: "if (ok) ", tail: ";" },
  { head: "while (ok) ", tail: ";" },
  { head: "x ? 1 : ", tail: ";" },
  { head: "typeof ", tail: ";" },
  { head: "if (ok) { run(); } else ", tail: ";" },
] as const;
const DIVIDED = ["a", "a++", "b--", "x.in", "x.return", "(a + b)", "arr[0]", "1.5", '"s"', "`t`"];

interface Case {
  readonly mention: string;
  readonly wrap: number;
  readonly lead: number;
}

const cases: Generator<Case> = (random) => ({
  mention: random.pick(MENTIONS),
  wrap: random.integer(0, WRAPS.length - 1),
  lead: random.integer(0, LEADS.length - 1),
});

function literalProgram(value: Case): string {
  const wrap = WRAPS[value.wrap];
  const lead = LEADS[value.lead];
  if (wrap === undefined || lead === undefined) throw new RangeError("case out of range");
  return `${lead.head}${wrap.wrap(value.mention)}${lead.tail}`;
}

const MENTION_NAME = "a mention of a tool call in a literal, pattern or comment";

describe(`${MENTION_NAME} (property)`, () => {
  it("never names a program kind", async () => {
    const options = {
      name: "mention in literal names no kind",
      generate: cases,
      property: (value: Case): void => {
        const kind = openCodeProgramKind({ input: { code: literalProgram(value) } });
        if (kind !== undefined) throw new Error(`labelled ${kind}: ${literalProgram(value)}`);
      },
    };
    const seen = { pattern: 0, comment: 0, division: 0 };
    await checkProperty({
      ...options,
      property: (value) => {
        const wrap = WRAPS[value.wrap];
        if (wrap?.pattern === true) seen.pattern += 1;
        if (wrap?.name === "comment") seen.comment += 1;
        if (LEADS[value.lead]?.head.includes(" / ") === true) seen.division += 1;
        options.property(value);
      },
    });
    const { runs } = propertySettings(options);
    for (const [what, count, share] of [
      ["a pattern literal", seen.pattern, 0.2],
      ["a comment", seen.comment, 0.05],
      ["a division before the literal", seen.division, 0.2],
    ] as const) {
      assertFrequencyFloor({ what, count, runs, share, validatedRuns: 200 });
    }
  });

  it("names exactly the kind of a real call that follows the literal", async () => {
    const options = {
      name: "real call after a literal names its kind",
      generate: cases,
      property: (value: Case): void => {
        const code = `${literalProgram(value)}\nawait tools.shell({});`;
        const kind = openCodeProgramKind({ input: { code } });
        if (kind !== "command") throw new Error(`labelled ${String(kind)}: ${code}`);
      },
    };
    await checkProperty(options);
  });

  it("sees a real call between two divisions", async () => {
    const generate: Generator<number> = (random) => random.integer(0, DIVIDED.length - 1);
    const options = {
      name: "call between divisions is seen",
      generate,
      property: (index: number): void => {
        const code = `return ${DIVIDED[index] ?? "a"} / tools.shell({}) / 2;`;
        const kind = openCodeProgramKind({ input: { code } });
        if (kind !== "command") throw new Error(`labelled ${String(kind)}: ${code}`);
      },
    };
    await checkProperty(options);
    const { runs } = propertySettings(options);
    expect(runs).toBeGreaterThanOrEqual(1);
  });
});

describe("reading a program's code (property)", () => {
  it("is linear in the length of a program full of slashes and long words", () => {
    for (const build of [
      (size: number): string => `${"a / ".repeat(size)}tools.shell({});`,
      (size: number): string => `return ${"x".repeat(size)} / 2;${"/ ".repeat(size)}`,
      (size: number): string => "(a) / b, ".repeat(size),
      (size: number): string => "/a/g, ".repeat(size),
    ]) {
      const scaling = measureScaling({
        size: 2_000,
        maximumSize: 128_000,
        build,
        run: (code: string) => void openCodeProgramKind({ input: { code } }),
      });
      expect(scalingRatio(scaling)).toBeLessThanOrEqual(LINEAR_RATIO_MAX);
    }
  });
});
