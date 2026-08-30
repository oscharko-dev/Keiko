// Guards the one property this repository's git activity-log evidence rests on: a production module
// that spawns git does so through an OBSERVED runner (AGENTS.md §8 Rule 1).
//
// `gitRoutes.ts` re-exports `defaultGitProcessRunner` / `defaultGitNetworkProcessRunner` /
// `createGitProcessRunner` unchanged, and its own header used to recommend importing "the process
// surface from here". Nothing in the type system separates those from the wrapped runner
// `optionsWithDefaults` hands out, so a future route could grab one, spawn git directly, and lose
// every `git.process.failed` / `git.process.refused` line with no lint, dependency-cruiser or
// compiler signal — the review finding this test answers.
//
// The rule is per-OCCURRENCE, not per-file: each mention of a raw runner as a value must have
// `observedGitRunner` within a few lines of it. A per-file rule ("the file also mentions the
// wrapper somewhere") was written first and proved vacuous under sabotage — removing the wrapper
// call left the import behind, so the file still "mentioned" it and the guard stayed green against
// exactly the regression it exists to catch.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_SRC = join(REPO_ROOT, "packages", "keiko-server", "src");

const RAW_RUNNERS = [
  "defaultGitProcessRunner",
  "defaultGitNetworkProcessRunner",
  "createGitProcessRunner",
];

// `relative()` returns backslash-separated paths on Windows, while every literal below (EXEMPT,
// the assertions) is written forward-slash. Comparing raw `relative()` output against those
// literals would silently lose the EXEMPT entry and every `named` assertion on that platform,
// making the guard vacuous there rather than failing loudly.
function posixRelative(from, to) {
  return relative(from, to).split(sep).join("/");
}

// The module that DEFINES the wrapper cannot be required to call it.
const EXEMPT = new Set(["packages/keiko-server/src/gitProcessActivity.ts"]);

function productionSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...productionSources(full));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
    if (entry.includes(".test.") || entry.includes(".bench.")) continue;
    if (entry.endsWith("test-support.ts") || entry.endsWith("testing.ts")) continue;
    out.push(full);
  }
  return out;
}

// Lines mentioning a raw runner as a VALUE — not a comment, not an `import type` / `export type`,
// and not the plain import or re-export that merely NAMES it for a composition root or a test.
// A line that only NAMES a raw runner for a composition root or a test — a comment, a type-only
// import, or any line inside an import/export block — is not a call site and is not scanned.
function isNonCodeLine(line, inImportOrExportBlock) {
  return (
    /^\s*(?:\/\/|\*|\/\*)/u.test(line) ||
    /\b(?:import|export)\s+type\b/u.test(line) ||
    /^\s*(?:import|export)\b/u.test(line) ||
    inImportOrExportBlock
  );
}

function rawRunnerValueLines(source) {
  const lines = source.split("\n");
  const hits = [];
  let inImportOrExportBlock = false;
  let lineStart = 0;
  for (const [index, line] of lines.entries()) {
    if (/^\s*(?:import|export)\s*\{/u.test(line)) inImportOrExportBlock = true;
    const isBlockEnd = inImportOrExportBlock && /\}\s*(?:from\s*"[^"]*"\s*)?;?\s*$/u.test(line);
    const skip = isNonCodeLine(line, inImportOrExportBlock);
    if (isBlockEnd) inImportOrExportBlock = false;
    if (skip) {
      lineStart += line.length + 1;
      continue;
    }
    // Each occurrence is recorded by its CHARACTER offset, not merely its line, so it can be
    // tested against `observedGitRunner(...)` argument spans rather than against line proximity.
    for (const runner of RAW_RUNNERS) {
      let at = line.indexOf(runner);
      while (at !== -1) {
        hits.push({ index, line, offset: lineStart + at });
        at = line.indexOf(runner, at + runner.length);
      }
    }
    lineStart += line.length + 1;
  }
  return { hits, lines };
}

