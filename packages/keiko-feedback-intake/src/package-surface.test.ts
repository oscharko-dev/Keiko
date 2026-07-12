import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface PackFile {
  readonly path: string;
}

interface PackEntry {
  readonly files: readonly PackFile[];
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productionModules = [
  "config",
  "crypto",
  "file-secret-provider",
  "feedback-review-command",
  "feedback-review-identifier",
  "feedback-review-persistence",
  "feedback-review-store",
  "feedback-review-types",
  "feedback-review-query",
  "feedback-publication-command",
  "feedback-publication-dispatch",
  "feedback-publication-persistence",
  "feedback-publication-projection",
  "feedback-publication-query",
  "feedback-publication-records",
  "feedback-publication-runner",
  "feedback-publication-runtime",
  "feedback-publication-store",
  "feedback-publication-types",
  "feedback-publication-worker-sql",
  "feedback-publication-worker-store",
  "feedback-publication-worker-success",
  "feedback-publication-worker-types",
  "feedback-publication-worker",
  "github-app-config",
  "github-app-jwt",
  "github-app-key",
  "github-app-transport",
  "github-issue-adapter",
  "github-secure-file",
  "http",
  "index",
  "main",
  "maintainer-action",
  "maintainer-auth",
  "maintainer-config",
  "maintainer-http",
  "maintainer-http-body",
  "maintainer-http-error",
  "maintainer-http-response",
  "maintainer-login-limiter",
  "maintainer-oidc",
  "maintainer-publication-action",
  "maintainer-publication-http",
  "maintainer-runtime",
  "maintainer-store",
  "maintainer-ui",
  "migrations",
  "postgres-client",
  "postgres-live-key-snapshot",
  "postgres-retention",
  "postgres-types",
  "postgres",
  "production-service",
  "proxy",
  "runtime-config",
  "runtime-key-custody",
  "runtime-pools",
  "runtime-timer",
  "runtime",
  "types",
] as const;
const forbiddenModules = ["intake", "keys", "memory-store", "postgres-integration-helpers"];

function packedPaths(): readonly string[] {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`npm pack --dry-run failed: ${result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout) as readonly PackEntry[];
  return (parsed[0]?.files ?? []).map((file) => file.path).sort();
}

function expectedPaths(): readonly string[] {
  const compiled = productionModules.flatMap((module) => [
    `dist/${module}.d.ts`,
    `dist/${module}.d.ts.map`,
    `dist/${module}.js`,
  ]);
  return [
    "assets/keiko-semantic-tokens.css",
    "assets/keiko-tokens.css",
    "assets/maintainer-ui.css",
    "assets/maintainer-ui-copy.js",
    "assets/maintainer-ui-dom.js",
    "assets/maintainer-ui.html",
    "assets/maintainer-ui.js",
    "migrations/001_feedback_intake.sql",
    "migrations/002_feedback_review.sql",
    "migrations/003_feedback_publication.sql",
    "migrations/004_feedback_publication_worker.sql",
    "migrations/005_feedback_publication_circuit.sql",
    "package.json",
    ...compiled,
  ].sort();
}

function relativeRuntimeImports(path: string): readonly string[] {
  const source = readFileSync(resolve(packageRoot, path), "utf8");
  return [...source.matchAll(/(?:from\s+|import\s*)["'](\.\.?\/[^"']+\.js)["']/gu)].map((match) =>
    relative(packageRoot, resolve(packageRoot, dirname(path), match[1] ?? "")),
  );
}

describe("hosted npm package surface", () => {
  it("ships exactly the production runtime, declarations, and migration", () => {
    expect(packedPaths()).toEqual(expectedPaths());
  });

  it("physically excludes test and in-memory-only compiled modules", () => {
    const paths = packedPaths();
    for (const module of forbiddenModules) {
      expect(paths.filter((path) => path.startsWith(`dist/${module}.`))).toEqual([]);
    }
  });

  it("includes every relative JavaScript dependency of every shipped module", () => {
    const paths = new Set(packedPaths());
    for (const path of paths) {
      if (!path.endsWith(".js")) continue;
      for (const imported of relativeRuntimeImports(path)) {
        expect(paths, `${path} imports missing ${imported}`).toContain(imported);
      }
    }
  });

  it("keeps publication creation capabilities off the package root and raw adapter surface", () => {
    const rootSource = readFileSync(resolve(packageRoot, "src/index.ts"), "utf8");
    for (const forbidden of [
      "GovernedGithubIssueAdapter",
      "PostgresFeedbackPublicationWorkerStore",
      "GithubAppPrivateKeyProvider",
      "createGithubAppJwt",
      "FixedOriginGithubTransport",
      "GithubTransport",
    ]) {
      expect(rootSource).not.toContain(forbidden);
    }
    const adapterSource = readFileSync(resolve(packageRoot, "src/github-issue-adapter.ts"), "utf8");
    expect(adapterSource).toContain("async #postIssue(");
    expect(adapterSource).not.toContain("createIssue(");
    expect(packedPaths().some((path) => path.includes("feedback-publication-armed"))).toBe(false);
    const rootDeclaration = readFileSync(resolve(packageRoot, "dist/index.d.ts"), "utf8");
    expect(rootDeclaration).not.toMatch(
      /GovernedGithubIssueAdapter|PostgresFeedbackPublicationWorkerStore|GithubAppPrivateKeyProvider|createGithubAppJwt|FixedOriginGithubTransport/u,
    );
    const adapterDeclaration = readFileSync(
      resolve(packageRoot, "dist/github-issue-adapter.d.ts"),
      "utf8",
    );
    expect(adapterDeclaration).not.toContain("createIssue");
    expect(adapterDeclaration).not.toContain("postIssue");
  });
});
