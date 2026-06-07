import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { collectWorkspacePackages } from "./workspace-graph.mjs";

const UI_PACKAGE = "@oscharko-dev/keiko-ui";
const BUILD_PACKAGES_SCRIPT = "tsc -b tsconfig.packages.json";
const TYPECHECK_SCRIPT =
  "npm run build:packages && npm run check:package-graph && tsc -p tsconfig.json --noEmit";
const ALLOWED_WORKSPACE_DEPENDENCIES = new Map([
  [
    "@oscharko-dev/keiko-cli",
    [
      "@oscharko-dev/keiko-contracts",
      "@oscharko-dev/keiko-security",
      "@oscharko-dev/keiko-model-gateway",
      "@oscharko-dev/keiko-workspace",
      "@oscharko-dev/keiko-tools",
      "@oscharko-dev/keiko-harness",
      "@oscharko-dev/keiko-workflows",
      "@oscharko-dev/keiko-evaluations",
      "@oscharko-dev/keiko-evidence",
      "@oscharko-dev/keiko-sdk",
      "@oscharko-dev/keiko-server",
      "@oscharko-dev/keiko-verification",
    ],
  ],
  ["@oscharko-dev/keiko-contracts", []],
  [
    "@oscharko-dev/keiko-evaluations",
    [
      "@oscharko-dev/keiko-contracts",
      "@oscharko-dev/keiko-security",
      "@oscharko-dev/keiko-model-gateway",
      "@oscharko-dev/keiko-workspace",
      "@oscharko-dev/keiko-tools",
      "@oscharko-dev/keiko-harness",
      "@oscharko-dev/keiko-workflows",
      "@oscharko-dev/keiko-verification",
      "@oscharko-dev/keiko-evidence",
    ],
  ],
  [
    "@oscharko-dev/keiko-evidence",
    [
      "@oscharko-dev/keiko-contracts",
      "@oscharko-dev/keiko-security",
      "@oscharko-dev/keiko-workspace",
    ],
  ],
  [
    "@oscharko-dev/keiko-harness",
    [
      "@oscharko-dev/keiko-contracts",
      "@oscharko-dev/keiko-security",
      "@oscharko-dev/keiko-model-gateway",
      "@oscharko-dev/keiko-workspace",
      "@oscharko-dev/keiko-tools",
      "@oscharko-dev/keiko-evidence",
    ],
  ],
  [
    "@oscharko-dev/keiko-local-knowledge",
    [
      "@oscharko-dev/keiko-contracts",
      "@oscharko-dev/keiko-model-gateway",
      "@oscharko-dev/keiko-workspace",
    ],
  ],
  [
    "@oscharko-dev/keiko-memory-capture",
    ["@oscharko-dev/keiko-contracts", "@oscharko-dev/keiko-security"],
  ],
  [
    "@oscharko-dev/keiko-memory-consolidation",
    ["@oscharko-dev/keiko-contracts", "@oscharko-dev/keiko-security"],
  ],
  [
    "@oscharko-dev/keiko-memory-governance",
    ["@oscharko-dev/keiko-contracts", "@oscharko-dev/keiko-security"],
  ],
  [
    "@oscharko-dev/keiko-memory-retrieval",
    ["@oscharko-dev/keiko-contracts", "@oscharko-dev/keiko-security"],
  ],
  [
    "@oscharko-dev/keiko-memory-vault",
    ["@oscharko-dev/keiko-contracts", "@oscharko-dev/keiko-security"],
  ],
  [
    "@oscharko-dev/keiko-model-gateway",
    ["@oscharko-dev/keiko-contracts", "@oscharko-dev/keiko-security"],
  ],
  [
    "@oscharko-dev/keiko-quality-intelligence",
    ["@oscharko-dev/keiko-contracts", "@oscharko-dev/keiko-security"],
  ],
  [
    "@oscharko-dev/keiko-sdk",
    [
      "@oscharko-dev/keiko-contracts",
      "@oscharko-dev/keiko-model-gateway",
      "@oscharko-dev/keiko-workspace",
      "@oscharko-dev/keiko-tools",
      "@oscharko-dev/keiko-harness",
      "@oscharko-dev/keiko-workflows",
      "@oscharko-dev/keiko-evaluations",
      "@oscharko-dev/keiko-verification",
      "@oscharko-dev/keiko-evidence",
    ],
  ],
  ["@oscharko-dev/keiko-security", ["@oscharko-dev/keiko-contracts"]],
  [
    "@oscharko-dev/keiko-server",
    [
      "@oscharko-dev/keiko-contracts",
      "@oscharko-dev/keiko-security",
      "@oscharko-dev/keiko-model-gateway",
      "@oscharko-dev/keiko-workspace",
      "@oscharko-dev/keiko-tools",
      "@oscharko-dev/keiko-harness",
      "@oscharko-dev/keiko-workflows",
      "@oscharko-dev/keiko-verification",
      "@oscharko-dev/keiko-evidence",
      "@oscharko-dev/keiko-sdk",
      "@oscharko-dev/keiko-local-knowledge",
      "@oscharko-dev/keiko-memory-vault",
      "@oscharko-dev/keiko-memory-governance",
      "@oscharko-dev/keiko-memory-retrieval",
      "@oscharko-dev/keiko-memory-capture",
      "@oscharko-dev/keiko-memory-consolidation",
      "@oscharko-dev/keiko-quality-intelligence",
    ],
  ],
  [
    "@oscharko-dev/keiko-tools",
    [
      "@oscharko-dev/keiko-contracts",
      "@oscharko-dev/keiko-security",
      "@oscharko-dev/keiko-workspace",
    ],
  ],
  [
    "@oscharko-dev/keiko-verification",
    [
      "@oscharko-dev/keiko-contracts",
      "@oscharko-dev/keiko-security",
      "@oscharko-dev/keiko-workspace",
      "@oscharko-dev/keiko-tools",
    ],
  ],
  [
    "@oscharko-dev/keiko-workflows",
    [
      "@oscharko-dev/keiko-contracts",
      "@oscharko-dev/keiko-security",
      "@oscharko-dev/keiko-model-gateway",
      "@oscharko-dev/keiko-workspace",
      "@oscharko-dev/keiko-tools",
      "@oscharko-dev/keiko-harness",
      "@oscharko-dev/keiko-verification",
      "@oscharko-dev/keiko-evidence",
      "@oscharko-dev/keiko-quality-intelligence",
    ],
  ],
  [
    "@oscharko-dev/keiko-workspace",
    ["@oscharko-dev/keiko-contracts", "@oscharko-dev/keiko-security"],
  ],
]);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function workspaceDeps(manifest) {
  return Object.keys(manifest.dependencies ?? {})
    .filter((name) => name.startsWith("@oscharko-dev/keiko-"))
    .sort();
}

