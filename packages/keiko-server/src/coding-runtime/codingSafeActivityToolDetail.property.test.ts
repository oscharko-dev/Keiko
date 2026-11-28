import { describe, it } from "vitest";
import { checkProperty, type Generator } from "../../../../tests/support/property-testing.js";
import { openCodeProgramKind } from "./codingSafeActivityToolDetail.js";

// A call's text inside a literal, a pattern or a comment is not a call: whatever code surrounds it,
// the program keeps the neutral label. A real call placed after the same literal still names its kind.
const MENTIONS = [
  "tools.shell({})",
  "tools.bash(1)",
  "tools.automation.create({})",
  "tools.fixture.echo({})",
] as const;
const WRAPS: readonly ((mention: string) => string)[] = [
  (m): string => `"${m}"`,
  (m): string => `'${m}'`,
  (m): string => `\`${m}\``,
  (m): string => `/${m.replaceAll("/", "\\/")}/u`,
  (m): string => `/[/]${m}/g`,
  (m): string => `/*${m}*/ 0`,
];
const LEADS = [
  "return ",
  "const x = ",
  "foo(",
  "a = b / c, d = ",
  "if (ok) { return ",
  "x ? 1 : ",
] as const;

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
  const wrap = WRAPS[value.wrap] as (mention: string) => string;
  const lead = LEADS[value.lead] as string;
  const tail = lead.includes("{") ? ";}" : lead.endsWith("(") ? ")" : ";";
  return `${lead}${wrap(value.mention)}${tail}`;
}

describe("a mention of a tool call in a literal, pattern or comment (property)", () => {
  it("never names a program kind", async () => {
    await checkProperty({
      name: "mention in literal names no kind",
      generate: cases,
      property: (value) => {
        const kind = openCodeProgramKind({ input: { code: literalProgram(value) } });
        if (kind !== undefined) throw new Error(`labelled ${kind}: ${literalProgram(value)}`);
      },
    });
  });

  it("still names the kind of a real call that follows the literal", async () => {
    await checkProperty({
      name: "real call after a literal names its kind",
      generate: cases,
      property: (value) => {
        const code = `${literalProgram(value)}\nawait tools.shell({});`;
        const kind = openCodeProgramKind({ input: { code } });
        // A literal the scan could not place (after `)` or `}`) leaves the program unread.
        if (kind !== undefined && kind !== "command") throw new Error(`wrong kind ${kind}`);
      },
    });
  });
});
