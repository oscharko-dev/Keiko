// npm-script detection and kind classification. Reads package.json through the workspace
// WorkspaceFs boundary (never raw node:fs), mirroring the parseScripts approach in
// src/tools/registry.ts but adding the kind-mapping layer the plan consumes.
//
// All name matching is done with plain substring/equality checks (no regex), so there is no
// ReDoS surface at all (CodeQL js/polynomial-redos). Script NAMES are matched, never values.

import { readWorkspaceFile } from "../workspace/index.js";
import type { WorkspaceFs, WorkspaceInfo } from "../workspace/index.js";
import type { ScriptCatalog, ScriptMapping } from "./types.js";

// package.json is small; this cap is generous and prevents reading a pathological file.
const PACKAGE_READ_BYTES = 262_144;

function parseScripts(text: string): Readonly<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A malformed package.json yields no scripts rather than throwing: detection is best-effort
    // and the plan will mark every kind skipped, which is a visible, testable outcome (D4).
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  const scripts = (parsed as Record<string, unknown>).scripts;
  if (typeof scripts !== "object" || scripts === null) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof value === "string") {
      out[name] = value;
    }
  }
  return out;
}

// Returns the first script name whose lowercased name satisfies `match`, preferring an exact-name
// hit over a substring hit so `test` wins over `pretest`/`test:watch` for the test kind.
function pickScript(
  names: readonly string[],
  exact: readonly string[],
  contains: readonly string[],
): string | undefined {
  for (const name of names) {
    if (exact.includes(name.toLowerCase())) {
      return name;
    }
  }
  for (const name of names) {
    const lower = name.toLowerCase();
    if (
      contains.some((needle) => lower.includes(needle)) &&
      !contains.some((needle) => isLifecycleWrapper(lower, needle))
    ) {
      return name;
    }
  }
  return undefined;
}

function isLifecycleWrapper(lowerName: string, needle: string): boolean {
  return (
    lowerName === `pre${needle}` ||
    lowerName === `post${needle}` ||
    lowerName.startsWith(`pre${needle}:`) ||
    lowerName.startsWith(`post${needle}:`)
  );
}

// Maps script names to verification kinds via conventional heuristics. Exact-name matches win;
// otherwise a substring of the lowercased name. `typecheck`/`type-check`/`tsc` → typecheck;
// `lint`/`eslint` → lint; `build` → build; `test` → test.
export function classifyScripts(scripts: Readonly<Record<string, string>>): ScriptMapping {
  const names = Object.keys(scripts);
  return {
    test: pickScript(names, ["test"], ["test"]),
    typecheck: pickScript(names, ["typecheck", "type-check", "tsc"], ["typecheck", "type-check"]),
    lint: pickScript(names, ["lint"], ["lint", "eslint"]),
    build: pickScript(names, ["build"], ["build"]),
  };
}

export function detectScripts(workspace: WorkspaceInfo, fs?: WorkspaceFs): ScriptCatalog {
  let scripts: Readonly<Record<string, string>>;
  try {
    const content = readWorkspaceFile(
      workspace,
      "package.json",
      { maxBytes: PACKAGE_READ_BYTES },
      fs,
    );
    scripts = parseScripts(content.text);
  } catch {
    // No package.json or an unreadable one: no scripts detected. The plan marks kinds skipped (D4).
    scripts = {};
  }
  return { scripts, mapping: classifyScripts(scripts) };
}
