#!/usr/bin/env node
// Runs SonarCloud's rule engine locally, over the pull-request diff (Issue #2699).
//
// SonarCloud's quality gate blocks on `new_violations`, `new_security_rating`,
// `new_reliability_rating` and `new_maintainability_rating` — all of them decided by rules that were
// invisible on a developer machine, because `eslint-plugin-sonarjs` was not installed. So the only
// way to learn that a diff violated one was to push and read the hosted analysis, which makes a
// required gate the discovery mechanism instead of the confirmation of a known answer.
//
// Scope matches Sonar's: only files this branch changed against its base. A pre-existing finding in
// untouched code is not this diff's to answer for, exactly as Sonar's new-code period decides.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import sonarjs from "eslint-plugin-sonarjs";

import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { isTestPath } from "./sonar-analysis-scope.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINTABLE = /\.(?:ts|tsx|mjs|cjs|js|jsx)$/u;

function git(args) {
  return execFileSync(resolveHostExecutable("git"), args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function resolveBaseRef(argv, env) {
  const explicit = argv.find((entry) => entry.startsWith("--base="));
  if (explicit !== undefined) return explicit.slice("--base=".length);
  return env.KEIKO_NEW_CODE_BASE_REF ?? "origin/dev";
}

/** Changed, still-present, lintable files — the set Sonar would treat as new code. */
export function changedLintableFiles(names, exists) {
  return names
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && LINTABLE.test(entry) && !isTestPath(entry))
    .filter((entry) => exists(entry));
}

// SonarCloud raises no issue on a line that carries a `NOSONAR` comment, whatever the rule (#4525).
const NOSONAR = /\bNOSONAR\b/u;

function suppressedLines(result, readSource) {
  const source = result.source ?? readSource(result.filePath);
  return new Set(
    source.split("\n").flatMap((text, index) => (NOSONAR.test(text) ? [index + 1] : [])),
  );
}

export function summarise(results, readSource = (path) => readFileSync(path, "utf8")) {
  const findings = [];
  for (const result of results) {
    // A file the engine could not parse (or type) was not analysed at all; passing it would hide
    // every finding it holds, so it fails like a finding.
    const sonarMessages = result.messages.filter(
      (message) => message.fatal === true || String(message.ruleId ?? "").startsWith("sonarjs/"),
    );
    if (sonarMessages.length === 0) continue;
    const suppressed = suppressedLines(result, readSource);
    for (const message of sonarMessages) {
      if (message.fatal !== true && suppressed.has(message.line)) continue;
      findings.push({
        line: message.line,
        message: message.message,
        path: result.filePath.startsWith(repoRoot)
          ? result.filePath.slice(repoRoot.length + 1)
          : result.filePath,
        rule: message.fatal === true ? "parse-error" : String(message.ruleId),
      });
    }
  }
  return findings;
}

// SonarCloud analyses with the organisation's quality profile, not the plugin's `recommended` set:
// 19 recommended rules are inactive for TypeScript there (#4525). The snapshot lists the rule keys
// each language's profile activates; refresh it when the organisation changes its profile
// (docs/qa/local-sonar.md).
export const QUALITY_PROFILE = JSON.parse(
  readFileSync(resolve(repoRoot, "scripts/sonar-quality-profile.json"), "utf8"),
);

const TYPESCRIPT_FILES = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];
const UI_ROOT = resolve(repoRoot, "packages/keiko-ui");
const JAVASCRIPT_FILES = ["**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"];

/** The SonarCloud rule key (`S4782`) a plugin rule implements, read from its documentation link. */
export function sonarRuleKey(rule) {
  return /\/(S\d+)(?:\/|$)/u.exec(String(rule?.meta?.docs?.url ?? ""))?.[1];
}

/** The plugin's recommended rules that the given profile language actually activates. */
export function profileRules(language, plugin = sonarjs, profile = QUALITY_PROFILE) {
  const active = new Set(profile[language]);
  return Object.fromEntries(
    Object.entries(plugin.configs.recommended.rules).filter(([name, level]) => {
      if (level === "off" || level === 0) return false;
      const key = sonarRuleKey(plugin.rules[name.slice("sonarjs/".length)]);
      return key !== undefined && active.has(key);
    }),
  );
}

/** A TypeScript file under the UI package, whose own ESLint config carries no type information. */
export function isUiTypeScriptFile(path) {
  return path.startsWith(UI_ROOT + sep) && /\.tsx?$/u.test(path);
}

// The repository's own flat configs still apply; these rules are layered on top, so parsing and
// globals stay exactly as `npm run lint` sees them. The UI's own config lints without type
// information, but SonarCloud analyses UI files with `packages/keiko-ui/tsconfig.json`; without it
// a type-aware rule such as S4782 cannot see `exactOptionalPropertyTypes` and reports what
// SonarCloud does not (#4525).
export function createEngine() {
  return new ESLint({
    cwd: repoRoot,
    overrideConfig: [
      { files: TYPESCRIPT_FILES, plugins: { sonarjs }, rules: profileRules("typescript") },
      { files: JAVASCRIPT_FILES, plugins: { sonarjs }, rules: profileRules("javascript") },
      {
        // A function, not a glob: override globs resolve against the config that owns the file,
        // which for UI files is the UI's own directory.
        files: [isUiTypeScriptFile],
        languageOptions: {
          parserOptions: {
            projectService: true,
            tsconfigRootDir: UI_ROOT,
          },
        },
      },
    ],
  });
}

function lintChangedFiles(files) {
  return createEngine().lintFiles(files);
}

/**
 * The whole verdict as data: what to print and how to exit. Exported, with injectable
 * collaborators, so every branch — unresolvable base, empty diff, clean lint, violations — is
 * reachable from a test without spawning git or loading the rule engine (#2699).
 */
export async function evaluate({
  argv = [],
  env = {},
  run = git,
  exists = existsInTree,
  lint = lintChangedFiles,
}) {
  const baseRef = resolveBaseRef(argv, env);
  let base;
  try {
    base = run(["merge-base", baseRef, "HEAD"]).trim();
  } catch {
    return {
      failures: [
        `sonar-rules: FAIL - cannot resolve "${baseRef}" against HEAD. Fetch the base ` +
          "(`git fetch origin dev`) or name another one with `--base=<ref>`.",
      ],
      ok: false,
    };
  }
  const files = changedLintableFiles(run(["diff", "--name-only", `${base}..HEAD`, "--"]), exists);
  if (files.length === 0) {
    return {
      failures: [],
      ok: true,
      summary: "sonar-rules: PASS — no changed source files in Sonar's main scope.",
    };
  }
  const findings = summarise(await lint(files));
  if (findings.length === 0) {
    return {
      failures: [],
      ok: true,
      summary: `sonar-rules: PASS — ${String(files.length)} changed file(s), no SonarCloud rule violations.`,
    };
  }
  return {
    failures: [
      ...findings.map(
        (finding) =>
          `sonar-rules: FAIL - ${finding.path}:${String(finding.line)} ${finding.rule} — ${finding.message}`,
      ),
      `sonar-rules: ${String(findings.length)} violation(s) SonarCloud would report on new code.`,
    ],
    ok: false,
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const verdict = await evaluate({ argv, env });
  if (verdict.summary !== undefined) console.log(verdict.summary);
  for (const failure of verdict.failures) console.error(failure);
  if (!verdict.ok) process.exit(1);
}

export function existsInTree(path) {
  try {
    git(["cat-file", "-e", `HEAD:${path}`]);
    return true;
  } catch {
    return false;
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) await main();