// Character spans covering the ARGUMENTS of every `observedGitRunner(...)` call, found by matching
// parentheses from each call's opening bracket. A proximity window was tried first and was
// bypassable: `const raw = defaultGitProcessRunner; observedGitRunner(other, sink, id); await
// raw(...)` put an unrelated wrapper call within the window, so the guard passed while git ran
// unobserved. Nearness is not the property that matters — being an ARGUMENT is — so that is what
// this measures. A gate must fail closed, and a bypassable gate is worse than none because it
// reads as coverage.
function observedArgumentSpans(source) {
  const spans = [];
  const marker = "observedGitRunner(";
  let from = 0;
  for (;;) {
    const call = source.indexOf(marker, from);
    if (call === -1) return spans;
    let depth = 0;
    let end = -1;
    for (let i = call + marker.length - 1; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    // An unbalanced call (truncated file) is treated as covering nothing rather than everything.
    if (end === -1) return spans;
    spans.push({ start: call + marker.length, end });
    from = end;
  }
}

// Every identifier that DEMONSTRABLY reaches `observedGitRunner`: named directly as one of its
// arguments, or naming a local helper whose own body calls it (`syncExecution.ts`'s `observe`).
// Requiring a raw runner to be a literal argument would reject those legitimate shapes; accepting
// mere proximity accepts the bypass. Binding to this set is the property in between.
function observedIdentifiers(source) {
  const identifiers = new Set();
  for (const span of observedArgumentSpans(source)) {
    for (const name of source.slice(span.start, span.end).matchAll(/[A-Za-z_$][\w$]*/gu)) {
      identifiers.add(name[0]);
    }
  }
  // A local helper that forwards into `observedGitRunner` counts as observed, so the runner it is
  // handed is observed too. Matched on the declaration line, which is where such a helper is bound.
  // `[^;]*?` deliberately stops at the first statement terminator: without that bound the scan ran
  // past the declaration into the NEXT statement, so `const sneaky = createGitProcessRunner(x);`
  // followed anywhere by an unrelated `observedGitRunner(...)` marked `sneaky` as observed — the
  // same bypass one level up.
  for (const decl of source.matchAll(
    /(?:const|let|function)\s+([A-Za-z_$][\w$]*)\s*(?:=|\()[^;]*?observedGitRunner\(/gu,
  )) {
    identifiers.add(decl[1]);
  }
  return identifiers;
}

// The span of a call to any observed identifier — `observe(seams.runner ?? defaultGitProcessRunner)`
// — so a raw runner handed to a forwarding helper is covered without loosening the rule to nearness.
function observedCallSpans(source, identifiers) {
  const spans = [];
  for (const name of identifiers) {
    let from = 0;
    const marker = `${name}(`;
    for (;;) {
      const call = source.indexOf(marker, from);
      if (call === -1) break;
      let depth = 0;
      let end = -1;
      for (let i = call + marker.length - 1; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === "(") depth += 1;
        else if (ch === ")") {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) break;
      spans.push({ start: call + marker.length, end });
      from = end;
    }
  }
  return spans;
}

// The identifier a raw runner is bound to on its own line, if any: `const runner = x ?? raw;`.
// That binding is observed only when the identifier itself reaches `observedGitRunner`.
function boundIdentifier(line) {
  return /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/u.exec(line)?.[1];
}

function unobservedRawRunnerLines(source) {
  const { hits } = rawRunnerValueLines(source);
  const identifiers = observedIdentifiers(source);
  const spans = [...observedArgumentSpans(source), ...observedCallSpans(source, identifiers)];
  return hits.filter(({ offset, line }) => {
    if (spans.some((span) => offset >= span.start && offset < span.end)) return false;
    const bound = boundIdentifier(line);
    return bound === undefined || !identifiers.has(bound);
  });
}

describe("git runner observation", () => {
  it("wraps every raw git runner a production source reaches for", () => {
    const offenders = productionSources(SERVER_SRC)
      .map((file) => ({ rel: posixRelative(REPO_ROOT, file), source: readFileSync(file, "utf8") }))
      .filter(({ rel }) => !EXEMPT.has(rel))
      .flatMap(({ rel, source }) =>
        unobservedRawRunnerLines(source).map(
          ({ index, line }) => `${rel}:${index + 1} ${line.trim()}`,
        ),
      );

    expect(offenders).toEqual([]);
  });

  // Synthetic sources, not the repository: a gate that only ever sees compliant input cannot show
  // it would reject anything. `fail closed` has to be demonstrated on the shapes it must refuse.
  it.each([
    {
      label: "a raw runner merely NEAR an unrelated wrapper call",
      source: [
        "const raw = defaultGitProcessRunner;",
        "const other = makeRunner();",
        "const observed = observedGitRunner(other, sink, id);",
        "await raw(args, options);",
      ].join("\n"),
    },
    {
      label: "a raw runner called directly with no wrapper anywhere",
      source: "await defaultGitNetworkProcessRunner(args, options);",
    },
    {
      label: "a raw runner bound to an identifier that never reaches the wrapper",
      source: [
        "const sneaky = createGitProcessRunner(envFactory);",
        "const wrapped = observedGitRunner(somethingElse, sink, id);",
        "await sneaky(args, options);",
      ].join("\n"),
    },
  ])("rejects $label", ({ source }) => {
    // The proximity window this guard originally used passed the first case: an unrelated
    // `observedGitRunner` call inside the window made an unwrapped runner look observed, so git
    // could run with no activity-log evidence while the gate stayed green.
    expect(unobservedRawRunnerLines(source)).not.toHaveLength(0);
  });

  it.each([
    {
      label: "a raw runner passed straight into the wrapper",
      source: "const r = observedGitRunner(inputs.runner ?? defaultGitProcessRunner, sink, id);",
    },
    {
      label: "a raw runner bound first, then wrapped",
      source: [
        "const runner = options?.runner ?? defaultGitProcessRunner;",
        "return { runner: observedGitRunner(runner, sink, correlationId) };",
      ].join("\n"),
    },
    {
      label: "a raw runner handed to a local forwarding helper",
      source: [
        "const observe = (runner) => observedGitRunner(runner, sink, id);",
        "readRunner: observe(seams.runner ?? defaultGitProcessRunner),",
      ].join("\n"),
    },
  ])("accepts $label", ({ source }) => {
    // The complement: a rule strict enough to demand a literal argument would reject these real,
    // correct shapes and push authors to weaken the gate instead of using it.
    expect(unobservedRawRunnerLines(source)).toEqual([]);
  });

  it("actually inspects the files it claims to — the guard is not vacuous", () => {
    // A rule that scanned nothing would pass the assertion above forever. Pin that the sweep finds
    // the known observed spawn sites, so deleting or renaming them fails here rather than silently
    // shrinking the guarded set to zero.
    const scanned = productionSources(SERVER_SRC)
      .map((file) => posixRelative(REPO_ROOT, file))
      .filter((rel) => !EXEMPT.has(rel));
    const named = productionSources(SERVER_SRC)
      .map((file) => ({ rel: posixRelative(REPO_ROOT, file), source: readFileSync(file, "utf8") }))
      .filter(({ rel }) => !EXEMPT.has(rel))
      .filter(({ source }) => rawRunnerValueLines(source).hits.length > 0)
      .map(({ rel }) => rel);

    expect(scanned.length).toBeGreaterThan(100);
    expect(named).toContain("packages/keiko-server/src/gitRoutes.ts");
    expect(named).toContain("packages/keiko-server/src/gitRepositoryRoutes.ts");
    expect(named).toContain("packages/keiko-server/src/gitDelivery/syncExecution.ts");
    expect(named).toContain("packages/keiko-server/src/grounded-git-history-evidence.ts");
  });
});
