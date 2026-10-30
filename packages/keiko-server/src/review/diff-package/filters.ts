// File-type filtering of the review diff package (Issue #4134).
//
// Port of PR-Agent v0.49.0 (MIT) `file_filter.py` and `language_handler.py`
// (`AUTO_GENERATED_FILES_EXACT`, the generated-suffix list): lockfiles, minified bundles, source
// maps and generated or vendored files are left out of the review and reported as `filtered` with
// their closed reason, never silently dropped. A repository's review configuration can exclude
// further paths, by exact path or by directory prefix (an entry ending in `/`); no pattern language
// is interpreted.

import type { ReviewDiffFilterReason } from "@oscharko-dev/keiko-contracts";
import { reviewPathBasename } from "./paths.js";

const LOCKFILES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "composer.lock",
  "Gemfile.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "go.sum",
  "Cargo.lock",
  "mix.lock",
  "pubspec.lock",
  "Podfile.lock",
  "packages.lock.json",
  "gradle.lockfile",
  "flake.lock",
  ".terraform.lock.hcl",
]);

const MINIFIED_SUFFIXES: readonly string[] = [".min.js", ".min.mjs", ".min.cjs", ".min.css"];

const GENERATED_SUFFIXES: readonly string[] = [
  ".js.map",
  ".mjs.map",
  ".cjs.map",
  ".css.map",
  ".ts.map",
  "_pb2.py",
  "_pb2_grpc.py",
  ".pb.go",
  ".pb.cc",
  ".pb.h",
  ".g.dart",
  ".freezed.dart",
  ".designer.cs",
];

const VENDORED_DIRECTORIES: ReadonlySet<string> = new Set([
  "vendor",
  "node_modules",
  "third_party",
  "bower_components",
]);

function isGenerated(lowerName: string): boolean {
  return (
    lowerName.includes(".generated.") ||
    GENERATED_SUFFIXES.some((suffix) => lowerName.endsWith(suffix))
  );
}

function isVendored(path: string): boolean {
  const directories = path.split("/").slice(0, -1);
  return directories.some((segment) => VENDORED_DIRECTORIES.has(segment));
}

function isConfigExcluded(path: string, excluded: readonly string[]): boolean {
  return excluded.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
}

/** Why a changed path is left out of the review, or `undefined` when it is reviewed. */
export function reviewDiffFilterReason(
  path: string,
  excludedPaths: readonly string[],
): ReviewDiffFilterReason | undefined {
  if (isConfigExcluded(path, excludedPaths)) return "review-config-excluded";
  const name = reviewPathBasename(path);
  if (LOCKFILES.has(name)) return "lockfile";
  const lowerName = name.toLowerCase();
  if (MINIFIED_SUFFIXES.some((suffix) => lowerName.endsWith(suffix))) return "minified";
  if (isGenerated(lowerName)) return "generated";
  return isVendored(path) ? "vendored" : undefined;
}
