import { describe, expect, it } from "vitest";
import { WorkspaceReadError } from "./errors.js";
import { redactWorkspaceSource } from "./sourceRedaction.js";

// Verbatim windows of this repository's own documents (AGENTS.md section 8, lines 746-778 at
// 6f9bab91b, and CONTRIBUTING.md, lines 638-641) that the code-region inference once read as source,
// so `redactWorkspaceSource` threw and the Coding runtime attached no repository instructions
// (#3900). Plain English prose, copied so the proof does not depend on the live documents.
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

describe("redactWorkspaceSource on repository instruction documents", () => {
  it.each([
    ["AGENTS.md", AGENTS_PROSE_WINDOW],
    ["CONTRIBUTING.md", CONTRIBUTING_PROSE_WINDOW],
    ["docs/guide.md", AGENTS_PROSE_WINDOW + CONTRIBUTING_PROSE_WINDOW],
  ])("projects the prose of %s without refusing it", (scopePath, text) => {
    expect(redactWorkspaceSource(text, scopePath)).toBe(text);
    expect(redactWorkspaceSource(text, scopePath, false)).toBe(text);
  });

  it("keeps a document with checklists and links whole and still masks its code", () => {
    const value = ["synthetic", "instructions", "6291"].join("-");
    const text = [
      "# Working agreement",
      "",
      "- [ ] Stop if the issue's work requires secrets or token-bearing artifacts (2).",
      "- [x](docs/a.md) explains the flow; read it before every push.",
      "- Run tests (see below) first.",
      "",
      AGENTS_PROSE_WINDOW,
      "```ts",
      `const password = "${value}";`,
      "```",
      "",
    ].join("\n");
    const safe = redactWorkspaceSource(text, "AGENTS.md");
    expect(safe).not.toContain(value);
    expect(safe).toBe(text.replace(value, "[REDACTED]"));
  });

  it.each([
    'Intro (2).\n\nconst x = foo(bar baz, "synthetic-malformed-value");\n',
    'Intro (2).\n\n```ts\nconst password = "synthetic-malformed-value\n```\n',
  ])("still fails closed when the document holds source that does not parse", (text) => {
    expect(() => redactWorkspaceSource(text, "AGENTS.md")).toThrow(WorkspaceReadError);
    expect(() => redactWorkspaceSource(text, "AGENTS.md")).toThrow(
      "code source redaction is unavailable",
    );
  });
});
