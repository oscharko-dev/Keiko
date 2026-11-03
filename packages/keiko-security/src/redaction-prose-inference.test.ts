import { describe, expect, it } from "vitest";
import { redact } from "./redaction.js";
import type { CodeRedactionReport } from "./redaction-code.js";

// Verbatim windows of this repository's own documents that the code-region inference once read as
// source: AGENTS.md section 8 (lines 746-778 at 6f9bab91b) and CONTRIBUTING.md (lines 638-641). Plain
// English prose, kept here as copies so the proof does not depend on the live documents.
const AGENTS_PROSE_WINDOW =
  [
    "  final prompt fitting; no source or query text enters the Activity Log.",
    "  Already admitted named source files are prioritized before the shared code index applies its",
    "  existing source-file ceiling; resolver metadata remains reserved within that same ceiling. The",
    "  request fixes that preference before its first index build and reuses the same canonical index.",
    "  For contextual whole-file questions, fresh callable evidence is observed through the existing",
    "  batched reader within the existing aggregate discovery-byte capacity. The reader derives window",
    "  capacity from finite requested ranges and remaining bytes, with the existing deadline and cancellation",
    "  guards. Current callable ownership and actual code matches precede root selection; contextual roots",
    "  use the existing query and certified-definition capacity. Explicit selected lines, non-addressed",
    "  discovery and route tracing keep their own rules.",
    "  Lexical query-group coverage alone never certifies the requested implementation or an answer.",
    "  The governed request's existing document collector checks the original remaining file and",
    "  excerpt-byte grant before each extraction. It bounds the redacted logical projection, including",
    "  UTF-8 separator bytes, within that capacity and discloses exhausted or truncated evidence. All positive returned document",
    "  projections reserve their bytes and distinct paths before code reads. Final usage preserves any",
    "  larger assembler usage and retains original initial usage plus actual consumed code bytes and",
    "  distinct positive-consumption paths plus all actually returned positive document projection bytes",
    "  and paths, even when later invalidation or assembly drops their published views. The reservation",
    "  does not enter assembler initial usage, so those contributions are not charged twice. Raw document",
    "  input, parser work and all filesystem I/O are outside these excerpt charges.",
    "  Each batch uses one classified, redacted source snapshot. A later expansion uses a fresh guarded",
    "  read and must match the first",
    "  complete redacted-source fingerprint; a mismatch invalidates all views for that path without",
    "  refunding consumed bytes. Subsequent passes exclude processed ranges and retain actual partial-view",
    "  identities rather than claiming complete bodies from clipped reads.",
    "  The existing selection-details operation records planned ordinary ranges on attempted reader paths,",
    "  ordinary ranges intersected by nonempty returned views, and deferred definition ranges. An",
    "  intersection count does not certify complete source content; truncation and omission counts remain",
    "  authoritative.",
    "  Separately identified returned partial views retain their actual ranges, contents and physical-view",
    "  identities through assembly, without inventing continuity or uncharged separators. Unidentified",
    "  multiple uncovered views remain fail-closed; conflicting views retain uncertainty. Bounded",
    "  observations do not establish that an arbitrarily large function was fully read. File and deadline",
  ].join("\n") + "\n";

const CONTRIBUTING_PROSE_WINDOW =
  [
    "healthy controls; ordinary file eligibility exclusions and budget limits are not failures.",
    "",
    "All repository-add lifecycle join ids, including discarded settlements, must pass the canonical Activity Log correlation guard. Browser delivery-loss counts enter the shared ledger once after rate admission and before routine diversion. Rate-limited reports carrying loss return 429 so the browser restores their counters for later admission; their server-owned drop must not be counted again as a failed POST. Final pagehide loss reports have their own bounded server budget, independent of routine/failure traffic. Gateway streams settle circuit/spend state, close provider iterators and emit completion before yielding done, since production consumers need not advance again. Commit-draft refusals retain measured prompt bounds and generated/reused outcomes share a body-free key digest.",
    "Repository-add dialogs report the attempt and its live or discarded settlement using the request's",
  ].join("\n") + "\n";

interface Outcome {
  readonly output: string;
  readonly refusals: number;
}

function inspect(text: string): Outcome {
  let refusals = 0;
  const output = redact(text, [], {
    preserveSourceLineBreaks: true,
    onCodeProjection: (report: CodeRedactionReport): void => {
      refusals += report.syntaxRefusals + report.depthRefusals + report.sizeRefusals;
    },
  });
  return { output, refusals };
}

