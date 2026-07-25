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
import { dirname, resolve } from "node:path";
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

export function summarise(results) {
  const findings = [];
  for (const result of results) {
    for (const message of result.messages) {
      const rule = String(message.ruleId ?? "");
      if (!rule.startsWith("sonarjs/")) continue;
      findings.push({
        line: message.line,
        message: message.message,
        path: result.filePath.startsWith(repoRoot)
          ? result.filePath.slice(repoRoot.length + 1)
          : result.filePath,
        rule,
      });
    }
  }
  return findings;
}

// The repository's own flat config still applies; these rules are layered on top, so parsing,
// globals and type information stay exactly as `npm run lint` sees them.
export function createEngine() {
  return new ESLint({
    overrideConfig: [
      {
        files: ["**/*.{ts,tsx,mjs,cjs,js,jsx}"],
        plugins: { sonarjs },
        rules: sonarjs.configs.recommended.rules,
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
