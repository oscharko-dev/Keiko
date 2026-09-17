#!/usr/bin/env node
// Reports whether the change set under test is documentation only, for CI cost scoping (#2699).
//
// Writes the scope verdict and exact cross-platform OS matrix to $GITHUB_OUTPUT when present. Any
// failure to determine the change set prints safe defaults: the full matrix then runs, which is the
// only safe direction for this decision.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { isDocumentationOnlyChange } from "./lib/documentation-only-change.mjs";
import { isWindowsRelevantChange } from "./lib/windows-relevant-change.mjs";

function changedPaths(baseSha, headSha) {
  const output = execFileSync(
    resolveHostExecutable("git"),
    ["diff", "--name-only", "-z", `${baseSha}...${headSha}`, "--"],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return output.split("\0").filter((entry) => entry.length > 0);
}

/**
 * Resolves the verdict for a change set. Exported so the decision, including every path that must
 * answer "false", is testable without spawning git or writing to $GITHUB_OUTPUT.
 */
export function resolveVerdict(baseSha, headSha, listChangedPaths = changedPaths) {
  if (typeof baseSha !== "string" || baseSha.length === 0) {
    return {
      documentationOnly: false,
      reason: "no base sha supplied",
      windowsRelevant: true,
    };
  }
  try {
    const paths = listChangedPaths(baseSha, headSha);
    return {
      documentationOnly: isDocumentationOnlyChange(paths),
      reason: `${String(paths.length)} changed path(s)`,
      windowsRelevant: isWindowsRelevantChange(paths),
    };
  } catch (error) {
    return {
      documentationOnly: false,
      reason: `could not resolve the change set (${error instanceof Error ? error.name : "unknown"})`,
      windowsRelevant: true,
    };
  }
}

const FULL_CROSS_PLATFORM_OS = Object.freeze(["ubuntu-latest", "macos-latest", "windows-latest"]);
const NON_WINDOWS_CROSS_PLATFORM_OS = Object.freeze(["ubuntu-latest", "macos-latest"]);

export function crossPlatformOsForEvent(windowsRelevant, eventName) {
  return eventName === "pull_request" && windowsRelevant === false
    ? NON_WINDOWS_CROSS_PLATFORM_OS
    : FULL_CROSS_PLATFORM_OS;
}

export function verdictLine({ documentationOnly, reason, windowsRelevant }) {
  const matrix = documentationOnly
    ? "cross-platform matrix skipped"
    : windowsRelevant === false
      ? "running the Linux/macOS matrix"
      : "running the full matrix";
  return (
    `documentation-only-change: ${String(documentationOnly)} — ${reason}; ` +
    `windows-relevant=${String(windowsRelevant)} (${matrix})`
  );
}

export function main() {
  const verdict = resolveVerdict(
    process.env.KEIKO_CHANGE_BASE_SHA ?? "",
    process.env.KEIKO_CHANGE_HEAD_SHA ?? "HEAD",
  );
  console.log(verdictLine(verdict));
  const crossPlatformOs = crossPlatformOsForEvent(
    verdict.windowsRelevant,
    process.env.GITHUB_EVENT_NAME ?? "",
  );
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath !== undefined && outputPath.length > 0) {
    appendFileSync(outputPath, `documentation-only=${String(verdict.documentationOnly)}\n`, "utf8");
    appendFileSync(outputPath, `windows-relevant=${String(verdict.windowsRelevant)}\n`, "utf8");
    appendFileSync(outputPath, `cross-platform-os=${JSON.stringify(crossPlatformOs)}\n`, "utf8");
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) main();