describe("prose is not inferred as standalone source", () => {
  it.each([
    ["AGENTS.md section 8 window", AGENTS_PROSE_WINDOW],
    ["CONTRIBUTING.md window", CONTRIBUTING_PROSE_WINDOW],
  ])("keeps the %s whole and readable", (_name, text) => {
    const { output, refusals } = inspect(text);
    expect(refusals).toBe(0);
    expect(output).toBe(text);
  });

  it("keeps a document readable that surrounds the window with other prose and a real fence", () => {
    const text = [
      "# Notes",
      "",
      "Intro (see 2).",
      "",
      AGENTS_PROSE_WINDOW,
      "```ts",
      'export const label = "public";',
      "```",
      "",
      "The function was fully read; it's done.",
      "",
    ].join("\n");
    const { output, refusals } = inspect(text);
    expect(refusals).toBe(0);
    expect(output).toBe(text);
  });

  // Each sentence begins with a word that is also a declaration keyword, or holds one mid-sentence,
  // and none of them is syntax-free: an apostrophe, a digit, a parenthesis or an `=` keeps the
  // whole-text prose shortcut from applying, so the inference itself has to decide. A lead line
  // that starts with a keyword makes the sentence part of a larger candidate, as it is in a real
  // document; a plain lead leaves the sentence as the candidate's first line.
  describe.each(["Intro (2).", "final report (2)."])("after the lead %j", (lead) => {
    it.each([
      "the function was fully read (it's done).",
      "the settlement using the request's own id (2).",
      "we set the value with const x = 5 here; it's done (2).",
      "type of the request decides it, it's said.",
      "let me know what you think = ok, it's said.",
      "const values are immutable here, it's said.",
      "import the module before use; it has (nested) parts = fine.",
      "import in the pipeline, it's said.",
      "enum values are closed; it's said.",
      "class of errors is listed (see below), it's said.",
      "function; no path reaches the database, it's said.",
      "function (chat-handlers.ts:941) does not call anything, it's said.",
      "interface names are stable, it's said.",
      "using the cache, it's said (2).",
    ])("does not read a sentence as a declaration: %j", (sentence) => {
      const text = `${lead}\n${sentence}\n`;
      const { output, refusals } = inspect(text);
      expect(refusals).toBe(0);
      expect(output).toBe(text);
    });
  });

  it.each([
    "[Docs](docs/)\n\nThe function was fully read; it's done (2).",
    "@oscharko owns this.\n\ntype of the request is unknown, it's said (2).",
    "final prompt fitting; the function was fully read (it's done).",
    "healthy controls; the settlement using the request's own id (2).",
  ])("does not read a mid-sentence declaration word as source: %j", (text) => {
    const { output, refusals } = inspect(`${text}\n`);
    expect(refusals).toBe(0);
    expect(output).toBe(`${text}\n`);
  });

  // A Markdown list marker followed by one space is a bullet, not a diff marker: the text after it
  // is judged on its own, so it cannot pull the rest of the document into one refused fragment.
  it.each([
    "- [x](docs/a.md) and the rest; it's done (2).",
    "- [ ] Stop if the issue's work requires secrets or token-bearing artifacts.",
    "- [x] **AC5:** A repeatable bootstrap produces every listed fixture class.",
    "- final artifact summaries, it's said (2),",
    "- static analysis of the repository found it's fine (2).",
    "- Run tests (see below) before every push; it's required.",
    "+ API token; both must belong to the same identity (2).",
  ])("does not read a list item as a diff fragment: %j", (item) => {
    const text = `${item}\n\nThe secret token is 1; it's said.\n`;
    const { output, refusals } = inspect(text);
    expect(refusals).toBe(0);
    expect(output).toBe(text);
  });
});

describe("source still fails closed and stays masked", () => {
  const VALUE = ["synthetic", "prose", "inference", "4417"].join("-");

  it("masks a credential literal inside a real code fence", () => {
    const text = `Intro (2).\n\n\`\`\`ts\nconst password = "${VALUE}";\n\`\`\`\n`;
    const { output, refusals } = inspect(text);
    expect(refusals).toBe(0);
    expect(output).not.toContain(VALUE);
    expect(output).toContain('const password = "[REDACTED]";');
  });

  it.each([
    ["ts", `const password = "${VALUE}`],
    ["ts", `const password = foo(bar baz, "${VALUE}");`],
    ["java", `class A { String password = "${VALUE}" +; }`],
    ["", `const password = foo(bar baz, "${VALUE}");`],
  ])("still refuses an unparsable %j code fence", (language, body) => {
    const text = `Intro (2).\n\n\`\`\`${language}\n${body}\n\`\`\`\n`;
    const { output, refusals } = inspect(text);
    expect(refusals).toBeGreaterThan(0);
    expect(output).not.toContain(VALUE);
  });

  // The same malformed declarations, with nothing but prose around them: error recovery must still
  // find them, and the prose in front of them must not hide them.
  it.each([
    `Here is the code (2):\n\nconst x = foo(bar baz, "${VALUE}");\n`,
    `// comment\nconst x = foo(bar baz, "${VALUE}");\n`,
    `final class Foo {\n int x = "${VALUE}" +;\n`,
    `public final class Foo {\n int x = "${VALUE}" +;\n`,
    `{\n  foo bar\n  const secret = "${VALUE}"\n}`,
    `export default {\n  setup() {\n    const key = "${VALUE}"\n`,
    `describe("x", () => {\n  const key = foo(;"${VALUE}"\n`,
    `Intro (2).\n\nfunction foo\n(a, b {"${VALUE}"\n`,
    `Intro (2).\n\n- see below\n\nexport const key = foo(bar baz, "${VALUE}");\n`,
  ])("still refuses malformed standalone source: %j", (text) => {
    const { output, refusals } = inspect(text);
    expect(refusals).toBeGreaterThan(0);
    expect(output).not.toContain(VALUE);
  });

  it.each([
    `-const config = {"pass\\u0077ord":"${VALUE}"};`,
    `- const config = {"pass\\u0077ord":"${VALUE}"};`,
    `- [ ] const config = {"pass\\u0077ord":"${VALUE}"};`,
    `+ const password = "${VALUE}";`,
  ])("never grants a diff or list marker a raw fallback for private source: %j", (line) => {
    const { output } = inspect(`${line}\n`);
    expect(output).not.toContain(VALUE);
  });
});
