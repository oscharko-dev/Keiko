// The error-kind gate exists three times, once per package that writes activity-log events:
// keiko-server, keiko-model-gateway and keiko-local-knowledge. It is the guard that stops a
// provider-supplied `error.code` — which can be a sentence, and can echo the input that was
// rejected — from reaching the log verbatim under the `errorKind` field.
//
// Consolidating it into keiko-contracts is the structurally correct answer, but it adds a public
// export and therefore drifts the packaged surface contract (AGENTS.md §8), which is a separate
// change with its own gate. What must not wait is the SILENT part: each package tests only its own
// copy, so relaxing one of the three breaks nothing and nobody finds out until a provider message
// lands in a log file. This pin makes divergence loud.
//
// When the consolidation happens, this file is deleted in the same change — a single definition
// cannot drift from itself.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const COPIES = [
  {
    label: "keiko-server",
    file: "packages/keiko-server/src/observability/server-log.ts",
  },
  {
    label: "keiko-model-gateway",
    file: "packages/keiko-model-gateway/src/observability.ts",
  },
  {
    label: "keiko-local-knowledge",
    file: "packages/keiko-local-knowledge/src/knowledge-log.ts",
  },
];

// Deliberately matched as source text rather than by importing the three modules: the point is
// that the three DECLARATIONS agree, and importing would only prove that whatever each module
// exports agrees with itself.
const DECLARATION = /const ERROR_KIND_PATTERN = (\/[^\n]*\/);/;

function declaredPattern(file) {
  const source = readFileSync(join(REPO_ROOT, file), "utf8");
  const match = DECLARATION.exec(source);
  return match?.[1];
}

describe("error-kind gate does not drift between packages", () => {
  it("declares the identical pattern in every package that writes activity-log events", () => {
    const found = COPIES.map((copy) => ({
      label: copy.label,
      pattern: declaredPattern(copy.file),
    }));

    // A missing declaration is a failure too: it means the copy was renamed, moved or deleted, and
    // this pin must be re-pointed rather than silently passing over two of three.
    const missing = found.filter((entry) => entry.pattern === undefined).map((e) => e.label);
    expect(missing).toStrictEqual([]);

    const distinct = new Set(found.map((entry) => entry.pattern));
    expect([...distinct]).toHaveLength(1);
  });

  it("still gates the shapes the guard exists for", () => {
    const source = declaredPattern(COPIES[0].file);
    expect(source).toBeDefined();
    const pattern = new RegExp(source.slice(1, source.lastIndexOf("/")));

    // An identifier passes.
    expect(pattern.test("EMBEDDING_ADAPTER_FAILED")).toBe(true);
    expect(pattern.test("http-error")).toBe(true);
    // A sentence — the shape that can carry the rejected input — does not.
    expect(pattern.test("Setting {'encoding_format': 'float'} is not supported")).toBe(false);
    expect(pattern.test("token sk-proj-abc is invalid")).toBe(false);
    // Neither does an over-long run that could hide a payload.
    expect(pattern.test(`E${"x".repeat(200)}`)).toBe(false);
  });
});
