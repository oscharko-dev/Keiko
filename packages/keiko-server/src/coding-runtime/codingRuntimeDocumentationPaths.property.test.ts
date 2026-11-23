// Seeded properties of the documentation-path rule (#4491, AGENTS.md section 10): whatever the
// folder or letter case, a file under a directory code or tests read is never documentation, and a
// code extension never is either.
import { describe, expect, it } from "vitest";
import {
  arrayOf,
  checkProperty,
  propertySettings,
  type Generator,
} from "../../../../tests/support/property-testing.js";
import { CODE_READ_DIRECTORIES, isDocumentationPath } from "./codingRuntimeDocumentationPaths.js";

const LISTED: readonly string[] = [
  "src",
  "lib",
  "app",
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
  "resources",
  "fixtures",
  "__fixtures__",
  "testdata",
  "test-data",
  "__snapshots__",
  "snapshots",
  "prompts",
  "templates",
  "skills",
  ".claude",
  ".github",
];
const NEUTRAL = ["docs", "guide", "notes", "api", "handbook", "a", "b2"];
const PROSE = [".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc", ".asciidoc"];
const CODE = [".ts", ".tsx", ".js", ".mjs", ".java", ".py", ".json", ".xml", ".yml", ".kt", ".go"];
const STEMS = ["expected", "overview", "prompt", "index", "main", "setup"];

const caseVariant: Generator<(text: string) => string> = (random) =>
  random.pick([
    (text: string): string => text,
    (text: string): string => text.toUpperCase(),
    (text: string): string => text.slice(0, 1).toUpperCase() + text.slice(1),
  ]);

interface Sample {
  readonly dirs: readonly string[];
  readonly stem: string;
  readonly extension: string;
  readonly separator: "/" | "\\";
  readonly cased: (text: string) => string;
}

function sample(extensions: readonly string[], listed: boolean): Generator<Sample> {
  return (random) => {
    const dirs = arrayOf((r) => r.pick(NEUTRAL), 0, 3)(random);
    const cased = caseVariant(random);
    if (listed) dirs.splice(random.integer(0, dirs.length), 0, random.pick(LISTED));
    return {
      dirs: dirs.map((dir) => (LISTED.includes(dir) ? cased(dir) : dir)),
      stem: random.pick(STEMS),
      extension: random.pick(extensions),
      separator: random.pick(["/", "\\"] as const),
      cased,
    };
  };
}

function render(value: Sample): string {
  return [...value.dirs, `${value.stem}${value.extension}`].join(value.separator);
}

function run(name: string, generate: Generator<Sample>, hold: (value: Sample) => void): void {
  it(name, async () => {
    let cases = 0;
    await checkProperty({
      name,
      generate,
      property: (value) => {
        cases += 1;
        hold(value);
      },
    });
    // Not vacuous: every planned case ran.
    expect(cases).toBe(propertySettings({ name }).runs);
  });
}

describe("documentation path rule properties", () => {
  it("lists exactly the directories the properties draw from", () => {
    expect([...CODE_READ_DIRECTORIES]).toEqual(expect.arrayContaining([...LISTED]));
  });

  run("a prose file under a listed directory is never documentation", sample(PROSE, true), (v) => {
    expect(isDocumentationPath(render(v))).toBe(false);
  });

  run("a code extension is never documentation, in any folder", sample(CODE, false), (v) => {
    expect(isDocumentationPath(render(v))).toBe(false);
  });

  run(
    "a prose file outside every listed directory stays documentation",
    sample(PROSE, false),
    (v) => {
      expect(isDocumentationPath(render(v))).toBe(true);
    },
  );

  run("letter case changes nothing", sample([...PROSE, ...CODE], true), (v) => {
    const path = render(v);
    expect(isDocumentationPath(path.toUpperCase())).toBe(isDocumentationPath(path.toLowerCase()));
  });
});
