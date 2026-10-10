import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import ts from "typescript";
import { extractInlineScriptHashes } from "@oscharko-dev/keiko-server";
import { collectWorkspacePackages } from "../workspace-graph.mjs";
import { isTestPath } from "../sonar-analysis-scope.mjs";
import { resolveGitExecutable } from "../check-dependency-hygiene.mjs";

export const POLICY_SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const TOOL_CATALOG_FIXTURES = new Set([
  "packages/keiko-server/src/tool-catalog/__fixtures__/catalogDefinition.ts",
  "packages/keiko-server/src/tool-catalog/__fixtures__/catalogRuntimeFixture.ts",
  "packages/keiko-server/src/tool-catalog/__fixtures__/catalogToolFixture.ts",
]);
export function policyDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function policyGit(root, args) {
  return execFileSync(resolveGitExecutable(), args, {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function withinRelative(root, path) {
  const result = relative(root, path).replaceAll("\\", "/");
  if (isAbsolute(result) || result.startsWith("../"))
    throw new TypeError("inventory-workspace-escape");
  return result;
}

function classified(scope, production, reason) {
  return { scope, production, reason };
}

export function classifyPolicyPath(path, packages) {
  const special = classifyNonProduction(path);
  if (special !== undefined) return special;
  const owner = packages.find((entry) => path.startsWith(`${entry.directory}/`));
  if (owner !== undefined)
    return classified(
      `package:${owner.name}`,
      true,
      /\.(?:generated|min)\.[^/]+$/u.test(path) ? "generated-workspace-runtime" : "workspace-owner",
    );
  if (path.startsWith("native/opencode-service-host/"))
    return classified("native-host", true, "native-runtime");
  if (path.startsWith("src/")) return classified("root-product", true, "root-entrypoint");
  if (path.startsWith("scripts/") || !path.includes("/"))
    return classified("tooling", true, "repository-tooling");
  throw new TypeError("unclassified-source");
}

function classifyNonProduction(path) {
  if (/\.d\.[cm]?ts$/u.test(path)) {
    return classified("declarations", false, "type-only-declaration");
  }
  if (
    isTestPath(path) ||
    TOOL_CATALOG_FIXTURES.has(path) ||
    /(?:^|\/)vitest\.setup\.[cm]?[jt]s$/u.test(path)
  ) {
    return classified("tests", false, "test-or-fixture");
  }
  if (path.startsWith("docs/") || path.startsWith("design-system/")) {
    return classified("documentary", false, "documentation-and-reference-proof");
  }
  if (path.startsWith("sandbox/"))
    return classified("fixtures", false, "non-shipped-sandbox-fixture");
  return undefined;
}

export function selectPolicyScope(files, id, ci) {
  if (ci && id !== "repository") throw new TypeError("partial-ci-scope");
  const selected = files.filter(
    (file) => id === "repository" || id === file.scope || (id === "production" && file.production),
  );
  if (selected.length === 0) throw new TypeError("unknown-or-empty-scope");
  return { id, partial: id !== "repository", files: selected };
}

function parsedBuildSources(root, directory, name = "tsconfig.json") {
  const config = join(root, directory, name);
  const configs = new Map();
  const parsed = ts.getParsedCommandLineOfConfigFile(
    config,
    {},
    {
      ...ts.sys,
      readFile(path) {
        const relativePath = withinRelative(root, path);
        safePolicyFile(root, relativePath);
        const source = ts.sys.readFile(path);
        if (source !== undefined) {
          configs.set(relativePath, policyDigest(source));
        }
        return source;
      },
      onUnRecoverableConfigFileDiagnostic() {
        throw new TypeError("invalid-build-config");
      },
    },
  );
  if (parsed === undefined || parsed.errors.length > 0) throw new TypeError("invalid-build-config");
  return {
    path: withinRelative(root, config),
    sha256: policyDigest(readFileSync(config)),
    configs: [...configs].map(([path, sha256]) => ({ path, sha256 })),
    sources: parsed.fileNames
      .map((file) => withinRelative(root, file))
      .sort((left, right) => left.localeCompare(right)),
  };
}

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") throw new TypeError("invalid-export-target");
  return Object.values(value).flatMap(exportTargets);
}

function packageInventory(root, entry) {
  const directory = withinRelative(root, entry.dir);
  const targets = entry.manifest.exports === undefined ? [] : exportTargets(entry.manifest.exports);
  return {
    name: entry.name,
    directory,
    manifestSha256: policyDigest(readFileSync(entry.manifestPath)),
    build: parsedBuildSources(root, directory),
    exports: [...new Set(targets)]
      .sort((left, right) => left.localeCompare(right))
      .map((target) => ({ target, exists: existsSync(join(entry.dir, target)) })),
  };
}

function sourceInventory(root, paths, tracked, packages) {
  return paths
    .filter((path) => POLICY_SOURCE_EXTENSION.test(path))
    .map((path) => {
      const absolute = join(root, path);
      safePolicyFile(root, path);
      return {
        path,
        tracked: tracked.has(path),
        sha256: policyDigest(readFileSync(absolute)),
        ...classifyPolicyPath(path, packages),
      };
    });
}

function verifyWorkspaceInventory(paths, packages) {
  const expected = paths
    .filter((path) => /^packages\/[^/]+\/package\.json$/u.test(path))
    .sort((left, right) => left.localeCompare(right));
  const observed = packages
    .map((entry) => `${entry.directory}/package.json`)
    .sort((left, right) => left.localeCompare(right));
  if (expected.join("\0") !== observed.join("\0") || expected.length === 0) {
    throw new TypeError("workspace-inventory-mismatch");
  }
}

function safePolicyFile(root, path) {
  const expected = join(realpathSync(root), path);
  const stats = lstatSync(join(root, path));
  if (!stats.isFile() || stats.isSymbolicLink() || realpathSync(join(root, path)) !== expected) {
    throw new TypeError("unsafe-source-file");
  }
}

export async function collectPolicyInventory(root) {
  const tracked = new Set(policyGit(root, ["ls-files", "-z"]).split("\0").filter(Boolean));
  const additions = policyGit(root, ["ls-files", "-z", "--others", "--exclude-standard"]);
  const paths = [...new Set([...tracked, ...additions.split("\0").filter(Boolean)])].sort(
    (left, right) => left.localeCompare(right),
  );
  const workspaces = await collectWorkspacePackages(root);
  const packages = workspaces.map((entry) => packageInventory(root, entry));
  verifyWorkspaceInventory(paths, packages);
  const files = sourceInventory(root, paths, tracked, packages);
  if (files.length === 0) throw new TypeError("empty-source-inventory");
  return {
    subject: policyGit(root, ["rev-parse", "HEAD"]).trim(),
    packages,
    files,
    rootBuild: parsedBuildSources(root, "", "tsconfig.build.json"),
    rootManifestSha256: policyDigest(readFileSync(join(root, "package.json"))),
    lockSha256: policyDigest(readFileSync(join(root, "package-lock.json"))),
    html: paths
      .filter((path) => /\.html?$/u.test(path))
      .map((path) => {
        if (!path.startsWith("design-system/")) throw new TypeError("unclassified-html-source");
        safePolicyFile(root, path);
        const source = readFileSync(join(root, path), "utf8");
        return {
          path,
          sha256: policyDigest(source),
          inlineScriptHashes: extractInlineScriptHashes([source]),
          reason: "non-shipped-design-system-reference",
          production: false,
        };
      }),
  };
}

export function readPreviousPolicies(root) {
  if (policyGit(root, ["rev-parse", "--is-shallow-repository"]).trim() !== "false") {
    throw new TypeError("incomplete-policy-history");
  }
  const path = "scripts/code-quality-policy.json";
  const result = [];
  const refs = policyGit(root, ["log", "--full-history", "--format=%H", "--", path])
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const ref of refs) {
    const tree = policyGit(root, ["ls-tree", "--name-only", ref, "--", path]);
    if (tree.trim() === path) result.push(JSON.parse(policyGit(root, ["show", `${ref}:${path}`])));
  }
  return result;
}