function workspaceRefs(tsconfig) {
  return (tsconfig.references ?? []).map((entry) => `@oscharko-dev/${basename(entry.path)}`).sort();
}

function manifestTargets(manifest) {
  const targets = [];
  if (typeof manifest.main === "string") targets.push(manifest.main);
  if (typeof manifest.types === "string") targets.push(manifest.types);
  for (const value of Object.values(manifest.exports ?? {})) {
    if (typeof value === "string") {
      targets.push(value);
      continue;
    }
    for (const nestedValue of Object.values(value ?? {})) {
      if (typeof nestedValue === "string") {
        targets.push(nestedValue);
      }
    }
  }
  return targets;
}

function parseArgs(argv) {
  const rootArg = argv.find((arg) => arg.startsWith("--root="));
  return {
    root: resolve(rootArg ? rootArg.slice("--root=".length) : process.cwd()),
  };
}

function rootScriptFailures(rootManifest) {
  const failures = [];
  if (rootManifest.scripts?.["build:packages"] !== BUILD_PACKAGES_SCRIPT) {
    failures.push(
      `root package.json build:packages must be "${BUILD_PACKAGES_SCRIPT}" (found "${rootManifest.scripts?.["build:packages"] ?? ""}")`,
    );
  }
  if (rootManifest.scripts?.typecheck !== TYPECHECK_SCRIPT) {
    failures.push(
      `root package.json typecheck must be "${TYPECHECK_SCRIPT}" (found "${rootManifest.scripts?.typecheck ?? ""}")`,
    );
  }
  return failures;
}

