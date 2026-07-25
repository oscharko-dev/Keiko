#!/usr/bin/env node
// Reports whether the change set under test is documentation only, for CI cost scoping (#2699).
//
// Writes `documentation-only=true|false` to $GITHUB_OUTPUT when present, and prints the verdict.
// Any failure to determine the change set prints false: the expensive matrix then runs, which is
// the only safe direction for this decision.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * Resolves the verdict for a change set. Exported so the decision — including every path that must
 * answer "false" — is testable without spawning git or writing to $GITHUB_OUTPUT.
 */
export function resolveVerdict(baseSha, headSha, listChangedPaths = changedPaths) {
  if (typeof baseSha !== "string" || baseSha.length === 0) {
    return { documentationOnly: false, reason: "no base sha supplied" };
  }
  try {
    const paths = listChangedPaths(baseSha, headSha);
    return {
      documentationOnly: isDocumentationOnlyChange(paths),
      reason: `${String(paths.length)} changed path(s)`,
    };
  } catch (error) {
    return {
      documentationOnly: false,
      reason: `could not resolve the change set (${error instanceof Error ? error.name : "unknown"})`,
    };
  }
}

export function verdictLine({ documentationOnly, reason }) {
  return (
    `documentation-only-change: ${String(documentationOnly)} — ${reason}` +
    (documentationOnly ? "" : " (running the full matrix)")
  );
}

function main() {
  const verdict = resolveVerdict(
    process.env.KEIKO_CHANGE_BASE_SHA ?? "",
    process.env.KEIKO_CHANGE_HEAD_SHA ?? "HEAD",
  );
  console.log(verdictLine(verdict));
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath !== undefined && outputPath.length > 0) {
    appendFileSync(outputPath, `documentation-only=${String(verdict.documentationOnly)}\n`, "utf8");
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) main();
