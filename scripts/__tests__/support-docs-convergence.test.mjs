// #3534 retired the open JSONL support bundle, its inclusion flags and raw-log analysis at the
// support boundary. Operator documentation must describe the canonical report only, so a reader
// who copies a command never reaches a refusal the docs did not mention.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

const RETIRED = [
  { name: "a bundle file as --out", pattern: /keiko support export[^\n`]*--out\s+\S*\.jsonl/u },
  { name: "analyze of a bundle file", pattern: /keiko support analyze\s+\S*\.jsonl/u },
  { name: "a retired inclusion flag", pattern: /--include-(?:evidence|ui-log)\b|--i-understand-/u },
  { name: "analyze of a raw segment", pattern: /support analyze`? on the newest segment/u },
];

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

function retiredUses(text) {
  return text
    .split("\n")
    .flatMap((line, index) =>
      RETIRED.filter(({ pattern }) => pattern.test(line)).map(
        ({ name }) => `${String(index + 1)}: ${name}`,
      ),
    );
}

describe("support documentation converges on the canonical report (#3534)", () => {
  it("documents no retired support bundle command", () => {
    const files = [
      ...markdownFiles(join(ROOT, "docs")),
      ...["AGENTS.md", "CONTRIBUTING.md", "README.md"].map((name) => join(ROOT, name)),
    ];
    const findings = files.flatMap((file) =>
      retiredUses(readFileSync(file, "utf8")).map((use) => `${relative(ROOT, file)}:${use}`),
    );
    expect(findings).toEqual([]);
  });

  it("recognizes every retired form", () => {
    expect(
      retiredUses(
        [
          "keiko support export --out keiko-support.jsonl",
          "keiko support analyze bundle.jsonl --clusters",
          "keiko support export --include-evidence run-1",
          "run `keiko support analyze` on the newest segment in <stateDir>/logs/",
        ].join("\n"),
      ),
    ).toEqual([
      "1: a bundle file as --out",
      "2: analyze of a bundle file",
      "3: a retired inclusion flag",
      "4: analyze of a raw segment",
    ]);
    expect(retiredUses("keiko support export --correlation-id <runId>")).toEqual([]);
  });
});