function solutionRefFailures(packagesSolution, graphPackages) {
  const expectedSolutionRefs = graphPackages.map((pkg) => pkg.name);
  const actualSolutionRefs = workspaceRefs(packagesSolution);
  if (JSON.stringify(actualSolutionRefs) !== JSON.stringify(expectedSolutionRefs)) {
    return [
      `tsconfig.packages.json references ${actualSolutionRefs.join(", ")} but expected ${expectedSolutionRefs.join(", ")}`,
    ];
  }
  return [];
}

function packageGraphFailures(pkg, tsconfig) {
  const failures = [];
  const deps = workspaceDeps(pkg.manifest);
  const refs = workspaceRefs(tsconfig);
  const allowedDeps = ALLOWED_WORKSPACE_DEPENDENCIES.get(pkg.name);

  if (JSON.stringify(refs) !== JSON.stringify(deps)) {
    failures.push(
      `${pkg.name}: tsconfig references ${refs.join(", ")} do not match dependencies ${deps.join(", ")}`,
    );
  }
  if (!allowedDeps) {
    failures.push(`${pkg.name}: missing ADR-0019 workspace dependency allowlist entry`);
  } else {
    const allowed = new Set(allowedDeps);
    const disallowedDeps = deps.filter((dep) => !allowed.has(dep));
    if (disallowedDeps.length > 0) {
      failures.push(
        `${pkg.name}: workspace dependencies ${disallowedDeps.join(", ")} are not allowed by the ADR-0019 package graph allowlist`,
      );
    }
  }
  if (tsconfig.compilerOptions?.rootDir !== "src") {
    failures.push(`${pkg.name}: compilerOptions.rootDir must be "src"`);
  }
  if ((tsconfig.include ?? []).some((entry) => String(entry).includes("../.."))) {
    failures.push(`${pkg.name}: tsconfig include still contains a root-relative path`);
  }
  if (manifestTargets(pkg.manifest).some((target) => target.includes("dist/packages/"))) {
    failures.push(`${pkg.name}: manifest still points at dist/packages/... output`);
  }
  return failures;
}

export async function checkWorkspacePackageGraph(root) {
  const failures = [];
  const rootManifest = await readJson(join(root, "package.json"));
  const packagesSolution = await readJson(join(root, "tsconfig.packages.json"));
  const packages = await collectWorkspacePackages(root);
  const graphPackages = packages
    .filter((pkg) => pkg.name !== UI_PACKAGE)
    .sort((a, b) => a.name.localeCompare(b.name));

  failures.push(...rootScriptFailures(rootManifest));
  failures.push(...solutionRefFailures(packagesSolution, graphPackages));
  for (const pkg of graphPackages) {
    const tsconfigPath = join(pkg.dir, "tsconfig.json");
    const tsconfig = await readJson(tsconfigPath);
    failures.push(...packageGraphFailures(pkg, tsconfig));
  }

  return failures;
}

export async function main(argv = process.argv.slice(2)) {
  const { root } = parseArgs(argv);
  const failures = await checkWorkspacePackageGraph(root);
  if (failures.length > 0) {
    console.error("package-graph: FAIL");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
  console.log(
    "package-graph: PASS — workspace references, package emits, and root package build graph are aligned.",
  );
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]).endsWith("check-package-graph.mjs");
if (invokedDirectly) {
  await main();
}
