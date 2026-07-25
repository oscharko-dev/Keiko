#!/usr/bin/env node
// Reports whether the change set under test is documentation only, for CI cost scoping (#2699).
//
// Writes `documentation-only=true|false` to $GITHUB_OUTPUT when present, and prints the verdict.
// Any failure to determine the change set prints false: the expensive matrix then runs, which is
// the only safe direction for this decision.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import { isDocumentationOnlyChange } from "./lib/documentation-only-change.mjs";

function changedPaths(baseSha, headSha) {
  const output = execFileSync(
    "git",
    ["diff", "--name-only", "-z", `${baseSha}...${headSha}`, "--"],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return output.split("\0").filter((entry) => entry.length > 0);
}

function main() {
  const baseSha = process.env.KEIKO_CHANGE_BASE_SHA ?? "";
  const headSha = process.env.KEIKO_CHANGE_HEAD_SHA ?? "HEAD";
  let verdict = false;
  let reason = "";
  if (baseSha.length === 0) {
    reason = "no base sha supplied";
  } else {
    try {
      const paths = changedPaths(baseSha, headSha);
      verdict = isDocumentationOnlyChange(paths);
      reason = `${String(paths.length)} changed path(s)`;
    } catch (error) {
      reason = `could not resolve the change set (${error instanceof Error ? error.name : "unknown"})`;
    }
  }
  console.log(
    `documentation-only-change: ${String(verdict)} — ${reason}` +
      (verdict ? "" : " (running the full matrix)"),
  );
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath !== undefined && outputPath.length > 0) {
    appendFileSync(outputPath, `documentation-only=${String(verdict)}\n`, "utf8");
  }
}

main();
