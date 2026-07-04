// GEN-DUP-SEMANTIC-018 — the UI-local store error codes were normalized to the dominant
// SCREAMING_SNAKE_CASE wire convention. This coverage pins the factory codes AND guards the
// convention repo-wide: every `errorBody("<literal>")` and every UiStoreError factory code in the
// keiko-server source must match /^[A-Z][A-Z0-9_]*$/ so a future snake_case literal fails CI.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  invalidPath,
  invalidRequest,
  notFound,
  pathNotDirectory,
  pathNotFound,
  projectExists,
  UiStoreError,
  type UiStoreErrorCode,
} from "./errors.js";

describe("UiStoreError factories (GEN-DUP-SEMANTIC-018)", () => {
  it("emit SCREAMING_SNAKE_CASE codes with unchanged status + message", () => {
    const cases: readonly {
      readonly err: UiStoreError;
      readonly code: UiStoreErrorCode;
      readonly status: number;
    }[] = [
      { err: invalidPath("bad path"), code: "INVALID_PATH", status: 400 },
      { err: pathNotDirectory(), code: "PATH_NOT_DIRECTORY", status: 400 },
      { err: pathNotFound(), code: "PATH_NOT_FOUND", status: 400 },
      { err: notFound("Chat"), code: "NOT_FOUND", status: 404 },
      { err: invalidRequest("nope"), code: "INVALID_REQUEST", status: 400 },
      { err: projectExists(), code: "PROJECT_EXISTS", status: 409 },
    ];
    for (const { err, code, status } of cases) {
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
      expect(err).toBeInstanceOf(UiStoreError);
    }
  });

  it("preserves the friendly messages (behavior-preserving relabel)", () => {
    expect(invalidPath("custom").message).toBe("custom");
    expect(pathNotDirectory().message).toBe("The path is not a directory.");
    expect(pathNotFound().message).toBe("The path does not exist.");
    expect(notFound("Chat").message).toBe("Chat not found.");
    expect(projectExists().message).toBe("Project already registered.");
  });

  it("every factory code matches the SCREAMING_SNAKE convention", () => {
    const codes: readonly UiStoreErrorCode[] = [
      invalidPath("x").code,
      pathNotDirectory().code,
      pathNotFound().code,
      notFound("x").code,
      invalidRequest("x").code,
      projectExists().code,
    ];
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});

// ── Convention guard: scan the whole keiko-server source for errorBody("<literal>") calls. ──
const SERVER_SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function collectTsFiles(dir: string, acc: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTsFiles(full, acc);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

// Matches the string-literal form errorBody("SOME_CODE", ...). Variable forms
// (errorBody(error.code, ...)) forward already-typed domain codes and are covered by their own
// per-domain tests, so they are intentionally out of scope here.
const ERROR_BODY_LITERAL_RE = /errorBody\(\s*"([^"]+)"/g;
const SCREAMING_SNAKE_RE = /^[A-Z][A-Z0-9_]*$/;

describe("keiko-server errorBody code casing convention (GEN-DUP-SEMANTIC-018)", () => {
  const files = collectTsFiles(SERVER_SRC_DIR, []);

  it("finds source files to scan (guard is not silently empty)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("every errorBody(<literal>) code is SCREAMING_SNAKE_CASE", () => {
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(ERROR_BODY_LITERAL_RE)) {
        const code = match[1];
        if (code !== undefined && !SCREAMING_SNAKE_RE.test(code)) {
          violations.push(`${file}: ${code}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
